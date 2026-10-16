/**
 * Token 消耗统计器。
 * 每次 LLM 调用（聊天 / 守望分析 / 压缩）返回的 usage 都累计到这里：
 * 会话级总量（内存）+ 全局累计（globalState 持久化，跨会话）。
 * 面板工具栏的小计数和 transcript 的 usage 事件都吃这份数据。
 * 注意：部分兼容网关不返回 usage，这类调用不计入（calls 里也不含）。
 */
import * as vscode from 'vscode';
import { TokenUsage } from './llm';

export type UsageSource = 'chat' | 'companion' | 'compact';

interface Bucket {
  prompt: number;
  completion: number;
  calls: number;
}

const ALL_TIME_KEY = 'vsAgent.usage.allTime';

function emptyBucket(): Bucket {
  return { prompt: 0, completion: 0, calls: 0 };
}

export class UsageTracker {
  private session = emptyBucket();
  private bySource: Record<UsageSource, Bucket> = {
    chat: emptyBucket(),
    companion: emptyBucket(),
    compact: emptyBucket(),
  };

  // 数据变化时通知（面板刷新小计数）
  onChange?: () => void;

  constructor(private readonly context: vscode.ExtensionContext) {}

  add(source: UsageSource, u: TokenUsage | undefined): void {
    if (!u) {
      return; // 网关没返回 usage，跳过
    }
    for (const bucket of [this.session, this.bySource[source]]) {
      bucket.prompt += u.promptTokens;
      bucket.completion += u.completionTokens;
      bucket.calls += 1;
    }
    const allTime = this.allTime();
    allTime.prompt += u.promptTokens;
    allTime.completion += u.completionTokens;
    allTime.calls += 1;
    void this.context.globalState.update(ALL_TIME_KEY, allTime);
    this.onChange?.();
  }

  sessionTotals(): Bucket & { total: number } {
    return { ...this.session, total: this.session.prompt + this.session.completion };
  }

  bySourceTotals(): Record<UsageSource, Bucket> {
    return this.bySource;
  }

  allTime(): Bucket {
    return this.context.globalState.get<Bucket>(ALL_TIME_KEY) ?? emptyBucket();
  }
}
