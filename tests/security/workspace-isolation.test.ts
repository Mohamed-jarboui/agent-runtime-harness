import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  matchesPatterns,
  WorkspaceSandbox,
  workspaceRead,
  workspaceWrite,
  workspaceList,
  workspaceSearch,
} from '@loopsmith/tools';
import { makeWorkspace } from '../helpers.js';

const ctx = (workspace: WorkspaceSandbox) => ({
  runId: 'r',
  sessionId: 's',
  agentId: 'a',
  toolCallId: 't',
  signal: new AbortController().signal,
  workspace,
});

describe('workspace sandbox', () => {
  it('rejects traversal, absolute paths, home paths and NUL bytes', async () => {
    const ws = await WorkspaceSandbox.create({ root: makeWorkspace({ 'a.txt': 'a' }) });
    for (const bad of [
      '../x',
      'sub/../../x',
      '/etc/passwd',
      'C:\\Windows\\win.ini',
      '~/.ssh/id_rsa',
      'a\0b',
    ]) {
      await expect(ws.resolveForRead(bad), bad).rejects.toMatchObject({
        category: 'permission_denied',
      });
    }
    await expect(ws.resolveForRead('a.txt')).resolves.toMatchObject({ relative: 'a.txt' });
  });

  it('blocks symlink escapes for reads and writes', async () => {
    const root = makeWorkspace({ 'inside.txt': 'ok' });
    const outside = path.join(tmpdir(), `loopsmith-outside-${Date.now()}`);
    mkdirSync(outside, { recursive: true });
    writeFileSync(path.join(outside, 'secret.txt'), 'TOP SECRET');
    symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'));
    symlinkSync(outside, path.join(root, 'linkdir'));
    const ws = await WorkspaceSandbox.create({ root });
    await expect(ws.resolveForRead('link.txt')).rejects.toMatchObject({
      category: 'permission_denied',
    });
    await expect(ws.resolveForRead('linkdir/secret.txt')).rejects.toMatchObject({
      category: 'permission_denied',
    });
    await expect(ws.resolveForWrite('linkdir/new.txt')).rejects.toMatchObject({
      category: 'permission_denied',
    });
    await expect(ws.resolveForWrite('link.txt')).rejects.toMatchObject({
      category: 'permission_denied',
    });
    // listing reports symlinks but never follows them
    const listing = (await workspaceList.execute({ path: '.', recursive: true }, ctx(ws))) as {
      entries: Array<{ path: string; type: string }>;
    };
    expect(listing.entries.find((e) => e.path === 'linkdir')?.type).toBe('symlink');
    expect(listing.entries.some((e) => e.path.startsWith('linkdir/'))).toBe(false);
  });

  it('denies secret files by default but allows .env.example', async () => {
    const ws = await WorkspaceSandbox.create({
      root: makeWorkspace({
        '.env': 'K=v',
        '.env.example': 'K=',
        'certs/server.pem': 'x',
        '.git/config': 'x',
      }),
    });
    for (const p of ['.env', 'certs/server.pem', '.git/config'])
      await expect(ws.resolveForRead(p), p).rejects.toMatchObject({
        category: 'permission_denied',
      });
    await expect(ws.resolveForRead('.env.example')).resolves.toBeTruthy();
    await expect(ws.resolveForWrite('.git/hooks/pre-commit')).rejects.toMatchObject({
      category: 'permission_denied',
    });
  });

  it('search skips denied files so secrets never reach the model', async () => {
    const ws = await WorkspaceSandbox.create({
      root: makeWorkspace({ '.env': 'PASSWORD=hunter2', 'app.js': 'const x = 1;' }),
    });
    const result = (await workspaceSearch.execute(
      { query: 'hunter2', path: '.', regex: false, caseSensitive: false, maxResults: 10 },
      ctx(ws),
    )) as { matches: unknown[] };
    expect(result.matches).toEqual([]);
  });

  it('writes atomically, refuses overwrite in create mode and enforces size limits', async () => {
    const ws = await WorkspaceSandbox.create({ root: makeWorkspace({}), maxWriteBytes: 10 });
    await workspaceWrite.execute(
      { path: 'out/a.txt', content: 'hello', mode: 'create', createDirs: true },
      ctx(ws),
    );
    await expect(
      workspaceWrite.execute(
        { path: 'out/a.txt', content: 'x', mode: 'create', createDirs: true },
        ctx(ws),
      ),
    ).rejects.toThrow(/already exists/);
    await expect(
      workspaceWrite.execute(
        { path: 'big.txt', content: 'x'.repeat(11), mode: 'create', createDirs: true },
        ctx(ws),
      ),
    ).rejects.toThrow(/too large/);
    const read = (await workspaceRead.execute({ path: 'out/a.txt' }, ctx(ws))) as {
      content: string;
    };
    expect(read.content).toBe('hello');
  });

  it('gitignore-style pattern matching', () => {
    expect(matchesPatterns('.env', ['.env', '.env.*', '!.env.example'])).toBe(true);
    expect(matchesPatterns('config/.env.local', ['.env', '.env.*', '!.env.example'])).toBe(true);
    expect(matchesPatterns('.env.example', ['.env', '.env.*', '!.env.example'])).toBe(false);
    expect(matchesPatterns('a/.git/HEAD', ['**/.git/**'])).toBe(true);
    expect(matchesPatterns('src/index.ts', ['**/.git/**', '*.pem'])).toBe(false);
  });
});
