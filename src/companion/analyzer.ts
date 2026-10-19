/**
 * 分析管线：守望模式的「大脑」，一次深度分析的完整过程。
 *
 * 输入一个文档，产出结构化建议（JSON：行号/级别 L1-L3/说明/修复参考）：
 *   内容截断 + 诊断收集 + 活动轨迹注入（跨文件视野）+ 项目记忆注入
 *   → 模型返回 JSON → parseSuggestions 解析
 *   模型拿不准时可自主调只读工具（read_file / list_files）取证，最多 3 轮，但不能改任何东西。
 *
 * 自带三道节流：
 * - hash 去重：内容没变就不重复分析（force 可跳过）
 * - 冷却闸门：两次真正调 LLM 之间的最小间隔（默认 300s）。冷却内不丢弃，
 *   而是通过 deps.onCooldownDefer 交还给编排层推迟调度（bypassCooldown 可跳过，复审/手动触发用）
 * - 单飞：新分析发起时 abort 掉在途的旧请求
 */

import * as vscode from 'vscode';
import { ChatMessage, TokenUsage, chatCompletion } from '../core/llm';
import { getConfig, languageDirective, learningMode } from '../core/config';
import { readOnlyToolDefinitions, executeReadOnlyTool } from '../agent/tools';
import { COMPANION_PROMPT, LEARNING_COMPANION } from '../agent/prompts';
import { memoryStore } from '../memory/store';
import { Suggestion, SuggestionLevel } from './annotations';
import { ActivityTracker } from './activity';

const MAX_CONTEXT_CHARS = 40000;
const MAX_DIAGNOSTICS = 20;
const MAX_TOOL_STEPS = 3;

export interface AnalyzerDeps {
  getApiKey(): Promise<string | undefined>;
  onAnalysisStart(id: string, file: string, label: string): void;
  onAnalysisEnd(id: string, file: string, uri: vscode.Uri, suggestions: Suggestion[], rawText: string | null): void;
  onNotice(message: string): void;
  onDebug?(event: string, data: Record<string, unknown>): void;
  onUsage?(usage: TokenUsage): void;
  /** 冷却闸门拦截时调用：由编排层决定推迟调度（届时用最新内容重来，hash 去重依然生效） */
  onCooldownDefer(waitMs: number): void;
}

/** 解析模型返回的 JSON 建议；完全无法解析时返回 null（区别于「没有问题」的空数组） */
export function parseSuggestions(text: string): Suggestion[] | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) {
    return null;
  }
  try {
    const obj = JSON.parse(match[0]);
    if (!obj || !Array.isArray(obj.suggestions)) {
      return null;
    }
    return obj.suggestions
      .filter((s: any) => s && typeof s.title === 'string' && typeof s.detail === 'string')
      .map((s: any) => {
        let level: SuggestionLevel = 1;
        if (s.level === 2 || s.level === 3) {
          level = s.level;
        } else if (s.severity === 'warning') {
          level = 2;
        }
        return {
          line: typeof s.line === 'number' && s.line >= 1 ? Math.floor(s.line) : undefined,
          level,
          title: String(s.title),
          detail: String(s.detail),
          fix: typeof s.fix === 'string' && s.fix.trim() ? s.fix : undefined,
          reflect: typeof s.reflect === 'string' && s.reflect.trim() ? s.reflect : undefined,
        };
      });
  } catch {
    return null;
  }
}

export class Analyzer {
  private lastHash = new Map<string, number>();
  private lastAnalysisAt = 0;
  private controller: AbortController | undefined;
  private counter = 0;
  private keyWarned = false;

  constructor(private readonly deps: AnalyzerDeps, private readonly activity?: ActivityTracker) {}

  /** 自上次分析以来该文档是否有实质变化（hash 去重判断） */
  hasUnanalyzedChanges(doc: vscode.TextDocument): boolean {
    return this.lastHash.get(doc.uri.toString()) !== this.hash(doc.getText());
  }

  /** 中止在途的分析请求（dispose 时调用） */
  abortInFlight(): void {
    this.controller?.abort();
  }

  // 冷却：两次真正调 LLM 之间的最小间隔。写写停停的节奏下，停笔触发不丢弃，
  // 而是推迟到冷却结束——到时用最新内容分析（hash 去重依然生效）。
  // 有了活动轨迹 + 保存分诊后，深度分析进一步降频：默认 300s（5 分钟）低频开口
  private cooldownMs(): number {
    const seconds = vscode.workspace.getConfiguration('vsAgent').get<number>('companion.cooldownSeconds', 300);
    return Math.max(10, seconds) * 1000;
  }

  /** 距冷却结束还剩多少毫秒（<= 0 表示不在冷却期）；给开口决策层（decision.ts）用 */
  cooldownWaitMs(): number {
    return this.cooldownMs() - (Date.now() - this.lastAnalysisAt);
  }

  private hash(text: string): number {
    let h = 5381;
    for (let i = 0; i < text.length; i++) {
      h = ((h << 5) + h + text.charCodeAt(i)) | 0;
    }
    return h;
  }

  /**
   * 跑一次完整分析，返回本次产出的建议；null = 没有产出新分析（未变化 / 被打断 / 无 key / 冷却推迟）。
   * opts.bypassCooldown：复审、手动触发、分诊叫醒等「现在就要看」的场景不受冷却限制。
   * opts.force：内容没变也分析（测试 prompt/链路时需要）。
   */
  async analyze(
    doc: vscode.TextDocument,
    label: string,
    extraNote?: string,
    opts?: { bypassCooldown?: boolean; force?: boolean },
  ): Promise<Suggestion[] | null> {
    const full = doc.getText();
    const hash = this.hash(full);
    const docKey = doc.uri.toString();
    if (!opts?.force && this.lastHash.get(docKey) === hash) {
      this.deps.onDebug?.('skip', { file: vscode.workspace.asRelativePath(doc.uri), reason: 'unchanged' });
      return null;
    }

    // 冷却闸门：距上次分析太近就交还编排层推迟到冷却结束，届时用最新内容重来
    if (!opts?.bypassCooldown) {
      const wait = this.cooldownMs() - (Date.now() - this.lastAnalysisAt);
      if (wait > 0) {
        this.deps.onDebug?.('gate', { result: 'cooldown', waitMs: wait, summary: `gate: cooldown → wait ${Math.round(wait / 1000)}s` });
        this.deps.onCooldownDefer(wait);
        return null;
      }
    }

    const apiKey = await this.deps.getApiKey();
    if (!apiKey) {
      if (!this.keyWarned) {
        this.keyWarned = true;
        this.deps.onNotice('Companion mode needs an API key. Click "🔑 API Key" above to set one.');
      }
      return null;
    }

    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    this.lastAnalysisAt = Date.now(); // 从发起请求开始计冷却，失败也计，避免报错时连环重试

    const relPath = vscode.workspace.asRelativePath(doc.uri);
    const content =
      full.length > MAX_CONTEXT_CHARS
        ? `${full.slice(0, MAX_CONTEXT_CHARS)}\n... (truncated, ${full.length} chars total)`
        : full;
    const diagnostics = vscode.languages
      .getDiagnostics(doc.uri)
      .filter((d) => d.severity <= vscode.DiagnosticSeverity.Warning && d.source !== 'QuietPair')
      .slice(0, MAX_DIAGNOSTICS)
      .map((d) => `- line ${d.range.start.line + 1} [${vscode.DiagnosticSeverity[d.severity]}]: ${d.message}`)
      .join('\n');

    // 分层观测第一层：用户最近的活动轨迹（本地统计，零 token），让建议有跨文件视野
    const recentActivity = this.activity?.summarize();
    const activityText = recentActivity
      ? `\nRecent editing activity (the user's work context; may reveal cross-file issues like a changed signature with stale callers — but only report issues visible in the current file):\n${recentActivity}\n`
      : '';

    const userMessage = `${extraNote ? `${extraNote}\n\n` : ''}File: ${relPath} (${doc.languageId}, ${doc.lineCount} lines)
${activityText}
Diagnostics:
${diagnostics || '(none)'}

Current content:
\`\`\`
${content}
\`\`\``;

    const id = `sug-${++this.counter}`;
    this.deps.onAnalysisStart(id, relPath, label);

    // 项目记忆注入：建议可以引用项目约定/决策，而不只是通用判断
    const memory = await memoryStore.read();
    let system =
      (memory.trim()
        ? `${COMPANION_PROMPT}\n\n## 项目记忆（这个项目的背景知识与约定，判断时参考）\n${memory}`
        : COMPANION_PROMPT) + languageDirective();
    // 学习模式：L1/L2 留白（detail 给方向不剧透），L3 豁免
    if (learningMode()) {
      system += `\n\n${LEARNING_COMPANION}`;
    }
    const messages: ChatMessage[] = [
      { role: 'system', content: system },
      { role: 'user', content: userMessage },
    ];

    try {
      const { baseUrl, model } = getConfig();
      let answer = '';
      // 工具循环：模型拿不准时可调只读工具取证，最多 3 轮；最后一轮收走工具，必须给出 JSON
      for (let step = 0; step <= MAX_TOOL_STEPS; step++) {
        const result = await chatCompletion({
          baseUrl,
          apiKey,
          model,
          messages,
          tools: step < MAX_TOOL_STEPS ? readOnlyToolDefinitions : undefined,
          signal: controller.signal,
        });
        if (controller.signal.aborted) {
          return null;
        }
        if (result.usage) {
          this.deps.onUsage?.(result.usage);
        }
        if (result.toolCalls.length === 0) {
          answer = result.content;
          break;
        }
        messages.push({
          role: 'assistant',
          content: result.content || null,
          tool_calls: result.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.name, arguments: tc.arguments },
          })),
        });
        for (const tc of result.toolCalls) {
          this.deps.onDebug?.('tool', { name: tc.name, args: tc.arguments.slice(0, 500), summary: `companion tool → ${tc.name}` });
          const out = await executeReadOnlyTool(tc.name, tc.arguments);
          messages.push({ role: 'tool', tool_call_id: tc.id, content: out });
        }
      }
      if (controller.signal.aborted) {
        return null;
      }
      this.lastHash.set(docKey, hash);

      const trimmed = answer.trim();
      const parsed = trimmed ? parseSuggestions(trimmed) : [];
      if (parsed !== null) {
        this.deps.onAnalysisEnd(id, relPath, doc.uri, parsed, null);
        return parsed;
      } else if (/NO_ISSUES/i.test(trimmed)) {
        this.deps.onAnalysisEnd(id, relPath, doc.uri, [], null);
      } else {
        this.deps.onAnalysisEnd(id, relPath, doc.uri, [], trimmed);
      }
      return [];
    } catch (err) {
      this.deps.onAnalysisEnd(id, relPath, doc.uri, [], null);
      if (!controller.signal.aborted) {
        this.deps.onNotice(`Companion analysis failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      return [];
    }
  }
}
