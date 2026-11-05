import { LoopSmithError, matchesToolPattern, type ToolSpec } from '@loopsmith/core';
import type { RegisteredTool } from './tool.js';

/** Dynamic registry of tools available to the runtime. */
export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  register(tool: RegisteredTool, options: { replace?: boolean } = {}): void {
    if (this.tools.has(tool.name) && !options.replace) {
      throw new LoopSmithError('configuration', `Tool already registered: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
  }

  registerAll(tools: RegisteredTool[]): void {
    for (const tool of tools) this.register(tool);
  }

  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): RegisteredTool[] {
    return [...this.tools.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Tools matching an agent's allow-list patterns (discovery). */
  forPatterns(patterns: string[]): RegisteredTool[] {
    return this.list().filter((tool) => patterns.some((p) => matchesToolPattern(p, tool.name)));
  }

  specs(tools: RegisteredTool[]): ToolSpec[] {
    return tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
  }
}
