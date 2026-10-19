/**
 * 开口决策层（纯函数，无 vscode 依赖）：「现在该不该让守望开口」的唯一权威。
 *
 * 之前这些判断散在 companion / gate / analyzer 三处，各说各话；
 * 本模块把它们统一成一次结构化判定，输出三值结论（对齐 TMLR《When Should the Agent Speak?》
 * 的 must/may/must-not 窗口思想，映射到我们的调度语义）：
 *
 *   speak    —— 可以开口（may 窗口 + 一切就绪）
 *   delay    —— 现在不是时候，但值得等（may 窗口推迟：冷却中 / 用户还没停在一个能看的节点 /
 *               聊天 Agent 在干活）。带 retryMs，到时用最新状态重新判定
 *   suppress —— 不该开口（must-not 窗口：守望被关了 / 内容没变化 / 用户始终没收笔）。
 *               与 delay 的区别：没有「再等等就会好」的预期，直接闭嘴
 *
 * 注意 must 窗口在这里不出现：「必须开口」只有分析完看到 L3 才知道，属于决策的下游。
 * 我们的场景校准（见 ARCHITECTURE 长期方向）：commit/push 前错误爆炸半径小，must 天然很薄。
 *
 * 每次判定都由编排层落 transcript（phase: 'decision'）——这是时机评测与个性化的数据底子。
 */

export type SpeakVerdict = 'speak' | 'delay' | 'suppress';

export interface SpeakContext {
  /** 守望模式总开关 */
  enabled: boolean;
  /** 聊天 Agent 正在运行（避免并发请求 + 注意力打架） */
  chatBusy: boolean;
  /** 自上次分析以来文档是否有实质变化（hash 去重） */
  contentChanged: boolean;
  /** 语义闸门：用户是否停在「能看」的节点（括号配平 + 光标边界） */
  settled: boolean;
  /** 「还没收笔」已连续重试的次数 */
  settleRetries: number;
  /** 「还没收笔」的最大重试次数，到顶放弃（用户可能真的在盯着半成品想） */
  maxSettleRetries: number;
  /** 距冷却结束还剩多少毫秒（<= 0 表示不在冷却期） */
  cooldownWaitMs: number;
}

export interface SpeakDecision {
  verdict: SpeakVerdict;
  /** 机器可读的判定理由（落 transcript、离线分析用） */
  reason: 'disabled' | 'chat-busy' | 'unchanged' | 'cooldown' | 'not-settled' | 'not-settled-giveup' | 'settled';
  /** verdict = delay 时的重试间隔 */
  retryMs?: number;
}

export function decideSpeak(ctx: SpeakContext, opts: { busyRetryMs: number; settleRetryMs: number }): SpeakDecision {
  if (!ctx.enabled) {
    return { verdict: 'suppress', reason: 'disabled' };
  }
  if (ctx.chatBusy) {
    // 聊天在跑：推迟而不是取消——Agent 干完活的现场往往正值得看一眼
    return { verdict: 'delay', reason: 'chat-busy', retryMs: opts.busyRetryMs };
  }
  if (!ctx.contentChanged) {
    return { verdict: 'suppress', reason: 'unchanged' };
  }
  if (ctx.cooldownWaitMs > 0) {
    // 冷却不丢弃：推迟到冷却结束，届时用最新内容重来（hash 去重依然生效）
    return { verdict: 'delay', reason: 'cooldown', retryMs: ctx.cooldownWaitMs };
  }
  if (!ctx.settled) {
    // 「写到一半」不打扰；但重试到顶就放弃——无法区分「正在想」和「人离开了」，不再纠缠
    return ctx.settleRetries < ctx.maxSettleRetries
      ? { verdict: 'delay', reason: 'not-settled', retryMs: opts.settleRetryMs }
      : { verdict: 'suppress', reason: 'not-settled-giveup' };
  }
  return { verdict: 'speak', reason: 'settled' };
}
