import type { ChatMessage, ToolSpec } from '@loopsmith/core';

/**
 * Token *estimate* (~4 characters per token plus per-message overhead).
 * This is a budgeting heuristic, not a tokenizer: real counts vary by model
 * and language. Providers' reported usage is recorded separately.
 */
export const CHARS_PER_TOKEN = 4;
const MESSAGE_OVERHEAD = 4;

export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function estimateMessageTokens(message: ChatMessage): number {
  let chars = message.content.length;
  if (message.role === 'assistant') {
    for (const call of message.toolCalls ?? [])
      chars += call.name.length + JSON.stringify(call.arguments ?? {}).length;
  }
  return Math.ceil(chars / CHARS_PER_TOKEN) + MESSAGE_OVERHEAD;
}

export function estimateRequestTokens(
  system: string,
  messages: ChatMessage[],
  tools: ToolSpec[],
): number {
  const toolChars = tools.reduce(
    (sum, t) => sum + t.name.length + t.description.length + JSON.stringify(t.inputSchema).length,
    0,
  );
  return (
    estimateTextTokens(system) +
    Math.ceil(toolChars / CHARS_PER_TOKEN) +
    messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0)
  );
}
