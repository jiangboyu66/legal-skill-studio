import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router } from 'express';
import type { DocumentSummary, Meta } from '../../shared/types';
import type { AppContext } from '../context';
import { requirePermission } from '../core/permissions';
import { summarizeDocument } from '../services/documents/text';
import { SAMPLES } from '../seed/samples';
import { Errors } from '../errors';
import { h, param, who } from './util';

/** Keep in step with package.json (a test checks this). */
export const APP_VERSION = '3.2.0';
const FILES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'seed', 'files');

export function metaRouter(ctx: AppContext) {
  const r = Router();

  // Public: no secrets, only whether a key is configured.
  r.get(
    '/meta',
    h((): Meta => ({
      provider: ctx.provider.info,
      hasRealKey: !!(ctx.cfg.anthropic.apiKey || ctx.cfg.deepseek.apiKey || ctx.cfg.openai.apiKey),
      appVersion: APP_VERSION,
      features: ctx.features,
      demoAccounts: ctx.cfg.demoAccounts,
    })),
  );

  r.get(
    '/samples',
    h((req) => {
      who(req);
      return SAMPLES;
    }),
  );

  /** Turns a bundled sample file (PDF / Word / image, all fictional) into an uploaded document. */
  r.post(
    '/samples/:id/document',
    h(async (req, res) => {
      const { user, org } = who(req);
      requirePermission(user, org, 'document.upload');
      const s = SAMPLES.find((x) => x.id === param(req, 'id'));
      if (!s?.file) throw Errors.notFound('示例文件');
      const doc = await ctx.docs.ingest(readFileSync(path.join(FILES_DIR, s.file)), s.file, org.id, user);
      ctx.rt.audit(org.id, user, 'document.upload', 'document', doc.id, { filename: doc.filename, sample: s.id });
      res.status(201);
      return summarizeDocument(doc) as DocumentSummary;
    }),
  );
  return r;
}
