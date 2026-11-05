import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { LoopSmithError } from '@loopsmith/core';

export interface SandboxOptions {
  root: string;
  /** Gitignore-style patterns (last match wins, `!` negates). */
  denyRead?: string[];
  denyWrite?: string[];
  /** Directory names skipped by listing and search. */
  ignoreDirs?: string[];
  maxReadBytes?: number;
  maxWriteBytes?: number;
}

export const DEFAULT_DENY_READ = [
  '.env',
  '.env.*',
  '!.env.example',
  '*.pem',
  '*.key',
  '*.p12',
  'id_rsa*',
  'id_ed25519*',
  '.npmrc',
  '**/.git/**',
  '**/.loopsmith/**',
];

export const DEFAULT_DENY_WRITE = [
  ...DEFAULT_DENY_READ.filter((p) => !p.startsWith('!')),
  '**/node_modules/**',
  'package-lock.json',
  'pnpm-lock.yaml',
];

export const DEFAULT_IGNORE_DIRS = [
  'node_modules',
  '.git',
  '.loopsmith',
  'dist',
  'coverage',
  '.venv',
  '__pycache__',
];

export interface ResolvedPath {
  absolute: string;
  /** POSIX-style path relative to the workspace root (`.` for the root). */
  relative: string;
}

/** Convert a glob (`*`, `**`, `?`) to an anchored regular expression. */
export function globToRegExp(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i] as string;
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        const slash = glob[i + 2] === '/';
        out += slash ? '(?:.*/)?' : '.*';
        i += slash ? 2 : 1;
      } else out += '[^/]*';
    } else if (ch === '?') out += '[^/]';
    else out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

/** Gitignore-like matching: patterns without `/` match the basename anywhere. */
export function matchesPatterns(relative: string, patterns: string[]): boolean {
  const base = relative.split('/').pop() ?? relative;
  let matched = false;
  for (const raw of patterns) {
    const negate = raw.startsWith('!');
    const pattern = negate ? raw.slice(1) : raw;
    const target = pattern.includes('/') ? relative : base;
    if (
      globToRegExp(pattern).test(target) ||
      (pattern.includes('/') && globToRegExp(pattern).test(`${relative}/`))
    ) {
      matched = !negate;
    }
  }
  return matched;
}

const violation = (message: string, details: Record<string, unknown> = {}): LoopSmithError =>
  new LoopSmithError('permission_denied', message, { code: 'workspace_violation', details });

/**
 * Confines every file operation to a workspace root.
 *
 * Defends against `..` traversal, absolute paths, NUL bytes and symlink
 * escapes (paths are re-checked after `realpath`). There is an unavoidable
 * TOCTOU window between the check and the operation; the sandbox is a policy
 * layer, not an OS-level jail — run untrusted workloads in a container.
 */
export class WorkspaceSandbox {
  readonly root: string;
  readonly denyRead: string[];
  readonly denyWrite: string[];
  readonly ignoreDirs: Set<string>;
  readonly maxReadBytes: number;
  readonly maxWriteBytes: number;

  private constructor(rootReal: string, options: SandboxOptions) {
    this.root = rootReal;
    this.denyRead = options.denyRead ?? DEFAULT_DENY_READ;
    this.denyWrite = options.denyWrite ?? DEFAULT_DENY_WRITE;
    this.ignoreDirs = new Set(options.ignoreDirs ?? DEFAULT_IGNORE_DIRS);
    this.maxReadBytes = options.maxReadBytes ?? 256 * 1024;
    this.maxWriteBytes = options.maxWriteBytes ?? 1024 * 1024;
  }

  static async create(options: SandboxOptions): Promise<WorkspaceSandbox> {
    let rootReal: string;
    try {
      rootReal = await realpath(options.root);
      if (!(await stat(rootReal)).isDirectory()) throw new Error('not a directory');
    } catch (err) {
      throw new LoopSmithError(
        'configuration',
        `Workspace root is not an accessible directory: ${options.root}`,
        {
          cause: err,
        },
      );
    }
    return new WorkspaceSandbox(rootReal, options);
  }

  private isInside(candidate: string): boolean {
    const rel = path.relative(this.root, candidate);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  }

  private lexical(input: unknown): ResolvedPath {
    const raw = typeof input === 'string' && input.trim() !== '' ? input.trim() : '.';
    if (raw.includes('\0')) throw violation('Path contains a NUL byte');
    if (path.isAbsolute(raw) || /^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith('~')) {
      throw violation('Absolute paths are not allowed; use a path relative to the workspace root', {
        path: raw,
      });
    }
    const absolute = path.resolve(this.root, raw);
    if (!this.isInside(absolute)) throw violation('Path escapes the workspace root', { path: raw });
    const relative = path.relative(this.root, absolute).split(path.sep).join('/') || '.';
    return { absolute, relative };
  }

  async resolveForRead(input: unknown): Promise<ResolvedPath> {
    const resolved = this.lexical(input);
    if (resolved.relative !== '.' && matchesPatterns(resolved.relative, this.denyRead)) {
      throw violation(`Reading "${resolved.relative}" is blocked by the workspace policy`, {
        path: resolved.relative,
      });
    }
    let real: string;
    try {
      real = await realpath(resolved.absolute);
    } catch {
      throw new LoopSmithError('tool_execution', `Path not found: ${resolved.relative}`, {
        code: 'not_found',
      });
    }
    if (!this.isInside(real))
      throw violation('Symlink resolves outside the workspace root', { path: resolved.relative });
    return { absolute: real, relative: resolved.relative };
  }

  async resolveForWrite(input: unknown): Promise<ResolvedPath> {
    const resolved = this.lexical(input);
    if (resolved.relative === '.') throw violation('Cannot write to the workspace root itself');
    if (matchesPatterns(resolved.relative, this.denyWrite)) {
      throw violation(`Writing "${resolved.relative}" is blocked by the workspace policy`, {
        path: resolved.relative,
      });
    }
    // The target may not exist yet: validate its nearest existing ancestor.
    let probe = resolved.absolute;
    for (let depth = 0; depth < 64; depth++) {
      try {
        const info = await lstat(probe);
        if (info.isSymbolicLink() && probe === resolved.absolute) {
          throw violation('Refusing to write through a symlink', { path: resolved.relative });
        }
        const real = await realpath(probe);
        if (!this.isInside(real))
          throw violation('Path resolves outside the workspace root', { path: resolved.relative });
        return resolved;
      } catch (err) {
        if (err instanceof LoopSmithError) throw err;
        const parent = path.dirname(probe);
        if (parent === probe) break;
        probe = parent;
      }
    }
    throw violation('Could not validate write path', { path: resolved.relative });
  }

  isIgnoredDir(name: string): boolean {
    return this.ignoreDirs.has(name);
  }

  isReadable(relative: string): boolean {
    return !matchesPatterns(relative, this.denyRead);
  }

  /** Bounded breadth-first walk. Symlinks are reported but never followed. */
  async walk(
    start: ResolvedPath,
    options: { maxEntries: number; maxDepth: number; recursive: boolean },
  ): Promise<{
    entries: Array<{ path: string; type: 'file' | 'dir' | 'symlink'; size: number }>;
    truncated: boolean;
  }> {
    const entries: Array<{ path: string; type: 'file' | 'dir' | 'symlink'; size: number }> = [];
    const queue: Array<{ abs: string; rel: string; depth: number }> = [
      { abs: start.absolute, rel: start.relative === '.' ? '' : start.relative, depth: 0 },
    ];
    while (queue.length > 0) {
      const dir = queue.shift() as { abs: string; rel: string; depth: number };
      let names;
      try {
        names = await readdir(dir.abs, { withFileTypes: true });
      } catch {
        continue;
      }
      names.sort((a, b) => a.name.localeCompare(b.name));
      for (const dirent of names) {
        const rel = dir.rel ? `${dir.rel}/${dirent.name}` : dirent.name;
        const abs = path.join(dir.abs, dirent.name);
        if (dirent.isDirectory() && this.isIgnoredDir(dirent.name)) continue;
        if (entries.length >= options.maxEntries) return { entries, truncated: true };
        if (dirent.isSymbolicLink()) {
          entries.push({ path: rel, type: 'symlink', size: 0 });
        } else if (dirent.isDirectory()) {
          entries.push({ path: rel, type: 'dir', size: 0 });
          if (options.recursive && dir.depth + 1 < options.maxDepth)
            queue.push({ abs, rel, depth: dir.depth + 1 });
        } else if (dirent.isFile()) {
          let size = 0;
          try {
            size = (await stat(abs)).size;
          } catch {
            /* raced with deletion */
          }
          entries.push({ path: rel, type: 'file', size });
        }
      }
    }
    return { entries, truncated: false };
  }
}
