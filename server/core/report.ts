import { feedbackStats } from '../../shared/feedback';
import type { GroundingResult, NodeRun, Run, VerificationItem } from '../../shared/types';
import { jurisdictionText } from './jurisdiction';

const RUN_STATUS: Record<string, string> = {
  queued: '排队中', running: '运行中', waiting_approval: '等待审批', succeeded: '成功', failed: '失败', rejected: '已驳回',
};
const NODE_STATUS: Record<string, string> = {
  pending: '等待', running: '运行中', waiting_approval: '等待审批', succeeded: '成功', failed: '失败', skipped: '已跳过', rejected: '已驳回',
};
const VERDICT: Record<string, string> = {
  supported: '有依据', partially_supported: '部分有依据', unsupported: '依据不足', needs_facts: '需补充事实', not_checked: '未核验',
};
const REVIEW: Record<string, string> = { accepted: '✓ 采纳', edited: '✎ 修改后采纳', rejected: '✗ 驳回' };
const PACK_STATUS: Record<string, string> = { draft: '草稿', in_review: '待审核', approved: '已批准', expired: '已过期' };

function cell(v: unknown): string {
  const s = v === undefined || v === null ? '' : typeof v === 'string' ? v : JSON.stringify(v);
  return s.replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>');
}

function rowCheck(grounding: GroundingResult[] | undefined, location: string): string {
  const items = (grounding ?? []).flatMap((g) => g.items.filter((i) => i.location.startsWith(`${location}.`) || i.location === location));
  if (!items.length) return '';
  const failed = items.filter((i) => !i.found).length;
  const fuzzy = items.filter((i) => i.found && i.match === 'fuzzy').length;
  const pages = [...new Set(items.map((i) => i.page).filter(Boolean))];
  if (failed) return `⚠ ${failed} 项未在来源中找到`;
  return `${fuzzy ? '≈ OCR 近似匹配，需对照原件核实' : '✓ 引文已核对'}${pages.length ? `（第 ${pages.join('、')} 页）` : ''}`;
}

function verificationCell(items: VerificationItem[] | undefined, index: number): string {
  const v = items?.find((x) => x.index === index);
  if (!v) return '';
  const notes = [v.applicabilityNote, v.severityNote, v.reason].filter(Boolean).join('；');
  return `${v.needsHumanReview ? '⚠ 优先复核 · ' : '常规复核 · '}${VERDICT[v.verdict]}${notes ? `：${notes}` : ''}`;
}

/** Renders JSON output generically: object lists → tables (with AI checks and human review marks). */
export function renderJson(value: unknown, node: NodeRun | undefined, reviews: Run['reviews']): string {
  if (!value || typeof value !== 'object') return String(value ?? '');
  const out: string[] = [];
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    out.push(`**${key}**`, '');
    if (Array.isArray(v) && v.length && v.every((x) => x && typeof x === 'object' && !Array.isArray(x))) {
      const cols = [...new Set(v.flatMap((x) => Object.keys(x as object)))];
      const hasChecks = (node?.validation?.grounding ?? []).some((g) => g.path.startsWith(`${key}[]`));
      const verified = node?.verification && node.verification.items.length && node.verification.items[0].location.startsWith(`${key}[`);
      const header = ['#', ...cols, ...(hasChecks ? ['引文核对'] : []), ...(verified ? ['结论核验'] : []), '人工复核'];
      out.push(`| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`);
      v.forEach((row, i) => {
        const loc = `${key}[${i}]`;
        const review = reviews[`${node?.nodeId}|${loc}`];
        const cells = [String(i + 1), ...cols.map((c) => cell((row as Record<string, unknown>)[c]))];
        if (hasChecks) cells.push(rowCheck(node?.validation?.grounding, loc));
        if (verified) cells.push(cell(verificationCell(node?.verification?.items, i)));
        const edits = review?.edits ? `；修改：${Object.entries(review.edits).map(([k, v]) => `${k} → ${cell(v)}`).join('；')}` : '';
        cells.push(review ? `${REVIEW[review.decision]}（${cell(review.byName)}${review.note ? `：${cell(review.note)}` : ''}${edits}）` : '待复核');
        out.push(`| ${cells.join(' | ')} |`);
      });
    } else if (Array.isArray(v)) {
      out.push(...(v.length ? v.map((x) => `- ${cell(x)}`) : ['（无）']));
    } else if (v && typeof v === 'object') {
      out.push('```json', JSON.stringify(v, null, 2), '```');
    } else {
      out.push(String(v ?? ''));
    }
    out.push('');
  }
  return out.join('\n');
}

const secs = (ms?: number) => (ms ? `${(ms / 1000).toFixed(1)}s` : '-');

export function renderRunMarkdown(run: Run): string {
  const L: string[] = [];
  const version = run.workflowVersion === 'draft' ? '草稿（测试运行）' : `v${run.workflowVersion}`;
  L.push(`# 运行报告：${run.workflowName}`, '');
  L.push(
    '> 本报告由 AI 生成，仅为初审草稿，须由具备资质的法律/合规人员复核后使用，不构成法律意见。',
    '> “引文核对”只说明引用的文字确实出现在材料中；“结论核验”会检查规则是否存在、是否适用于该渠道、并由核验代理复查，但都不能保证法律结论正确——它只决定复核顺序（优先 / 常规），所有发现都需要人工确认。',
    '',
    `- ${jurisdictionText(run.jurisdiction)}${run.jurisdiction ? `（${run.jurisdiction.source}）` : ''}`,
    `- 运行编号：${run.id}（工作流 ${version}${run.mode === 'test' ? '，测试运行' : ''}${run.retryOf ? `，从失败节点重试自 ${run.retryOf}` : ''}${run.rerunOf ? `，重新运行自 ${run.rerunOf}` : ''}）`,
    `- 状态：${RUN_STATUS[run.status] ?? run.status}`,
    `- 发起人：${run.startedByName}`,
    `- 模型：${run.provider.name} / ${run.provider.model}${run.provider.mode === 'mock' ? '（模拟模式，未调用真实模型）' : ''}`,
    `- 开始：${run.startedAt ?? run.createdAt}　结束：${run.finishedAt ?? '-'}`,
  );
  if (run.usage.inputTokens || run.usage.outputTokens) {
    L.push(`- 用量：输入 ${run.usage.inputTokens ?? 0} tokens，输出 ${run.usage.outputTokens ?? 0} tokens${run.usage.costUsd !== undefined ? `，估算费用 US$${run.usage.costUsd.toFixed(4)}` : ''}`);
  }
  if (run.rulePacks.length) {
    L.push('', '## 使用的规则包', '');
    for (const p of run.rulePacks) {
      L.push(
        p.version === 'draft'
          ? `- ${p.name}：**未经审核的草稿**（${PACK_STATUS[p.status] ?? p.status}），结果仅供测试`
          : `- ${p.name} v${p.version}：由 ${p.approval?.approverName}（${p.approval?.approverQualification}）于 ${p.approval?.approvedAt.slice(0, 10)} 批准，复审截止 ${p.approval?.reviewDueAt.slice(0, 10)}`,
      );
    }
  }
  if (run.warnings.length) {
    L.push('', '## 提示', '');
    for (const w of run.warnings) L.push(`- ${w.message}`);
  }
  const sec = run.order
    .map((id) => run.nodes[id])
    .flatMap((n) => {
      const s = n.security;
      if (!s) return [];
      return [
        s.pseudonymized && `「${n.name}」发送模型前已假名化：${s.pseudonymized}${s.visionWithheld?.length ? '；含个人信息的原件未发送' : ''}`,
        s.injectionSuspected?.length && `「${n.name}」材料含疑似提示注入语句（已按数据处理）`,
        s.externalImagesRemoved && `「${n.name}」已移除输出中的 ${s.externalImagesRemoved} 个外部图片`,
        s.leakBlocked && `「${n.name}」输出被拦截：${s.leakBlocked}`,
      ].filter(Boolean) as string[];
    });
  if (sec.length) {
    L.push('', '## 安全防护记录', '');
    for (const x of sec) L.push(`- ${x}`);
  }
  L.push('', '## 节点', '', '| # | 节点 | 类型 | Skill（版本） | 状态 | 耗时 | 引文核对 | 结论核验（优先复核） |', '| --- | --- | --- | --- | --- | --- | --- | --- |');
  run.order.forEach((id, i) => {
    const n = run.nodes[id];
    const g = n.validation?.grounding ?? [];
    const total = g.reduce((s, x) => s + x.total, 0);
    const passed = g.reduce((s, x) => s + x.passed, 0);
    const v = n.verification;
    const status = `${NODE_STATUS[n.status] ?? n.status}${n.skipReason ? `（${cell(n.skipReason)}）` : ''}${n.reusedFrom ? `（复用 ${n.reusedFrom} 的结果）` : ''}`;
    const sv = n.skillVersion === undefined ? '-' : `${cell(n.skillName)} (${n.skillVersion === 'draft' ? '草稿' : `v${n.skillVersion}`})`;
    L.push(
      `| ${i + 1} | ${cell(n.name)} | ${n.type === 'approval' ? '人工审批' : 'AI Skill'} | ${sv} | ${status} | ${secs(n.latencyMs)} | ${total ? `${passed}/${total} 通过` : '-'} | ${v ? `${v.summary.flagged}/${v.items.length} 条优先复核` : '-'} |`,
    );
  });
  const approvals = run.order.map((id) => run.nodes[id]).filter((n) => n.approval);
  if (approvals.length) {
    L.push('', '## 审批记录', '');
    for (const n of approvals) {
      const a = n.approval!;
      L.push(`- ${n.name}：${a.decision === 'approved' ? '批准' : '驳回'} — ${a.byName}，${a.at}${a.comment ? `；意见：${a.comment}` : ''}`);
    }
  }
  if (run.error) L.push('', `**错误**：${run.error.message}${run.error.hint ? `（${run.error.hint}）` : ''}`);

  const fb = feedbackStats(run);
  if (fb.accepted + fb.edited + fb.rejected + fb.missed > 0) {
    L.push('', '## 人工复核汇总', '', `- 采纳 ${fb.accepted}，修改后采纳 ${fb.edited}，驳回 ${fb.rejected}，补充漏项 ${fb.missed}，待复核 ${fb.pending}${fb.h !== undefined ? `；H = ${fb.h.toFixed(2)}` : ''}`);
    for (const m of run.missed ?? []) L.push(`- 补充漏项（${m.byName}）：[${m.ruleId}] ${m.issue}${m.quote ? `；原文：“${m.quote}”` : ''}`);
  }

  L.push('', '## 最终结果', '');
  const outNode = (run.finalNodeId ? run.nodes[run.finalNodeId] : undefined) ?? Object.values(run.nodes).find((n) => n.type === 'skill' && n.status === 'succeeded' && n.output === run.finalOutput);
  if (run.finalOutput === undefined) L.push('（无）');
  else if (typeof run.finalOutput === 'string') L.push(run.finalOutput);
  else L.push(renderJson(run.finalOutput, outNode, run.reviews));

  for (const id of run.order) {
    const n = run.nodes[id];
    if (n === outNode || n.status !== 'succeeded' || n.type !== 'skill' || !n.output || typeof n.output !== 'object') continue;
    if (!n.verification && !Object.keys(run.reviews).some((k) => k.startsWith(`${id}|`))) continue;
    L.push('', `## 节点详情：${n.name}`, '');
    if (n.verification?.note) L.push(`> ${n.verification.note}`, '');
    L.push(renderJson(n.output, n, run.reviews));
  }
  return L.join('\n');
}
