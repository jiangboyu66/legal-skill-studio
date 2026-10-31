import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { aggregate, configHash, loadEvalSets, scoreCase } from '../server/core/eval';
import { evidenceText, gateFor } from '../server/core/evalService';
import type { EvalCase, EvalCaseResult, EvalRun, OptimizationRun, SkillView } from '../shared/types';
import { SKILL_CHECK, startApp, type TestApp } from './helpers';

const target = { listPath: 'findings', ruleIdField: 'rule_id', quoteField: 'quote' };
const material = 'Best mattress in Singapore! WAS $2,999 NOW $899. Reply with your NRIC to win.';
const c: EvalCase = {
  id: 'X1',
  split: 'train',
  title: 't',
  tags: [],
  inputs: { material },
  expected: [
    { id: 'X1-1', description: 'superlative', rules: ['SCAP-04', 'SCAP-02'], anchors: ['Best mattress'] },
    { id: 'X1-2', description: 'price comparison', rules: ['PRICE-01'], anchors: ['WAS $2,999'] },
    { id: 'X1-3', description: 'NRIC', rules: ['NRIC-01'], anchors: ['NRIC'] },
  ],
  mustNotFlag: [{ rules: ['SPAM-01'], reason: 'not an e-mail' }],
};
const known = new Set(['SCAP-04', 'SCAP-02', 'PRICE-01', 'NRIC-01', 'SPAM-01']);

describe('scoring', () => {
  it('matches findings by acceptable rule + anchor; counts false positives, must-not-flag hits, quote checks and unknown rules', () => {
    const r = scoreCase(
      {
        findings: [
          { rule_id: 'SCAP-04', quote: 'Best mattress in Singapore!' },
          { rule_id: 'SCAP-02', quote: 'Best mattress in Singapore!' }, // duplicate of the same issue: correct, no new match
          { rule_id: 'CPFTA-01', quote: 'WAS $2,999 NOW $899.' }, // right place, rule not acceptable
          { rule_id: 'SPAM-01', quote: 'Reply with your NRIC to win.' }, // must not flag
          { rule_id: 'XYZ-9', quote: 'Invented sentence that is not there' },
        ],
      },
      c,
      target,
      known,
      material,
    );
    expect(r.matched).toEqual(['X1-1']);
    expect(r.missed.map((m) => m.id)).toEqual(['X1-2', 'X1-3']);
    expect(r.falsePositives.map((f) => f.index)).toEqual([2, 3, 4]);
    expect(r.falsePositives[0].reason).toContain('规则编号不在可接受范围');
    expect(r.mustNotFlagHits).toEqual([{ index: 3, ruleId: 'SPAM-01', reason: 'not an e-mail' }]);
    expect(r.quotesVerified).toBe(4);
    expect(r.unknownRules).toBe(2);
  });

  it('aggregates micro-averaged recall / precision / F2 and treats "no findings" as vacuous precision', () => {
    const base = { caseId: 'a', title: '', split: 'train' as const, tags: [], ok: true, missed: [], falsePositives: [], mustNotFlagHits: [], unknownRules: 0, latencyMs: 10 };
    const results: EvalCaseResult[] = [
      { ...base, findings: 4, expected: 4, matched: ['1', '2', '3'], falsePositives: [{ index: 3, ruleId: 'A', quote: '', reason: '' }], quotesVerified: 4 },
      { ...base, caseId: 'b', findings: 0, expected: 0, matched: [], quotesVerified: 0 },
    ];
    const m = aggregate(results);
    expect(m.recall).toBeCloseTo(0.75);
    expect(m.precision).toBeCloseTo(0.75);
    expect(m.f2).toBeCloseTo(0.75);
    expect(m.score).toBeCloseTo(0.5 * 0.75 + 0.15 * 1);
    expect(aggregate([{ ...base, findings: 0, expected: 2, matched: [], quotesVerified: 0 }])).toMatchObject({ recall: 0, precision: 1, f2: 0 });
  });

  it('the bundled eval set is consistent: anchors occur verbatim in the materials and splits are 6 / 4', () => {
    const [set] = loadEvalSets();
    expect(set.cases.filter((x) => x.split === 'train')).toHaveLength(6);
    expect(set.cases.filter((x) => x.split === 'holdout')).toHaveLength(4);
    for (const k of set.cases) for (const e of k.expected) for (const a of e.anchors) expect(k.inputs.material.toLowerCase()).toContain(a.toLowerCase());
    expect(set.cases.some((x) => x.tags.includes('injection'))).toBe(true);
    expect(set.cases.filter((x) => x.tags.includes('control')).length).toBe(2);
  });

  it('the gate requires a holdout gain ≥ 0.03, no new false positives or errors, and ≤ 120 % length', () => {
    const run = (score: number, mustNotFlag = 0, errors = 0) => ({ metrics: { holdout: { score } as never, all: { mustNotFlag, errors } as never } }) as unknown as EvalRun;
    expect(gateFor(run(0.5), run(0.54), 100, 110).passed).toBe(true);
    expect(gateFor(run(0.5), run(0.52), 100, 110).checks[0].passed).toBe(false);
    expect(gateFor(run(0.5), run(0.6, 1), 100, 110).checks[1].passed).toBe(false);
    expect(gateFor(run(0.5), run(0.6, 0, 1), 100, 110).checks[2].passed).toBe(false);
    expect(gateFor(run(0.5), run(0.6), 100, 121).checks[3].passed).toBe(false);
  });
});

describe('evaluation and controlled optimisation through the API', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await startApp();
    await t.login('builder', 'runner', 'reviewer', 'reviewer2');
  });
  afterAll(() => t.stop());

  const finished = async (id: string) => {
    await t.ctx.evals.idle();
    return (await t.call<EvalRun>('builder', 'GET', `/api/evals/${id}`)).body;
  };

  let draftEval: EvalRun;
  it('evaluates the draft on train + holdout and reports metrics per split (mock mode is labelled)', async () => {
    const view = (await t.call('builder', 'GET', `/api/skills/${SKILL_CHECK}/evals`)).body;
    expect(view.set).toMatchObject({ counts: { train: 6, holdout: 4 } });
    const r = await t.call<EvalRun>('builder', 'POST', `/api/skills/${SKILL_CHECK}/evals`, { target: 'draft', split: 'all' });
    expect(r.status).toBe(202);
    expect(r.body.status).toBe('running');
    draftEval = await finished(r.body.id);
    expect(draftEval.status).toBe('succeeded');
    expect(draftEval.cases).toHaveLength(10);
    expect(draftEval.metrics.train!.cases).toBe(6);
    expect(draftEval.metrics.holdout!.cases).toBe(4);
    expect(draftEval.metrics.all!.f2).toBeGreaterThanOrEqual(0);
    expect(draftEval.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(['MOCK_MODE', 'RULEPACK_UNREVIEWED']));
    // the PII case was pseudonymised like any other run, and quotes still verify against the original
    expect(draftEval.cases.find((x) => x.caseId === 'T06')!.ok).toBe(true);
  });

  it('runners cannot evaluate; skills without a findings list are not evaluable', async () => {
    expect((await t.call('runner', 'POST', `/api/skills/${SKILL_CHECK}/evals`, {})).status).toBe(403);
    const memo = await t.call('builder', 'POST', '/api/skills/skl_demo_review_memo/evals', {});
    expect(memo.status).toBe(400);
    expect(memo.body.error.code).toBe('EVAL_NOT_APPLICABLE');
  });

  it('the optimiser sees training failures only, and a candidate without holdout gain is rejected by the gate', async () => {
    const r = await t.call<OptimizationRun>('builder', 'POST', `/api/skills/${SKILL_CHECK}/optimizations`, { baselineEvalId: draftEval.id });
    expect(r.status).toBe(202);
    await t.ctx.evals.idle();
    const opt = (await t.call<OptimizationRun>('builder', 'GET', `/api/optimizations/${r.body.id}`)).body;
    expect(opt.status).toBe('succeeded');
    expect(opt.evidence.missed).toBeGreaterThan(0);
    expect(opt.candidate!.instructions.startsWith(opt.baseline.instructions)).toBe(true);
    expect(opt.candidate!.instructions.length).toBeLessThanOrEqual(opt.baseline.instructions.length * 1.2);
    const cand = (await t.call<EvalRun>('builder', 'GET', `/api/evals/${opt.candidateEvalId}`)).body;
    expect(cand).toMatchObject({ version: 'candidate', optimizationId: opt.id, status: 'succeeded' });
    expect(opt.gate!.passed).toBe(false); // mock output does not depend on instructions → no gain
    expect(opt.gate!.checks[0]).toMatchObject({ passed: false });
    const adopt = await t.call('builder', 'POST', `/api/skills/${SKILL_CHECK}/optimizations/${opt.id}/adopt`);
    expect(adopt.status).toBe(409);
    // holdout cases never reach the optimiser: only training-split failures are used as evidence
    const ev = evidenceText(draftEval, []).text;
    const holdoutMisses = draftEval.cases.filter((x) => x.split === 'holdout').flatMap((x) => x.missed.map((m) => m.description));
    const trainMisses = draftEval.cases.filter((x) => x.split === 'train').flatMap((x) => x.missed.map((m) => m.description));
    expect(holdoutMisses.length).toBeGreaterThan(0);
    for (const d of holdoutMisses) expect(ev).not.toContain(d);
    for (const d of trainMisses) expect(ev).toContain(d);
  });

  it('a gated candidate can be adopted into the draft only (publishing still needs review)', async () => {
    const skill = t.ctx.db.skills.get('org_demo', SKILL_CHECK)!;
    const ok: OptimizationRun = {
      id: 'opt_test1',
      orgId: 'org_demo',
      skillId: SKILL_CHECK,
      skillName: skill.name,
      status: 'succeeded',
      provider: t.ctx.provider.info,
      baseline: { evalId: draftEval.id, configHash: configHash(skill.draft), instructions: skill.draft.instructions },
      evidence: { missed: 1, falsePositives: 0, mustNotFlag: 0, feedback: 0 },
      candidate: { instructions: `${skill.draft.instructions}\n10. 逐项检查小字中的条件。`, rationale: 'test', changes: ['x'] },
      gate: { passed: true, checks: [] },
      startedBy: 'usr_builder',
      startedByName: 'b',
      createdAt: new Date().toISOString(),
    };
    t.ctx.db.optimizations.put(ok);
    expect((await t.call('runner', 'POST', `/api/skills/${SKILL_CHECK}/optimizations/${ok.id}/adopt`)).status).toBe(403);
    const r = await t.call<SkillView>('builder', 'POST', `/api/skills/${SKILL_CHECK}/optimizations/${ok.id}/adopt`);
    expect(r.status).toBe(200);
    expect(r.body.draft.instructions).toContain('逐项检查小字');
    expect(r.body.published!.instructions).not.toContain('逐项检查小字');
    expect(r.body).toMatchObject({ dirty: true, publishedVersion: 1 });
    expect((await t.call('builder', 'POST', `/api/skills/${SKILL_CHECK}/optimizations/${ok.id}/adopt`)).status).toBe(409);

    // the reviewer sees both evaluations side by side when the change is submitted
    const e2 = await t.call<EvalRun>('builder', 'POST', `/api/skills/${SKILL_CHECK}/evals`, { target: 'draft' });
    const e1 = await t.call<EvalRun>('builder', 'POST', `/api/skills/${SKILL_CHECK}/evals`, { target: 'published' });
    await finished(e2.body.id);
    await finished(e1.body.id);
    const sub = await t.call('builder', 'POST', `/api/skills/${SKILL_CHECK}/submit`, { note: '采用优化候选' });
    const detail = (await t.call('reviewer', 'GET', `/api/reviews/${sub.body.id}`)).body;
    expect(detail.evals.submitted.id).toBe(e2.body.id);
    expect(detail.evals.published.id).toBe(e1.body.id);
  });
});
