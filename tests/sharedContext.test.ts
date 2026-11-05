/**
 * SharedContext 的单元测试：替换语义（同文件重分析不重复入栈）、
 * 「正在看」标记的携带与精确匹配（无行号建议靠 title 区分）。
 */
import { describe, it, expect } from 'vitest';
import { SharedContext } from '../src/memory/sharedContext';
import type { Suggestion } from '../src/companion/annotations';

function sug(title: string, line?: number, level: 1 | 2 | 3 = 2): Suggestion {
  return { title, detail: `${title} 的详情`, line, level };
}

describe('SharedContext.addSuggestions（替换语义）', () => {
  it('同一文件重复分析不重复入栈', () => {
    const ctx = new SharedContext();
    ctx.addSuggestions('a.ts', [sug('空指针风险', 42)]);
    ctx.addSuggestions('a.ts', [sug('空指针风险', 42)]); // 没修，停顿后再报
    ctx.addSuggestions('a.ts', [sug('空指针风险', 42)]);
    const lines = ctx.summarize().split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('空指针风险');
  });

  it('重分析只换本文件，其他文件的条目保留', () => {
    const ctx = new SharedContext();
    ctx.addSuggestions('a.ts', [sug('a 的问题', 1)]);
    ctx.addSuggestions('b.ts', [sug('b 的问题', 2)]);
    ctx.addSuggestions('a.ts', [sug('a 的新问题', 3)]);
    const text = ctx.summarize();
    expect(text).toContain('b 的问题');
    expect(text).toContain('a 的新问题');
    expect(text).not.toContain('a 的问题 —');
  });

  it('重复刷屏不再挤掉别的文件（容量回归）', () => {
    const ctx = new SharedContext();
    ctx.addSuggestions('other.ts', [sug('别让我被挤掉', 1)]);
    for (let i = 0; i < 30; i++) {
      ctx.addSuggestions('spam.ts', [sug('同一个没修的 bug', 42), sug('另一个', 43)]);
    }
    expect(ctx.summarize()).toContain('别让我被挤掉');
  });
});

describe('SharedContext.markViewed（身份键匹配）', () => {
  it('有行号：精确命中并出现在摘要里', () => {
    const ctx = new SharedContext();
    ctx.addSuggestions('a.ts', [sug('问题一', 10), sug('问题二', 20)]);
    ctx.markViewed('a.ts', 20, '问题二');
    const lines = ctx.summarize().split('\n');
    expect(lines[0]).not.toContain('正在看');
    expect(lines[1]).toContain('正在看');
  });

  it('无行号：多条无行号建议按 title 区分，不再永远命中第一条', () => {
    const ctx = new SharedContext();
    ctx.addSuggestions('a.ts', [sug('架构问题甲'), sug('架构问题乙')]);
    ctx.markViewed('a.ts', undefined, '架构问题乙');
    const lines = ctx.summarize().split('\n');
    expect(lines[0]).not.toContain('正在看');
    expect(lines[1]).toContain('正在看');
  });

  it('同文件重新分析后「正在看」标记按身份键携带', () => {
    const ctx = new SharedContext();
    ctx.addSuggestions('a.ts', [sug('持续的问题', 42)]);
    ctx.markViewed('a.ts', 42, '持续的问题');
    ctx.addSuggestions('a.ts', [sug('持续的问题', 42)]); // 重分析刷新
    expect(ctx.summarize()).toContain('正在看');
  });

  it('无行号标记同样能携带过重新分析', () => {
    const ctx = new SharedContext();
    ctx.addSuggestions('a.ts', [sug('文件级问题')]);
    ctx.markViewed('a.ts', undefined, '文件级问题');
    ctx.addSuggestions('a.ts', [sug('文件级问题')]);
    expect(ctx.summarize()).toContain('正在看');
  });
});
