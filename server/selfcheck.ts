import { accessSync, constants } from 'node:fs';
import type { AppConfig } from './config';
import { AppError } from './errors';
import type { Db } from './services/storage/db';

export interface SelfCheckItem {
  name: string;
  ok: boolean;
  level: 'info' | 'warn' | 'fatal';
  message: string;
}

/**
 * Startup self-check: configuration problems are reported before the server accepts requests.
 * Fatal problems stop the start (createApp throws CONFIG_INVALID) so a misconfigured deployment
 * cannot silently run in the wrong mode. Messages never include secret values.
 */
export function selfCheck(cfg: AppConfig, db: Db, opts: { customProvider: boolean }): SelfCheckItem[] {
  const items: SelfCheckItem[] = [];
  const KEY_NAME: Record<string, string> = { anthropic: 'ANTHROPIC_API_KEY', deepseek: 'DEEPSEEK_API_KEY', openai: 'OPENAI_API_KEY' };
  const keyName = KEY_NAME[cfg.provider] ?? '';
  const key = cfg.provider === 'anthropic' ? cfg.anthropic.apiKey : cfg.provider === 'deepseek' ? cfg.deepseek.apiKey : cfg.provider === 'openai' ? cfg.openai.apiKey : '';
  if (!opts.customProvider && keyName && !key) {
    items.push({ name: 'model', ok: false, level: 'fatal', message: `LLM_PROVIDER=${cfg.provider}，但未设置 ${keyName}。请在环境变量中配置密钥，或改用 LLM_PROVIDER=auto / mock。` });
  } else if (cfg.provider === 'mock' || (cfg.provider === 'auto' && !cfg.anthropic.apiKey && !cfg.deepseek.apiKey && !cfg.openai.apiKey)) {
    items.push({ name: 'model', ok: true, level: 'warn', message: '未配置模型密钥：使用模拟模式（结果由程序生成，不代表模型能力）。' });
  } else {
    items.push({ name: 'model', ok: true, level: 'info', message: '模型密钥已通过环境变量配置（值不会被记录或返回给前端）。' });
  }

  try {
    accessSync(cfg.dataDir, constants.W_OK);
    items.push({ name: 'data-dir', ok: true, level: 'info', message: '数据目录可写。' });
  } catch {
    items.push({ name: 'data-dir', ok: false, level: 'fatal', message: `数据目录不可写：${cfg.dataDir}` });
  }

  const probe = db.encryptionProbe();
  if (!probe.readable) {
    items.push({ name: 'encryption', ok: false, level: 'fatal', message: probe.error ?? '无法读取已加密的数据。' });
  } else if (db.cipher) {
    items.push({ name: 'encryption', ok: true, level: 'info', message: `静态加密已开启（AES-256-GCM）${probe.plainRows ? `；另有 ${probe.plainRows} 条开启加密前写入的明文记录，会在下次更新时加密` : ''}。` });
  } else {
    items.push({ name: 'encryption', ok: true, level: 'warn', message: '未设置 DATA_ENCRYPTION_KEY：上传的材料与运行记录以明文存储在数据目录中。' });
  }

  items.push(
    cfg.retentionDays > 0
      ? { name: 'retention', ok: true, level: 'info', message: `数据保留期 ${cfg.retentionDays} 天（到期的运行记录、评测与未被引用的文件会被删除）。` }
      : { name: 'retention', ok: true, level: 'warn', message: '未设置 RETENTION_DAYS：运行记录与上传文件会一直保留。' },
  );
  if (cfg.demoAccounts) items.push({ name: 'demo-accounts', ok: true, level: 'warn', message: '测试账号已启用，密码公开显示在登录页；正式环境请设置 DEMO_ACCOUNTS=false 并修改全部密码。' });
  return items;
}

export function assertSelfCheck(items: SelfCheckItem[]) {
  const fatal = items.filter((i) => i.level === 'fatal');
  if (fatal.length) {
    throw new AppError('CONFIG_INVALID', `启动自检未通过：${fatal.map((f) => f.message).join('；')}`, { hint: '修改环境变量（.env）后重新启动。' });
  }
}
