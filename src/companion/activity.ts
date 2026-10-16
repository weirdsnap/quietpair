/**
 * 活动缓冲区（分层观测的第一层）：纯本地记录用户最近的编辑/浏览轨迹，零 token。
 * 按文件聚合编辑量（ring 窗口 ~15 分钟），深度分析时压缩成几行摘要注入 prompt——
 * 守望从「看单文件快照」升级成「看用户这一段时间的工作」，
 * 跨文件一致性建议（改了 A 的签名、B 没跟上）的原材料就来自这里。
 */
import * as vscode from 'vscode';

interface EditRecord {
  file: string;
  added: number;
  removed: number;
  time: number;
}

const WINDOW_MS = 15 * 60 * 1000;
const MAX_OPENED = 5;

export class ActivityTracker implements vscode.Disposable {
  private edits = new Map<string, EditRecord>();
  private opens: { file: string; time: number }[] = [];
  private agentWrites = new Map<string, number>(); // relPath → 标记时间，用于排除 Agent 自己的写入
  private disposables: vscode.Disposable[] = [];

  // 聊天 Agent 刚写了这个文件：随后的文档变更事件是它干的，不算用户活动
  markAgentWrite(absolutePath: string): void {
    this.agentWrites.set(vscode.workspace.asRelativePath(vscode.Uri.file(absolutePath)), Date.now());
  }

  constructor() {
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.scheme !== 'file' || e.contentChanges.length === 0) {
          return;
        }
        const file = vscode.workspace.asRelativePath(e.document.uri);
        const markedAt = this.agentWrites.get(file);
        if (markedAt !== undefined && Date.now() - markedAt < 3000) {
          return; // Agent 写入触发的变更（3 秒窗口内），不记为用户活动
        }
        this.agentWrites.delete(file);
        const rec = this.edits.get(file) ?? { file, added: 0, removed: 0, time: 0 };
        for (const c of e.contentChanges) {
          rec.added += c.text.length;
          rec.removed += c.rangeLength;
        }
        rec.time = Date.now();
        this.edits.set(file, rec);
      }),
      vscode.window.onDidChangeActiveTextEditor((e) => {
        if (e && e.document.uri.scheme === 'file') {
          this.opens.push({ file: vscode.workspace.asRelativePath(e.document.uri), time: Date.now() });
        }
      })
    );
  }

  // 单个文件的近期编辑量（供保存分诊判断改动规模）
  fileStats(file: string): { added: number; removed: number } | undefined {
    const rec = this.edits.get(file);
    if (!rec || Date.now() - rec.time >= WINDOW_MS) {
      return undefined;
    }
    return { added: rec.added, removed: rec.removed };
  }

  // 压缩成几行中文摘要，注入守望分析 prompt；没有活动则返回空串（不注入）
  summarize(): string {
    const cutoff = Date.now() - WINDOW_MS;
    const edited = [...this.edits.values()]
      .filter((r) => r.time >= cutoff)
      .sort((a, b) => b.time - a.time)
      .slice(0, 8);
    const editedFiles = new Set(edited.map((r) => r.file));
    const openedOnly: string[] = [];
    for (const o of this.opens) {
      if (o.time >= cutoff && !editedFiles.has(o.file) && !openedOnly.includes(o.file)) {
        openedOnly.push(o.file);
      }
    }
    if (edited.length === 0 && openedOnly.length === 0) {
      return '';
    }
    const lines: string[] = [];
    if (edited.length > 0) {
      lines.push(`最近编辑过：${edited.map((r) => `${r.file}（+${r.added}/-${r.removed} 字符）`).join('、')}`);
    }
    if (openedOnly.length > 0) {
      lines.push(`打开看过但没改：${openedOnly.slice(0, MAX_OPENED).join('、')}`);
    }
    return lines.join('\n');
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
