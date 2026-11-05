import type { Condition, Transition, WorkflowDefinition, WorkflowNode } from './definition.js';

function describeCondition(c: Condition): string {
  if ('all' in c) return c.all.map(describeCondition).join(' and ');
  if ('any' in c) return c.any.map(describeCondition).join(' or ');
  if ('not' in c) return `not ${describeCondition(c.not)}`;
  const path = c.path.replace(/^state\./, '');
  if ('equals' in c) return `${path} = ${String(c.equals)}`;
  if ('notEquals' in c) return `${path} ≠ ${String(c.notEquals)}`;
  if (c.exists !== undefined) return `${path} ${c.exists ? 'exists' : 'missing'}`;
  return path;
}

function label(node: WorkflowNode, id: string): string {
  switch (node.type) {
    case 'agent':
      return `${id}<br/><i>agent: ${node.agent}</i>`;
    case 'tool':
      return `${id}<br/><i>tool: ${node.tool}</i>`;
    case 'approval':
      return `${id}<br/><i>human approval</i>`;
    case 'code':
      return `${id}<br/><i>code: ${node.handler}</i>`;
    case 'end':
      return id;
  }
}

/** Render a workflow definition as a Mermaid flowchart. */
export function toMermaid(def: WorkflowDefinition): string {
  const lines = ['flowchart TD', `  START([start]) --> ${def.start}`];
  for (const [id, node] of Object.entries(def.nodes)) {
    const text = label(node, id).replace(/"/g, "'");
    if (node.type === 'end') lines.push(`  ${id}(["${text}"])`);
    else if (node.type === 'approval') lines.push(`  ${id}{{"${text}"}}`);
    else if (node.type === 'code') lines.push(`  ${id}[/"${text}"/]`);
    else lines.push(`  ${id}["${text}"]`);
  }
  const edge = (from: string, t: Transition): void => {
    if (typeof t === 'string') lines.push(`  ${from} --> ${t}`);
    else {
      for (const c of t.cases)
        lines.push(
          `  ${from} -->|${(c.label ?? describeCondition(c.when)).replace(/[|"]/g, '')}| ${c.to}`,
        );
      lines.push(`  ${from} -->|otherwise| ${t.default}`);
    }
  };
  for (const [id, node] of Object.entries(def.nodes)) {
    if (node.type === 'end') continue;
    if (node.type === 'approval') {
      lines.push(
        `  ${id} -->|approved| ${node.onApproved}`,
        `  ${id} -->|rejected| ${node.onRejected}`,
      );
    } else edge(id, node.next);
    if (node.onMaxVisits) lines.push(`  ${id} -.->|max visits| ${node.onMaxVisits}`);
    if (node.onError) lines.push(`  ${id} -.->|error| ${node.onError}`);
  }
  return lines.join('\n');
}
