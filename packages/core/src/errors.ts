/**
 * Structured error model shared by every LoopSmith module.
 *
 * Every failure that crosses a module boundary is normalised into a
 * {@link LoopSmithError} with a stable `category`. The category drives retry
 * decisions, recovery behaviour and evaluation metrics, so callers never need
 * to string-match error messages.
 */

export const ERROR_CATEGORIES = [
  'provider_transient',
  'provider_rate_limit',
  'provider_timeout',
  'provider_auth',
  'provider_invalid_request',
  'model_refusal',
  'invalid_model_response',
  'invalid_tool_arguments',
  'unknown_tool',
  'tool_execution',
  'tool_timeout',
  'permission_denied',
  'approval_rejected',
  'limit_exceeded',
  'context_overflow',
  'cancelled',
  'workflow',
  'configuration',
  'storage',
  'internal',
] as const;

export type ErrorCategory = (typeof ERROR_CATEGORIES)[number];

/** Categories that are safe to retry automatically (no side effects happened). */
const RETRYABLE: ReadonlySet<ErrorCategory> = new Set([
  'provider_transient',
  'provider_rate_limit',
  'provider_timeout',
]);

export interface LoopSmithErrorOptions {
  code?: string;
  retryable?: boolean;
  retryAfterMs?: number;
  details?: Record<string, unknown>;
  cause?: unknown;
}

export class LoopSmithError extends Error {
  readonly category: ErrorCategory;
  readonly code: string;
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;
  readonly details: Record<string, unknown>;

  constructor(category: ErrorCategory, message: string, options: LoopSmithErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'LoopSmithError';
    this.category = category;
    this.code = options.code ?? category;
    this.retryable = options.retryable ?? RETRYABLE.has(category);
    this.retryAfterMs = options.retryAfterMs;
    this.details = options.details ?? {};
  }
}

export interface SerializedError {
  category: ErrorCategory;
  code: string;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export function isLoopSmithError(value: unknown): value is LoopSmithError {
  return value instanceof LoopSmithError;
}

/** Normalise any thrown value into a LoopSmithError (never throws). */
export function toLoopSmithError(
  value: unknown,
  fallback: ErrorCategory = 'internal',
): LoopSmithError {
  if (value instanceof LoopSmithError) return value;
  if (isAbortError(value)) {
    return new LoopSmithError('cancelled', 'Operation was cancelled', { cause: value });
  }
  if (value instanceof Error) {
    return new LoopSmithError(fallback, value.message, { cause: value });
  }
  return new LoopSmithError(fallback, typeof value === 'string' ? value : 'Unknown error');
}

export function serializeError(value: unknown): SerializedError {
  const err = toLoopSmithError(value);
  const out: SerializedError = {
    category: err.category,
    code: err.code,
    message: err.message,
    retryable: err.retryable,
  };
  if (Object.keys(err.details).length > 0) out.details = err.details;
  return out;
}

export function isAbortError(value: unknown): boolean {
  if (value instanceof LoopSmithError) return value.category === 'cancelled';
  if (typeof value !== 'object' || value === null) return false;
  const name = (value as { name?: unknown }).name;
  return name === 'AbortError' || name === 'APIUserAbortError';
}
