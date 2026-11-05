export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
/** A JSON Schema document (kept loose on purpose; validated by tools). */
export type JsonSchema = Record<string, unknown>;

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

export function safeJsonParse<T = unknown>(text: string): ParseResult<T> {
  try {
    return { ok: true, value: JSON.parse(text) as T };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** JSON.stringify that never throws (cycles and BigInts are handled). */
export function safeStringify(value: unknown, space?: number): string {
  const seen = new WeakSet<object>();
  try {
    return (
      JSON.stringify(
        value,
        (_key, v: unknown) => {
          if (typeof v === 'bigint') return v.toString();
          if (typeof v === 'object' && v !== null) {
            if (seen.has(v)) return '[Circular]';
            seen.add(v);
          }
          if (v instanceof Error) return { name: v.name, message: v.message };
          return v;
        },
        space,
      ) ?? 'null'
    );
  } catch {
    return '"[unserializable]"';
  }
}

export interface TruncateResult {
  text: string;
  truncated: boolean;
  originalLength: number;
}

/** Truncate text to `max` characters, keeping head and tail for context. */
export function truncateMiddle(text: string, max: number): TruncateResult {
  if (text.length <= max) return { text, truncated: false, originalLength: text.length };
  const marker = `\n…[truncated ${text.length - max} chars]…\n`;
  const budget = Math.max(0, max - marker.length);
  const head = Math.ceil(budget * 0.7);
  const tail = budget - head;
  return {
    text: text.slice(0, head) + marker + (tail > 0 ? text.slice(text.length - tail) : ''),
    truncated: true,
    originalLength: text.length,
  };
}

/** Extract the first JSON object/array from a model's text answer. */
export function extractJson(text: string): ParseResult<unknown> {
  const trimmed = text.trim();
  const direct = safeJsonParse(trimmed);
  if (direct.ok) return direct;
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fence?.[1]) {
    const fenced = safeJsonParse(fence[1].trim());
    if (fenced.ok) return fenced;
  }
  const start = trimmed.search(/[[{]/);
  if (start >= 0) {
    const open = trimmed[start];
    const close = open === '{' ? '}' : ']';
    const end = trimmed.lastIndexOf(close);
    if (end > start) {
      const sliced = safeJsonParse(trimmed.slice(start, end + 1));
      if (sliced.ok) return sliced;
    }
  }
  return { ok: false, error: 'No valid JSON value found in model output' };
}

/** Resolve a dotted path (`a.b.0.c`) against an object. */
export function getPath(source: unknown, path: string): unknown {
  if (path === '' || path === '.') return source;
  let current: unknown = source;
  for (const part of path.split('.')) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
