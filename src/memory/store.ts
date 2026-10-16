/**
 * 项目级持久记忆：.vs-agent/memory.md。
 * 单例（按当前工作区动态解析）。内容注入聊天 Agent 的 system prompt，
 * AI 通过 update_memory 工具维护，人类可直接编辑 / 提交 git。
 */
import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';

const MEMORY_REL = path.join('.vs-agent', 'memory.md');

export const MEMORY_TEMPLATE = `# 项目记忆

> 由 QuietPair 结对伙伴维护，人类可直接编辑，AI 下次对话会看到。
> 条目保持一句话、可独立理解。

## 项目概况

## 偏好与约定

## 重要决策

## 进行中

## 禁区
`;

// 项目级持久记忆：单例，工作区级。注入聊天 Agent 的 system prompt，
// AI 通过 update_memory 工具写入（整文件覆写，写入前应先用 read_file 读最新内容）。
export class MemoryStore {
  private cache: string | null = null;

  filePath(): string | null {
    const folder = vscode.workspace.workspaceFolders?.[0];
    return folder ? path.join(folder.uri.fsPath, MEMORY_REL) : null;
  }

  async read(): Promise<string> {
    const fp = this.filePath();
    if (!fp) {
      return '';
    }
    if (this.cache !== null) {
      return this.cache;
    }
    try {
      this.cache = await fs.readFile(fp, 'utf8');
    } catch {
      this.cache = '';
    }
    return this.cache;
  }

  async write(content: string): Promise<void> {
    const fp = this.filePath();
    if (!fp) {
      throw new Error('No workspace folder is open');
    }
    await fs.mkdir(path.dirname(fp), { recursive: true });
    await fs.writeFile(fp, content, 'utf8');
    this.cache = content;
  }

  // 把蒸馏出的条目合并进对应分区（插在分区标题下；分区不存在则在文件末尾重建）。
  // 供压缩时的记忆沉淀用：模型只产出增量条目，不让它覆写整个文件，避免误删人类编辑
  async appendEntries(entries: { section: string; entry: string }[]): Promise<number> {
    if (!this.filePath() || entries.length === 0) {
      return 0;
    }
    let content = await this.read();
    if (!content.trim()) {
      content = MEMORY_TEMPLATE;
    }
    const lines = content.split('\n');
    let added = 0;
    for (const { section, entry } of entries) {
      const text = entry.trim().replace(/^[-*]\s*/, '');
      if (!text || lines.includes(`- ${text}`)) {
        continue; // 空条目或完全重复的不收
      }
      const heading = `## ${section.trim()}`;
      let idx = lines.findIndex((l) => l.trim() === heading);
      if (idx === -1) {
        if (lines[lines.length - 1]?.trim()) {
          lines.push('');
        }
        lines.push(heading);
        idx = lines.length - 1;
      }
      lines.splice(idx + 1, 0, `- ${text}`);
      added++;
    }
    if (added > 0) {
      await this.write(lines.join('\n'));
    }
    return added;
  }

  invalidate(): void {
    this.cache = null;
  }
}

export const memoryStore = new MemoryStore();
