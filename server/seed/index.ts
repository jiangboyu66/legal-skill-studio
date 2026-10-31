import type { Org, Role, User } from '../../shared/types';
import { DEFAULT_POLICY } from '../core/permissions';
import { installPlugin, type LoadedPlugin } from '../plugins/loader';
import { hashPassword, verifyPassword } from '../services/auth';
import type { Db } from '../services/storage/db';

export const DEMO_ORG_ID = 'org_demo';

export interface SeedUser {
  id: string;
  email: string;
  name: string;
  role: Role;
  title: string;
  /** Test password (demo organisation only). Shown on the login page while DEMO_ACCOUNTS=true and unchanged. */
  password?: string;
}

/** Test accounts: one per role, each with its own password (two reviewers for the four-eyes rule). */
export const DEMO_USERS: (SeedUser & { password: string })[] = [
  { id: 'usr_admin', email: 'admin@demo.local', name: '陈管理（管理员）', role: 'admin', title: '法务运营负责人', password: 'Admin@2026' },
  { id: 'usr_builder', email: 'builder@demo.local', name: '林创建（创建者）', role: 'builder', title: '法务运营 / 知识管理', password: 'Builder@2026' },
  { id: 'usr_reviewer', email: 'reviewer@demo.local', name: '黄审核（法律审核人）', role: 'reviewer', title: '资深法律顾问（演示账号）', password: 'Reviewer@2026' },
  { id: 'usr_reviewer2', email: 'reviewer2@demo.local', name: '吴复核（法律审核人）', role: 'reviewer', title: '法律顾问（演示账号）', password: 'Reviewer2@2026' },
  { id: 'usr_runner', email: 'runner@demo.local', name: '张使用（使用者）', role: 'runner', title: '市场合规专员', password: 'Runner@2026' },
];

export const demoPassword = (email: string) => DEMO_USERS.find((u) => u.email === email.toLowerCase())?.password;

/** Creates an organisation, its users (own password, or the shared fallback) and installs the given plugins. */
export function createOrg(db: Db, p: { id: string; name: string; users: SeedUser[]; password?: string; plugins: LoadedPlugin[] }): Org {
  const ts = new Date().toISOString();
  const org: Org = { id: p.id, name: p.name, policy: structuredClone(DEFAULT_POLICY), createdAt: ts };
  db.orgs.put(org);
  for (const u of p.users) {
    const pw = u.password ?? p.password;
    if (!pw) throw new Error(`no password for ${u.email}`);
    const user: User = { id: u.id, orgId: org.id, email: u.email, name: u.name, role: u.role, title: u.title, createdAt: ts };
    db.putUser(user, hashPassword(pw));
  }
  const installer = p.users.find((u) => u.role === 'admin') ?? p.users[0];
  for (const plugin of p.plugins) installPlugin(db, org, plugin, installer);
  return org;
}

export function seedIfEmpty(db: Db, plugins: LoadedPlugin[]) {
  if (!db.isEmpty()) return false;
  db.tx(() => createOrg(db, { id: DEMO_ORG_ID, name: '演示法务团队', users: DEMO_USERS, plugins }));
  return true;
}

/** v3.0 gave every test account the same password; this was public, as are the per-role ones. */
const LEGACY_SHARED_DEMO_PASSWORD = 'demo1234';

/**
 * Upgrade path for data created by v3.0: test accounts still using the old shared password get their own
 * per-role password. Accounts whose password was changed are left alone. Returns the migrated e-mails.
 */
export function migrateLegacyDemoPasswords(db: Db): string[] {
  const moved: string[] = [];
  for (const u of DEMO_USERS) {
    const row = db.getUserByEmail(u.email);
    if (!row || row.orgId !== DEMO_ORG_ID || !verifyPassword(LEGACY_SHARED_DEMO_PASSWORD, row.passwordHash)) continue;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { passwordHash, ...user } = row;
    db.putUser(user, hashPassword(u.password));
    moved.push(u.email);
  }
  return moved;
}
