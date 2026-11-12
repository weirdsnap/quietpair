/**
 * confirmVerdict 的测试：复审结局（confirmed/rejected/inconclusive）的唯一权威。
 * 方法学：判定表——原建议锚形态（强锚在/强锚失/弱锚/无锚有行号/无锚无行号）
 * × 复审结果（干净/报同级且重叠/报同级不重叠/只报更低级）。
 */
import { describe, it, expect } from 'vitest';
import { judgeConfirmOutcome } from '../../src/companion/confirmVerdict';
import type { Suggestion } from '../../src/companion/annotations';

const strong = (lines: number[], quote = 'a\nb\nc'): Suggestion => ({
  level: 2,
  title: '原问题',
  detail: 'd',
  line: lines[0] + 1,
  anchor: { quote, strength: 'strong', lines, tier: 'exact' },
});

const sug = (line: number | undefined, level: 1 | 2 | 3, title = 'x', anchor?: Suggestion['anchor']): Suggestion => ({
  level,
  title,
  detail: 'd',
  line,
  anchor,
});

describe('judgeConfirmOutcome：强锚路径', () => {
  it('证据消失 + 复审干净 → confirmed', () => {
    const v = judgeConfirmOutcome({ original: strong([10]), anchorFound: false, reviewed: [] });
    expect(v.kind).toBe('confirmed');
  });

  it('证据消失 + 复审只报更低级问题 → confirmed（同级门槛）', () => {
    const v = judgeConfirmOutcome({ original: strong([10]), anchorFound: false, reviewed: [sug(20, 1)] });
    expect(v.kind).toBe('confirmed');
  });

  it('证据消失 + 复审仍报同级问题 → inconclusive（无法定位比对，不猜）', () => {
    const v = judgeConfirmOutcome({ original: strong([10]), anchorFound: false, reviewed: [sug(20, 2)] });
    expect(v.kind).toBe('inconclusive');
  });

  it('证据还在 + 复审干净 → confirmed', () => {
    const v = judgeConfirmOutcome({ original: strong([10]), anchorFound: true, anchorSpanStarts: [10], reviewed: [] });
    expect(v.kind).toBe('confirmed');
  });

  it('证据还在 + 新建议行号落在证据区间（10..12）→ rejected', () => {
    const v = judgeConfirmOutcome({ original: strong([10]), anchorFound: true, anchorSpanStarts: [10], reviewed: [sug(11, 2, '还是它')] });
    expect(v).toEqual({ kind: 'rejected', remaining: [expect.objectContaining({ title: '还是它' })] });
  });

  it('证据还在 + 新建议的行号在区间外 → confirmed', () => {
    const v = judgeConfirmOutcome({ original: strong([10]), anchorFound: true, anchorSpanStarts: [10], reviewed: [sug(30, 3, '别的事')] });
    expect(v.kind).toBe('confirmed');
  });

  it('证据还在 + 新建议自带锚且锚区间重叠 → rejected（锚优先于行号）', () => {
    const reFlagged = sug(undefined, 2, '换皮重报', { quote: 'b\nc\nd', strength: 'strong', lines: [11], tier: 'exact' });
    const v = judgeConfirmOutcome({ original: strong([10]), anchorFound: true, anchorSpanStarts: [10], reviewed: [reFlagged] });
    expect(v.kind).toBe('rejected');
  });

  it('证据区间多处出现：任一区间与新建议重叠都算', () => {
    const v = judgeConfirmOutcome({ original: strong([10, 40]), anchorFound: true, anchorSpanStarts: [10, 40], reviewed: [sug(41, 2)] });
    expect(v.kind).toBe('rejected');
  });
});

describe('judgeConfirmOutcome：弱锚/无锚路径（位置窗口旧逻辑保持）', () => {
  it('弱锚：复审 ±3 行内同级问题消失 → confirmed', () => {
    const weakSug = sug(10, 2, '原问题', { quote: 'x\ny', strength: 'weak', lines: [9], tier: 'exact' });
    const v = judgeConfirmOutcome({ original: weakSug, anchorFound: true, anchorSpanStarts: [9], reviewed: [] });
    expect(v.kind).toBe('confirmed');
  });

  it('弱锚：复审 ±3 行内仍有同级问题 → rejected', () => {
    const weakSug = sug(10, 2, '原问题', { quote: 'x\ny', strength: 'weak', lines: [9], tier: 'exact' });
    const v = judgeConfirmOutcome({ original: weakSug, anchorFound: false, reviewed: [sug(12, 2)] });
    expect(v).toEqual({ kind: 'rejected', remaining: [expect.objectContaining({ line: 12 })] });
  });

  it('无锚有行号：±3 窗口同级问题残留 → rejected', () => {
    const v = judgeConfirmOutcome({ original: sug(10, 2, '原问题'), reviewed: [sug(13, 2)] });
    expect(v.kind).toBe('rejected');
  });

  it('无锚有行号：窗口外的同级问题不算残留 → confirmed', () => {
    const v = judgeConfirmOutcome({ original: sug(10, 2, '原问题'), reviewed: [sug(20, 2)] });
    expect(v.kind).toBe('confirmed');
  });

  it('无锚无行号 + 复审干净 → confirmed（模型说文件干净就是真干净）', () => {
    const v = judgeConfirmOutcome({ original: sug(undefined, 2, '架构级问题'), reviewed: [] });
    expect(v.kind).toBe('confirmed');
  });

  it('无锚无行号 + 复审非空 → inconclusive（第三态：比对不了不猜）', () => {
    const v = judgeConfirmOutcome({ original: sug(undefined, 2, '架构级问题'), reviewed: [sug(5, 2)] });
    expect(v.kind).toBe('inconclusive');
  });
});
