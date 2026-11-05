# MCP integration

Implementation: `packages/mcp` (official `@modelcontextprotocol/sdk` v1 client).

## What works

* **Transport:** stdio (`StdioClientTransport`). The server process gets only the SDK's safe default environment plus explicitly configured variables — parent secrets are not inherited.
* **Discovery:** paginated `tools/list`, optional `include` allow-list.
* **Schema conversion:** each tool's `inputSchema` is compiled with ajv; arguments are validated before approval and before the call reaches the server.
* **Registration:** tools become ordinary `RegisteredTool`s named `mcp.<server>.<tool>`, so they show up in `loopsmith tools`, agent allow-lists (`mcp.*`), traces and metrics.
* **Invocation:** `tools/call` with timeout and `AbortSignal`; text content is concatenated, `structuredContent` preferred when present, `isError` becomes a `tool_execution` error.
* **Policy:** MCP tools default to category `external` → **approval required**. Operators can set `category` or `toolCategories` per server. MCP annotations such as `readOnlyHint` are treated as untrusted hints and ignored for permissions. `idempotentTools` controls crash-recovery behaviour.
* **Lifecycle:** `connect()` with timeout, `close()` on CLI exit.

## Configuration

```json
{
  "mcpServers": {
    "demo": {
      "command": "node",
      "args": ["examples/mcp-server/server.mjs"],
      "category": "external",
      "include": ["text_stats", "slugify"],
      "timeoutMs": 10000,
      "enabled": true
    }
  }
}
```

Programmatic:

```ts
import { registerMcpServer } from '@loopsmith/mcp';
const { source, tools } = await registerMcpServer(ls.tools, { name: 'demo', command: 'node', args: ['server.mjs'] });
// … agents with tools: ['mcp.*'] can now call mcp.demo.text_stats (after approval)
await source.close();
```

## Verified

`tests/integration/mcp.test.ts` spawns the bundled server, discovers both tools, checks names/categories, runs an agent that calls `mcp.demo.text_stats` (approved) and an invalid call (rejected by ajv before reaching the server), and checks that MCP calls pause for approval by default.

## Not yet implemented

Streamable HTTP and SSE transports, OAuth, resources, prompts, sampling, elicitation, list-changed notifications, and per-call progress reporting.
