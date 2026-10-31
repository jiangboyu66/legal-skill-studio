/** Moves the local data directory aside; the next server start re-creates the demo organisation. */
import { existsSync, renameSync } from 'node:fs';
import { loadConfig } from '../server/config';

const cfg = loadConfig();
if (existsSync(cfg.dataDir)) {
  const backup = `${cfg.dataDir}.bak-${Date.now()}`;
  renameSync(cfg.dataDir, backup);
  console.log(`已重置。旧数据（数据库、上传的文件）备份在：${backup}\n重新启动服务即可恢复演示组织与示例数据。`);
} else {
  console.log('没有找到数据目录，无需重置。');
}
