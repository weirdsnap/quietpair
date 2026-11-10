/**
 * detect.ts 的测试：记忆指令检测是「打不打扰用户」的边界，误报/漏报的口径钉死在这里。
 */
import { describe, it, expect } from 'vitest';
import { detectMemoryCommand } from '../../src/memory/detect';

describe('detectMemoryCommand：显式记忆指令识别', () => {
  it('命中常见中文指令并归类到正确分区', () => {
    expect(detectMemoryCommand('记住：这个项目用 pnpm，别用 npm')?.section).toBe('禁区'); // 禁区优先于偏好
    expect(detectMemoryCommand('以后都用 pnpm 装依赖')).toMatchObject({ section: '偏好与约定', matched: '以后都' });
    expect(detectMemoryCommand('别再改 src/legacy 目录了')?.section).toBe('禁区');
    expect(detectMemoryCommand('就这么定了，用方案 A')?.section).toBe('重要决策');
    expect(detectMemoryCommand('帮我记一下这个约定')?.section).toBe('偏好与约定');
  });

  it('命中英文指令', () => {
    expect(detectMemoryCommand('remember: we use tabs here')?.section).toBe('偏好与约定');
    expect(detectMemoryCommand('never commit .env files')?.section).toBe('禁区');
    expect(detectMemoryCommand("don't change the public API")?.section).toBe('禁区');
  });

  it('普通提问/讨论不误报', () => {
    expect(detectMemoryCommand('这个函数在哪里定义的？')).toBeNull();
    expect(detectMemoryCommand('怎么编译这个项目')).toBeNull();
    expect(detectMemoryCommand('帮我分析一下这段代码')).toBeNull();
    expect(detectMemoryCommand('记忆文件的路径是什么')).toBeNull(); // 聊「记忆」本身不是记忆指令
  });
});
