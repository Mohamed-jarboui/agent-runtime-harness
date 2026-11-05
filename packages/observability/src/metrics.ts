import type { RunRecord, RuntimeEvent, StateStore } from '@loopsmith/core';
import { estimateCost } from './pricing.js';

export interface RunMetrics {
  rootRunId: string;
  status: RunRecord['status'];
  kind: RunRecord['kind'];
  agentRuns: number;
  modelCalls: number;
  iterations: number;
  toolCalls: number;
  toolErrors: number;
  toolsDenied: number;
  approvalsRequested: number;
  approvalsApproved: number;
  approvalsRejected: number;
  handoffs: number;
  delegations: number;
  retries: number;
  fallbacks: number;
  recoveries: number;
  compactions: number;
  workflowSteps: number;
  durationMs: number | null;
  toolTimeMs: number;
  modelTimeMs: number;
  usage: { inputTokens: number; outputTokens: number; reported: boolean };
  /** Present only when every model used has known pricing. */
  estimatedCostUsd: number | null;
  providers: string[];
  toolsUsed: Record<string, number>;
}

/** Derive metrics for a whole run tree from persisted runs and events. */
export function computeRunMetrics(store: StateStore, rootRunId: string): RunMetrics {
  const root = store.getRun(rootRunId);
  if (!root) throw new Error(`Run not found: ${rootRunId}`);
  const runs = store.listRuns({ rootRunId, limit: 10_000 });
  const events = store.listEvents({ rootRunId });
  return metricsFromEvents(root, runs, events);
}

export function metricsFromEvents(
  root: RunRecord,
  runs: RunRecord[],
  events: RuntimeEvent[],
): RunMetrics {
  const count = (type: RuntimeEvent['type']): number =>
    events.filter((e) => e.type === type).length;
  const toolsUsed: Record<string, number> = {};
  let toolTimeMs = 0;
  let modelTimeMs = 0;
  const providerModels = new Map<
    string,
    { provider: string; model: string; input: number; output: number }
  >();
  let reported = false;
  let inputTokens = 0;
  let outputTokens = 0;

  for (const event of events) {
    if (event.type === 'tool.completed' || event.type === 'tool.failed') {
      const name = String(event.data.tool ?? 'unknown');
      toolsUsed[name] = (toolsUsed[name] ?? 0) + 1;
      toolTimeMs += event.durationMs ?? 0;
    }
    if (event.type === 'model.response') {
      modelTimeMs += event.durationMs ?? 0;
      const provider = String(event.data.providerKind ?? event.data.provider ?? 'unknown');
      const model = String(event.data.model ?? 'unknown');
      const key = `${provider}:${model}`;
      const entry = providerModels.get(key) ?? { provider, model, input: 0, output: 0 };
      const usage = event.data.usage as { inputTokens?: number; outputTokens?: number } | undefined;
      if (usage) {
        reported = true;
        entry.input += usage.inputTokens ?? 0;
        entry.output += usage.outputTokens ?? 0;
        inputTokens += usage.inputTokens ?? 0;
        outputTokens += usage.outputTokens ?? 0;
      }
      providerModels.set(key, entry);
    }
  }

  let estimatedCostUsd: number | null = null;
  if (reported && providerModels.size > 0) {
    let total = 0;
    let known = true;
    for (const pm of providerModels.values()) {
      const cost = estimateCost(pm.provider, pm.model, pm.input, pm.output);
      if (cost === null) known = false;
      else total += cost;
    }
    estimatedCostUsd = known ? Math.round(total * 1e6) / 1e6 : null;
  }

  const start = root.startedAt ? Date.parse(root.startedAt) : null;
  const end = root.endedAt ? Date.parse(root.endedAt) : null;
  const agentRuns = runs.filter((r) => r.kind === 'agent');

  return {
    rootRunId: root.id,
    status: root.status,
    kind: root.kind,
    agentRuns: agentRuns.length,
    modelCalls: count('model.response'),
    iterations: agentRuns.reduce((sum, r) => sum + r.iteration, 0),
    toolCalls: count('tool.completed') + count('tool.failed'),
    toolErrors: count('tool.failed'),
    toolsDenied: count('tool.denied'),
    approvalsRequested: count('approval.requested'),
    approvalsApproved: events.filter(
      (e) => e.type === 'approval.decided' && e.data.status === 'approved',
    ).length,
    approvalsRejected: events.filter(
      (e) => e.type === 'approval.decided' && e.data.status === 'rejected',
    ).length,
    handoffs: count('agent.handoff'),
    delegations: count('agent.delegation.started'),
    retries: count('model.retry') + count('workflow.node.retry'),
    fallbacks: count('model.fallback'),
    recoveries: count('recovery.attempted'),
    compactions: count('context.compacted'),
    workflowSteps: count('workflow.node.completed'),
    durationMs: start !== null && end !== null ? end - start : null,
    toolTimeMs,
    modelTimeMs,
    usage: { inputTokens, outputTokens, reported },
    estimatedCostUsd,
    providers: [...new Set([...providerModels.values()].map((p) => `${p.provider}/${p.model}`))],
    toolsUsed,
  };
}
