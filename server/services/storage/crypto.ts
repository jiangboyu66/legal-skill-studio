import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { AppError } from '../../errors';

const PREFIX = 'enc:v1:';
const MAGIC = Buffer.from('LSSENC1\0', 'latin1');

/**
 * Encryption at rest for materials and run records (AES-256-GCM, random 96-bit IV per value).
 * The key comes from DATA_ENCRYPTION_KEY (32 bytes, base64 or hex) and is never stored with the data.
 * Values written before a key was configured stay readable (no prefix / magic → plaintext).
 */
export class DataCipher {
  private constructor(private key: Buffer) {}

  static parseKey(raw: string): Buffer {
    const s = raw.trim();
    const buf = /^[0-9a-f]{64}$/i.test(s) ? Buffer.from(s, 'hex') : Buffer.from(s, 'base64');
    if (buf.length !== 32) {
      throw new AppError('CONFIG_INVALID', 'DATA_ENCRYPTION_KEY 必须是 32 字节密钥（64 位十六进制或 base64）。', {
        hint: '生成方法：node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"',
      });
    }
    return buf;
  }

  static fromKey(raw?: string): DataCipher | undefined {
    return raw?.trim() ? new DataCipher(DataCipher.parseKey(raw)) : undefined;
  }

  static isEncryptedString(s: string): boolean {
    return s.startsWith(PREFIX);
  }

  static isEncryptedBuffer(b: Buffer): boolean {
    return b.length >= MAGIC.length && b.subarray(0, MAGIC.length).equals(MAGIC);
  }

  private seal(plain: Buffer): Buffer {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([c.update(plain), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), ct]);
  }

  private open(sealed: Buffer): Buffer {
    const iv = sealed.subarray(0, 12);
    const tag = sealed.subarray(12, 28);
    const d = createDecipheriv('aes-256-gcm', this.key, iv);
    d.setAuthTag(tag);
    try {
      return Buffer.concat([d.update(sealed.subarray(28)), d.final()]);
    } catch {
      throw new AppError('DATA_KEY_MISMATCH', '无法解密已加密的数据：DATA_ENCRYPTION_KEY 与加密时使用的密钥不一致。', { hint: '请恢复原来的密钥；密钥丢失时已加密的数据无法恢复。' });
    }
  }

  encryptString(s: string): string {
    return PREFIX + this.seal(Buffer.from(s, 'utf8')).toString('base64');
  }

  decryptString(s: string): string {
    return s.startsWith(PREFIX) ? this.open(Buffer.from(s.slice(PREFIX.length), 'base64')).toString('utf8') : s;
  }

  encryptBuffer(b: Buffer): Buffer {
    return Buffer.concat([MAGIC, this.seal(b)]);
  }

  decryptBuffer(b: Buffer): Buffer {
    return DataCipher.isEncryptedBuffer(b) ? this.open(b.subarray(MAGIC.length)) : b;
  }
}

export function keyMissingError() {
  return new AppError('DATA_KEY_MISSING', '数据已加密，但未配置 DATA_ENCRYPTION_KEY。', { hint: '请在环境变量中设置加密时使用的同一个密钥后重启服务。' });
}
