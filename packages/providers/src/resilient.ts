import {
  LoopSmithError,
  anySignal,
  backoffDelay,
  sleep,
  throwIfAborted,
  toLoopSmithError,
  type ErrorCategory,
  type ModelCallOptions,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
} from '@loopsmith/core';

export interface RetryPolicy {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Per-attempt timeout. */
  timeoutMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 3,
  baseDelayMs: 500,
  maxDelayMs: 15_000,
  timeoutMs: 120_000,
};

export interface RetryEvent {
  attempt: number;
  delayMs: number;
  category: ErrorCategory;
  message: string;
  provider: string;
}

export interface ResilientOptions {
  policy?: Partial<RetryPolicy>;
  onRetry?: (event: RetryEvent) => void;
  random?: () => number;
}

/**
 * Wraps a provider with bounded retries (exponential backoff + full jitter),
 * per-attempt timeouts and `retry-after` support. Only errors classified as
 * retryable are retried; a model call has no side effects, so retrying it is
 * always safe — tool execution is never retried here.
 */
export class ResilientProvider implements ModelProvider {
  readonly name: string;
  readonly kind: ModelProvider['kind'];
  readonly defaultModel: string;
  private readonly policy: RetryPolicy;

  constructor(
    readonly inner: ModelProvider,
    private readonly options: ResilientOptions = {},
  ) {
    this.name = inner.name;
    this.kind = inner.kind;
    this.defaultModel = inner.defaultModel;
    this.policy = { ...DEFAULT_RETRY_POLICY, ...options.policy };
  }

  async complete(request: ModelRequest, options: ModelCallOptions = {}): Promise<ModelResponse> {
    let attempt = 0;
    // Bounded: at most maxRetries + 1 attempts.
    for (;;) {
      attempt += 1;
      throwIfAborted(options.signal, 'Model request');
      const timeout = AbortSignal.timeout(this.policy.timeoutMs);
      try {
        return await this.inner.complete(request, {
          ...options,
          signal: anySignal(options.signal, timeout),
        });
      } catch (raw) {
        let err = toLoopSmithError(raw, 'provider_transient');
        if (options.signal?.aborted)
          throw new LoopSmithError('cancelled', 'Model request was cancelled');
        if (timeout.aborted && err.category === 'cancelled') {
          err = new LoopSmithError(
            'provider_timeout',
            `Model request timed out after ${this.policy.timeoutMs}ms`,
          );
        }
        if (!err.retryable || attempt > this.policy.maxRetries) {
          if (attempt > 1) err.details.attempts = attempt;
          throw err;
        }
        const delayMs = Math.max(
          err.retryAfterMs ?? 0,
          backoffDelay(
            attempt,
            this.policy.baseDelayMs,
            this.policy.maxDelayMs,
            this.options.random,
          ),
        );
        const event: RetryEvent = {
          attempt,
          delayMs,
          category: err.category,
          message: err.message,
          provider: this.name,
        };
        this.options.onRetry?.(event);
        options.observer?.onRetry?.(event);
        await sleep(Math.min(delayMs, this.policy.maxDelayMs), options.signal);
      }
    }
  }
}

export interface FallbackEntry {
  provider: ModelProvider;
  /** Model to use on this provider; defaults to the provider's default. */
  model?: string;
}

/** Categories that justify trying the next provider. */
const FALLBACK_CATEGORIES: ReadonlySet<ErrorCategory> = new Set([
  'provider_transient',
  'provider_rate_limit',
  'provider_timeout',
  'provider_auth',
]);

/**
 * Ordered provider fallback. Each entry is usually a ResilientProvider, so a
 * provider exhausts its own retries before the next one is tried.
 */
export class FallbackProvider implements ModelProvider {
  readonly kind = 'composite' as const;
  readonly defaultModel: string;

  constructor(
    readonly name: string,
    private readonly entries: FallbackEntry[],
    private readonly onFallback?: (event: {
      from: string;
      to: string;
      category: ErrorCategory;
      message: string;
    }) => void,
  ) {
    if (entries.length === 0)
      throw new LoopSmithError('configuration', 'FallbackProvider needs at least one entry');
    this.defaultModel = entries[0]?.model ?? entries[0]?.provider.defaultModel ?? 'unknown';
  }

  async complete(request: ModelRequest, options: ModelCallOptions = {}): Promise<ModelResponse> {
    let lastError: LoopSmithError | undefined;
    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i] as FallbackEntry;
      const model = i === 0 ? request.model : (entry.model ?? entry.provider.defaultModel);
      try {
        return await entry.provider.complete({ ...request, model }, options);
      } catch (raw) {
        const err = toLoopSmithError(raw);
        lastError = err;
        const next = this.entries[i + 1];
        if (!next || !FALLBACK_CATEGORIES.has(err.category)) throw err;
        const event = {
          from: entry.provider.name,
          to: next.provider.name,
          category: err.category,
          message: err.message,
        };
        this.onFallback?.(event);
        options.observer?.onFallback?.(event);
      }
    }
    throw lastError ?? new LoopSmithError('internal', 'Fallback chain exhausted');
  }
}
