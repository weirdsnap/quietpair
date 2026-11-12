/**
 * anchor.ts 的测试：双档匹配与锚构建是「确认修复说真话」的物理基础。
 * 方法学：等价类（exact/normalized/不出现/多处出现）+ 边界值（首行/末行/越界行号/空 quote）。
 */
import { describe, it, expect } from 'vitest';
import { findQuote, extractQuoteAroundLine, buildAnchor, countQuoteLines, normalizeLines } from '../../src/core/anchor';

const CODE = [
  'function add(a, b) {', // 1
  '  return a + b;', // 2
  '}', // 3
  '', // 4
  'function sub(a, b) {', // 5
  '  return a - b;', // 6
  '}', // 7
].join('\n');

describe('findQuote：双档匹配', () => {
  it('exact 档：逐字节命中，返回 1-based 起始行', () => {
    const m = findQuote(CODE, 'function add(a, b) {\n  return a + b;\n}');
    expect(m).toEqual({ lines: [1], tier: 'exact' });
  });

  it('normalized 档：缩进被重排也能命中，tier 记为 normalized', () => {
    // 模型把缩进从 2 空格改成 4 空格（最常见的照抄偏差）
    const m = findQuote(CODE, 'function add(a, b) {\n    return a + b;\n}');
    expect(m).toEqual({ lines: [1], tier: 'normalized' });
  });

  it('多处出现：全部位置都记录（任一存活即存活）', () => {
    const m = findQuote(CODE, '}');
    expect(m?.lines).toEqual([3, 7]);
  });

  it('找不到返回 null（只陈述「文本变了」，不做裁决）', () => {
    expect(findQuote(CODE, 'return a * b;')).toBeNull();
  });

  it('文件内移动免费：片段挪到别处，新位置直接找到', () => {
    const moved = ['// 前面插了十行', '', '', '', '', '', '', '', '', '', '', ...CODE.split('\n')].join('\n');
    const m = findQuote(moved, 'function add(a, b) {\n  return a + b;\n}');
    expect(m).toEqual({ lines: [12], tier: 'exact' });
  });

  it('quote 头尾的空白行先剥掉再匹配（模型常多带）', () => {
    const m = findQuote(CODE, '\n  return a + b;\n\n');
    expect(m).toEqual({ lines: [2], tier: 'exact' });
  });

  it('空 quote / 纯空白 quote 返回 null', () => {
    expect(findQuote(CODE, '')).toBeNull();
    expect(findQuote(CODE, '   \n  ')).toBeNull();
  });

  it('CRLF 内容也能匹配 LF 的 quote（归一化换行）', () => {
    const crlf = CODE.replace(/\n/g, '\r\n');
    expect(findQuote(crlf, 'return a + b;')?.lines).toEqual([2]);
  });

  it('行边界对齐：单行 quote 不命中其他行的中间位置（回归：substring 误报行号）', () => {
    const code = ['x}', '  }', '}'].join('\n');
    // quote `}` 是第 1/2 行的子串但不是整行——只有第 3 行是行边界对齐的合法命中
    expect(findQuote(code, '}')?.lines).toEqual([3]);
  });
});

describe('extractQuoteAroundLine：弱锚取材', () => {
  it('以行为中心截取 ±2 行', () => {
    expect(extractQuoteAroundLine(CODE, 5)).toBe('}\n\nfunction sub(a, b) {\n  return a - b;\n}');
  });

  it('首行附近越界收敛（不从负数行开始）', () => {
    expect(extractQuoteAroundLine(CODE, 1)).toBe('function add(a, b) {\n  return a + b;\n}');
  });

  it('末行附近越界收敛', () => {
    expect(extractQuoteAroundLine(CODE, 7)).toBe('function sub(a, b) {\n  return a - b;\n}');
  });

  it('行号越界返回 undefined', () => {
    expect(extractQuoteAroundLine(CODE, 0)).toBeUndefined();
    expect(extractQuoteAroundLine(CODE, 99)).toBeUndefined();
  });
});

describe('buildAnchor：强弱锚分级', () => {
  it('quote 校验通过 → 强锚，带出现位置和命中档位', () => {
    const a = buildAnchor('  return a + b;', 2, CODE);
    expect(a).toEqual({ quote: '  return a + b;', strength: 'strong', lines: [2], tier: 'exact' });
  });

  it('quote 校验失败 → 降级为行号截取的弱锚（不丢弃建议）', () => {
    const a = buildAnchor('return a + b  // 模型转述了', 2, CODE);
    expect(a?.strength).toBe('weak');
    expect(a?.quote).toContain('return a + b;');
    expect(a?.lines).toEqual([1]); // 窗口从 line-2 收敛到 1
  });

  it('没有 quote → 有行号则弱锚兜底', () => {
    const a = buildAnchor(undefined, 6, CODE);
    expect(a?.strength).toBe('weak');
    expect(a?.quote).toContain('return a - b;');
  });

  it('quote 没有 + 行号也没有 → 无锚（走诚实的不确定三态）', () => {
    expect(buildAnchor(undefined, undefined, CODE)).toBeUndefined();
  });

  it('行号越界且 quote 不中 → 无锚', () => {
    expect(buildAnchor(undefined, 99, CODE)).toBeUndefined();
  });
});

describe('countQuoteLines / normalizeLines', () => {
  it('行数按换行计数', () => {
    expect(countQuoteLines('a\nb\nc')).toBe(3);
    expect(countQuoteLines('a')).toBe(1);
  });

  it('归一化幂等：normalize(normalize(x)) === normalize(x)', () => {
    const once = normalizeLines('  a \n\tb\t ');
    expect(normalizeLines(once.join('\n'))).toEqual(once);
  });
});
