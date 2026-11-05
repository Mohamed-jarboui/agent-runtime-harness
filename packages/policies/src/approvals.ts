import type { ApprovalRecord } from '@loopsmith/core';

export type ApprovalOutcome =
  { decision: 'approved' | 'rejected'; by: string; note?: string } | { decision: 'defer' };

/**
 * Decides what happens the moment an approval is requested. The approval is
 * always persisted first; the resolver only chooses between deciding now
 * (interactive prompt, CI auto-policy) and deferring, which pauses the run
 * until someone runs `loopsmith approvals approve|reject`.
 */
export interface ApprovalResolver {
  resolve(approval: ApprovalRecord): Promise<ApprovalOutcome>;
}

/** Default: never decide automatically; pause and wait for a human. */
export class DeferApprovals implements ApprovalResolver {
  async resolve(): Promise<ApprovalOutcome> {
    return { decision: 'defer' };
  }
}

/** Approve everything. Only for demos/tests; decisions are still recorded. */
export class AutoApprove implements ApprovalResolver {
  constructor(private readonly by = 'auto-approve') {}
  async resolve(): Promise<ApprovalOutcome> {
    return { decision: 'approved', by: this.by, note: 'auto-approved by configuration' };
  }
}

export class AutoReject implements ApprovalResolver {
  constructor(private readonly by = 'auto-reject') {}
  async resolve(): Promise<ApprovalOutcome> {
    return { decision: 'rejected', by: this.by, note: 'auto-rejected by configuration' };
  }
}

/** Delegate to an async callback (e.g. an interactive terminal prompt). */
export class CallbackApprovals implements ApprovalResolver {
  constructor(private readonly callback: (approval: ApprovalRecord) => Promise<ApprovalOutcome>) {}
  resolve(approval: ApprovalRecord): Promise<ApprovalOutcome> {
    return this.callback(approval);
  }
}

/** One-line description of what is being approved, for prompts and events. */
export function summarizeApproval(approval: ApprovalRecord): string {
  if (approval.kind === 'workflow_gate') return approval.reason;
  const args = approval.arguments as Record<string, unknown> | null;
  const target = args && typeof args.path === 'string' ? ` ${args.path}` : '';
  const size = args && typeof args.content === 'string' ? ` (${args.content.length} chars)` : '';
  return `${approval.toolName ?? 'tool'}${target}${size} — requested by ${approval.agentId ?? 'workflow'}`;
}
