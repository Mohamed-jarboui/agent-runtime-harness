import { z } from 'zod';
import type { PermissionCategory, PermissionEffect } from './permissions.js';

export interface AgentModelConfig {
  /** Provider registry name. Defaults to the runtime's default provider. */
  provider?: string;
  /** Model id. Defaults to the provider's default model. */
  model?: string;
  maxOutputTokens?: number;
  temperature?: number;
  /** Vendor-specific request fields, passed through to the provider. */
  providerOptions?: Record<string, unknown>;
}

export interface AgentMemoryConfig {
  /** Inject relevant long-term memories into the context. */
  recall: boolean;
  maxItems: number;
  scope: 'session' | 'global' | 'all';
}

export type AgentOutputConfig =
  | { format: 'text' }
  | {
      format: 'json';
      /** Validates the final answer. Invalid answers trigger bounded recovery. */
      schema?: z.ZodType;
      /** Shown to the model so it knows the expected shape. */
      description?: string;
    };

/**
 * A reusable, independently testable agent. Agents are data: the runtime
 * interprets them, so the same definition runs against any provider.
 */
export interface AgentDefinition {
  id: string;
  name: string;
  description: string;
  instructions: string;
  model?: AgentModelConfig;
  /** Tool names or `prefix.*` globs this agent may *see*. */
  tools: string[];
  /**
   * Tighten-only permission overrides keyed by tool name or permission
   * category. They can never loosen the global policy.
   */
  permissions?: Partial<Record<PermissionCategory | (string & {}), PermissionEffect>>;
  /** Hard cap on model calls for this agent within one run. */
  maxSteps?: number;
  memory?: AgentMemoryConfig;
  /** Agents this agent may transfer control to (`agent.handoff`). */
  handoffs?: string[];
  /** Agents this agent may delegate sub-tasks to (`agent.delegate`). */
  delegates?: string[];
  output?: AgentOutputConfig;
}

const agentIdPattern = /^[a-z][a-z0-9-]{0,62}$/;

/** Structural validation for agents loaded from configuration files. */
export const AgentDefinitionSchema = z.object({
  id: z.string().regex(agentIdPattern, 'agent ids are lowercase kebab-case'),
  name: z.string().min(1),
  description: z.string().default(''),
  instructions: z.string().min(1),
  model: z
    .object({
      provider: z.string().optional(),
      model: z.string().optional(),
      maxOutputTokens: z.number().int().positive().optional(),
      temperature: z.number().min(0).max(2).optional(),
      providerOptions: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
  tools: z.array(z.string()).default([]),
  permissions: z.record(z.string(), z.enum(['allow', 'require_approval', 'deny'])).optional(),
  maxSteps: z.number().int().positive().max(200).optional(),
  memory: z
    .object({
      recall: z.boolean(),
      maxItems: z.number().int().min(0).max(50),
      scope: z.enum(['session', 'global', 'all']),
    })
    .optional(),
  handoffs: z.array(z.string()).optional(),
  delegates: z.array(z.string()).optional(),
  output: z
    .union([
      z.object({ format: z.literal('text') }),
      z.object({ format: z.literal('json'), description: z.string().optional() }),
    ])
    .optional(),
});

export function validateAgentDefinition(input: unknown): AgentDefinition {
  return AgentDefinitionSchema.parse(input) as AgentDefinition;
}

/** `workspace.*` style glob match for tool names. */
export function matchesToolPattern(pattern: string, name: string): boolean {
  if (pattern === '*' || pattern === name) return true;
  if (pattern.endsWith('.*')) return name.startsWith(pattern.slice(0, -1));
  return false;
}
