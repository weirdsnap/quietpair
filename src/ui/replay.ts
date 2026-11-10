/**
 * 会话回放映射（纯函数）：持久化 history → webview 回放条目。
 * 只回放用户与助手文本；压缩摘要降级为 note 卡；tool 消息与纯工具调用的
 * assistant 消息不回放（完整过程在 Activity 视图与 transcript）。
 * 背景：history 一直在喂模型，界面若不回放就是「AI 记得、用户看不到」的数据-视图不一致。
 */
import { ChatMessage } from '../core/llm';

export const SUMMARY_PREFIX = '[此前对话的压缩摘要]';

export interface ReplayEntry {
  kind: 'user' | 'assistant' | 'note';
  title?: string;
  text: string;
}

export function historyToReplayEntries(history: ChatMessage[]): ReplayEntry[] {
  const entries: ReplayEntry[] = [];
  for (const m of history) {
    if (m.role === 'user' && typeof m.content === 'string' && m.content.trim()) {
      if (m.content.startsWith(SUMMARY_PREFIX)) {
        entries.push({
          kind: 'note',
          title: '🗜 Earlier conversation (compacted summary)',
          text: m.content.slice(SUMMARY_PREFIX.length).trim(),
        });
      } else {
        entries.push({ kind: 'user', text: m.content });
      }
    } else if (m.role === 'assistant' && typeof m.content === 'string' && m.content.trim()) {
      entries.push({ kind: 'assistant', text: m.content });
    }
  }
  return entries;
}
