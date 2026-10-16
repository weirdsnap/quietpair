/**
 * OpenAI 兼容接口的流式客户端。
 * 手写 SSE 解析，支持流式 token 回调、tool_calls 增量累积、AbortSignal 打断。
 * 被打断时返回部分内容 + aborted 标记（不是异常），由上层把半成品发言留存进历史。
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
  signal?: AbortSignal;
}

export interface ChatCompletionResult {
  content: string;
  toolCalls: ToolCall[];
  usage?: TokenUsage;
  aborted?: boolean;
}

export async function chatCompletion(options: ChatCompletionOptions): Promise<ChatCompletionResult> {
  const { baseUrl, apiKey, model, messages, tools, onToken, signal } = options;

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
  let content = '';
  let usage: TokenUsage | undefined;
  const toolCalls: ToolCall[] = [];

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });

      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith('data:')) {
          continue;
        }
        const data = line.slice(5).trim();
        if (data === '[DONE]') {
          continue;
        }
        let chunk: any;
        try {
          chunk = JSON.parse(data);
        } catch {
          continue;
        }
        // usage chunk：最后一个包，choices 为空、只带 token 统计
        if (chunk.usage && typeof chunk.usage.total_tokens === 'number') {
          usage = {
            promptTokens: chunk.usage.prompt_tokens ?? 0,
            completionTokens: chunk.usage.completion_tokens ?? 0,
            totalTokens: chunk.usage.total_tokens,
          };
        }
        const delta = chunk.choices?.[0]?.delta;
        if (!delta) {
          continue;
        }
        if (typeof delta.content === 'string' && delta.content.length > 0) {
          content += delta.content;
          onToken?.(delta.content);
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const index: number = typeof tc.index === 'number' ? tc.index : toolCalls.length - 1;
            if (!toolCalls[index]) {
              toolCalls[index] = { id: '', name: '', arguments: '' };
            }
            if (tc.id) {
              toolCalls[index].id = tc.id;
            }
            if (tc.function?.name) {
              toolCalls[index].name += tc.function.name;
            }
            if (tc.function?.arguments) {
              toolCalls[index].arguments += tc.function.arguments;
            }
          }
        }
      }
    }
  } catch (err) {
    // 被打断不是错误：返回已说出的部分内容，让调用方标记后留存
    if (signal?.aborted || (err instanceof Error && err.name === 'AbortError')) {
      return { content, toolCalls: toolCalls.filter((tc) => tc.id), usage, aborted: true };
    }
    throw err;
  }

  return { content, toolCalls: toolCalls.filter((tc) => tc.id), usage, aborted: signal?.aborted };
}
