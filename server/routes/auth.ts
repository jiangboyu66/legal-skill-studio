import { Router } from 'express';
import type { DemoAccounts, Me, Org, User } from '../../shared/types';
import type { AppContext } from '../context';
import { effectivePermissions } from '../core/permissions';
import { Errors } from '../errors';
import { DEMO_ORG_ID, DEMO_USERS } from '../seed';
import { verifyPassword } from '../services/auth';
import { h, who } from './util';

export const toMe = (user: User, org: Org): Me => ({ user, org, can: effectivePermissions(user, org) });

export function authRouter(ctx: AppContext) {
  const r = Router();
  // Whether a test account still uses its published password (cached per stored hash; scrypt is slow on purpose).
  const unchanged = new Map<string, boolean>();
  const stillDefault = (email: string, password: string) => {
    const u = ctx.db.getUserByEmail(email);
    if (!u) return false;
    const key = `${u.id}:${u.passwordHash}`;
    if (!unchanged.has(key)) unchanged.set(key, verifyPassword(password, u.passwordHash));
    return unchanged.get(key)!;
  };

  r.post(
    '/login',
    h((req, res) => {
      const { email, password } = (req.body ?? {}) as { email?: unknown; password?: unknown };
      if (typeof email !== 'string' || typeof password !== 'string' || !email.trim() || !password) throw Errors.badRequest('请输入邮箱和密码。');
      const { token, user } = ctx.auth.login(email, password);
      ctx.auth.setCookie(res, token);
      const org = ctx.db.orgs.get(user.orgId)!;
      ctx.rt.audit(org.id, user, 'auth.login');
      return toMe(user, org);
    }),
  );

  r.post(
    '/logout',
    h((req, res) => {
      if (req.auth) ctx.rt.audit(req.auth.org.id, req.auth.user, 'auth.logout');
      ctx.auth.logout(req);
      ctx.auth.clearCookie(res);
      return { ok: true };
    }),
  );

  r.get(
    '/me',
    h((req) => {
      const { user, org } = who(req);
      return toMe(user, org);
    }),
  );

  // Test accounts are listed on the login page only when DEMO_ACCOUNTS is on (disable in production).
  // Passwords are shown only while unchanged; logging in still goes through the normal form.
  r.get(
    '/demo-accounts',
    h((): DemoAccounts => {
      if (!ctx.cfg.demoAccounts || !ctx.db.orgs.get(DEMO_ORG_ID)) return { accounts: [] };
      return {
        accounts: DEMO_USERS.filter((u) => ctx.db.getUser(u.id) && !ctx.db.getUser(u.id)!.disabled).map((u) => {
          const same = stillDefault(u.email, u.password);
          return { email: u.email, name: u.name, role: u.role, title: u.title, password: same ? u.password : undefined, passwordChanged: !same };
        }),
      };
    }),
  );
  return r;
}
