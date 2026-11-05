import OpenAI from 'openai';
import {
  LoopSmithError,
  Redactor,
  safeJsonParse,
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

export interface OpenAICompatibleOptions {
  name?: string;
  apiKey?: string;
  /** Any OpenAI-compatible endpoint: OpenAI, Azure gateways, vLLM, Ollama, LiteLLM, OpenRouter... */
  baseURL?: string;
  /** Required: model names differ between gateways, so there is no silent default. */
  defaultModel: string;
  timeoutMs?: number;
  /**
   * `max_completion_tokens` (current OpenAI API) or `max_tokens` (most
   * self-hosted gateways). Defaults by base URL.
   */
  maxTokensParam?: 'max_tokens' | 'max_completion_tokens';
  redactor?: Redactor;
  fetch?: typeof fetch;
}

/**
 * Chat Completions adapter (official `openai` SDK). Chat Completions is used
 * deliberately: it is the de-facto interoperability surface implemented by
 * self-hosted and third-party gateways.
 */
export class OpenAICompatibleProvider implements ModelProvider {
  readonly kind = 'openai-compatible' as const;
  readonly name: string;
  readonly defaultModel: string;
  private readonly client: OpenAI;
  private readonly redactor: Redactor;
  private readonly maxTokensParam: 'max_tokens' | 'max_completion_tokens';

  constructor(options: OpenAICompatibleOptions) {
    this.name = options.name ?? 'openai';
    this.defaultModel = options.defaultModel;
    this.redactor = options.redactor ?? new Redactor();
    this.redactor.addSecret(options.apiKey);
    const isOfficial = !options.baseURL || /api\.openai\.com/.test(options.baseURL);
    this.maxTokensParam =
      options.maxTokensParam ?? (isOfficial ? 'max_completion_tokens' : 'max_tokens');
    this.client = new OpenAI({
      // Many local gateways accept any key; the SDK requires a non-empty string.
      apiKey: options.apiKey ?? 'not-set',
      ...(options.baseURL ? { baseURL: options.baseURL } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
      maxRetries: 0,
      timeout: options.timeoutMs ?? 120_000,
    });
  }

  async complete(request: ModelRequest, options: ModelCallOptions = {}): Promise<ModelResponse> {
    const names = new ToolNameMap(request.tools.map((t) => t.name));
    const body: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
      model: request.model,
      messages: this.toOpenAIMessages(request, names),
      [this.maxTokensParam]: request.maxOutputTokens,
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      ...(request.tools.length > 0
        ? {
            tools: request.tools.map((t) => ({
              type: 'function' as const,
              function: {
                name: names.wire(t.name),
                description: t.description,
                parameters: t.inputSchema,
              },
            })),
          }
        : {}),
      ...((request.providerOptions ?? {}) as object),
    };

    let completion: OpenAI.Chat.Completions.ChatCompletion;
    try {
      completion = await this.client.chat.completions.create(body, {
        signal: options.signal ?? null,
      });
    } catch (err) {
      throw this.mapError(err);
    }

    const choice = completion.choices?.[0];
    if (!choice) {
      throw new LoopSmithError(
        'invalid_model_response',
        `${this.name}: response contained no choices`,
      );
    }
    const toolCalls: ToolCall[] = [];
    for (const call of choice.message.tool_calls ?? []) {
      if (call.type !== 'function') continue;
      const raw = call.function.arguments ?? '';
      const parsed = raw.trim() === '' ? { ok: true as const, value: {} } : safeJsonParse(raw);
      toolCalls.push({
        id: call.id,
        name: names.canonical(call.function.name),
        arguments: parsed.ok ? parsed.value : null,
        ...(parsed.ok ? {} : { rawArguments: raw, parseError: parsed.error }),
      });
    }
    const response: ModelResponse = {
      content: choice.message.content ?? '',
      toolCalls,
      stopReason: mapFinishReason(choice.finish_reason, toolCalls.length),
      provider: this.name,
      model: completion.model ?? request.model,
    };
    if (completion.usage) {
      response.usage = {
        inputTokens: completion.usage.prompt_tokens,
        outputTokens: completion.usage.completion_tokens,
      };
    }
    return response;
  }

  private toOpenAIMessages(
    request: ModelRequest,
    names: ToolNameMap,
  ): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
    const out: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      { role: 'system', content: request.system },
    ];
    for (const message of request.messages as ChatMessage[]) {
      switch (message.role) {
        case 'system':
          out.push({ role: 'system', content: message.content });
          break;
        case 'user':
          out.push({ role: 'user', content: message.content });
          break;
        case 'tool':
          out.push({ role: 'tool', tool_call_id: message.toolCallId, content: message.content });
          break;
        case 'assistant':
          out.push({
            role: 'assistant',
            content: message.content || null,
            ...(message.toolCalls?.length
              ? {
                  tool_calls: message.toolCalls.map((call) => ({
                    id: call.id,
                    type: 'function' as const,
                    function: {
                      name: names.wire(call.name),
                      arguments: call.rawArguments ?? JSON.stringify(call.arguments ?? {}),
                    },
                  })),
                }
              : {}),
          });
          break;
      }
    }
    return out;
  }

  private mapError(err: unknown): LoopSmithError {
    if (err instanceof LoopSmithError) return err;
    if (err instanceof OpenAI.APIUserAbortError) {
      return new LoopSmithError('cancelled', `${this.name} request was aborted`, { cause: err });
    }
    if (err instanceof OpenAI.APIConnectionTimeoutError) {
      return new LoopSmithError('provider_timeout', `${this.name} request timed out`, {
        cause: err,
      });
    }
    if (err instanceof OpenAI.APIConnectionError) {
      return classifyHttpError(this.name, undefined, err.message, undefined, this.redactor, err);
    }
    if (err instanceof OpenAI.APIError) {
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

function mapFinishReason(reason: string | null | undefined, toolCalls: number): StopReason {
  switch (reason) {
    case 'stop':
      return toolCalls > 0 ? 'tool_use' : 'end_turn';
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'refusal';
    default:
      return toolCalls > 0 ? 'tool_use' : 'other';
  }
}
