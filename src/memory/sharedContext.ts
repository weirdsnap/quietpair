/**
 * 守望模式与聊天 Agent 之间的共享上下文栈（容量 20 条）。
 * 守望发现的建议写入这里，发聊天消息时注入 system prompt，
 * 因此用户可以说「刚才那个建议」「标红的那行」而无需复制粘贴。
 */
import { Suggestion, LEVEL_LABEL } from '../companion/annotations';

export interface ContextEntry {
  time: number;
  file: string;
  line?: number;
  level: number;
  title: string;
  detail: string;
  viewedAt?: number; // 用户在面板里查看过这条（点「在面板中查看」/ L3 自动展开）
}

const MAX_ENTRIES = 20;

export class SharedContext {
  private entries: ContextEntry[] = [];

  addSuggestions(file: string, items: Suggestion[]): void {
    for (const s of items) {
      this.entries.push({
        time: Date.now(),
        file,
        line: s.line,
        level: s.level,
        title: s.title,
        detail: s.detail,
      });
    }
    if (this.entries.length > MAX_ENTRIES) {
      this.entries = this.entries.slice(-MAX_ENTRIES);
    }
  }

  clear(): void {
    this.entries = [];
  }

  // 用户在面板里查看了某条建议 → 打上「正在看」标记。
  // 用户问「什么意思」这类模糊指代时，模型优先对应到这条，而不是瞎猜
  markViewed(file: string, line?: number): void {
    const e = this.entries.find((x) => x.file === file && x.line === line);
    if (e) {
      e.viewedAt = Date.now();
    }
  }

  summarize(): string {
    if (this.entries.length === 0) {
      return '';
    }
    return this.entries
      .map(
        (e) =>
          `- [L${e.level} ${LEVEL_LABEL[e.level as 1 | 2 | 3]}] ${e.file}${e.line ? `:${e.line}` : ''} ${e.title} — ${e.detail}${e.viewedAt ? '（← 用户正在看这条）' : ''}`
      )
      .join('\n');
  }
}
