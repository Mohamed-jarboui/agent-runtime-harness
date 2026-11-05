#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Command, Option } from 'commander';
import pc from 'picocolors';
import { matchesToolPattern, Redactor, type RunStatus } from '@loopsmith/core';
import { coreSuite, reportToMarkdown, runEvalSuite } from '@loopsmith/evaluation';
import { exportRunTrace } from '@loopsmith/observability';
import { ProviderRegistry, registerEnvProviders } from '@loopsmith/providers';
import { summarizeApproval } from '@loopsmith/policies';
import { toMermaid } from '@loopsmith/workflow-engine';
import { analystEvalTasks, REPORT_PATH } from '@loopsmith/workspace-analyst';
import { boot, openStore, SAMPLE_WORKSPACE, type GlobalOptions } from './bootstrap.js';
import { DEFAULT_CONFIG_FILE, EXAMPLE_CONFIG } from './config.js';
import { executeWithTrace } from './execute.js';
import { out, printInspection, printRunsList, statusColor, table } from './render.js';

const VERSION = '0.1.0';
const redactor = new Redactor();

const program = new Command()
  .name('loopsmith')
  .description(
    'LoopSmith — a provider-agnostic agent runtime: run, inspect, approve and evaluate agent workflows.',
  )
  .version(VERSION)
  .option('--db <path>', 'SQLite state database (default: .loopsmith/loopsmith.db)')
  .option(
    '--workspace <dir>',
    'workspace root for the sandboxed workspace tools (default: current directory)',
  )
  .option('--config <file>', `config file (default: ./${DEFAULT_CONFIG_FILE} if present)`)
  .option('--provider <name>', 'model provider: mock | anthropic | openai | fallback')
  .option('-v, --verbose', 'show model requests and tool starts in traces')
  .option('--json', 'machine-readable JSON output')
  .option('--no-color', 'disable colors')
  .showHelpAfterError();

const globals = (): GlobalOptions => program.opts<GlobalOptions>();

type Action<A extends unknown[]> = (...args: A) => Promise<void> | void;
function guarded<A extends unknown[]>(fn: Action<A>): (...args: A) => Promise<void> {
  return async (...args: A) => {
    try {
      await fn(...args);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`${pc.red('error:')} ${redactor.redactString(message)}\n`);
      process.exitCode = 1;
    }
  };
}

// ---------------------------------------------------------------- init
program
  .command('init')
  .description(`create ${DEFAULT_CONFIG_FILE} and the .loopsmith/ state directory`)
  .option('--force', 'overwrite an existing config file')
  .action(
    guarded((opts: { force?: boolean }) => {
      const file = path.resolve(DEFAULT_CONFIG_FILE);
      if (existsSync(file) && !opts.force)
        throw new Error(`${DEFAULT_CONFIG_FILE} already exists (use --force to overwrite)`);
      writeFileSync(file, `${JSON.stringify(EXAMPLE_CONFIG, null, 2)}\n`);
      mkdirSync('.loopsmith', { recursive: true });
      out(`${pc.green('✔')} wrote ${DEFAULT_CONFIG_FILE} and created .loopsmith/`);
      out(pc.dim('  Add ".loopsmith/" to your .gitignore — it holds run state and traces.'));
      out(
        `  Next: ${pc.bold('loopsmith demo')}  or  ${pc.bold('loopsmith run --agent assistant --goal "Summarise this workspace"')}`,
      );
    }),
  );

// ---------------------------------------------------------------- demo
program
  .command('demo')
  .description(
    'run the Autonomous Workspace Analyst end to end on a sample workspace (no API key needed)',
  )
  .option('-y, --yes', 'auto-approve the report write (decision is still recorded)')
  .option(
    '--defer',
    'never prompt: pause at the approval and exit (resume later with approvals approve --resume)',
  )
  .option('--keep', 'reuse the existing demo workspace instead of resetting it')
  .action(
    guarded(async (opts: { yes?: boolean; defer?: boolean; keep?: boolean }) => {
      const g = globals();
      const demoDir = path.resolve('.loopsmith', 'demo-workspace');
      if (!opts.keep || !existsSync(demoDir)) {
        rmSync(demoDir, { recursive: true, force: true });
        cpSync(SAMPLE_WORKSPACE, demoDir, { recursive: true });
      }
      const booted = await boot({ ...g, provider: g.provider ?? 'mock', workspaceRoot: demoDir });
      try {
        const provider = booted.ls.providers.get(booted.ls.providers.default);
        if (!g.json) {
          out(pc.bold('LoopSmith demo — Autonomous Workspace Analyst'));
          out(
            pc.dim(
              `provider: ${provider.name} (${provider.kind}${provider.kind === 'mock' ? ', deterministic, offline' : ''}) · workspace: ${path.relative(process.cwd(), demoDir)} · db: ${path.relative(process.cwd(), path.resolve(g.db ?? '.loopsmith/loopsmith.db'))}`,
            ),
          );
          out();
        }
        const outcome = await executeWithTrace(
          booted.ls,
          { ...opts, json: g.json ?? false, verbose: g.verbose ?? false },
          ({ signal, approvals }) =>
            booted.ls.runWorkflow(
              'workspace-analyst',
              'Analyze this project workspace, inspect its files, identify technical weaknesses, and produce a structured improvement report.',
              { signal, approvals },
            ),
        );
        if (!g.json && outcome.status === 'completed') {
          const report = path.join(demoDir, REPORT_PATH);
          if (existsSync(report))
            out(`${pc.green('✔')} Report: ${path.relative(process.cwd(), report)}`);
        }
      } finally {
        await booted.close();
      }
    }),
  );

// ---------------------------------------------------------------- run
program
  .command('run')
  .description('run a workflow or a single agent against a goal')
  .addOption(new Option('--workflow <id>', 'workflow to run').conflicts('agent'))
  .option('--agent <id>', 'agent to run')
  .requiredOption('--goal <text>', 'the user goal')
  .option('-y, --yes', 'auto-approve approval-gated actions (recorded)')
  .option('--defer', 'never prompt: pause at approvals and exit')
  .option('--max-iterations <n>', 'override maxIterations', (v) => Number.parseInt(v, 10))
  .action(
    guarded(
      async (opts: {
        workflow?: string;
        agent?: string;
        goal: string;
        yes?: boolean;
        defer?: boolean;
        maxIterations?: number;
      }) => {
        const g = globals();
        if (!opts.workflow && !opts.agent)
          throw new Error(
            'pass --workflow <id> or --agent <id> (see: loopsmith workflows list / agents list)',
          );
        const booted = await boot(g);
        try {
          const runOpts = {
            ...(g.provider ? { provider: g.provider } : {}),
            ...(opts.maxIterations ? { limits: { maxIterations: opts.maxIterations } } : {}),
          };
          await executeWithTrace(
            booted.ls,
            { ...opts, json: g.json ?? false, verbose: g.verbose ?? false },
            ({ signal, approvals }) =>
              opts.workflow
                ? booted.ls.runWorkflow(opts.workflow, opts.goal, { ...runOpts, signal, approvals })
                : booted.ls.runAgent(opts.agent as string, opts.goal, {
                    ...runOpts,
                    signal,
                    approvals,
                  }),
          );
        } finally {
          await booted.close();
        }
      },
    ),
  );

// ---------------------------------------------------------------- runs
const runs = program.command('runs').description('list, inspect, resume and export runs');

runs
  .command('list')
  .description('list recent root runs')
  .option('-n, --limit <n>', 'number of runs', (v) => Number.parseInt(v, 10), 20)
  .option('--status <status>', 'filter by status')
  .option('--all', 'include child runs (agent nodes, delegations)')
  .action(
    guarded((opts: { limit: number; status?: RunStatus; all?: boolean }) => {
      const { store } = openStore(globals());
      try {
        const list = store.listRuns({
          limit: opts.limit,
          rootOnly: !opts.all,
          ...(opts.status ? { status: opts.status } : {}),
        });
        if (globals().json) out(JSON.stringify(list, null, 2));
        else printRunsList(list);
      } finally {
        store.close();
      }
    }),
  );

runs
  .command('inspect <runId>')
  .description('show the run tree, tool calls, approvals, transitions, metrics and timeline')
  .option('--events', 'show every event in the timeline')
  .action(
    guarded(async (runId: string, opts: { events?: boolean }) => {
      const g = globals();
      const { store, loaded } = openStore(g);
      const booted = await boot({ ...g, store, loaded, connectMcp: false });
      try {
        const inspection = booted.ls.inspect(runId);
        if (g.json) out(JSON.stringify(inspection, null, 2));
        else
          printInspection(inspection, {
            events: opts.events ?? false,
            verbose: g.verbose ?? false,
          });
      } finally {
        await booted.close();
      }
    }),
  );

runs
  .command('resume <runId>')
  .description('resume a paused or interrupted run (completed steps are not repeated)')
  .option('-y, --yes', 'auto-approve remaining approval-gated actions')
  .option('--defer', 'never prompt')
  .action(
    guarded(async (runId: string, opts: { yes?: boolean; defer?: boolean }) =>
      resumeRun(runId, opts),
    ),
  );

runs
  .command('export <runId>')
  .description('export the run trace as JSONL (one structured event per line)')
  .option('-o, --out <file>', 'write to a file instead of stdout')
  .action(
    guarded((runId: string, opts: { out?: string }) => {
      const { store } = openStore(globals());
      try {
        const run = store.getRun(runId);
        if (!run) throw new Error(`Run not found: ${runId}`);
        const jsonl = exportRunTrace(store, run.rootRunId, opts.out);
        if (opts.out)
          out(
            `${pc.green('✔')} wrote ${jsonl.split('\n').filter(Boolean).length} events to ${opts.out}`,
          );
        else process.stdout.write(jsonl);
      } finally {
        store.close();
      }
    }),
  );

async function resumeRun(runId: string, opts: { yes?: boolean; defer?: boolean }): Promise<void> {
  const g = globals();
  const { store, loaded } = openStore(g);
  const run = store.getRun(runId);
  if (!run) {
    store.close();
    throw new Error(`Run not found: ${runId}`);
  }
  const root = store.getRun(run.rootRunId) ?? run;
  const session = store.getSession(root.sessionId);
  const workspaceRoot = g.workspace
    ? path.resolve(g.workspace)
    : (session?.metadata.workspaceRoot as string | undefined);
  const booted = await boot({ ...g, store, loaded, ...(workspaceRoot ? { workspaceRoot } : {}) });
  try {
    if (!g.json)
      out(
        pc.dim(`Resuming ${root.id} (${root.kind}) in workspace ${workspaceRoot ?? '(default)'}`),
      );
    await executeWithTrace(
      booted.ls,
      { ...opts, json: g.json ?? false, verbose: g.verbose ?? false },
      ({ signal, approvals }) => booted.ls.resume(root.id, { signal, approvals }),
    );
  } finally {
    await booted.close();
  }
}

// ----------------------------------------------------------- approvals
const approvals = program.command('approvals').description('list and decide human approvals');

approvals
  .command('list')
  .description('list pending approvals (or all with --all)')
  .option('--all', 'include decided approvals')
  .action(
    guarded((opts: { all?: boolean }) => {
      const { store } = openStore(globals());
      try {
        const list = store.listApprovals(opts.all ? {} : { status: 'pending' });
        if (globals().json) return out(JSON.stringify(list, null, 2));
        if (list.length === 0)
          return out(opts.all ? 'No approvals recorded.' : 'No pending approvals.');
        out(
          table(
            list.map((a) => [
              a.id,
              statusColor(a.status),
              a.rootRunId,
              a.decidedBy ?? '-',
              summarizeApproval(a).slice(0, 80),
            ]),
            ['APPROVAL', 'STATUS', 'ROOT RUN', 'BY', 'WHAT'],
          ),
        );
      } finally {
        store.close();
      }
    }),
  );

for (const decision of ['approve', 'reject'] as const) {
  approvals
    .command(`${decision} <approvalId>`)
    .description(
      `${decision} a pending approval${decision === 'approve' ? ' (the action runs on resume)' : ''}`,
    )
    .option('--note <text>', 'reason recorded with the decision')
    .option('--by <name>', 'who decided', `cli:${process.env.USER ?? 'user'}`)
    .option('--resume', 'resume the run immediately after deciding')
    .action(
      guarded(async (approvalId: string, opts: { note?: string; by: string; resume?: boolean }) => {
        const g = globals();
        const { store, loaded } = openStore(g);
        const booted = await boot({ ...g, store, loaded, connectMcp: false });
        let rootRunId: string;
        try {
          const decided = booted.ls.decide(
            approvalId,
            decision === 'approve' ? 'approved' : 'rejected',
            opts.by,
            opts.note,
          );
          rootRunId = decided.rootRunId;
          if (g.json && !opts.resume) out(JSON.stringify(decided, null, 2));
          else if (!g.json)
            out(
              `${decision === 'approve' ? pc.green('✓') : pc.red('✗')} ${approvalId} ${statusColor(decided.status)} by ${opts.by}: ${summarizeApproval(decided)}`,
            );
          const pending = booted.ls.store.listApprovals({ status: 'pending', rootRunId });
          if (!opts.resume && !g.json)
            out(
              pending.length
                ? pc.dim(`${pending.length} approval(s) still pending for ${rootRunId}.`)
                : pc.dim(`Continue with: loopsmith runs resume ${rootRunId}`),
            );
        } finally {
          await booted.close();
        }
        if (opts.resume) await resumeRun(rootRunId, { defer: true });
      }),
    );
}

// --------------------------------------------------------- registries
program
  .command('agents')
  .description('list registered agents')
  .argument('[action]', 'list', 'list')
  .action(
    guarded(async () => {
      const booted = await boot({ ...globals(), connectMcp: false });
      try {
        const list = booted.ls.agents.list();
        if (globals().json)
          return out(
            JSON.stringify(
              list.map(({ output, ...a }) => ({ ...a, output: output?.format ?? 'text' })),
              null,
              2,
            ),
          );
        out(
          table(
            list.map((a) => [
              a.id,
              a.name,
              booted.ls.tools
                .list()
                .filter((t) => a.tools.some((p) => matchesToolPattern(p, t.name)))
                .map((t) => t.name)
                .join(', ') || '-',
              [
                ...(a.delegates ?? []).map((d) => `delegate:${d}`),
                ...(a.handoffs ?? []).map((d) => `handoff:${d}`),
              ].join(' ') || '-',
              a.output?.format ?? 'text',
            ]),
            ['AGENT', 'NAME', 'TOOLS', 'TRANSFERS', 'OUTPUT'],
          ),
        );
      } finally {
        await booted.close();
      }
    }),
  );

const workflows = program.command('workflows').description('list and show workflows');
workflows
  .command('list')
  .description('list registered workflows')
  .action(
    guarded(async () => {
      const booted = await boot({ ...globals(), connectMcp: false });
      try {
        const list = booted.ls.workflows.list();
        if (globals().json) return out(JSON.stringify(list, null, 2));
        out(
          table(
            list.map((w) => [
              w.id,
              w.version,
              String(Object.keys(w.nodes).length),
              String(w.maxSteps),
              w.description,
            ]),
            ['WORKFLOW', 'VERSION', 'NODES', 'MAX STEPS', 'DESCRIPTION'],
          ),
        );
      } finally {
        await booted.close();
      }
    }),
  );
workflows
  .command('show <id>')
  .description('show a workflow definition (as JSON, or as a Mermaid diagram with --mermaid)')
  .option('--mermaid', 'print a Mermaid flowchart')
  .action(
    guarded(async (id: string, opts: { mermaid?: boolean }) => {
      const booted = await boot({ ...globals(), connectMcp: false });
      try {
        const def = booted.ls.workflows.get(id);
        out(opts.mermaid ? toMermaid(def) : JSON.stringify(def, null, 2));
      } finally {
        await booted.close();
      }
    }),
  );

program
  .command('tools')
  .description('list registered tools with their permission category and default policy')
  .argument('[action]', 'list', 'list')
  .action(
    guarded(async () => {
      const booted = await boot(globals());
      try {
        const list = booted.ls.tools.list();
        if (globals().json)
          return out(
            JSON.stringify(
              list.map(({ execute: _e, validateInput: _v, validateOutput: _o, ...t }) => t),
              null,
              2,
            ),
          );
        out(
          table(
            list.map((t) => {
              const effect = booted.ls.policy.evaluate({
                toolName: t.name,
                category: t.category,
              }).effect;
              return [
                t.name,
                t.category,
                effect === 'allow'
                  ? pc.green(effect)
                  : effect === 'deny'
                    ? pc.red(effect)
                    : pc.yellow(effect),
                t.source,
                t.idempotent ? 'yes' : 'no',
                t.description.slice(0, 60),
              ];
            }),
            ['TOOL', 'CATEGORY', 'DEFAULT POLICY', 'SOURCE', 'IDEMPOTENT', 'DESCRIPTION'],
          ),
        );
      } finally {
        await booted.close();
      }
    }),
  );

program
  .command('providers')
  .description('list model providers and their configuration status (never prints secrets)')
  .argument('[action]', 'list', 'list')
  .action(
    guarded(async () => {
      const booted = await boot({ ...globals(), connectMcp: false });
      try {
        const list = booted.ls.providers.list();
        if (globals().json) return out(JSON.stringify(list, null, 2));
        out(
          table(
            list.map((p) => [
              p.isDefault ? `${p.name} ${pc.green('(default)')}` : p.name,
              p.kind,
              p.defaultModel,
              p.status,
              p.baseURL ?? '-',
            ]),
            ['PROVIDER', 'KIND', 'DEFAULT MODEL', 'STATUS', 'BASE URL'],
          ),
        );
        out(
          pc.dim(
            'Configure live providers with ANTHROPIC_API_KEY / OPENAI_API_KEY + LOOPSMITH_OPENAI_MODEL (see .env.example).',
          ),
        );
      } finally {
        await booted.close();
      }
    }),
  );

const memory = program.command('memory').description('inspect long-term memory');
memory
  .command('search <query>')
  .description('full-text search over stored memories (BM25)')
  .option('-n, --limit <n>', 'results', (v) => Number.parseInt(v, 10), 10)
  .action(
    guarded(async (query: string, opts: { limit: number }) => {
      const booted = await boot({ ...globals(), connectMcp: false });
      try {
        const hits = booted.ls.memory.search(query, { limit: opts.limit });
        if (globals().json) return out(JSON.stringify(hits, null, 2));
        if (hits.length === 0) return out('No matching memories.');
        out(
          table(
            hits.map((m) => [m.id, m.scope, m.score.toFixed(3), m.source, m.content.slice(0, 90)]),
            ['MEMORY', 'SCOPE', 'SCORE', 'SOURCE', 'CONTENT'],
          ),
        );
      } finally {
        await booted.close();
      }
    }),
  );
memory
  .command('list')
  .description('list recent memories')
  .action(
    guarded(async () => {
      const booted = await boot({ ...globals(), connectMcp: false });
      try {
        const list = booted.ls.memory.list({ limit: 50 });
        if (globals().json) return out(JSON.stringify(list, null, 2));
        if (list.length === 0) return out('No memories stored yet.');
        out(
          table(
            list.map((m) => [
              m.id,
              m.scope,
              m.source,
              m.createdAt.slice(0, 19),
              m.content.slice(0, 80),
            ]),
            ['MEMORY', 'SCOPE', 'SOURCE', 'CREATED', 'CONTENT'],
          ),
        );
      } finally {
        await booted.close();
      }
    }),
  );

// ---------------------------------------------------------------- eval
const evalCmd = program.command('eval').description('run the agent evaluation suite');
evalCmd
  .command('run')
  .description(
    'run the benchmark suite (mock mode by default; --live runs live-compatible tasks on a real provider)',
  )
  .option('--live', 'run live-compatible tasks against --provider (costs money)')
  .option('--filter <text>', 'only tasks whose id contains text')
  .option('-o, --out <dir>', 'output directory for report.json and report.md', 'eval-results')
  .action(
    guarded(async (opts: { live?: boolean; filter?: string; out: string }) => {
      const g = globals();
      const tasks = [...coreSuite, ...analystEvalTasks(SAMPLE_WORKSPACE)];
      let providers: ProviderRegistry | undefined;
      if (opts.live) {
        if (!g.provider || g.provider === 'mock')
          throw new Error('--live requires --provider anthropic|openai|fallback');
        providers = new ProviderRegistry();
        registerEnvProviders(providers);
        providers.get(g.provider);
      }
      if (!g.json)
        out(
          pc.bold(
            `LoopSmith eval · ${opts.live ? `LIVE provider ${g.provider}` : 'mock provider (deterministic)'} · ${tasks.length} tasks`,
          ),
        );
      const report = await runEvalSuite(tasks, {
        mode: opts.live ? 'live' : 'mock',
        ...(providers && g.provider ? { providers, provider: g.provider } : {}),
        ...(opts.filter ? { filter: (t) => t.id.includes(opts.filter as string) } : {}),
        onTaskComplete: (r) => {
          if (!g.json)
            out(
              `  ${r.passed ? pc.green('✔') : pc.red('✖')} ${r.id.padEnd(36)} ${pc.dim(`${r.status} · ${r.modelCalls} model · ${r.toolCalls} tools · ${r.durationMs}ms`)}`,
            );
        },
      });
      mkdirSync(opts.out, { recursive: true });
      writeFileSync(path.join(opts.out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
      writeFileSync(path.join(opts.out, 'report.md'), reportToMarkdown(report));
      if (g.json) out(JSON.stringify(report.summary, null, 2));
      else {
        const s = report.summary;
        out();
        out(
          `${pc.bold(`${s.passed}/${s.tasks} passed`)} · completion ${fmt(s.completionRate)} · tool selection ${fmt(s.toolSelectionAccuracy)} · arg validity ${fmt(s.toolArgumentValidity)} · approval enforcement ${fmt(s.approvalPolicyEnforcement)} · recovery ${fmt(s.recoveryPassRate)}`,
        );
        out(
          pc.dim(
            `avg ${s.avgModelCalls} model calls · ${s.avgToolCalls} tool calls · ${s.avgDurationMs}ms per task · reports in ${opts.out}/`,
          ),
        );
      }
      if (report.summary.passed !== report.summary.tasks) process.exitCode = 1;
    }),
  );
const fmt = (v: number | null): string => (v === null ? 'n/a' : `${(v * 100).toFixed(1)}%`);

// Keep the version honest with the package manifest when available.
try {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version?: string;
  };
  if (pkg.version && pkg.version !== VERSION) program.version(pkg.version);
} catch {
  /* running from an unusual layout */
}

await program.parseAsync(process.argv);
