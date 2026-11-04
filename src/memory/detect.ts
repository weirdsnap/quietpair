/**
 * 显式记忆指令检测（纯函数，无 vscode 依赖，可单测）。
 *
 * 识别用户在对话里的「主动命令记忆」：「记住这个」「以后都用 pnpm」「别再用 npm」等。
 * 设计原则（2026-11-04 定案）：检测到不打扰——不弹确认卡、不自动写，
 * 只在面板给一张可忽略的轻卡，用户点「记住它」才落盘；检测和保存都落埋点，
 * 先看检测准确率再决定要不要更进一步。
 *
 * 误报由轻卡消化（「别再说废话了」是情绪不是指令，用户不点按钮就完事）。
 */

export type MemorySection = '禁区' | '重要决策' | '偏好与约定';

export interface MemoryCommandMatch {
  section: MemorySection;
  /** 命中的关键词（埋点用，便于离线分析哪条规则在误报） */
  matched: string;
}

// 顺序即优先级：禁区 > 重要决策 > 偏好与约定
const PATTERNS: Array<{ re: RegExp; section: MemorySection }> = [
  { re: /别再|不要再|别用|不准|禁止/, section: '禁区' },
  { re: /\bnever\b|\bdon'?t (?:use|do|change|modify)\b/i, section: '禁区' },
  { re: /就这么定|决定了|以后按/, section: '重要决策' },
  { re: /记住|记一下|记下来|帮我记/, section: '偏好与约定' },
  { re: /以后都|以后用|从今以后/, section: '偏好与约定' },
  { re: /\bremember\b|\bfrom now on\b|\balways use\b/i, section: '偏好与约定' },
];

export function detectMemoryCommand(text: string): MemoryCommandMatch | null {
  for (const { re, section } of PATTERNS) {
    const m = text.match(re);
    if (m) {
      return { section, matched: m[0] };
    }
  }
  return null;
}
