import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import type { OrgPolicy, PlatformInfo, Role, User } from '../../shared/types';
import type { AppContext } from '../context';
import { agentInfo } from '../core/agents';
import { requirePermission, ROLE_RULES, ruleMatches } from '../core/permissions';
import { listTools } from '../core/tools';
import { pluginInfo } from '../plugins/loader';
import { hashPassword } from '../services/auth';
import { Errors } from '../errors';
import { toMe } from './auth';
import { h, param, text, who } from './util';

const ROLES: Role[] = ['admin', 'builder', 'reviewer', 'runner'];
const RULE = /^(\*|[a-z_]+(\.[a-z_]+)?\.?\*?|tool:[a-z_]*\*?)$/;

export function adminRouter(ctx: AppContext) {
  const r = Router();
  const { db } = ctx;

  r.get(
    '/users',
    h((req) => {
      const { user, org } = who(req);
      requirePermission(user, org, 'admin.users');
      return db.listUsers(org.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    }),
  );

  r.post(
    '/users',
    h((req, res) => {
      const { user, org } = who(req);
      requirePermission(user, org, 'admin.users');
      const b = (req.body ?? {}) as Record<string, unknown>;
      const email = text(b.email, 120).toLowerCase();
      const password = typeof b.password === 'string' ? b.password : '';
      if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw Errors.badRequest('邮箱格式不正确。');
      if (password.length < 8) throw Errors.badRequest('密码至少 8 位。');
      if (db.getUserByEmail(email)) throw Errors.conflict('该邮箱已被使用。');
      const u: User = {
        id: `usr_${randomUUID().slice(0, 8)}`,
        orgId: org.id,
        email,
        name: text(b.name, 60) || email,
        role: ROLES.includes(b.role as Role) ? (b.role as Role) : 'runner',
        title: text(b.title, 80) || undefined,
        createdAt: new Date().toISOString(),
      };
      db.putUser(u, hashPassword(password));
      ctx.rt.audit(org.id, user, 'admin.user_create', 'user', u.id, { email, role: u.role });
      res.status(201);
      return u;
    }),
  );

  r.patch(
    '/users/:id',
    h((req) => {
      const { user, org } = who(req);
      requirePermission(user, org, 'admin.users');
      const target = db.getUser(param(req, 'id'));
      if (!target || target.orgId !== org.id) throw Errors.notFound('用户');
      const b = (req.body ?? {}) as Record<string, unknown>;
      const next: User = { ...target };
      if (typeof b.name === 'string') next.name = text(b.name, 60) || target.name;
      if (typeof b.title === 'string') next.title = text(b.title, 80) || undefined;
      if (ROLES.includes(b.role as Role)) next.role = b.role as Role;
      if (typeof b.disabled === 'boolean') next.disabled = b.disabled;
      if (target.id === user.id && (next.role !== 'admin' || next.disabled)) throw Errors.badRequest('不能停用自己或取消自己的管理员角色。', '请由另一位管理员操作，避免组织失去管理员。');
      let hash: string | undefined;
      if (typeof b.password === 'string' && b.password) {
        if (b.password.length < 8) throw Errors.badRequest('密码至少 8 位。');
        hash = hashPassword(b.password);
      }
      db.putUser(next, hash);
      if (hash || next.disabled || next.role !== target.role) db.deleteUserSessions(target.id);
      ctx.rt.audit(org.id, user, 'admin.user_update', 'user', target.id, { role: next.role, disabled: !!next.disabled, passwordReset: !!hash });
      return next;
    }),
  );

  r.put(
    '/policy',
    h((req) => {
      const { user, org } = who(req);
      requirePermission(user, org, 'admin.policy');
      const b = (req.body ?? {}) as Partial<OrgPolicy>;
      const list = (v: unknown) => [...new Set((Array.isArray(v) ? v : []).map((x) => String(x).trim()).filter(Boolean))];
      const permissions = { allow: list(b.permissions?.allow), ask: list(b.permissions?.ask), deny: list(b.permissions?.deny) };
      const bad = [...permissions.allow, ...permissions.ask, ...permissions.deny].filter((x) => !RULE.test(x));
      if (bad.length) throw Errors.badRequest(`规则格式不正确：${bad.join('、')}`, '示例：workflow.run、skill.*、tool:lookup_rule、tool:*');
      if (permissions.deny.some((x) => ruleMatches(x, 'admin.policy')) || permissions.ask.some((x) => ruleMatches(x, 'admin.policy'))) {
        throw Errors.badRequest('该策略会导致管理员无法再修改策略，已拒绝。');
      }
      const policy: OrgPolicy = {
        permissions,
        requireApprovedRulePacks: b.requireApprovedRulePacks !== false,
        requireDistinctApprover: b.requireDistinctApprover !== false,
        customInstructions: text(b.customInstructions, 4000),
      };
      const next = { ...org, policy };
      db.orgs.put(next);
      ctx.rt.audit(org.id, user, 'admin.policy_update', 'org', org.id, policy);
      return toMe(user, next);
    }),
  );

  r.get(
    '/audit',
    h((req) => {
      const { user, org } = who(req);
      requirePermission(user, org, 'audit.view');
      const limit = Math.min(Math.max(Number(req.query.limit) || 300, 1), 1000);
      return db.listAudit(org.id, limit);
    }),
  );

  /** Read-only view of the platform's extension points: plugins, tools, agents, hooks, feature flags. */
  r.get(
    '/platform',
    h((req): PlatformInfo => {
      who(req);
      return {
        roles: ROLE_RULES,
        plugins: ctx.plugins.map(pluginInfo),
        tools: listTools(),
        agents: ctx.agents.map(agentInfo),
        hooks: ctx.hooks.list(),
        features: ctx.features,
      };
    }),
  );
  return r;
}
