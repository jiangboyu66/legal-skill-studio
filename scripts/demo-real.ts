/**
 * Real-model end-to-end demo (no browser needed):
 *   1. reads the API key from environment variables / .env (never printed)
 *   2. creates a throw-away demo organisation, approves the sample rule pack as the demo reviewer
 *      (a demo approval — NOT a review by a practising lawyer)
 *   3. runs the DAG workflow on a fictional sample (text, PDF, Word or image), approves the human
 *      approval node as a second reviewer, and prints live node status
 *   4. writes the run report and an answer-key evaluation to docs/evidence/
 *
 * Usage:  npm run demo:real                 (high-risk text EDM)
 *         npm run demo:real -- low          (low-risk control sample)
 *         npm run demo:real -- pdf|docx|png (file samples)
 */
import 'dotenv/config';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app';
import { renderRunMarkdown } from '../server/core/report';
import { HIGH_RISK_ANSWER_KEY } from '../server/seed/answerKey';
import { SAMPLES } from '../server/seed/samples';
import type { Run } from '../shared/types';

const arg = process.argv[2] ?? 'high';
const sampleId = { high: 'sample_high_edm', low: 'sample_low_post', pdf: 'sample_edm_pdf', docx: 'sample_post_docx', png: 'sample_poster_png' }[arg];
if (!sampleId) {
  console.error('用法：npm run demo:real -- [high|low|pdf|docx|png]');
  process.exit(1);
}
const tmp = mkdtempSync(path.join(os.tmpdir(), 'lss-demo-'));
const { ctx, close } = await createApp({ config: { dataDir: tmp } });
const provider = ctx.provider.info;
if (provider.mode !== 'real') {
  console.error('\n未检测到模型密钥：当前为模拟模式。');
  console.error('请在 .env 中设置 DEEPSEEK_API_KEY（DeepSeek）、ANTHROPIC_API_KEY，或 OPENAI_API_KEY + OPENAI_BASE_URL/OPENAI_MODEL 后重试。\n');
  process.exit(1);
}

const { db, engine, governance, docs } = ctx;
const org = db.orgs.get('org_demo')!;
const user = (id: string) => db.getUser(id)!;

// Demo approval of the bundled rule pack (four-eyes: installed by the admin, approved by the reviewer).
const pending = db.reviews.list(org.id).find((r) => r.entityType === 'rulepack' && r.status === 'pending')!;
governance.decide(org, user('usr_reviewer'), pending.id, 'approved', '演示审批（非执业律师审核）', {
  approverName: '演示审核人',
  approverQualification: '演示账号（非新加坡执业律师）',
  attested: true,
  reviewDueAt: new Date(Date.now() + 90 * 86400_000).toISOString(),
});

const sample = SAMPLES.find((s) => s.id === sampleId)!;
const inputs: Record<string, unknown> = { ...sample.inputs };
if (sample.file) {
  const doc = await docs.ingest(readFileSync(path.resolve('server/seed/files', sample.file)), sample.file, org.id, user('usr_runner'));
  inputs.material = { documentId: doc.id };
  console.log(`已解析文件 ${sample.file}：${doc.method}，${doc.pages.length} 页${doc.warnings.length ? `（${doc.warnings.join(' ')}）` : ''}`);
}
const wf = db.workflows.get(org.id, 'wf_demo_sg_marketing_review')!;
console.log(`\n真实模型：${provider.name} / ${provider.model}${provider.vision ? '（视觉开启）' : ''}`);
console.log(`工作流：${wf.name}（${wf.published!.nodes.length} 个节点，DAG）`);
console.log(`材料：${sample.title}\n`);

const started = Date.now();
const seen = new Map<string, string>();
const t = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;
let run: Run = await engine.start({ org, user: user('usr_runner'), workflow: wf, mode: 'production', inputs });
const unsubscribe = ctx.events.subscribe(run.id, (e) => {
  if (e.type === 'node_status' && seen.get(e.nodeId) !== e.status) {
    seen.set(e.nodeId, e.status);
    const n = engine.get(org.id, run.id).nodes[e.nodeId];
    console.log(`  [${t()}] 节点「${n.name}」→ ${e.status}${n.latencyMs ? `  ${(n.latencyMs / 1000).toFixed(1)}s` : ''}${n.error ? `  ${n.error.code}: ${n.error.message}` : ''}${n.skipReason ? `（${n.skipReason}）` : ''}`);
  }
  if (e.type === 'transcript' && e.entry.type === 'tool_call') console.log(`  [${t()}]   · ${e.nodeId} 调用工具 ${e.entry.name}`);
});

for (;;) {
  await engine.idle();
  run = engine.get(org.id, run.id);
  if (run.status !== 'waiting_approval') break;
  const waiting = run.order.find((id) => run.nodes[id].status === 'waiting_approval')!;
  console.log(`  [${t()}] 节点「${run.nodes[waiting].name}」等待审批 → 由第二位演示审核人批准`);
  await engine.decide({ org, user: user('usr_reviewer2'), runId: run.id, nodeId: waiting, decision: 'approved', comment: '演示：同意' });
}
unsubscribe();
run = db.runs.get(org.id, run.id)!;

const evidenceDir = path.resolve('docs/evidence');
mkdirSync(evidenceDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const base = path.join(evidenceDir, `real-run-${arg}-${stamp}`);
writeFileSync(`${base}.json`, JSON.stringify(run, null, 2));
writeFileSync(`${base}.md`, renderRunMarkdown(run));

console.log(`\n结果：${run.status}，总用时 ${t()}，token 输入 ${run.usage.inputTokens ?? 0}（缓存读 ${run.usage.cacheReadTokens ?? 0}）/ 输出 ${run.usage.outputTokens ?? 0}`);
for (const id of run.order) {
  const n = run.nodes[id];
  for (const g of n.validation?.grounding ?? []) console.log(`  「${n.name}」${g.label}：${g.passed}/${g.total} 通过`);
  if (n.verification) {
    const s = n.verification.summary;
    console.log(`  「${n.name}」结论核验：支持 ${s.supported} / 部分 ${s.partially_supported} / 不支持 ${s.unsupported} / 需补充事实 ${s.needs_facts}；优先复核 ${s.flagged}（其余为常规复核）`);
  }
}

const findings = ((run.nodes.check?.output as { findings?: { quote?: string; rule_id?: string; risk_level?: string }[] })?.findings ?? []);
const lines: string[] = [];
if (arg === 'high' || arg === 'png') {
  const hit = HIGH_RISK_ANSWER_KEY.map((k) => {
    const match = findings.find((f) => (f.quote ?? '').toLowerCase().includes(k.anchor.toLowerCase()));
    return { k, match, ruleOk: !!match && k.rules.includes(String(match.rule_id)) };
  });
  lines.push(`预置问题识别：${hit.filter((h) => h.match).length}/${HIGH_RISK_ANSWER_KEY.length}（按原文锚点匹配；规则编号与参考答案一致 ${hit.filter((h) => h.ruleOk).length} 项）${arg === 'png' ? '——海报只包含部分问题，召回率不可与文字版直接比较' : ''}`);
  for (const h of hit) lines.push(`  ${h.match ? '✓' : '✗'} ${h.k.id} ${h.k.description}${h.match ? `  → ${h.match.rule_id}` : ''}`);
} else {
  lines.push(`对照样例：共 ${findings.length} 条发现，其中 high ${findings.filter((f) => f.risk_level === 'high').length} 条（需人工判断是否误报）`);
}
console.log(`\n${lines.join('\n')}`);
writeFileSync(`${base}-eval.txt`, `${lines.join('\n')}\n`);
if (run.error) console.log(`  错误：${run.error.message}（${run.error.hint ?? ''}）`);
console.log(`\n证据已写入：\n  ${base}.md\n  ${base}.json\n  ${base}-eval.txt\n`);
await close();
process.exit(run.status === 'succeeded' ? 0 : 2);
