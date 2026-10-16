/**
 * 守望模式：结对伙伴的「眼睛」——编排层。
 *
 * 本文件只负责「什么时候分析、分析谁」：编辑/切换编辑器事件监听、调度（debounce）、
 * 以及各公开入口（手动触发 / 聊天请求 / 复审 / 确认修复）。
 * 具体实现拆在三个模块里：
 * - gate.ts      语义闸门（纯函数）：编辑分类决定等待时长 + 括号配对/光标边界检测
 * - analyzer.ts  分析管线：一次深度分析的完整过程（含 hash 去重、冷却、工具取证循环）
 * - triage.ts    保存分诊「速记员」：用户保存时用极小调用判断值不值得叫醒分析
 *
 * 分析结果分流给编辑器标注（annotations.ts）、面板卡片、共享上下文。
 * 另负责聊天 Agent 改完文件后的复审（reviewFiles）。
 */
import * as vscode from 'vscode';
import * as path from 'path';
import { TokenUsage } from '../core/llm';
import { Suggestion } from './annotations';
import { ActivityTracker } from './activity';
import { Analyzer } from './analyzer';
import { SaveTriage } from './triage';
import { classifyDelay, isSemanticallySettled } from './gate';

const MAX_REVIEW_FILES = 3;

export interface CompanionCallbacks {
  getApiKey(): Promise<string | undefined>;
  isBusy(): boolean;
  onAnalysisStart(id: string, file: string, label: string): void;
  onAnalysisEnd(id: string, file: string, uri: vscode.Uri, suggestions: Suggestion[], rawText: string | null): void;
  onInvalidate(uri: vscode.Uri): void;
  onNotice(message: string): void;
  onDebug?(event: string, data: Record<string, unknown>): void;
  onUsage?(usage: TokenUsage): void;
}

// 「✓ 改好了」的三种结局：聊天在跑 → busy；文件没变化但当前内容刚分析过 → unchanged
//（现有标注就是最新判断，无需再调 LLM）；真正复审出新结果 → reviewed
export type ConfirmResult =
  | { status: 'busy' }
  | { status: 'unchanged' }
  | { status: 'reviewed'; suggestions: Suggestion[] };

export class Companion implements vscode.Disposable {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private retryCount = 0;
  private readonly analyzer: Analyzer;
  private readonly triage: SaveTriage;
  private disposables: vscode.Disposable[] = [];

  constructor(private readonly callbacks: CompanionCallbacks, activity?: ActivityTracker) {
    this.analyzer = new Analyzer(
      {
        getApiKey: () => callbacks.getApiKey(),
        onAnalysisStart: (id, file, label) => callbacks.onAnalysisStart(id, file, label),
        onAnalysisEnd: (id, file, uri, suggestions, rawText) => callbacks.onAnalysisEnd(id, file, uri, suggestions, rawText),
        onNotice: (message) => callbacks.onNotice(message),
        onDebug: callbacks.onDebug ? (event, data) => callbacks.onDebug!(event, data) : undefined,
        onUsage: callbacks.onUsage ? (usage) => callbacks.onUsage!(usage) : undefined,
        // 冷却拦截 → 交还编排层推迟调度（届时用最新内容重来，hash 去重依然生效）
        onCooldownDefer: (waitMs) => this.schedule(waitMs),
      },
      activity,
    );
    this.triage = new SaveTriage(
      {
        getApiKey: () => callbacks.getApiKey(),
        isBusy: () => callbacks.isBusy(),
        isEnabled: () => this.isEnabled(),
        onDebug: callbacks.onDebug ? (event, data) => callbacks.onDebug!(event, data) : undefined,
        onUsage: callbacks.onUsage ? (usage) => callbacks.onUsage!(usage) : undefined,
      },
      this.analyzer,
      activity,
    );

    this.disposables.push(
      this.triage,
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.scheme === 'file' && e.contentChanges.length > 0) {
          this.callbacks.onInvalidate(e.document.uri);
          this.retryCount = 0;
          const { delay, reason } = classifyDelay(e.contentChanges, this.quickTriggerMs(), this.debounceMs());
          this.callbacks.onDebug?.('trigger', {
            file: vscode.workspace.asRelativePath(e.document.uri),
            reason,
            delayMs: delay,
            summary: `trigger: ${reason} → ${delay}ms`,
          });
          this.schedule(delay);
        }
      }),
      vscode.window.onDidChangeActiveTextEditor((e) => {
        if (e && e.document.uri.scheme === 'file') {
          this.schedule();
        }
      })
    );
  }

  schedule(delayMs?: number): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (!this.isEnabled()) {
      return;
    }
    this.timer = setTimeout(() => void this.analyzeActive(), delayMs ?? this.debounceMs());
  }

  private isEnabled(): boolean {
    return vscode.workspace.getConfiguration('vsAgent').get<boolean>('companion.enabled', true);
  }

  private debounceMs(): number {
    const seconds = vscode.workspace.getConfiguration('vsAgent').get<number>('companion.debounceSeconds', 10);
    return Math.max(3, seconds) * 1000;
  }

  private quickTriggerMs(): number {
    const seconds = vscode.workspace.getConfiguration('vsAgent').get<number>('companion.quickTriggerSeconds', 3);
    return Math.max(1, seconds) * 1000;
  }

  private async analyzeActive(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== 'file' || !this.isEnabled()) {
      return;
    }
    if (this.callbacks.isBusy()) {
      this.callbacks.onDebug?.('gate', { result: 'chat-busy-reschedule' });
      this.schedule();
      return;
    }

    // 语义完备性闸门：用户还停在半个表达式里时不开口，3 秒后再看，最多重试 3 次
    if (!isSemanticallySettled(editor)) {
      this.callbacks.onDebug?.('gate', {
        result: this.retryCount < 3 ? 'not-settled-retry' : 'not-settled-giveup',
        retry: this.retryCount,
      });
      if (this.retryCount < 3) {
        this.retryCount++;
        this.schedule(this.quickTriggerMs());
      }
      return;
    }
    this.retryCount = 0;
    this.callbacks.onDebug?.('gate', { result: 'settled' });

    await this.analyzer.analyze(editor.document, `Analyzing ${vscode.workspace.asRelativePath(editor.document.uri)}…`);
  }

  // 聊天 Agent 写完文件后的复审：跳过语义闸门，直接分析被修改的文件。
  // 返回各文件的复审结果（null = 没产出分析），由调用方决定闭环动作（静默确认 / 回灌 Agent）
  async reviewFiles(absolutePaths: string[]): Promise<{ file: string; suggestions: Suggestion[] | null }[]> {
    const results: { file: string; suggestions: Suggestion[] | null }[] = [];
    if (!this.isEnabled() || this.callbacks.isBusy()) {
      return results;
    }
    // 复审接手这些文件：挂起的常规调度没意义了（醒来也只会 hash 命中白跑一趟）
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    for (const abs of absolutePaths.slice(0, MAX_REVIEW_FILES)) {
      try {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(abs));
        const rel = vscode.workspace.asRelativePath(doc.uri);
        const suggestions = await this.analyzer.analyze(
          doc,
          `Reviewing agent change in ${rel}…`,
          'Note: this file was just modified by the AI agent to address earlier feedback. Verify the change: does it actually address the feedback? Did it introduce new problems (broken references, inconsistent style, incomplete edits)? Only report issues related to this change — do NOT re-audit untouched parts of the file.',
          { bypassCooldown: true } // 复审不受冷却限制：Agent 刚改完，需要立刻看
        );
        results.push({ file: rel, suggestions });
      } catch {
        // 文件可能已被删除或不可读，跳过
      }
    }
    return results;
  }

  // 对话中触发的分析（聊天 Agent 的 analyze_code 工具，比如用户说「帮我分析一下」）：
  // 强制跑完整守望管线（绕过冷却 + 强制分析），结果照常进编辑器标注/共享上下文，
  // 同时以文本形式返回给模型，让它结合结果跟用户讨论
  async analyzeRequested(relPath?: string): Promise<string> {
    if (!this.isEnabled()) {
      return '守望模式已关闭（vsAgent.companion.enabled = false）。';
    }
    let doc: vscode.TextDocument;
    if (relPath) {
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!folder) {
        return '没有打开的工作区。';
      }
      const normalized = path.normalize(path.isAbsolute(relPath) ? relPath : path.join(folder.uri.fsPath, relPath));
      if (normalized !== folder.uri.fsPath && !normalized.startsWith(folder.uri.fsPath + path.sep)) {
        return `路径超出工作区：${relPath}`;
      }
      try {
        doc = await vscode.workspace.openTextDocument(vscode.Uri.file(normalized));
      } catch {
        return `打不开文件：${relPath}`;
      }
    } else {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.uri.scheme !== 'file') {
        return '当前没有打开的文件编辑器。';
      }
      doc = editor.document;
    }
    const rel = vscode.workspace.asRelativePath(doc.uri);
    const suggestions = await this.analyzer.analyze(doc, `Analyzing ${rel} (requested in chat)…`, undefined, {
      bypassCooldown: true,
      force: true,
    });
    if (suggestions === null) {
      return '分析没有运行（缺少 API key 或请求被中止）。';
    }
    if (suggestions.length === 0) {
      return `分析完成：${rel} 没有发现问题。`;
    }
    const lines = suggestions.map(
      (s) => `[L${s.level}] ${s.line ? `第 ${s.line} 行 — ` : ''}${s.title}\n${s.detail}${s.fix ? `\n修复参考：${s.fix}` : ''}`
    );
    return `分析完成：${rel} 共 ${suggestions.length} 条建议（已标注到编辑器；L1 观察 / L2 提醒 / L3 打断）：\n\n${lines.join('\n\n')}`;
  }

  // 手动触发（面板 🔍 按钮 / 命令，主要方便测试）：
  // 跳过语义闸门、冷却和哈希去重，立刻分析当前文件
  async analyzeNow(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== 'file' || !this.isEnabled()) {
      this.callbacks.onNotice('没有可分析的活动文件（或守望模式已关闭）。');
      return;
    }
    if (this.callbacks.isBusy()) {
      this.callbacks.onNotice('聊天 Agent 正在运行，等它结束再手动分析。');
      return;
    }
    await this.analyzer.analyze(
      editor.document,
      `Manually analyzing ${vscode.workspace.asRelativePath(editor.document.uri)}…`,
      undefined,
      { bypassCooldown: true, force: true } // 内容没变也分析（测试 prompt/链路时需要）
    );
  }

  // 用户声称已手动修复某条建议（点了「✓ 改好了」）→ 绕过冷却立刻复审
  async confirmFix(absolutePath: string, s: Suggestion): Promise<ConfirmResult> {
    if (!this.isEnabled() || this.callbacks.isBusy()) {
      return { status: 'busy' };
    }
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(absolutePath));
      if (!this.analyzer.hasUnanalyzedChanges(doc)) {
        // 内容没变 = 当前这份代码我刚分析过，现有的标注就是最新判断，不用花 token 再看一遍
        return { status: 'unchanged' };
      }
      const rel = vscode.workspace.asRelativePath(doc.uri);
      const suggestions = await this.analyzer.analyze(
        doc,
        `Verifying fix in ${rel}…`,
        `The user says they just manually fixed this issue: [L${s.level}] line ${s.line ?? '?'} "${s.title}" — ${s.detail}. Verify honestly: if it is actually fixed, do NOT report it again; only report problems that still exist or are newly introduced.`,
        { bypassCooldown: true } // 用户在回应我们的建议，这是最值得立刻反馈的时刻，不受冷却限制
      );
      return { status: 'reviewed', suggestions: suggestions ?? [] };
    } catch {
      return { status: 'busy' };
    }
  }

  dispose(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.analyzer.abortInFlight();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
