/**
 * confirmGate 的单元测试：诚实化闸门的判定矩阵。
 * 核心不变量：确定性分支（unchanged/untouched）只在「相关范围内什么都没动」时结论——
 * 修复可能落在别的文件，任何「别处动过」的迹象都必须放行给 LLM 复审。
 */
import { describe, it, expect } from 'vitest';
import { decideConfirmGate } from '../../src/companion/confirmGate';
import { lineDiff } from '../../src/core/lineDiff';

const oldText = Array.from({ length: 10 }, (_, i) => `L${i + 1}`).join('\n');
// L5 改了：未变区 = [1..4] 和 [6..10]；line 1 远离编辑区，line 5 在其中
const editedDiff = lineDiff(oldText, oldText.replace('L5', 'CHANGED'))!;

describe('decideConfirmGate', () => {
  it('文件没变 + 别处也没动 → unchanged', () => {
    expect(
      decideConfirmGate({ fileChanged: false, suggestionLine: 5, diff: null, otherEdited: [], relatedEdited: [] })
    ).toBe('unchanged');
  });

  it('文件没变但别处动过 → review（修复可能在别的文件，哪怕看起来无关）', () => {
    expect(
      decideConfirmGate({ fileChanged: false, suggestionLine: 5, diff: null, otherEdited: ['b.ts'], relatedEdited: [] })
    ).toBe('review');
    expect(
      decideConfirmGate({ fileChanged: false, suggestionLine: 5, diff: null, otherEdited: ['b.ts'], relatedEdited: ['b.ts'] })
    ).toBe('review');
  });

  it('文件变了、改动离建议很远、相关文件没动 → untouched', () => {
    expect(
      decideConfirmGate({ fileChanged: true, suggestionLine: 1, diff: editedDiff, otherEdited: [], relatedEdited: [] })
    ).toBe('untouched');
  });

  it('文件变了、改动离建议很远、但相关文件动过 → review（可能改的是声明）', () => {
    expect(
      decideConfirmGate({
        fileChanged: true,
        suggestionLine: 1,
        diff: editedDiff,
        otherEdited: ['decl.ts'],
        relatedEdited: ['decl.ts'],
      })
    ).toBe('review');
  });

  it('文件变了、改动落在建议邻近区域 → review', () => {
    expect(
      decideConfirmGate({ fileChanged: true, suggestionLine: 5, diff: editedDiff, otherEdited: [], relatedEdited: [] })
    ).toBe('review');
  });

  it('无行号建议 → review（位置无从谈起）', () => {
    expect(
      decideConfirmGate({ fileChanged: true, suggestionLine: undefined, diff: editedDiff, otherEdited: [], relatedEdited: [] })
    ).toBe('review');
  });

  it('无 diff 基线 → review（不确定就不走确定性分支）', () => {
    expect(
      decideConfirmGate({ fileChanged: true, suggestionLine: 1, diff: undefined, otherEdited: [], relatedEdited: [] })
    ).toBe('review');
  });
});
