/**
 * 属性测试（Property-Based Testing，fast-check）：不钉例子，钉**不变量**。
 * 例子测试证明「这几个输入对」；属性测试在几百个随机输入上验证「对所有输入都成立」的性质——
 * 对解析器/diff 这类输入空间巨大的纯函数，这是性价比最高的防线。
 *
 * 每条属性都对应产品逻辑真实依赖的保证（不是为测而测）：
 * - P1–P4：lineDiff 的结构不变量（复审 prompt 的变更集线索就建立在「未变区逐字节一致」上）
 * - P5a：findQuote 报「找到」⇒ 该行起的内容与 quote 真的逐行一致（exact 档逐字节 / normalized 档归一化后）
 * - P5b：findQuote 优先 exact 档（exact 能中时绝不报 normalized）
 * - P6：escapeHtml 的输出没有未转义的 < > &（webview XSS 防线）
 * - P7：renderInline 只生成白名单标签、href 只放行 http/https（链接渲染的安全承诺）
 * - P8：splitFences 的代码块数 = ``` 次数 / 2 向上取整（围栏配对守恒）
 */
import { describe, it } from 'vitest';
import * as fc from 'fast-check';
import { lineDiff } from '../../src/core/lineDiff';
import { findQuote, normalizeLines } from '../../src/core/anchor';
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

});

describe('findQuote（内容锚）不变量', () => {
  it('P5a: 报找到 ⇒ 报告行起的内容与 quote 逐行一致（按命中档位）', () => {
    fc.assert(
      fc.property(arbText, fc.integer({ min: 0, max: 29 }), fc.integer({ min: 1, max: 4 }), (text, startRaw, len) => {
        const lines = text.split('\n');
        const start = startRaw % lines.length;
        const quote = lines.slice(start, start + len).join('\n');
        // 合法 quote 的非退化形态：整体非空白，且首尾行非空行
        //（findQuote 按设计剥掉头尾空白行——「模型多带一行空行」场景由 anchor.test.ts 的单测专门钉死）
        fc.pre(quote.trim().length > 0 && lines[start].trim().length > 0 && lines[Math.min(start + len, lines.length) - 1].trim().length > 0);
        const m = findQuote(text, quote);
        if (!m) {
          return false; // 从内容里切出来的 quote 必须能找到
        }
        for (const line of m.lines) {
          const window = lines.slice(line - 1, line - 1 + len);
          if (m.tier === 'exact') {
            if (window.join('\n') !== quote) {
              return false;
            }
          } else {
            if (normalizeLines(window.join('\n')).join('\n') !== normalizeLines(quote).join('\n')) {
              return false;
            }
          }
        }
        return true;
      })
    );
  });

  it('P5b: exact 能中时绝不报 normalized（档位优先级）', () => {
    fc.assert(
      fc.property(arbText, fc.integer({ min: 0, max: 29 }), (text, startRaw) => {
        const lines = text.split('\n');
        const quote = lines[startRaw % lines.length];
        fc.pre(quote.trim().length > 0);
        const m = findQuote(text, quote);
        if (!m) {
          return false;
        }
        return m.tier === 'exact'; // quote 原样来自内容，exact 必中
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
