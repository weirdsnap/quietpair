/**
 * MemoryStore 缓存行为的测试（P2-2 回归）：
 * 人类手动编辑 .vs-agent/memory.md 后，外部变化必须能经 invalidate() 反映到 read()——
 * 否则 system prompt 会一直注入旧记忆。接线（文件监听 → invalidate）在 extension.ts。
 * vscode 由 vitest alias 指向 tests/vscode-stub.ts。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { setWorkspaceRoot } from '../vscode-stub';
import { MemoryStore } from '../../src/memory/store';

let tmpWs: string;
let memFile: string;

beforeAll(() => {
  tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), 'vsagent-store-test-'));
  fs.mkdirSync(path.join(tmpWs, '.vs-agent'), { recursive: true });
  memFile = path.join(tmpWs, '.vs-agent', 'memory.md');
  fs.writeFileSync(memFile, '# 旧记忆\n', 'utf8');
  setWorkspaceRoot(tmpWs);
});

afterAll(() => {
  fs.rmSync(tmpWs, { recursive: true, force: true });
});

describe('MemoryStore：缓存与失效', () => {
  it('read 之后命中缓存（不重复读盘）', async () => {
    const store = new MemoryStore();
    expect(await store.read()).toBe('# 旧记忆\n');
    // 外部直接改文件，未 invalidate 前仍读旧值（这正是需要监听接线的原因）
    fs.writeFileSync(memFile, '# 新记忆\n', 'utf8');
    expect(await store.read()).toBe('# 旧记忆\n');
  });

  it('invalidate 后读到外部的新内容（P2-2）', async () => {
    const store = new MemoryStore();
    expect(await store.read()).toBe('# 新记忆\n');
    fs.writeFileSync(memFile, '# 又改了\n', 'utf8');
    store.invalidate();
    expect(await store.read()).toBe('# 又改了\n');
  });

  it('write 直接刷新缓存', async () => {
    const store = new MemoryStore();
    await store.write('# 工具写入\n');
    expect(await store.read()).toBe('# 工具写入\n');
  });
});
