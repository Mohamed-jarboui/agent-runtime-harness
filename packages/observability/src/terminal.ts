import pc from 'picocolors';
import type { RuntimeEvent } from '@loopsmith/core';

export interface RenderOptions {
  /** Show model request/response events (verbose). */
  verbose?: boolean;
  /** Include wall-clock timestamps. */
  timestamps?: boolean;
  colors?: boolean;
}

const short = (value: unknown, max = 90): string => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text === undefined) return '';
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
};

const ms = (value: number | undefined): string =>
  value === undefined ? '' : value >= 1000 ? ` ${(value / 1000).toFixed(2)}s` : ` ${value}ms`;

/**
 * Human-readable rendering of a single runtime event, or `null` when the
 * event is not interesting at the chosen verbosity.
 */
export function formatEvent(event: RuntimeEvent, options: RenderOptions = {}): string | null {
  const c = options.colors === false ? pc.createColors(false) : pc;
  const d = event.data;
  const depth = typeof d.depth === 'number' ? d.depth : 0;
  const indent = '  '.repeat((event.nodeId ? 1 : 0) + depth);
  const agent = event.agentId ? c.cyan(`[${event.agentId}]`) + ' ' : '';
  const time = options.timestamps ? c.dim(event.timestamp.slice(11, 23)) + ' ' : '';
  const line = (icon: string, text: string): string => `${time}${indent}${icon} ${text}`;

  switch (event.type) {
    case 'run.started':
      return line(
        c.bold('▶'),
        `${c.bold('run')} ${event.runId} started ${c.dim(`(${String(d.kind)}: ${String(d.target)})`)}`,
      );
    case 'run.resumed':
      return line(c.bold('↻'), `run ${event.runId} resumed ${c.dim(String(d.reason ?? ''))}`);
    case 'run.paused':
      return line(c.yellow('⏸'), c.yellow(`run ${event.runId} paused: ${String(d.reason)}`));
    case 'run.completed':
      return line(c.green('✔'), `${agent}run ${event.runId} completed${ms(event.durationMs)}`);
    case 'run.failed':
      return line(
        c.red('✖'),
        c.red(
          `run ${event.runId} failed: ${short((d.error as { message?: string })?.message ?? d.error)}`,
        ),
      );
    case 'run.cancelled':
      return line(c.red('■'), c.red(`run ${event.runId} cancelled`));
    case 'agent.selected':
      return line(
        c.cyan('●'),
        `${agent}agent selected ${c.dim(`(${String(d.provider)}/${String(d.model)})`)}`,
      );
    case 'agent.handoff':
      return line(
        c.magenta('⇢'),
        `${agent}handoff → ${c.cyan(String(d.to))}: ${short(d.reason, 70)}`,
      );
    case 'agent.delegation.started':
      return line(
        c.magenta('⤷'),
        `${agent}delegates to ${c.cyan(String(d.to))}: ${short(d.task, 70)}`,
      );
    case 'agent.delegation.completed':
      return line(
        c.magenta('⤶'),
        `${agent}delegation to ${c.cyan(String(d.to))} ${String(d.status)}`,
      );
    case 'model.request':
      return options.verbose
        ? line(
            c.dim('→'),
            c.dim(
              `${agent}model request #${String(d.iteration)} · ~${String(d.estimatedTokens)} tokens (est.) · ${String(d.tools)} tools`,
            ),
          )
        : null;
    case 'model.response': {
      const calls = Number(d.toolCalls ?? 0);
      const usage = d.usage as { inputTokens?: number; outputTokens?: number } | undefined;
      const tokens = usage ? ` · ${usage.inputTokens ?? 0}→${usage.outputTokens ?? 0} tok` : '';
      const what = calls > 0 ? `${calls} tool call${calls === 1 ? '' : 's'}` : 'final answer';
      return line(
        c.blue('◆'),
        `${agent}model → ${what}${c.dim(`${ms(event.durationMs)}${tokens}`)}`,
      );
    }
    case 'model.retry':
      return line(
        c.yellow('↺'),
        c.yellow(
          `${agent}model retry ${String(d.attempt)} after ${String(d.category)} (wait ${String(d.delayMs)}ms)`,
        ),
      );
    case 'model.fallback':
      return line(
        c.yellow('⇄'),
        c.yellow(
          `${agent}provider fallback ${String(d.from)} → ${String(d.to)} (${String(d.category)})`,
        ),
      );
    case 'tool.started':
      return options.verbose
        ? line(c.dim('⚙'), c.dim(`${agent}${String(d.tool)} ${short(d.arguments, 70)}`))
        : null;
    case 'tool.completed':
      return line(
        c.green('⚙'),
        `${agent}${c.bold(String(d.tool))} ${c.dim(short(d.arguments, 60))} ${c.green('ok')}${c.dim(ms(event.durationMs))}`,
      );
    case 'tool.failed':
      return line(
        c.red('⚙'),
        `${agent}${c.bold(String(d.tool))} ${c.red(`${String(d.category)}`)}: ${short(d.message, 70)}`,
      );
    case 'tool.denied':
      return line(
        c.red('⛔'),
        `${agent}${c.bold(String(d.tool))} denied by policy: ${short(d.reason, 70)}`,
      );
    case 'approval.requested':
      return line(
        c.yellow('⏸'),
        c.yellow(`approval required ${c.bold(String(d.approvalId))}: ${short(d.summary, 80)}`),
      );
    case 'approval.decided':
      return line(
        d.status === 'approved' ? c.green('✓') : c.red('✗'),
        `approval ${String(d.approvalId)} ${String(d.status)} by ${String(d.by)}`,
      );
    case 'workflow.started':
      return line(
        c.bold('▶'),
        `${c.bold('workflow')} ${String(d.workflowId)} started ${c.dim(event.runId)}`,
      );
    case 'workflow.resumed':
      return line(c.bold('↻'), `workflow resumed at node ${String(d.nodeId)}`);
    case 'workflow.node.started':
      return `${time}${c.bold('◇')} node ${c.bold(String(event.nodeId))} ${c.dim(`(${String(d.nodeType)}${d.target ? `: ${String(d.target)}` : ''}, visit ${String(d.visit)})`)}`;
    case 'workflow.node.failed':
      return `${time}${c.red('✖')} node ${String(event.nodeId)} failed: ${short(d.message)}`;
    case 'workflow.node.retry':
      return `${time}${c.yellow('↺')} node ${String(event.nodeId)} retry ${String(d.attempt)}`;
    case 'workflow.transition':
      return `${time}${c.dim(`  ↓ ${String(d.from)} → ${String(d.to)}${d.reason ? ` (${String(d.reason)})` : ''}`)}`;
    case 'workflow.paused':
      return `${time}${c.yellow('⏸')} ${c.yellow(`workflow paused at ${String(d.nodeId)}: ${String(d.reason)}`)}`;
    case 'workflow.completed':
      return `${time}${c.green('✔')} ${c.bold('workflow completed')}${c.dim(ms(event.durationMs))}`;
    case 'workflow.failed':
      return `${time}${c.red('✖')} ${c.red(`workflow failed: ${short(d.message)}`)}`;
    case 'context.compacted':
      return line(
        c.magenta('⊟'),
        `${agent}context compacted (${String(d.strategy)}): ~${String(d.tokensBefore)} → ~${String(d.tokensAfter)} tokens (est.)`,
      );
    case 'memory.recalled':
      return options.verbose
        ? line(c.dim('☰'), c.dim(`${agent}recalled ${String(d.count)} memories`))
        : null;
    case 'memory.stored':
      return line(c.magenta('☰'), `${agent}memory stored: ${short(d.content, 70)}`);
    case 'recovery.attempted':
      return line(
        c.yellow('✚'),
        c.yellow(`${agent}recovery (${String(d.reason)}) attempt ${String(d.attempt)}`),
      );
    case 'limit.exceeded':
      return line(
        c.red('⛔'),
        c.red(`${agent}limit exceeded: ${String(d.limit)} (${String(d.value)})`),
      );
    case 'security.flagged':
      return line(
        c.yellow('⚠'),
        c.yellow(`${agent}untrusted content flagged in ${String(d.source)}: ${String(d.signal)}`),
      );
    case 'error':
      return line(c.red('!'), c.red(short(d.message)));
    default:
      return null;
  }
}

export class TerminalTraceRenderer {
  constructor(
    private readonly write: (line: string) => void,
    private readonly options: RenderOptions = {},
  ) {}

  readonly listener = (event: RuntimeEvent): void => {
    const text = formatEvent(event, this.options);
    if (text !== null) this.write(text);
  };
}
