import type { MaterialDocument } from '../../../shared/types';

/** Renders a document for prompts: each page wrapped in <page n="..."> so the model can cite pages. */
export function documentForPrompt(doc: MaterialDocument, maxChars = 50_000): { text: string; truncated: boolean } {
  let out = '';
  let truncated = false;
  for (const p of doc.pages) {
    const block = `<page n="${p.n}">\n${p.text.trim()}\n</page>\n`;
    if (out.length + block.length > maxChars) {
      truncated = true;
      break;
    }
    out += block;
  }
  return { text: out.trim(), truncated };
}

export function documentPlainText(doc: MaterialDocument): string {
  return doc.pages.map((p) => p.text).join('\n\n');
}

/** Splits long plain text into pseudo-pages at paragraph boundaries. */
export function paginate(text: string, pageChars = 3000): { n: number; text: string }[] {
  const paras = text.replace(/\r\n/g, '\n').split(/\n{2,}/);
  const pages: string[] = [];
  let cur = '';
  for (const p of paras) {
    if (cur && cur.length + p.length + 2 > pageChars) {
      pages.push(cur);
      cur = '';
    }
    cur = cur ? `${cur}\n\n${p}` : p;
  }
  if (cur.trim() || !pages.length) pages.push(cur);
  return pages.map((t, i) => ({ n: i + 1, text: t.trim() }));
}

export function summarizeDocument(doc: MaterialDocument) {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { pages, ...rest } = doc;
  const text = documentPlainText(doc);
  const conf = pages.map((p) => p.ocrConfidence).filter((c): c is number => c !== undefined);
  return { ...rest, pageCount: pages.length, chars: text.length, preview: text.slice(0, 240), ...(conf.length ? { ocrConfidence: Math.min(...conf) } : {}) };
}
