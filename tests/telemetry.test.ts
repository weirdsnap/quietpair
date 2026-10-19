/**
 * telemetry.ts 的 schema 守护测试：埋点字段是离线分析的合约，
 * 改字段名/漏字段必须在这里炸出来，而不是攒了一周数据才发现是废的。
 */
import { describe, it, expect } from 'vitest';
import { Telemetry } from '../src/core/telemetry';
import type { Suggestion } from '../src/companion/annotations';

interface Captured {
  kind: string;
  name?: string;
  [k: string]: unknown;
}

function makeSink() {
  const events: Captured[] = [];
  const sink = { event: (kind: string, data: Record<string, unknown>) => events.push({ kind, ...data }) };
  return { events, sink };
}

function sug(overrides: Partial<Suggestion> = {}): Suggestion {
  return { line: 5, level: 2, title: '测试建议', detail: '细节', fix: 'x = 1', shownAt: Date.now() - 3000, ...overrides };
}

describe('Telemetry：事件 schema', () => {
  it('所有事件 kind 都是 metric 且带 name 和 summary', () => {
    const { events, sink } = makeSink();
    const t = new Telemetry(sink);
    const s = sug();
    t.suggestionShown('a.ts', [s], false);
    t.suggestionViewed(s, 'a.ts', 'codelens', { masked: false, learningMode: false });
    t.fixRevealed(s, 'a.ts', { masked: true, learningMode: true });
    t.deepenClicked(s, 'a.ts', 'explain', { masked: false, learningMode: false });
    t.suggestionAdopted(s, 'a.ts', 'confirm-verified', { masked: false, learningMode: false });
    t.suggestionRejected(s, 'a.ts', 1, { masked: false, learningMode: false });
    t.confirmUnchanged(s, 'a.ts', { masked: false, learningMode: false });
    t.suggestionDiscussed(s, 'a.ts', { masked: false, learningMode: false });
    t.suggestionStale('a.ts', 2);
    t.modeSwitched(true, 'quick-toggle');
    expect(events).toHaveLength(10);
    for (const e of events) {
      expect(e.kind).toBe('metric');
      expect(typeof e.name).toBe('string');
      expect(typeof e.summary).toBe('string');
    }
  });

  it('suggestion_shown：逐条带 level/hasFix/masked/hasReflect，masked 口径 = 学习模式且非 L3 且有 fix', () => {
    const { events, sink } = makeSink();
    const t = new Telemetry(sink);
    t.suggestionShown('a.ts', [
      sug({ level: 2 }),
      sug({ level: 3 }), // L3 豁免：不藏
      sug({ level: 1, fix: undefined }), // 没有 fix 谈不上藏
    ], true);
    const items = events[0].items as Array<{ level: number; masked: boolean; hasFix: boolean }>;
    expect(items.map((i) => i.masked)).toEqual([true, false, false]);
    expect(events[0].learningMode).toBe(true);
    expect(events[0].count).toBe(3);
  });

  it('非学习模式：任何级别都不 masked', () => {
    const { events, sink } = makeSink();
    new Telemetry(sink).suggestionShown('a.ts', [sug({ level: 1 })], false);
    const items = events[0].items as Array<{ masked: boolean }>;
    expect(items[0].masked).toBe(false);
  });

  it('单条事件带 msSinceShown（距展示时长，漏斗分析用）', () => {
    const { events, sink } = makeSink();
    new Telemetry(sink).fixRevealed(sug(), 'a.ts', { masked: true, learningMode: true });
    expect(typeof events[0].msSinceShown).toBe('number');
    expect(events[0].msSinceShown as number).toBeGreaterThanOrEqual(3000);
  });

  it('suggestion_stale：count 为 0 不落事件（编辑噪音过滤）', () => {
    const { events, sink } = makeSink();
    new Telemetry(sink).suggestionStale('a.ts', 0);
    expect(events).toHaveLength(0);
  });

  it('mode_switched 记录方向和来源', () => {
    const { events, sink } = makeSink();
    const t = new Telemetry(sink);
    t.modeSwitched(true, 'quick-toggle');
    t.modeSwitched(false, 'settings');
    expect(events[0]).toMatchObject({ name: 'mode_switched', learningMode: true, via: 'quick-toggle' });
    expect(events[1]).toMatchObject({ name: 'mode_switched', learningMode: false, via: 'settings' });
  });
});
