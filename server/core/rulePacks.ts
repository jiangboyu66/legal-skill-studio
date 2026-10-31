import type { Rule, RulePackContent, SourceVerification } from '../../shared/types';
import { AppError } from '../errors';

export const CHANNEL_TAGS = ['email', 'sms', 'messaging', 'voice', 'social', 'web', 'print', 'outdoor'] as const;
const RULE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/;
const VERIFICATION: SourceVerification[] = ['verbatim', 'paraphrased', 'unverified'];
const str = (v: unknown, max: number) => (typeof v === 'string' ? v : '').slice(0, max).trim();

/** Normalises untrusted rule pack content and lists problems (Chinese). */
export function normalizeRulePackContent(raw: unknown): { content: RulePackContent; issues: string[] } {
  const r = (raw ?? {}) as Record<string, unknown>;
  const issues: string[] = [];
  const seen = new Set<string>();
  const rules: Rule[] = (Array.isArray(r.rules) ? r.rules : []).slice(0, 300).map((x: Record<string, unknown>, i: number) => {
    const src = (x?.source ?? {}) as Record<string, unknown>;
    const url = str(src.url, 500);
    const rule: Rule = {
      id: str(x?.id, 40),
      title: str(x?.title, 200),
      text: str(x?.text, 4000),
      severity: x?.severity === 'high' || x?.severity === 'low' ? x.severity : 'medium',
      category: str(x?.category, 80) || undefined,
      source: {
        title: str(src.title, 300),
        url: /^https?:\/\//i.test(url) ? url : undefined,
        excerpt: str(src.excerpt, 1000) || undefined,
        verification: VERIFICATION.includes(src.verification as SourceVerification) ? (src.verification as SourceVerification) : 'unverified',
      },
    };
    const channels = ((x?.appliesTo as Record<string, unknown>)?.channels ?? []) as unknown[];
    const tags = (Array.isArray(channels) ? channels : []).map(String).filter((c) => (CHANNEL_TAGS as readonly string[]).includes(c));
    if (tags.length) rule.appliesTo = { channels: [...new Set(tags)] };
    const label = rule.id || `第 ${i + 1} 条`;
    if (!RULE_ID.test(rule.id)) issues.push(`规则「${label}」的编号不合法（字母或数字开头，只含字母、数字、. _ -，最长 40 个字符）。`);
    else if (seen.has(rule.id.toUpperCase())) issues.push(`规则编号「${rule.id}」重复。`);
    seen.add(rule.id.toUpperCase());
    if (!rule.title) issues.push(`规则「${label}」缺少标题。`);
    if (!rule.text) issues.push(`规则「${label}」缺少规则内容。`);
    if (!rule.source.title) issues.push(`规则「${label}」缺少来源（法律法规、准则名称或内部政策）。`);
    if (url && !rule.source.url) issues.push(`规则「${label}」的来源链接必须以 http(s):// 开头。`);
    if (rule.source.verification === 'verbatim' && !rule.source.excerpt) issues.push(`规则「${label}」标注为“原文核对”，请填写来源原文摘录。`);
    return rule;
  });
  return { content: { rules, notes: str(r.notes, 4000) || undefined }, issues };
}

export function assertValidRulePackContent(raw: unknown): RulePackContent {
  const { content, issues } = normalizeRulePackContent(raw);
  if (issues.length) {
    throw new AppError('RULEPACK_INVALID', `规则包有误：${issues[0]}`, { status: 400, hint: issues.length > 1 ? `共 ${issues.length} 处问题。` : undefined, details: { issues } });
  }
  return content;
}

/** Stats shown to reviewers: how much of the pack is backed by verbatim source text. */
export function sourceStats(content: RulePackContent) {
  const by = (v: SourceVerification) => content.rules.filter((r) => r.source.verification === v).length;
  return { total: content.rules.length, verbatim: by('verbatim'), paraphrased: by('paraphrased'), unverified: by('unverified') };
}
