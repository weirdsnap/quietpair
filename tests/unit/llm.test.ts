/**
 * llm.ts 的 SSE 解析测试：手写解析器是接口边界，reasoning/tool_calls/usage 的
 * 增量累积规则必须钉死，网关返回格式变了在这里先炸。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { chatCompletion } from '../../src/core/llm';

function sseResponse(chunks: object[]): Response {
  const text = chunks.map((c) => `data: ${JSON.stringify(c)}\n`).join('') + 'data: [DONE]\n';
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

const baseOpts = { baseUrl: 'https://example.com/v1', apiKey: 'k', model: 'm', messages: [] };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('chatCompletion：SSE 解析', () => {
  it('reasoning_content 增量累积 + onReasoning 回调，与 content 分开', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      sseResponse([
        { choices: [{ delta: { reasoning_content: '先想' } }] },
        { choices: [{ delta: { reasoning_content: '清楚' } }] },
        { choices: [{ delta: { content: '答' } }] },
        { choices: [{ delta: { content: '案' } }] },
        { choices: [], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } },
      ])
    ));
    const reasoningDeltas: string[] = [];
    const result = await chatCompletion({ ...baseOpts, onReasoning: (t) => reasoningDeltas.push(t) });
    expect(result.reasoning).toBe('先想清楚');
    expect(reasoningDeltas).toEqual(['先想', '清楚']);
    expect(result.content).toBe('答案');
    expect(result.usage?.totalTokens).toBe(3);
  });

  it('普通模型没有 reasoning 字段：result.reasoning 为 undefined，回调不触发', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      sseResponse([{ choices: [{ delta: { content: 'hi' } }] }])
    ));
    const onReasoning = vi.fn();
    const result = await chatCompletion({ ...baseOpts, onReasoning });
    expect(result.reasoning).toBeUndefined();
    expect(onReasoning).not.toHaveBeenCalled();
  });

  it('tool_calls 增量按 index 累积 id/name/arguments', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      sseResponse([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_', arguments: '{"pa' } }] } }] },
        { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'file', arguments: 'th":"a"}' } }] } }] },
      ])
    ));
    const result = await chatCompletion(baseOpts);
    expect(result.toolCalls).toEqual([{ id: 'call_1', name: 'read_file', arguments: '{"path":"a"}' }]);
  });
});

// ---- 重构提纯的纯函数（parseSseLine / applyChunk）与两个边界回归 ----

import { parseSseLine, applyChunk, SseAccumulator } from '../../src/core/llm';

function freshAcc(): SseAccumulator {
  return { content: '', reasoning: '', toolCalls: new Map() };
}

describe('parseSseLine：行 → 载荷', () => {
  it('data 行返回 JSON 载荷', () => {
    expect(parseSseLine('data: {"a":1}')).toBe('{"a":1}');
    expect(parseSseLine('data:   {"a":1}  ')).toBe('{"a":1}');
  });

  it('[DONE] 与非 data 行返回 null', () => {
    expect(parseSseLine('data: [DONE]')).toBeNull();
    expect(parseSseLine('')).toBeNull();
    expect(parseSseLine('event: message')).toBeNull();
    expect(parseSseLine(': comment')).toBeNull();
  });
});

describe('applyChunk：增量累积', () => {
  it('首个 tool_calls delta 缺 index → 进 0 号槽（-1 bug 回归）', () => {
    const acc = freshAcc();
    applyChunk({ choices: [{ delta: { tool_calls: [{ id: 'call_1', function: { name: 'read_file', arguments: '{}' } }] } }] }, acc, {});
    expect([...acc.toolCalls.values()]).toEqual([{ id: 'call_1', name: 'read_file', arguments: '{}' }]);
  });

  it('缺 index 的后续 delta 归并到当前最后一个槽位', () => {
    const acc = freshAcc();
    applyChunk({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'a', arguments: '{"x' } }] } }] }, acc, {});
    applyChunk({ choices: [{ delta: { tool_calls: [{ function: { arguments: '":1}' } }] } }] }, acc, {});
    expect([...acc.toolCalls.values()]).toEqual([{ id: 'c1', name: 'a', arguments: '{"x":1}' }]);
  });

  it('usage chunk 不带 delta 时只记 usage 不崩', () => {
    const acc = freshAcc();
    applyChunk({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } }, acc, {});
    expect(acc.usage?.totalTokens).toBe(3);
    expect(acc.content).toBe('');
  });
});

describe('chatCompletion：流收尾边界', () => {
  it('末尾无换行的 data 行不丢（decoder/buffer 双重冲尾）', async () => {
    const text = 'data: {"choices":[{"delta":{"content":"尾"}}]}\n\n' +
      'data: {"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}'; // 无结尾换行
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode(text)); c.close(); },
    }), { status: 200 })));
    const result = await chatCompletion(baseOpts);
    expect(result.content).toBe('尾');
    expect(result.usage?.totalTokens).toBe(2);
  });

  it('缺 index 的 tool_calls 端到端不丢调用（-1 bug 回归）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      sseResponse([
        { choices: [{ delta: { tool_calls: [{ id: 'call_9', function: { name: 'list_files', arguments: '{}' } }] } }] },
      ])
    ));
    const result = await chatCompletion(baseOpts);
    expect(result.toolCalls).toEqual([{ id: 'call_9', name: 'list_files', arguments: '{}' }]);
  });
});
