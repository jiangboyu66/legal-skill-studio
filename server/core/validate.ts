import Ajv, { type ErrorObject, type ValidateFunction } from 'ajv';
import { buildOutputSchema } from '../../shared/schema';
import type { OutputField } from '../../shared/types';

const ajv = new Ajv({ allErrors: true, strict: false, coerceTypes: true });
const cache = new Map<string, ValidateFunction>();

function compile(fields: OutputField[]): ValidateFunction {
  const schema = buildOutputSchema(fields);
  const key = JSON.stringify(schema);
  let fn = cache.get(key);
  if (!fn) {
    fn = ajv.compile(schema);
    cache.set(key, fn);
  }
  return fn;
}

/** Tolerant normalisation before validation: enum case, single value where a list is expected. */
function coerce(fields: OutputField[], obj: Record<string, unknown>) {
  for (const f of fields) {
    const v = obj[f.key];
    if (v === undefined || v === null) continue;
    if (f.type === 'enum' && typeof v === 'string') {
      const match = (f.options ?? []).find((o) => o.toLowerCase() === v.trim().toLowerCase());
      if (match) obj[f.key] = match;
    } else if (f.type === 'string_list' && typeof v === 'string') {
      obj[f.key] = [v];
    } else if (f.type === 'object_list') {
      const list = Array.isArray(v) ? v : typeof v === 'object' ? [v] : v;
      if (Array.isArray(list)) {
        obj[f.key] = list;
        for (const item of list) {
          if (item && typeof item === 'object') coerce(f.fields ?? [], item as Record<string, unknown>);
        }
      }
    }
  }
}

function describe(e: ErrorObject): string {
  const where = e.instancePath ? e.instancePath.replace(/^\//, '').replace(/\//g, '.') : '(根对象)';
  switch (e.keyword) {
    case 'required':
      return `缺少必填字段：${e.instancePath ? `${where}.` : ''}${(e.params as { missingProperty: string }).missingProperty}`;
    case 'enum':
      return `${where} 的值必须是以下之一：${((e.params as { allowedValues: string[] }).allowedValues ?? []).join(' / ')}`;
    case 'type':
      return `${where} 的类型应为 ${(e.params as { type: string }).type}`;
    default:
      return `${where} ${e.message ?? '不符合要求'}`;
  }
}

export function validateOutput(
  fields: OutputField[],
  value: Record<string, unknown>,
): { value: Record<string, unknown>; errors: string[] } {
  const copy = structuredClone(value);
  coerce(fields, copy);
  const fn = compile(fields);
  const ok = fn(copy);
  const errors = ok ? [] : [...new Set((fn.errors ?? []).map(describe))].slice(0, 12);
  return { value: copy, errors };
}
