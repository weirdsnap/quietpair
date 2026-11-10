/**
 * mdrender（webview 迷你 markdown 渲染纯逻辑）的单元测试。
 * 这是聊天界面的渲染正确性基础：链接安全（只放行 http/https）、
 * 表格识别、围栏切分的边界必须钉死——渲染错误是用户每屏都看见的东西。
 */
import { describe, it, expect } from 'vitest';
import MdRender from '../media/mdrender.js';

describe('escapeHtml', () => {
  it('转义 & < >', () => {
    expect(MdRender.escapeHtml('<b>&</b>')).toBe('&lt;b&gt;&amp;&lt;/b&gt;');
  });
});

describe('renderInline', () => {
  it('行内代码与加粗', () => {
    expect(MdRender.renderInline('`x = 1` and **bold**')).toBe('<code>x = 1</code> and <strong>bold</strong>');
  });

  it('markdown 链接渲染为 <a>', () => {
    expect(MdRender.renderInline('see [docs](https://example.com/a) here')).toBe(
      'see <a href="https://example.com/a" target="_blank" rel="noreferrer">docs</a> here'
    );
  });

  it('裸 URL 自动链接，末尾句读标点不属于 URL', () => {
    expect(MdRender.renderInline('见 https://example.com/a?x=1。'.replace('。', '.'))).toBe(
      '见 <a href="https://example.com/a?x=1" target="_blank" rel="noreferrer">https://example.com/a?x=1</a>.'
    );
  });

  it('javascript: 协议不放行（只认 http/https）', () => {
    expect(MdRender.renderInline('[x](javascript:alert(1))')).toBe('[x](javascript:alert(1))');
    expect(MdRender.renderInline('javascript:alert(1)')).toBe('javascript:alert(1)');
  });

  it('行内代码里的 URL 与星号不替换', () => {
    expect(MdRender.renderInline('`https://a.com` and `**not bold**`')).toBe(
      '<code>https://a.com</code> and <code>**not bold**</code>'
    );
  });

  it('markdown 链接与裸 URL 相邻不互相污染', () => {
    expect(MdRender.renderInline('[a](https://a.com) then https://b.com')).toBe(
      '<a href="https://a.com" target="_blank" rel="noreferrer">a</a> then ' +
        '<a href="https://b.com" target="_blank" rel="noreferrer">https://b.com</a>'
    );
  });
});

describe('isTableSeparator', () => {
  it('接受标准与对齐写法', () => {
    expect(MdRender.isTableSeparator('| --- | --- |')).toBe(true);
    expect(MdRender.isTableSeparator('|---|---|')).toBe(true);
    expect(MdRender.isTableSeparator('| :--- | ---: | :-: |')).toBe(true);
    expect(MdRender.isTableSeparator(' --- | --- ')).toBe(true);
  });

  it('拒绝普通文本与无横线行', () => {
    expect(MdRender.isTableSeparator('| a | b |')).toBe(false);
    expect(MdRender.isTableSeparator('a | b')).toBe(false);
    expect(MdRender.isTableSeparator('| | |')).toBe(false); // 没有 -
  });
});

describe('splitRow', () => {
  it('剥首尾管道并按列切分', () => {
    expect(MdRender.splitRow('| a | b |')).toEqual(['a', 'b']);
    expect(MdRender.splitRow('a|b')).toEqual(['a', 'b']);
    expect(MdRender.splitRow('| a |')).toEqual(['a']);
  });
});

describe('splitFences', () => {
  it('语言标记剥离、末尾换行剥离', () => {
    expect(MdRender.splitFences('before\n```ts\nconst a = 1;\n```\nafter')).toEqual([
      { type: 'text', content: 'before\n' },
      { type: 'code', content: 'const a = 1;' },
      { type: 'text', content: '\nafter' },
    ]);
  });

  it('未闭合围栏：后半截整体算代码（流式中途的常态）', () => {
    expect(MdRender.splitFences('text\n```\ncode')).toEqual([
      { type: 'text', content: 'text\n' },
      { type: 'code', content: 'code' },
    ]);
  });

  it('无围栏：单个文本块', () => {
    expect(MdRender.splitFences('plain')).toEqual([{ type: 'text', content: 'plain' }]);
  });
});

describe('splitBlocks', () => {
  it('表格前后文本分块（保留空行，交给 CSS pre-wrap 表现）', () => {
    const blocks = MdRender.splitBlocks('intro\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\noutro');
    expect(blocks).toEqual([
      { type: 'text', text: 'intro\n' },
      { type: 'table', lines: ['| A | B |', '| --- | --- |', '| 1 | 2 |'] },
      { type: 'text', text: '\noutro' },
    ]);
  });

  it('表格在行尾结束（无尾随文本）', () => {
    const blocks = MdRender.splitBlocks('| A |\n| --- |\n| 1 |');
    expect(blocks).toEqual([{ type: 'table', lines: ['| A |', '| --- |', '| 1 |'] }]);
  });

  it('含 | 但下一行不是分隔行 → 不当表格', () => {
    const blocks = MdRender.splitBlocks('a | b\nnormal line');
    expect(blocks).toEqual([{ type: 'text', text: 'a | b\nnormal line' }]);
  });

  it('全空白不产出块', () => {
    expect(MdRender.splitBlocks('\n  \n')).toEqual([]);
  });
});
