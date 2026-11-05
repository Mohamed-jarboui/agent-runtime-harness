import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Redactor,
  secretsFromEnv,
  type AgentDefinition,
  type ModelRequest,
  type StateStore,
} from '@loopsmith/core';
import { type McpToolSource, registerMcpServer } from '@loopsmith/mcp';
import { LoopSmith } from '@loopsmith/orchestration';
import {
  ProviderRegistry,
  ScriptedProvider,
  call,
  say,
  registerEnvProviders,
  type ScriptStep,
} from '@loopsmith/providers';
import { SqliteStateStore } from '@loopsmith/storage';
import {
  analystAgents,
  analystHandlers,
  analystScripts,
  analystWorkflows,
} from '@loopsmith/workspace-analyst';
import { DEFAULT_DB, loadConfig, type LoadedConfig } from './config.js';

export interface GlobalOptions {
  db?: string;
  workspace?: string;
  config?: string;
  provider?: string;
  verbose?: boolean;
  json?: boolean;
}

/** Repository root (the CLI ships inside the monorepo for the first release). */
export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const SAMPLE_WORKSPACE = path.join(REPO_ROOT, 'examples', 'sample-workspace');

export const assistantAgent: AgentDefinition = {
  id: 'assistant',
  name: 'Assistant',
  description:
    'General-purpose workspace assistant with read-only tools, the calculator and memory.',
  instructions:
    'You help users understand a software workspace. Use workspace tools to look before you answer, ' +
    'calculator.evaluate for arithmetic, and memory tools for durable facts. Ask for approval-gated writes only when needed.',
  tools: ['workspace.*', 'calculator.*', 'memory.*'],
  memory: { recall: true, maxItems: 5, scope: 'all' },
};

/** Offline behaviour for the generic assistant: look, then summarise what was seen. */
const assistantPolicy = (req: ModelRequest): ScriptStep => {
  const listed = req.messages.find((m) => m.role === 'tool' && m.toolName === 'workspace.list');
  if (!listed)
    return call(
      'workspace.list',
      { path: '.', recursive: true, maxEntries: 200 },
      'Let me look at the workspace first.',
    );
  try {
    const data = JSON.parse(listed.content) as { entries: Array<{ path: string; type: string }> };
    const files = data.entries.filter((e) => e.type === 'file').map((e) => e.path);
    return say(
      `[mock provider] The workspace contains ${files.length} files: ${files.slice(0, 15).join(', ')}${files.length > 15 ? ', …' : ''}.`,
    );
  } catch {
    return say('[mock provider] I could not parse the workspace listing.');
  }
};

export interface Booted {
  ls: LoopSmith;
  loaded: LoadedConfig;
  mcp: McpToolSource[];
  close(): Promise<void>;
}

export function resolveDbPath(opts: GlobalOptions, loaded: LoadedConfig): string {
  const raw = opts.db ?? process.env.LOOPSMITH_DB ?? loaded.config.database ?? DEFAULT_DB;
  return path.resolve(opts.db ? process.cwd() : loaded.baseDir, raw);
}

export function openStore(opts: GlobalOptions): { store: SqliteStateStore; loaded: LoadedConfig } {
  const loaded = loadConfig(opts.config);
  return { store: new SqliteStateStore({ path: resolveDbPath(opts, loaded) }), loaded };
}

export interface BootOptions extends GlobalOptions {
  /** Workspace root override (e.g. the demo copy, or a resumed run's root). */
  workspaceRoot?: string;
  store?: StateStore;
  loaded?: LoadedConfig;
  connectMcp?: boolean;
}

export async function boot(opts: BootOptions): Promise<Booted> {
  const loaded = opts.loaded ?? loadConfig(opts.config);
  const { config } = loaded;
  const redactor = new Redactor(secretsFromEnv());

  const providers = new ProviderRegistry({ maxRetries: config.limits?.maxRetries ?? 3 });
  providers.register(
    new ScriptedProvider({
      name: 'mock',
      agents: { ...analystScripts, assistant: assistantPolicy },
    }),
    {
      status: 'ready (deterministic, offline, no API key)',
    },
  );
  registerEnvProviders(providers, { redactor });
  providers.setDefault(
    opts.provider ?? process.env.LOOPSMITH_PROVIDER ?? config.provider ?? 'mock',
  );

  const workspace =
    opts.workspaceRoot ??
    path.resolve(
      opts.workspace ? process.cwd() : loaded.baseDir,
      opts.workspace ?? process.env.LOOPSMITH_WORKSPACE ?? config.workspace ?? '.',
    );
  const ls = await LoopSmith.create({
    database: resolveDbPath(opts, loaded),
    ...(opts.store ? { store: opts.store } : {}),
    workspace,
    providers,
    redactor,
    agents: [...analystAgents, assistantAgent],
    workflows: analystWorkflows,
    handlers: analystHandlers,
    ...(config.limits ? { limits: config.limits } : {}),
    ...(config.policy ? { policy: config.policy } : {}),
    ...(config.compaction ? { compaction: config.compaction } : {}),
  });

  const mcp: McpToolSource[] = [];
  if (opts.connectMcp !== false) {
    for (const [name, server] of Object.entries(config.mcpServers ?? {})) {
      if (server.enabled === false) continue;
      const { source } = await registerMcpServer(ls.tools, {
        name,
        command: server.command,
        args: server.args ?? [],
        ...(server.env ? { env: server.env } : {}),
        cwd: server.cwd ? path.resolve(loaded.baseDir, server.cwd) : loaded.baseDir,
        ...(server.category ? { category: server.category } : {}),
        ...(server.idempotentTools ? { idempotentTools: server.idempotentTools } : {}),
        ...(server.include ? { include: server.include } : {}),
        ...(server.timeoutMs ? { timeoutMs: server.timeoutMs } : {}),
      });
      mcp.push(source);
    }
  }

  return {
    ls,
    loaded,
    mcp,
    async close() {
      for (const source of mcp) await source.close();
      ls.close();
    },
  };
}
