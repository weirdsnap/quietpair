/**
 * 复审结局判定（纯函数）：LLM 复审出新建议列表后，「用户那条到底修好没有」的唯一权威。
 * 设计定案：docs/design/suggestion-identity.md D4 ③/④/⑤ 分支。
 *
 * 三态语义：「比对不了」既不是「修好了」也不是「还在」——
 * 比对不了时如实把新鲜分析交给用户自己判断（inconclusive），且不算进 adopted/rejected 统计。
 *
 * 强锚路径（内容比对）：
 * - 证据已消失（anchorFound=false）：模型没再报同级问题 → confirmed；还报了 → inconclusive
 *   （文本变了，可能是修复也可能是重写，字符串层面分不开，但新分析若仍指出问题则无法定位比对）
 * - 证据还在（anchorFound=true，说明是相关文件动过才进的复审）：
 *   新建议与证据区间（锚的行跨度）有重叠 → rejected；无重叠 → confirmed
 *
 * 弱锚/无锚路径（位置比对的旧逻辑，保持现状）：弱锚无确定性裁决权，
 * 它只影响复审 prompt 的线索质量，不影响这里的判定。
 */
import type { Suggestion } from './annotations';
import { countQuoteLines } from '../core/anchor';

export type ConfirmVerdict =
  | { kind: 'confirmed' }
  | { kind: 'rejected'; remaining: Suggestion[] }
  | { kind: 'inconclusive' };

export interface ConfirmVerdictInput {
  /** 被打勾的那条原建议 */
  original: Suggestion;
  /** 复审前在当前内容中搜索原建议强锚的结果（无强锚传 undefined） */
  anchorFound?: boolean;
  /** 强锚命中时的所有起始行（anchorFound=true 时必传） */
  anchorSpanStarts?: number[];
  /** 复审新产出的建议 */
  reviewed: Suggestion[];
}

function rangesOverlap(aStart: number, aLen: number, bStart: number, bLen: number): boolean {
  return aStart <= bStart + bLen - 1 && bStart <= aStart + aLen - 1;
}

/** 新建议是否与证据区间有交集（优先用它自己的锚，退而用行号点） */
function overlapsEvidence(x: Suggestion, spanStarts: number[], spanLen: number): boolean {
  const xLen = x.anchor ? countQuoteLines(x.anchor.quote) : 1;
  const xStarts = x.anchor && x.anchor.lines.length > 0 ? x.anchor.lines : x.line !== undefined ? [x.line] : [];
  return xStarts.some((xs) => spanStarts.some((p) => rangesOverlap(xs, xLen, p, spanLen)));
}

export function judgeConfirmOutcome(input: ConfirmVerdictInput): ConfirmVerdict {
  const { original, anchorFound, anchorSpanStarts, reviewed } = input;
  const anchor = original.anchor;
  const sameLevelOrWorse = reviewed.filter((x) => x.level >= original.level);

  if (anchor?.strength === 'strong' && anchorFound !== undefined) {
    if (!anchorFound) {
      return sameLevelOrWorse.length === 0 ? { kind: 'confirmed' } : { kind: 'inconclusive' };
    }
    const spanStarts = anchorSpanStarts ?? [];
    const spanLen = countQuoteLines(anchor.quote);
    const remaining = sameLevelOrWorse.filter((x) => overlapsEvidence(x, spanStarts, spanLen));
    return remaining.length === 0 ? { kind: 'confirmed' } : { kind: 'rejected', remaining };
  }

  // 弱锚/无锚：保持位置窗口比对；无行号且复审非空 → 第三态
  const from = original.line;
  if (from === undefined) {
    return reviewed.length === 0 ? { kind: 'confirmed' } : { kind: 'inconclusive' };
  }
  const remaining = sameLevelOrWorse.filter((x) => x.line !== undefined && Math.abs(x.line - from) <= 3);
  return remaining.length === 0 ? { kind: 'confirmed' } : { kind: 'rejected', remaining };
}
