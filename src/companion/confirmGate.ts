/**
 * 确认修复的闸门判定（纯函数）：点「✓ 改好了」后走哪条路的唯一权威。
 * 设计定案：docs/design/suggestion-identity.md D4 判定树。
 *
 * 诚实化原则：问题的身份是论断不是坐标——修复可能落在别的文件。
 * 确定性分支只在证据充分时下结论：
 * - unchanged：建议打出后全工作区都没动过 → 现有标注就是最新判断
 * - untouched：强锚（LLM 照抄并校验过的原文片段）在当前内容里还在，
 *   且相关文件（import 图）也没动 → 证据原样存在 + 相关范围零改动，
 *   几乎可以肯定没修到点上（措辞留余地：图是召回优先的启发式）
 * 其余一律 LLM 复审。弱锚（行号截取，位置可能钉错）永远没有确定性裁决权，
 * 只能作为线索进复审——错误的锚比没有锚危害大。
 */
export interface ConfirmGateInput {
  /** 建议所在文件自上次分析以来是否有变化 */
  fileChanged: boolean;
  /** 建议打出后被编辑过的其他文件 */
  otherEdited: string[];
  /** otherEdited 中与建议文件有依赖关系的（import 图） */
  relatedEdited: string[];
  /** 内容锚（无锚建议省略）；found = 打出时的片段在当前内容里还能搜到 */
  anchor?: { strength: 'strong' | 'weak'; found: boolean };
}

export type ConfirmGate = 'unchanged' | 'untouched' | 'review';

export function decideConfirmGate(input: ConfirmGateInput): ConfirmGate {
  const { fileChanged, otherEdited, relatedEdited, anchor } = input;
  if (!fileChanged) {
    return otherEdited.length === 0 ? 'unchanged' : 'review';
  }
  if (anchor?.strength === 'strong' && anchor.found && relatedEdited.length === 0) {
    return 'untouched';
  }
  return 'review';
}
