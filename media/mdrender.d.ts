/** media/mdrender.js 的类型声明（UMD：浏览器挂 window.MdRender，测试走 import） */
declare const MdRender: {
  escapeHtml(s: string): string;
  renderInline(escaped: string): string;
  isTableSeparator(line: string): boolean;
  splitRow(line: string): string[];
  splitFences(text: string): ({ type: 'code'; content: string } | { type: 'text'; content: string })[];
  splitBlocks(text: string): ({ type: 'text'; text: string } | { type: 'table'; lines: string[] })[];
};
export = MdRender;
