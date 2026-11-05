import Anthropic from '@anthropic-ai/sdk';
import {
  LoopSmithError,
  Redactor,
  type ChatMessage,
  type ModelCallOptions,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type StopReason,
  type ToolCall,
} from '@loopsmith/core';
import { classifyHttpError } from './http-errors.js';
import { ToolNameMap } from './wire-names.js';

export interface AnthropicProviderOptions {
  name?: string;
  apiKey?: string;
  /** Custom gateway, e.g. a corporate proxy. Defaults to ANTHROPIC_BASE_URL / SDK default. */
  baseURL?: string;
  defaultModel?: string;
  /** SDK-level timeout per request; LoopSmith owns retries, so SDK retries are disabled. */
  timeoutMs?: number;
  redactor?: Redactor;
  /** Inject a fetch implementation (used by the wire-level integration tests). */
  fetch?: typeof fetch;
}

export const ANTHROPIC_DEFAULT_MODEL = 'claude-opus-5-5';

/**
 * Anthropic Messages API adapter (official SDK).
 *
 * - Tool names are encoded for the wire and decoded on the way back.
 * - Consecutive tool results are merged into one `user` turn, as the API
 *   expects all `tool_result` blocks for a turn in a single message.
 * - The assistant's raw content blocks (including thinking blocks) are kept
 *   as opaque provider state and replayed verbatim, keeping the transcript
 *   append-only.
 * - Sampling parameters are not sent: current Claude models reject them.
 */
export class AnthropicProvider implements ModelProvider {
  readonly kind = 'anthropic' as const;
  readonly name: string;
  readonly defaultModel: string;
  private readonly client: Anthropic;
  private readonly redactor: Redactor;

  constructor(options: AnthropicProviderOptions = {}) {
    this.name = options.name ?? 'anthropic';
    this.defaultModel = options.defaultModel ?? ANTHROPIC_DEFAULT_MODEL;
    this.redactor = options.redactor ?? new Redactor();
    this.redactor.addSecret(options.apiKey);
    this.client = new Anthropic({
      ...(options.apiKey ? { apiKey: options.apiKey } : {}),
      ...(options.baseURL ? { baseURL: options.baseURL } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
      maxRetries: 0,
      timeout: options.timeoutMs ?? 120_000,
    });
  }

  async complete(request: ModelRequest, options: ModelCallOptions = {}): Promise<ModelResponse> {
    const names = new ToolNameMap(request.tools.map((t) => t.name));
    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: request.model,
      max_tokens: request.maxOutputTokens,
      system: [request.system, ...systemNotes(request.messages)].filter(Boolean).join('\n\n'),
      messages: this.toAnthropicMessages(request.messages, names),
      ...(request.tools.length > 0
        ? {
            tools: request.tools.map((t): Anthropic.Tool => ({
              name: names.wire(t.name),
              description: t.description,
              input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
            })),
          }
        : {}),
      ...((request.providerOptions ?? {}) as object),
    };

    let response: Anthropic.Message;
    try {
      response = await this.client.messages.create(params, { signal: options.signal ?? null });
    } catch (err) {
      throw this.mapError(err);
    }

    if (response.stop_reason === 'model_context_window_exceeded') {
      throw new LoopSmithError(
        'context_overflow',
        'Anthropic: request exceeded the model context window',
      );
    }

    const toolCalls: ToolCall[] = [];
    const text: string[] = [];
    for (const block of response.content) {
      if (block.type === 'text') text.push(block.text);
      if (block.type === 'tool_use') {
        toolCalls.push({ id: block.id, name: names.canonical(block.name), arguments: block.input });
      }
    }
    return {
      content: text.join('\n'),
      toolCalls,
      stopReason: mapStopReason(response.stop_reason),
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        ...(response.usage.cache_read_input_tokens
          ? { cacheReadTokens: response.usage.cache_read_input_tokens }
          : {}),
        ...(response.usage.cache_creation_input_tokens
          ? { cacheWriteTokens: response.usage.cache_creation_input_tokens }
          : {}),
      },
      provider: this.name,
      model: response.model,
      providerState: { provider: this.kind, data: response.content },
    };
  }

  private toAnthropicMessages(
    messages: ChatMessage[],
    names: ToolNameMap,
  ): Anthropic.MessageParam[] {
    const out: Anthropic.MessageParam[] = [];
    const pushUserBlocks = (blocks: Anthropic.ContentBlockParam[]): void => {
      const last = out[out.length - 1];
      if (last && last.role === 'user') {
        const existing =
          typeof last.content === 'string'
            ? [{ type: 'text' as const, text: last.content }]
            : last.content;
        // tool_result blocks must precede text blocks within a user turn.
        const merged = [...existing, ...blocks];
        merged.sort((a, b) => Number(b.type === 'tool_result') - Number(a.type === 'tool_result'));
        last.content = merged;
      } else {
        out.push({ role: 'user', content: blocks });
      }
    };

    for (const message of messages) {
      switch (message.role) {
        case 'system':
          break; // folded into the top-level system prompt
        case 'user':
          pushUserBlocks([{ type: 'text', text: message.content || '(empty)' }]);
          break;
        case 'tool':
          pushUserBlocks([
            {
              type: 'tool_result',
              tool_use_id: message.toolCallId,
              content: message.content,
              is_error: message.isError,
            },
          ]);
          break;
        case 'assistant': {
          if (
            message.providerState?.provider === this.kind &&
            Array.isArray(message.providerState.data)
          ) {
            out.push({
              role: 'assistant',
              content: message.providerState.data as Anthropic.ContentBlockParam[],
            });
            break;
          }
          const blocks: Anthropic.ContentBlockParam[] = [];
          if (message.content) blocks.push({ type: 'text', text: message.content });
          for (const call of message.toolCalls ?? []) {
            blocks.push({
              type: 'tool_use',
              id: call.id,
              name: names.wire(call.name),
              input: (call.arguments ?? {}) as Record<string, unknown>,
            });
          }
          out.push({
            role: 'assistant',
            content: blocks.length ? blocks : [{ type: 'text', text: '(no content)' }],
          });
          break;
        }
      }
    }
    return out;
  }

  private mapError(err: unknown): LoopSmithError {
    if (err instanceof LoopSmithError) return err;
    if (err instanceof Anthropic.APIUserAbortError) {
      return new LoopSmithError('cancelled', 'Anthropic request was aborted', { cause: err });
    }
    if (err instanceof Anthropic.APIConnectionTimeoutError) {
      return new LoopSmithError('provider_timeout', 'Anthropic request timed out', { cause: err });
    }
    if (err instanceof Anthropic.APIConnectionError) {
      return classifyHttpError(this.name, undefined, err.message, undefined, this.redactor, err);
    }
    if (err instanceof Anthropic.APIError) {
      return classifyHttpError(this.name, err.status, err.message, err.headers, this.redactor, err);
    }
    const message = err instanceof Error ? err.message : String(err);
    return new LoopSmithError(
      'provider_transient',
      `${this.name}: ${this.redactor.redactString(message)}`,
      {
        cause: err,
      },
    );
  }
}

function systemNotes(messages: ChatMessage[]): string[] {
  return messages.filter((m) => m.role === 'system').map((m) => m.content);
}

function mapStopReason(reason: Anthropic.Message['stop_reason']): StopReason {
  switch (reason) {
    case 'end_turn':
    case 'tool_use':
    case 'max_tokens':
    case 'stop_sequence':
    case 'refusal':
    case 'pause_turn':
      return reason;
    default:
      return 'other';
  }
}
