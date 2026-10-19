/**
 * 侧边栏聊天面板（Webview）的后端。
 * - 持有单会话对话历史（workspaceState 持久化：一个项目一条持续线程）
 * - 组装 system prompt：伙伴人设 + 项目记忆 + 守望上下文
 * - 驱动 Agent 工具循环，处理审批、打断/插话、历史压缩
 * - 与 media/chat.js 前端通信（消息流、设置页、建议卡片）
 */
import * as vscode from 'vscode';
import { ChatMessage, chatCompletion } from '../core/llm';
import { runAgent, SYSTEM_PROMPT } from '../agent/agent';
import { GUIDE_PROMPT, INIT_PROMPT, LEARNING_POSTURE } from '../agent/prompts';
import type { ToolContext } from '../agent/tools';
import { getConfig, getApiKey, promptForApiKey, API_KEY_SECRET, languageDirective, learningMode } from '../core/config';
import { SharedContext } from '../memory/sharedContext';
import { Logger } from '../core/logger';
import { UsageTracker } from '../core/usage';
import { memoryStore, MEMORY_TEMPLATE } from '../memory/store';
import type { Suggestion } from '../companion/annotations';
import type { Telemetry } from '../core/telemetry';

const HISTORY_KEY = 'vsAgent.history';
const HISTORY_PERSIST_LIMIT = 150;
const COMPACT_THRESHOLD_CHARS = 60000;
const COMPACT_KEEP_RECENT = 12;

export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'vs-agent.chatView';

  private view?: vscode.WebviewView;
  private history: ChatMessage[] = [{ role: 'system', content: SYSTEM_PROMPT }];
  private pendingApprovals = new Map<string, (approved: boolean) => void>();
  private pendingChoices = new Map<string, (answer: string) => void>();
  private running = false;
  private writtenFiles: string[] = [];
  private currentAbort: AbortController | null = null;
  private abortWaiters: Array<() => void> = [];
  private lastActivity = '';
  private runBuffer = '';
  private reasoningBuffer = '';
  // 一次 handleSend/runAgent 运行 = 一个 chat-N，把这轮的 思考/工具/审批/回答 圈成一个闭环
  private turnCounter = 0;
  private currentTurnId = '';

  // Agent 跑完且期间写过文件时触发（交给守望模式复审）
  onFilesWritten?: (absolutePaths: string[]) => void;

  // Agent 每次写文件的实时回调（用于活动缓冲区排除 Agent 自己的写入）
  onFileWrittenLive?: (absolutePath: string) => void;

  // Agent 的 analyze_code 工具（对话中触发守望分析），由装配层接到 Companion
  onRequestAnalysis?: (path?: string) => Promise<string>;

  // 建议卡片的按需深化（展开说说 / 给个例子），由装配层接到一次性的 deepen LLM 调用
  onDeepenSuggestion?: (uriStr: string, index: number, kind: 'explain' | 'example') => void;

  // 前端本地动作的埋点回传（如 fix_revealed：本地拉开藏起的 fix，不产生 LLM 调用，必须主动上报）
  onUiEvent?: (name: string, data: Record<string, unknown>) => void;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly sharedContext: SharedContext,
    private readonly logger: Logger,
    private readonly usage: UsageTracker,
    private readonly telemetry?: Telemetry
  ) {
    // 单会话：一个项目一条持续线程，重开 VS Code 接着聊
    const saved = context.workspaceState.get<ChatMessage[]>(HISTORY_KEY);
    if (Array.isArray(saved) && saved.length > 0 && saved[0]?.role === 'system') {
      this.history = saved;
    }
    this.usage.onChange = () => this.postUsage();
    // Activity 视图的实时推送：logger 是唯一事件源，面板只是订阅者
    this.logger.onEvent((entry) => this.post({ type: 'activityEvent', entry }));
  }

  // 工具栏小计数：本次会话 + 累计（按来源细分放 tooltip）
  private postUsage(): void {
    this.post({
      type: 'usage',
      session: this.usage.sessionTotals(),
      bySource: this.usage.bySourceTotals(),
      allTime: this.usage.allTime(),
    });
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
    };
    view.webview.html = this.getHtml(view.webview);
    view.webview.onDidReceiveMessage((msg) => this.handleMessage(msg));
  }

  clear(): void {
    this.history = [{ role: 'system', content: SYSTEM_PROMPT }];
    void this.context.workspaceState.update(HISTORY_KEY, undefined);
    this.post({ type: 'cleared' });
  }

  get isBusy(): boolean {
    return this.running;
  }

  // 建议详情卡（结构化）：帮助阶梯的展示层——detail 直接给，reflect 元认知提问随行，
  // fix 在学习模式且非 L3 时先藏起（masked），用户点「直接给方案」才拉开
  showSuggestionCard(s: Suggestion, title: string, uriStr: string, index: number): void {
    this.view?.show(true);
    this.post({
      type: 'suggestionCard',
      title,
      detail: s.detail,
      reflect: s.reflect,
      fix: s.fix,
      masked: learningMode() && s.level !== 3 && !!s.fix,
      uriStr,
      index,
    });
  }

  // 低调提示：只进面板，不抢焦点（修复确认结果等场景用）
  note(title: string, text: string): void {
    this.post({ type: 'note', title, text });
  }

  // 守望复审未通过时的自动回灌：以「守望反馈」的身份给 Agent 发后续消息，
  // 让它自我修正。不抢面板焦点（区别于 askAgent），过程在面板可见、可打断
  async observerFollowUp(text: string): Promise<void> {
    this.logger.event('lifecycle', { summary: `observer follow-up: ${text.slice(0, 200)}` });
    await this.handleSend(text);
  }

  // 从编辑器一键发起讨论：面板弹出 + 建议进入引用 chip，用户输入问题即可
  discussSuggestion(title: string, body: string): void {
    this.view?.show(true);
    this.post({ type: 'setQuote', title, body });
  }

  async askAgent(text: string): Promise<void> {
    this.view?.show(true);
    await this.handleSend(text);
  }

  // init：先让用户选模式（代码层确定性分支，不依赖模型自觉）——
  // 带我读一遍（引导式，用户自己读懂项目）/ 帮我总结（agent 代读）/ 我已熟悉（跳过）。
  // 复用正常对话流程，用户能看到探索过程、可以打断，完成后这轮对话也留在历史里
  async initProject(): Promise<void> {
    this.view?.show(true);
    this.logger.event('lifecycle', { summary: 'init project memory requested' });

    const answer = await this.requestChoice('How would you like to start?', [
      { label: 'Guide me through it', description: 'I give you a reading map and accompany you stop by stop — you build the mental model yourself (recommended)' },
      { label: 'Summarize for me', description: 'I explore the project and write the overview into project memory' },
      { label: 'I know it already', description: 'Skip initialization and start right away' },
    ]);
    this.logger.event('lifecycle', { summary: `init mode chosen: ${answer.slice(0, 100)}` });

    if (answer.startsWith('C.') || answer.includes('未做选择')) {
      this.note('Initialization skipped', 'Click "Init" anytime to start over, or just start chatting.');
      return;
    }
    // 自定义输入视为对所选剧本的补充说明，拼在剧本前面
    const isPreset = answer.startsWith('A.') || answer.startsWith('B.');
    const supplement = isPreset ? '' : `补充说明（用户）：${answer}\n\n`;
    const script = answer.startsWith('B.') ? INIT_PROMPT : GUIDE_PROMPT;
    await this.handleSend(supplement + script);
  }

  suggestionStart(id: string, file: string, label?: string): void {
    this.post({ type: 'suggestionStart', id, file, label });
  }

  suggestionEnd(id: string, file: string, content: string | null): void {
    this.post({ type: 'suggestionEnd', id, file, content });
  }

  notice(message: string): void {
    this.post({ type: 'error', message });
  }

  // system prompt = 伙伴人设 + 项目记忆 + 守望上下文
  private async buildSystemPrompt(): Promise<string> {
    let prompt = SYSTEM_PROMPT;

    const memory = await memoryStore.read();
    prompt += `\n\n## 项目记忆（.vs-agent/memory.md）\n${memory.trim() ? memory : '（还没有记忆，对话中学到值得长期记住的事就用 update_memory 建立）'}`;

    const summary = this.sharedContext.summarize();
    if (summary) {
      prompt += `

The companion (code watcher) recently raised these suggestions. The user may refer to them as "刚才的建议"、"标红的那行" etc. — resolve such references using this list. The entry marked ← 用户正在看这条 is the one currently open in the user's panel: when the user asks a vague question like "什么意思" or "这条怎么办", assume they mean that entry:
${summary}`;
    }

    // 权限模式写进 prompt：让模型别去调用注定被拒的工具，也给用户正确的预期
    const mode = this.permissionMode();
    if (mode === 'discuss') {
      prompt += `\n\n## 当前权限：只读讨论\n你没有 write_file / run_command / update_memory 的权限（调了也会被直接拒绝）。这一轮只做讨论、分析和给方案，把动手留给用户。`;
    } else if (mode === 'yolo') {
      prompt += `\n\n## 当前权限：写操作已预授权\n写文件、跑命令不再逐次弹窗，但原则不变：用户明确要求时才动手。`;
    }
    prompt += languageDirective();
    if (learningMode()) {
      prompt += `\n\n${LEARNING_POSTURE}`;
    }
    return prompt;
  }

  // discuss = 只给建议；ask = 写操作弹审批（默认）；yolo = 写操作预授权
  private permissionMode(): 'discuss' | 'ask' | 'yolo' {
    const m = vscode.workspace.getConfiguration('vsAgent').get<string>('permissionMode', 'ask');
    return m === 'discuss' || m === 'yolo' ? m : 'ask';
  }

  // 权限模式 → 工具上下文：缺哪个能力，对应工具在 tools.ts 里默认拒绝（discuss 连弹窗都不会出）
  private buildToolContext(): ToolContext {
    const mode = this.permissionMode();
    const ctx: ToolContext = {
      onFileWritten: (abs) => {
        this.writtenFiles.push(abs);
        this.onFileWrittenLive?.(abs);
      },
      requestAnalysis: (p) => this.onRequestAnalysis?.(p) ?? Promise.resolve('Analysis capability is not connected.'),
      // 选项卡在 discuss 模式下也可用——它就是讨论的一部分
      requestChoice: (q, o) => this.requestChoice(q, o),
    };
    if (mode === 'discuss') {
      return ctx; // 不注入 memory / requestApproval：写文件、跑命令、写记忆全部被工具层拒绝
    }
    ctx.memory = memoryStore;
    ctx.requestApproval =
      mode === 'yolo'
        ? (action, detail) => {
            // yolo 自动放行，但每次操作都记 transcript，可审计
            this.logger.event('approval', { turnId: this.currentTurnId, action, detail: detail.slice(0, 500), decision: 'auto (yolo)', summary: `approval auto-granted (yolo): ${action}` });
            return Promise.resolve(true);
          }
        : (action, detail) => {
            this.logger.event('approval', { turnId: this.currentTurnId, action, detail: detail.slice(0, 500), summary: `approval requested: ${action}` });
            return this.requestApproval(action, detail);
          };
    return ctx;
  }

  private estimateHistoryChars(): number {
    return this.history.reduce(
      (n, m) => n + (typeof m.content === 'string' ? m.content.length : 0) + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0),
      0
    );
  }

  // 压缩：历史太长时把旧轮次蒸馏成摘要，近期保持原文（对标 Claude Code 的 compaction）。
  // 同一次蒸馏顺带做记忆沉淀：值得长期记住的条目按分区合并进 memory.md（增量合并，不覆写人类编辑）
  private async compactIfNeeded(baseUrl: string, apiKey: string, model: string): Promise<void> {
    if (this.estimateHistoryChars() < COMPACT_THRESHOLD_CHARS || this.history.length <= COMPACT_KEEP_RECENT + 2) {
      return;
    }
    const old = this.history.slice(1, this.history.length - COMPACT_KEEP_RECENT);
    const recent = this.history.slice(this.history.length - COMPACT_KEEP_RECENT);
    // 开头不能是孤儿 tool 消息（没有对应的 assistant tool_calls 会被 API 拒绝）
    while (recent.length > 0 && recent[0].role === 'tool') {
      recent.shift();
    }
    if (old.length === 0) {
      return;
    }
    const serialized = old
      .map((m) => `${m.role}: ${(typeof m.content === 'string' ? m.content : '').slice(0, 2000)}`)
      .join('\n\n')
      .slice(0, 40000);
    const memory = await memoryStore.read();
    try {
      const result = await chatCompletion({
        baseUrl,
        apiKey,
        model,
        messages: [
          {
            role: 'user',
            content: `你是对话压缩器。处理以下 AI 结对编程对话，只输出一个 JSON（不要 markdown 围栏、不要解释）：
{"summary": "<对话摘要：用户的真实意图与决定、AI 做过的操作与结果、未完成的事项、关键技术细节（文件名、方案名、结论）。要点列表，300 字以内>",
"memory": [{"section": "<项目概况|偏好与约定|重要决策|进行中|禁区>", "entry": "<一句话条目>"}]}
memory 只收值得长期记住的内容（项目约定、用户偏好、重要决策带日期、用户拒绝过的建议），琐碎的一次性信息不要收；不要和已有记忆重复；没有就给空数组。

已有项目记忆：
${memory || '(空)'}

对话内容：
${serialized}`,
          },
        ],
      });
      const { content } = result;
      this.usage.add('compact', result.usage);
      this.logger.event('usage', {
        source: 'compact',
        prompt: result.usage?.promptTokens,
        completion: result.usage?.completionTokens,
        summary: `usage compact: ${result.usage?.totalTokens ?? '?'} tokens`,
      });
      const match = content.match(/\{[\s\S]*\}/);
      let parsed: any = null;
      try {
        parsed = match ? JSON.parse(match[0]) : null;
      } catch {
        parsed = null; // 模型没按格式输出时退化为纯摘要，记忆沉淀这轮跳过
      }
      const summary = typeof parsed?.summary === 'string' && parsed.summary.trim() ? parsed.summary.trim() : content;
      const additions = Array.isArray(parsed?.memory)
        ? parsed.memory.filter((m: any) => m && typeof m.section === 'string' && typeof m.entry === 'string')
        : [];
      this.history = [
        this.history[0],
        { role: 'user', content: `[此前对话的压缩摘要]\n${summary}` },
        ...recent,
      ];
      const added = await memoryStore.appendEntries(additions);
      this.logger.event('lifecycle', {
        summary: `history compacted: ${old.length} messages → summary, ${added} memory entries`,
        memoryAdded: added,
      });
      this.post({
        type: 'note',
        title: '🗜 Conversation compacted',
        text: `${old.length} earlier messages were distilled into a summary; recent turns are kept verbatim. The full record remains in the transcript logs.${added > 0 ? `\n\n${added} durable note(s) were also merged into project memory (.vs-agent/memory.md).` : ''}`,
      });
    } catch (err) {
      this.logger.error(`compaction failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private companionEnabled(): boolean {
    return vscode.workspace.getConfiguration('vsAgent').get<boolean>('companion.enabled', true);
  }

  private async sendSettings(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('vsAgent');
    const apiKey = await getApiKey(this.context);
    this.post({
      type: 'settings',
      settings: {
        baseUrl: cfg.get<string>('baseUrl', 'https://api.deepseek.com/v1'),
        model: cfg.get<string>('model', 'deepseek-chat'),
        apiKey: apiKey ?? '',
        permissionMode: cfg.get<string>('permissionMode', 'ask'),
        companionEnabled: cfg.get<boolean>('companion.enabled', true),
        debounceSeconds: cfg.get<number>('companion.debounceSeconds', 10),
        quickTriggerSeconds: cfg.get<number>('companion.quickTriggerSeconds', 3),
        cooldownSeconds: cfg.get<number>('companion.cooldownSeconds', 300),
        responseLanguage: cfg.get<string>('responseLanguage', 'zh'),
        learningMode: cfg.get<boolean>('learningMode', false),
      },
    });
  }

  private async saveSettings(s: Record<string, unknown>): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('vsAgent');
    const baseUrl = String(s.baseUrl ?? '').trim();
    const model = String(s.model ?? '').trim();
    await cfg.update('baseUrl', baseUrl || 'https://api.deepseek.com/v1', vscode.ConfigurationTarget.Global);
    await cfg.update('model', model || 'deepseek-chat', vscode.ConfigurationTarget.Global);
    const mode = ['discuss', 'ask', 'yolo'].includes(String(s.permissionMode)) ? String(s.permissionMode) : 'ask';
    await cfg.update('permissionMode', mode, vscode.ConfigurationTarget.Global);
    await cfg.update('companion.enabled', !!s.companionEnabled, vscode.ConfigurationTarget.Global);
    await cfg.update('companion.debounceSeconds', Math.max(3, Number(s.debounceSeconds) || 10), vscode.ConfigurationTarget.Global);
    await cfg.update('companion.quickTriggerSeconds', Math.max(1, Number(s.quickTriggerSeconds) || 3), vscode.ConfigurationTarget.Global);
    await cfg.update('companion.cooldownSeconds', Math.max(10, Number(s.cooldownSeconds) || 300), vscode.ConfigurationTarget.Global);
    const lang = String(s.responseLanguage) === 'en' ? 'en' : 'zh';
    await cfg.update('responseLanguage', lang, vscode.ConfigurationTarget.Global);
    const prevLearning = learningMode();
    await cfg.update('learningMode', !!s.learningMode, vscode.ConfigurationTarget.Global);
    if (!!s.learningMode !== prevLearning) {
      this.telemetry?.modeSwitched(!!s.learningMode, 'settings');
    }
    const key = String(s.apiKey ?? '').trim();
    if (key) {
      await this.context.secrets.store(API_KEY_SECRET, key);
    } else {
      await this.context.secrets.delete(API_KEY_SECRET);
    }
    this.post({ type: 'settingsSaved' });
    this.postCompanionState();
    await this.sendSettings();
  }

  private postCompanionState(): void {
    this.post({ type: 'companionState', enabled: this.companionEnabled() });
  }

  private post(msg: unknown): void {
    this.view?.webview.postMessage(msg);
  }

  private requestApproval(action: string, detail: string): Promise<boolean> {
    return new Promise((resolve) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      this.pendingApprovals.set(id, resolve);
      this.post({ type: 'confirm', id, action, detail });
      // 任务被打断时，悬而未决的审批自动视为拒绝
      this.currentAbort?.signal.addEventListener(
        'abort',
        () => {
          if (this.pendingApprovals.delete(id)) {
            resolve(false);
          }
        },
        { once: true }
      );
    });
  }

  stopRun(): void {
    this.currentAbort?.abort();
  }

  // ask_user 工具的后端：发选项卡到面板，挂起等用户点选/自填；打断时视为跳过
  private requestChoice(question: string, options: { label: string; description?: string }[]): Promise<string> {
    return new Promise((resolve) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      this.pendingChoices.set(id, resolve);
      this.post({ type: 'choice', id, question, options });
      this.currentAbort?.signal.addEventListener(
        'abort',
        () => {
          if (this.pendingChoices.delete(id)) {
            resolve('（用户打断了这次提问，未做选择）');
          }
        },
        { once: true }
      );
    });
  }

  private async handleMessage(msg: {
    type: string;
    text?: string;
    id?: string;
    approved?: boolean;
    answer?: string;
    settings?: Record<string, unknown>;
    uriStr?: string;
    index?: number;
    kind?: string;
    name?: string;
  }): Promise<void> {
    switch (msg.type) {
      case 'send':
        if (msg.text) {
          await this.handleSend(msg.text);
        }
        break;
      case 'approve': {
        if (msg.id) {
          const resolve = this.pendingApprovals.get(msg.id);
          this.pendingApprovals.delete(msg.id);
          resolve?.(!!msg.approved);
          this.logger.event('approval', { turnId: this.currentTurnId, approved: !!msg.approved });
        }
        break;
      }
      case 'choiceAnswer': {
        if (msg.id) {
          const resolve = this.pendingChoices.get(msg.id);
          this.pendingChoices.delete(msg.id);
          const answer = String(msg.answer ?? '');
          resolve?.(answer);
          this.logger.event('user', { summary: `choice answered: ${answer.slice(0, 100)}` });
        }
        break;
      }
      case 'clear':
        this.clear();
        break;
      case 'stop':
        this.stopRun();
        this.logger.event('interrupt', { summary: 'user pressed stop' });
        break;
      case 'setApiKey':
        await vscode.commands.executeCommand('vs-agent.setApiKey');
        break;
      case 'openSettings':
        await vscode.commands.executeCommand('vs-agent.openSettings');
        break;
      case 'getSettings':
        await this.sendSettings();
        break;
      case 'saveSettings':
        if (msg.settings) {
          await this.saveSettings(msg.settings);
        }
        break;
      case 'toggleCompanion': {
        const next = !this.companionEnabled();
        await vscode.workspace
          .getConfiguration('vsAgent')
          .update('companion.enabled', next, vscode.ConfigurationTarget.Global);
        this.postCompanionState();
        break;
      }
      case 'toggleLearning': {
        const next = !learningMode();
        await vscode.workspace
          .getConfiguration('vsAgent')
          .update('learningMode', next, vscode.ConfigurationTarget.Global);
        this.telemetry?.modeSwitched(next, 'quick-toggle');
        // 快切走全局设置，按钮状态经 sendSettings 回推同步（设置页保存也走同一条路）
        await this.sendSettings();
        break;
      }
      case 'uiEvent':
        if (typeof msg.name === 'string') {
          this.onUiEvent?.(msg.name, msg);
        }
        break;
      case 'deepenSuggestion': {
        const kind = msg.kind === 'example' ? 'example' : 'explain';
        if (typeof msg.uriStr === 'string' && typeof msg.index === 'number') {
          this.onDeepenSuggestion?.(msg.uriStr, msg.index, kind);
        }
        break;
      }
      case 'ready':
        this.postCompanionState();
        this.postUsage();
        await this.sendSettings();
        break;
      case 'openLogs':
        await vscode.commands.executeCommand('vs-agent.openLogs');
        break;
      // Activity 视图打开时拉全量（之后的增量走 activityEvent 实时推送）
      case 'getActivityLog':
        this.post({ type: 'activityLog', entries: this.logger.recent() });
        break;
      case 'initProject':
        await this.initProject();
        break;
      case 'analyzeNow':
        await vscode.commands.executeCommand('vs-agent.analyzeNow');
        break;
      case 'setModel': {
        const m = String(msg.text ?? '').trim();
        if (m) {
          await vscode.workspace.getConfiguration('vsAgent').update('model', m, vscode.ConfigurationTarget.Global);
          await this.sendSettings();
        }
        break;
      }
      case 'setPermissionMode': {
        const mode = String(msg.text ?? '');
        if (mode === 'discuss' || mode === 'ask' || mode === 'yolo') {
          await vscode.workspace.getConfiguration('vsAgent').update('permissionMode', mode, vscode.ConfigurationTarget.Global);
          await this.sendSettings();
        }
        break;
      }
    }
  }

  private async handleSend(text: string): Promise<void> {
    // 结对编程式插话：AI 正在干活时发消息 = 先打断当前任务，再说新的
    if (this.running) {
      this.stopRun();
      await new Promise<void>((resolve) => this.abortWaiters.push(resolve));
    }

    let apiKey = await getApiKey(this.context);
    if (!apiKey) {
      apiKey = await promptForApiKey(this.context);
      if (!apiKey) {
        this.post({ type: 'error', message: 'No API key set. Use the key button above or the "QuietPair: Set API Key" command.' });
        return;
      }
    }

    const config = getConfig();
    this.running = true;
    this.writtenFiles = [];
    this.lastActivity = '';
    this.runBuffer = '';
    this.reasoningBuffer = '';
    const turnId = `chat-${++this.turnCounter}`;
    this.currentTurnId = turnId;
    this.logger.event('user', {
      text,
      turnId,
      learningMode: learningMode(),
      permissionMode: this.permissionMode(),
      summary: `user: ${text.slice(0, 200)}`,
    });
    // 首次运行时建立记忆文件模板，用户能看到「伙伴记了什么」
    if (!(await memoryStore.read()).trim()) {
      await memoryStore.write(MEMORY_TEMPLATE).catch(() => undefined);
    }
    await this.compactIfNeeded(config.baseUrl, apiKey, config.model);
    this.history[0] = { role: 'system', content: await this.buildSystemPrompt() };
    const abort = new AbortController();
    this.currentAbort = abort;
    this.post({ type: 'busy', busy: true });
    try {
      await runAgent(text, this.history, { ...config, apiKey, signal: abort.signal }, {
        onToken: (t) => {
          this.runBuffer += t;
          this.post({ type: 'token', text: t });
        },
        onReasoning: (t) => {
          this.reasoningBuffer += t;
          this.post({ type: 'reasoning', text: t });
        },
        onToolStart: (name, args) => {
          this.lastActivity = `Calling ${name}`;
          this.logger.event('tool_call', { turnId, name, args: args.slice(0, 1000), summary: `tool → ${name}` });
          this.post({ type: 'toolStart', name, args });
        },
        onToolResult: (name, result) => {
          this.logger.event('tool_result', { turnId, name, result: result.slice(0, 2000), summary: `tool ✔ ${name}` });
          this.post({ type: 'toolResult', name, result });
        },
        onDone: () => {
          if (this.reasoningBuffer.trim()) {
            this.logger.event('reasoning', { turnId, text: this.reasoningBuffer, summary: `reasoning: ${this.reasoningBuffer.slice(0, 200)}` });
          }
          this.logger.event('assistant', { turnId, text: this.runBuffer, summary: `assistant: ${this.runBuffer.slice(0, 200)}` });
          this.post({ type: 'done' });
        },
        onAborted: () => {
          if (this.reasoningBuffer.trim()) {
            this.logger.event('reasoning', { turnId, text: this.reasoningBuffer, aborted: true, summary: `reasoning (aborted): ${this.reasoningBuffer.slice(0, 200)}` });
          }
          this.logger.event('interrupt', {
            turnId,
            activity: this.lastActivity,
            partial: this.runBuffer.slice(0, 500),
            summary: `interrupted while: ${this.lastActivity || 'thinking'}`,
          });
          this.post({
            type: 'interrupted',
            activity: this.lastActivity || 'Composing reply',
          });
        },
        onError: (message) => {
          this.logger.error(message);
          this.post({ type: 'error', message });
        },
        onUsage: (u) => {
          this.usage.add('chat', u);
          this.logger.event('usage', {
            turnId,
            source: 'chat',
            prompt: u.promptTokens,
            completion: u.completionTokens,
            summary: `usage chat: ${u.totalTokens} tokens (in ${u.promptTokens} / out ${u.completionTokens})`,
          });
        },
      }, this.buildToolContext());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(message);
      this.post({ type: 'error', message });
    } finally {
      this.running = false;
      this.currentAbort = null;
      this.post({ type: 'busy', busy: false });
      void this.context.workspaceState.update(HISTORY_KEY, this.history.slice(-HISTORY_PERSIST_LIMIT));
      const waiters = this.abortWaiters;
      this.abortWaiters = [];
      for (const resolve of waiters) {
        resolve();
      }
      if (this.writtenFiles.length > 0) {
        this.onFilesWritten?.([...new Set(this.writtenFiles)]);
        this.writtenFiles = [];
      }
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = String(Date.now()) + Math.random().toString(36).slice(2);
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'chat.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'chat.css'));

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${styleUri}" rel="stylesheet">
  <title>QuietPair</title>
</head>
<body>
  <div id="topbar">
    <span id="brand">🐾 QuietPair</span>
    <span id="usage-stats" title="Token usage"></span>
    <button id="init-btn" title="Initialize project memory: let the AI explore the project and write it into .vs-agent/memory.md">Init</button>
    <button id="analyze-btn" title="Analyze the current file now (skips debounce/cooldown/dedup, for testing)">Analyze</button>
    <button id="logs-btn" title="Activity view: the unified event stream (chat turns, watch decisions, metrics) with track filters">Activity</button>
    <button id="clear-btn" title="Clear conversation">Clear</button>
  </div>
  <div id="settings-view" class="hidden">
    <h3>Settings</h3>
    <label class="field">
      <span>Provider</span>
      <select id="set-provider">
        <option value="openai">OpenAI</option>
        <option value="deepseek">DeepSeek</option>
        <option value="kimi">Kimi (Moonshot)</option>
        <option value="custom">Custom (OpenAI-compatible)</option>
      </select>
    </label>
    <label class="field">
      <span>Base URL</span>
      <input id="set-baseurl" type="text" spellcheck="false">
    </label>
    <label class="field">
      <span>Model</span>
      <input id="set-model" type="text" spellcheck="false">
    </label>
    <label class="field">
      <span>API Key</span>
      <input id="set-apikey" type="password" spellcheck="false" placeholder="sk-...">
    </label>
    <div class="hint">The key is stored in the OS-encrypted SecretStorage, never in any config file; clearing it and saving deletes it.</div>
    <label class="field row">
      <input id="set-companion" type="checkbox">
      <span>Companion watch mode (automatically analyzes the code you are editing)</span>
    </label>
    <label class="field">
      <span>Write permissions (Agent editing files / running commands / writing memory)</span>
      <select id="set-permission">
        <option value="discuss">Discuss only: all write operations disabled, advice only</option>
        <option value="ask">Ask me: confirm each write operation (default)</option>
        <option value="yolo">Pre-authorized: writes go through automatically (each is logged)</option>
      </select>
    </label>
    <label class="field">
      <span>Response language (chat replies and suggestions)</span>
      <select id="set-language">
        <option value="zh">中文</option>
        <option value="en">English</option>
      </select>
    </label>
    <label class="field row">
      <input id="set-learning" type="checkbox">
      <span>Learning mode (chat guides you with questions instead of giving answers; you can always override by asking directly)</span>
    </label>
    <label class="field">
      <span>Typing debounce (seconds)</span>
      <input id="set-debounce" type="number" min="3" step="1">
    </label>
    <label class="field">
      <span>Semantic-trigger debounce (seconds)</span>
      <input id="set-quick" type="number" min="1" step="1">
    </label>
    <label class="field">
      <span>Analysis cooldown (seconds, minimum interval between two LLM analyses)</span>
      <input id="set-cooldown" type="number" min="10" step="1">
    </label>
    <div class="settings-actions">
      <button id="settings-save" class="primary">Save</button>
      <button id="settings-cancel">Cancel</button>
      <span id="settings-status"></span>
    </div>
  </div>
  <div id="activity-view" class="hidden">
    <div id="activity-header">
      <h3>Activity</h3>
      <button id="activity-open-logs" title="Open the full JSONL transcript / Output panel / log folder">Logs…</button>
      <button id="activity-close" title="Back to chat">Close</button>
    </div>
    <div id="activity-filters">
      <button class="chip active" data-track="all">All</button>
      <button class="chip" data-track="chat">Chat</button>
      <button class="chip" data-track="watch">Watch</button>
      <button class="chip" data-track="metrics">Metrics</button>
      <button class="chip" data-track="system">System</button>
    </div>
    <div id="activity-list"></div>
  </div>
  <div id="messages"></div>
  <div id="quote-chip" class="hidden"></div>
  <div id="composer">
    <textarea id="input" rows="3" placeholder="Ask the agent… (Enter to send, Shift+Enter for newline)"></textarea>
    <div id="composer-row">
      <button id="companion-btn" title="Companion watch mode: automatically analyze the code you are editing">Watch</button>
      <button id="learn-btn" title="Learning mode: guidance comes as questions and hints; answers stay behind a click">Learn</button>
      <select id="model-select" title="Model (quick switch)"></select>
      <select id="permission-select" title="Write permissions">
        <option value="discuss">discuss</option>
        <option value="ask">ask</option>
        <option value="yolo">yolo</option>
      </select>
      <button id="settings-btn" title="Settings">Settings</button>
      <button id="send" title="Send (Enter)">↑</button>
    </div>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
