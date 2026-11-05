import { z } from 'zod';
import type { JsonSchema, MemoryService, PermissionCategory } from '@loopsmith/core';
import type { WorkspaceSandbox } from './sandbox.js';

export interface ToolContext {
  runId: string;
  sessionId: string;
  agentId: string;
  toolCallId: string;
  /** Aborted on timeout or run cancellation. Long-running tools must honour it. */
  signal: AbortSignal;
  workspace?: WorkspaceSandbox;
  memory?: MemoryService;
}

export type ValidationResult = { ok: true; value: unknown } | { ok: false; issues: string[] };

/**
 * The runtime-facing tool contract. Native tools are built from Zod schemas
 * with {@link defineTool}; MCP tools implement it from JSON Schema.
 */
export interface RegisteredTool {
  name: string;
  description: string;
  category: PermissionCategory;
  /** Safe to re-run after an interrupted execution (no external side effects). */
  idempotent: boolean;
  timeoutMs?: number;
  maxOutputChars?: number;
  source: 'native' | 'mcp';
  /** JSON Schema shown to the model. */
  inputSchema: JsonSchema;
  validateInput(input: unknown): ValidationResult;
  validateOutput?(output: unknown): ValidationResult;
  execute(input: unknown, context: ToolContext): Promise<unknown>;
}

export interface ToolDefinition<I extends z.ZodType, O extends z.ZodType | undefined = undefined> {
  name: string;
  description: string;
  input: I;
  output?: O;
  category: PermissionCategory;
  idempotent: boolean;
  timeoutMs?: number;
  maxOutputChars?: number;
  execute(
    input: z.output<I>,
    context: ToolContext,
  ): Promise<O extends z.ZodType ? z.input<O> : unknown>;
}

const TOOL_NAME = /^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)*$/;

export function formatZodIssues(error: z.ZodError): string[] {
  return error.issues.map(
    (issue) => `${issue.path.length ? issue.path.join('.') : '(root)'}: ${issue.message}`,
  );
}

/** Build a RegisteredTool from Zod schemas (input validation + JSON Schema). */
export function defineTool<I extends z.ZodType, O extends z.ZodType | undefined = undefined>(
  definition: ToolDefinition<I, O>,
): RegisteredTool {
  if (!TOOL_NAME.test(definition.name)) {
    throw new Error(
      `Invalid tool name "${definition.name}" (expected dotted lowercase, e.g. workspace.read)`,
    );
  }
  const jsonSchema = z.toJSONSchema(definition.input, {
    io: 'input',
    unrepresentable: 'any',
  }) as JsonSchema;
  delete jsonSchema.$schema;
  const tool: RegisteredTool = {
    name: definition.name,
    description: definition.description,
    category: definition.category,
    idempotent: definition.idempotent,
    source: 'native',
    inputSchema: jsonSchema,
    validateInput(input) {
      const result = definition.input.safeParse(input);
      return result.success
        ? { ok: true, value: result.data }
        : { ok: false, issues: formatZodIssues(result.error) };
    },
    execute: (input, context) => definition.execute(input as z.output<I>, context),
  };
  if (definition.timeoutMs !== undefined) tool.timeoutMs = definition.timeoutMs;
  if (definition.maxOutputChars !== undefined) tool.maxOutputChars = definition.maxOutputChars;
  const output = definition.output;
  if (output) {
    tool.validateOutput = (value) => {
      const result = output.safeParse(value);
      return result.success
        ? { ok: true, value: result.data }
        : { ok: false, issues: formatZodIssues(result.error) };
    };
  }
  return tool;
}
