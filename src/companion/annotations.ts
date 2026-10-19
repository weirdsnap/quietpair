/**
 * 编辑器内的建议标注：把守望产出的结构化建议画到代码上。
 * L1 观察 → 仅 CodeLens；L2 提醒 → 黄色波浪线 + 问题面板(Warning)；
 * L3 打断 → 红色波浪线 + 问题面板(Error)。
 * 每条建议带三个操作：✓ 改好了（LLM 复审确认）/ 🔧 帮我改（转聊天 Agent）/ 💬 讨论（带进聊天）。
 * 用户编辑文件后标注进入「待确认」状态（变暗保留、退出问题面板），
 * 等新分析刷新或用户点 ✓ 确认——标注是有新鲜度状态的观察，不是一次性通知。
 */
import * as vscode from 'vscode';

export type SuggestionLevel = 1 | 2 | 3;

export interface Suggestion {
  line?: number;
  level: SuggestionLevel;
  title: string;
  detail: string;
  fix?: string;
  reflect?: string; // 元认知提问：帮用户以后更早自己发现这类问题
  pending?: boolean; // 待确认：用户编辑过该文件，AI 还没确认新内容
}

export const LEVEL_LABEL: Record<SuggestionLevel, string> = {
  1: 'Note',
  2: 'Warning',
  3: 'Urgent',
};

export function levelIcon(level: SuggestionLevel): string {
  return level === 3 ? '🚨' : level === 2 ? '⚠️' : '💡';
}

export class AnnotationManager implements vscode.Disposable {
  private suggestions = new Map<string, Suggestion[]>();
  private changeEmitter = new vscode.EventEmitter<void>();
  private diagnosticCollection = vscode.languages.createDiagnosticCollection('vs-agent');
  private disposables: vscode.Disposable[] = [];

  // L2 提醒：黄色波浪线；L3 打断：红色波浪线。L1 观察不划线，只挂 CodeLens。
  private warningDeco = vscode.window.createTextEditorDecorationType({
    textDecoration: 'underline wavy #cca700',
    overviewRulerColor: '#cca700',
    overviewRulerLane: vscode.OverviewRulerLane.Right,
  });

  private errorDeco = vscode.window.createTextEditorDecorationType({
    textDecoration: 'underline wavy #f14c4c',
    overviewRulerColor: '#f14c4c',
    overviewRulerLane: vscode.OverviewRulerLane.Right,
  });

  // 待确认状态：同样的波浪线但大幅变淡，提示「AI 还没确认你改过的内容」
  private warningPendingDeco = vscode.window.createTextEditorDecorationType({
    textDecoration: 'underline wavy #cca700',
    opacity: '0.35',
  });

  private errorPendingDeco = vscode.window.createTextEditorDecorationType({
    textDecoration: 'underline wavy #f14c4c',
    opacity: '0.35',
  });

  constructor() {
    this.disposables.push(
      this.changeEmitter,
      this.diagnosticCollection,
      this.warningDeco,
      this.errorDeco,
      this.warningPendingDeco,
      this.errorPendingDeco,
      vscode.languages.registerCodeLensProvider(
        { scheme: 'file' },
        {
          onDidChangeCodeLenses: this.changeEmitter.event,
          provideCodeLenses: (doc) => this.provideCodeLenses(doc),
        }
      )
    );
  }

  set(uri: vscode.Uri, items: Suggestion[]): void {
    this.suggestions.set(uri.toString(), items);
    this.refresh(uri);
    this.changeEmitter.fire();
  }

  clear(uri: vscode.Uri): void {
    if (this.suggestions.delete(uri.toString())) {
      this.refresh(uri);
      this.changeEmitter.fire();
    }
  }

  // 用户编辑了文件：标注不消失，降级为待确认（变暗 + 退出问题面板），
  // 等下一次分析刷新，或用户点「✓ 改好了」触发复审
  markPending(uri: vscode.Uri): void {
    const items = this.suggestions.get(uri.toString());
    if (!items || items.length === 0) {
      return;
    }
    for (const s of items) {
      s.pending = true;
    }
    this.refresh(uri);
    this.changeEmitter.fire();
  }

  get(uriStr: string, index: number): Suggestion | undefined {
    return this.suggestions.get(uriStr)?.[index];
  }

  private refresh(uri: vscode.Uri): void {
    const key = uri.toString();
    const items = this.suggestions.get(key) ?? [];

    // 问题面板（Diagnostics）：L2 → Warning，L3 → Error，L1 和待确认的不进面板（避免过期报错吓人）
    const diagnostics: vscode.Diagnostic[] = [];
    const doc = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === key)?.document;
    const lineCount = doc?.lineCount;
    items.forEach((s) => {
      if (s.level === 1 || s.pending || !s.line || (lineCount !== undefined && (s.line < 1 || s.line > lineCount))) {
        return;
      }
      const range = doc
        ? doc.lineAt(s.line - 1).range
        : new vscode.Range(s.line - 1, 0, s.line - 1, Number.MAX_SAFE_INTEGER);
      const diag = new vscode.Diagnostic(
        range,
        `[${LEVEL_LABEL[s.level]}] ${s.title} — ${s.detail}`,
        s.level === 3 ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning
      );
      diag.source = 'QuietPair';
      diagnostics.push(diag);
    });
    if (diagnostics.length > 0) {
      this.diagnosticCollection.set(uri, diagnostics);
    } else {
      this.diagnosticCollection.delete(uri);
    }

    // 编辑器装饰
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.toString() !== key) {
        continue;
      }
      const warnings: vscode.DecorationOptions[] = [];
      const errors: vscode.DecorationOptions[] = [];
      const pendingWarnings: vscode.DecorationOptions[] = [];
      const pendingErrors: vscode.DecorationOptions[] = [];
      items.forEach((s, index) => {
        if (s.level === 1 || !s.line || s.line < 1 || s.line > editor.document.lineCount) {
          return;
        }
        const line = editor.document.lineAt(s.line - 1);
        const deco: vscode.DecorationOptions = {
          range: line.range,
          hoverMessage: this.buildHover(key, index, s),
        };
        if (s.pending) {
          (s.level === 3 ? pendingErrors : pendingWarnings).push(deco);
        } else {
          (s.level === 3 ? errors : warnings).push(deco);
        }
      });
      editor.setDecorations(this.warningDeco, warnings);
      editor.setDecorations(this.errorDeco, errors);
      editor.setDecorations(this.warningPendingDeco, pendingWarnings);
      editor.setDecorations(this.errorPendingDeco, pendingErrors);
    }
  }

  private buildHover(uriStr: string, index: number, s: Suggestion): vscode.MarkdownString {
    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = true;
    if (s.pending) {
      md.appendMarkdown(`_⏳ You edited the code; this note has not been re-confirmed yet_\n\n`);
    }
    md.appendMarkdown(`**${levelIcon(s.level)} L${s.level} ${LEVEL_LABEL[s.level]} · ${s.title}**\n\n${s.detail}`);
    if (s.fix) {
      md.appendMarkdown(`\n\nSuggested fix:\n\`\`\`\n${s.fix}\n\`\`\``);
    }
    if (s.reflect) {
      md.appendMarkdown(`\n\n🪞 _${s.reflect}_`);
    }
    const args = encodeURIComponent(JSON.stringify([uriStr, index]));
    md.appendMarkdown(
      `\n\n[$(check) Fixed](command:vs-agent.confirmFixed?${args} "I fixed it; ask the AI to re-confirm") · [$(wrench) Fix for me](command:vs-agent.applySuggestion?${args} "Hand to the chat agent; writing files needs approval") · [$(comment-discussion) Discuss](command:vs-agent.discussSuggestion?${args} "Bring into chat") · [$(notebook) Details](command:vs-agent.showSuggestion?${args} "View in panel")`
    );
    return md;
  }

  private provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const items = this.suggestions.get(doc.uri.toString()) ?? [];
    const lenses: vscode.CodeLens[] = [];
    items.forEach((s, index) => {
      if (!s.line || s.line < 1 || s.line > doc.lineCount) {
        return;
      }
      const range = doc.lineAt(s.line - 1).range;
      const uriStr = doc.uri.toString();
      const icon = s.level === 3 ? '$(error)' : s.level === 2 ? '$(warning)' : '$(lightbulb)';
      lenses.push(
        new vscode.CodeLens(range, {
          title: `${icon} ${s.pending ? 'Stale: ' : ''}${s.title}`,
          tooltip: s.detail,
          command: 'vs-agent.showSuggestion',
          arguments: [uriStr, index],
        }),
        // 三个操作：确认修复 / 帮我改 / 讨论（图标 + 文字标签，语义不藏在 tooltip 里）
        new vscode.CodeLens(range, {
          title: '$(check) Fixed',
          tooltip: 'I fixed it; ask the AI to re-confirm',
          command: 'vs-agent.confirmFixed',
          arguments: [uriStr, index],
        }),
        new vscode.CodeLens(range, {
          title: '$(wrench) Fix for me',
          tooltip: 'Hand to the chat agent (writing files needs approval)',
          command: 'vs-agent.applySuggestion',
          arguments: [uriStr, index],
        }),
        new vscode.CodeLens(range, {
          title: '$(comment-discussion) Discuss',
          tooltip: 'Bring this into the chat for discussion',
          command: 'vs-agent.discussSuggestion',
          arguments: [uriStr, index],
        })
      );
    });
    return lenses;
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
