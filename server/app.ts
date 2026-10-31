import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { HealthInfo, Usage } from '../shared/types';
import { type AppConfig, loadConfig } from './config';
import type { AppContext } from './context';
import { loadAgentDefinitions } from './core/agents';
import { registerBuiltinHooks } from './core/builtinHooks';
import { EvalService } from './core/evalService';
import { Governance } from './core/governance';
import { HookRunner } from './core/hooks';
import type { Runtime } from './core/runtime';
import { WorkflowEngine } from './core/workflow/engine';
import { AppError, toErrorInfo } from './errors';
import { resolveFeatures } from './features';
import { loadPlugins } from './plugins/loader';
import { adminRouter } from './routes/admin';
import { authRouter } from './routes/auth';
import { documentsRouter } from './routes/documents';
import { evalsRouter } from './routes/evals';
import { APP_VERSION, metaRouter } from './routes/meta';
import { reviewsRouter } from './routes/reviews';
import { rulePacksRouter } from './routes/rulepacks';
import { runsRouter } from './routes/runs';
import { skillsRouter } from './routes/skills';
import { workflowsRouter } from './routes/workflows';
import { migrateLegacyDemoPasswords, seedIfEmpty } from './seed';
import { assertSelfCheck, selfCheck } from './selfcheck';
import { AuthService, csrfGuard } from './services/auth';
import { DocumentService } from './services/documents';
import { EventBus } from './services/events';
import { createProvider, type LLMProvider, providerKey } from './services/llm';
import { purgeExpired } from './services/retention';
import { DataCipher } from './services/storage/crypto';
import { Db } from './services/storage/db';

export { APP_VERSION } from './routes/meta';

/** Content-Security-Policy for the SPA: no external images / scripts / connections (AI output is untrusted). */
export const CSP = [
  "default-src 'self'",
  "img-src 'self' data: blob:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "connect-src 'self'",
  "font-src 'self' data:",
  "object-src 'none'",
  "frame-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/**
 * Composition root. Services are created once and injected (cf. QueryEngineConfig / ToolUseContext),
 * so tests can replace the provider, the clock-sensitive bits or the storage directory.
 */
export async function createApp(opts: { config?: Partial<AppConfig>; provider?: LLMProvider; seed?: boolean; resume?: boolean } = {}) {
  const cfg = loadConfig(opts.config);
  const features = resolveFeatures(cfg.featureOverrides);
  const cipher = DataCipher.fromKey(cfg.dataEncryptionKey);
  const db = new Db(cfg.dataDir, { cipher });
  const checks = selfCheck(cfg, db, { customProvider: !!opts.provider });
  try {
    assertSelfCheck(checks);
  } catch (e) {
    db.close();
    throw e;
  }
  const plugins = loadPlugins(cfg.dataDir);
  const seeded = opts.seed !== false && seedIfEmpty(db, plugins);
  if (cfg.demoAccounts && !seeded) {
    const moved = migrateLegacyDemoPasswords(db);
    if (moved.length) checks.push({ name: 'demo-passwords', ok: true, level: 'info', message: `${moved.length} 个测试账号仍在使用 v3.0 的统一密码，已改为各角色独立的密码（见登录页）。` });
  }

  const provider = opts.provider ?? createProvider(cfg, features);
  const hooks = new HookRunner();
  const events = new EventBus();
  const docs = new DocumentService(db, features, cfg.ocrLangs);
  const agents = loadAgentDefinitions(plugins.flatMap((p) => p.agents));
  const cacheReadPrice = cfg.priceCacheReadPerMTok || cfg.priceInputPerMTok * 0.1;
  const priceFn = (u: Usage) =>
    cfg.priceInputPerMTok || cfg.priceOutputPerMTok
      ? (((u.inputTokens ?? 0) + (u.cacheWriteTokens ?? 0) * 1.25) * cfg.priceInputPerMTok + (u.cacheReadTokens ?? 0) * cacheReadPrice + (u.outputTokens ?? 0) * cfg.priceOutputPerMTok) / 1e6
      : undefined;
  const rt: Runtime = {
    cfg,
    features,
    provider,
    hooks,
    db,
    events,
    agents,
    priceFn,
    readFile: docs.readFile,
    audit: (orgId, user, action, entityType, entityId, detail) =>
      db.addAudit({ id: `aud_${randomUUID()}`, orgId, userId: user?.id, userName: user?.name, action, entityType, entityId, detail, at: new Date().toISOString() }),
  };
  registerBuiltinHooks(hooks, () => rt);
  const engine = new WorkflowEngine(rt, docs);
  const governance = new Governance(db, (orgId, user, action, type, id, detail) => rt.audit(orgId, user, action, type, id, detail));
  const auth = new AuthService(db, cfg.sessionTtlHours);
  const evals = new EvalService(rt);
  const ctx: AppContext = { cfg, features, db, provider, hooks, events, docs, plugins, agents, rt, engine, governance, evals, auth };
  if (opts.resume !== false) engine.resumeAll();

  // Retention: purge once at start, then every 6 hours.
  const purge = () => {
    try {
      purgeExpired(db, cfg.retentionDays, (orgId, detail) => rt.audit(orgId, undefined, 'retention.purge', 'system', undefined, detail));
    } catch (e) {
      console.error('[retention]', (e as Error).message);
    }
  };
  if (cfg.retentionDays > 0) purge();
  const purgeTimer = cfg.retentionDays > 0 ? setInterval(purge, 6 * 3600_000) : undefined;
  purgeTimer?.unref();
  const startedAt = Date.now();

  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
  });

  // Public health endpoint for load balancers / monitoring: status only, never secrets or user data.
  app.get('/api/health', (_req, res) => {
    let dbOk = true;
    try {
      db.isEmpty();
    } catch {
      dbOk = false;
    }
    const keyOk = provider.info.mode === 'mock' || opts.provider !== undefined || !!providerKey(cfg, provider.info.name);
    const body: HealthInfo = {
      status: dbOk && keyOk ? 'ok' : 'degraded',
      version: APP_VERSION,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      provider: { name: provider.info.name, mode: provider.info.mode, model: provider.info.model, configured: keyOk },
      encryptionAtRest: !!cipher,
      retentionDays: cfg.retentionDays,
      checks: [{ name: 'database', ok: dbOk, message: dbOk ? '数据库可访问' : '数据库不可访问' }, ...checks.map((c) => ({ name: c.name, ok: c.ok, message: c.message }))],
    };
    res.status(body.status === 'ok' ? 200 : 503).json(body);
  });

  app.use('/api', auth.middleware, csrfGuard);
  app.use('/api/documents', documentsRouter(ctx)); // raw body parser, before express.json
  app.use(express.json({ limit: '2mb' }));
  app.use('/api', metaRouter(ctx));
  app.use('/api/auth', authRouter(ctx));
  app.use('/api/skills', skillsRouter(ctx));
  app.use('/api/rulepacks', rulePacksRouter(ctx));
  app.use('/api/workflows', workflowsRouter(ctx));
  app.use('/api/reviews', reviewsRouter(ctx));
  app.use('/api/runs', runsRouter(ctx));
  app.use('/api/admin', adminRouter(ctx));
  app.use('/api', evalsRouter(ctx));
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: '接口不存在。' } });
  });

  // Serve the built SPA when available (npm run build).
  const dist = path.resolve('dist');
  if (existsSync(path.join(dist, 'index.html'))) {
    const csp = (_req: Request, res: Response, next: NextFunction) => {
      res.setHeader('Content-Security-Policy', CSP);
      next();
    };
    app.use(csp, express.static(dist, { index: false }));
    app.get('*', csp, (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const e = err as { type?: string; status?: number };
    if (e?.type === 'entity.too.large') {
      res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: '提交的内容过大。', hint: '文本请精简到 2MB 以内；文件请小于 20MB。' } });
      return;
    }
    if (e?.type === 'entity.parse.failed') {
      res.status(400).json({ error: { code: 'INVALID_JSON', message: '请求体不是有效的 JSON。' } });
      return;
    }
    const status = err instanceof AppError ? err.status : 500;
    if (status >= 500) console.error('[api]', err);
    if (res.headersSent) return;
    res.status(status).json({ error: toErrorInfo(err) });
  });

  const close = async () => {
    if (purgeTimer) clearInterval(purgeTimer);
    await engine.idle();
    await evals.idle();
    await docs.close();
    db.close();
  };
  return { app, ctx, close, checks };
}
