import { z } from 'zod';

/**
 * Declarative, JSON-serialisable workflow definitions. Conditions and
 * templates are data (not closures), so a workflow can be validated,
 * rendered as a diagram, stored, diffed and loaded from a file.
 */
export type Condition =
  | {
      /** Dotted path into the scope: `state.review.verdict`, `goal`, `input.x`. */
      path: string;
      equals?: unknown;
      notEquals?: unknown;
      in?: unknown[];
      exists?: boolean;
      gt?: number;
      gte?: number;
      lt?: number;
      lte?: number;
      contains?: string;
    }
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition };

export type Transition =
  string | { cases: Array<{ when: Condition; to: string; label?: string }>; default: string };

export interface NodeRetryPolicy {
  /** Total attempts including the first (1 = no retry). */
  maxAttempts: number;
  backoffMs: number;
}

interface NodeCommon {
  description?: string;
  retry?: NodeRetryPolicy;
  /** Max times this node may run in one workflow run (bounds loops). */
  maxVisits?: number;
  /** Where to go when maxVisits is exceeded (otherwise the workflow fails). */
  onMaxVisits?: string;
  /** Where to go when the node fails after retries (otherwise the workflow fails). */
  onError?: string;
}

export interface AgentNode extends NodeCommon {
  type: 'agent';
  agent: string;
  /** Template, e.g. "Review this draft:\n{{state.draft}}". */
  prompt: string;
  /** State key that receives the agent's answer (structured JSON when available). */
  output?: string;
  /** State keys shared with the agent as critical context (survive compaction). */
  contextKeys?: string[];
  next: Transition;
}

export interface ToolNode extends NodeCommon {
  type: 'tool';
  tool: string;
  /** Argument templates; a value that is exactly "{{path}}" keeps its raw type. */
  args: Record<string, unknown>;
  output?: string;
  next: Transition;
}

export interface ApprovalNode extends NodeCommon {
  type: 'approval';
  prompt: string;
  onApproved: string;
  onRejected: string;
}

export interface CodeNode extends NodeCommon {
  type: 'code';
  /** Name of a deterministic handler registered with the engine. */
  handler: string;
  next: Transition;
}

export interface EndNode {
  type: 'end';
  description?: string;
  status?: 'completed' | 'failed';
  /** Output template. */
  output?: string;
}

export type WorkflowNode = AgentNode | ToolNode | ApprovalNode | CodeNode | EndNode;

export interface WorkflowDefinition {
  id: string;
  name: string;
  description: string;
  version: string;
  start: string;
  /** Hard cap on node executions per run. */
  maxSteps: number;
  /** Default maxVisits for nodes that do not set one. */
  defaultMaxVisits?: number;
  initialState?: Record<string, unknown>;
  nodes: Record<string, WorkflowNode>;
}

const ConditionSchema: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    z.object({ all: z.array(ConditionSchema) }).strict(),
    z.object({ any: z.array(ConditionSchema) }).strict(),
    z.object({ not: ConditionSchema }).strict(),
    z
      .object({
        path: z.string().min(1),
        equals: z.unknown().optional(),
        notEquals: z.unknown().optional(),
        in: z.array(z.unknown()).optional(),
        exists: z.boolean().optional(),
        gt: z.number().optional(),
        gte: z.number().optional(),
        lt: z.number().optional(),
        lte: z.number().optional(),
        contains: z.string().optional(),
      })
      .strict(),
  ]),
);

const TransitionSchema = z.union([
  z.string().min(1),
  z.object({
    cases: z.array(
      z.object({ when: ConditionSchema, to: z.string().min(1), label: z.string().optional() }),
    ),
    default: z.string().min(1),
  }),
]);

const common = {
  description: z.string().optional(),
  retry: z
    .object({
      maxAttempts: z.number().int().min(1).max(10),
      backoffMs: z.number().int().min(0).max(60_000),
    })
    .optional(),
  maxVisits: z.number().int().min(1).max(100).optional(),
  onMaxVisits: z.string().optional(),
  onError: z.string().optional(),
};

const NodeSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('agent'),
      agent: z.string(),
      prompt: z.string(),
      output: z.string().optional(),
      contextKeys: z.array(z.string()).optional(),
      next: TransitionSchema,
      ...common,
    })
    .strict(),
  z
    .object({
      type: z.literal('tool'),
      tool: z.string(),
      args: z.record(z.string(), z.unknown()),
      output: z.string().optional(),
      next: TransitionSchema,
      ...common,
    })
    .strict(),
  z
    .object({
      type: z.literal('approval'),
      prompt: z.string(),
      onApproved: z.string(),
      onRejected: z.string(),
      ...common,
    })
    .strict(),
  z
    .object({ type: z.literal('code'), handler: z.string(), next: TransitionSchema, ...common })
    .strict(),
  z
    .object({
      type: z.literal('end'),
      description: z.string().optional(),
      status: z.enum(['completed', 'failed']).optional(),
      output: z.string().optional(),
    })
    .strict(),
]);

export const WorkflowDefinitionSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  name: z.string().min(1),
  description: z.string(),
  version: z.string(),
  start: z.string(),
  maxSteps: z.number().int().min(1).max(1000),
  defaultMaxVisits: z.number().int().min(1).max(100).optional(),
  initialState: z.record(z.string(), z.unknown()).optional(),
  nodes: z.record(z.string(), NodeSchema),
});

/** Every node a transition can lead to. */
export function successors(node: WorkflowNode): string[] {
  const out: string[] = [];
  const add = (t: Transition | undefined): void => {
    if (!t) return;
    if (typeof t === 'string') out.push(t);
    else out.push(...t.cases.map((c) => c.to), t.default);
  };
  if (node.type === 'approval') out.push(node.onApproved, node.onRejected);
  else if (node.type !== 'end') add(node.next);
  if (node.type !== 'end') {
    if (node.onError) out.push(node.onError);
    if (node.onMaxVisits) out.push(node.onMaxVisits);
  }
  return out;
}

/** Structural + graph validation. Returns the parsed definition or throws. */
export function validateWorkflow(input: unknown): WorkflowDefinition {
  const def = WorkflowDefinitionSchema.parse(input) as WorkflowDefinition;
  const problems: string[] = [];
  if (!def.nodes[def.start]) problems.push(`start node "${def.start}" does not exist`);
  for (const [id, node] of Object.entries(def.nodes)) {
    for (const target of successors(node)) {
      if (!def.nodes[target]) problems.push(`node "${id}" points to unknown node "${target}"`);
    }
  }
  if (!Object.values(def.nodes).some((n) => n.type === 'end'))
    problems.push('workflow has no end node');
  // Reachability: unreachable nodes are almost always a definition bug.
  const seen = new Set<string>();
  const queue = [def.start];
  while (queue.length > 0) {
    const id = queue.shift() as string;
    if (seen.has(id) || !def.nodes[id]) continue;
    seen.add(id);
    queue.push(...successors(def.nodes[id] as WorkflowNode));
  }
  for (const id of Object.keys(def.nodes))
    if (!seen.has(id)) problems.push(`node "${id}" is unreachable`);
  if (problems.length > 0) throw new Error(`Invalid workflow "${def.id}": ${problems.join('; ')}`);
  return def;
}
