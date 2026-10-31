import type { PendingReviewRef, ReviewEntity, RulePack, RulePackView, Run, RunEvent, Skill, SkillConfig, SkillView, Workflow, WorkflowDef, WorkflowView } from '../../shared/types';
import { rulePackStatus } from '../core/workflow/engine';
import { validateWorkflowDef } from '../core/workflow/dag';
import { sourceStats } from '../core/rulePacks';
import type { Db } from '../services/storage/db';
import { same } from './util';

export function pendingMap(db: Db, orgId: string, type: ReviewEntity): Map<string, PendingReviewRef> {
  const m = new Map<string, PendingReviewRef>();
  for (const r of db.reviews.list(orgId)) {
    if (r.entityType === type && r.status === 'pending') m.set(r.entityId, { id: r.id, submittedByName: r.submittedByName, createdAt: r.createdAt, note: r.note });
  }
  return m;
}

export function skillViews(db: Db, orgId: string, skills: Skill[]): SkillView[] {
  const pending = pendingMap(db, orgId, 'skill');
  const workflows = db.workflows.list(orgId);
  return skills.map((s) => ({
    ...s,
    dirty: !s.published || !same(s.draft, s.published),
    pendingReview: pending.get(s.id),
    usedBy: workflows.filter((w) => [...w.draft.nodes, ...(w.published?.nodes ?? [])].some((n) => n.type === 'skill' && n.skillId === s.id)).map((w) => ({ id: w.id, name: w.name })),
  }));
}

/** Published definition without the approval-time pins (drafts never carry pins). */
export const withoutPins = (d?: WorkflowDef): WorkflowDef | undefined => {
  if (!d) return d;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { pins, ...rest } = d;
  return rest;
};

export function workflowViews(db: Db, orgId: string, wfs: Workflow[]): WorkflowView[] {
  const pending = pendingMap(db, orgId, 'workflow');
  const skills = new Map(db.skills.list(orgId).map((s) => [s.id, s]));
  return wfs.map((w) => {
    const skillIds = [...new Set((w.published ?? w.draft).nodes.filter((n) => n.type === 'skill').map((n) => (n as { skillId: string }).skillId))];
    const pinInfo = skillIds.map((id) => ({
      skillId: id,
      skillName: skills.get(id)?.name ?? id,
      pinned: w.published?.pins?.[id],
      latest: skills.get(id)?.publishedVersion,
    }));
    return {
      ...w,
      dirty: !w.published || !same(w.draft, withoutPins(w.published)),
      pendingReview: pending.get(w.id),
      pinInfo,
      issues: validateWorkflowDef(w.draft, (id) => {
        const s = skills.get(id);
        return s ? { name: s.name, config: s.draft } : undefined;
      }),
    };
  });
}

export function rulePackViews(db: Db, orgId: string, packs: RulePack[]): RulePackView[] {
  const pending = pendingMap(db, orgId, 'rulepack');
  const skills = db.skills.list(orgId);
  return packs.map((p) => ({
    ...p,
    status: rulePackStatus(p),
    dirty: !p.approved || !same(p.draft, p.approved),
    pendingReview: pending.get(p.id),
    usedBy: skills.filter((s) => [...s.draft.rulePackIds, ...(s.published?.rulePackIds ?? [])].includes(p.id)).map((s) => ({ id: s.id, name: s.name })),
    stats: sourceStats(p.draft),
  }));
}

/**
 * What a 使用者 (no edit / approve right) gets: the published version only, without the authoring parts
 * (task instructions, team notes, saved samples) and without unpublished drafts. Returns undefined for
 * items that were never published, which callers treat as "not found".
 */
export function consumerSkillView(db: Db, orgId: string, v: SkillView): SkillView | undefined {
  if (!v.published) return undefined;
  const strip = (c: SkillConfig): SkillConfig => ({ ...c, instructions: '', knowledge: '', testCases: [] });
  const usedBy = db.workflows
    .list(orgId)
    .filter((w) => w.published?.nodes.some((n) => n.type === 'skill' && n.skillId === v.id))
    .map((w) => ({ id: w.id, name: w.name }));
  return { ...v, draft: strip(v.published), published: strip(v.published), dirty: false, pendingReview: undefined, usedBy };
}

export function consumerWorkflowView(v: WorkflowView): WorkflowView | undefined {
  if (!v.published) return undefined;
  const pub = withoutPins(v.published)!;
  return { ...v, draft: pub, dirty: false, pendingReview: undefined, issues: [] };
}

/** Prompts and raw model output are authoring internals: only roles with run.view_internals see them. */
export function runForViewer(run: Run, internals: boolean): Run {
  if (internals) return run;
  const nodes = Object.fromEntries(
    Object.entries(run.nodes).map(([id, n]) => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { prompt, rawOutput, ...rest } = n;
      // the model's reasoning may restate the task instructions: an authoring internal like the prompt
      return [id, { ...rest, transcript: rest.transcript?.filter((e) => e.type !== 'thinking') }];
    }),
  );
  return { ...run, nodes, log: run.log?.filter((e) => e.kind !== 'thinking') };
}

/** Whether a live run event may be sent to a viewer (reasoning only to roles that see run internals). */
export function eventForViewer(e: RunEvent, internals: boolean): boolean {
  if (internals) return true;
  if (e.type === 'thinking_delta') return false;
  if (e.type === 'transcript' && e.entry.type === 'thinking') return false;
  if (e.type === 'log' && e.entry.kind === 'thinking') return false;
  return true;
}
