import { LoopSmithError } from '@loopsmith/core';
import { validateWorkflow, type WorkflowDefinition } from '@loopsmith/workflow-engine';

export class WorkflowRegistry {
  private readonly workflows = new Map<string, WorkflowDefinition>();

  register(definition: WorkflowDefinition, options: { replace?: boolean } = {}): void {
    const validated = validateWorkflow(definition);
    if (this.workflows.has(validated.id) && !options.replace) {
      throw new LoopSmithError('configuration', `Workflow already registered: ${validated.id}`);
    }
    this.workflows.set(validated.id, validated);
  }

  get(id: string): WorkflowDefinition {
    const def = this.workflows.get(id);
    if (!def) {
      throw new LoopSmithError(
        'configuration',
        `Unknown workflow "${id}". Known: ${[...this.workflows.keys()].join(', ')}`,
      );
    }
    return def;
  }

  has(id: string): boolean {
    return this.workflows.has(id);
  }

  list(): WorkflowDefinition[] {
    return [...this.workflows.values()];
  }
}
