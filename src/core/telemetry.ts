/**
 * 埋点（评测数据底子）：所有 metric 事件的 schema 集中在这一处——
 * 和 prompts.ts 同一个哲学：评测资产集中管理，改字段只改这里。
 *
 * 全部经 Logger 落 JSONL transcript（kind: 'metric'），离线分析用。
 * 设计依据（见 research/DISCUSSIONS.md）：
 * - Copilot MAPS 2022 的接受率漏斗：展示 → 注意到 → 采纳 → 存活
 * - TMLR：主动场景必须接受率 × 时机双指标并列
 * - TreeInstruct：泄题率（learning 模式下 fix 是否被提前看到）
 *
 * 事件目录：
 *   suggestion_shown      一轮分析的建议展示（带 level/hasFix/masked/learningMode）
 *   suggestion_viewed     用户点开详情（来源：CodeLens / L3 自动展开）
 *   fix_revealed          学习模式下用户点「直接给方案」（本地动作，webview 回传）
 *   deepen_clicked        点「展开说说 / 给个例子」（按需深化）
 *   suggestion_adopted    采纳：confirm 复审通过 / Fix-for-me 移交 Agent
 *   suggestion_rejected   点 Fixed 但复审没通过（问题还在）
 *   confirm_unchanged     点 Fixed 但代码没动过（没白调 LLM，现有判断就是最新的）
 *   suggestion_discussed  点 Discuss 带进聊天
 *   suggestion_stale      用户编辑使一批标注变「待确认」（存活分析的素材）
 *   mode_switched         学习模式切换（解释后续行为的语境）
 *
 * 存活率（30s/120s/… 档）不主动追踪：由 suggestion_shown / stale / adopted 的时间戳离线算。
 */

import type { Suggestion } from '../companion/annotations';

// 结构化类型即可，不绑死 Logger 类（测试可喂假 sink，Telemetry 不依赖 vscode）
export interface MetricSink {
  event(kind: string, data: Record<string, unknown>): void;
}

/** 建议的埋点快照：事件里只放分析用得着的字段，不放全文（全文在 companion end 事件里） */
type SugSnapshot = Record<string, unknown>;

export class Telemetry {
  constructor(private readonly sink: MetricSink) {}

  private emit(name: string, data: Record<string, unknown>, summary: string): void {
    this.sink.event('metric', { name, ...data, summary });
  }

  private snap(s: Suggestion, file: string, opts: { masked: boolean; learningMode: boolean }): SugSnapshot {
    return {
      file,
      line: s.line,
      level: s.level,
      hasFix: !!s.fix,
      masked: opts.masked,
      learningMode: opts.learningMode,
      msSinceShown: s.shownAt ? Date.now() - s.shownAt : undefined,
    };
  }

  /** 一轮分析的建议上屏（编辑器标注 + 面板摘要卡） */
  suggestionShown(file: string, suggestions: Suggestion[], learningMode: boolean): void {
    this.emit(
      'suggestion_shown',
      {
        file,
        count: suggestions.length,
        learningMode,
        items: suggestions.map((s) => ({
          line: s.line,
          level: s.level,
          hasFix: !!s.fix,
          masked: learningMode && s.level !== 3 && !!s.fix,
          hasReflect: !!s.reflect,
        })),
      },
      `metric: shown ${suggestions.length} suggestion(s) for ${file}${learningMode ? ' (learning)' : ''}`,
    );
  }

  /** 用户点开某条建议的详情 */
  suggestionViewed(s: Suggestion, file: string, source: 'codelens' | 'l3-auto', opts: { masked: boolean; learningMode: boolean }): void {
    this.emit('suggestion_viewed', { ...this.snap(s, file, opts), source }, `metric: viewed [${source}] ${s.title}`);
  }

  /** 学习模式下用户点「直接给方案」（本地拉开被藏起的 fix） */
  fixRevealed(s: Suggestion, file: string, opts: { masked: boolean; learningMode: boolean }): void {
    this.emit('fix_revealed', this.snap(s, file, opts), `metric: fix revealed after ${s.shownAt ? Math.round((Date.now() - s.shownAt) / 1000) : '?'}s — ${s.title}`);
  }

  /** 点「展开说说 / 给个例子」 */
  deepenClicked(s: Suggestion, file: string, kind: 'explain' | 'example', opts: { masked: boolean; learningMode: boolean }): void {
    // 字段名用 flavor 不用 kind：避免和 JSONL 信封的 kind='metric' 撞名
    this.emit('deepen_clicked', { ...this.snap(s, file, opts), flavor: kind }, `metric: deepen (${kind}) ${s.title}`);
  }

  /** 采纳：confirm 复审通过 / 移交 Agent 帮我改 */
  suggestionAdopted(s: Suggestion, file: string, via: 'confirm-verified' | 'fix-for-me', opts: { masked: boolean; learningMode: boolean }): void {
    this.emit('suggestion_adopted', { ...this.snap(s, file, opts), via }, `metric: adopted (${via}) ${s.title}`);
  }

  /** 点 Fixed 但复审没通过 */
  suggestionRejected(s: Suggestion, file: string, remaining: number, opts: { masked: boolean; learningMode: boolean }): void {
    this.emit('suggestion_rejected', { ...this.snap(s, file, opts), remaining }, `metric: rejected, ${remaining} issue(s) remain — ${s.title}`);
  }

  /** 点 Fixed 但代码没动过（未白调 LLM） */
  confirmUnchanged(s: Suggestion, file: string, opts: { masked: boolean; learningMode: boolean }): void {
    this.emit('confirm_unchanged', this.snap(s, file, opts), `metric: confirm unchanged — ${s.title}`);
  }

  /** 点 Discuss 带进聊天 */
  suggestionDiscussed(s: Suggestion, file: string, opts: { masked: boolean; learningMode: boolean }): void {
    this.emit('suggestion_discussed', this.snap(s, file, opts), `metric: discussed — ${s.title}`);
  }

  /** 一批标注因用户编辑变「待确认」（存活分析素材） */
  suggestionStale(file: string, count: number): void {
    if (count > 0) {
      this.emit('suggestion_stale', { file, count }, `metric: ${count} suggestion(s) stale in ${file}`);
    }
  }

  /** 学习模式切换（解释后续行为的语境） */
  modeSwitched(learningMode: boolean, via: 'quick-toggle' | 'settings'): void {
    this.emit('mode_switched', { learningMode, via }, `metric: learning mode ${learningMode ? 'on' : 'off'} (${via})`);
  }
}
