/**
 * Keeps hints inside an input short. A long description is shown under the field instead of as a
 * placeholder (placeholders get cut off in narrow boxes and vanish once you type). A short leading
 * example such as "如 新加坡 / SG" stays as the placeholder and the rest becomes help text.
 */
export const PLACEHOLDER_MAX = 24;

export function splitHint(description?: string, defaultValue?: string): { placeholder?: string; help?: string } {
  const d = description?.trim();
  if (defaultValue) return { placeholder: `默认：${defaultValue}`, help: d || undefined };
  if (!d) return {};
  const m = new RegExp(`^(.{1,${PLACEHOLDER_MAX}}?)[。；;]\\s*(\\S[\\s\\S]*)$`).exec(d);
  if (m) return { placeholder: m[1], help: m[2] };
  return d.length <= PLACEHOLDER_MAX ? { placeholder: d } : { help: d };
}
