/**
 * logger.ts 的测试：事件 envelope（track 推导 / turnId 透传）、ring buffer、实时订阅。
 * Logger 构造需要 Output 通道桩（见 vscode-stub.ts）和一个可写的临时目录。
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Logger, trackOf } from '../src/core/logger';
import type * as vscode from 'vscode';

function makeLogger() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quietpair-log-'));
  const logger = new Logger({ globalStorageUri: { fsPath: dir } } as unknown as vscode.ExtensionContext);
  return { logger, dir };
}

describe('trackOf：kind → 展示轨道', () => {
  it('聊天闭环 / 守望闭环 / 埋点用量 / 系统噪音', () => {
    expect(trackOf('user')).toBe('chat');
    expect(trackOf('assistant')).toBe('chat');
    expect(trackOf('tool_call')).toBe('chat');
    expect(trackOf('tool_result')).toBe('chat');
    expect(trackOf('reasoning')).toBe('chat');
    expect(trackOf('approval')).toBe('chat');
    expect(trackOf('interrupt')).toBe('chat');
    expect(trackOf('companion')).toBe('watch');
    expect(trackOf('metric')).toBe('metrics');
    expect(trackOf('usage')).toBe('metrics');
    expect(trackOf('lifecycle')).toBe('system');
    expect(trackOf('error')).toBe('system');
  });
});

describe('Logger：事件信封与 ring buffer', () => {
  it('event() 自动打 track，透传 turnId，recent() 可取回', () => {
    const { logger } = makeLogger();
    logger.event('user', { turnId: 'chat-1', learningMode: true, summary: 'user: hi' });
    logger.event('companion', { phase: 'decision', turnId: 'watch-1', summary: 'decision: speak' });
    const all = logger.recent();
    // 构造器自带一条 lifecycle 事件
    expect(all[0].kind).toBe('lifecycle');
    const user = all.find((e) => e.kind === 'user');
    expect(user?.track).toBe('chat');
    expect(user?.turnId).toBe('chat-1');
    expect(user?.learningMode).toBe(true);
    const decision = all.find((e) => e.kind === 'companion');
    expect(decision?.track).toBe('watch');
    expect(decision?.turnId).toBe('watch-1');
    logger.dispose();
  });

  it('recent(track) 按轨道过滤', () => {
    const { logger } = makeLogger();
    logger.event('user', { summary: 'u' });
    logger.event('metric', { name: 'm', summary: 'm' });
    expect(logger.recent('chat').map((e) => e.kind)).toEqual(['user']);
    expect(logger.recent('metrics').map((e) => e.kind)).toEqual(['metric']);
    expect(logger.recent('system').map((e) => e.kind)).toEqual(['lifecycle']);
    logger.dispose();
  });

  it('ring buffer 超出容量时丢最旧的', () => {
    const { logger } = makeLogger();
    for (let i = 0; i < 1005; i++) {
      logger.event('user', { summary: `msg ${i}` });
    }
    const all = logger.recent();
    expect(all.length).toBe(1000);
    expect(all[all.length - 1].summary).toBe('msg 1004');
    expect(all[0].summary).toBe('msg 5'); // 最早的 lifecycle + msg 0-4 已被挤出
    logger.dispose();
  });

  it('onEvent 实时推送，dispose 后停止', () => {
    const { logger } = makeLogger();
    const seen: string[] = [];
    const sub = logger.onEvent((e) => seen.push(`${e.kind}:${e.summary}`));
    logger.event('user', { summary: 'a' });
    sub.dispose();
    logger.event('user', { summary: 'b' });
    expect(seen).toEqual(['user:a']);
    logger.dispose();
  });
});
