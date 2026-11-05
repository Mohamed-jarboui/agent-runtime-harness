import { describe, expect, it } from 'vitest';
import { isSensitiveKey, mostRestrictive, Redactor, resolveLimits } from '@loopsmith/core';
import { PolicyEngine } from '@loopsmith/policies';
import { evaluateExpression } from '@loopsmith/tools';

describe('calculator', () => {
  it.each([
    ['1 + 2 * 3', 7],
    ['(1 + 2) * 3', 9],
    ['2 ^ 3 ^ 2', 512],
    ['-3 + +5', 2],
    ['round(5 / 104 * 1000, 2)', 48.08],
    ['max(1, sqrt(81), 4) % 5', 4],
    ['2 * pi', 2 * Math.PI],
    ['1e3 / 4', 250],
  ])('%s = %d', (expr, expected) => {
    expect(evaluateExpression(expr)).toBeCloseTo(expected, 10);
  });

  it.each([
    'process.exit()',
    'constructor',
    '1 / 0',
    '2 +',
    '(1',
    'foo(1)',
    'a'.repeat(501),
    '1 ; 2',
  ])('rejects %s', (expr) => {
    expect(() => evaluateExpression(expr)).toThrow();
  });
});

describe('policy engine', () => {
  const policy = new PolicyEngine();
  const agent = { id: 'a', tools: ['workspace.*'], permissions: {} };

  it('applies the default table', () => {
    expect(policy.evaluate({ toolName: 'workspace.read', category: 'read', agent }).effect).toBe(
      'allow',
    );
    expect(policy.evaluate({ toolName: 'workspace.write', category: 'write', agent }).effect).toBe(
      'require_approval',
    );
    expect(policy.evaluate({ toolName: 'shell.exec', category: 'execute' }).effect).toBe('deny');
    expect(policy.evaluate({ toolName: 'x.y', category: 'destructive' }).effect).toBe('deny');
    expect(policy.evaluate({ toolName: 'mcp.s.t', category: 'external' }).effect).toBe(
      'require_approval',
    );
  });

  it('denies tools outside the agent allow-list regardless of category', () => {
    const d = policy.evaluate({ toolName: 'calculator.evaluate', category: 'compute', agent });
    expect(d.effect).toBe('deny');
    expect(d.rule).toBe('agent.tools');
  });

  it('agent permissions can only tighten', () => {
    const strict = {
      id: 'r',
      tools: ['workspace.*'],
      permissions: { read: 'require_approval' as const, write: 'allow' as const },
    };
    expect(
      policy.evaluate({ toolName: 'workspace.read', category: 'read', agent: strict }).effect,
    ).toBe('require_approval');
    // 'allow' on write cannot loosen the global require_approval
    expect(
      policy.evaluate({ toolName: 'workspace.write', category: 'write', agent: strict }).effect,
    ).toBe('require_approval');
  });

  it('operator tool rules: most specific wins', () => {
    const p = new PolicyEngine({ tools: { 'workspace.*': 'deny', 'workspace.read': 'allow' } });
    expect(p.evaluate({ toolName: 'workspace.read', category: 'read' }).effect).toBe('allow');
    expect(p.evaluate({ toolName: 'workspace.list', category: 'read' }).effect).toBe('deny');
  });

  it('mostRestrictive', () => {
    expect(mostRestrictive('allow', undefined, 'require_approval')).toBe('require_approval');
    expect(mostRestrictive('deny', 'allow')).toBe('deny');
  });
});

describe('redaction', () => {
  it('redacts secret keys, known formats and registered literals but not token counts', () => {
    const r = new Redactor(['super-secret-value-123']);
    const out = r.redact({
      apiKey: 'abc',
      headers: { authorization: 'Bearer xyz' },
      usage: { inputTokens: 120, outputTokens: 30 },
      note: 'key sk-ant-api03-abcdefgh and ghp_abcdefghijklmnopqrstuvwxyz and super-secret-value-123',
    });
    expect(out.apiKey).toBe('[REDACTED]');
    expect(out.headers.authorization).toBe('[REDACTED]');
    expect(out.usage).toEqual({ inputTokens: 120, outputTokens: 30 });
    expect(out.note).not.toMatch(/sk-ant|ghp_|super-secret/);
  });

  it('classifies key names', () => {
    for (const k of [
      'apiKey',
      'x-api-key',
      'ANTHROPIC_API_KEY',
      'accessToken',
      'password',
      'client_secret',
    ])
      expect(isSensitiveKey(k)).toBe(true);
    for (const k of ['inputTokens', 'maxTokens', 'tokenizer', 'path', 'content'])
      expect(isSensitiveKey(k)).toBe(false);
  });
});

describe('limits', () => {
  it('validates and merges overrides', () => {
    expect(resolveLimits({ maxIterations: 3 }, { maxToolCalls: 5 })).toMatchObject({
      maxIterations: 3,
      maxToolCalls: 5,
      maxRetries: 3,
    });
    expect(() => resolveLimits({ maxIterations: -1 })).toThrow();
  });
});
