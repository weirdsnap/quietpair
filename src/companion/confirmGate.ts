/**
 * 确认修复的闸门判定（纯函数）：点「✓ 改好了」后走哪条路的唯一权威。
 *
 * 诚实化原则：问题的身份是论断不是坐标——修复可能落在别的文件
 * （调用处看到的问题，用户可能去改了函数声明）。所以确定性分支
 * （unchanged / untouched）只在「相关范围内什么都没动」时才允许下结论：
 * - A 文件没变 + 别处也没动 → unchanged（现有标注就是最新判断）
 * - A 变了但改动离建议很远 + 相关文件也没动 → untouched（问题区域不受影响）
 * 其余一律交给 LLM 复审，且把「哪些文件动过」作为取证线索带给模型。
 */
import { LineDiff, isLineOutsideEdits } from '../core/lineDiff';

export interface ConfirmGateInput {
  /** 建议所在文件自上次分析以来是否有变化 */
  fileChanged: boolean;
  suggestionLine?: number;
  /** 建议所在文件 vs 上次分析版本的行级 diff（无基线 undefined，一致 null） */
  diff?: LineDiff | null;
  /** 建议打出后被编辑过的其他文件 */
  otherEdited: string[];
  /** otherEdited 中与建议文件有依赖关系的（import 图） */
  relatedEdited: string[];
}

export type ConfirmGate = 'unchanged' | 'untouched' | 'review';

export function decideConfirmGate(input: ConfirmGateInput): ConfirmGate {
  const { fileChanged, suggestionLine, diff, otherEdited, relatedEdited } = input;
  if (!fileChanged) {
    return otherEdited.length === 0 ? 'unchanged' : 'review';
  }
  if (suggestionLine !== undefined && diff && relatedEdited.length === 0 && isLineOutsideEdits(suggestionLine, diff)) {
    return 'untouched';
  }
  return 'review';
}
