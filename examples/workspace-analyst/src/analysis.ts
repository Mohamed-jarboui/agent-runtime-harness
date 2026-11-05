import type { Observation } from './observations.js';
import { flaggedObservation } from './observations.js';

export type Severity = 'high' | 'medium' | 'low';

export interface Evidence {
  path: string;
  line?: number;
  excerpt?: string;
}

export interface Finding {
  id: string;
  title: string;
  severity: Severity;
  category:
    'security' | 'reliability' | 'maintainability' | 'documentation' | 'supply-chain' | 'process';
  evidence: Evidence[];
  recommendation: string;
}

export interface FindingsReport {
  workspace: string;
  findings: Finding[];
  metrics: {
    filesInspected: number;
    linesInspected: number;
    todoCount: number;
    todoDensityPer1k: number | null;
    consoleLogCount: number;
  };
  summary: { total: number; high: number; medium: number; low: number };
}

export interface Plan {
  objective: string;
  steps: string[];
  focusFiles: string[];
  inventory: {
    files: number;
    directories: number;
    hasTests: boolean;
    hasLicense: boolean;
    hasCi: boolean;
    envFiles: string[];
  };
}

interface ListEntry {
  path: string;
  type: string;
  size: number;
}

export function listingFrom(obs: Observation[]): ListEntry[] {
  const listing = obs.find((o) => o.tool === 'workspace.list' && o.ok);
  const data = listing?.data as { entries?: ListEntry[] } | undefined;
  return data?.entries ?? [];
}

const PRIORITY: Array<[RegExp, number]> = [
  [/^readme(\.md)?$/i, 0],
  [/(^|\/)package\.json$/, 1],
  [/^src\/.*\.(js|ts|mjs|cjs|py)$/, 2],
  [/\.(js|ts|py)$/, 3],
  [/^docs\/.*\.md$/, 4],
];

/** Deterministic planning from a workspace listing. */
export function buildPlan(goal: string, entries: ListEntry[]): Plan {
  const files = entries.filter((e) => e.type === 'file');
  const rank = (p: string): number => PRIORITY.find(([re]) => re.test(p))?.[1] ?? 9;
  const envFiles = files
    .map((f) => f.path)
    .filter((p) => /(^|\/)\.env(\.|$)/.test(p) && !p.endsWith('.example'));
  const focusFiles = files
    .filter((f) => rank(f.path) < 9 && f.size < 200_000)
    .sort((a, b) => rank(a.path) - rank(b.path) || a.path.localeCompare(b.path))
    .slice(0, 8)
    .map((f) => f.path);
  const has = (re: RegExp): boolean => entries.some((e) => re.test(e.path));
  return {
    objective: goal.split('\n')[0]?.slice(0, 200) ?? goal,
    steps: [
      'Read the README, manifest and source files selected below',
      'Search for unfinished work markers (TODO/FIXME/HACK) and hard-coded credentials',
      'Quantify technical debt with exact arithmetic (calculator.evaluate)',
      'Classify findings by severity with file/line evidence',
      'Draft an improvement report, verify it, review it, then publish it with human approval',
    ],
    focusFiles: [...focusFiles, ...envFiles.slice(0, 1)],
    inventory: {
      files: files.length,
      directories: entries.filter((e) => e.type === 'dir').length,
      hasTests: has(/(^|\/)(tests?|__tests__|spec)(\/|$)|\.(test|spec)\.[jt]s$/),
      hasLicense: has(/^licen[cs]e(\.md|\.txt)?$/i),
      hasCi: has(/^\.github\/workflows\//),
      envFiles,
    },
  };
}

function lineOf(content: string, needle: RegExp): Array<{ line: number; text: string }> {
  return content
    .split('\n')
    .map((text, i) => ({ line: i + 1, text: text.trim() }))
    .filter((l) => needle.test(l.text));
}

/** Turn real tool observations into findings. Every finding cites evidence. */
export function analyze(
  plan: Plan | undefined,
  obs: Observation[],
  workspaceName: string,
  todoDensity: number | null,
): FindingsReport {
  const reads = obs.filter((o) => o.tool === 'workspace.read');
  const contents = new Map<string, string>();
  for (const r of reads) {
    const data = r.data as { path?: string; content?: string } | undefined;
    if (r.ok && data?.path && typeof data.content === 'string')
      contents.set(data.path, data.content);
  }
  const searches = obs.filter((o) => o.tool === 'workspace.search' && o.ok);
  const matchesFor = (pattern: RegExp): Array<{ path: string; line: number; text: string }> =>
    searches
      .filter((s) => pattern.test(String(s.args.query ?? '')))
      .flatMap(
        (s) =>
          (s.data as { matches?: Array<{ path: string; line: number; text: string }> }).matches ??
          [],
      );

  const findings: Finding[] = [];
  const push = (f: Finding): void => {
    if (f.evidence.length > 0 || f.id === 'missing-tests' || f.id === 'missing-license')
      findings.push(f);
  };

  // Hard-coded credentials (search results).
  const secrets = matchesFor(/password|secret|api/i).filter((m) => !/process\.env/.test(m.text));
  push({
    id: 'hardcoded-credentials',
    title: 'Hard-coded credentials in source code',
    severity: 'high',
    category: 'security',
    // Quote the line but never the credential value itself.
    evidence: secrets.slice(0, 5).map((m) => ({
      path: m.path,
      line: m.line,
      excerpt: m.text.replace(/(["'`])[^"'`]{3,}\1/g, '"<redacted>"'),
    })),
    recommendation:
      'Load credentials from the environment or a secret manager, rotate the exposed value, and add secret scanning to CI.',
  });

  // Dynamic code execution.
  const evalHits: Evidence[] = [];
  for (const [path, content] of contents) {
    for (const hit of lineOf(content, /\beval\s*\(|new Function\s*\(/))
      evalHits.push({ path, line: hit.line, excerpt: hit.text });
  }
  push({
    id: 'dynamic-code-execution',
    title: 'Dynamic code execution with eval()',
    severity: 'high',
    category: 'security',
    evidence: evalHits,
    recommendation:
      'Replace eval() with a parsed, whitelisted rule format (e.g. a small expression parser) and validate rules at load time.',
  });

  // Tests.
  const pkgRaw = [...contents.entries()].find(([p]) => p.endsWith('package.json'))?.[1];
  let pkg:
    | { scripts?: Record<string, string>; dependencies?: Record<string, string>; engines?: unknown }
    | undefined;
  try {
    pkg = pkgRaw ? JSON.parse(pkgRaw) : undefined;
  } catch {
    pkg = undefined;
  }
  if (plan && !plan.inventory.hasTests) {
    push({
      id: 'missing-tests',
      title: 'No automated tests',
      severity: 'high',
      category: 'reliability',
      evidence:
        pkg && !pkg.scripts?.test
          ? [{ path: 'package.json', excerpt: 'no "test" script defined' }]
          : [{ path: '.', excerpt: 'no test directory or *.test.* files found' }],
      recommendation:
        'Add a test runner (e.g. node:test or Vitest), cover inventory calculations first, and run tests in CI.',
    });
  }

  // Dependencies.
  const loose = Object.entries(pkg?.dependencies ?? {}).filter(
    ([, v]) => v === '*' || v === 'latest' || v === '',
  );
  push({
    id: 'unpinned-dependencies',
    title: 'Unpinned dependency versions',
    severity: 'medium',
    category: 'supply-chain',
    evidence: loose.map(([name, version]) => ({
      path: 'package.json',
      excerpt: `"${name}": "${version}"`,
    })),
    recommendation: 'Pin semver ranges, commit a lockfile and enable automated dependency updates.',
  });

  // Secrets file present but unreadable (blocked by the sandbox).
  const blockedEnv = reads.filter((r) => !r.ok && /\.env/.test(String(r.args.path ?? '')));
  push({
    id: 'env-file-in-workspace',
    title: 'Environment file stored in the workspace',
    severity: 'medium',
    category: 'security',
    evidence: blockedEnv.map((r) => ({
      path: String(r.args.path),
      excerpt: 'read blocked by LoopSmith workspace policy (contents not inspected)',
    })),
    recommendation:
      'Keep .env files out of version control (.gitignore) and provide a .env.example with placeholder values.',
  });

  // README gaps.
  const readme = [...contents.entries()].find(([p]) => /^readme/i.test(p));
  if (readme) {
    const missing = ['install', 'usage', 'configuration', 'test'].filter(
      (s) => !new RegExp(`^#+.*${s}`, 'im').test(readme[1]),
    );
    if (missing.length >= 2) {
      push({
        id: 'readme-gaps',
        title: 'README lacks setup and usage documentation',
        severity: 'medium',
        category: 'documentation',
        evidence: [{ path: readme[0], excerpt: `missing sections: ${missing.join(', ')}` }],
        recommendation:
          'Document installation, configuration (environment variables), usage examples and how to run tests.',
      });
    }
  }

  // Untrusted instructions embedded in content (flagged by the runtime).
  const injected = reads.filter((r) => r.ok && flaggedObservation(r));
  push({
    id: 'embedded-agent-instructions',
    title: 'Repository content contains instructions aimed at AI agents',
    severity: 'medium',
    category: 'security',
    evidence: injected.map((r) => {
      const content = (r.data as { content?: string; path?: string }).content ?? '';
      const hit = lineOf(content, /ignore|disregard|approve/i)[0];
      return {
        path: String((r.data as { path?: string }).path ?? r.args.path),
        ...(hit ? { line: hit.line, excerpt: hit.text } : {}),
      };
    }),
    recommendation:
      'Remove the embedded instruction and treat repository text as untrusted input in any AI tooling (LoopSmith flagged and ignored it).',
  });

  // TODO debt.
  const todos = matchesFor(/todo|fixme|hack/i);
  push({
    id: 'todo-debt',
    title: 'Unresolved TODO/FIXME/HACK markers',
    severity: todos.length >= 5 ? 'medium' : 'low',
    category: 'maintainability',
    evidence: todos.slice(0, 6).map((m) => ({ path: m.path, line: m.line, excerpt: m.text })),
    recommendation:
      'Convert markers into tracked issues and resolve the ones on request-handling paths first.',
  });

  // Logging.
  const logs: Evidence[] = [];
  for (const [path, content] of contents)
    for (const hit of lineOf(content, /console\.log\(/))
      logs.push({ path, line: hit.line, excerpt: hit.text });
  push({
    id: 'console-logging',
    title: 'Unstructured console logging',
    severity: 'low',
    category: 'maintainability',
    evidence: logs.slice(0, 4),
    recommendation: 'Use a structured logger (e.g. pino) with levels and request ids.',
  });

  if (plan && !plan.inventory.hasLicense) {
    push({
      id: 'missing-license',
      title: 'No license file',
      severity: 'low',
      category: 'process',
      evidence: [{ path: '.', excerpt: 'no LICENSE file at the workspace root' }],
      recommendation: 'Add a LICENSE file so usage and contribution terms are explicit.',
    });
  }

  const order: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);
  const lines = [...contents.values()].reduce((n, c) => n + c.split('\n').length, 0);
  const count = (s: Severity): number => findings.filter((f) => f.severity === s).length;
  return {
    workspace: workspaceName,
    findings,
    metrics: {
      filesInspected: contents.size,
      linesInspected: lines,
      todoCount: todos.length,
      todoDensityPer1k: todoDensity,
      consoleLogCount: logs.length,
    },
    summary: {
      total: findings.length,
      high: count('high'),
      medium: count('medium'),
      low: count('low'),
    },
  };
}
