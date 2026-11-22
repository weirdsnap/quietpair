/**
 * ChatViewProvider 的竞态测试（P2-1 回归）：
 * 手动压缩进行中用户 Clear 会话——压缩必须被打断，绝不允许把旧对话的摘要
 * 塞回已清空的 history（「清空后旧对话复活」）。
 * chatCompletion 经 vi.mock 替换；vscode 由 vitest alias 指向 tests/vscode-stub.ts。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { setWorkspaceRoot, setWarningResponse } from '../vscode-stub';
import type { ChatMessage } from '../../src/core/llm';

vi.mock('../../src/core/llm', () => ({
  chatCompletion: vi.fn(),
}));

import { chatCompletion } from '../../src/core/llm';
import { ChatViewProvider } from '../../src/ui/chatView';
import { SharedContext } from '../../src/memory/sharedContext';
import { Logger } from '../../src/core/logger';
import { UsageTracker } from '../../src/core/usage';
import { SUMMARY_PREFIX } from '../../src/ui/replay';

const mockCompletion = vi.mocked(chatCompletion);

let tmpRoot: string;
let logger: Logger;

function memento(): { get: (k: string) => unknown; update: (k: string, v: unknown) => Promise<void> } {
  const m = new Map<string, unknown>();
  return {
    get: (k) => m.get(k),
    update: async (k, v) => {
      if (v === undefined) {
        m.delete(k);
      } else {
        m.set(k, v);
      }
    },
  };
}

function makeProvider(): ChatViewProvider {
  const context = {
    workspaceState: memento(),
    globalState: memento(),
    secrets: { get: async () => 'test-key', store: async () => {}, delete: async () => {} },
    globalStorageUri: { fsPath: tmpRoot },
    extensionUri: { fsPath: tmpRoot },
    subscriptions: [] as { dispose(): void }[],
  };
  return new ChatViewProvider(context as never, new SharedContext(), logger, new UsageTracker(context as never));
}

/** 塞入超过压缩保留线的历史（COMPACT_KEEP_RECENT = 12，需 > 14 条） */
function seedLongHistory(provider: ChatViewProvider): void {
  const history: ChatMessage[] = [{ role: 'system', content: 'sys' }];
  for (let i = 0; i < 10; i++) {
    history.push({ role: 'user', content: `第 ${i} 个问题` }, { role: 'assistant', content: `第 ${i} 个回答` });
  }
  (provider as unknown as { history: ChatMessage[] }).history = history;
}

function getHistory(provider: ChatViewProvider): ChatMessage[] {
  return (provider as unknown as { history: ChatMessage[] }).history;
}

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vsagent-chatview-test-'));
  setWorkspaceRoot(tmpRoot);
});

afterAll(() => {
  logger?.dispose();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('compactNow × clear 竞态（P2-1）', () => {
  it('压缩进行中 Clear：压缩被打断，旧摘要不得复活进已清空的 history', async () => {
    logger = new Logger({ globalStorageUri: { fsPath: tmpRoot } } as never);
    // 压缩的 LLM 调用挂起：遵守 signal（真实客户端如此），也可手动放行
    let release: ((v: { content: string; toolCalls: never[] }) => void) | undefined;
    mockCompletion.mockImplementation(({ signal }) => {
      return new Promise((resolve, reject) => {
        signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        release = resolve;
      });
    });
    setWarningResponse('Clear');

    const provider = makeProvider();
    seedLongHistory(provider);
    const compacting = provider.compactNow();
    // 等压缩真正开始（LLM 调用已发出）
    await vi.waitFor(() => expect(mockCompletion).toHaveBeenCalled());

    await provider.clear(); // 修复后：clear 会打断压缩并等它收尾
    release?.({ content: '{"summary":"旧对话摘要","memory":[]}', toolCalls: [] });
    await compacting;

    const history = getHistory(provider);
    expect(history).toHaveLength(1); // 只剩 system
    expect(history.some((m) => typeof m.content === 'string' && m.content.startsWith(SUMMARY_PREFIX))).toBe(false);
  });
});
