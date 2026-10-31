import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import type { Org, User } from '../../shared/types';
import { AppError, Errors } from '../errors';
import type { Db } from './storage/db';

const COOKIE = 'lss_session';

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$16384$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [scheme, n, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, { N: Number(n), r: 8, p: 1 });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie ?? '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

export interface AuthContext {
  user: User;
  org: Org;
}

declare module 'express-serve-static-core' {
  interface Request {
    auth?: AuthContext;
  }
}

/** Simple in-memory brute-force protection for the login endpoint. */
const failures = new Map<string, number[]>();
export function checkLoginRate(key: string) {
  const now = Date.now();
  const recent = (failures.get(key) ?? []).filter((t) => now - t < 10 * 60_000);
  failures.set(key, recent);
  if (recent.length >= 5) {
    throw new AppError('TOO_MANY_ATTEMPTS', '登录失败次数过多，请 10 分钟后再试。', { status: 429 });
  }
}
export function recordLoginFailure(key: string) {
  failures.set(key, [...(failures.get(key) ?? []), Date.now()]);
}

export class AuthService {
  constructor(
    private db: Db,
    private ttlHours: number,
  ) {}

  login(email: string, password: string): { token: string; user: User } {
    const key = email.trim().toLowerCase();
    checkLoginRate(key);
    const u = this.db.getUserByEmail(key);
    if (!u || u.disabled || !verifyPassword(password, u.passwordHash)) {
      recordLoginFailure(key);
      throw new AppError('LOGIN_FAILED', '邮箱或密码不正确。', { status: 401 });
    }
    const token = randomBytes(32).toString('base64url');
    this.db.createSession(sha256(token), u.id, Date.now() + this.ttlHours * 3600_000);
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { passwordHash, ...user } = u;
    return { token, user };
  }

  /**
   * A browser tab that started from another tab's session (new tab opened from a link) gets its own session
   * for the same user and expiry, so signing out or switching account in one tab leaves the others alone.
   */
  fork(req: Request): string {
    const bearer = readBearer(req);
    const s = bearer ? this.db.getSession(sha256(bearer)) : undefined;
    if (!s || s.expiresAt <= Date.now()) throw Errors.unauthenticated();
    const token = randomBytes(32).toString('base64url');
    this.db.createSession(sha256(token), s.userId, s.expiresAt);
    return token;
  }

  /** Ends the session of this browser tab (bearer token) or, without one, the cookie session. */
  logout(req: Request, res: Response) {
    const bearer = readBearer(req);
    const cookie = readCookie(req, COOKIE);
    const token = bearer ?? cookie;
    if (token) this.db.deleteSession(sha256(token));
    // Another tab may be signed in through the shared cookie as someone else — only clear our own.
    if (!bearer || bearer === cookie) this.clearCookie(res);
  }

  setCookie(res: Response, token: string) {
    res.setHeader('set-cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${this.ttlHours * 3600}`);
  }
  clearCookie(res: Response) {
    res.setHeader('set-cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
  }

  /**
   * Resolves the session into req.auth (does not reject anonymous requests). A bearer token (one per browser
   * tab, kept in sessionStorage) wins over the cookie, so several accounts can be used side by side in one
   * browser; when a bearer token is sent but invalid, the cookie is NOT used as a fallback.
   */
  middleware = (req: Request, _res: Response, next: NextFunction) => {
    const bearer = readBearer(req);
    // The web app sends x-session-mode: tab — such a tab is signed in only through its own token.
    const token = req.headers['x-session-mode'] === 'tab' ? bearer : bearer ?? readCookie(req, COOKIE);
    if (token) {
      const s = this.db.getSession(sha256(token));
      if (s && s.expiresAt > Date.now()) {
        const user = this.db.getUser(s.userId);
        const org = user && this.db.orgs.get(user.orgId);
        if (user && org && !user.disabled) req.auth = { user, org };
      } else if (s) {
        this.db.deleteSession(sha256(token));
      }
    }
    next();
  };
}

function readBearer(req: Request): string | undefined {
  const h = req.headers.authorization;
  const m = typeof h === 'string' ? /^Bearer\s+([A-Za-z0-9_-]{20,200})$/.exec(h.trim()) : null;
  return m?.[1];
}

export function requireAuth(req: Request): AuthContext {
  if (!req.auth) throw Errors.unauthenticated();
  return req.auth;
}

/**
 * CSRF guard: state-changing API calls must carry a custom header, which browsers
 * only send cross-origin after a CORS preflight (which this server never grants).
 */
export function csrfGuard(req: Request, _res: Response, next: NextFunction) {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && req.headers['x-requested-with'] !== 'lss') {
    next(new AppError('CSRF_BLOCKED', '请求缺少安全头，已拒绝。', { status: 403 }));
    return;
  }
  next();
}
