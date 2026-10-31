import { ACTIONS } from '../../shared/schema';
import type { Org, OrgPolicy, PermissionEffect, Role, User } from '../../shared/types';
import { Errors } from '../errors';

/**
 * Permission engine (cf. Claude Code PermissionContext): rule lists with allow / ask / deny.
 * Precedence: deny  >  not allowed  >  ask  >  allow.
 *  - Role rules give the baseline allow list; the org's managed policy can add allow, ask or deny rules.
 *  - "ask" means the action needs a human decision at the moment it happens. It is used for agent tools
 *    ("tool:<name>"): the node pauses until someone with run.approve_node grants it for this run.
 * Rule syntax: "*", "skill.*", "tool:*", or an exact action such as "workflow.run".
 */
export const ROLE_RULES: Record<Role, string[]> = {
  admin: ['*'],
  builder: [
    'skill.view', 'skill.edit', 'skill.submit', 'skill.delete',
    'workflow.view', 'workflow.edit', 'workflow.submit', 'workflow.delete', 'workflow.run', 'workflow.test',
    'rulepack.view', 'rulepack.edit', 'rulepack.submit',
    'run.view_all', 'run.review', 'run.view_internals', 'review.view', 'document.upload', 'tool:*',
  ],
  reviewer: [
    'skill.view', 'workflow.view', 'rulepack.view',
    'skill.approve', 'workflow.approve', 'rulepack.approve',
    'workflow.run', 'run.view_all', 'run.approve_node', 'run.review', 'run.view_internals', 'review.view', 'document.upload', 'audit.view', 'tool:*',
  ],
  // 使用者: runs published workflows and reviews their own results. Sees published items only (no drafts,
  // no task instructions, no prompts / raw model output) and has no access to the review area.
  runner: ['skill.view', 'workflow.view', 'rulepack.view', 'workflow.run', 'run.review', 'document.upload', 'tool:*'],
};

export function ruleMatches(rule: string, action: string): boolean {
  if (rule === '*' || rule === action) return true;
  if (rule.endsWith('*')) return action.startsWith(rule.slice(0, -1));
  return false;
}

export function decide(user: Pick<User, 'role'>, policy: OrgPolicy, action: string): PermissionEffect {
  const p = policy.permissions;
  if (p.deny.some((r) => ruleMatches(r, action))) return 'deny';
  const allowed = ROLE_RULES[user.role].some((r) => ruleMatches(r, action)) || p.allow.some((r) => ruleMatches(r, action));
  if (!allowed) return 'deny';
  if (p.ask.some((r) => ruleMatches(r, action))) return 'ask';
  return 'allow';
}

/** Throws 403 unless the action is allowed outright. */
export function requirePermission(user: User, org: Org, action: string) {
  const d = decide(user, org.policy, action);
  if (d !== 'allow') {
    throw Errors.forbidden(ACTIONS[action] ?? action, d === 'ask' ? '组织策略要求此操作需人工确认。' : undefined);
  }
}

export function effectivePermissions(user: User, org: Org): Record<string, PermissionEffect> {
  return Object.fromEntries(Object.keys(ACTIONS).map((a) => [a, decide(user, org.policy, a)]));
}

export const DEFAULT_POLICY: OrgPolicy = {
  permissions: { allow: [], ask: [], deny: [] },
  requireApprovedRulePacks: true,
  requireDistinctApprover: true,
  customInstructions: '',
};
