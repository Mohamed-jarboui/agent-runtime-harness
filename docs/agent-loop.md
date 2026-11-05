# The agent loop

Implementation: `packages/runtime/src/agent-runtime.ts`.

## Lifecycle

1. **Start** — `startRun` creates the run row and persists the goal as transcript message `seq 0` in one transaction, then emits `run.started`.
2. **Phase A: resolve outstanding tool calls.** If the last assistant message has tool calls without appended results, each is resolved according to its persisted status:

   | Status | Action |
   |---|---|
   | `requested` | lookup → policy → schema validation → approval (if required) → execute |
   | `awaiting_approval` | approved → execute; rejected → error result to the model; pending → stay paused |
   | `executing` | the process died mid-call: idempotent tool → re-execute (`recovery.attempted`); side-effecting tool → **not** retried, the model is told the outcome is unknown |
   | `awaiting_child` | resume (or read) the delegated child run |
   | `completed` / `failed` / `denied` / `rejected` | append the stored result if it was not yet appended |

   If any approval is pending the run is marked `awaiting_approval` and returns. If a handoff was accepted, the owner agent changes and the loop restarts.
3. **Phase B: limits** — `maxIterations`, the agent's `maxSteps`, the runtime deadline and cancellation are checked.
4. **Phase C: context** — `ContextManager.build` produces the system prompt (agent instructions, runtime rules, output format, workflow context, recalled memories, compaction summary) and the message list. Compactions are persisted and emitted.
5. **Phase D: model request** — the iteration counter is incremented *before* the call (so a crash during the call still counts against the budget). The provider is wrapped with retries and timeouts; retries and fallbacks are reported as events through a per-call observer.
6. **Phase E: decision engine**

   | Response | Decision |
   |---|---|
   | `stop_reason = refusal` | fail with `model_refusal` |
   | tool calls present | persist assistant message + tool-call rows → back to Phase A |
   | truncated (`max_tokens`) or empty | bounded recovery prompt (`maxRecoveryAttempts`) |
   | final answer, agent expects JSON | extract + validate against the agent's Zod schema; invalid → recovery prompt with the exact issues |
   | final answer | `completed`, output persisted with the owning agent id |

## Bounds

| Limit | Default | Enforced where |
|---|---|---|
| `maxIterations` | 12 | before every model call |
| `maxToolCalls` | 40 | before every execution |
| `maxRuntimeMs` | 300 s | deadline `AbortSignal` passed to providers and tools; converted to `limit_exceeded` |
| `maxRetries` | 3 | `ResilientProvider` |
| `maxRecoveryAttempts` | 2 | recovery prompts |
| `contextBudgetTokens` | 100k (estimate) | context builder; `context_overflow` if even one turn does not fit |
| `toolTimeoutMs` | 30 s | `ToolExecutor` (tools may declare lower) |
| `maxToolOutputChars` | 20k | `ToolExecutor` truncation (head + tail kept) |
| `maxHandoffs` | 4 | handoffs + delegations per run tree |
| `maxDelegationDepth` | 2 | delegation |
| hard loop cap | `2·maxIterations + recovery + handoffs + 4` | safety net on the `for` loop itself |

## Multi-agent control

Agents opt in to orchestration by declaring destinations:

```ts
{ id: 'coordinator', delegates: ['researcher'], handoffs: ['executor'], tools: [] }
```

The runtime then offers meta-tools whose `agent` parameter is an **enum of the allowed destinations** — the model cannot even express a disallowed target, and any attempt is still re-validated.

* **`agent.delegate`** — creates a child run (persisted *before* it starts, with `delegation_depth + 1`), runs it to completion, and returns `{agent, status, output}` as the tool result. The delegating agent keeps ownership of the final answer. Approvals inside the child pause the whole tree; resuming the root resumes the child.
* **`agent.handoff`** — records the transition, switches the run's owner agent, and appends a synthetic handoff note containing the reason and payload (as data). The new agent produces the final answer; `RunOutcome.finalAgentId` records final ownership. One handoff per turn.

Both are bounded by `maxHandoffs` per run tree and recorded in the `handoffs` table (`loopsmith runs inspect` → *Agent transitions*).

## Cancellation

`AbortSignal`s flow from the CLI (Ctrl-C) through the loop into provider HTTP requests and tool executions. A cancelled run is persisted as `cancelled` with a `run.cancelled` event; tools are aborted through their own signal.
