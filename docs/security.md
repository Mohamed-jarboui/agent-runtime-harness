# Security

## Threat model

| Asset | Threat | Control |
|---|---|---|
| Host filesystem | Model requests `../../etc/passwd`, absolute paths, `~`, NUL bytes | `WorkspaceSandbox` lexical checks: relative paths only, resolved inside the root |
| Host filesystem | Symlink inside the workspace pointing outside | `realpath` re-check for reads; writes validate the nearest existing ancestor and refuse to write through symlinks; listings never follow symlinks |
| Credentials in the workspace | Model reads `.env`, keys, `.git` | Default deny-read patterns (`.env`, `.env.*` except `.env.example`, `*.pem`, `*.key`, `id_rsa*`, `.npmrc`, `.git/**`, `.loopsmith/**`); search skips denied files |
| Workspace integrity | Unreviewed writes | `write` category requires human approval by default; atomic writes; `create` mode refuses to overwrite; size limits; deny-write patterns |
| Host | Arbitrary command execution | No shell tool ships; the `execute` category is denied by default |
| Network | Data exfiltration | No network tool ships; the `network` category is denied by default |
| Agent behaviour | Prompt injection via files, tool output, memories, MCP | Data labelled untrusted in the system prompt; heuristic detection + annotation + `security.flagged`; **policy enforced in code regardless of what the model asks** |
| Tool arguments | Malformed / malicious arguments | Zod or JSON Schema (ajv) validation *before* approval and execution; strict objects |
| Secrets in traces | Keys in arguments, errors, logs | `Redactor` on every event before persistence/export (sensitive key names, known token formats, registered env secrets); provider error messages redacted; pino redaction; `providers` command never prints keys |
| Availability | Runaway loops, hung tools, huge outputs | Iteration, tool-call, runtime, retry, recovery, handoff and depth limits; per-tool timeouts with abort; output truncation |
| Side effects | Double execution after a crash | Tool-call state machine; interrupted non-idempotent calls are never retried automatically |
| Multi-agent | Recursive delegation, hand-off to privileged agents | Allow-listed destinations (enum in the schema), depth limit, transfer count limit, agent permissions tighten-only |
| MCP servers | Untrusted remote tools | Category `external` → approval by default; annotations (`readOnlyHint`) ignored for permissions; server env does not inherit the parent's secrets (only safe defaults + explicit env) |

## Default policy

See the table in the README (§7). Precedence: agent allow-list → most specific operator tool rule → category default → agent overrides (tighten-only).

## Verified by tests

* `tests/security/workspace-isolation.test.ts` — traversal, absolute and home paths, NUL bytes, file and directory symlink escapes, secret files, search leakage, write limits.
* `tests/unit/calculator-policy-redact.test.ts` — policy precedence, tighten-only agent overrides, redaction.
* Benchmarks `deny-command-execution`, `path-traversal-blocked`, `prompt-injection-contained` (a scripted "compromised" model follows an injected instruction and tries to write — the runtime flags the content and still pauses for approval), and the global *no unapproved side effects* invariant on every task.
* `tests/integration/recovery.test.ts` — interrupted side effects are not re-run.

## Known limitations

* **Prompt injection is not solved.** Detection is heuristic and can be evaded. The design goal is that a successful injection still cannot exceed the agent's permissions or skip an approval.
* The sandbox is a policy layer in the same process, not an OS boundary; there is a time-of-check/time-of-use window. Use containers for untrusted workloads.
* Approvals are only as good as the reviewer: the CLI shows the tool, arguments and a content preview, but large payloads should be reviewed in full.
* Redaction is pattern-based; unusual secret formats can slip through. Do not put secrets in goals or files the agent may read.
* Approval identity (`decided_by`) is self-asserted by the CLI user; there is no authentication layer in this single-user release.

## Reporting

Please report vulnerabilities privately via GitHub security advisories on this repository rather than public issues.
