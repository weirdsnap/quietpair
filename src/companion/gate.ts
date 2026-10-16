/**
 * 语义闸门（纯函数）：决定「现在适不适合让 LLM 开口」。
 *
 * 守望模式分层架构里最轻的一层，零 LLM 成本：
 *   分层（轻 → 重）：活动记录 → 语义闸门（本文件）→ 保存分诊 → 分析 → 复审
 *
 * 两道闸门，都通过才发起分析：
 * 1) classifyDelay —— 编辑分类决定等待时长（语句边界/粘贴/删除走快速触发）
 * 2) isSemanticallySettled —— 括号配对扫描 + 光标边界：用户是否停在一个「能看」的节点上
 */

import * as vscode from 'vscode';

/**
 * 括号配对扫描（能识别字符串、模板串、行注释、块注释，避免被字符串里的括号误导）
 */
export function bracketsBalanced(text: string): boolean {
  const stack: string[] = [];
  const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  let quote = '';
  let comment: 'line' | 'block' | null = null;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (comment === 'line') {
      if (ch === '\n') {
        comment = null;
      }
      i++;
      continue;
    }
    if (comment === 'block') {
      if (ch === '*' && next === '/') {
        comment = null;
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (quote) {
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === quote) {
        quote = '';
      }
      i++;
      continue;
    }
    if (ch === '/' && next === '/') {
      comment = 'line';
      i += 2;
      continue;
    }
    if (ch === '/' && next === '*') {
      comment = 'block';
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      i++;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') {
      stack.push(ch);
    } else if (ch === ')' || ch === ']' || ch === '}') {
      if (stack.pop() !== pairs[ch]) {
        return false;
      }
    }
    i++;
  }
  return stack.length === 0 && !quote && comment !== 'block';
}

/** 光标是否停在语句边界：空行、以 ; { } : , 结尾的行、注释行都算边界 */
export function cursorAtBoundary(editor: vscode.TextEditor): boolean {
  const line = editor.document.lineAt(editor.selection.active.line).text.trim();
  if (!line) {
    return true;
  }
  return /[;{}:,]$/.test(line) || line.startsWith('//') || line.startsWith('#') || line.startsWith('*');
}

/** 语义闸门组合：括号配平 + 光标边界 */
export function isSemanticallySettled(editor: vscode.TextEditor): boolean {
  return bracketsBalanced(editor.document.getText()) && cursorAtBoundary(editor);
}

/**
 * 编辑分类：决定等待时长。删除/粘贴/语句边界 → 快速触发（quickMs）；普通打字 → 常规防抖（debounceMs）。
 */
export function classifyDelay(
  changes: readonly vscode.TextDocumentContentChangeEvent[],
  quickMs: number,
  debounceMs: number,
): { delay: number; reason: string } {
  for (const c of changes) {
    if (c.rangeLength > 0 && c.text.length === 0) {
      return { delay: quickMs, reason: 'deletion' }; // 删除（可能在重构）
    }
    if (c.text.length >= 50) {
      return { delay: quickMs, reason: 'paste/bulk-insert' }; // 粘贴/大块插入
    }
    if (c.text.includes('\n\n')) {
      return { delay: quickMs, reason: 'blank-line' }; // 空行分段
    }
    const t = c.text.trimEnd();
    if (/[;})]$/.test(t) || /=>$/.test(t) || /\breturn$/.test(t)) {
      return { delay: quickMs, reason: 'statement-boundary' }; // 语句边界 token
    }
  }
  return { delay: debounceMs, reason: 'typing' };
}
