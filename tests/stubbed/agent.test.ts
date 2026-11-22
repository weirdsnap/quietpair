/**
 * runAgent 的测试：核心是 history 结构不变量——任何退出路径下，
 * assistant 消息里的每个 tool_call 都必须有对应 tool_call_id 的 tool 消息，
 * 否则下一轮请求会被 OpenAI 兼容 API 整个拒绝（P1-1 回归门禁）。
 * chatCompletion 经 vi.mock 替换；vscode 由 vitest alias 指向 tests/vscode-stub.ts。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { setWorkspaceRoot } from '../vscode-stub';
import type { ChatMessage } from '../../src/core/llm';

vi.mock('../../src/core/llm', () => ({
  chatCompletion: vi.fn(),
}));

import { chatCompletion } from '../../src/core/llm';
import { runAgent } from '../../src/agent/agent';

const mockCompletion = vi.mocked(chatCompletion);

let tmpWs: string;

beforeAll(() => {
  tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), 'vsagent-agent-test-'));
  fs.writeFileSync(path.join(tmpWs, 'hello.ts'), 'export const hi = 1;\n');
  setWorkspaceRoot(tmpWs);
});

afterAll(() => {
  fs.rmSync(tmpWs, { recursive: true, force: true });
});

/** 不变量断言：history 里每个 tool_call 都有匹配的 tool 响应 */
function expectHistoryIntegrity(history: ChatMessage[]): void {
  const callIds: string[] = [];
  const answered = new Set<string>();
  for (const m of history) {
    for (const tc of m.tool_calls ?? []) {
      callIds.push(tc.id);
    }
    if (m.role === 'tool' && m.tool_call_id) {
      answered.add(m.tool_call_id);
    }
  }
  const orphan = callIds.filter((id) => !answered.has(id));
  expect(orphan).toEqual([]);
}

function noopEvents(overrides: Partial<Parameters<typeof runAgent>[3]> = {}) {
  return {
    onToken: () => {},
    onToolStart: () => {},
    onToolResult: () => {},
    onDone: () => {},
    onAborted: () => {},
    onError: () => {},
    ...overrides,
  };
}

// 一轮返回两组工具调用：read_file（可并行组）+ write_file（串行组）
const TWO_GROUP_CALLS = [
  { id: 'call-1', name: 'read_file', arguments: JSON.stringify({ path: 'hello.ts' }) },
  { id: 'call-2', name: 'write_file', arguments: JSON.stringify({ path: 'x.ts', content: 'y' }) },
];

describe('runAgent：打断时 history 结构完整（P1-1）', () => {
  it('组间打断：未执行的 tool_calls 补占位 tool 消息', async () => {
    mockCompletion.mockResolvedValueOnce({ content: '', toolCalls: TWO_GROUP_CALLS });
    const abort = new AbortController();
    const history: ChatMessage[] = [{ role: 'system', content: 'sys' }];
    let aborted = false;
    const events = noopEvents({
      // 第一组结果回来时打断 → 第二组（write_file）还没执行
      onToolResult: () => abort.abort(),
      onAborted: () => { aborted = true; },
    });
    await runAgent('干活', history, { baseUrl: 'http://x', apiKey: 'k', model: 'm', signal: abort.signal }, events, {
      requestApproval: async () => true,
    });
    expect(aborted).toBe(true);
    // write_file 没被执行
    expect(fs.existsSync(path.join(tmpWs, 'x.ts'))).toBe(false);
    // 关键不变量：history 里没有孤儿 tool_calls
    expectHistoryIntegrity(history);
    const placeholder = history.find((m) => m.role === 'tool' && m.tool_call_id === 'call-2');
    expect(String(placeholder?.content)).toMatch(/interrupt/i);
  });

  it('任何一组都还没执行就打断：全部 tool_calls 都有占位响应', async () => {
    mockCompletion.mockImplementationOnce(({ signal }) => {
      // 模拟「响应刚收完、工具还没开始跑」用户就按了打断
      const controller = new AbortController();
      void signal;
      controller.abort();
      return Promise.resolve({ content: '', toolCalls: TWO_GROUP_CALLS, aborted: true });
    });
    // result.aborted 路径（83 行）只留 content 不留 tool_calls，本就该完整
    const history: ChatMessage[] = [{ role: 'system', content: 'sys' }];
    await runAgent('干活', history, { baseUrl: 'http://x', apiKey: 'k', model: 'm' }, noopEvents(), {});
    expectHistoryIntegrity(history);
  });
});

describe('runAgent：正常路径', () => {
  it('两组工具都执行后回答完成', async () => {
    mockCompletion
      .mockResolvedValueOnce({ content: '', toolCalls: TWO_GROUP_CALLS })
      .mockResolvedValueOnce({ content: '都搞定了', toolCalls: [] });
    const history: ChatMessage[] = [{ role: 'system', content: 'sys' }];
    let done = false;
    const order: string[] = [];
    const events = noopEvents({
      onToolStart: (name) => order.push(`start:${name}`),
      onDone: () => { done = true; },
    });
    await runAgent('干活', history, { baseUrl: 'http://x', apiKey: 'k', model: 'm' }, events, {
      requestApproval: async () => true,
    });
    expect(done).toBe(true);
    expect(order).toEqual(['start:read_file', 'start:write_file']);
    expect(fs.readFileSync(path.join(tmpWs, 'x.ts'), 'utf8')).toBe('y');
    expectHistoryIntegrity(history);
    expect(history.at(-1)?.content).toBe('都搞定了');
  });
});
