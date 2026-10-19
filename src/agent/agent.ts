/**
 * 聊天 Agent 的核心循环。
 * runAgent：用户消息入历史 → 调模型 → 模型要调工具就执行并回灌结果 → 循环，
 * 直到模型给出最终回答（或达到步数上限 / 被用户打断）。
 * 连续出现的纯读工具（read_file / list_files / get_active_editor）合并并发执行；
 * 写类/交互类工具保持串行（见 tools.ts 的 groupToolCalls）。
 * 人设 SYSTEM_PROMPT 在 ./prompts（所有 prompt 集中管理），这里只做转发导出。
 */
import { ChatMessage, TokenUsage, ToolCall, chatCompletion } from '../core/llm';
import { toolDefinitions, executeTool, groupToolCalls, ToolContext } from './tools';

export { SYSTEM_PROMPT } from './prompts';

const MAX_STEPS = 20;

export interface AgentEvents {
  onToken(text: string): void;
  // 推理模型的思考流（deepseek-reasoner 等）；展示+落 transcript，不进对话历史
  onReasoning?(text: string): void;
  onToolStart(name: string, args: string): void;
  onToolResult(name: string, result: string): void;
  onDone(): void;
  onAborted(): void;
  onError(message: string): void;
  onUsage?(usage: TokenUsage): void;
}

export interface AgentDeps {
  baseUrl: string;
  apiKey: string;
  model: string;
  signal?: AbortSignal;
}

function toOpenAIToolCall(tc: ToolCall) {
  return {
    id: tc.id,
    type: 'function' as const,
    function: { name: tc.name, arguments: tc.arguments },
  };
}

export async function runAgent(
  userText: string,
  history: ChatMessage[],
  deps: AgentDeps,
  events: AgentEvents,
  toolCtx: ToolContext
): Promise<void> {
  history.push({ role: 'user', content: userText });

  for (let step = 0; step < MAX_STEPS; step++) {
    if (deps.signal?.aborted) {
      events.onAborted();
      return;
    }

    let result;
    try {
      result = await chatCompletion({
        baseUrl: deps.baseUrl,
        apiKey: deps.apiKey,
        model: deps.model,
        messages: history,
        tools: toolDefinitions,
        onToken: events.onToken,
        onReasoning: events.onReasoning,
        signal: deps.signal,
      });
    } catch (err) {
      if (deps.signal?.aborted) {
        events.onAborted();
        return;
      }
      throw err;
    }

    if (result.usage) {
      events.onUsage?.(result.usage);
    }

    // 被打断：半成品发言留存并标记，模型知道这段是被打断的，而不是说完了
    if (result.aborted || deps.signal?.aborted) {
      if (result.content.trim()) {
        history.push({
          role: 'assistant',
          content: `${result.content}\n\n[用户打断了这里，上文没说完的部分不必继续]`,
        });
      }
      events.onAborted();
      return;
    }

    const { content, toolCalls } = result;

    history.push({
      role: 'assistant',
      content: content || null,
      tool_calls: toolCalls.length > 0 ? toolCalls.map(toOpenAIToolCall) : undefined,
    });

    if (toolCalls.length === 0) {
      events.onDone();
      return;
    }

    for (const group of groupToolCalls(toolCalls)) {
      if (deps.signal?.aborted) {
        events.onAborted();
        return;
      }
      for (const tc of group) {
        events.onToolStart(tc.name, tc.arguments);
      }
      // 纯读工具一批并发；写/交互类工具组里只有一个，等价于串行
      const results = await Promise.all(group.map((tc) => executeTool(tc.name, tc.arguments, toolCtx)));
      group.forEach((tc, j) => {
        events.onToolResult(tc.name, results[j]);
        history.push({ role: 'tool', tool_call_id: tc.id, content: results[j] });
      });
    }
  }

  events.onError(`Stopped after ${MAX_STEPS} tool steps without a final answer.`);
}
