/**
 * EditTracker 的单元测试：时间戳记录与「打出之后哪些文件动过」的查询语义。
 * 这是 confirmGate 诚实化的数据源，边界（except、容量封顶）必须钉死。
 */
import { describe, it, expect } from 'vitest';
import { EditTracker } from '../src/core/editTracker';

describe('EditTracker', () => {
  it('记录后可查：ts 之后编辑过 → true，之前 → false', () => {
    const t = new EditTracker();
    t.recordEdit('a.ts', 100);
    expect(t.editedAfter('a.ts', 50)).toBe(true);
    expect(t.editedAfter('a.ts', 100)).toBe(false); // 严格大于：同一时刻不算「之后」
    expect(t.editedAfter('a.ts', 150)).toBe(false);
    expect(t.editedAfter('b.ts', 50)).toBe(false); // 没记录过的文件
  });

  it('重复记录以最后一次为准', () => {
    const t = new EditTracker();
    t.recordEdit('a.ts', 100);
    t.recordEdit('a.ts', 200);
    expect(t.editedAfter('a.ts', 150)).toBe(true);
    expect(t.editedAfter('a.ts', 250)).toBe(false);
  });

  it('filesEditedAfter：过滤时间、排除自身', () => {
    const t = new EditTracker();
    t.recordEdit('a.ts', 100);
    t.recordEdit('b.ts', 200);
    t.recordEdit('c.ts', 300);
    expect(t.filesEditedAfter(150).sort()).toEqual(['b.ts', 'c.ts']);
    expect(t.filesEditedAfter(150, 'b.ts')).toEqual(['c.ts']);
    expect(t.filesEditedAfter(400)).toEqual([]);
  });

  it('容量封顶：超出后最旧的一半被裁掉，最新的保留', () => {
    const t = new EditTracker();
    for (let i = 0; i < 1100; i++) {
      t.recordEdit(`f${i}.ts`, i);
    }
    expect(t.size).toBeLessThanOrEqual(1001); // 封顶触发时砍一半 + 当次插入
    expect(t.editedAfter('f1099.ts', 0)).toBe(true); // 最新的还在
    expect(t.editedAfter('f0.ts', 0)).toBe(false); // 最旧的被裁
  });
});
