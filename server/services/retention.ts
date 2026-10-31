import { rmSync } from 'node:fs';
import path from 'node:path';
import type { Db } from './storage/db';

/**
 * Data retention (RETENTION_DAYS): finished runs, evaluation records and documents older than the
 * retention period are deleted, together with the stored files. Documents still referenced by a
 * remaining run are kept. Each deletion is recorded in the organisation's audit log (ids only).
 */
export function purgeExpired(db: Db, days: number, audit: (orgId: string, detail: unknown) => void, now = Date.now()) {
  if (days <= 0) return { runs: 0, documents: 0, evals: 0 };
  const cutoff = new Date(now - days * 86400_000).toISOString();
  const r = db.purgeBefore(cutoff);
  for (const d of r.documents) rmSync(path.join(db.filesDir, d.id), { force: true });
  const byOrg = new Map<string, { runs: string[]; documents: string[] }>();
  for (const x of r.runs) (byOrg.get(x.orgId) ?? byOrg.set(x.orgId, { runs: [], documents: [] }).get(x.orgId)!).runs.push(x.id);
  for (const x of r.documents) (byOrg.get(x.orgId) ?? byOrg.set(x.orgId, { runs: [], documents: [] }).get(x.orgId)!).documents.push(x.id);
  for (const [orgId, detail] of byOrg) audit(orgId, { cutoff, retentionDays: days, ...detail });
  return { runs: r.runs.length, documents: r.documents.length, evals: r.evals };
}
