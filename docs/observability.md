# Observability

## Events

`EventBus.emit` → redact → persist (`events` table) → dispatch to listeners (terminal renderer, tests). Listener failures are isolated: observability can never break a run.

Every event carries `id`, `type`, ISO `timestamp`, `sessionId`, `runId`, `rootRunId` and, where relevant, `agentId`, `nodeId`, `durationMs` and a `data` payload (with delegation `depth`). The 42 event types:

| Group | Types |
|---|---|
| Run | `run.started`, `run.resumed`, `run.paused`, `run.completed`, `run.failed`, `run.cancelled` |
| Agents | `agent.selected`, `agent.handoff`, `agent.delegation.started`, `agent.delegation.completed` |
| Model | `model.request` (estimated tokens), `model.response` (usage, stop reason, tool count, duration), `model.retry`, `model.fallback`, `model.error` |
| Tools | `tool.requested`, `tool.policy`, `tool.approved`, `tool.rejected`, `tool.denied`, `tool.started`, `tool.completed`, `tool.failed` |
| Approvals | `approval.requested`, `approval.decided` |
| Workflow | `workflow.started`, `workflow.resumed`, `workflow.node.started`, `workflow.node.completed`, `workflow.node.failed`, `workflow.node.retry`, `workflow.transition`, `workflow.checkpoint`, `workflow.paused`, `workflow.completed`, `workflow.failed` |
| Context & memory | `context.compacted`, `memory.recalled`, `memory.stored` |
| Reliability & security | `recovery.attempted`, `limit.exceeded`, `security.flagged` |

## Outputs

* **Live terminal trace** — `TerminalTraceRenderer` (indentation by workflow node and delegation depth; `--verbose` adds model requests and tool starts).
* **`loopsmith runs inspect <id>`** — run tree, tool calls with policy effects and durations, approvals, agent transitions, workflow path and checkpoints, metrics, condensed or full timeline; `--json` for machines.
* **`loopsmith runs export <id> [--out trace.jsonl]`** — one JSON event per line in emission order.
* **Logs** — pino to stderr (`LOOPSMITH_LOG_LEVEL`), with credential paths censored.

## Metrics (`computeRunMetrics`)

Model calls, iterations, tool calls/errors/denials, approvals requested/approved/rejected, handoffs, delegations, retries, fallbacks, recoveries, compactions, workflow steps, total duration, tool and model time, providers used, token usage **only when reported by the provider**, and estimated cost **only when every model used has a known price** (Anthropic list prices dated 2026-10-06; extend with `registerPricing`). Otherwise cost is reported as unknown — never guessed.

## Redaction

Applied to every event: values under sensitive key names (`apiKey`, `authorization`, `password`, `*_token`, `secret`, …; counts such as `inputTokens` are deliberately not matched), known credential formats (Anthropic/OpenAI/GitHub/AWS/Slack keys, bearer tokens, PEM private keys), and the literal values of secret-looking environment variables.
