/**
 * sendQueue.ts 的测试：发言串行化是「用户消息不丢」的最后一道闸门。
 * 钉死的口径：顺序消费不并发、运行中入队必触发打断、压缩期消息等待而非丢弃、
 * 显式丢弃必须交出原文、单条坏消息不拖垮泵。
 */
import { describe, it, expect } from 'vitest';
import { SendQueue, SendQueueHooks } from '../../src/core/sendQueue';

// 可手动放行的 Promise，用来精确控制 consume / 压缩的完成时机
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

function makeHooks(overrides: Partial<SendQueueHooks> = {}) {
  const consumed: string[] = [];
  const errors: unknown[] = [];
  let running = false;
  let interruptCount = 0;
  const hooks: SendQueueHooks = {
    consume: async (text) => {
      consumed.push(text);
    },
    isRunning: () => running,
    interrupt: () => {
      interruptCount++;
    },
    waitWhileCompacting: () => Promise.resolve(),
    onError: (err) => errors.push(err),
    ...overrides,
  };
  return {
    hooks,
    consumed,
    errors,
    setRunning: (v: boolean) => (running = v),
    interruptCount: () => interruptCount,
  };
}

// 等队列泵排空（consume 都是同步 resolve 时，几轮微任务足够）
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
}

describe('SendQueue：发言串行化', () => {
  it('多条消息按序消费，且不并发（同一时刻最多一个在跑）', async () => {
    const gate = deferred();
    let active = 0;
    let maxActive = 0;
    const { hooks, consumed } = makeHooks({
      consume: async (text) => {
        active++;
        maxActive = Math.max(maxActive, active);
        await gate.promise;
        active--;
        hooksConsumed.push(text);
      },
    });
    const hooksConsumed: string[] = [];
    const q = new SendQueue(hooks);

    q.enqueue('A');
    q.enqueue('B');
    q.enqueue('C');
    await flush(); // 泵已启动，A 卡在 gate 上
    expect(maxActive).toBe(1); // B/C 没有趁 A 未完成挤进来
    gate.resolve();
    await flush();
    expect(hooksConsumed).toEqual(['A', 'B', 'C']);
    expect(consumed).toEqual([]); // consume 被覆盖，默认收集器不应有内容
  });

  it('运行中入队触发打断；空闲时入队不打断', async () => {
    const { hooks, setRunning, interruptCount } = makeHooks();
    const q = new SendQueue(hooks);

    q.enqueue('第一条');
    expect(interruptCount()).toBe(0);

    setRunning(true);
    q.enqueue('第二条');
    expect(interruptCount()).toBe(1);
    await flush();
  });

  it('压缩期间消息留在队里等待，压缩放行后才消费（不丢弃）', async () => {
    const compaction = deferred();
    let compacting = true;
    const { hooks, consumed } = makeHooks({
      waitWhileCompacting: () => (compacting ? compaction.promise : Promise.resolve()),
    });
    const q = new SendQueue(hooks);

    q.enqueue('压缩时发的消息');
    await flush();
    expect(consumed).toEqual([]); // 还在等，但消息没丢
    expect(q.pendingCount).toBe(1);

    compacting = false;
    compaction.resolve();
    await flush();
    expect(consumed).toEqual(['压缩时发的消息']);
  });

  it('压缩等待期间 discardAll：消息不消费，原文全数交出', async () => {
    const compaction = deferred();
    const { hooks, consumed } = makeHooks({
      waitWhileCompacting: () => compaction.promise,
    });
    const q = new SendQueue(hooks);

    q.enqueue('消息甲');
    q.enqueue('消息乙');
    await flush();
    const discarded = q.discardAll();
    expect(discarded).toEqual(['消息甲', '消息乙']);

    compaction.resolve();
    await flush();
    expect(consumed).toEqual([]); // 放行后泵发现队列已空，不消费
    expect(q.pendingCount).toBe(0);
  });

  it('consume 抛错：onError 记录，后续消息照常消费（泵不死）', async () => {
    const { hooks, consumed, errors } = makeHooks({
      consume: async (text) => {
        if (text === '坏消息') {
          throw new Error('boom');
        }
        consumed.push(text);
      },
    });
    const q = new SendQueue(hooks);

    q.enqueue('好消息1');
    q.enqueue('坏消息');
    q.enqueue('好消息2');
    await flush();

    expect(errors).toHaveLength(1);
    expect(consumed).toEqual(['好消息1', '好消息2']);
  });
});
