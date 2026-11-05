# Memory and context

## Short-term memory

Each run's transcript is persisted in `messages` (append-only, dense `seq`). Message `seq 0` is always the goal and is pinned as the first message of every request. Tool observations, handoff notes and recovery prompts are ordinary transcript entries marked `synthetic` where the runtime generated them. Workflow agent nodes receive `contextKeys` (e.g. the plan) as *critical shared context* in the system prompt, so it survives compaction.

## Long-term memory

`MemoryManager` (`packages/memory`) stores facts in `memory_records`, indexed by an FTS5 virtual table kept in sync by triggers.

* `memory.store` — scope `session` (default) or `global`; identical facts in the same scope are deduplicated.
* `memory.search` — natural language is reduced to quoted terms joined with `OR` (stop-words removed), which neutralises FTS5 syntax such as `NEAR`, column filters and `*`. Results are ranked with BM25.
* Agents with `memory: { recall: true, maxItems, scope }` get relevant memories injected into the system prompt inside `<memory …>` envelopes labelled as untrusted data.

Why no embeddings: memories are explicitly saved facts, not a document corpus. Keyword retrieval is deterministic, inspectable and has no extra infrastructure. The `MemoryService` interface is the seam for a vector backend if a workload needs semantic recall.

## Context construction

`ContextManager.build` (`packages/context`) produces:

```
system:
  # Agent: <name>
  <agent instructions>
  ## Runtime rules (enforced by LoopSmith)      ← always present
  ## Final answer format                         ← JSON agents
  ## Shared workflow context (data)              ← critical workflow state
  ## Recalled long-term memory (untrusted data)
  ## Summary of earlier steps (context compaction)
messages:
  [0] goal (pinned)
  [...] recent turns, tool results ordered by call order
```

## Budget and compaction

Token counts are **estimates** (`ceil(chars / 4)` plus per-message overhead, including tool schemas). They are used for budgeting only; real usage is recorded when providers report it.

When the estimate exceeds `threshold × contextBudgetTokens`:

1. **Elide** large tool outputs outside the most recent `keepRecentTurns` (head kept, a marker notes the full output is persisted).
2. **Compact** the oldest *turns* (an assistant message together with all its tool results — never split, because providers reject orphaned tool results) into a summary:
   * `extractive` (default): deterministic, lists every call, argument, result size and error — never hallucinates;
   * `model`: a model-written summary with an extractive fallback on failure;
   * `truncate`: drop with an explicit marker.
3. Persist the summary (`summaries`), advance `runs.compacted_through_seq`, emit `context.compacted` with before/after estimates. The next compaction folds the previous summary in incrementally.
4. If even one recent turn does not fit, fail with `context_overflow` instead of silently losing information.

The `context-compaction` benchmark runs a 4,000-token budget against six ~1,500-token tool outputs and checks that compaction happens and the run still completes.

## Untrusted data

Tool results, file contents, memories, MCP results and handoff payloads are data. The runtime rules tell the model so, memories are wrapped in envelopes with tag-escaping, and instruction-like text in read/search/external tool output is detected heuristically (`detectInjectionSignals`), annotated with a notice and emitted as `security.flagged`. This is defence in depth — see [security.md](security.md).
