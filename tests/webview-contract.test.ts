/**
 * Webview 契约门禁：media/chat.js（前端）与 src/ui/chatView.ts（后端）之间的
 * 两条隐性合约必须闭合，任何一边改名都会在运行时才炸（webview 脚本报错即整面板死亡）：
 *
 * 1. DOM id：chat.js 里 getElementById / querySelector('#id') 引用的每个 id，
 *    必须存在于 chatView.ts getHtml() 生成的 HTML 里；
 * 2. 消息类型：chat.js postMessage 的 type 必须在 handleMessage 有 case；
 *    chatView.ts this.post 的 type 必须在 chat.js 的消息 switch 里有 case。
 *
 * 纯源码静态检查，不启动浏览器——抓的是「拼写漂移」，不是渲染正确性。
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const root = path.resolve(__dirname, '..');
const chatJs = fs.readFileSync(path.join(root, 'media', 'chat.js'), 'utf8');
const chatViewTs = fs.readFileSync(path.join(root, 'src', 'ui', 'chatView.ts'), 'utf8');

function extract(pattern: RegExp, source: string): Set<string> {
  const out = new Set<string>();
  for (const m of source.matchAll(pattern)) {
    out.add(m[1]);
  }
  return out;
}

// getHtml() 返回的模板字符串里的 id="..."（getHtml 是私有方法，直接扫源码契约同样有效）
const htmlIds = extract(/id="([^"]+)"/g, chatViewTs);

// 前端引用的 id：getElementById('x') 和 querySelector(All)('#x …' / '#x')
const jsRefIds = new Set<string>([
  ...extract(/getElementById\('([^']+)'\)/g, chatJs),
  ...extract(/querySelector(?:All)?\('#([A-Za-z0-9_-]+)/g, chatJs),
]);

// 后端 → 前端：this.post({ type: 'x' … })（type 恒为第一个字段）
const postedTypes = extract(/this\.post\(\{\s*type:\s*'([^']+)'/g, chatViewTs);
// 前端消息 switch 的 case
const frontendCases = extract(/case '([^']+)':/g, chatJs);

// 前端 → 后端：vscode.postMessage({ type: 'x' … })
const frontendSentTypes = extract(/postMessage\(\{\s*type:\s*'([^']+)'/g, chatJs);
// 后端 handleMessage 的 case
const backendCases = extract(/case '([^']+)':/g, chatViewTs);

describe('webview 契约：DOM id 闭合', () => {
  it('chat.js 引用的每个 id 都存在于 chatView.ts 生成的 HTML', () => {
    expect(jsRefIds.size).toBeGreaterThan(10); // 提取规则失效时立刻发现（而不是假绿）
    const missing = [...jsRefIds].filter((id) => !htmlIds.has(id));
    expect(missing).toEqual([]);
  });
});

describe('webview 契约：消息类型闭合', () => {
  it('后端 post 的每个 type，前端都有 case', () => {
    expect(postedTypes.size).toBeGreaterThan(10);
    const missing = [...postedTypes].filter((t) => !frontendCases.has(t));
    expect(missing).toEqual([]);
  });

  it('前端 postMessage 的每个 type，后端 handleMessage 都有 case', () => {
    expect(frontendSentTypes.size).toBeGreaterThan(10);
    const missing = [...frontendSentTypes].filter((t) => !backendCases.has(t));
    expect(missing).toEqual([]);
  });
});
