import { z } from 'zod';
import type { AgentDefinition, ToolSpec } from '@loopsmith/core';
import { formatZodIssues } from '@loopsmith/tools';

/**
 * Orchestration "meta tools" are handled by the runtime itself rather than
 * the tool registry. They still pass through the policy engine
 * (category `orchestration`) and are only offered to agents that declare
 * handoff / delegation targets — with the targets as an enum, so the model
 * cannot even name a destination it is not allowed to use.
 */
export const HANDOFF_TOOL = 'agent.handoff';
export const DELEGATE_TOOL = 'agent.delegate';
export const META_TOOLS = new Set([HANDOFF_TOOL, DELEGATE_TOOL]);

export function handoffSchema(targets: [string, ...string[]]) {
  return z
    .object({
      agent: z.enum(targets).describe('Agent that takes over the task'),
      reason: z.string().min(1).max(500).describe('Why control is being transferred'),
      payload: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('Structured context for the next agent'),
    })
    .strict();
}

export function delegateSchema(targets: [string, ...string[]]) {
  return z
    .object({
      agent: z.enum(targets).describe('Agent that performs the sub-task'),
      task: z.string().min(1).max(4000).describe('Self-contained description of the sub-task'),
      context: z.string().max(8000).optional().describe('Relevant facts the delegate needs'),
    })
    .strict();
}

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const out = z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>;
  delete out.$schema;
  return out;
}

export function metaToolSpecs(agent: AgentDefinition): ToolSpec[] {
  const specs: ToolSpec[] = [];
  const handoffs = agent.handoffs ?? [];
  const delegates = agent.delegates ?? [];
  if (handoffs.length > 0) {
    specs.push({
      name: HANDOFF_TOOL,
      description:
        'Transfer ownership of the whole task to another agent. Your turn ends; the target agent continues ' +
        `with the conversation and produces the final answer. Allowed targets: ${handoffs.join(', ')}.`,
      inputSchema: jsonSchema(handoffSchema(handoffs as [string, ...string[]])),
    });
  }
  if (delegates.length > 0) {
    specs.push({
      name: DELEGATE_TOOL,
      description:
        'Delegate a self-contained sub-task to another agent and receive its result as this tool result. ' +
        `You keep ownership of the final answer. Allowed targets: ${delegates.join(', ')}.`,
      inputSchema: jsonSchema(delegateSchema(delegates as [string, ...string[]])),
    });
  }
  return specs;
}

export type MetaParse<T> = { ok: true; value: T } | { ok: false; issues: string[] };

export function parseMeta<T>(schema: z.ZodType<T>, input: unknown): MetaParse<T> {
  const result = schema.safeParse(input);
  return result.success
    ? { ok: true, value: result.data }
    : { ok: false, issues: formatZodIssues(result.error) };
}
