import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { DocumentKind, DocumentPage, MaterialDocument, User } from '../../../shared/types';
import { AppError } from '../../errors';
import type { FeatureSet } from '../../features';
import { DataCipher, keyMissingError } from '../storage/crypto';
import type { Db } from '../storage/db';
import { paginate } from './text';

const require = createRequire(import.meta.url);
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

const MIME: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  txt: 'text/plain',
  md: 'text/markdown',
};

function sniff(buf: Buffer, filename: string): { kind: DocumentKind; mime: string } {
  const ext = path.extname(filename).slice(1).toLowerCase();
  if (buf.subarray(0, 4).toString('latin1') === '%PDF') return { kind: 'pdf', mime: MIME.pdf };
  if (buf[0] === 0x89 && buf.subarray(1, 4).toString('latin1') === 'PNG') return { kind: 'image', mime: MIME.png };
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { kind: 'image', mime: MIME.jpg };
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return { kind: 'image', mime: MIME.webp };
  if (buf.subarray(0, 4).toString('latin1') === 'PK\u0003\u0004' && ext === 'docx') return { kind: 'docx', mime: MIME.docx };
  if (ext === 'doc' || buf.subarray(0, 4).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0]))) {
    throw new AppError('UNSUPPORTED_FILE', '暂不支持旧版 Word（.doc）文件。', { status: 415, hint: '请在 Word 中另存为 .docx 或 PDF 后再上传。' });
  }
  if (ext === 'txt' || ext === 'md') return { kind: 'text', mime: MIME[ext] };
  throw new AppError('UNSUPPORTED_FILE', `不支持的文件类型：${filename}`, { status: 415, hint: '支持 PDF、Word（.docx）、PNG/JPG/WebP 图片和 TXT/Markdown。' });
}

async function extractPdf(buf: Buffer): Promise<{ pages: DocumentPage[]; warnings: string[] }> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const fonts = `${path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts')}${path.sep}`;
  const task = pdfjs.getDocument({ data: new Uint8Array(buf), standardFontDataUrl: fonts, disableFontFace: true, useSystemFonts: false, verbosity: 0 });
  const doc = await task.promise;
  const pages: DocumentPage[] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const tc = await (await doc.getPage(n)).getTextContent();
    const text = (tc.items as { str?: string; hasEOL?: boolean }[]).map((i) => `${i.str ?? ''}${i.hasEOL ? '\n' : ''}`).join('').replace(/[ \t]+\n/g, '\n').trim();
    pages.push({ n, text });
  }
  await task.destroy();
  const empty = pages.filter((p) => p.text.length < 10).map((p) => p.n);
  const warnings: string[] = [];
  if (empty.length === pages.length) warnings.push('PDF 没有可提取的文字层（可能是扫描件）。支持视觉的模型会直接读取原 PDF；否则请上传图片版本以使用 OCR。');
  else if (empty.length) warnings.push(`第 ${empty.join('、')} 页没有可提取的文字（可能是图片），这些页面的内容可能被遗漏。`);
  return { pages, warnings };
}

async function extractDocx(buf: Buffer): Promise<{ pages: DocumentPage[]; warnings: string[] }> {
  const mammoth = (await import('mammoth')).default;
  const { value, messages } = await mammoth.extractRawText({ buffer: buf });
  const warnings = messages.length ? [`Word 解析提示：${messages.slice(0, 2).map((m) => m.message).join('；')}`] : [];
  warnings.push('Word 文件按段落分为“页”，页码仅用于定位，不对应打印页码。');
  return { pages: paginate(value), warnings };
}

/** Local OCR with tesseract.js; the worker is created lazily (heavy module) and reused. */
class OcrService {
  private worker?: Promise<{ recognize: (img: Buffer) => Promise<{ data: { text: string; confidence: number } }>; terminate: () => Promise<unknown> }>;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private langs: string, private cacheDir: string) {}

  private langPath(lang: string): string | undefined {
    try {
      return path.dirname(require.resolve(`@tesseract.js-data/${lang}/4.0.0_best_int/${lang}.traineddata.gz`));
    } catch {
      return undefined;
    }
  }

  private start() {
    const langs = this.langs.split('+').filter((l) => this.langPath(l));
    const use = langs.length ? langs : ['eng'];
    this.worker ??= import('tesseract.js').then(({ createWorker }) =>
      createWorker(use.join('+'), 1, { langPath: this.langPath(use[0]), gzip: true, cachePath: this.cacheDir, logger: () => {} }),
    ) as never;
    return this.worker!;
  }

  recognize(buf: Buffer) {
    const job = this.queue.then(async () => (await this.start()).recognize(buf));
    this.queue = job.catch(() => undefined);
    return job;
  }

  async close() {
    if (this.worker) await (await this.worker).terminate();
  }
}

/**
 * Document ingestion service: PDF text layer, Word (.docx), images (local OCR), plain text.
 * Originals are stored under DATA_DIR/files so vision-capable models can read them directly.
 */
export class DocumentService {
  private ocr: OcrService;
  constructor(private db: Db, private features: FeatureSet, ocrLangs: string) {
    this.ocr = new OcrService(ocrLangs, path.join(db.filesDir, '..', 'ocr-cache'));
  }

  async ingest(buf: Buffer, filename: string, orgId: string, user: Pick<User, 'id'>): Promise<MaterialDocument> {
    if (!buf.length) throw new AppError('EMPTY_FILE', '文件为空。', { status: 400 });
    if (buf.length > MAX_UPLOAD_BYTES) throw new AppError('FILE_TOO_LARGE', '文件超过 20MB。', { status: 413, hint: '请压缩或拆分后上传。' });
    const safeName = path.basename(filename || 'upload').slice(0, 120);
    const { kind, mime } = sniff(buf, safeName);
    let pages: DocumentPage[] = [];
    let warnings: string[] = [];
    let method: MaterialDocument['method'] = 'plain';
    try {
      if (kind === 'pdf') {
        ({ pages, warnings } = await extractPdf(buf));
        method = 'text-layer';
      } else if (kind === 'docx') {
        ({ pages, warnings } = await extractDocx(buf));
        method = 'docx';
      } else if (kind === 'text') pages = paginate(buf.toString('utf8'));
      else {
        method = 'ocr';
        if (!this.features.OCR) {
          pages = [{ n: 1, text: '' }];
          warnings.push('OCR 功能已关闭，无法识别图片中的文字。');
        } else {
          const { data } = await this.ocr.recognize(buf);
          const confidence = Math.round(data.confidence);
          pages = [{ n: 1, text: data.text.trim(), ocrConfidence: confidence }];
          warnings.push('图片文字由 OCR 识别，可能遗漏小字、竖排文字或排版信息；支持视觉的模型会同时查看原图。');
          if (confidence < 70) warnings.push(`OCR 置信度较低（${confidence}%），请对照原图人工核对。`);
        }
      }
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError('EXTRACT_FAILED', `无法解析文件「${safeName}」：${(err as Error).message}`, { status: 422, hint: '文件可能已损坏或加密，请另存后重试。' });
    }
    if (!pages.some((p) => p.text.trim()) && kind !== 'pdf') warnings.push('未能从文件中提取到文字。');
    const doc: MaterialDocument = {
      id: `doc_${randomUUID().slice(0, 12)}`,
      orgId,
      filename: safeName,
      mime,
      kind,
      size: buf.length,
      sha256: createHash('sha256').update(buf).digest('hex'),
      status: 'ready',
      method,
      pages,
      warnings,
      uploadedBy: user.id,
      createdAt: new Date().toISOString(),
    };
    // Originals are encrypted at rest when DATA_ENCRYPTION_KEY is set.
    writeFileSync(path.join(this.db.filesDir, doc.id), this.db.cipher ? this.db.cipher.encryptBuffer(buf) : buf);
    return this.db.documents.put(doc);
  }

  ingestText(text: string, label: string, orgId: string, user: Pick<User, 'id'>): Promise<MaterialDocument> {
    return this.ingest(Buffer.from(text, 'utf8'), `${label}.txt`, orgId, user);
  }

  readFile = (doc: MaterialDocument): Buffer | undefined => {
    const f = path.join(this.db.filesDir, doc.id);
    if (!existsSync(f)) return undefined;
    const raw = readFileSync(f);
    if (!DataCipher.isEncryptedBuffer(raw)) return raw;
    if (!this.db.cipher) throw keyMissingError();
    return this.db.cipher.decryptBuffer(raw);
  };

  remove(doc: MaterialDocument) {
    rmSync(path.join(this.db.filesDir, doc.id), { force: true });
    this.db.documents.delete(doc.orgId, doc.id);
  }

  close() {
    return this.ocr.close();
  }
}
