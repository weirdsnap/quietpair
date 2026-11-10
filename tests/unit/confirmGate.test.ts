/**
 * confirmGate 的测试：用**判定表（Decision Table）**形式化驱动。
 *
 * 条件桩                            动作
 *   C1 fileChanged      建议文件自上次分析以来是否变化      A1 unchanged
 *   C2 otherEdited      建议打出后其他文件是否动过          A2 untouched
 *   C3 suggestionLine   建议是否带行号                      A3 review
 *   C4 diff             是否有有效 diff（null=一致/undefined=无基线）
 *   C5 outsideEdits     行号是否远离本文件一切编辑（isLineOutsideEdits）
 *   C6 relatedEdited    动过的其他文件里是否有相关文件（import 图）
 *
 * 规则（来自实现，判定表把它们钉成可审阅的契约）：
 *   R1  C1=F ∧ C2=∅            → unchanged（全工作区没动，现有标注即最新判断）
 *   R2  C1=F ∧ C2≠∅            → review（修复可能在别的文件，哪怕看起来无关）
 *   R3  C1=T ∧ C3∧C4∧C5 ∧ C6=∅ → untouched（本文件问题区域没变且相关文件没动）
 *   R4  其余                    → review（不确定就不走确定性分支）
 *
 * 覆盖原则：每条规则至少一个具体化行；C2 在 C1=T 时与动作无关（只经 C6 起作用），
 * 但仍单列 R3b 行钉死「无关文件动过不挡 untouched」这个有意设计（图是召回优先）。
 */
import { describe, it, expect } from 'vitest';
import { decideConfirmGate, ConfirmGate, ConfirmGateInput } from '../../src/companion/confirmGate';
import { lineDiff } from '../../src/core/lineDiff';

const oldText = Array.from({ length: 10 }, (_, i) => `L${i + 1}`).join('\n');
// L5 改了：未变区 = [1..4] 和 [6..10]；line 1 远离编辑区（outside=T），line 5 在其中（outside=F）
const editedDiff = lineDiff(oldText, oldText.replace('L5', 'CHANGED'))!;

interface Row {
  name: string;
  input: ConfirmGateInput;
  expect: ConfirmGate;
}

const TABLE: Row[] = [
  // R1：全工作区静止。无行号建议同样适用（C3 与此分支无关）
  { name: 'R1 文件没变+别处没动（带行号）', input: { fileChanged: false, suggestionLine: 5, diff: null, otherEdited: [], relatedEdited: [] }, expect: 'unchanged' },
  { name: 'R1 文件没变+别处没动（无行号）', input: { fileChanged: false, suggestionLine: undefined, diff: null, otherEdited: [], relatedEdited: [] }, expect: 'unchanged' },
  // R2：别处动过就必须复审——跨文件修复的场景，「看起来无关」也不能放行
  { name: 'R2 文件没变+无关文件动过', input: { fileChanged: false, suggestionLine: 5, diff: null, otherEdited: ['unrelated.ts'], relatedEdited: [] }, expect: 'review' },
  { name: 'R2 文件没变+相关文件动过', input: { fileChanged: false, suggestionLine: 5, diff: null, otherEdited: ['decl.ts'], relatedEdited: ['decl.ts'] }, expect: 'review' },
  // R3：问题区域确定未变 且 相关文件没动 → 免 LLM
  { name: 'R3a 改动远离建议+其他文件没动', input: { fileChanged: true, suggestionLine: 1, diff: editedDiff, otherEdited: [], relatedEdited: [] }, expect: 'untouched' },
  { name: 'R3b 改动远离建议+动过的都无关（有意放行）', input: { fileChanged: true, suggestionLine: 1, diff: editedDiff, otherEdited: ['unrelated.ts'], relatedEdited: [] }, expect: 'untouched' },
  // R4：任何一环不确定都落 review
  { name: 'R4 改动落在建议邻近区域', input: { fileChanged: true, suggestionLine: 5, diff: editedDiff, otherEdited: [], relatedEdited: [] }, expect: 'review' },
  { name: 'R4 改动远离但相关文件动过', input: { fileChanged: true, suggestionLine: 1, diff: editedDiff, otherEdited: ['decl.ts'], relatedEdited: ['decl.ts'] }, expect: 'review' },
  { name: 'R4 无行号建议（位置无从谈起）', input: { fileChanged: true, suggestionLine: undefined, diff: editedDiff, otherEdited: [], relatedEdited: [] }, expect: 'review' },
  { name: 'R4 无 diff 基线', input: { fileChanged: true, suggestionLine: 1, diff: undefined, otherEdited: [], relatedEdited: [] }, expect: 'review' },
  { name: 'R4 diff=null（内容一致但 fileChanged 报的矛盾输入，防御行）', input: { fileChanged: true, suggestionLine: 1, diff: null, otherEdited: [], relatedEdited: [] }, expect: 'review' },
];

describe('decideConfirmGate：判定表', () => {
  for (const row of TABLE) {
    it(`${row.name} → ${row.expect}`, () => {
      expect(decideConfirmGate(row.input)).toBe(row.expect);
    });
  }
});
