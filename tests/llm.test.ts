/**
 * llm.ts 的 SSE 解析测试：手写解析器是接口边界，reasoning/tool_calls/usage 的
 * 增量累积规则必须钉死，网关返回格式变了在这里先炸。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { chatCompletion } from '../src/core/llm';

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
