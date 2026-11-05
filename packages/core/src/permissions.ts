export const PERMISSION_CATEGORIES = [
  'read',
  'search',
  'compute',
  'memory.read',
  'memory.write',
  'write',
  'execute',
  'network',
  'destructive',
  'orchestration',
  'external',
] as const;

export type PermissionCategory = (typeof PERMISSION_CATEGORIES)[number];

export type PermissionEffect = 'allow' | 'require_approval' | 'deny';

const RESTRICTIVENESS: Record<PermissionEffect, number> = {
  allow: 0,
  require_approval: 1,
  deny: 2,
};

/** Combine effects so that the most restrictive one always wins. */
export function mostRestrictive(...effects: Array<PermissionEffect | undefined>): PermissionEffect {
  let result: PermissionEffect = 'allow';
  for (const effect of effects) {
    if (effect && RESTRICTIVENESS[effect] > RESTRICTIVENESS[result]) result = effect;
  }
  return result;
}

export interface PolicyDecision {
  effect: PermissionEffect;
  reason: string;
  /** Which rule produced the decision (for audit trails). */
  rule: string;
}
