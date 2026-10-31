import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Org, User } from '../../shared/types';
import { Errors } from '../errors';
import { decide } from '../core/permissions';
import { requireAuth } from '../services/auth';

/** Wraps an (async) handler: returned values are sent as JSON, thrown errors go to the error middleware. */
export const h =
  (fn: (req: Request, res: Response) => unknown): RequestHandler =>
  (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve()
      .then(() => fn(req, res))
      .then((r) => {
        if (r !== undefined && !res.headersSent) res.json(r);
      })
      .catch(next);
  };

export function who(req: Request): { user: User; org: Org } {
  return requireAuth(req);
}

export function can(user: User, org: Org, action: string): boolean {
  return decide(user, org.policy, action) === 'allow';
}

/** A "consumer" of an entity type (使用者): may neither edit nor approve it, so only sees published versions. */
export function consumerOnly(user: User, org: Org, type: 'skill' | 'workflow' | 'rulepack'): boolean {
  return !can(user, org, `${type}.edit`) && !can(user, org, `${type}.approve`);
}

/** Requires at least one of the actions. */
export function requireAny(user: User, org: Org, actions: string[], label: string) {
  if (!actions.some((a) => can(user, org, a))) throw Errors.forbidden(label);
}

export function param(req: Request, name: string): string {
  return String(req.params[name] ?? '');
}

export function text(v: unknown, max: number): string {
  return (typeof v === 'string' ? v : '').trim().slice(0, max);
}

export const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
