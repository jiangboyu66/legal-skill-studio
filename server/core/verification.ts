import { collectPath } from '../../shared/schema';
import type { MaterialDocument, Rule, VerificationConfig, VerificationItem, VerificationResult, Verdict } from '../../shared/types';
import { locate } from './grounding';

const CHANNEL_PATTERNS: [string, RegExp][] = [
  ['email', /edm|e-?mail|newsletter|邮件|电邮/i],
  ['sms', /\bsms\b|text message|短信/i],
  ['messaging', /whatsapp|telegram|wechat|微信|\bline\b|messag|即时通讯/i],
  ['voice', /\bcall\b|voice|telemarket|电话/i],
  ['social', /instagram|facebook|tiktok|social|社交|小红书|linkedin|youtube/i],
  ['web', /\bweb|landing|网站|网页|落地页/i],
  ['print', /print|poster|flyer|brochure|海报|传单|印刷/i],
  ['outdoor', /outdoor|billboard|户外/i],
];

/** Maps a free-text channel ("EDM（批量营销邮件）", "Instagram") to channel tags used by rule scopes. */
export function channelTags(channel?: string): string[] {
  if (!channel?.trim()) return [];
  return CHANNEL_PATTERNS.filter(([, re]) => re.test(channel)).map(([tag]) => tag);
}

const RANK: Record<string, number> = { high: 3, medium: 2, low: 1 };

export interface AgentVerdict {
  index: number;
  verdict: Exclude<Verdict, 'not_checked'>;
  reason?: string;
  missing_facts?: string[];
}

export interface VerifyParams {
  output: unknown;
  config: VerificationConfig;
  rules: Map<string, Rule & { packName: string }>;
  material: { text: string; doc?: MaterialDocument };
  channel?: string;
  /** Injected verifier sub-agent; returns null when unavailable. */
  runAgent?: (findings: { index: number; rule_id: string; quote: string; conclusion: string; severity?: string }[]) => Promise<AgentVerdict[] | null>;
}

/**
 * Second line of defence for legal conclusions:
 *  1. deterministic: cited rule exists; quote is in the material (page); rule scope covers the channel;
 *     severity is consistent with the rule's default severity
 *  2. verifier agent (read-only sub-agent) tries to falsify each finding
 * Anything doubtful is flagged for human review. This narrows — it does not remove — the need for review.
 */
export async function verifyFindings(p: VerifyParams): Promise<VerificationResult> {
  const c = p.config;
  const list = collectPath(p.output, `${c.listPath}[]`).filter((x) => x.value && typeof x.value === 'object');
  const tags = channelTags(p.channel);
  const items: VerificationItem[] = list.map((entry, index) => {
    const row = entry.value as Record<string, unknown>;
    const ruleId = String(row[c.ruleIdField] ?? '').trim();
    const rule = p.rules.get(ruleId);
    const quote = String(row[c.quoteField] ?? '');
    const m = quote ? locate(quote, p.material) : { found: false };
    let applicability: VerificationItem['applicability'] = 'unknown';
    let applicabilityNote: string | undefined;
    if (rule) {
      const scope = rule.appliesTo?.channels ?? [];
      if (!scope.length) applicability = 'ok';
      else if (!tags.length) {
        applicability = 'unknown';
        applicabilityNote = `该规则仅适用于 ${scope.join('/')} 渠道，但未提供物料渠道，无法判断。`;
      } else if (scope.some((s) => tags.includes(s))) applicability = 'ok';
      else {
        applicability = 'warn';
        applicabilityNote = `该规则适用于 ${scope.join('/')} 渠道，物料渠道为 ${tags.join('/')}；除非物料中另有相应的营销发送行为，否则可能不适用。`;
      }
    }
    let severity: VerificationItem['severity'] = 'unknown';
    let severityNote: string | undefined;
    const sev = c.severityField ? String(row[c.severityField] ?? '') : '';
    if (rule && RANK[sev]) {
      const diff = RANK[sev] - RANK[rule.severity];
      severity = Math.abs(diff) >= 2 ? 'warn' : 'ok';
      if (severity === 'warn') severityNote = `风险等级 ${sev} 与规则默认等级 ${rule.severity} 相差较大，请确认。`;
    }
    return {
      index,
      location: entry.location,
      ruleId,
      ruleExists: !!rule,
      ruleTitle: rule?.title,
      quoteFound: m.found,
      quoteMatch: m.found ? (m as { match?: 'exact' | 'fuzzy' }).match : undefined,
      page: m.page,
      applicability,
      applicabilityNote,
      severity,
      severityNote,
      verdict: 'not_checked',
      needsHumanReview: false,
    };
  });

  let agentUsed = false;
  let note: string | undefined;
  if (p.runAgent && items.length) {
    const verdicts = await p.runAgent(
      items.map((it, i) => {
        const row = list[i].value as Record<string, unknown>;
        return { index: it.index, rule_id: it.ruleId, quote: String(row[c.quoteField] ?? ''), conclusion: String(row[c.conclusionField] ?? ''), severity: c.severityField ? String(row[c.severityField] ?? '') : undefined };
      }),
    );
    if (verdicts) {
      agentUsed = true;
      for (const v of verdicts) {
        const it = items.find((x) => x.index === v.index);
        if (!it) continue;
        it.verdict = v.verdict;
        it.reason = v.reason;
        it.missingFacts = v.missing_facts?.filter(Boolean);
      }
    } else note = '验证代理未能完成，本次仅做了确定性检查。';
  }

  // Every finding still needs a human decision; this only orders the review (cf. the guide's point that
  // one AI checking another is not a substitute for a lawyer reading the material).
  for (const it of items) {
    it.needsHumanReview =
      !it.ruleExists ||
      !it.quoteFound ||
      it.quoteMatch === 'fuzzy' ||
      it.applicability === 'warn' ||
      it.severity === 'warn' ||
      ['unsupported', 'needs_facts', 'partially_supported'].includes(it.verdict);
  }
  const summary = { supported: 0, partially_supported: 0, unsupported: 0, needs_facts: 0, not_checked: 0, flagged: 0 } as VerificationResult['summary'];
  for (const it of items) {
    summary[it.verdict]++;
    if (it.needsHumanReview) summary.flagged++;
  }
  return { items, summary, agentUsed, note };
}
