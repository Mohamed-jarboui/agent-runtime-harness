import { getPath, safeStringify } from '@loopsmith/core';
import type { Condition, Transition } from './definition.js';

export interface TemplateScope {
  goal: string;
  state: Record<string, unknown>;
  input: unknown;
}

const WHOLE = /^\{\{\s*(json\s+)?([a-zA-Z0-9_.]+)\s*\}\}$/;
const ANY = /\{\{\s*(json\s+)?([a-zA-Z0-9_.]+)\s*\}\}/g;

function display(value: unknown, json: boolean): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string' && !json) return value;
  return safeStringify(value, 2);
}

/** Render `{{path}}` / `{{json path}}` placeholders. Missing values render as ''. */
export function renderTemplate(template: string, scope: TemplateScope): string {
  return template.replace(ANY, (_m, json: string | undefined, path: string) =>
    display(getPath(scope, path), Boolean(json)),
  );
}

/** Render argument templates. A value that is exactly `{{path}}` keeps its raw type. */
export function renderValue(value: unknown, scope: TemplateScope): unknown {
  if (typeof value === 'string') {
    const whole = WHOLE.exec(value);
    if (whole && !whole[1]) return getPath(scope, whole[2] as string);
    return renderTemplate(value, scope);
  }
  if (Array.isArray(value)) return value.map((v) => renderValue(v, scope));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, renderValue(v, scope)]));
  }
  return value;
}

export function evaluateCondition(condition: Condition, scope: TemplateScope): boolean {
  if ('all' in condition) return condition.all.every((c) => evaluateCondition(c, scope));
  if ('any' in condition) return condition.any.some((c) => evaluateCondition(c, scope));
  if ('not' in condition) return !evaluateCondition(condition.not, scope);
  const value = getPath(scope, condition.path);
  const checks: boolean[] = [];
  if ('equals' in condition) checks.push(value === condition.equals);
  if ('notEquals' in condition) checks.push(value !== condition.notEquals);
  if (condition.in) checks.push(condition.in.includes(value));
  if (condition.exists !== undefined)
    checks.push((value !== undefined && value !== null) === condition.exists);
  if (condition.gt !== undefined) checks.push(typeof value === 'number' && value > condition.gt);
  if (condition.gte !== undefined) checks.push(typeof value === 'number' && value >= condition.gte);
  if (condition.lt !== undefined) checks.push(typeof value === 'number' && value < condition.lt);
  if (condition.lte !== undefined) checks.push(typeof value === 'number' && value <= condition.lte);
  if (condition.contains !== undefined) {
    checks.push(
      (typeof value === 'string' && value.includes(condition.contains)) ||
        (Array.isArray(value) && value.includes(condition.contains)),
    );
  }
  return checks.length > 0 && checks.every(Boolean);
}

export function resolveTransition(
  transition: Transition,
  scope: TemplateScope,
): { to: string; label?: string } {
  if (typeof transition === 'string') return { to: transition };
  for (const c of transition.cases) {
    if (evaluateCondition(c.when, scope))
      return { to: c.to, ...(c.label ? { label: c.label } : {}) };
  }
  return { to: transition.default, label: 'default' };
}
