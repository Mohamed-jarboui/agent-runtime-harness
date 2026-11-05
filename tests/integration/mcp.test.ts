import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { type McpToolSource, registerMcpServer } from '@loopsmith/mcp';
import { AutoApprove } from '@loopsmith/policies';
import { call, say } from '@loopsmith/providers';
import { createHarness, type Harness } from '../helpers.js';

const SERVER = fileURLToPath(new URL('../../examples/mcp-server/server.mjs', import.meta.url));
let h: Harness | undefined;
let source: McpToolSource | undefined;
afterEach(async () => {
  await source?.close();
  h?.ls.close();
});

describe('MCP stdio integration', () => {
  it('discovers tools, converts schemas and invokes them through the policy engine', async () => {
    h = await createHarness({
      agents: [
        {
          id: 'assistant',
          name: 'A',
          description: '',
          instructions: 'Use MCP tools.',
          tools: ['mcp.*'],
        },
      ],
      script: {
        agents: {
          assistant: [
            call('mcp.demo.text_stats', { text: 'hello agent runtime\nsecond line' }),
            call('mcp.demo.text_stats', { text: 42 }),
            (req) =>
              say(
                `stats: ${req.messages
                  .filter((m) => m.role === 'tool')
                  .map((m) => m.content)
                  .join(' | ')}`,
              ),
          ],
        },
      },
    });
    const registered = await registerMcpServer(h.ls.tools, {
      name: 'demo',
      command: process.execPath,
      args: [SERVER],
    });
    source = registered.source;
    expect(registered.tools.map((t) => t.name).sort()).toEqual([
      'mcp.demo.slugify',
      'mcp.demo.text_stats',
    ]);
    expect(registered.tools.every((t) => t.category === 'external' && t.source === 'mcp')).toBe(
      true,
    );

    const result = await h.ls.runAgent('assistant', 'Count words', {
      approvals: new AutoApprove('test'),
    });
    expect(result.status).toBe('completed');
    expect(result.output).toContain('"words": 5');
    expect(result.output).toContain('invalid_tool_arguments'); // ajv rejected text: 42 before the server saw it
    const inspection = h.ls.inspect(result.runId);
    // external tools require approval by default: exactly one approval (the invalid call never reached it)
    expect(inspection.approvals).toHaveLength(1);
  });

  it('pauses for approval by default (MCP tools are untrusted)', async () => {
    h = await createHarness({
      agents: [
        { id: 'assistant', name: 'A', description: '', instructions: 'x', tools: ['mcp.*'] },
      ],
      script: {
        agents: { assistant: [call('mcp.demo.slugify', { title: 'Hello World' }), say('done')] },
      },
    });
    source = (
      await registerMcpServer(h.ls.tools, {
        name: 'demo',
        command: process.execPath,
        args: [SERVER],
      })
    ).source;
    const result = await h.ls.runAgent('assistant', 'slugify');
    expect(result.status).toBe('awaiting_approval');
  });
});
