# Workflows

Implementation: `packages/workflow-engine`. The engine is provider-agnostic — it sequences nodes and delegates execution to injected `WorkflowServices` (implemented in `@loopsmith/orchestration` on top of the agent runtime). `tests/workflows/engine.test.ts` runs it with fake services and no model at all.

## Definition format

```ts
const wf: WorkflowDefinition = {
  id: 'plan-execute-review',
  name: 'Plan · Execute · Review',
  description: '…',
  version: '1.0.0',
  start: 'plan',
  maxSteps: 16,            // hard cap on node executions
  defaultMaxVisits: 3,     // loop bound per node
  initialState: { revisions: 0 },
  nodes: {
    plan:    { type: 'agent', agent: 'planner', prompt: 'Goal: {{goal}}', output: 'plan', next: 'execute',
               retry: { maxAttempts: 2, backoffMs: 200 } },
    execute: { type: 'agent', agent: 'researcher', prompt: '<plan>{{json state.plan}}</plan>', output: 'findings',
               contextKeys: ['plan'], next: 'draft' },
    draft:   { type: 'agent', agent: 'executor', prompt: '…', output: 'draft', next: 'verify', onMaxVisits: 'done' },
    verify:  { type: 'code', handler: 'verifyReport', next: 'review' },
    review:  { type: 'agent', agent: 'reviewer', prompt: '…', output: 'review', onMaxVisits: 'done',
               next: { cases: [{ when: { path: 'state.review.verdict', equals: 'approved' }, to: 'done' }], default: 'draft' } },
    done:    { type: 'end', output: 'Verdict: {{state.review.verdict}}' },
  },
};
```

### Node types

| Type | Executes | Output |
|---|---|---|
| `agent` | A child agent run with the rendered prompt; `contextKeys` are injected as critical context that survives compaction | Structured JSON (if the agent declares a schema) or text → `state[output]` |
| `tool` | A registered tool through the **same** policy, approval, validation and executor path as agent tool calls | Tool data → `state[output]` |
| `approval` | A persisted human gate | routes to `onApproved` / `onRejected` |
| `code` | A named deterministic handler | merged into state |
| `end` | Renders the output template; `status: 'failed'` for failure endings | workflow output |

### Transitions and conditions

A transition is a node id or `{ cases: [{ when, to, label? }], default }`. Conditions are data: `{ path, equals | notEquals | in | exists | gt | gte | lt | lte | contains }` composed with `all`, `any`, `not`.

### Templates

`{{goal}}`, `{{state.x.y}}`, `{{json state.x}}`, `{{input.z}}`. In tool `args`, a value that is exactly `{{path}}` keeps its raw type (objects stay objects).

## Execution semantics

* **Checkpoint after every node** — `{nodeId, state, visits, step, history, pending}` in the `checkpoints` table.
* **Pause** — when an agent node's child run, a tool node or an approval node is waiting for a human, the checkpoint records `pending = {nodeId, kind, ref, attempt}` and the workflow returns `awaiting_approval`.
* **Resume** — loads the latest checkpoint and re-enters the pending node with its reference (child run id, tool-call id, approval id). Completed nodes never re-run (verified by `resumes from the checkpoint in a fresh process-equivalent instance`).
* **Retries** — `retry.maxAttempts` with exponential backoff, only for failures marked retryable: provider/transient failures for agent nodes; for tool nodes only when the tool is idempotent (side effects are never silently retried).
* **Bounded loops** — `maxVisits` per node (`onMaxVisits` route or failure) and `maxSteps` per workflow.
* **Error routing** — `onError` sends failures to a recovery node with `state.lastError` set; otherwise the workflow fails with a structured error.

`loopsmith workflows show <id> --mermaid` renders any definition as a diagram.
