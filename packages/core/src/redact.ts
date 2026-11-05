/*
 * Secret redaction. Applied to every event before it is persisted, logged or
 * exported, and to provider error messages before they surface to users.
 * Redaction is defence in depth, not a guarantee: it catches known key names,
 * common credential formats and explicitly registered secret values.
 */
/**
 * Key names whose values are always redacted. Matching is on the normalised
 * key suffix, so `apiKey`, `x-api-key` and `ACCESS_TOKEN` match while
 * `inputTokens` or `maxTokens` (counts, not secrets) do not.
 */
const SENSITIVE_SUFFIXES = [
  'apikey',
  'secret',
  'secretkey',
  'token',
  'password',
  'passwd',
  'authorization',
  'cookie',
  'credential',
  'credentials',
  'privatekey',
  'accesskey',
  'sessionid',
];

export function isSensitiveKey(key: string): boolean {
  const normalised = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return SENSITIVE_SUFFIXES.some((suffix) => normalised.endsWith(suffix));
}

const SECRET_PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g, // Anthropic
  /sk-(?:proj-)?[A-Za-z0-9_-]{16,}/g, // OpenAI-style
  /gh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub tokens
  /AKIA[0-9A-Z]{16}/g, // AWS access key ids
  /xox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

export const REDACTED = '[REDACTED]';

export class Redactor {
  private readonly literals = new Set<string>();

  constructor(secretValues: Iterable<string | undefined> = []) {
    for (const value of secretValues) this.addSecret(value);
  }

  /** Register an exact secret value (e.g. the configured API key). */
  addSecret(value: string | undefined): void {
    if (value && value.length >= 6) this.literals.add(value);
  }

  redactString(input: string): string {
    let out = input;
    for (const literal of this.literals) out = out.split(literal).join(REDACTED);
    for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, REDACTED);
    return out;
  }

  redact<T>(value: T, depth = 0): T {
    if (depth > 12) return value;
    if (typeof value === 'string') return this.redactString(value) as T;
    if (Array.isArray(value)) return value.map((v) => this.redact(v, depth + 1)) as T;
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
        out[key] =
          isSensitiveKey(key) && (typeof v === 'string' || typeof v === 'number')
            ? REDACTED
            : this.redact(v, depth + 1);
      }
      return out as T;
    }
    return value;
  }
}

/** Collect secret-looking environment values so they can be scrubbed. */
export function secretsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.entries(env)
    .filter(([key, value]) => value && isSensitiveKey(key))
    .map(([, value]) => value as string);
}
