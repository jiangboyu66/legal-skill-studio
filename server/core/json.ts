export type JsonParse = { ok: true; value: Record<string, unknown> } | { ok: false; error: string };

/**
 * Lenient JSON extraction from model text: accepts raw JSON, ```json fenced blocks,
 * or the outermost {...} span surrounded by chatter.
 */
export function extractJson(text: string): JsonParse {
  const t = (text ?? '').replace(/^﻿/, '').trim();
  if (!t) return { ok: false, error: '模型返回了空内容' };
  const candidates: string[] = [t];
  const fence = /```(?:json|JSON)?\s*([\s\S]*?)```/.exec(t);
  if (fence) candidates.push(fence[1].trim());
  const first = t.indexOf('{');
  const last = t.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(t.slice(first, last + 1));

  let lastError = '';
  for (const c of candidates) {
    try {
      const v = JSON.parse(c);
      if (v && typeof v === 'object' && !Array.isArray(v)) return { ok: true, value: v as Record<string, unknown> };
      lastError = '期望一个 JSON 对象，但得到的是数组或基本类型';
    } catch (err) {
      lastError = (err as Error).message;
    }
  }
  return { ok: false, error: `不是有效的 JSON（${lastError}）` };
}

/** Removes a single wrapping code fence from Markdown output, if present. */
export function unwrapMarkdown(text: string): string {
  const t = (text ?? '').trim();
  const m = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i.exec(t);
  return (m ? m[1] : t).trim();
}
