# LoopSmith evaluation report

- **Mode:** deterministic mock provider (scripted model behaviour — measures the runtime, not model quality)
- **Generated:** 2026-11-05T04:10:28.936Z
- **Tasks:** 25/25 passed (100.0%)

| Metric | Value |
|---|---|
| Task completion rate (tasks expected to complete) | 100.0% |
| Tool selection correctness | 100.0% |
| Tool argument validity (valid / all tool calls) | 95.9% |
| Workflow completion rate | 100.0% |
| Approval policy enforcement (no unapproved side effects) | 100.0% |
| Recovery tasks passed | 100.0% |
| Avg model calls / task | 3.56 |
| Avg tool calls / task | 2.92 |
| Avg duration / task | 21.28 ms |
| Tokens | not reported (mock provider does not invent usage) |

| Task | Category | Result | Status | Model calls | Tool calls | Failed checks |
|---|---|---|---|---|---|---|
| `tool-loop-basic` | tool-use | ✅ pass | completed | 3 | 2 | — |
| `parallel-tool-calls` | tool-use | ✅ pass | completed | 2 | 2 | — |
| `calculator-exact` | tool-use | ✅ pass | completed | 2 | 1 | — |
| `unknown-tool-recovery` | recovery | ✅ pass | completed | 2 | 1 | — |
| `invalid-arguments-recovery` | recovery | ✅ pass | completed | 3 | 2 | — |
| `malformed-json-arguments` | recovery | ✅ pass | completed | 3 | 2 | — |
| `provider-transient-retry` | recovery | ✅ pass | completed | 1 | 0 | — |
| `provider-auth-not-retried` | recovery | ✅ pass | failed | 0 | 0 | — |
| `empty-response-recovery` | recovery | ✅ pass | completed | 2 | 0 | — |
| `structured-output-recovery` | recovery | ✅ pass | completed | 2 | 0 | — |
| `deny-command-execution` | security | ✅ pass | completed | 2 | 0 | — |
| `path-traversal-blocked` | security | ✅ pass | completed | 2 | 3 | — |
| `prompt-injection-contained` | security | ✅ pass | awaiting_approval | 2 | 1 | — |
| `approval-approve-write` | approvals | ✅ pass | completed | 2 | 1 | — |
| `approval-reject-write` | approvals | ✅ pass | completed | 2 | 0 | — |
| `iteration-limit` | limits | ✅ pass | failed | 4 | 4 | — |
| `tool-call-limit` | limits | ✅ pass | failed | 1 | 2 | — |
| `tool-timeout` | limits | ✅ pass | completed | 2 | 1 | — |
| `context-compaction` | context | ✅ pass | completed | 7 | 6 | — |
| `agent-handoff` | multi-agent | ✅ pass | completed | 3 | 1 | — |
| `handoff-destination-enforced` | multi-agent | ✅ pass | completed | 2 | 1 | — |
| `delegation-depth-limit` | multi-agent | ✅ pass | completed | 4 | 0 | — |
| `workspace-analyst-e2e` | workflow | ✅ pass | completed | 14 | 16 | — |
| `workspace-analyst-rejected-publish` | approvals | ✅ pass | completed | 14 | 15 | — |
| `coordinator-delegate-handoff` | multi-agent | ✅ pass | completed | 8 | 12 | — |

> Mock-mode scores verify runtime behaviour (loop control, policies, recovery, persistence) under scripted model
> responses, including deliberately bad ones. They say nothing about how well a real model performs the tasks.
