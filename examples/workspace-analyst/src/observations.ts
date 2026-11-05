import { extractJson, safeJsonParse, type ChatMessage, type ModelRequest } from '@loopsmith/core';

export interface Observation {
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  data: unknown;
  raw: string;
}

/**
 * Collect every tool observation in a request, pairing each result with the
 * arguments of the call that produced it. Untrusted-content notices added by
 * the runtime are stripped before parsing (and remembered as `flagged`).
 */
export function observations(request: ModelRequest): Observation[] {
  const args = new Map<string, { name: string; args: Record<string, unknown> }>();
  for (const m of request.messages) {
    if (m.role === 'assistant')
      for (const c of m.toolCalls ?? [])
        args.set(c.id, { name: c.name, args: (c.arguments ?? {}) as Record<string, unknown> });
  }
  const out: Observation[] = [];
  for (const m of request.messages) {
    if (m.role !== 'tool') continue;
    const raw = m.content.startsWith('[LoopSmith notice')
      ? m.content.slice(m.content.indexOf('\n') + 1)
      : m.content;
    const parsed = safeJsonParse(raw);
    out.push({
      tool: m.toolName,
      args: args.get(m.toolCallId)?.args ?? {},
      ok: !m.isError,
      data: parsed.ok ? parsed.value : raw,
      raw: m.content,
    });
  }
  return out;
}

export const flaggedObservation = (o: Observation): boolean =>
  o.raw.startsWith('[LoopSmith notice');

/** Extract `<tag>…</tag>` from the conversation's user messages (latest first). */
export function tagged(request: ModelRequest, tag: string): string | undefined {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`);
  const users = request.messages.filter(
    (m): m is Extract<ChatMessage, { role: 'user' }> => m.role === 'user',
  );
  for (const m of [...users].reverse()) {
    const match = re.exec(m.content);
    if (match?.[1] !== undefined) return match[1].trim();
  }
  return undefined;
}

export function taggedJson<T>(request: ModelRequest, tag: string): T | undefined {
  const text = tagged(request, tag);
  if (!text) return undefined;
  const parsed = extractJson(text);
  return parsed.ok ? (parsed.value as T) : undefined;
}

/** JSON found anywhere in user messages (e.g. a handoff payload). */
export function jsonInUserMessages<T>(
  request: ModelRequest,
  predicate: (value: unknown) => boolean,
): T | undefined {
  for (const m of [...request.messages].reverse()) {
    if (m.role !== 'user') continue;
    for (const match of m.content.matchAll(/\{[\s\S]*\}/g)) {
      const parsed = extractJson(match[0]);
      if (parsed.ok && predicate(parsed.value)) return parsed.value as T;
    }
  }
  return undefined;
}
