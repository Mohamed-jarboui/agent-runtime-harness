#!/usr/bin/env node
// Minimal stdio MCP server used by LoopSmith's MCP integration test and example.
// Tools: text_stats (pure) and slugify (pure). Uses the low-level Server API.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const server = new Server(
  { name: 'loopsmith-demo-mcp', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'text_stats',
      description: 'Count words, lines and characters in a text.',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string', maxLength: 100000 } },
        required: ['text'],
        additionalProperties: false,
      },
    },
    {
      name: 'slugify',
      description: 'Turn a title into a URL slug.',
      inputSchema: {
        type: 'object',
        properties: { title: { type: 'string', minLength: 1 } },
        required: ['title'],
        additionalProperties: false,
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const args = request.params.arguments ?? {};
  if (request.params.name === 'text_stats') {
    const text = String(args.text ?? '');
    const stats = {
      words: text.trim() ? text.trim().split(/\s+/).length : 0,
      lines: text.split('\n').length,
      characters: text.length,
    };
    return { content: [{ type: 'text', text: JSON.stringify(stats) }], structuredContent: stats };
  }
  if (request.params.name === 'slugify') {
    const slug = String(args.title)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    return { content: [{ type: 'text', text: slug }] };
  }
  return {
    content: [{ type: 'text', text: `Unknown tool ${request.params.name}` }],
    isError: true,
  };
});

await server.connect(new StdioServerTransport());
