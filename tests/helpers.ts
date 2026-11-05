import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AgentDefinition, ExecutionLimits } from '@loopsmith/core';
import { LoopSmith, type LoopSmithOptions } from '@loopsmith/orchestration';
import {
  ProviderRegistry,
  ScriptedProvider,
  type ScriptedProviderOptions,
} from '@loopsmith/providers';
import type { WorkflowDefinition } from '@loopsmith/workflow-engine';

/** Create a throwaway workspace directory populated with `files`. */
export function makeWorkspace(files: Record<string, string> = {}): string {
  const root = mkdtempSync(path.join(tmpdir(), 'loopsmith-ws-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

export function tempDb(): string {
  return path.join(mkdtempSync(path.join(tmpdir(), 'loopsmith-db-')), 'state.db');
}

export const assistantAgent = (overrides: Partial<AgentDefinition> = {}): AgentDefinition => ({
  id: 'assistant',
  name: 'Assistant',
  description: 'Test agent',
  instructions: 'You are a careful test agent.',
  tools: ['workspace.*', 'calculator.*', 'memory.*'],
  ...overrides,
});

export interface Harness {
  ls: LoopSmith;
  provider: ScriptedProvider;
  workspace: string;
  database: string;
}

export async function createHarness(options: {
  script: ScriptedProviderOptions;
  agents?: AgentDefinition[];
  workflows?: WorkflowDefinition[];
  files?: Record<string, string>;
  limits?: Partial<ExecutionLimits>;
  extra?: Partial<LoopSmithOptions>;
  database?: string;
  workspace?: string;
}): Promise<Harness> {
  const provider = new ScriptedProvider(options.script);
  const providers = new ProviderRegistry({
    baseDelayMs: 1,
    maxDelayMs: 5,
    maxRetries: 3,
    timeoutMs: 5000,
  });
  providers.register(provider);
  const workspace =
    options.workspace ?? makeWorkspace(options.files ?? { 'README.md': '# Demo\nHello\n' });
  const database = options.database ?? tempDb();
  const ls = await LoopSmith.create({
    database,
    workspace,
    providers,
    agents: options.agents ?? [assistantAgent()],
    workflows: options.workflows ?? [],
    limits: { maxRuntimeMs: 20_000, ...options.limits },
    ...options.extra,
  });
  return { ls, provider, workspace, database };
}
