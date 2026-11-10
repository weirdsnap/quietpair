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

// 边界值分析（BVA）：空/单行/零 margin 这些「最小合法输入」是 diff 数学最容易出错的地方
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
    expect(isLineOutsideEdits(1, d)).toBe(false); // 唯一的行就在编辑区里
  });

  it('单行一致 → null（不是 0 前缀 0 后缀的 diff）', () => {
    expect(lineDiff('a', 'a')).toBeNull();
  });

  it('首行变化：prefix=0 时没有任何前缀行能豁免；suffix 侧按 margin 正常计算', () => {
    const d = lineDiff(lines(5), lines(5).replace('L1', 'X'))!;
    expect(d.prefixLines).toBe(0);
    expect(isLineOutsideEdits(1, d)).toBe(false); // 变化行本身
    expect(isLineOutsideEdits(4, d)).toBe(false); // 4 > 5-4+3=4 不成立：margin 内
    expect(isLineOutsideEdits(5, d)).toBe(true); // 5 > 4：margin 外的最后一行
  });
});

describe('isLineOutsideEdits：margin=0 的精确边界', () => {
  // 10 行文件，L5 改了：prefix=4，suffix=5
  const d = lineDiff(lines(10), lines(10).replace('L5', 'CHANGED'))!;

  it('margin=0：prefixLines 本身仍算未变，+1 即否', () => {
    expect(isLineOutsideEdits(4, d, 0)).toBe(true); // 4 <= 4-0
    expect(isLineOutsideEdits(5, d, 0)).toBe(false);
  });

  it('margin=0：suffix 侧 oldCount-suffix+1 仍算未变，-1 即否', () => {
    expect(isLineOutsideEdits(6, d, 0)).toBe(true); // 6 > 10-5+0
    expect(isLineOutsideEdits(5, d, 0)).toBe(false);
  });
});
