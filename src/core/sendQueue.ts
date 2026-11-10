/**
 * 发言串行队列：所有进 handleSend 的入口（用户输入、守望回灌、init 剧本）统一经这里，
 * 单消费者 pump 依次执行——否则运行中连发两条会并发进 handleSend，
 * currentAbort 互相覆盖（停止按钮失灵）、共享 history 被两个 run 同时写。
 *
 * 打断语义在入队时表达：正在跑就叫停当前轮，pump 收尾后立刻接下一条；
 * 压缩（compacting）期间消息留在队里等，不再直接丢弃用户输入。
 */
export interface SendQueueHooks {
  consume: (text: string) => Promise<void>;
  isRunning: () => boolean;
  interrupt: () => void;
  waitWhileCompacting: () => Promise<void>;
  onError?: (err: unknown) => void;
}

export class SendQueue {
  private queue: string[] = [];
  private pumping = false;

  constructor(private readonly hooks: SendQueueHooks) {}

  enqueue(text: string): void {
    this.queue.push(text);
    if (this.hooks.isRunning()) {
      this.hooks.interrupt();
    }
    void this.pump();
  }

  // 显式停止/清空会话时丢弃排队消息；返回原文，调用方必须如实告知用户（不静默吞）
  discardAll(): string[] {
    return this.queue.splice(0, this.queue.length);
  }

  get pendingCount(): number {
    return this.queue.length;
  }

  private async pump(): Promise<void> {
    if (this.pumping) {
      return;
    }
    this.pumping = true;
    try {
      while (this.queue.length > 0) {
        await this.hooks.waitWhileCompacting();
        const text = this.queue.shift();
        if (text === undefined) {
          continue; // 压缩等待期间被 discardAll 清空
        }
        try {
          await this.hooks.consume(text);
        } catch (err) {
          // 一条坏消息不拖垮整个泵：记下来的同时继续消费后续
          this.hooks.onError?.(err);
        }
      }
    } finally {
      this.pumping = false;
    }
  }
}
