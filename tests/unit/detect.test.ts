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

  // 判定表：优先级 = PATTERNS 数组序（禁区 > 重要决策 > 偏好与约定）。
  // 同一句话命中多条规则时，高优先级分区胜出，且 matched 报告胜出的那个关键词
  describe('优先级：混合命中时高优先级胜出', () => {
    it('禁区 > 偏好：「记住」与「别再」同句 → 禁区', () => {
      expect(detectMemoryCommand('记住：别再随便改配置')).toMatchObject({ section: '禁区', matched: '别再' });
      expect(detectMemoryCommand('remember this: never use var')).toMatchObject({ section: '禁区', matched: 'never' });
    });

    it('重要决策 > 偏好：「以后都」与「就这么定」同句 → 重要决策', () => {
      expect(detectMemoryCommand('以后都按这个结构来，就这么定了')).toMatchObject({ section: '重要决策', matched: '就这么定' });
    });

    it('禁区 > 重要决策：「决定了」与「禁止」同句 → 禁区', () => {
      expect(detectMemoryCommand('决定了：禁止再碰这个模块')).toMatchObject({ section: '禁区', matched: '禁止' });
    });
  });

  it('退化输入：空串与纯空白不命中', () => {
    expect(detectMemoryCommand('')).toBeNull();
    expect(detectMemoryCommand('   \n  ')).toBeNull();
  });
});
