import { describe, expect, it } from 'vitest';
import { LoopSmithError, type ModelProvider, type ModelRequest } from '@loopsmith/core';
import {
  FallbackProvider,
  parseRetryAfter,
  ResilientProvider,
  ScriptedProvider,
  ToolNameMap,
} from '@loopsmith/providers';

const req = (agentTurn = 0): ModelRequest => ({
  model: 'm',
  system: '',
  messages: [{ role: 'user', content: 'x' }],
  tools: [],
  maxOutputTokens: 10,
  metadata: { runId: 'r', agentId: 'a', iteration: 0, agentTurn },
});

const failing = (
  category: LoopSmithError['category'],
  name = 'bad',
): ModelProvider & { calls: number } => ({
  name,
  kind: 'mock',
  defaultModel: 'm',
  calls: 0,
  async complete() {
    this.calls++;
    throw new LoopSmithError(category, `${category}!`);
  },
});

describe('resilient provider', () => {
  it('retries retryable errors with bounded attempts and reports each retry', async () => {
    const inner = failing('provider_rate_limit');
    const retries: number[] = [];
    const p = new ResilientProvider(inner, {
      policy: { maxRetries: 3, baseDelayMs: 1, maxDelayMs: 2 },
      onRetry: (e) => retries.push(e.attempt),
    });
    await expect(p.complete(req())).rejects.toMatchObject({ category: 'provider_rate_limit' });
    expect(inner.calls).toBe(4);
    expect(retries).toEqual([1, 2, 3]);
  });

  it('does not retry non-retryable errors', async () => {
    const inner = failing('provider_invalid_request');
    await expect(
      new ResilientProvider(inner, { policy: { baseDelayMs: 1 } }).complete(req()),
    ).rejects.toMatchObject({ category: 'provider_invalid_request' });
    expect(inner.calls).toBe(1);
  });

  it('converts a hung call into provider_timeout', async () => {
    const slow = new ScriptedProvider({ agents: { a: [{ text: 'late', delayMs: 2000 }] } });
    await expect(
      new ResilientProvider(slow, { policy: { maxRetries: 0, timeoutMs: 30 } }).complete(req()),
    ).rejects.toMatchObject({ category: 'provider_timeout' });
  });

  it('falls back to the next provider on provider-level failures only', async () => {
    const good = new ScriptedProvider({ name: 'good', agents: { a: [{ text: 'from good' }] } });
    const events: string[] = [];
    const chain = new FallbackProvider(
      'chain',
      [
        { provider: failing('provider_transient', 'primary') },
        { provider: good, model: 'good-model' },
      ],
      (e) => events.push(`${e.from}->${e.to}`),
    );
    const response = await chain.complete(req());
    expect(response.content).toBe('from good');
    expect(response.model).toBe('good-model');
    expect(events).toEqual(['primary->good']);
    const strict = new FallbackProvider('chain', [
      { provider: failing('provider_invalid_request', 'primary') },
      { provider: good },
    ]);
    await expect(strict.complete(req())).rejects.toMatchObject({
      category: 'provider_invalid_request',
    });
  });

  it('parses retry-after headers', () => {
    expect(parseRetryAfter({ 'retry-after': '3' })).toBe(3000);
    expect(parseRetryAfter({ 'retry-after-ms': '250' })).toBe(250);
    expect(
      parseRetryAfter({ 'retry-after': new Date(Date.now() + 5000).toUTCString() }),
    ).toBeGreaterThan(3000);
    expect(parseRetryAfter({})).toBeUndefined();
  });

  it('encodes dotted tool names reversibly and rejects collisions', () => {
    const map = new ToolNameMap(['workspace.read', 'mcp.server.tool']);
    expect(map.wire('workspace.read')).toBe('workspace__read');
    expect(map.canonical('mcp__server__tool')).toBe('mcp.server.tool');
    expect(map.canonical('unknown__tool')).toBe('unknown__tool');
    expect(() => new ToolNameMap(['a.b', 'a__b'])).toThrow(/collide/);
  });
});
