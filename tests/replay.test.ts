/**
 * 会话回放映射（historyToReplayEntries）的单元测试。
 * 钉死「回放什么」的契约：用户与助手文本要回放；压缩摘要降级为 note 卡；
 * tool 消息与纯工具调用的 assistant 不回放——回放错了就是界面在编造历史。
 */
import { describe, it, expect } from 'vitest';
import { historyToReplayEntries, SUMMARY_PREFIX } from '../src/ui/replay';
import { ChatMessage } from '../src/core/llm';

describe('historyToReplayEntries', () => {
  it('空历史与仅 system → 无条目', () => {
    expect(historyToReplayEntries([])).toEqual([]);
    expect(historyToReplayEntries([{ role: 'system', content: 'prompt' }])).toEqual([]);
  });

  it('用户与助手文本按序回放', () => {
    const history: ChatMessage[] = [
      { role: 'system', content: 'p' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: 'how?' },
    ];
    expect(historyToReplayEntries(history)).toEqual([
      { kind: 'user', text: 'hi' },
      { kind: 'assistant', text: 'hello' },
      { kind: 'user', text: 'how?' },
    ]);
  });

  it('tool 消息与纯工具调用的 assistant 不回放', () => {
    const history: ChatMessage[] = [
      { role: 'user', content: 'q' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: '1', type: 'function', function: { name: 'read_file', arguments: '{}' } }],
      } as unknown as ChatMessage,
      { role: 'tool', tool_call_id: '1', content: 'file body' } as unknown as ChatMessage,
      { role: 'assistant', content: 'answer' },
    ];
    expect(historyToReplayEntries(history)).toEqual([
      { kind: 'user', text: 'q' },
      { kind: 'assistant', text: 'answer' },
    ]);
  });

  it('空白内容消息跳过', () => {
    expect(historyToReplayEntries([{ role: 'user', content: '  ' }, { role: 'assistant', content: '' }])).toEqual([]);
  });

  it('压缩摘要降级为 note 卡，前缀剥离', () => {
    const history: ChatMessage[] = [
      { role: 'system', content: 'p' },
      { role: 'user', content: `${SUMMARY_PREFIX}\n- 决定了 X\n- 放弃了 Y` },
      { role: 'user', content: 'next question' },
    ];
    expect(historyToReplayEntries(history)).toEqual([
      { kind: 'note', title: '🗜 Earlier conversation (compacted summary)', text: '- 决定了 X\n- 放弃了 Y' },
      { kind: 'user', text: 'next question' },
    ]);
  });
});
