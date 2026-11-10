/**
 * lineDiff 的单元测试：前后缀夹逼的正确性 + isLineOutsideEdits 的边界。
 * 这是 confirmFix 确定性豁免的数学基础，边界必须钉死。
 */
import { describe, it, expect } from 'vitest';
import { lineDiff, isLineOutsideEdits } from '../../src/core/lineDiff';

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

describe('isLineOutsideEdits（确定性豁免）', () => {
  // 10 行文件，L5 改了：未变区 = [1..4] 和 [6..10]
  const d = lineDiff(lines(10), lines(10).replace('L5', 'CHANGED'))!;

  it('远离编辑区的行判定为未变', () => {
    expect(isLineOutsideEdits(1, d)).toBe(true);
    expect(isLineOutsideEdits(10, d)).toBe(true);
  });

  it('margin 内保守：邻近编辑的行不算未变', () => {
    expect(isLineOutsideEdits(4, d)).toBe(false); // 距离变化行 1 行
    expect(isLineOutsideEdits(6, d)).toBe(false);
    expect(isLineOutsideEdits(2, d)).toBe(false); // prefixLines(4) - margin(3) = 1，L2 在 margin 内
  });

  it('margin 边界恰好在界外', () => {
    expect(isLineOutsideEdits(1, d)).toBe(true); // 1 <= 4-3
    expect(isLineOutsideEdits(9, d)).toBe(true); // 9 > 10-5+3 = 8
    expect(isLineOutsideEdits(8, d)).toBe(false);
  });
});
