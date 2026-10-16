/**
 * gate.ts 的测试：语义闸门是纯函数逻辑（括号配对 / 光标边界 / 编辑分类），
 * 编辑器对象用最小桩（只需要 document.lineAt / getText / selection.active.line）。
 */
import { describe, it, expect } from 'vitest';
import { bracketsBalanced, classifyDelay, cursorAtBoundary, isSemanticallySettled } from '../src/companion/gate';

/** 最小编辑器桩：满足 cursorAtBoundary / isSemanticallySettled 用到的接口 */
function fakeEditor(text: string, cursorLine: number) {
  const lines = text.split('\n');
  return {
    document: {
      getText: () => text,
      lineAt: (n: number) => ({ text: lines[n] }),
    },
    selection: { active: { line: cursorLine } },
  } as never;
}

describe('bracketsBalanced', () => {
  const balanced = [
    'const x = (1 + 2) * 3;',
    'function f() { return [1, {a: 2}]; }',
    'const s = "括号在字符串里 ({[";',       // 字符串里的括号不算
    "const t = `模板 ${'内 { 嵌套'}`;",
    '// 注释里的括号 ((( 不算',
    '/* 块注释 ((( */ const x = 1;',
    'const q = "转义 \\" 后的 ( 括号";',
    '',                                        // 空文本算平衡
  ];
  const unbalanced = [
    'const x = (1 + 2;',
    'function f() {',
    'const y = [1, 2}',
    'const s = "未闭合的字符串 (',             // 未闭合字符串 = 没写完
    '/* 未闭合的块注释 (',
    'const z = )(',
  ];
  for (const text of balanced) {
    it(`平衡: ${JSON.stringify(text.slice(0, 30))}`, () => {
      expect(bracketsBalanced(text)).toBe(true);
    });
  }
  for (const text of unbalanced) {
    it(`不平衡: ${JSON.stringify(text.slice(0, 30))}`, () => {
      expect(bracketsBalanced(text)).toBe(false);
    });
  }
});

describe('cursorAtBoundary', () => {
  const cases: Array<[string, boolean]> = [
    ['', true],                    // 空行
    ['const x = 1;', true],        // 语句结束
    ['function f() {', true],      // 块开始
    ['}', true],                   // 块结束
    ['// 注释', true],
    ['# python 注释', true],
    ['* 块注释中间行', true],
    ['const x = 1,', true],        // 逗号结尾（参数列表换行）
    ['const x = 1', false],        // 写到一半
    ['retur', false],              // 关键字写到一半
  ];
  for (const [line, expected] of cases) {
    it(`${JSON.stringify(line)} → ${expected}`, () => {
      expect(cursorAtBoundary(fakeEditor(line, 0))).toBe(expected);
    });
  }
});

describe('isSemanticallySettled：括号配平 + 光标边界', () => {
  it('配平且在边界 → settled', () => {
    expect(isSemanticallySettled(fakeEditor('const x = 1;\n', 0))).toBe(true);
  });
  it('括号未配平 → 不 settled', () => {
    expect(isSemanticallySettled(fakeEditor('function f() {\n', 0))).toBe(false);
  });
  it('配平但光标在行中间 → 不 settled', () => {
    expect(isSemanticallySettled(fakeEditor('const x = 1', 0))).toBe(false);
  });
});

describe('classifyDelay：编辑分类决定等待时长', () => {
  const QUICK = 3000;
  const SLOW = 10000;

  it('删除 → 快速触发', () => {
    expect(classifyDelay([{ rangeLength: 5, text: '' } as never], QUICK, SLOW)).toEqual({ delay: QUICK, reason: 'deletion' });
  });
  it('粘贴/大块插入 → 快速触发', () => {
    expect(classifyDelay([{ rangeLength: 0, text: 'x'.repeat(50) } as never], QUICK, SLOW)).toEqual({ delay: QUICK, reason: 'paste/bulk-insert' });
  });
  it('空行分段 → 快速触发', () => {
    expect(classifyDelay([{ rangeLength: 0, text: '\n\n' } as never], QUICK, SLOW)).toEqual({ delay: QUICK, reason: 'blank-line' });
  });
  it.each(['const x = 1;', '}', ')', '() =>', 'return'])('语句边界 %s → 快速触发', (text) => {
    expect(classifyDelay([{ rangeLength: 0, text } as never], QUICK, SLOW)).toEqual({ delay: QUICK, reason: 'statement-boundary' });
  });
  it('普通打字 → 常规防抖', () => {
    expect(classifyDelay([{ rangeLength: 0, text: 'const' } as never], QUICK, SLOW)).toEqual({ delay: SLOW, reason: 'typing' });
  });
  it('无变化 → 常规防抖', () => {
    expect(classifyDelay([], QUICK, SLOW)).toEqual({ delay: SLOW, reason: 'typing' });
  });
});
