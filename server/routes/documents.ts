import express, { Router } from 'express';
import type { DocumentSummary } from '../../shared/types';
import type { AppContext } from '../context';
import { requirePermission } from '../core/permissions';
import { MAX_UPLOAD_BYTES } from '../services/documents';
import { summarizeDocument } from '../services/documents/text';
import { Errors } from '../errors';
import { h, param, who } from './util';

export function documentsRouter(ctx: AppContext) {
  const r = Router();
  const { db } = ctx;

  /** Upload: raw request body (the browser sends the File as-is), filename in ?filename= */
  r.post(
    '/',
    express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES + 1024 }),
    h(async (req, res) => {
      const { user, org } = who(req);
      requirePermission(user, org, 'document.upload');
      const filename = String(req.query.filename ?? '').trim();
      if (!filename) throw Errors.badRequest('缺少文件名。');
      const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const doc = await ctx.docs.ingest(buf, filename, org.id, user);
      ctx.rt.audit(org.id, user, 'document.upload', 'document', doc.id, { filename: doc.filename, kind: doc.kind, method: doc.method, sha256: doc.sha256 });
      res.status(201);
      return summarizeDocument(doc) as DocumentSummary;
    }),
  );

  r.get(
    '/',
    h((req) => {
      const { org } = who(req);
      return db.documents
        .list(org.id)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, 200)
        .map((d) => summarizeDocument(d) as DocumentSummary);
    }),
  );

  r.get(
    '/:id',
    h((req) => {
      const { org } = who(req);
      const d = db.documents.get(org.id, param(req, 'id'));
      if (!d) throw Errors.notFound('文档');
      return d;
    }),
  );

  r.get(
    '/:id/file',
    h((req, res) => {
      const { org } = who(req);
      const d = db.documents.get(org.id, param(req, 'id'));
      const buf = d && ctx.docs.readFile(d);
      if (!d || !buf) throw Errors.notFound('文档原件');
      const inline = d.kind === 'image' || d.kind === 'pdf';
      res.setHeader('Content-Type', d.mime);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'");
      res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(d.filename)}`);
      res.send(buf);
    }),
  );

  r.delete(
    '/:id',
    h((req) => {
      const { user, org } = who(req);
      const d = db.documents.get(org.id, param(req, 'id'));
      if (!d) throw Errors.notFound('文档');
      if (d.uploadedBy !== user.id && user.role !== 'admin') throw Errors.forbidden('删除他人上传的文档');
      const active = db.runsByStatus(['queued', 'running', 'waiting_approval']).some((run) => run.orgId === org.id && Object.values(run.documents).includes(d.id));
      if (active) throw Errors.conflict('该文档正被进行中的运行使用，暂不能删除。');
      ctx.docs.remove(d);
      ctx.rt.audit(org.id, user, 'document.delete', 'document', d.id, { filename: d.filename });
      return { ok: true };
    }),
  );
  return r;
}
