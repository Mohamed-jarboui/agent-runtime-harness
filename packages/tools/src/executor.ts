import {
  LoopSmithError,
  safeStringify,
  serializeError,
  toLoopSmithError,
  truncateMiddle,
  withTimeout,
  type SerializedError,
  type ToolCall,
} from '@loopsmith/core';
import type { ToolRegistry } from './registry.js';
import type { RegisteredTool, ToolContext } from './tool.js';

export interface ToolExecutionResult {
  ok: boolean;
  /** Serialized payload handed back to the model (always bounded). */
  content: string;
  data?: unknown;
  error?: SerializedError;
  durationMs: number;
  truncated: boolean;
}

export interface ToolExecutorOptions {
  defaultTimeoutMs: number;
  maxOutputChars: number;
}

/**
 * Executes a single validated tool call. It never throws for tool-level
 * problems (unknown tool, bad arguments, exceptions, timeouts): those become
 * structured error results the model can observe and recover from, so one
 * failing tool cannot corrupt the session. Only cancellation propagates.
 */
export class ToolExecutor {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly options: ToolExecutorOptions,
  ) {}

  /** Validate without executing (used before policy checks and approvals). */
  prepare(
    call: Pick<ToolCall, 'name' | 'arguments' | 'parseError'>,
  ): { ok: true; tool: RegisteredTool; input: unknown } | { ok: false; error: LoopSmithError } {
    const tool = this.registry.get(call.name);
    if (!tool) {
      const available = this.registry
        .list()
        .map((t) => t.name)
        .join(', ');
      return {
        ok: false,
        error: new LoopSmithError(
          'unknown_tool',
          `Unknown tool "${call.name}". Available tools: ${available}`,
        ),
      };
    }
    if (call.parseError) {
      return {
        ok: false,
        error: new LoopSmithError(
          'invalid_tool_arguments',
          `Arguments are not valid JSON: ${call.parseError}`,
        ),
      };
    }
    const validation = tool.validateInput(call.arguments ?? {});
    if (!validation.ok) {
      return {
        ok: false,
        error: new LoopSmithError(
          'invalid_tool_arguments',
          `Invalid arguments for ${tool.name}: ${validation.issues.join('; ')}`,
          {
            details: { issues: validation.issues },
          },
        ),
      };
    }
    return { ok: true, tool, input: validation.value };
  }

  async execute(
    tool: RegisteredTool,
    input: unknown,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const started = Date.now();
    const timeoutMs = Math.min(
      tool.timeoutMs ?? this.options.defaultTimeoutMs,
      this.options.defaultTimeoutMs,
    );
    try {
      const output = await withTimeout((signal) => tool.execute(input, { ...context, signal }), {
        timeoutMs,
        signal: context.signal,
        onTimeout: () =>
          new LoopSmithError('tool_timeout', `${tool.name} timed out after ${timeoutMs}ms`),
      });
      if (tool.validateOutput) {
        const check = tool.validateOutput(output);
        if (!check.ok) {
          throw new LoopSmithError(
            'tool_execution',
            `${tool.name} returned invalid output: ${check.issues.join('; ')}`,
          );
        }
      }
      const serialized = typeof output === 'string' ? output : safeStringify(output, 2);
      const limit = Math.min(
        tool.maxOutputChars ?? this.options.maxOutputChars,
        this.options.maxOutputChars,
      );
      const bounded = truncateMiddle(serialized, limit);
      return {
        ok: true,
        content: bounded.text,
        data: output,
        durationMs: Date.now() - started,
        truncated: bounded.truncated,
      };
    } catch (raw) {
      const err = toLoopSmithError(raw, 'tool_execution');
      if (err.category === 'cancelled' && context.signal.aborted) throw err;
      return this.failure(err, Date.now() - started);
    }
  }

  failure(error: unknown, durationMs = 0): ToolExecutionResult {
    const serialized = serializeError(error);
    return {
      ok: false,
      content: safeStringify({
        error: { category: serialized.category, message: serialized.message },
      }),
      error: serialized,
      durationMs,
      truncated: false,
    };
  }
}
