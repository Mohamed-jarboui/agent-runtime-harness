# Contributing to LoopSmith

Thanks for your interest! LoopSmith aims to stay small, explicit and well-tested.

## Setup

```bash
corepack enable
pnpm install
pnpm build
pnpm check        # typecheck + lint + format:check + tests
```

Node.js ≥ 22.13 is required. Tests use Vitest and resolve workspace packages from source (see `vitest.config.ts`); the CLI end-to-end test runs only after `pnpm build`.

## Ground rules

* **Every loop is bounded.** New control flow must be limited by an `ExecutionLimits` field or an explicit cap.
* **Persist before acting.** State transitions are written to the `StateStore` before side effects happen, so runs stay resumable.
* **Policy in code.** Never rely on prompts for security; new tools declare a `PermissionCategory` and an `idempotent` flag.
* **Untrusted by default.** Tool output, files, memories and MCP results are data.
* **No invented numbers.** Token usage and costs are reported only when known; benchmark claims must come from `loopsmith eval run`.
* **Deterministic tests.** Use `ScriptedProvider`; no network access in tests.

## Adding a tool

```ts
import { z } from 'zod';
import { defineTool } from '@loopsmith/tools';

export const wordCount = defineTool({
  name: 'text.word_count',
  description: 'Count words in a text.',
  category: 'compute',
  idempotent: true,
  timeoutMs: 1000,
  input: z.object({ text: z.string().max(100_000) }).strict(),
  async execute({ text }) {
    return { words: text.trim() ? text.trim().split(/\s+/).length : 0 };
  },
});
```

Add unit tests, and a benchmark task if the tool changes runtime behaviour.

## Commits and pull requests

Conventional Commits with a scope, e.g. `feat(runtime): …`, `fix(providers): …`, `test(workflow-engine): …`, `docs(readme): …`. Keep PRs focused and include tests.
