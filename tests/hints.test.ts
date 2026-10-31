import { describe, expect, it } from 'vitest';
import { PLACEHOLDER_MAX, splitHint } from '../shared/hints';

describe('input hints (placeholder vs. help text)', () => {
  it('keeps a short leading example as placeholder and moves the rest below the box', () => {
    expect(splitHint('如 新加坡 / SG。留空则按规则包法域推定，结果会标注“假设”')).toEqual({ placeholder: '如 新加坡 / SG', help: '留空则按规则包法域推定，结果会标注“假设”' });
  });
  it('uses a short description as the placeholder only', () => {
    expect(splitHint('如 EDM、Instagram、短信、海报')).toEqual({ placeholder: '如 EDM、Instagram、短信、海报' });
  });
  it('never puts a long description into the placeholder', () => {
    const long = '这是一个很长的说明，没有句号分隔，因此应当完整显示在输入框下方，而不是被截断在输入框里面';
    expect(splitHint(long)).toEqual({ help: long });
    for (const d of [long, '甲'.repeat(60) + '。乙', '如 x。' + 'y'.repeat(80)]) {
      expect((splitHint(d).placeholder ?? '').length).toBeLessThanOrEqual(PLACEHOLDER_MAX);
    }
  });
  it('shows the default value as placeholder and keeps the description as help', () => {
    expect(splitHint('报告使用的语言', '简体中文')).toEqual({ placeholder: '默认：简体中文', help: '报告使用的语言' });
    expect(splitHint(undefined, '简体中文')).toEqual({ placeholder: '默认：简体中文', help: undefined });
    expect(splitHint('  ')).toEqual({});
  });
});
