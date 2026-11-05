import { createInterface } from 'node:readline/promises';
import pc from 'picocolors';
import { TerminalTraceRenderer } from '@loopsmith/observability';
import type { LoopSmith, RunOutcome } from '@loopsmith/orchestration';
import {
  AutoApprove,
  CallbackApprovals,
  DeferApprovals,
  type ApprovalResolver,
} from '@loopsmith/policies';
import { approvalBlock, out, printOutcome } from './render.js';

export interface ExecuteFlags {
  yes?: boolean;
  defer?: boolean;
  json?: boolean;
  verbose?: boolean;
}

/** Interactive approvals when attached to a TTY; otherwise defer (pause + persist). */
export function approvalResolver(flags: ExecuteFlags): ApprovalResolver {
  if (flags.yes) return new AutoApprove('cli:--yes');
  if (flags.defer || flags.json || !process.stdin.isTTY || !process.stdout.isTTY)
    return new DeferApprovals();
  return new CallbackApprovals(async (approval) => {
    out();
    for (const line of approvalBlock(approval)) out(line);
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      for (let attempt = 0; attempt < 5; attempt++) {
        const answer = (
          await rl.question(
            `   ${pc.bold('[a]pprove')} / ${pc.bold('[r]eject')} / ${pc.bold('[d]efer')} (pause run) › `,
          )
        )
          .trim()
          .toLowerCase();
        if (answer === 'a' || answer === 'approve' || answer === 'y')
          return { decision: 'approved', by: `cli:${process.env.USER ?? 'user'}` };
        if (answer === 'r' || answer === 'reject' || answer === 'n') {
          const note = (await rl.question('   reason (optional) › ')).trim();
          return {
            decision: 'rejected',
            by: `cli:${process.env.USER ?? 'user'}`,
            ...(note ? { note } : {}),
          };
        }
        if (answer === 'd' || answer === 'defer' || answer === '') return { decision: 'defer' };
      }
      return { decision: 'defer' };
    } finally {
      rl.close();
    }
  });
}

/**
 * Run something against the runtime with live trace rendering, Ctrl-C
 * cancellation (the run is marked `cancelled` and can be inspected), and a
 * final summary.
 */
export async function executeWithTrace(
  ls: LoopSmith,
  flags: ExecuteFlags,
  fn: (ctx: { signal: AbortSignal; approvals: ApprovalResolver }) => Promise<RunOutcome>,
): Promise<RunOutcome> {
  const controller = new AbortController();
  let interrupts = 0;
  const onSigint = (): void => {
    interrupts += 1;
    if (interrupts > 1) process.exit(130);
    process.stderr.write(pc.yellow('\nCancelling… (press Ctrl-C again to force quit)\n'));
    controller.abort(new Error('Interrupted by user'));
  };
  process.on('SIGINT', onSigint);
  const unsubscribe = flags.json
    ? () => undefined
    : ls.events.subscribe(
        new TerminalTraceRenderer((line) => out(line), { verbose: flags.verbose ?? false })
          .listener,
      );
  try {
    const outcome = await fn({ signal: controller.signal, approvals: approvalResolver(flags) });
    if (flags.json) out(JSON.stringify(outcome, null, 2));
    else printOutcome(outcome, ls.inspect(outcome.runId));
    process.exitCode = outcome.status === 'failed' ? 1 : outcome.status === 'cancelled' ? 130 : 0;
    return outcome;
  } finally {
    unsubscribe();
    process.off('SIGINT', onSigint);
  }
}
