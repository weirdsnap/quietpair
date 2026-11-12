/**
 * lineDiff 的单元测试：前后缀夹逼的正确性。
 * 它是 confirmFix 复审 prompt「变更集线索」的数据源——报告给模型的变化区域必须真实，
 * 边界（空/单行/全重写）必须钉死。
 */
import { describe, it, expect } from 'vitest';
import { lineDiff } from '../../src/core/lineDiff';

function lines(n: number, prefix = 'L'): string {
  return Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`).join('\n');
}

describe('lineDiff', () => {
  it('完全一致返回 null', () => {
    expect(lineDiff('a\nb\nc', 'a\nb\nc')).toBeNull();
  });

  it('中间改一行：前后缀正确夹住', () => {
    const d = lineDiff(lines(10), lines(10).replace('L5', 'CHANGED'))!;
    expect(d.prefixLines).toBe(4);
    expect(d.suffixLines).toBe(5);
    expect(d.oldLineCount).toBe(10);
    expect(d.newLineCount).toBe(10);
  });

  it('开头插入：prefix 为 0，suffix 保住', () => {
    const d = lineDiff(lines(5), 'NEW\n' + lines(5))!;
    expect(d.prefixLines).toBe(0);
    expect(d.suffixLines).toBe(5);
    expect(d.newLineCount).toBe(6);
  });

  it('结尾追加：suffix 为 0', () => {
    const d = lineDiff(lines(5), lines(5) + '\nNEW')!;
    expect(d.prefixLines).toBe(5);
    expect(d.suffixLines).toBe(0);
  });

  it('多处编辑夹成一个大区（保守方向）', () => {
    const old = lines(10);
    const next = old.replace('L2', 'A').replace('L9', 'B');
    const d = lineDiff(old, next)!;
    expect(d.prefixLines).toBe(1); // 只有 L1 确定未变
    expect(d.suffixLines).toBe(1); // 只有 L10 确定未变
  });

  it('全部重写：前后缀都是 0', () => {
    const d = lineDiff(lines(5), 'x\ny\nz')!;
    expect(d.prefixLines).toBe(0);
    expect(d.suffixLines).toBe(0);
  });
});

// 边界值分析（BVA）：空/单行这些「最小合法输入」是 diff 数学最容易出错的地方
describe('lineDiff：退化输入边界', () => {
  it('空文本 vs 非空（注意空串 split 得到单元素数组，空文本按 1 行计）', () => {
    const d = lineDiff('', 'a')!;
    expect(d).toMatchObject({ prefixLines: 0, suffixLines: 0, oldLineCount: 1, newLineCount: 1 });
  });

  it('非空 vs 空', () => {
    const d = lineDiff('a', '')!;
    expect(d).toMatchObject({ prefixLines: 0, suffixLines: 0, oldLineCount: 1, newLineCount: 1 });
  });

  it('单行变化：前后缀都是 0', () => {
    const d = lineDiff('a', 'b')!;
    expect(d).toMatchObject({ prefixLines: 0, suffixLines: 0 });
  });

  it('单行一致 → null（不是 0 前缀 0 后缀的 diff）', () => {
    expect(lineDiff('a', 'a')).toBeNull();
  });

  it('首行变化：prefix=0，suffix 覆盖其余', () => {
    const d = lineDiff(lines(5), lines(5).replace('L1', 'X'))!;
    expect(d.prefixLines).toBe(0);
    expect(d.suffixLines).toBe(4);
  });
});
