import type { Jurisdiction, RunWarning } from '../../shared/types';

/**
 * Applicable law is an explicit run input. When the user does not choose one, the run records the
 * assumption it made (from the rule packs' jurisdiction) and every result shows it as "假设".
 * A company headquartered in Singapore can still publish material governed by other laws.
 */
const ALIASES: [string, RegExp][] = [
  ['SG', /^(sg|sgp|singapore)\b|新加坡/i],
  ['MY', /^(my|mys|malaysia)\b|马来西亚/i],
  ['HK', /^(hk|hong ?kong)\b|香港/i],
  ['CN', /^(cn|prc|china|mainland china)\b|中国/i],
  ['UK', /^(uk|gb|united kingdom|england)\b|英国/i],
  ['US', /^(us|usa|united states)\b|美国/i],
  ['AU', /^(au|australia)\b|澳大利亚|澳洲/i],
  ['EU', /^(eu|european union)\b|欧盟/i],
];

const NAMES: Record<string, string> = { SG: '新加坡', MY: '马来西亚', HK: '中国香港', CN: '中国内地', UK: '英国', US: '美国', AU: '澳大利亚', EU: '欧盟' };

export function jurisdictionCode(raw?: string): string | undefined {
  const s = raw?.trim();
  if (!s) return undefined;
  return ALIASES.find(([, re]) => re.test(s))?.[0];
}

export function jurisdictionLabel(raw: string): string {
  const code = jurisdictionCode(raw);
  return code ? `${NAMES[code]}（${code}）` : raw.trim();
}

export function resolveJurisdiction(explicit: string | undefined, packJurisdictions: string[]): { jurisdiction?: Jurisdiction; warning?: RunWarning } {
  const packCodes = [...new Set(packJurisdictions.map((j) => jurisdictionCode(j) ?? j.trim()).filter(Boolean))];
  if (explicit?.trim()) {
    const code = jurisdictionCode(explicit) ?? explicit.trim();
    const jurisdiction: Jurisdiction = { value: jurisdictionLabel(explicit), assumed: false, source: '运行时由用户指定' };
    if (packCodes.length && !packCodes.includes(code)) {
      return {
        jurisdiction,
        warning: {
          code: 'JURISDICTION_MISMATCH',
          message: `所选适用法域「${jurisdiction.value}」与所用规则包的法域（${packCodes.map(jurisdictionLabel).join('、')}）不一致：规则包中的规则可能不适用于该法域，结果仅供参考，请由熟悉该法域的律师判断。`,
        },
      };
    }
    return { jurisdiction };
  }
  if (!packCodes.length) return {};
  return { jurisdiction: { value: packCodes.map(jurisdictionLabel).join('、'), assumed: true, source: '运行时未指定，按所用规则包的法域推定' } };
}

/** "适用法域：新加坡（SG）（假设）" */
export function jurisdictionText(j?: Jurisdiction): string {
  if (!j) return '适用法域：未确定';
  return `适用法域：${j.value}${j.assumed ? '（假设）' : ''}`;
}
