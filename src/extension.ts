/**
 * 插件入口与装配层。
 * 负责把各模块组装起来：共享上下文、日志、守望模块、编辑器标注、聊天面板，
 * 并注册所有命令。模块间的事件流转（守望 → 面板/标注/通知，Agent 写文件 → 守望复审）都在这里接线。
 */
import * as vscode from 'vscode';
import { ChatViewProvider } from './ui/chatView';
import { Companion } from './companion/companion';
import { AnnotationManager, Suggestion, levelIcon, LEVEL_LABEL } from './companion/annotations';
import { ActivityTracker } from './companion/activity';
import { SharedContext } from './memory/sharedContext';
import { Logger } from './core/logger';
import { UsageTracker } from './core/usage';
import { getApiKey, promptForApiKey, getConfig, languageDirective, learningMode } from './core/config';
import { chatCompletion } from './core/llm';
import { deepenPrompt, DeepenKind } from './agent/prompts';
import { Telemetry } from './core/telemetry';

function formatSummary(items: Suggestion[]): string {
  return items
    .map(
      (s) =>
        `${levelIcon(s.level)} L${s.level} ${LEVEL_LABEL[s.level]}${s.line ? ` · line ${s.line}` : ''} — ${s.title}\n${s.detail}`
    )
    .join('\n\n');
}

export function activate(context: vscode.ExtensionContext) {
  const logger = new Logger(context);
  const usage = new UsageTracker(context);
  const telemetry = new Telemetry(logger);
  const sharedContext = new SharedContext();
  const chatProvider = new ChatViewProvider(context, sharedContext, logger, usage, telemetry);
  const annotations = new AnnotationManager();
  const activity = new ActivityTracker();
  chatProvider.onFileWrittenLive = (abs) => activity.markAgentWrite(abs);

  // 埋点快照的统一口径：masked = 学习模式且非 L3 的 fix 被藏起（与 chatView 卡片逻辑一致）
  const snapOpts = (s: Suggestion) => ({ masked: learningMode() && s.level !== 3 && !!s.fix, learningMode: learningMode() });

  // 前端本地动作（不产生 LLM 调用）的埋点回传
  chatProvider.onUiEvent = (name, data) => {
    if (name === 'fix_revealed' && typeof data.uriStr === 'string' && typeof data.index === 'number') {
      const s = annotations.get(data.uriStr, data.index);
      if (s) {
        telemetry.fixRevealed(s, vscode.workspace.asRelativePath(vscode.Uri.parse(data.uriStr)), snapOpts(s));
      }
    }
  };

  // L3 打断：弹通知 + 自动在面板展开详情
  function notifyInterrupts(uri: vscode.Uri, items: Suggestion[]): void {
    const l3 = items.filter((s) => s.level === 3);
    if (l3.length === 0) {
      return;
    }
    const first = l3[0];
    const file = vscode.workspace.asRelativePath(uri);
    sharedContext.markViewed(file, first.line); // L3 自动展开 = 用户正在看这条
    telemetry.suggestionViewed(first, file, 'l3-auto', snapOpts(first));
    void vscode.window.showWarningMessage(
      `QuietPair: ${file}${first.line ? `:${first.line}` : ''} — ${first.title}${l3.length > 1 ? ` (${l3.length} critical issues)` : ''}`
    );
    chatProvider.showSuggestionCard(
      first,
      `${levelIcon(3)} ${file}${first.line ? `:${first.line}` : ''} — ${first.title}`,
      uri.toString(),
      items.indexOf(first)
    );
  }

  const companion = new Companion({
    getApiKey: () => getApiKey(context),
    isBusy: () => chatProvider.isBusy,
    onAnalysisStart: (id, file, label) => {
      logger.event('companion', { phase: 'start', file, label, summary: `companion: ${label}` });
      chatProvider.suggestionStart(id, file, label);
    },
    onAnalysisEnd: (id, file, uri, suggestions, rawText) => {
      logger.event('companion', {
        phase: 'end',
        file,
        count: suggestions.length,
        levels: suggestions.map((s) => s.level),
        rawFallback: !!rawText,
        suggestions: suggestions.map((s) => ({ line: s.line, level: s.level, title: s.title, detail: s.detail })),
        summary: `companion done: ${file} → ${suggestions.length} suggestions${rawText ? ' (raw fallback)' : ''}`,
      });
      annotations.set(uri, suggestions);
      if (suggestions.length > 0) {
        sharedContext.addSuggestions(file, suggestions);
        telemetry.suggestionShown(file, suggestions, learningMode());
        chatProvider.suggestionEnd(id, file, formatSummary(suggestions));
        notifyInterrupts(uri, suggestions);
      } else if (rawText) {
        chatProvider.suggestionEnd(id, file, rawText);
      } else {
        chatProvider.suggestionEnd(id, file, null);
      }
    },
    onInvalidate: (uri) => {
      telemetry.suggestionStale(vscode.workspace.asRelativePath(uri), annotations.count(uri));
      annotations.markPending(uri); // 编辑后标注降级为待确认，等新分析或用户点「✓ 改好了」
    },
    onNotice: (message) => chatProvider.notice(message),
    onDebug: (event, data) => logger.event('companion', { phase: event, ...data }),
    onUsage: (u) => {
      usage.add('companion', u);
      logger.event('usage', {
        source: 'companion',
        prompt: u.promptTokens,
        completion: u.completionTokens,
        summary: `usage companion: ${u.totalTokens} tokens (in ${u.promptTokens} / out ${u.completionTokens})`,
      });
    },
  }, activity);

  // Agent 的 analyze_code 工具：对话中触发守望分析（「帮我看看这段代码」）
  chatProvider.onRequestAnalysis = (p) => companion.analyzeRequested(p);

  // 建议卡片的按需深化：帮助阶梯的更深两级现场生成（展开说说=原理 / 给个例子=平行示例）
  chatProvider.onDeepenSuggestion = async (uriStr, index, kind: DeepenKind) => {
    const s = annotations.get(uriStr, index);
    if (!s) {
      return;
    }
    const apiKey = await getApiKey(context);
    if (!apiKey) {
      chatProvider.note('No API key', 'Set an API key first (key button above).');
      return;
    }
    const uri = vscode.Uri.parse(uriStr);
    const file = vscode.workspace.asRelativePath(uri);
    telemetry.deepenClicked(s, file, kind, snapOpts(s));
    logger.event('companion', { phase: 'deepen', file, kind, summary: `deepen (${kind}): ${s.title}` });
    try {
      // 上下文给建议行 ±40 行的窗口，够理解又不必整文件
      const doc = await vscode.workspace.openTextDocument(uri);
      const line = s.line ?? 1;
      const start = Math.max(0, line - 41);
      const end = Math.min(doc.lineCount, line + 40);
      const snippet = doc.getText(new vscode.Range(start, 0, end, 0));
      const { baseUrl, model } = getConfig();
      const result = await chatCompletion({
        baseUrl,
        apiKey,
        model,
        messages: [
          { role: 'system', content: deepenPrompt(kind) + languageDirective() },
          {
            role: 'user',
            content: `File: ${file}\n\n建议：【${s.title}】\n${s.detail}\n\n相关代码（第 ${start + 1}-${end} 行）：\n\`\`\`\n${snippet}\n\`\`\``,
          },
        ],
      });
      if (result.usage) {
        usage.add('companion', result.usage);
        logger.event('usage', {
          source: 'companion',
          prompt: result.usage.promptTokens,
          completion: result.usage.completionTokens,
          summary: `usage deepen: ${result.usage.totalTokens} tokens`,
        });
      }
      chatProvider.note(
        kind === 'example' ? `📎 Example — ${s.title}` : `💡 Deeper — ${s.title}`,
        result.content.trim() || '(empty response)'
      );
    } catch (err) {
      chatProvider.note('Deepen failed', err instanceof Error ? err.message : String(err));
    }
  };

  // 聊天 Agent 写完文件 → 守望立刻复审 → 自动闭环：
  // 干净 → 静默确认；L2/L3 → 回灌给 Agent 自我修正（最多 2 轮，防乒乓）；到顶摊牌给用户
  let reviewRounds = 0;
  const MAX_REVIEW_ROUNDS = 2;
  chatProvider.onFilesWritten = (paths) => {
    logger.event('lifecycle', { summary: `agent wrote files → review: ${paths.join(', ')}` });
    void (async () => {
      const results = await companion.reviewFiles(paths);
      const produced = results.filter((r) => r.suggestions !== null);
      if (produced.length === 0) {
        return; // 复审没跑成（聊天任务运行中等），保持安静，不要误报「通过」
      }
      const issuesByFile = produced
        .map((r) => ({ file: r.file, issues: (r.suggestions as Suggestion[]).filter((s) => s.level >= 2) }))
        .filter((r) => r.issues.length > 0);

      if (issuesByFile.length === 0) {
        // 复审干净（只有 L1 或没问题）：标注已被新结果静默刷新，只记 transcript，不打扰用户
        reviewRounds = 0;
        logger.event('lifecycle', { summary: 'review passed: agent change is clean (silent)' });
        return;
      }

      const issuesText = issuesByFile
        .map((r) => `【${r.file}】\n${formatSummary(r.issues)}`)
        .join('\n\n');

      if (reviewRounds >= MAX_REVIEW_ROUNDS) {
        // 自动来回两轮还没过：停止乒乓，把问题摊开给用户决定
        reviewRounds = 0;
        logger.event('lifecycle', { summary: 'review loop capped, handing to user' });
        chatProvider.note(
          '🤔 Review still failing — your call',
          `The agent and the watcher have gone back and forth ${MAX_REVIEW_ROUNDS} rounds and the watcher still sees problems. Your call: hit Discuss, Fix for me, or tell us the code is fine as is.\n\n${issuesText}`
        );
        return;
      }

      reviewRounds++;
      logger.event('lifecycle', { summary: `review failed (round ${reviewRounds}) → feeding back to agent` });
      await chatProvider.observerFollowUp(
        `[守望复审反馈] 你刚才的修改复审没通过（第 ${reviewRounds} 轮）：\n\n${issuesText}\n\n请判断：确实是问题就继续修（write_file 仍需审批）；如果你认为这样写是对的，解释理由，不用改。`
      );
    })();
  };

  context.subscriptions.push(
    logger,
    companion,
    annotations,
    activity,
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewId, chatProvider),
    vscode.commands.registerCommand('vs-agent.setApiKey', async () => {
      const key = await promptForApiKey(context);
      if (key) {
        vscode.window.showInformationMessage('QuietPair API key saved.');
      }
    }),
    vscode.commands.registerCommand('vs-agent.clearChat', () => chatProvider.clear()),
    vscode.commands.registerCommand('vs-agent.initProject', () => chatProvider.initProject()),
    vscode.commands.registerCommand('vs-agent.analyzeNow', () => companion.analyzeNow()),
    vscode.commands.registerCommand('vs-agent.openSettings', () =>
      vscode.commands.executeCommand('workbench.action.openSettings', '@ext:herta.vs-agent')
    ),
    vscode.commands.registerCommand('vs-agent.openLogs', async () => {
      const choice = await vscode.window.showQuickPick(
        [
          { label: '$(file-code) Open session transcript (JSONL)', action: 'transcript' },
          { label: '$(output) Open live log (Output panel)', action: 'output' },
          { label: '$(folder-opened) Reveal log directory', action: 'folder' },
        ],
        { title: 'QuietPair Logs' }
      );
      if (choice?.action === 'transcript') {
        await logger.showTranscript();
      } else if (choice?.action === 'output') {
        logger.showOutput();
      } else if (choice?.action === 'folder') {
        await logger.openLogsFolder();
      }
    }),
    vscode.commands.registerCommand('vs-agent.showSuggestion', (uriStr: string, index: number) => {
      const s = annotations.get(uriStr, index);
      if (!s) {
        return;
      }
      const file = vscode.workspace.asRelativePath(vscode.Uri.parse(uriStr));
      sharedContext.markViewed(file, s.line); // 用户点开了这条 = 后续模糊提问大概率指它
      telemetry.suggestionViewed(s, file, 'codelens', snapOpts(s));
      chatProvider.showSuggestionCard(
        s,
        `${levelIcon(s.level)} L${s.level} ${LEVEL_LABEL[s.level]} · ${file}${s.line ? `:${s.line}` : ''} — ${s.title}`,
        uriStr,
        index
      );
    }),
    vscode.commands.registerCommand('vs-agent.applySuggestion', async (uriStr: string, index: number) => {
      const s = annotations.get(uriStr, index);
      if (!s) {
        return;
      }
      const file = vscode.workspace.asRelativePath(vscode.Uri.parse(uriStr));
      reviewRounds = 0; // 新的修复任务开始，重置复审来回计数
      telemetry.suggestionAdopted(s, file, 'fix-for-me', snapOpts(s));
      await chatProvider.askAgent(
        `请把以下建议应用到 ${file}${s.line ? ` 第 ${s.line} 行附近` : ''}：\n\n【${s.title}】\n${s.detail}${s.fix ? `\n\n参考修复：\n${s.fix}` : ''}\n\n先用 read_file 确认现状，再用 write_file 修改。`
      );
    }),
    // 「✓ 改好了」：用户声称已手动修复 → 绕过冷却复审，确认消除或指出问题还在
    vscode.commands.registerCommand('vs-agent.confirmFixed', async (uriStr: string, index: number) => {
      const s = annotations.get(uriStr, index);
      if (!s) {
        return;
      }
      const uri = vscode.Uri.parse(uriStr);
      const relFile = vscode.workspace.asRelativePath(uri);
      sharedContext.markViewed(relFile, s.line);
      logger.event('lifecycle', { summary: `confirm fix requested: ${s.title}` });
      const result = await companion.confirmFix(uri.fsPath, s);

      if (result.status === 'busy') {
        logger.event('lifecycle', { summary: `confirm fix deferred (busy): ${s.title}` });
        chatProvider.note('⏳ One moment', 'The chat agent is still running a task; confirm with Fixed once it finishes.');
        return;
      }
      if (result.status === 'unchanged') {
        // 当前代码就是最新分析过的版本：这条标注本身就是最新判断，无需再调 LLM
        logger.event('lifecycle', { summary: `confirm rejected (already analyzed, still flagged): ${s.title}` });
        telemetry.confirmUnchanged(s, relFile, snapOpts(s));
        chatProvider.note(
          '🔍 This is already the latest verdict on the current code',
          `"${s.title}" — you have not changed the code (or this version was just analyzed); the issue still stands.\n${s.detail}\n\nWant me to fix it: hit Fix for me above the line. Think I am wrong: hit Discuss and let's hash it out.`
        );
        return;
      }

      // 判定修复：复审后原位置（±3 行）没有同级及以上问题就算修好
      const remaining = result.suggestions.filter((x) => x.line && s.line && Math.abs(x.line - s.line) <= 3 && x.level >= s.level);
      if (remaining.length === 0) {
        logger.event('lifecycle', { summary: `fix verified: ${s.title}` });
        telemetry.suggestionAdopted(s, relFile, 'confirm-verified', snapOpts(s));
        chatProvider.note('✓ Fix confirmed', `"${s.title}" is clean now.`);
      } else {
        logger.event('lifecycle', { summary: `fix rejected: ${s.title}, ${remaining.length} issues remain` });
        telemetry.suggestionRejected(s, relFile, remaining.length, snapOpts(s));
        chatProvider.note(
          `🔄 Review: the issue may still be there`,
          remaining.map((x) => `L${x.level} line ${x.line} — ${x.title}\n${x.detail}`).join('\n\n')
        );
      }
    }),
    // 「💬 讨论」：一键把建议带进聊天引用 chip，用户输入问题即可
    vscode.commands.registerCommand('vs-agent.discussSuggestion', (uriStr: string, index: number) => {
      const s = annotations.get(uriStr, index);
      if (!s) {
        return;
      }
      const file = vscode.workspace.asRelativePath(vscode.Uri.parse(uriStr));
      sharedContext.markViewed(file, s.line);
      telemetry.suggestionDiscussed(s, file, snapOpts(s));
      chatProvider.discussSuggestion(
        `${levelIcon(s.level)} L${s.level} ${LEVEL_LABEL[s.level]} · ${file}${s.line ? `:${s.line}` : ''} — ${s.title}`,
        `${s.detail}${s.fix ? `\n\nSuggested fix:\n${s.fix}` : ''}`
      );
    })
  );

  companion.schedule();
}

export function deactivate() {}
