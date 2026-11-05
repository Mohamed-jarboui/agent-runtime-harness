import { LoopSmithError, validateAgentDefinition, type AgentDefinition } from '@loopsmith/core';

/** Registry of configurable, reusable agents. */
export class AgentRegistry {
  private readonly agents = new Map<string, AgentDefinition>();

  register(agent: AgentDefinition, options: { replace?: boolean } = {}): void {
    // Structural validation (ids, limits); Zod output schemas are kept as-is.
    const validated = validateAgentDefinition({
      ...agent,
      output: agent.output ? { ...agent.output, schema: undefined } : undefined,
    });
    if (this.agents.has(validated.id) && !options.replace) {
      throw new LoopSmithError('configuration', `Agent already registered: ${validated.id}`);
    }
    this.agents.set(agent.id, agent);
  }

  registerAll(agents: AgentDefinition[]): void {
    for (const agent of agents) this.register(agent);
  }

  get(id: string): AgentDefinition {
    const agent = this.agents.get(id);
    if (!agent) {
      throw new LoopSmithError(
        'configuration',
        `Unknown agent "${id}". Known: ${[...this.agents.keys()].join(', ')}`,
      );
    }
    return agent;
  }

  has(id: string): boolean {
    return this.agents.has(id);
  }

  list(): AgentDefinition[] {
    return [...this.agents.values()];
  }

  /** Validate cross-references (handoff/delegate targets must exist). */
  validateGraph(): string[] {
    const problems: string[] = [];
    for (const agent of this.agents.values()) {
      for (const target of [...(agent.handoffs ?? []), ...(agent.delegates ?? [])]) {
        if (!this.agents.has(target)) problems.push(`${agent.id} → unknown agent "${target}"`);
        if (target === agent.id) problems.push(`${agent.id} cannot hand off or delegate to itself`);
      }
    }
    return problems;
  }
}
