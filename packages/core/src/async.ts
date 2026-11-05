import { randomUUID } from 'node:crypto';
import { LoopSmithError } from './errors.js';

/** Prefixed, collision-resistant identifiers (`run_3f9c...`). */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function throwIfAborted(signal: AbortSignal | undefined, what = 'Operation'): void {
  if (signal?.aborted) {
    throw new LoopSmithError('cancelled', `${what} was cancelled`, { cause: signal.reason });
  }
}

/** Abortable sleep. Rejects with a `cancelled` LoopSmithError on abort. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new LoopSmithError('cancelled', 'Sleep was cancelled'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new LoopSmithError('cancelled', 'Sleep was cancelled'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Combine signals; the result aborts when any input aborts. */
export function anySignal(...signals: Array<AbortSignal | undefined>): AbortSignal {
  const present = signals.filter((s): s is AbortSignal => s !== undefined);
  if (present.length === 1 && present[0]) return present[0];
  return AbortSignal.any(present);
}

export interface TimeoutOptions {
  timeoutMs: number;
  signal?: AbortSignal;
  /** Factory for the timeout error (category defaults to `tool_timeout`). */
  onTimeout?: () => Error;
}

/**
 * Run `fn` with a dedicated AbortSignal that fires on timeout or on parent
 * cancellation. The promise settles as soon as either happens, even if `fn`
 * ignores its signal (the work is then abandoned, never awaited).
 */
export async function withTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  options: TimeoutOptions,
): Promise<T> {
  const controller = new AbortController();
  const parent = options.signal;
  if (parent?.aborted) throw new LoopSmithError('cancelled', 'Operation was cancelled');

  let timer: NodeJS.Timeout | undefined;
  let onParentAbort: (() => void) | undefined;
  const guard = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err =
        options.onTimeout?.() ??
        new LoopSmithError('tool_timeout', `Timed out after ${options.timeoutMs}ms`);
      controller.abort(err);
      reject(err);
    }, options.timeoutMs);
    onParentAbort = () => {
      const err = new LoopSmithError('cancelled', 'Operation was cancelled');
      controller.abort(err);
      reject(err);
    };
    parent?.addEventListener('abort', onParentAbort, { once: true });
  });

  try {
    return await Promise.race([fn(controller.signal), guard]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onParentAbort) parent?.removeEventListener('abort', onParentAbort);
  }
}

/** Exponential backoff with full jitter, capped. `attempt` starts at 1. */
export function backoffDelay(
  attempt: number,
  baseMs: number,
  maxMs: number,
  random: () => number = Math.random,
): number {
  const exp = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
  return Math.round(exp / 2 + random() * (exp / 2));
}
