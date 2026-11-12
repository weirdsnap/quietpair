/**
 * 内容片段锚（quote anchor）的纯逻辑：建议的身份不绑行号、绑原文片段。
 * 设计定案见 docs/design/suggestion-identity.md（D1-D3）。
 *
 * 匹配分两档（同一套代码同时服务「打出时校验」与「确认时搜索」）：
 * 1) exact      逐字节包含；
 * 2) normalized 逐行去首尾空白后比对（模型重排缩进是最常见偏差）。
 * 多处出现全部记录（任一位置存活即锚存活）；找不到只陈述「文本变了」这个事实，裁决交上层。
 *
 * 锚分强弱（D2）：
 * - strong = LLM 照抄原文的 quote 且校验通过——可获得确定性分支入场券
 * - weak   = 行号截取兜底——位置可能钉错，永远没有确定性裁决权，只作复审线索
 */

export type AnchorStrength = 'strong' | 'weak';
export type MatchTier = 'exact' | 'normalized';

export interface AnchorMatch {
  /** 所有出现位置（1-based 起始行） */
  lines: number[];
  tier: MatchTier;
}

export interface SuggestionAnchor {
  quote: string;
  strength: AnchorStrength;
  /** 打出时的出现位置（1-based 起始行；弱锚记截取窗口的起始行） */
  lines: number[];
  tier: MatchTier;
}

/** quote 的行数（归一化后非空的逻辑行数；用于算证据区间跨度） */
export function countQuoteLines(quote: string): number {
  return quote.replace(/\r\n/g, '\n').split('\n').length;
}

/** 逐行去首尾空白（normalized 档的归一形式；锚哈希也用同一份，保持一致） */
export function normalizeLines(text: string): string[] {
  return text.replace(/\r\n/g, '\n').split('\n').map((l) => l.trim());
}

// exact 档要求行边界对齐：quote 必须从行首开始、到行尾结束。
// 否则单行 quote（如 `}`）会命中其他行的中间位置，报出错误行号
function exactOccurrences(content: string, quote: string): number[] {
  const lines: number[] = [];
  let idx = content.indexOf(quote);
  while (idx >= 0) {
    const end = idx + quote.length;
    const startsAtLineStart = idx === 0 || content[idx - 1] === '\n';
    const endsAtLineEnd = end === content.length || content[end] === '\n';
    if (startsAtLineStart && endsAtLineEnd) {
      lines.push(content.slice(0, idx).split('\n').length); // 起始行 = 前面换行数 + 1
    }
    idx = content.indexOf(quote, idx + 1);
  }
  return lines;
}

function normalizedOccurrences(content: string, quoteLines: string[]): number[] {
  const contentLines = normalizeLines(content);
  const span = quoteLines.length;
  const lines: number[] = [];
  for (let start = 0; start + span <= contentLines.length; start++) {
    let ok = true;
    for (let i = 0; i < span; i++) {
      if (contentLines[start + i] !== quoteLines[i]) {
        ok = false;
        break;
      }
    }
    if (ok) {
      lines.push(start + 1);
    }
  }
  return lines;
}

/**
 * 在 content 中找 quote 的全部出现位置。先 exact 档；全不中再 normalized 档。
 * quote 先去掉头尾空白行（模型常多带）；空 quote 返回 null。
 */
export function findQuote(content: string, quote: string): AnchorMatch | null {
  const cleaned = quote.replace(/\r\n/g, '\n').replace(/^\s*\n/, '').replace(/\n\s*$/, '');
  if (!cleaned.trim()) {
    return null;
  }
  const exact = exactOccurrences(content, cleaned);
  if (exact.length > 0) {
    return { lines: exact, tier: 'exact' };
  }
  const normalized = normalizedOccurrences(content, normalizeLines(cleaned));
  return normalized.length > 0 ? { lines: normalized, tier: 'normalized' } : null;
}

/** 弱锚取材：以 line 为中心截取 ±radius 行（越界收敛）。line 非法返回 undefined */
export function extractQuoteAroundLine(content: string, line: number, radius = 2): string | undefined {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  if (line < 1 || line > lines.length) {
    return undefined;
  }
  const from = Math.max(1, line - radius);
  const to = Math.min(lines.length, line + radius);
  return lines.slice(from - 1, to).join('\n');
}

/**
 * 建议落锚的唯一入口（打出时调用）：
 * - 有 quote 且校验通过（能在被分析内容中找到）→ strong
 * - quote 缺失或校验失败 → 有行号则截取 ±2 行作 weak
 * - 都没有 → undefined（无锚建议，走诚实的不确定三态）
 */
export function buildAnchor(quote: string | undefined, line: number | undefined, content: string): SuggestionAnchor | undefined {
  if (quote && quote.trim()) {
    const m = findQuote(content, quote);
    if (m) {
      return { quote: quote.replace(/\r\n/g, '\n').replace(/^\s*\n/, '').replace(/\n\s*$/, ''), strength: 'strong', lines: m.lines, tier: m.tier };
    }
  }
  if (line !== undefined) {
    const radius = 2;
    const q = extractQuoteAroundLine(content, line, radius);
    if (q) {
      return { quote: q, strength: 'weak', lines: [Math.max(1, line - radius)], tier: 'exact' };
    }
  }
  return undefined;
}
