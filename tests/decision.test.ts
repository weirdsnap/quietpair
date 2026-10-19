/**
 * decision.ts 开口决策层的单元测试：纯函数，七个判定分支全部锁死。
 * 这是「什么时候开口」的唯一权威，行为漂移必须在这里炸出来。
 */
import { describe, it, expect } from 'vitest';
import { decideSpeak, SpeakContext } from '../src/companion/decision';

const OPTS = { busyRetryMs: 10000, settleRetryMs: 3000 };

function ctx(overrides: Partial<SpeakContext> = {}): SpeakContext {
  return {
    enabled: true,
    chatBusy: false,
    contentChanged: true,
    settled: true,
    settleRetries: 0,
    maxSettleRetries: 3,
    cooldownWaitMs: 0,
    ...overrides,
  };
}

describe('decideSpeak：三值开口判定', () => {
  it('一切就绪 → speak', () => {
    const d = decideSpeak(ctx(), OPTS);
    expect(d.verdict).toBe('speak');
    expect(d.reason).toBe('settled');
  });

  it('守望关闭 → suppress/disabled', () => {
    const d = decideSpeak(ctx({ enabled: false }), OPTS);
    expect(d.verdict).toBe('suppress');
    expect(d.reason).toBe('disabled');
  });

  it('聊天 Agent 在跑 → delay/chat-busy（推迟而非取消）', () => {
    const d = decideSpeak(ctx({ chatBusy: true }), OPTS);
    expect(d.verdict).toBe('delay');
    expect(d.reason).toBe('chat-busy');
    expect(d.retryMs).toBe(OPTS.busyRetryMs);
  });

  it('内容没变化 → suppress/unchanged（不重复开口）', () => {
    const d = decideSpeak(ctx({ contentChanged: false }), OPTS);
    expect(d.verdict).toBe('suppress');
    expect(d.reason).toBe('unchanged');
  });

  it('冷却期 → delay/cooldown，等待时长透传', () => {
    const d = decideSpeak(ctx({ cooldownWaitMs: 42000 }), OPTS);
    expect(d.verdict).toBe('delay');
    expect(d.reason).toBe('cooldown');
    expect(d.retryMs).toBe(42000);
  });

  it('写到一半 → delay/not-settled，重试次数+1 由编排层负责', () => {
    const d = decideSpeak(ctx({ settled: false, settleRetries: 1 }), OPTS);
    expect(d.verdict).toBe('delay');
    expect(d.reason).toBe('not-settled');
    expect(d.retryMs).toBe(OPTS.settleRetryMs);
  });

  it('重试到顶仍没收笔 → suppress/not-settled-giveup（不纠缠可能在想的人）', () => {
    const d = decideSpeak(ctx({ settled: false, settleRetries: 3 }), OPTS);
    expect(d.verdict).toBe('suppress');
    expect(d.reason).toBe('not-settled-giveup');
  });
});

describe('decideSpeak：优先级顺序（先拦安静的，再算要等多久）', () => {
  it('disabled 优先于一切', () => {
    const d = decideSpeak(ctx({ enabled: false, chatBusy: true, contentChanged: false }), OPTS);
    expect(d.reason).toBe('disabled');
  });

  it('chat-busy 优先于 unchanged（Agent 干完活的现场值得看）', () => {
    const d = decideSpeak(ctx({ chatBusy: true, contentChanged: false }), OPTS);
    expect(d.reason).toBe('chat-busy');
  });

  it('unchanged 优先于 cooldown（没变就不必等冷却）', () => {
    const d = decideSpeak(ctx({ contentChanged: false, cooldownWaitMs: 5000 }), OPTS);
    expect(d.reason).toBe('unchanged');
  });

  it('cooldown 优先于 not-settled（冷却未到，不消耗收笔重试次数）', () => {
    const d = decideSpeak(ctx({ cooldownWaitMs: 5000, settled: false }), OPTS);
    expect(d.reason).toBe('cooldown');
  });
});
