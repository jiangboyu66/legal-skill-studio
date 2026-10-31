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

  logout(req: Request) {
    const token = readCookie(req, COOKIE);
    if (token) this.db.deleteSession(sha256(token));
  }

  setCookie(res: Response, token: string) {
    res.setHeader('set-cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${this.ttlHours * 3600}`);
  }
  clearCookie(res: Response) {
    res.setHeader('set-cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
  }

  /** Resolves the session cookie into req.auth (does not reject anonymous requests). */
  middleware = (req: Request, _res: Response, next: NextFunction) => {
    const token = readCookie(req, COOKIE);
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
