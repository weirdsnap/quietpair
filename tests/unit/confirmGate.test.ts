/**
 * confirmGate 的测试：用**判定表（Decision Table）**形式化驱动。
 * 设计依据：docs/design/suggestion-identity.md D4 判定树。
 *
 * 条件桩                            动作
 *   C1 fileChanged      建议文件自上次分析以来是否变化      A1 unchanged
 *   C2 otherEdited      建议打出后其他文件是否动过          A2 untouched
 *   C3 anchor.strength  锚强度（strong / weak / 无锚）      A3 review
 *   C4 anchor.found     打出时的片段在当前内容里还能搜到
 *   C5 relatedEdited    动过的其他文件里是否有相关文件（import 图）
 *
 * 规则：
 *   R1  C1=F ∧ C2=∅              → unchanged（全工作区没动，现有标注即最新判断）
 *   R2  C1=F ∧ C2≠∅              → review（修复可能在别的文件）
 *   R3  C1=T ∧ 强锚 ∧ C4=T ∧ C5=∅ → untouched（证据原样还在 + 相关范围零改动）
 *   R4  其余                      → review（不确定就不走确定性分支）
 *
 * 钉死的边界：弱锚永远没有确定性裁决权（D2 安全规则）——
 * 即使 weak+found+related=∅（旧逻辑会给 untouched 的形状）也必须 review。
 */
import { describe, it, expect } from 'vitest';
import { decideConfirmGate, ConfirmGate, ConfirmGateInput } from '../../src/companion/confirmGate';

interface Row {
  name: string;
  input: ConfirmGateInput;
  expect: ConfirmGate;
}

const TABLE: Row[] = [
  // R1：全工作区静止（锚与此分支无关）
  { name: 'R1 文件没变+别处没动（无锚）', input: { fileChanged: false, otherEdited: [], relatedEdited: [] }, expect: 'unchanged' },
  { name: 'R1 文件没变+别处没动（强锚在场也不影响）', input: { fileChanged: false, otherEdited: [], relatedEdited: [], anchor: { strength: 'strong', found: true } }, expect: 'unchanged' },
  // R2：别处动过就必须复审——跨文件修复的场景，「看起来无关」也不能放行
  { name: 'R2 文件没变+无关文件动过', input: { fileChanged: false, otherEdited: ['unrelated.ts'], relatedEdited: [] }, expect: 'review' },
  { name: 'R2 文件没变+相关文件动过', input: { fileChanged: false, otherEdited: ['decl.ts'], relatedEdited: ['decl.ts'] }, expect: 'review' },
  // R3：强锚 + 证据还在 + 相关文件没动 → 免 LLM
  { name: 'R3a 强锚找到+其他文件没动', input: { fileChanged: true, otherEdited: [], relatedEdited: [], anchor: { strength: 'strong', found: true } }, expect: 'untouched' },
  { name: 'R3b 强锚找到+动过的都无关（有意放行，图是召回优先）', input: { fileChanged: true, otherEdited: ['unrelated.ts'], relatedEdited: [], anchor: { strength: 'strong', found: true } }, expect: 'untouched' },
  // R4：任何一环不确定都落 review
  { name: 'R4 强锚但证据消失（修了或重写了，得复审）', input: { fileChanged: true, otherEdited: [], relatedEdited: [], anchor: { strength: 'strong', found: false } }, expect: 'review' },
  { name: 'R4 强锚找到但相关文件动过（可能跨文件修复）', input: { fileChanged: true, otherEdited: ['decl.ts'], relatedEdited: ['decl.ts'], anchor: { strength: 'strong', found: true } }, expect: 'review' },
  { name: 'R4 弱锚找到+相关没动（弱锚无确定性裁决权，铁律）', input: { fileChanged: true, otherEdited: [], relatedEdited: [], anchor: { strength: 'weak', found: true } }, expect: 'review' },
  { name: 'R4 弱锚找不到', input: { fileChanged: true, otherEdited: [], relatedEdited: [], anchor: { strength: 'weak', found: false } }, expect: 'review' },
  { name: 'R4 无锚建议', input: { fileChanged: true, otherEdited: [], relatedEdited: [] }, expect: 'review' },
];

describe('decideConfirmGate：判定表（内容锚版）', () => {
  for (const row of TABLE) {
    it(`${row.name} → ${row.expect}`, () => {
      expect(decideConfirmGate(row.input)).toBe(row.expect);
    });
  }
});
