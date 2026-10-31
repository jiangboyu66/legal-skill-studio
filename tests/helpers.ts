import { mkdtempSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app';
import type { AppConfig } from '../server/config';
import { demoPassword } from '../server/seed';
import type { LLMProvider } from '../server/services/llm';
import type { Run } from '../shared/types';

export type TestApp = Awaited<ReturnType<typeof startApp>>;

/** Starts the full app (fresh SQLite DB in a temp dir, mock model unless a provider is given) on a random port. */
export async function startApp(opts: { config?: Partial<AppConfig>; provider?: LLMProvider; dataDir?: string } = {}) {
  const dataDir = opts.dataDir ?? mkdtempSync(path.join(os.tmpdir(), 'lss-test-'));
  const created = await createApp({
    config: { dataDir, mockLatencyMs: 0, retryBaseMs: 1, demoAccounts: true, provider: 'mock', ...opts.config },
    provider: opts.provider,
  });
  const server: Server = await new Promise((ok) => {
    const s = created.app.listen(0, '127.0.0.1', () => ok(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const cookies: Record<string, string> = {};

  async function call<T = any>(who: string, method: string, url: string, body?: unknown, extra: { raw?: Buffer; headers?: Record<string, string> } = {}) {
    const headers: Record<string, string> = { 'x-requested-with': 'lss', ...(extra.headers ?? {}) };
    if (cookies[who]) headers.cookie = cookies[who];
    let payload: BodyInit | undefined;
    if (extra.raw) {
      payload = new Uint8Array(extra.raw);
      headers['content-type'] = 'application/octet-stream';
    } else if (body !== undefined) {
      payload = JSON.stringify(body);
      headers['content-type'] = 'application/json';
    }
    const res = await fetch(base + url, { method, headers, body: payload });
    const set = res.headers.get('set-cookie');
    if (set) cookies[who] = set.split(';')[0];
    const text = await res.text();
    let json: any = text;
    try {
      json = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: res.status, body: json as T, headers: res.headers };
  }

  const login = async (...users: string[]) => {
    for (const u of users) {
      const r = await call(u, 'POST', '/api/auth/login', { email: `${u}@demo.local`, password: demoPassword(`${u}@demo.local`) });
      if (r.status !== 200) throw new Error(`login ${u} failed: ${JSON.stringify(r.body)}`);
    }
  };

  /** Approves the seeded rule pack as `reviewer`, with a review due date `days` from now. */
  const approveSeedRulePack = async (days = 180) => {
    const inbox = await call('reviewer', 'GET', '/api/reviews');
    const req = inbox.body.requests.find((r: { entityType: string; status: string }) => r.entityType === 'rulepack' && r.status === 'pending');
    const due = new Date(Date.now() + days * 86400_000).toISOString().slice(0, 10);
    return call('reviewer', 'POST', `/api/reviews/${req.id}/decide`, {
      decision: 'approved',
      comment: '演示审核',
      attestation: { approverName: 'Demo Reviewer', approverQualification: '演示账号（非真实执业律师）', attested: true, reviewDueAt: due },
    });
  };

  const waitRun = async (who: string, id: string, until: Run['status'][] = ['succeeded', 'failed', 'rejected', 'waiting_approval'], timeoutMs = 15_000): Promise<Run> => {
    const end = Date.now() + timeoutMs;
    for (;;) {
      await created.ctx.engine.idle();
      const r = await call<Run>(who, 'GET', `/api/runs/${id}`);
      if (until.includes(r.body.status)) return r.body;
      if (Date.now() > end) throw new Error(`run ${id} stuck in ${r.body.status}`);
      await new Promise((ok) => setTimeout(ok, 20));
    }
  };

  const stop = async () => {
    await new Promise<void>((ok) => server.close(() => ok()));
    await created.close();
  };
  return { ...created, server, base, dataDir, call, login, approveSeedRulePack, waitRun, stop, cookies };
}

export const WF = 'wf_demo_sg_marketing_review';
export const RULE_PACK = 'rp_demo_sg_marketing';
export const SKILL_CHECK = 'skl_demo_rule_check';
