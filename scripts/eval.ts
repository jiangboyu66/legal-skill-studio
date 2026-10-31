/**
 * Offline evaluation of the bundled rule-check skill on testdata/eval (npm run eval).
 *   npm run eval -- --split all|train|holdout --out docs/evidence
 * Uses the provider configured by environment variables (mock when no key is set — the report says so).
 * Runs against a fresh temporary data directory, so it never touches your DATA_DIR.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app';
import { assertEvaluable, renderEvalMarkdown, runEval } from '../server/core/eval';
import type { EvalRun } from '../shared/types';

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const split = arg('split', 'all') as EvalRun['split'];
const out = path.resolve(arg('out', 'docs/evidence'));

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'lss-eval-'));
const { ctx, close } = await createApp({ config: { dataDir, demoAccounts: true, mockLatencyMs: 0, retentionDays: 0 }, resume: false });
try {
  const org = ctx.db.orgs.get('org_demo')!;
  const user = ctx.db.getUser('usr_builder')!;
  const skill = ctx.db.skills.get(org.id, 'skl_demo_rule_check')!;
  const set = assertEvaluable(skill.draft);
  console.log(`评测 ${skill.name}（草稿）× ${set.name}，划分 ${split}，模型 ${ctx.provider.info.name}/${ctx.provider.info.model}（${ctx.provider.info.mode}）…`);
  const run = await runEval({
    rt: ctx.rt,
    org,
    user,
    skill: { id: skill.id, name: skill.name, config: skill.draft },
    version: 'draft',
    split,
    set,
    onProgress: (r) => process.stdout.write(`\r  进度 ${r.progress.done}/${r.progress.total}`),
  });
  process.stdout.write('\n');
  const md = renderEvalMarkdown(run, set);
  mkdirSync(out, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const base = path.join(out, `eval-${ctx.provider.info.mode}-${split}-${stamp}`);
  writeFileSync(`${base}.md`, md);
  writeFileSync(`${base}.json`, JSON.stringify(run, null, 2));
  const m = run.metrics.all!;
  console.log(`召回率 ${m.recall?.toFixed(3)}  精确率 ${m.precision?.toFixed(3)}  F2 ${m.f2?.toFixed(3)}  引文可核验率 ${m.quoteRate?.toFixed(3)}  不应标记命中 ${m.mustNotFlag}`);
  console.log(`报告：${base}.md`);
  if (ctx.provider.info.mode === 'mock') console.log('（模拟模式：指标只验证评测流程，不代表模型质量。配置 ANTHROPIC_API_KEY 或 OPENAI_API_KEY 后重跑可得到真实指标。）');
} finally {
  await close();
}
