import { LoopSmithError, type Redactor } from '@loopsmith/core';

type HeaderBag = Headers | Record<string, string | string[] | undefined> | undefined;

function header(headers: HeaderBag, name: string): string | undefined {
  if (!headers) return undefined;
  if (typeof (headers as Headers).get === 'function')
    return (headers as Headers).get(name) ?? undefined;
  const value = (headers as Record<string, string | string[] | undefined>)[name];
  return Array.isArray(value) ? value[0] : value;
}

/** Parse `retry-after-ms` / `retry-after` (seconds or HTTP date). */
export function parseRetryAfter(headers: HeaderBag, now = Date.now()): number | undefined {
  const msHeader = header(headers, 'retry-after-ms');
  if (msHeader && !Number.isNaN(Number(msHeader))) return Math.max(0, Number(msHeader));
  const value = header(headers, 'retry-after');
  if (!value) return undefined;
  const seconds = Number(value);
  if (!Number.isNaN(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

/**
 * Map an HTTP status from any provider into a LoopSmith error category.
 * Messages are redacted because SDK errors can echo request fragments.
 */
export function classifyHttpError(
  provider: string,
  status: number | undefined,
  rawMessage: string,
  headers: HeaderBag,
  redactor: Redactor,
  cause?: unknown,
): LoopSmithError {
  const message = `${provider}: ${redactor.redactString(rawMessage)}`;
  const details = { provider, status };
  if (status === undefined) {
    return new LoopSmithError('provider_transient', message, {
      code: 'connection_error',
      details,
      cause,
    });
  }
  if (status === 401 || status === 403) {
    return new LoopSmithError('provider_auth', message, { code: `http_${status}`, details, cause });
  }
  if (status === 408) {
    return new LoopSmithError('provider_timeout', message, { code: 'http_408', details, cause });
  }
  if (status === 429) {
    const retryAfterMs = parseRetryAfter(headers);
    return new LoopSmithError('provider_rate_limit', message, {
      code: 'http_429',
      details,
      cause,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    });
  }
  if (status === 409 || status >= 500) {
    return new LoopSmithError('provider_transient', message, {
      code: `http_${status}`,
      details,
      cause,
    });
  }
  return new LoopSmithError('provider_invalid_request', message, {
    code: `http_${status}`,
    details,
    cause,
  });
}
