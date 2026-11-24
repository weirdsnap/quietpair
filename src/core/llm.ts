/**
 * OpenAI 兼容接口的流式客户端。
 * 手写 SSE 解析，支持流式 token 回调、tool_calls 增量累积、AbortSignal 打断。
 * 被打断时返回部分内容 + aborted 标记（不是异常），由上层把半成品发言留存进历史。
 *
 * 结构分三层（按状态生命周期划分，详见 tests/unit/llm.test.ts 的门禁）：
 * - 纯行解析：parseSseLine（零状态，字符串进字符串出）
 * - 逐块语义：applyChunk（状态显式装在 SseAccumulator 里传入传出）
 * - 主循环：只负责 读 → 解码 → 切行 → 喂给上面两层，外加收尾冲尾
 */
export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

// 一次调用的 token 消耗（来自流式响应末尾的 usage chunk，部分网关可能不返回）
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_calls?: {
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }[];
  tool_call_id?: string;
}

export interface ChatCompletionOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  tools?: unknown[];
  onToken?: (text: string) => void;
  // 推理模型（deepseek-reasoner 等）的思考流 delta.reasoning_content；普通模型不会触发
  onReasoning?: (text: string) => void;
  signal?: AbortSignal;
}

export interface ChatCompletionResult {
  content: string;
  // 完整思考过程（不回灌历史：reasoning_content 不应出现在下一轮请求里）
  reasoning?: string;
  toolCalls: ToolCall[];
  usage?: TokenUsage;
  aborted?: boolean;
}

/** 一次流式响应的累积状态：跨 chunk 存活，显式传递（不藏闭包），所以可以直接喂测试 */
export interface SseAccumulator {
  content: string;
  reasoning: string;
  usage?: TokenUsage;
  // index → 累积中的 tool call。用 Map 不用数组：index 缺省时归并到最后一个槽位，
  // 天然不存在数组下标语义的 -1 bug（曾导致首个 delta 缺 index 时整个调用被静默丢弃）
  toolCalls: Map<number, ToolCall>;
}

export interface SseHandlers {
  onToken?: (text: string) => void;
  onReasoning?: (text: string) => void;
}

/** 一行 SSE → JSON 载荷；非 data 行和 [DONE] 哨兵返回 null（调用方跳过即可） */
export function parseSseLine(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) {
    return null;
  }
  const data = trimmed.slice(5).trim();
  return data === '[DONE]' ? null : data;
}

/** 单个 OpenAI chunk 的语义累积：usage / reasoning / content / tool_calls 增量 */
export function applyChunk(chunk: any, acc: SseAccumulator, handlers: SseHandlers): void {
  // usage chunk：最后一个包，choices 为空、只带 token 统计
  if (chunk?.usage && typeof chunk.usage.total_tokens === 'number') {
    acc.usage = {
      promptTokens: chunk.usage.prompt_tokens ?? 0,
      completionTokens: chunk.usage.completion_tokens ?? 0,
      totalTokens: chunk.usage.total_tokens,
    };
  }
  const delta = chunk?.choices?.[0]?.delta;
  if (!delta) {
    return;
  }
  if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
    acc.reasoning += delta.reasoning_content;
    handlers.onReasoning?.(delta.reasoning_content);
  }
  if (typeof delta.content === 'string' && delta.content.length > 0) {
    acc.content += delta.content;
    handlers.onToken?.(delta.content);
  }
  if (Array.isArray(delta.tool_calls)) {
    for (const tc of delta.tool_calls) {
      // index 缺省 → 归并到当前最后一个槽位（流里的惯例：同一调用的续片不重复 index）；
      // 一个槽位都还没有时从 0 开始
      const index: number =
        typeof tc.index === 'number' ? tc.index : acc.toolCalls.size === 0 ? 0 : Math.max(...acc.toolCalls.keys());
      let slot = acc.toolCalls.get(index);
      if (!slot) {
        slot = { id: '', name: '', arguments: '' };
        acc.toolCalls.set(index, slot);
      }
      if (tc.id) {
        slot.id = tc.id;
      }
      if (tc.function?.name) {
        slot.name += tc.function.name;
      }
      if (tc.function?.arguments) {
        slot.arguments += tc.function.arguments;
      }
    }
  }
}

function accToResult(acc: SseAccumulator, aborted: boolean | undefined): ChatCompletionResult {
  return {
    content: acc.content,
    reasoning: acc.reasoning || undefined,
    toolCalls: [...acc.toolCalls.values()].filter((tc) => tc.id),
    usage: acc.usage,
    aborted,
  };
}

export async function chatCompletion(options: ChatCompletionOptions): Promise<ChatCompletionResult> {
  const { baseUrl, apiKey, model, messages, tools, onToken, onReasoning, signal } = options;

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      tools: tools && tools.length > 0 ? tools : undefined,
      stream: true,
      // 流式模式默认不返回 token 用量，要求末尾追加 usage chunk（OpenAI/DeepSeek/Kimi 均支持）
      stream_options: { include_usage: true },
    }),
    signal,
  });

  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => '');
    throw new Error(`API request failed (${res.status}): ${body.slice(0, 500)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const acc: SseAccumulator = { content: '', reasoning: '', toolCalls: new Map() };
  const handlers: SseHandlers = { onToken, onReasoning };

  // buffer 里切一行喂一行；坏 JSON 行跳过（网关偶发脏数据不值得整轮失败）
  const feed = (line: string): void => {
    const data = parseSseLine(line);
    if (data === null) {
      return;
    }
    try {
      applyChunk(JSON.parse(data), acc, handlers);
    } catch {
      /* 跳过坏行 */
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        feed(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
    }
    // 收尾：冲掉解码器的多字节残留，buffer 里没等来回车的最后一行也要喂掉
    buffer += decoder.decode();
    if (buffer.trim()) {
      feed(buffer);
    }
  } catch (err) {
    // 被打断不是错误：返回已说出的部分内容，让调用方标记后留存
    if (signal?.aborted || (err instanceof Error && err.name === 'AbortError')) {
      return accToResult(acc, true);
    }
    throw err;
  }

  return accToResult(acc, signal?.aborted);
}
