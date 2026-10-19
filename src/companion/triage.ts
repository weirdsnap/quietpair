/**
 * 保存分诊：分层观测的第二层「速记员」。
 *
 * 用户主动保存是「这段写完了」的高质量信号。用一次极小调用（输入几百 token、输出 1 个词）
 * 判断值不值得叫醒深度分析（默认冷却 5 分钟，单次成本远高于分诊）：
 * - 自上次分析以来没有实质变化 → 直接跳过（hash 判断，零成本）
 * - 分诊本身限频 30s，防连续保存/保存格式化连环触发
 * - 分诊可以用更便宜的模型（vsAgent.triageModel），不配置就复用主模型
 * - 回答 YES → 绕过冷却直接叫醒深度分析
 */

import * as vscode from 'vscode';
import { TokenUsage, chatCompletion } from '../core/llm';
import { getConfig } from '../core/config';
import { Analyzer } from './analyzer';
import { ActivityTracker } from './activity';

const TRIAGE_THROTTLE_MS = 30000;

export interface SaveTriageDeps {
  getApiKey(): Promise<string | undefined>;
  isBusy(): boolean;
  isEnabled(): boolean;
  onDebug?(event: string, data: Record<string, unknown>): void;
  onUsage?(usage: TokenUsage): void;
  /** 分诊叫醒深度分析时领取 watch-N（由编排层统一发号，和常规触发同一序列） */
  nextTurnId?(): string;
}

export class SaveTriage implements vscode.Disposable {
  private lastTriageAt = 0;
  private readonly listener: vscode.Disposable;

  constructor(
    private readonly deps: SaveTriageDeps,
    private readonly analyzer: Analyzer,
    private readonly activity?: ActivityTracker,
  ) {
    this.listener = vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.uri.scheme === 'file') {
        void this.triageOnSave(doc);
      }
    });
  }

  private async triageOnSave(doc: vscode.TextDocument): Promise<void> {
    if (!this.deps.isEnabled() || this.deps.isBusy()) {
      return;
    }
    if (!vscode.workspace.getConfiguration('vsAgent').get<boolean>('companion.saveTriage', true)) {
      return;
    }
    // 自上次分析以来没有实质变化 → 没有可分诊的
    if (!this.analyzer.hasUnanalyzedChanges(doc)) {
      this.deps.onDebug?.('triage', { result: 'unchanged-skip', file: vscode.workspace.asRelativePath(doc.uri) });
      return;
    }
    // 分诊本身限频 30s，防连续保存/保存格式化连环触发
    const wait = TRIAGE_THROTTLE_MS - (Date.now() - this.lastTriageAt);
    if (wait > 0) {
      this.deps.onDebug?.('triage', { result: 'throttled', waitMs: wait });
      return;
    }
    const apiKey = await this.deps.getApiKey();
    if (!apiKey) {
      return;
    }
    this.lastTriageAt = Date.now();

    const rel = vscode.workspace.asRelativePath(doc.uri);
    const stats = this.activity?.fileStats(rel);
    const diagnostics = vscode.languages
      .getDiagnostics(doc.uri)
      .filter((d) => d.severity <= vscode.DiagnosticSeverity.Warning && d.source !== 'QuietPair')
      .slice(0, 5)
      .map((d) => `- line ${d.range.start.line + 1} [${vscode.DiagnosticSeverity[d.severity]}]: ${d.message}`)
      .join('\n');
    const { baseUrl, model } = getConfig();
    // 分诊可以用更便宜的模型（vsAgent.triageModel），不配置就复用主模型
    const triageModel = vscode.workspace.getConfiguration('vsAgent').get<string>('triageModel', '').trim() || model;
    try {
      const { content, usage } = await chatCompletion({
        baseUrl,
        apiKey,
        model: triageModel,
        messages: [
          {
            role: 'user',
            content: `你是代码审查的分诊员。用户刚保存了文件，判断现在是否值得叫一次深度代码审查（成本较高）。

刚保存：${rel}${stats ? `（近期编辑 +${stats.added}/-${stats.removed} 字符）` : ''}
诊断信息：
${diagnostics || '(无)'}
用户最近活动：
${this.activity?.summarize() || '(无)'}

值得的情况：改动量大、结构性修改（重构/新功能）、有诊断错误、可能涉及跨文件联动。
不值得的情况：纯格式化、注释或文案微调、改动量极小。
只回答 YES 或 NO。`,
          },
        ],
      });
      if (usage) {
        this.deps.onUsage?.(usage);
      }
      const wake = /^\s*yes/i.test(content);
      const turnId = wake ? this.deps.nextTurnId?.() : undefined;
      this.deps.onDebug?.('triage', {
        file: rel,
        decision: wake ? 'wake' : 'skip',
        answer: content.trim().slice(0, 20),
        turnId,
        summary: `triage: ${rel} → ${wake ? '叫醒守望' : '不值得'}`,
      });
      if (wake) {
        // 分诊说值得：绕过冷却直接分析（哈希去重仍生效，上面已确认有变化）
        await this.analyzer.analyze(doc, `Reviewing saved ${rel}…`, undefined, { bypassCooldown: true, turnId });
      }
    } catch (err) {
      this.deps.onDebug?.('triage', { file: rel, decision: 'error', error: err instanceof Error ? err.message : String(err) });
    }
  }

  dispose(): void {
    this.listener.dispose();
  }
}
