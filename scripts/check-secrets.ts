/**
 * Secret scan (npm run check:secrets [dir]): fails if anything that looks like an API key, token or
 * private key is present in the source tree or in the built frontend (dist/). Complements gitleaks
 * (.pre-commit-config.yaml) for environments without the gitleaks binary.
 *
 * Skipped: node_modules, data directories, .git, binary files, and the local .env files that hold
 * real keys by design (they are git-ignored). A line can opt out with the marker  secret-scan:allow
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SECRET_PATTERNS: { name: string; re: RegExp }[] = [
  { name: 'Anthropic API key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { name: 'OpenAI-style API key', re: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/ },
  { name: 'AWS access key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: 'Slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'Private key', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY( BLOCK)?-----/ },
  { name: 'Hard-coded secret assignment', re: /\b[A-Z0-9_]*(?:API_KEY|SECRET|TOKEN|PASSWORD|ENCRYPTION_KEY)\s*[:=]\s*["']?[A-Za-z0-9_+/=-]{24,}/ },
];

const SKIP_DIRS = new Set(['node_modules', '.git', 'data', 'test-results', '.vite', 'coverage']);
const SKIP_FILES = new Set(['.env', '.env.local', 'package-lock.json']);
const BINARY = /\.(png|jpe?g|gif|webp|ico|pdf|docx|zip|gz|woff2?|ttf|eot|traineddata|wasm|db|sqlite)$/i;

export interface SecretFinding {
  file: string;
  line: number;
  pattern: string;
  preview: string;
}

export function scanText(text: string, file: string): SecretFinding[] {
  const out: SecretFinding[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (line.includes('secret-scan:allow')) return;
    // One finding per line: the first (most specific) pattern wins.
    for (const p of SECRET_PATTERNS) {
      const m = p.re.exec(line);
      if (m) {
        out.push({ file, line: i + 1, pattern: p.name, preview: `${m[0].slice(0, 8)}…（已隐藏）` });
        break;
      }
    }
  });
  return out;
}

export function scanDir(root: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('lss-')) walk(full);
        continue;
      }
      if (!e.isFile() || SKIP_FILES.has(e.name) || BINARY.test(e.name) || statSync(full).size > 5_000_000) continue;
      const buf = readFileSync(full);
      if (buf.subarray(0, 8000).includes(0)) continue; // binary
      findings.push(...scanText(buf.toString('utf8'), path.relative(root, full)));
    }
  };
  walk(root);
  return findings;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const root = path.resolve(process.argv[2] ?? '.');
  const found = scanDir(root);
  if (found.length) {
    console.error(`✗ 发现 ${found.length} 处疑似密钥：`);
    for (const f of found) console.error(`  ${f.file}:${f.line}  ${f.pattern}  ${f.preview}`);
    console.error('\n请删除后改用环境变量配置；确属测试样例的行可加注释 secret-scan:allow。');
    process.exit(1);
  }
  console.log(`✓ 未发现疑似密钥（已扫描 ${root}，含 dist/ 构建产物）。`);
}
