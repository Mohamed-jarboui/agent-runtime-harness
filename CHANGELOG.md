# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [0.1.0] — 2026-11-05

First public release.

### Added

- Bounded agent loop with decision engine (final answer, tool calls, handoff, delegation, approval pause, recovery), hard limits and cancellation.
- Typed tool registry and executor with validation, timeouts, output limits and structured errors; built-in `workspace.list/read/search/write`, `calculator.evaluate`, `memory.search/store`.
- Workspace sandbox (traversal, absolute paths, symlink escapes, secret files).
- Permission policy engine and persisted human approvals with cross-process resume.
- Declarative, checkpointed workflow engine with conditional transitions, bounded loops, retries, approval gates and Mermaid rendering.
- Multi-agent handoff and delegation with allow-listed destinations and depth/count limits.
- SQLite persistence with migrations; crash recovery that never silently re-runs side effects.
- Context manager with token estimates, tool-output elision and persistent compaction summaries; FTS5 long-term memory.
- Providers: Anthropic and OpenAI-compatible (official SDKs), deterministic scripted mock, retries with backoff, fallback chains.
- MCP stdio client adapter routed through the same policy engine.
- Structured events (42 types), redaction, terminal traces, JSONL export, run inspection and metrics.
- Evaluation harness with a 25-task benchmark suite and mock/live modes.
- `loopsmith` CLI and the offline Autonomous Workspace Analyst demo.
