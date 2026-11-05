import {
  matchesToolPattern,
  mostRestrictive,
  PERMISSION_CATEGORIES,
  type AgentDefinition,
  type PermissionCategory,
  type PermissionEffect,
  type PolicyDecision,
} from '@loopsmith/core';

export interface PolicyConfig {
  /** Default effect per permission category. */
  categories: Record<PermissionCategory, PermissionEffect>;
  /** Operator overrides by tool name or `prefix.*` glob. Most specific wins. */
  tools?: Record<string, PermissionEffect>;
}

/**
 * The default policy: read-only and in-memory operations are allowed, side
 * effects need a human, and command execution / destructive / network access
 * are denied until an operator explicitly opts in.
 */
export const DEFAULT_POLICY: PolicyConfig = {
  categories: {
    read: 'allow',
    search: 'allow',
    compute: 'allow',
    'memory.read': 'allow',
    'memory.write': 'allow',
    orchestration: 'allow',
    write: 'require_approval',
    external: 'require_approval',
    execute: 'deny',
    network: 'deny',
    destructive: 'deny',
  },
  tools: {},
};

/** Operator input: any subset of categories and tool rules (merged over the defaults). */
export interface PolicyConfigInput {
  categories?: Partial<Record<PermissionCategory, PermissionEffect>>;
  tools?: Record<string, PermissionEffect>;
}

export interface PolicyRequest {
  toolName: string;
  category: PermissionCategory;
  agent?: Pick<AgentDefinition, 'id' | 'tools' | 'permissions'>;
}

/**
 * Deterministic permission evaluation. Security is enforced here, in code —
 * never by asking the model to behave.
 *
 * Precedence:
 *  1. A tool the agent was not given is denied outright.
 *  2. Base effect = most specific operator tool rule, else category default.
 *  3. Agent overrides may only tighten the base effect (most restrictive wins).
 */
export class PolicyEngine {
  readonly config: PolicyConfig;

  constructor(config: PolicyConfigInput = {}) {
    this.config = {
      categories: { ...DEFAULT_POLICY.categories, ...config.categories },
      tools: { ...DEFAULT_POLICY.tools, ...config.tools },
    };
  }

  evaluate(request: PolicyRequest): PolicyDecision {
    const { toolName, category, agent } = request;

    if (agent && !agent.tools.some((pattern) => matchesToolPattern(pattern, toolName))) {
      return {
        effect: 'deny',
        reason: `Tool "${toolName}" is not available to agent "${agent.id}"`,
        rule: 'agent.tools',
      };
    }

    const toolRule = this.mostSpecificToolRule(toolName);
    const base: PermissionEffect = toolRule?.effect ?? this.config.categories[category] ?? 'deny';
    const baseRule = toolRule ? `tools["${toolRule.pattern}"]` : `categories.${category}`;

    const agentEffect = agent?.permissions?.[toolName] ?? agent?.permissions?.[category];
    const effect = mostRestrictive(base, agentEffect);
    const rule = effect !== base ? `agent["${agent?.id}"].permissions` : baseRule;

    return { effect, rule, reason: describe(effect, toolName, category, rule) };
  }

  /** The effective policy table, for `loopsmith policies` style output. */
  describeCategories(): Array<{ category: PermissionCategory; effect: PermissionEffect }> {
    return PERMISSION_CATEGORIES.map((category) => ({
      category,
      effect: this.config.categories[category],
    }));
  }

  private mostSpecificToolRule(
    toolName: string,
  ): { pattern: string; effect: PermissionEffect } | undefined {
    let best: { pattern: string; effect: PermissionEffect } | undefined;
    for (const [pattern, effect] of Object.entries(this.config.tools ?? {})) {
      if (!matchesToolPattern(pattern, toolName)) continue;
      if (!best || specificity(pattern) > specificity(best.pattern)) best = { pattern, effect };
    }
    return best;
  }
}

const specificity = (pattern: string): number =>
  pattern === '*' ? 0 : pattern.endsWith('.*') ? pattern.length : 1000;

function describe(effect: PermissionEffect, tool: string, category: string, rule: string): string {
  switch (effect) {
    case 'allow':
      return `${tool} (${category}) is allowed by ${rule}`;
    case 'require_approval':
      return `${tool} (${category}) requires human approval (${rule})`;
    case 'deny':
      return `${tool} (${category}) is denied by ${rule}`;
  }
}
