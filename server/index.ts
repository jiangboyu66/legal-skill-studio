import { createApp } from './app';
import { AppError } from './errors';
import { DEMO_USERS } from './seed';

let created: Awaited<ReturnType<typeof createApp>>;
try {
  created = await createApp();
} catch (e) {
  // Startup self-check (or another configuration problem): explain and stop instead of running half-configured.
  if (e instanceof AppError) {
    console.error(`\n  ✗ ${e.message}${e.hint ? `\n    ${e.hint}` : ''}\n`);
    process.exit(1);
  }
  throw e;
}
const { app, ctx, close, checks } = created;

const server = app.listen(ctx.cfg.port, () => {
  const p = ctx.provider.info;
  console.log(`\n  Legal Skill Studio API  → http://localhost:${ctx.cfg.port}`);
  console.log(`  数据目录：${ctx.cfg.dataDir}`);
  console.log(`  模型：${p.name} / ${p.model}${p.mode === 'mock' ? '（模拟模式：未检测到 API Key，配置 .env 后重启即可切换为真实模型）' : '（真实模型）'}`);
  const off = Object.entries(ctx.features).filter(([, v]) => !v).map(([k]) => k);
  if (off.length) console.log(`  已关闭的功能开关：${off.join(', ')}`);
  console.log('  启动自检：');
  for (const c of checks) console.log(`    ${c.level === 'warn' ? '!' : '✓'} ${c.message}`);
  if (ctx.cfg.demoAccounts) {
    console.log('  测试账号（首次初始化时的密码；登录页同样列出）：');
    for (const u of DEMO_USERS) console.log(`    ${u.email.padEnd(22)} ${u.password.padEnd(16)} ${u.name}`);
  }
  console.log(`  健康检查：http://localhost:${ctx.cfg.port}/api/health\n`);
});

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  server.close();
  // Let executing nodes finish (bounded); unfinished runs resume on the next start.
  await Promise.race([close(), new Promise((r) => setTimeout(r, 10_000))]);
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
