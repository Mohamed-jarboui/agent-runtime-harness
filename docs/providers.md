# Providers

All providers implement `ModelProvider` from `@loopsmith/core`:

```ts
interface ModelProvider {
  readonly name: string;
  readonly kind: 'anthropic' | 'openai-compatible' | 'mock' | 'composite';
  readonly defaultModel: string;
  complete(request: ModelRequest, options?: { signal?: AbortSignal; observer?: ModelCallObserver }): Promise<ModelResponse>;
}
```

The runtime never sees vendor payloads: requests use `ChatMessage[]` + `ToolSpec[]`, responses are normalised to `{ content, toolCalls, stopReason, usage?, provider, model, providerState? }`.

## Anthropic (`AnthropicProvider`)

* Official `@anthropic-ai/sdk` (`messages.create`), SDK retries disabled (`maxRetries: 0`) so LoopSmith owns retry policy.
* Default model `claude-opus-5-5` (override with `LOOPSMITH_ANTHROPIC_MODEL` or the agent's `model.model`); `ANTHROPIC_BASE_URL` for gateways.
* Tool names: LoopSmith uses dotted names; the API requires `^[a-zA-Z0-9_-]{1,64}$`. `ToolNameMap` encodes `workspace.read` → `workspace__read`, decodes responses, and rejects collisions.
* Transcript mapping: tool results become `tool_result` blocks; consecutive tool results and runtime notes are merged into a single `user` turn with tool results first.
* Assistant turns produced by Anthropic are replayed **verbatim** from `providerState` (including thinking blocks), so the history sent back is exactly what the API returned.
* Sampling parameters (`temperature`) are not sent: current Claude models reject them. Vendor-specific fields (e.g. `output_config`) can be passed per agent via `model.providerOptions`.
* `stop_reason` mapping: `end_turn`, `tool_use`, `max_tokens`, `stop_sequence`, `refusal`, `pause_turn`; `model_context_window_exceeded` → `context_overflow` error.

## OpenAI-compatible (`OpenAICompatibleProvider`)

* Official `openai` SDK, **Chat Completions** — the interoperability surface implemented by vLLM, Ollama, LiteLLM, OpenRouter and most gateways.
* `OPENAI_BASE_URL` for any endpoint; the model must be set explicitly (`LOOPSMITH_OPENAI_MODEL`) because names differ per gateway.
* `max_completion_tokens` for api.openai.com, `max_tokens` for custom endpoints (configurable).
* Function-call arguments are parsed defensively: invalid JSON produces a `ToolCall` with `parseError` and `rawArguments`; the runtime never executes it and returns an `invalid_tool_arguments` observation.
* `finish_reason` mapping: `stop`, `tool_calls`, `length` → `max_tokens`, `content_filter` → `refusal`.

## Mock (`ScriptedProvider`)

* Scripts per agent: arrays of steps or functions of the request. Steps can return text, tool calls, malformed arguments, failures (`{ fail: { category }, times, then }`) and delays.
* Indexed by `metadata.agentTurn`, which the runtime derives from the **persisted** transcript, so scripted runs resume correctly in a new process.
* Never reports token usage — usage would be invented.

## Reliability

* `ResilientProvider`: per-attempt timeout (`AbortSignal.timeout`), bounded retries with exponential backoff and full jitter, honours `retry-after` / `retry-after-ms`, retries only `provider_transient`, `provider_rate_limit`, `provider_timeout`.
* HTTP classification: 401/403 → `provider_auth` (no retry), 408 → timeout, 409/5xx/529 → transient, 429 → rate limit, other 4xx → `provider_invalid_request`.
* `FallbackProvider`: ordered chain; falls through only on provider-level failures (transient, rate limit, timeout, auth) — never on invalid requests, which would fail everywhere.
* Every retry and fallback is emitted as `model.retry` / `model.fallback` with run context.
* Error messages are redacted (SDK errors can echo request fragments).

## Testing without keys

`tests/integration/providers-wire.test.ts` starts local HTTP servers that speak the Anthropic Messages and OpenAI Chat Completions wire formats and points the real SDKs at them. It verifies request encoding, auth headers, tool-name mapping, verbatim replay, tool-result merging, usage normalisation, error classification, `retry-after` parsing, redaction of echoed keys, and a full LoopSmith agent run over HTTP with cost estimation.
