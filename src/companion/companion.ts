/**
 * 守望模式：结对伙伴的「眼睛」——编排层。
 *
 * 本文件只负责「什么时候分析、分析谁」：编辑/切换编辑器事件监听、调度（debounce）、
 * 以及各公开入口（手动触发 / 聊天请求 / 复审 / 确认修复）。
 * 具体实现拆在四个模块里：
 * - decision.ts  开口决策层（纯函数）：「现在该不该开口」的唯一权威，输出 speak/delay/suppress 三值判定
 * - gate.ts      语义闸门（纯函数）：编辑分类决定等待时长 + 括号配对/光标边界检测（决策层的信号源）
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
import { decideSpeak } from './decision';
import { decideConfirmGate } from './confirmGate';
import { EditTracker } from '../core/editTracker';
import { ImportGraph, languageIdFromPath } from '../core/importGraph';

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

// 「✓ 改好了」的四种结局：聊天在跑 → busy；建议打出后全工作区都没动过 → unchanged
//（现有标注就是最新判断，无需再调 LLM）；本文件的改动离建议很远且相关文件也没动 → untouched
//（diff 确定性判定：问题区域逐字节没变，免 LLM 复审）；真正复审出新结果 → reviewed
// 闸门逻辑抽在 confirmGate.ts（纯函数）：确定性分支只在「相关范围内什么都没动」时结论
export type ConfirmResult =
  | { status: 'busy' }
  | { status: 'unchanged' }
  | { status: 'untouched' }
  | { status: 'reviewed'; suggestions: Suggestion[] };

export class Companion implements vscode.Disposable {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private retryCount = 0;
  // 一次「决策→分析→标注」链路 = 一个 watch-N，与 chat-N 在同一条事件流里对齐时间轴
  private watchCounter = 0;
  private readonly analyzer: Analyzer;
  private readonly triage: SaveTriage;
  // 确认修复的诚实化基础设施：编辑追踪（建议打出后哪些文件动过）+ import 关系图（哪些文件相关）
  private readonly editTracker = new EditTracker();
  private readonly importGraph = new ImportGraph();
  private scanTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private disposables: vscode.Disposable[] = [];

  private nextWatchId(): string {
    return `watch-${++this.watchCounter}`;
  }

  private static readonly SCAN_GLOB = '**/*.{ts,tsx,js,jsx,mjs,cjs,py,c,cc,cpp,cxx,h,hh,hpp,go,java,kt}';
  private static readonly SCAN_EXCLUDE = '**/{node_modules,.git,out,dist,build,.vscode-test}/**';

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
        nextTurnId: () => this.nextWatchId(),
      },
      this.analyzer,
      activity,
    );

    this.disposables.push(
      this.triage,
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.scheme === 'file' && e.contentChanges.length > 0) {
          const rel = vscode.workspace.asRelativePath(e.document.uri);
          this.editTracker.recordEdit(rel);
          this.importGraph.updateFile(rel, e.document.languageId, e.document.getText());
          this.callbacks.onInvalidate(e.document.uri);
          this.retryCount = 0;
          const { delay, reason } = classifyDelay(e.contentChanges, this.quickTriggerMs(), this.debounceMs());
          this.callbacks.onDebug?.('trigger', {
            file: rel,
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
      }),
      vscode.workspace.onDidCreateFiles((e) => {
        for (const u of e.files) {
          this.trackNewFile(u);
        }
      }),
      vscode.workspace.onDidDeleteFiles((e) => {
        for (const u of e.files) {
          this.importGraph.removeFile(vscode.workspace.asRelativePath(u));
        }
      }),
      vscode.workspace.onDidRenameFiles((e) => {
        for (const f of e.files) {
          this.importGraph.removeFile(vscode.workspace.asRelativePath(f.oldUri));
          this.trackNewFile(f.newUri);
        }
      })
    );
    void this.buildImportGraph();
  }

  // 新文件：登记路径 + 异步读内容解析 import（图是召回优先，读不了就只登记路径）
  private trackNewFile(uri: vscode.Uri): void {
    const rel = vscode.workspace.asRelativePath(uri);
    this.importGraph.registerFile(rel);
    void vscode.workspace.fs.readFile(uri).then(
      (bytes) => this.importGraph.updateFile(rel, languageIdFromPath(uri.path), new TextDecoder().decode(bytes)),
      () => undefined
    );
  }

  // 启动后台扫描：先登记全部路径（解析候选集合），再分批读内容建边，避免阻塞激活
  private async buildImportGraph(): Promise<void> {
    if (!vscode.workspace.workspaceFolders?.length) {
      return;
    }
    let uris: vscode.Uri[];
    try {
      uris = await vscode.workspace.findFiles(Companion.SCAN_GLOB, Companion.SCAN_EXCLUDE, 2000);
    } catch {
      return;
    }
    for (const u of uris) {
      this.importGraph.registerFile(vscode.workspace.asRelativePath(u));
    }
    let i = 0;
    const step = async (): Promise<void> => {
      if (this.disposed) {
        return;
      }
      const batch = uris.slice(i, (i += 25));
      for (const u of batch) {
        try {
          const bytes = await vscode.workspace.fs.readFile(u);
          if (bytes.byteLength > 256 * 1024) {
            continue;
          }
          this.importGraph.updateFile(vscode.workspace.asRelativePath(u), languageIdFromPath(u.path), new TextDecoder().decode(bytes));
        } catch {
          // 读不动就跳过：召回优先的启发式，缺一条边只是少一个候选
        }
      }
      if (i < uris.length) {
        this.scanTimer = setTimeout(() => void step(), 50);
      }
    };
    await step();
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

  private static readonly MAX_SETTLE_RETRIES = 3;

  private async analyzeActive(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== 'file') {
      return;
    }

    // 开口决策（decision.ts 是唯一权威）：所有「现在该不该开口」的判断汇成一次结构化判定，
    // 每次判定落 transcript（phase: 'decision'），攒时机评测/个性化的数据底子
    const settled = isSemanticallySettled(editor);
    const decision = decideSpeak(
      {
        enabled: this.isEnabled(),
        chatBusy: this.callbacks.isBusy(),
        contentChanged: this.analyzer.hasUnanalyzedChanges(editor.document),
        settled,
        settleRetries: this.retryCount,
        maxSettleRetries: Companion.MAX_SETTLE_RETRIES,
        cooldownWaitMs: this.analyzer.cooldownWaitMs(),
      },
      { busyRetryMs: this.debounceMs(), settleRetryMs: this.quickTriggerMs() },
    );
    const turnId = decision.verdict === 'speak' ? this.nextWatchId() : undefined;
    this.callbacks.onDebug?.('decision', {
      file: vscode.workspace.asRelativePath(editor.document.uri),
      verdict: decision.verdict,
      reason: decision.reason,
      retryMs: decision.retryMs,
      turnId,
      summary: `decision: ${decision.verdict} (${decision.reason})`,
    });

    if (decision.verdict === 'delay') {
      if (decision.reason === 'not-settled') {
        this.retryCount++;
      }
      this.schedule(decision.retryMs);
      return;
    }
    if (decision.verdict === 'suppress') {
      return;
    }
    this.retryCount = 0;
    await this.analyzer.analyze(editor.document, `Analyzing ${vscode.workspace.asRelativePath(editor.document.uri)}…`, undefined, { turnId });
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
    // 一轮复审（最多 MAX_REVIEW_FILES 个文件）共用一个 watch-N：它们源于同一次 Agent 写盘
    const turnId = this.nextWatchId();
    for (const abs of absolutePaths.slice(0, MAX_REVIEW_FILES)) {
      try {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(abs));
        const rel = vscode.workspace.asRelativePath(doc.uri);
        const suggestions = await this.analyzer.analyze(
          doc,
          `Reviewing agent change in ${rel}…`,
          'Note: this file was just modified by the AI agent to address earlier feedback. Verify the change: does it actually address the feedback? Did it introduce new problems (broken references, inconsistent style, incomplete edits)? Only report issues related to this change — do NOT re-audit untouched parts of the file.',
          { bypassCooldown: true, turnId } // 复审不受冷却限制：Agent 刚改完，需要立刻看
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
      turnId: this.nextWatchId(),
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
    // 分析在飞时再点：自动链路的单飞是「新内容来了重跑」，手动连点只是白烧 token，拦下
    if (this.analyzer.isAnalyzing) {
      this.callbacks.onNotice('Analysis already running — wait for it to finish.');
      return;
    }
    await this.analyzer.analyze(
      editor.document,
      `Manually analyzing ${vscode.workspace.asRelativePath(editor.document.uri)}…`,
      undefined,
      { bypassCooldown: true, force: true, turnId: this.nextWatchId() } // 内容没变也分析（测试 prompt/链路时需要）
    );
  }

  // 用户声称已手动修复某条建议（点了「✓ 改好了」）→ 闸门判定（confirmGate）→ 必要时绕过冷却复审。
  // 问题的身份是论断不是坐标：修复可能落在别的文件，所以闸门要带上全工作区的编辑视野，
  // 复审 prompt 也要把「哪些文件动过、和建议什么关系」作为取证线索交给模型。
  async confirmFix(absolutePath: string, s: Suggestion): Promise<ConfirmResult> {
    if (!this.isEnabled() || this.callbacks.isBusy()) {
      return { status: 'busy' };
    }
    try {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(absolutePath));
      const rel = vscode.workspace.asRelativePath(doc.uri);
      // 无 shownAt 打戳（理论上的老建议）→ 按 0 算：一切追踪到的编辑都算「之后」，最保守
      const since = s.shownAt ?? 0;
      const otherEdited = this.editTracker.filesEditedAfter(since, rel);
      const relations = this.importGraph.related(rel);
      const whyOf = new Map(relations.map((r) => [r.file, r.why]));
      const relatedEdited = otherEdited.filter((f) => whyOf.has(f));
      const gate = decideConfirmGate({
        fileChanged: this.analyzer.hasUnanalyzedChanges(doc),
        suggestionLine: s.line,
        diff: this.analyzer.diffVsLastAnalysis(doc),
        otherEdited,
        relatedEdited,
      });
      if (gate === 'unchanged') {
        return { status: 'unchanged' };
      }
      if (gate === 'untouched') {
        return { status: 'untouched' };
      }
      const editedHint =
        otherEdited.length > 0
          ? `\nFiles edited since this note was shown: ${otherEdited
              .map((f) => `${f} (${whyOf.get(f) ?? 'no known relation to this file'})`)
              .join('; ')}.` +
            `\nThe fix may live in ANY of them — the issue is a claim about behavior, not about that specific line ` +
            `(e.g. a mismatch spotted at a call site can be fixed by changing the declaration). ` +
            `Use read_file to check the current state of the relevant files before judging.`
          : '';
      const suggestions = await this.analyzer.analyze(
        doc,
        `Verifying fix in ${rel}…`,
        `The user says they just manually fixed this issue: [L${s.level}] line ${s.line ?? '?'} "${s.title}" — ${s.detail}. Verify honestly: if it is actually fixed, do NOT report it again; only report problems that still exist or are newly introduced.${editedHint}`,
        { bypassCooldown: true, turnId: this.nextWatchId() } // 用户在回应我们的建议，这是最值得立刻反馈的时刻，不受冷却限制
      );
      return { status: 'reviewed', suggestions: suggestions ?? [] };
    } catch {
      return { status: 'busy' };
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) {
      clearTimeout(this.timer);
    }
    if (this.scanTimer) {
      clearTimeout(this.scanTimer);
    }
    this.analyzer.abortInFlight();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
