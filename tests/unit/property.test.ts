/**
 * 属性测试（Property-Based Testing，fast-check）：不钉例子，钉**不变量**。
 * 例子测试证明「这几个输入对」；属性测试在几百个随机输入上验证「对所有输入都成立」的性质——
 * 对解析器/diff 这类输入空间巨大的纯函数，这是性价比最高的防线。
 *
 * 每条属性都对应产品逻辑真实依赖的保证（不是为测而测）：
 * - P1–P4：lineDiff 的结构不变量（confirmFix 的确定性豁免就建立在「未变区逐字节一致」上）
 * - P5：isLineOutsideEdits 为真 ⇒ 该行内容真的没变（豁免分支的核心承诺，措辞「逐字节」的数学化）
 * - P6：escapeHtml 的输出没有未转义的 < > &（webview XSS 防线）
 * - P7：renderInline 只生成白名单标签、href 只放行 http/https（链接渲染的安全承诺）
 * - P8：splitFences 的代码块数 = ``` 次数 / 2 向下取整（围栏配对守恒）
 */
import { describe, it } from 'vitest';
import * as fc from 'fast-check';
import { lineDiff, isLineOutsideEdits } from '../../src/core/lineDiff';
import MdRender from '../../media/mdrender.js';

// 小字母表行文本：行内容撞车率高，前后缀夹逼才有机会夹出非平凡结构
const arbLine = fc.string({ minLength: 0, maxLength: 4 });
const arbText = fc.array(arbLine, { minLength: 1, maxLength: 30 }).map((ls) => ls.join('\n'));

describe('lineDiff 结构不变量', () => {
  it('P1: 返回 null 当且仅当两版完全一致', () => {
    fc.assert(
      fc.property(arbText, arbText, (a, b) => {
        return (lineDiff(a, b) === null) === (a === b);
      })
    );
  });

  it('P2/P3: 前缀区与后缀区逐行逐字节一致', () => {
    fc.assert(
      fc.property(arbText, arbText, (a, b) => {
        const d = lineDiff(a, b);
        if (!d) {
          return true;
        }
        const oldLines = a.split('\n');
        const newLines = b.split('\n');
        for (let i = 0; i < d.prefixLines; i++) {
          if (oldLines[i] !== newLines[i]) {
            return false;
          }
        }
        for (let i = 0; i < d.suffixLines; i++) {
          if (oldLines[d.oldLineCount - 1 - i] !== newLines[d.newLineCount - 1 - i]) {
            return false;
          }
        }
        return true;
      })
    );
  });

  it('P4: 前后缀不相交（prefix + suffix ≤ 较短行数），且行数记录正确', () => {
    fc.assert(
      fc.property(arbText, arbText, (a, b) => {
        const d = lineDiff(a, b);
        if (!d) {
          return true;
        }
        return (
          d.prefixLines + d.suffixLines <= Math.min(d.oldLineCount, d.newLineCount) &&
          d.oldLineCount === a.split('\n').length &&
          d.newLineCount === b.split('\n').length
        );
      })
    );
  });

  it('P5（豁免分支的核心承诺）: isLineOutsideEdits 为真的行，内容在新旧两版间逐字节一致', () => {
    fc.assert(
      fc.property(arbText, arbText, fc.integer({ min: 0, max: 5 }), (a, b, margin) => {
        const d = lineDiff(a, b);
        if (!d) {
          return true;
        }
        const oldLines = a.split('\n');
        const newLines = b.split('\n');
        for (let line = 1; line <= d.oldLineCount; line++) {
          if (!isLineOutsideEdits(line, d, margin)) {
            continue;
          }
          // 前缀侧坐标不变；后缀侧平移 (newCount - oldCount)
          const newIdx = line <= d.prefixLines ? line : line + (d.newLineCount - d.oldLineCount);
          if (oldLines[line - 1] !== newLines[newIdx - 1]) {
            return false;
          }
        }
        return true;
      })
    );
  });
});

describe('mdrender 安全不变量', () => {
  it('P6: escapeHtml 输出没有未转义的 < > &', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const out = MdRender.escapeHtml(s);
        return !/[<>]/.test(out) && out.replace(/&(amp|lt|gt);/g, '').indexOf('&') === -1;
      })
    );
  });

  it('P7: renderInline 只生成白名单标签（code/strong/a），且 href 只放行 http/https', () => {
    const ALLOWED_TAGS = new Set(['code', 'strong', 'a']);
    fc.assert(
      fc.property(fc.string(), (s) => {
        const out = MdRender.renderInline(MdRender.escapeHtml(s));
        for (const m of out.matchAll(/<\/?([a-zA-Z]+)/g)) {
          if (!ALLOWED_TAGS.has(m[1])) {
            return false;
          }
        }
        for (const m of out.matchAll(/href="([^"]*)"/g)) {
          if (!/^https?:\/\//.test(m[1])) {
            return false;
          }
        }
        return true;
      })
    );
  });
});

describe('splitFences 守恒不变量', () => {
  it('P8: 代码块数 = 输入中 ``` 出现次数的一半（向上取整：未闭合的尾围栏也开一个块）', () => {
    // 显式注入 ``` 让围栏配对成为常态（纯随机文本几乎撞不出围栏）
    const arbFenced = fc
      .array(fc.oneof(fc.string({ maxLength: 10 }), fc.constant('```')), { minLength: 0, maxLength: 12 })
      .map((parts) => parts.join('\n'));
    fc.assert(
      fc.property(arbFenced, (text) => {
        const fenceCount = (text.match(/```/g) ?? []).length;
        const codeBlocks = MdRender.splitFences(text).filter((s) => s.type === 'code').length;
        return codeBlocks === Math.ceil(fenceCount / 2);
      })
    );
  });
});
