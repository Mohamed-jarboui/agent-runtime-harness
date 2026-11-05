import { z } from 'zod';

/**
 * Hard execution limits. Every loop in LoopSmith is bounded by one of these;
 * there is no unbounded `while (true)` anywhere in the runtime.
 */
export const ExecutionLimitsSchema = z.object({
  /** Maximum model calls per agent run. */
  maxIterations: z.number().int().positive().max(500).default(12),
  /** Maximum tool executions per agent run. */
  maxToolCalls: z.number().int().positive().max(2000).default(40),
  /** Wall-clock budget per execution segment (start or resume), in ms. */
  maxRuntimeMs: z.number().int().positive().default(300_000),
  /** Provider retries for transient failures (per model call). */
  maxRetries: z.number().int().min(0).max(10).default(3),
  /** Re-prompts after invalid / empty / truncated model responses. */
  maxRecoveryAttempts: z.number().int().min(0).max(10).default(2),
  /** Estimated token budget for a single model request. */
  contextBudgetTokens: z.number().int().positive().default(100_000),
  /** Default per-tool timeout (tools may declare a lower one). */
  toolTimeoutMs: z.number().int().positive().default(30_000),
  /** Tool output is truncated to this many characters before the model sees it. */
  maxToolOutputChars: z.number().int().positive().default(20_000),
  /** Control transfers allowed across a whole run tree. */
  maxHandoffs: z.number().int().min(0).max(50).default(4),
  /** Maximum nesting depth of delegated sub-runs. */
  maxDelegationDepth: z.number().int().min(0).max(5).default(2),
});

export type ExecutionLimits = z.infer<typeof ExecutionLimitsSchema>;

export const DEFAULT_LIMITS: ExecutionLimits = ExecutionLimitsSchema.parse({});

export function resolveLimits(
  ...overrides: Array<Partial<ExecutionLimits> | undefined>
): ExecutionLimits {
  const merged: Partial<ExecutionLimits> = {};
  for (const o of overrides) if (o) Object.assign(merged, stripUndefined(o));
  return ExecutionLimitsSchema.parse({ ...DEFAULT_LIMITS, ...merged });
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}
