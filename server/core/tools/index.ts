import type { ToolInfo } from '../../../shared/types';
import { locate } from '../grounding';
import type { Tool, ToolContext } from '../tool';

function pickDocument(ctx: ToolContext, key?: string) {
  const keys = Object.keys(ctx.documents);
  if (key && ctx.documents[key]) return { key, doc: ctx.documents[key] };
  if (!key && keys.length === 1) return { key: keys[0], doc: ctx.documents[keys[0]] };
  return { key, doc: undefined, available: keys };
}

const noDocument = (key: string | undefined, available: string[]) => ({
  content: `ERROR: no document for input_key "${key ?? ''}". Available document inputs: ${available.join(', ') || '(none)'}.`,
  summary: '未找到文档',
  isError: true,
});

// ───────────── read_document ─────────────
export const readDocumentTool: Tool<{ input_key?: string; from_page?: number; to_page?: number }> = {
  name: 'read_document',
  category: 'document',
  readOnly: true,
  description: [
    'Reads pages of an uploaded material (PDF, Word, image OCR text or pasted text) and returns them with page numbers.',
    'When to use: the document was truncated in the prompt, or you need the exact wording/context around a passage before quoting it.',
    'When NOT to use: the full text is already in the prompt — do not re-read it.',
    'Notes: text from images comes from OCR and may contain recognition errors; small print can be missing. Returns at most 20,000 characters per call; request page ranges for long documents.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      input_key: { type: 'string', description: 'Input key of the document, e.g. "material". Optional if there is only one document.' },
      from_page: { type: 'integer', minimum: 1 },
      to_page: { type: 'integer', minimum: 1 },
    },
    additionalProperties: false,
  },
  async call(input, ctx) {
    const { key, doc, available } = pickDocument(ctx, input.input_key);
    if (!doc) return noDocument(key, available ?? []);
    const from = input.from_page ?? 1;
    const to = Math.min(input.to_page ?? doc.pages.length, doc.pages.length);
    let out = '';
    for (const p of doc.pages.filter((p) => p.n >= from && p.n <= to)) {
      const block = `<page n="${p.n}"${p.ocrConfidence !== undefined ? ` ocr_confidence="${p.ocrConfidence}"` : ''}>\n${p.text}\n</page>\n`;
      if (out.length + block.length > 20_000) {
        out += `\n[truncated at page ${p.n}; call again with from_page=${p.n}]`;
        break;
      }
      out += block;
    }
    return { content: `${doc.filename} (${doc.pages.length} pages, extracted via ${doc.method})\n${out}`, summary: `读取 ${doc.filename} 第 ${from}–${to} 页` };
  },
};

// ───────────── search_document ─────────────
export const searchDocumentTool: Tool<{ query: string; input_key?: string }> = {
  name: 'search_document',
  category: 'document',
  readOnly: true,
  description: [
    'Searches a material for a word or phrase (case-insensitive) and returns matching passages with page numbers.',
    'When to use: to find where a claim, price, condition or disclosure appears, or to confirm that something is ABSENT (e.g. no unsubscribe link).',
    'An empty result means the phrase does not appear in the extracted text — for images this may also be an OCR miss, so say so if it matters.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: { query: { type: 'string', minLength: 1 }, input_key: { type: 'string' } },
    required: ['query'],
    additionalProperties: false,
  },
  async call(input, ctx) {
    const { key, doc, available } = pickDocument(ctx, input.input_key);
    if (!doc) return noDocument(key, available ?? []);
    const q = input.query.toLowerCase();
    const hits: string[] = [];
    for (const p of doc.pages) {
      const lower = p.text.toLowerCase();
      let idx = lower.indexOf(q);
      while (idx >= 0 && hits.length < 20) {
        const s = Math.max(0, idx - 80);
        hits.push(`[page ${p.n}] …${p.text.slice(s, idx + q.length + 80).replace(/\s+/g, ' ')}…`);
        idx = lower.indexOf(q, idx + q.length);
      }
    }
    return {
      content: hits.length ? hits.join('\n') : `No match for "${input.query}" in ${doc.filename}.`,
      summary: `搜索「${input.query}」：${hits.length} 处`,
    };
  },
};

// ───────────── lookup_rule ─────────────
export const lookupRuleTool: Tool<{ rule_ids: string[] }> = {
  name: 'lookup_rule',
  category: 'knowledge',
  readOnly: true,
  description: [
    'Returns the full text, severity, source and scope of rules in the rule packs attached to this skill.',
    'When to use: before citing a rule, to confirm it exists and actually covers the issue; to check its channel scope (appliesTo).',
    'Unknown IDs are reported as NOT FOUND — never cite a rule that was not found. Use rule ID "N/A" when no rule applies.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: { rule_ids: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 20 } },
    required: ['rule_ids'],
    additionalProperties: false,
  },
  async call(input, ctx) {
    const lines = input.rule_ids.map((id) => {
      const r = ctx.rules.get(id);
      if (!r) return `[${id}] NOT FOUND in the attached rule packs.`;
      return [
        `[${r.id}] ${r.title} (severity: ${r.severity}; pack: ${r.packName})`,
        r.text,
        r.appliesTo?.channels?.length ? `Applies to channels: ${r.appliesTo.channels.join(', ')}` : 'Applies to: all channels',
        `Source: ${r.source.title}${r.source.url ? ` <${r.source.url}>` : ''} (source text ${r.source.verification})`,
        r.source.excerpt ? `Source excerpt: "${r.source.excerpt}"` : '',
      ]
        .filter(Boolean)
        .join('\n');
    });
    const found = input.rule_ids.filter((id) => ctx.rules.has(id)).length;
    return { content: lines.join('\n\n'), summary: `查询规则 ${input.rule_ids.join(', ')}：找到 ${found}/${input.rule_ids.length}` };
  },
};

// ───────────── verify_quote ─────────────
export const verifyQuoteTool: Tool<{ quote: string; input_key?: string }> = {
  name: 'verify_quote',
  category: 'verification',
  readOnly: true,
  description: [
    'Checks whether a quote appears verbatim in an input (page-aware; tolerant to whitespace, quote marks and dashes; approximate for OCR text).',
    'When to use: before submitting findings, to make sure every quote is copied exactly. If it is not found, copy the exact wording with read_document or search_document.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: { quote: { type: 'string', minLength: 1 }, input_key: { type: 'string' } },
    required: ['quote'],
    additionalProperties: false,
  },
  async call(input, ctx) {
    const { key, doc } = pickDocument(ctx, input.input_key);
    const text = doc ? doc.pages.map((p) => p.text).join('\n') : ctx.inputs[key ?? ''] ?? Object.values(ctx.inputs).join('\n');
    const m = locate(input.quote, { text, doc });
    return {
      content: m.found ? `FOUND (${m.match}${m.page ? `, page ${m.page}` : ''})` : 'NOT FOUND — the quote is not verbatim; copy the exact wording from the document.',
      summary: `核对引文：${m.found ? `找到${m.page ? `（第 ${m.page} 页）` : ''}` : '未找到'}`,
    };
  },
};

/** Registry of built-in tools (cf. tools.ts). submit_output is created per execution in the query engine. */
export const TOOL_REGISTRY: Tool[] = [
  readDocumentTool as unknown as Tool,
  searchDocumentTool as unknown as Tool,
  lookupRuleTool as unknown as Tool,
  verifyQuoteTool as unknown as Tool,
];

export const getTool = (name: string) => TOOL_REGISTRY.find((t) => t.name === name);

export const SUBMIT_OUTPUT = 'submit_output';

export function listTools(): ToolInfo[] {
  return [
    ...TOOL_REGISTRY.map((t) => ({ name: t.name, description: t.description.split('\n')[0], readOnly: t.readOnly })),
    { name: SUBMIT_OUTPUT, description: 'Submits the structured result; input schema = the skill output contract.', readOnly: true },
  ];
}
