/**
 * 守望模式与聊天 Agent 之间的共享上下文栈（容量 20 条）。
 * 守望发现的建议写入这里，发聊天消息时注入 system prompt，
 * 因此用户可以说「刚才那个建议」「标红的那行」而无需复制粘贴。
 */
import { Suggestion, SuggestionLevel, LEVEL_LABEL } from '../companion/annotations';

export interface ContextEntry {
  time: number;
  file: string;
  line?: number;
  level: SuggestionLevel;
  title: string;
  detail: string;
  viewedAt?: number; // 用户在面板里查看过这条（点「在面板中查看」/ L3 自动展开）
}

const MAX_ENTRIES = 20;

export class SharedContext {
  private entries: ContextEntry[] = [];

  // 同一文件重新分析 = 该文件旧条目全部过期（与 annotations.set 的替换语义对齐）：
  // 否则同一个没修的 bug 每轮分析重复入栈，20 格很快被它挤满、别的文件被 slice 挤掉
  addSuggestions(file: string, items: Suggestion[]): void {
    // 「正在看」标记按身份键携带过重新分析，不因刷新丢失
    const prevViewed = new Map<string, number>();
    for (const e of this.entries) {
      if (e.file === file && e.viewedAt) {
        prevViewed.set(entryKey(e.file, e.line, e.title), e.viewedAt);
      }
    }
    this.entries = this.entries.filter((e) => e.file !== file);
    for (const s of items) {
      this.entries.push({
        time: Date.now(),
        file,
        line: s.line,
        level: s.level,
        title: s.title,
        detail: s.detail,
        viewedAt: prevViewed.get(entryKey(file, s.line, s.title)),
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
  // 用户问「什么意思」这类模糊指代时，模型优先对应到这条，而不是瞎猜。
  // 必须带 title 匹配：无行号时 undefined === undefined 恒真，
  // 同文件多条无行号建议会让 find 永远命中第一条，标记贴错对象
  markViewed(file: string, line: number | undefined, title: string): void {
    const key = entryKey(file, line, title);
    const e = this.entries.find((x) => entryKey(x.file, x.line, x.title) === key);
    if (e) {
      e.viewedAt = Date.now();
    }
  }

  summarize(): string {
    if (this.entries.length === 0) {
      return '';
    }
    return this.entries.map(formatEntry).join('\n');
  }
}

// 条目身份键：有行号按 file:line，无行号退化为 file:title（无行号建议靠位置无从区分，标题是唯一身份）
function entryKey(file: string, line: number | undefined, title: string): string {
  return line !== undefined ? `${file}:${line}` : `${file}~${title}`;
}

// 每条建议的 prompt 行：抽出来命名，输出字符串与原来一字不差（这是注入 system prompt 的内容）
function formatEntry(e: ContextEntry): string {
  const level = LEVEL_LABEL[e.level];
  const location = e.line ? `${e.file}:${e.line}` : e.file;
  const viewed = e.viewedAt ? '（← 用户正在看这条）' : '';
  return `- [L${e.level} ${level}] ${location} ${e.title} — ${e.detail}${viewed}`;
}
