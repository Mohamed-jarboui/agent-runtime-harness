import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { ModelRequest } from '@loopsmith/core';
import { LoopSmith } from '@loopsmith/orchestration';
import {
  AnthropicProvider,
  OpenAICompatibleProvider,
  ProviderRegistry,
} from '@loopsmith/providers';
import { assistantAgent, makeWorkspace, tempDb } from '../helpers.js';

/**
 * Wire-level tests: the official Anthropic and OpenAI SDKs talk HTTP to a
 * local fake server. This verifies request encoding, tool-name mapping,
 * response normalisation and error classification without API keys.
 */
interface Captured {
  path: string;
  headers: IncomingMessage['headers'];
  body: Record<string, unknown>;
}

type Responder = (
  req: Captured,
  index: number,
) => { status?: number; headers?: Record<string, string>; body: unknown };

async function fakeServer(
  responder: Responder,
): Promise<{ url: string; requests: Captured[]; server: Server }> {
  const requests: Captured[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
    req.on('end', () => {
      const captured: Captured = {
        path: req.url ?? '',
        headers: req.headers,
        body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
      };
      requests.push(captured);
      const reply = responder(captured, requests.length - 1);
      res.writeHead(reply.status ?? 200, { 'content-type': 'application/json', ...reply.headers });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, requests, server };
}

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((r) => s.close(r));
});

const request = (overrides: Partial<ModelRequest> = {}): ModelRequest => ({
  model: 'test-model',
  system: 'You are a test.',
  messages: [{ role: 'user', content: 'Read the README' }],
  tools: [
    {
      name: 'workspace.read',
      description: 'Read a file',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
  ],
  maxOutputTokens: 1024,
  metadata: { runId: 'run_1', agentId: 'assistant', iteration: 0, agentTurn: 0 },
  ...overrides,
});

const anthropicMessage = (content: unknown[], stop = 'tool_use') => ({
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-5-5',
  content,
  stop_reason: stop,
  stop_sequence: null,
  usage: { input_tokens: 120, output_tokens: 30 },
});

describe('AnthropicProvider (official SDK over HTTP)', () => {
  it('encodes tools for the wire and normalises tool_use blocks back', async () => {
    const fake = await fakeServer(() => ({
      body: anthropicMessage([
        { type: 'thinking', thinking: '', signature: 'sig-abc' },
        { type: 'text', text: 'Reading it.' },
        { type: 'tool_use', id: 'toolu_1', name: 'workspace__read', input: { path: 'README.md' } },
      ]),
    }));
    servers.push(fake.server);
    const provider = new AnthropicProvider({ apiKey: 'sk-ant-test-key-123456', baseURL: fake.url });
    const response = await provider.complete(request());

    const sent = fake.requests[0];
    expect(sent?.path).toBe('/v1/messages');
    expect(sent?.headers.authorization).toBe('Bearer sk-ant-test-key-123456'); // SDK 1.x sends keys as bearer auth
    expect((sent?.body.tools as Array<{ name: string }>)[0]?.name).toBe('workspace__read');
    expect(sent?.body.system).toBe('You are a test.');
    expect(sent?.body).not.toHaveProperty('temperature');

    expect(response.toolCalls).toEqual([
      { id: 'toolu_1', name: 'workspace.read', arguments: { path: 'README.md' } },
    ]);
    expect(response.content).toBe('Reading it.');
    expect(response.stopReason).toBe('tool_use');
    expect(response.usage).toEqual({ inputTokens: 120, outputTokens: 30 });
  });

  it('replays assistant content verbatim and merges tool results into one user turn', async () => {
    const raw = [
      { type: 'thinking', thinking: '', signature: 'sig-abc' },
      { type: 'tool_use', id: 'toolu_1', name: 'workspace__read', input: { path: 'a' } },
      { type: 'tool_use', id: 'toolu_2', name: 'workspace__read', input: { path: 'b' } },
    ];
    const fake = await fakeServer(() => ({
      body: anthropicMessage([{ type: 'text', text: 'done' }], 'end_turn'),
    }));
    servers.push(fake.server);
    const provider = new AnthropicProvider({ apiKey: 'sk-ant-test-key-123456', baseURL: fake.url });
    await provider.complete(
      request({
        messages: [
          { role: 'user', content: 'Read a and b' },
          {
            role: 'assistant',
            content: '',
            toolCalls: [],
            providerState: { provider: 'anthropic', data: raw },
          },
          {
            role: 'tool',
            toolCallId: 'toolu_2',
            toolName: 'workspace.read',
            content: 'B',
            isError: false,
          },
          {
            role: 'tool',
            toolCallId: 'toolu_1',
            toolName: 'workspace.read',
            content: 'A',
            isError: true,
          },
          { role: 'user', content: '[runtime note]', synthetic: 'recovery' },
        ],
      }),
    );
    const messages = fake.requests[0]?.body.messages as Array<{
      role: string;
      content: Array<Record<string, unknown>>;
    }>;
    expect(messages).toHaveLength(3);
    expect(messages[1]?.content).toEqual(raw); // thinking block preserved
    const user = messages[2]?.content ?? [];
    expect(user.map((b) => b.type)).toEqual(['tool_result', 'tool_result', 'text']);
    expect(user[1]).toMatchObject({ tool_use_id: 'toolu_1', is_error: true });
  });

  it('classifies HTTP errors (429 with retry-after, 401, 529, 400)', async () => {
    const statuses: Array<{ status: number; headers: Record<string, string> }> = [
      { status: 429, headers: { 'retry-after': '2' } },
      { status: 401, headers: {} },
      { status: 529, headers: {} },
      { status: 400, headers: {} },
    ];
    const fake = await fakeServer((_req, i) => ({
      status: statuses[i]?.status ?? 500,
      headers: statuses[i]?.headers ?? {},
      body: {
        type: 'error',
        error: { type: 'x', message: 'boom with sk-ant-test-key-123456 echoed' },
      },
    }));
    servers.push(fake.server);
    const provider = new AnthropicProvider({ apiKey: 'sk-ant-test-key-123456', baseURL: fake.url });
    const errors = [];
    for (let i = 0; i < statuses.length; i++)
      errors.push(await provider.complete(request()).catch((e: unknown) => e));
    const categories = errors.map((e) => (e as { category: string }).category);
    expect(categories).toEqual([
      'provider_rate_limit',
      'provider_auth',
      'provider_transient',
      'provider_invalid_request',
    ]);
    expect((errors[0] as { retryAfterMs?: number }).retryAfterMs).toBe(2000);
    for (const e of errors)
      expect(String((e as Error).message)).not.toContain('sk-ant-test-key-123456');
  });

  it('drives a full LoopSmith agent run over the wire', async () => {
    const fake = await fakeServer((_req, i) =>
      i === 0
        ? {
            body: anthropicMessage([
              {
                type: 'tool_use',
                id: 'toolu_9',
                name: 'workspace__read',
                input: { path: 'README.md' },
              },
            ]),
          }
        : {
            body: anthropicMessage([{ type: 'text', text: 'The README says hello.' }], 'end_turn'),
          },
    );
    servers.push(fake.server);
    const providers = new ProviderRegistry({ baseDelayMs: 1 });
    providers.register(
      new AnthropicProvider({ apiKey: 'sk-ant-test-key-123456', baseURL: fake.url }),
    );
    const ls = await LoopSmith.create({
      database: tempDb(),
      workspace: makeWorkspace({ 'README.md': 'hello' }),
      providers,
      agents: [assistantAgent()],
    });
    const result = await ls.runAgent('assistant', 'What does the README say?');
    expect(result.status).toBe('completed');
    expect(result.output).toBe('The README says hello.');
    const second = fake.requests[1]?.body.messages as Array<{
      role: string;
      content: Array<Record<string, unknown>>;
    }>;
    expect(second.at(-1)?.content[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'toolu_9',
    });
    const metrics = ls.inspect(result.runId).metrics;
    expect(metrics.usage).toEqual({ inputTokens: 240, outputTokens: 60, reported: true });
    expect(metrics.estimatedCostUsd).toBeCloseTo((240 * 4 + 60 * 20) / 1_000_000, 8);
    ls.close();
  });
});

describe('OpenAICompatibleProvider (official SDK over HTTP)', () => {
  const completion = (message: Record<string, unknown>, finish = 'tool_calls') => ({
    id: 'chatcmpl-1',
    object: 'chat.completion',
    created: 1,
    model: 'gpt-test',
    choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason: finish }],
    usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 },
  });

  it('maps function tools, system prompt and tool messages; parses arguments', async () => {
    const fake = await fakeServer(() => ({
      body: completion({
        content: null,
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'workspace__read', arguments: '{"path":"README.md"}' },
          },
          {
            id: 'call_2',
            type: 'function',
            function: { name: 'workspace__read', arguments: '{"path": "unterminated' },
          },
        ],
      }),
    }));
    servers.push(fake.server);
    const provider = new OpenAICompatibleProvider({
      apiKey: 'sk-test-openai-000000000000',
      baseURL: `${fake.url}/v1`,
      defaultModel: 'gpt-test',
    });
    const response = await provider.complete(
      request({
        messages: [
          { role: 'user', content: 'hi' },
          {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'call_0', name: 'workspace.read', arguments: { path: 'x' } }],
          },
          {
            role: 'tool',
            toolCallId: 'call_0',
            toolName: 'workspace.read',
            content: 'X',
            isError: false,
          },
        ],
      }),
    );
    const sent = fake.requests[0];
    expect(sent?.path).toBe('/v1/chat/completions');
    expect(sent?.headers.authorization).toBe('Bearer sk-test-openai-000000000000');
    const messages = sent?.body.messages as Array<Record<string, unknown>>;
    expect(messages[0]).toEqual({ role: 'system', content: 'You are a test.' });
    expect(messages[2]).toMatchObject({
      role: 'assistant',
      tool_calls: [{ id: 'call_0', function: { name: 'workspace__read' } }],
    });
    expect(messages[3]).toEqual({ role: 'tool', tool_call_id: 'call_0', content: 'X' });
    expect(sent?.body).toHaveProperty('max_tokens', 1024); // custom base URL → classic parameter
    expect((sent?.body.tools as Array<{ function: { name: string } }>)[0]?.function.name).toBe(
      'workspace__read',
    );

    expect(response.toolCalls[0]).toEqual({
      id: 'call_1',
      name: 'workspace.read',
      arguments: { path: 'README.md' },
    });
    expect(response.toolCalls[1]?.parseError).toBeTruthy();
    expect(response.toolCalls[1]?.rawArguments).toBe('{"path": "unterminated');
    expect(response.usage).toEqual({ inputTokens: 50, outputTokens: 10 });
  });

  it('maps finish reasons and server errors', async () => {
    const fake = await fakeServer((_req, i) =>
      i === 0
        ? { body: completion({ content: 'cut' }, 'length') }
        : { status: 503, body: { error: { message: 'unavailable' } } },
    );
    servers.push(fake.server);
    const provider = new OpenAICompatibleProvider({
      baseURL: `${fake.url}/v1`,
      defaultModel: 'local',
    });
    expect((await provider.complete(request())).stopReason).toBe('max_tokens');
    await expect(provider.complete(request())).rejects.toMatchObject({
      category: 'provider_transient',
    });
  });
});
