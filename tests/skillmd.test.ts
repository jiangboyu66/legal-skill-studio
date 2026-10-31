/** SKILL.md (Agent Skills format) export / import, and the editor's live workflow validation. */
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { SkillView } from '../shared/types';
import { SKILL_CHECK, startApp, type TestApp, WF } from './helpers';

let t: TestApp;
beforeAll(async () => {
  t = await startApp();
  await t.login('builder', 'runner');
});
afterAll(() => t.stop());

it('round-trips a skill through SKILL.md, re-linking rule packs by name', async () => {
  const res = await fetch(`${t.base}/api/skills/${SKILL_CHECK}/export`, { headers: { cookie: t.cookies.builder } });
  expect(res.headers.get('content-disposition')).toContain('-SKILL.md');
  const md = await res.text();
  expect(md).toMatch(/^---\nname: /);
  expect(md).toContain('## Rule packs');
  const imported = await t.call<{ skill: SkillView; warnings: string[] }>('builder', 'POST', '/api/skills/import', { content: md });
  expect(imported.status).toBe(201);
  expect(imported.body.warnings).toEqual([]);
  const original = (await t.call<SkillView>('builder', 'GET', `/api/skills/${SKILL_CHECK}`)).body;
  const copy = imported.body.skill;
  expect(copy.status).toBe('draft');
  expect(copy.draft.instructions).toBe(original.draft.instructions);
  expect(copy.draft.output).toEqual(original.draft.output);
  expect(copy.draft.verification).toEqual(original.draft.verification);
  expect(copy.draft.rulePackIds).toEqual(original.draft.rulePackIds);
  expect(copy.draft.tools).toEqual(original.draft.tools);
});

it('imports a plain SKILL.md from another tool as a document → Markdown skill; rejects files without frontmatter', async () => {
  const md = '---\nname: nda-review\ndescription: Review NDAs for one-sided terms\n---\n# NDA review\n\nRead the NDA and list one-sided clauses.';
  const r = await t.call<{ skill: SkillView }>('builder', 'POST', '/api/skills/import', { content: md });
  expect(r.body.skill.draft.inputs[0]).toMatchObject({ key: 'document', type: 'document' });
  expect(r.body.skill.draft.output.format).toBe('markdown');
  const bad = await t.call('builder', 'POST', '/api/skills/import', { content: '# no frontmatter' });
  expect(bad.body.error.code).toBe('IMPORT_INVALID');
  expect((await t.call('runner', 'POST', '/api/skills/import', { content: md })).status).toBe(403);
});

it('validates workflow drafts live for the editor', async () => {
  const wf = (await t.call('builder', 'GET', `/api/workflows/${WF}`)).body;
  const ok = await t.call('builder', 'POST', '/api/workflows/validate', { def: wf.draft });
  expect(ok.body.issues).toEqual([]);
  const broken = structuredClone(wf.draft);
  broken.nodes[0].needs = ['memo'];
  const bad = await t.call('builder', 'POST', '/api/workflows/validate', { def: broken });
  expect(bad.body.issues[0].message).toContain('循环');
});

it('exposes role baselines and extension points read-only', async () => {
  const p = (await t.call('runner', 'GET', '/api/admin/platform')).body;
  expect(p.roles.runner).toContain('workflow.run');
  expect(p.tools.map((x: { name: string }) => x.name)).toEqual(['read_document', 'search_document', 'lookup_rule', 'verify_quote', 'submit_output']);
  expect(p.agents.map((a: { agentType: string }) => a.agentType)).toEqual(['skill-runner', 'verifier', 'skill-optimizer', 'result-qa']);
  expect(p.hooks.map((h: { name: string }) => h.name)).toContain('legal-verification');
  expect(p.plugins[0]).toMatchObject({ name: 'sg-marketing-compliance', builtIn: true });
});
