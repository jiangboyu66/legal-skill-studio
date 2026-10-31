/**
 * Image / PDF / Word materials (fix for "text paste only"): extraction, OCR, page-aware grounding, API upload.
 */
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PDFDocument, rgb } from 'pdf-lib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '../server/errors';
import { locate } from '../server/core/grounding';
import { resolveFeatures } from '../server/features';
import { DocumentService } from '../server/services/documents';
import { Db } from '../server/services/storage/db';
import type { DocumentSummary, MaterialDocument, Run } from '../shared/types';
import { startApp, type TestApp } from './helpers';

const FILES = path.join(__dirname, '..', 'server', 'seed', 'files');
const file = (f: string) => readFileSync(path.join(FILES, f));

let db: Db;
let svc: DocumentService;
beforeAll(() => {
  db = new Db(mkdtempSync(path.join(os.tmpdir(), 'lss-doc-')));
  svc = new DocumentService(db, resolveFeatures(''), 'eng');
});
afterAll(async () => {
  await svc.close();
  db.close();
});

async function codeOf(p: Promise<unknown>) {
  try {
    await p;
    return 'OK';
  } catch (e) {
    return `${(e as AppError).code}/${(e as AppError).status}`;
  }
}

describe('document ingestion', () => {
  it('extracts PDF text per page', async () => {
    const d = await svc.ingest(file('edm-2pages.pdf'), 'edm-2pages.pdf', 'org', { id: 'u' });
    expect(d).toMatchObject({ kind: 'pdf', method: 'text-layer', mime: 'application/pdf', warnings: [] });
    expect(d.pages.map((p) => p.n)).toEqual([1, 2]);
    expect(d.pages[0].text).toContain("Singapore's No.1 mattress");
    expect(d.pages[1].text).toContain('NRIC number');
    expect(d.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(svc.readFile(d)!.equals(file('edm-2pages.pdf'))).toBe(true);
  });

  it('extracts Word (.docx) text and explains that pages are pseudo-pages', async () => {
    const d = await svc.ingest(file('post-low-risk.docx'), 'post.docx', 'org', { id: 'u' });
    expect(d).toMatchObject({ kind: 'docx', method: 'docx' });
    expect(d.pages[0].text).toContain('15% off from 1 to 30 Nov 2026');
    expect(d.warnings.join()).toContain('页码仅用于定位');
  });

  it('reads images with local OCR and reports confidence', async () => {
    const d = await svc.ingest(file('poster-high-risk.png'), 'poster.png', 'org', { id: 'u' });
    expect(d).toMatchObject({ kind: 'image', method: 'ocr', mime: 'image/png' });
    expect(d.pages[0].ocrConfidence).toBeGreaterThan(70);
    expect(d.pages[0].text).toMatch(/Clinically proven to cure back pain/i);
    expect(d.warnings.join()).toContain('OCR');
  }, 60_000);

  it('warns when a PDF has no text layer (scanned)', async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage([300, 300]).drawRectangle({ x: 20, y: 20, width: 100, height: 100, color: rgb(0.2, 0.2, 0.2) });
    const d = await svc.ingest(Buffer.from(await pdf.save()), 'scan.pdf', 'org', { id: 'u' });
    expect(d.warnings[0]).toContain('没有可提取的文字层');
  });

  it('rejects unsupported, empty, oversized and corrupt files with clear errors', async () => {
    expect(await codeOf(svc.ingest(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 1, 2]), 'old.doc', 'org', { id: 'u' }))).toBe('UNSUPPORTED_FILE/415');
    expect(await codeOf(svc.ingest(Buffer.from('MZ....'), 'tool.exe', 'org', { id: 'u' }))).toBe('UNSUPPORTED_FILE/415');
    expect(await codeOf(svc.ingest(Buffer.from('not really a pdf'), 'fake.pdf', 'org', { id: 'u' }))).toBe('UNSUPPORTED_FILE/415');
    expect(await codeOf(svc.ingest(Buffer.alloc(0), 'empty.txt', 'org', { id: 'u' }))).toBe('EMPTY_FILE/400');
    expect(await codeOf(svc.ingest(Buffer.alloc(20 * 1024 * 1024 + 1, 1), 'big.txt', 'org', { id: 'u' }))).toBe('FILE_TOO_LARGE/413');
    expect(await codeOf(svc.ingest(Buffer.from('%PDF-1.7\n garbage garbage'), 'broken.pdf', 'org', { id: 'u' }))).toBe('EXTRACT_FAILED/422');
  });

  it('can switch OCR off with a feature flag', async () => {
    const off = new DocumentService(db, resolveFeatures('-OCR'), 'eng');
    const d = await off.ingest(file('poster-high-risk.png'), 'poster.png', 'org', { id: 'u' });
    expect(d.pages[0].text).toBe('');
    expect(d.warnings.join()).toContain('OCR 功能已关闭');
  });
});

describe('page-aware grounding', () => {
  const ocr: MaterialDocument = {
    id: 'd',
    orgId: 'o',
    filename: 'p.png',
    mime: 'image/png',
    kind: 'image',
    size: 1,
    sha256: '',
    status: 'ready',
    method: 'ocr',
    pages: [{ n: 1, text: 'Clinicaly proven to cure back pain in 7 nlghts. WAS $2,999 NOW ONLY $899', ocrConfidence: 81 }],
    warnings: [],
    uploadedBy: '',
    createdAt: '',
  };
  it('finds exact quotes with their page and tolerates OCR errors with a fuzzy match', () => {
    const pdf = { ...ocr, method: 'text-layer' as const, kind: 'pdf' as const, pages: [{ n: 1, text: 'Intro' }, { n: 2, text: 'Reply with your NRIC number.' }] };
    expect(locate('reply with your NRIC number', { text: '', doc: pdf })).toEqual({ found: true, match: 'exact', page: 2 });
    expect(locate('Clinically proven to cure back pain in 7 nights', { text: ocr.pages[0].text, doc: ocr })).toEqual({ found: true, match: 'fuzzy', page: 1 });
    expect(locate('Guaranteed results for everyone who buys today', { text: ocr.pages[0].text, doc: ocr }).found).toBe(false);
    // no fuzzy matching for text-layer documents: quotes there must be verbatim
    expect(locate('Clinically proven to cure back pain in 7 nights', { text: ocr.pages[0].text, doc: { ...ocr, method: 'text-layer' } }).found).toBe(false);
  });
});

describe('documents through the API and in a workflow run', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startApp();
    await t.login('builder', 'runner', 'reviewer');
  });
  afterAll(() => t.stop());

  it('uploads a PDF, serves the original safely, and grounds quotes to pages in a run', async () => {
    const up = await t.call<DocumentSummary>('runner', 'POST', '/api/documents?filename=edm-2pages.pdf', undefined, { raw: file('edm-2pages.pdf') });
    expect(up.status).toBe(201);
    expect(up.body).toMatchObject({ kind: 'pdf', pageCount: 2, method: 'text-layer' });
    expect(up.body).not.toHaveProperty('pages');

    const f = await fetch(`${t.base}/api/documents/${up.body.id}/file`, { headers: { cookie: t.cookies.runner } });
    expect(f.headers.get('content-type')).toBe('application/pdf');
    expect(f.headers.get('content-security-policy')).toContain('sandbox');
    expect(Buffer.from(await f.arrayBuffer()).equals(file('edm-2pages.pdf'))).toBe(true);

    const r = await t.call<Run>('builder', 'POST', '/api/workflows/wf_demo_sg_marketing_review/runs', { mode: 'test', inputs: { material: { documentId: up.body.id }, channel: 'EDM' } });
    expect(r.status).toBe(201);
    expect(r.body.inputs.material).toBe('[文档] edm-2pages.pdf');
    const run = await t.waitRun('builder', r.body.id);
    const quotes = run.nodes.check.validation!.grounding.find((g) => g.path === 'findings[].quote')!;
    expect(quotes.items.length).toBeGreaterThan(0);
    expect(quotes.items.every((i) => i.found && (i.page === 1 || i.page === 2))).toBe(true);
    expect(run.nodes.check.verification!.items.every((i) => i.page !== undefined)).toBe(true);
    expect(run.nodes.extract.resolvedInputs!.material).toContain('2 页');
  });

  it('turns bundled sample files (image) into documents and runs on OCR text', async () => {
    const up = await t.call<DocumentSummary>('runner', 'POST', '/api/samples/sample_poster_png/document');
    expect(up.status).toBe(201);
    expect(up.body).toMatchObject({ kind: 'image', method: 'ocr' });
    const r = await t.call<Run>('builder', 'POST', '/api/workflows/wf_demo_sg_marketing_review/runs', { mode: 'test', inputs: { material: up.body.id, channel: '户外海报' } });
    const run = await t.waitRun('builder', r.body.id);
    expect(run.nodes.check.output).toMatchObject({ overall_risk: 'high' });
    expect(run.nodes.extract.transcript!.some((e) => e.type === 'tool_call' && e.name === 'search_document')).toBe(true);
  }, 60_000);

  it('rejects bad uploads and protects other users’ documents', async () => {
    const bad = await t.call('runner', 'POST', '/api/documents?filename=old.doc', undefined, { raw: Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0, 0]) });
    expect(bad.status).toBe(415);
    expect(bad.body.error.hint).toContain('.docx');
    const noName = await t.call('runner', 'POST', '/api/documents', undefined, { raw: Buffer.from('x') });
    expect(noName.status).toBe(400);
    const mine = await t.call<DocumentSummary>('builder', 'POST', '/api/documents?filename=note.txt', undefined, { raw: Buffer.from('Plain text material') });
    expect((await t.call('runner', 'DELETE', `/api/documents/${mine.body.id}`)).status).toBe(403);
    expect((await t.call('builder', 'DELETE', `/api/documents/${mine.body.id}`)).status).toBe(200);
    expect(existsSync(path.join(t.dataDir, 'files', mine.body.id))).toBe(false);
    expect((await t.call('builder', 'GET', `/api/documents/${mine.body.id}`)).status).toBe(404);
  });
});
