/**
 * Provider-neutral conversation and model contracts.
 *
 * The runtime only ever speaks this vocabulary. Provider adapters translate it
 * to and from vendor wire formats (Anthropic Messages, OpenAI Chat
 * Completions, ...), which keeps the agent loop independent of any vendor.
 */
import type { JsonSchema } from './json.js';

export interface ToolCall {
  /** Provider-issued call id (unique within one assistant message). */
  id: string;
  /** Canonical LoopSmith tool name, e.g. `workspace.read`. */
  name: string;
  /** Parsed arguments. Untrusted: always validated before execution. */
  arguments: unknown;
  /** Raw argument text when the provider returned unparseable JSON. */
  rawArguments?: string;
  /** Set when arguments could not be parsed; the call is never executed. */
  parseError?: string;
}

export interface SystemMessage {
  role: 'system';
  content: string;
}

export interface UserMessage {
  role: 'user';
  content: string;
  /** Marks runtime-generated messages (handoff notes, recovery nudges). */
  synthetic?: 'handoff' | 'recovery' | 'delegation' | 'resume';
}

export interface AssistantMessage {
  role: 'assistant';
  content: string;
  toolCalls?: ToolCall[];
  /**
   * Opaque provider state (for example Anthropic thinking blocks) replayed
   * verbatim to the same provider so the transcript stays append-only.
   */
  providerState?: { provider: string; data: unknown };
}

export interface ToolResultMessage {
  role: 'tool';
  toolCallId: string;
  toolName: string;
  content: string;
  isError: boolean;
}

export type ChatMessage = SystemMessage | UserMessage | AssistantMessage | ToolResultMessage;

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: JsonSchema;
}

export type StopReason =
  'end_turn' | 'tool_use' | 'max_tokens' | 'stop_sequence' | 'refusal' | 'pause_turn' | 'other';

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface ModelRequestMetadata {
  runId: string;
  agentId: string;
  /** Model calls made in this run before this request (resume-safe). */
  iteration: number;
  /** Model calls made by this agent in this run before this request. */
  agentTurn: number;
  sessionId?: string;
}

export interface ModelRequest {
  model: string;
  system: string;
  messages: ChatMessage[];
  tools: ToolSpec[];
  maxOutputTokens: number;
  temperature?: number;
  /** Vendor-specific request fields, passed through untouched. */
  providerOptions?: Record<string, unknown>;
  metadata: ModelRequestMetadata;
}

export interface ModelResponse {
  content: string;
  toolCalls: ToolCall[];
  stopReason: StopReason;
  /** Undefined when the provider did not report usage (never invented). */
  usage?: TokenUsage;
  provider: string;
  model: string;
  providerState?: { provider: string; data: unknown };
}

export interface ModelCallObserver {
  onRetry?(event: {
    attempt: number;
    delayMs: number;
    category: string;
    message: string;
    provider: string;
  }): void;
  onFallback?(event: { from: string; to: string; category: string; message: string }): void;
}

export interface ModelCallOptions {
  signal?: AbortSignal;
  /** Per-call hooks so wrappers can report retries/fallbacks with run context. */
  observer?: ModelCallObserver;
}

export interface ModelProvider {
  /** Registry name, e.g. `anthropic`, `openai`, `mock`. */
  readonly name: string;
  readonly kind: 'anthropic' | 'openai-compatible' | 'mock' | 'composite';
  readonly defaultModel: string;
  complete(request: ModelRequest, options?: ModelCallOptions): Promise<ModelResponse>;
}
