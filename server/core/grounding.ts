import { collectPath } from '../../shared/schema';
import type { GroundingCheck, GroundingResult, InputField, MaterialDocument } from '../../shared/types';

/** Normalises text for tolerant matching: width, case, quotes, dashes, whitespace. */
export function normalizeText(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[​-‍﻿]/g, '')
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐‑‒–—―]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Exact (normalised) containment. Quotes may contain "..." / "…"; each segment must appear in order.
 * Short identifiers (rule IDs) must match whole tokens.
 */
export function appearsIn(source: string, value: string): boolean {
  const src = normalizeText(source);
  let v = normalizeText(value).replace(/^["'「『]+|["'」』]+$/g, '').trim();
  if (!v) return false;
  if (!/\s/.test(v) && v.length <= 24) {
    return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(v)}(?![\\p{L}\\p{N}])`, 'u').test(src);
  }
  v = v.replace(/[.,;:!?。，；：！？]+$/u, '');
  const segments = v.split(/\s*(?:\.{3,}|…+)\s*/).map((x) => x.trim()).filter((x) => x.length >= 2);
  if (!segments.length) return false;
  let from = 0;
  for (const seg of segments) {
    const idx = src.indexOf(seg, from);
    if (idx < 0) return false;
    from = idx + seg.length;
  }
  return true;
}

/**
 * Smallest edit distance between `pattern` and any substring of `text` (Sellers' algorithm, O(n·m)).
 */
function approxSubstringDistance(text: string, pattern: string): number {
  const m = pattern.length;
  let prev = new Uint32Array(m + 1);
  let cur = new Uint32Array(m + 1);
  for (let i = 0; i <= m; i++) prev[i] = i;
  let best = m;
  for (let j = 1; j <= text.length; j++) {
    cur[0] = 0; // a match may start anywhere in the text
    const tc = text.charCodeAt(j - 1);
    for (let i = 1; i <= m; i++) {
      const sub = prev[i - 1] + (pattern.charCodeAt(i - 1) === tc ? 0 : 1);
      cur[i] = Math.min(prev[i] + 1, cur[i - 1] + 1, sub);
    }
    if (cur[m] < best) best = cur[m];
    [prev, cur] = [cur, prev];
  }
  return best;
}

/**
 * Approximate match for OCR'd text: accepts when the quote can be turned into some passage of the
 * source with at most 15 % character edits (OCR typically confuses l/i, rn/m, drops letters).
 * Only used for OCR documents; quotes from text layers must match exactly.
 */
export function fuzzyAppearsIn(source: string, value: string, maxEditRatio = 0.15): boolean {
  const q = normalizeText(value).replace(/^["'「『]+|["'」』]+$/g, '');
  if (q.length < 12 || q.length > 600) return false;
  const s = normalizeText(source);
  return approxSubstringDistance(s, q) <= Math.floor(q.length * maxEditRatio);
}

export interface MatchResult {
  found: boolean;
  match?: 'exact' | 'fuzzy';
  page?: number;
}

/** Finds a quote in a document (page-aware) or plain text. Fuzzy matching is used for OCR'd documents. */
export function locate(value: string, source: { text: string; doc?: MaterialDocument }): MatchResult {
  const doc = source.doc;
  if (doc) {
    for (const p of doc.pages) if (appearsIn(p.text, value)) return { found: true, match: 'exact', page: p.n };
    if (appearsIn(source.text, value)) return { found: true, match: 'exact' };
    if (doc.method === 'ocr') {
      for (const p of doc.pages) if (fuzzyAppearsIn(p.text, value)) return { found: true, match: 'fuzzy', page: p.n };
    }
    return { found: false };
  }
  return appearsIn(source.text, value) ? { found: true, match: 'exact' } : { found: false };
}

export function sourceLabel(source: string, inputDefs: InputField[]): string {
  if (source === 'knowledge') return '参考资料与规则包';
  const key = source.replace(/^input:/, '');
  const def = inputDefs.find((d) => d.key === key);
  return def ? `输入「${def.label}」` : `输入 ${key}`;
}

export function runGroundingChecks(
  checks: GroundingCheck[],
  output: unknown,
  ctx: { inputs: Record<string, string>; knowledge: string; inputDefs: InputField[]; documents: Record<string, MaterialDocument> },
): GroundingResult[] {
  return checks.map((check) => {
    const base = { checkId: check.id, label: check.label, path: check.path, source: check.source, sourceLabel: sourceLabel(check.source, ctx.inputDefs) };
    const key = check.source.replace(/^input:/, '');
    const doc = check.source === 'knowledge' ? undefined : ctx.documents[key];
    const text = check.source === 'knowledge' ? ctx.knowledge : doc ? doc.pages.map((p) => p.text).join('\n') : ctx.inputs[key];
    if (!text || !text.trim()) return { ...base, total: 0, passed: 0, items: [], note: '核对来源为空，未执行核对' };
    const items = collectPath(output, check.path)
      .filter((pv) => typeof pv.value === 'string' && pv.value.trim() !== '')
      .map((pv) => {
        const m = locate(String(pv.value), { text, doc });
        return { location: pv.location, value: String(pv.value), found: m.found, match: m.match, page: m.page };
      });
    return { ...base, total: items.length, passed: items.filter((i) => i.found).length, items };
  });
}
