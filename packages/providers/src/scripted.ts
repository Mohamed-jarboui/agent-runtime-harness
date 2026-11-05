import {
  LoopSmithError,
  sleep,
  type ErrorCategory,
  type ModelCallOptions,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type StopReason,
  type TokenUsage,
} from '@loopsmith/core';

export interface ScriptedToolCall {
  name: string;
  arguments?: unknown;
  id?: string;
  /** Simulate a provider returning malformed JSON arguments. */
  rawArguments?: string;
}

export interface ScriptResponseStep {
  text?: string;
  toolCalls?: ScriptedToolCall[];
  stopReason?: StopReason;
  usage?: TokenUsage;
  /** Artificial latency (abortable) — used to exercise timeouts. */
  delayMs?: number;
}

export interface ScriptFailureStep {
  fail: { category: ErrorCategory; message?: string; retryAfterMs?: number };
  /** Fail this many attempts of the same turn, then answer with `then`. */
  times?: number;
  then?: ScriptResponseStep;
}

export type ScriptStep = ScriptResponseStep | ScriptFailureStep;

export interface ScriptContext {
  /** Model calls this agent has already completed in this run. */
  turn: number;
  /** Attempt number for this turn (1-based; >1 after a retry). */
  attempt: number;
}

export type ScriptFn = (
  request: ModelRequest,
  context: ScriptContext,
) => ScriptStep | Promise<ScriptStep>;
export type ScriptEntry = ScriptStep | ScriptFn;
export type AgentScript = ScriptEntry[] | ScriptFn;

export interface ScriptedProviderOptions {
  name?: string;
  defaultModel?: string;
  /** Scripts keyed by agent id. Array scripts are indexed by the agent's turn. */
  agents?: Record<string, AgentScript>;
  /** Used when an agent has no dedicated script. */
  fallback?: AgentScript;
  /** Behaviour when a script runs out of steps. */
  onExhausted?: 'error' | 'final-answer';
}

/**
 * Deterministic model for development, tests and the offline demo.
 *
 * Scripts are indexed by `metadata.agentTurn`, which the runtime derives from
 * the *persisted* transcript. That makes scripted runs resume-safe: a run
 * paused for approval and resumed in a new process continues exactly where
 * the script left off. Usage is not reported (it would be invented).
 */
export class ScriptedProvider implements ModelProvider {
  readonly kind = 'mock' as const;
  readonly name: string;
  readonly defaultModel: string;
  private readonly attempts = new Map<string, number>();
  readonly calls: ModelRequest[] = [];

  constructor(private readonly options: ScriptedProviderOptions = {}) {
    this.name = options.name ?? 'mock';
    this.defaultModel = options.defaultModel ?? 'scripted-v1';
  }

  async complete(request: ModelRequest, options: ModelCallOptions = {}): Promise<ModelResponse> {
    this.calls.push(request);
    const { agentId, agentTurn, runId } = request.metadata;
    const key = `${runId}:${agentId}:${agentTurn}`;
    const attempt = (this.attempts.get(key) ?? 0) + 1;
    this.attempts.set(key, attempt);

    const script = this.options.agents?.[agentId] ?? this.options.fallback;
    if (!script) {
      throw new LoopSmithError('configuration', `No mock script for agent "${agentId}"`);
    }
    let entry: ScriptEntry | undefined = typeof script === 'function' ? script : script[agentTurn];
    if (entry === undefined) {
      if (this.options.onExhausted === 'final-answer') entry = { text: '[mock script exhausted]' };
      else
        throw new LoopSmithError(
          'invalid_model_response',
          `Mock script for "${agentId}" exhausted at turn ${agentTurn}`,
          { code: 'mock_script_exhausted' },
        );
    }
    let step: ScriptStep =
      typeof entry === 'function' ? await entry(request, { turn: agentTurn, attempt }) : entry;

    if ('fail' in step) {
      const times = step.times ?? Number.POSITIVE_INFINITY;
      if (attempt <= times || !step.then) {
        throw new LoopSmithError(
          step.fail.category,
          step.fail.message ?? `mock ${step.fail.category}`,
          {
            ...(step.fail.retryAfterMs === undefined
              ? {}
              : { retryAfterMs: step.fail.retryAfterMs }),
          },
        );
      }
      step = step.then;
    }
    if (step.delayMs) await sleep(step.delayMs, options.signal);

    const toolCalls = (step.toolCalls ?? []).map((call, index) => ({
      id: call.id ?? `call_${agentId}_${agentTurn}_${index}`,
      name: call.name,
      arguments: call.rawArguments === undefined ? (call.arguments ?? {}) : null,
      ...(call.rawArguments === undefined
        ? {}
        : { rawArguments: call.rawArguments, parseError: 'Unexpected token in JSON (mock)' }),
    }));
    const response: ModelResponse = {
      content: step.text ?? '',
      toolCalls,
      stopReason: step.stopReason ?? (toolCalls.length > 0 ? 'tool_use' : 'end_turn'),
      provider: this.name,
      model: request.model,
    };
    if (step.usage) response.usage = step.usage;
    return response;
  }
}

/** Helpers for terse scripts in tests and examples. */
export const say = (text: string): ScriptResponseStep => ({ text });
export const call = (name: string, args: unknown = {}, text = ''): ScriptResponseStep => ({
  text,
  toolCalls: [{ name, arguments: args }],
});
export const calls = (list: Array<[string, unknown]>, text = ''): ScriptResponseStep => ({
  text,
  toolCalls: list.map(([name, args]) => ({ name, arguments: args })),
});
