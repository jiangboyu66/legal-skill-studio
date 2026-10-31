import type { FeedbackStats, Run } from './types';

/** Locations of reviewable items (rows of object lists) in a node output, e.g. "findings[2]". */
export function reviewableLocations(output: unknown): string[] {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(output as Record<string, unknown>)) {
    if (Array.isArray(v) && v.length && v.every((x) => x && typeof x === 'object' && !Array.isArray(x))) v.forEach((_x, i) => out.push(`${k}[${i}]`));
  }
  return out;
}

/**
 * Human feedback on AI findings. H = (A + E) / (A + E + Jr + 2M): accepted and edited findings count
 * as correct, rejected ones as wrong, and every issue the reviewer had to add (missed) weighs double.
 */
export function feedbackStats(run: Pick<Run, 'reviews' | 'missed' | 'nodes'>, nodeId?: string): FeedbackStats {
  const s: FeedbackStats = { accepted: 0, edited: 0, rejected: 0, missed: 0, pending: 0 };
  for (const n of Object.values(run.nodes)) {
    if (nodeId && n.nodeId !== nodeId) continue;
    if (n.status !== 'succeeded') continue;
    for (const loc of reviewableLocations(n.output)) {
      const m = run.reviews[`${n.nodeId}|${loc}`];
      if (!m) s.pending++;
      else s[m.decision]++;
    }
  }
  s.missed = (run.missed ?? []).filter((m) => !nodeId || m.nodeId === nodeId).length;
  const good = s.accepted + s.edited;
  const denom = good + s.rejected + 2 * s.missed;
  if (denom > 0) s.h = good / denom;
  return s;
}

export function addFeedback(a: FeedbackStats, b: FeedbackStats): FeedbackStats {
  const s: FeedbackStats = { accepted: a.accepted + b.accepted, edited: a.edited + b.edited, rejected: a.rejected + b.rejected, missed: a.missed + b.missed, pending: a.pending + b.pending };
  const good = s.accepted + s.edited;
  const denom = good + s.rejected + 2 * s.missed;
  if (denom > 0) s.h = good / denom;
  return s;
}
