/**
 * prompts.ts 的守护测试：prompt 是高频改动的产品资产，
 * 这些断言锁住核心定位，防止改文案时意外丢失关键约束。
 */
import { describe, it, expect } from 'vitest';
import { SYSTEM_PROMPT, COMPANION_PROMPT, GUIDE_PROMPT, INIT_PROMPT } from '../src/agent/prompts';

describe('SYSTEM_PROMPT：伙伴人设的核心约束', () => {
  it('定位是结对伙伴而非执行工具', () => {
    expect(SYSTEM_PROMPT).toContain('结对编程伙伴');
  });

  it('顾问姿态：动手是例外，必须由用户发话', () => {
    expect(SYSTEM_PROMPT).toContain('动手永远是例外且必须由用户发话');
  });

  it('先讨论后动手', () => {
    expect(SYSTEM_PROMPT).toContain('先讨论方案');
    expect(SYSTEM_PROMPT).toContain('别自作主张');
  });

  it('ask_user 用于方案选择', () => {
    expect(SYSTEM_PROMPT).toContain('ask_user');
  });

  it('维护项目记忆', () => {
    expect(SYSTEM_PROMPT).toContain('update_memory');
  });
});

describe('COMPANION_PROMPT：守望分析的核心约束', () => {
  it('同事口吻而非审查报告', () => {
    expect(COMPANION_PROMPT).toContain('同事');
  });

  it('结构化输出格式（suggestions JSON）', () => {
    expect(COMPANION_PROMPT).toContain('"suggestions"');
    expect(COMPANION_PROMPT).toContain('"level"');
  });

  it('分级体系 L1/L2/L3', () => {
    expect(COMPANION_PROMPT).toContain('1 观察');
    expect(COMPANION_PROMPT).toContain('2 提醒');
    expect(COMPANION_PROMPT).toContain('3 打断');
  });

  it('半成品不指摘', () => {
    expect(COMPANION_PROMPT).toContain('半成品');
  });
});

describe('GUIDE_PROMPT：引导式 init 的核心约束', () => {
  it('交付阅读地图，用户自己读', () => {
    expect(GUIDE_PROMPT).toContain('阅读地图');
    expect(GUIDE_PROMPT).toContain('你自己读');
  });

  it('逐站陪同并验证理解', () => {
    expect(GUIDE_PROMPT).toContain('理解检查问题');
    expect(GUIDE_PROMPT).toContain('ask_user');
  });

  it('用户确认的知识带前缀，与 agent 推断区分', () => {
    expect(GUIDE_PROMPT).toContain('✅ 用户确认');
  });

  it('不替用户代读', () => {
    expect(GUIDE_PROMPT).toContain('不是代读');
  });

  it('收尾建议最小改动任务，只建议不动手', () => {
    expect(GUIDE_PROMPT).toContain('最小改动任务');
    expect(GUIDE_PROMPT).toContain('只建议，不动手');
  });
});

describe('INIT_PROMPT：代读式 init 的核心约束', () => {
  it('探索项目并写入记忆', () => {
    expect(INIT_PROMPT).toContain('list_files');
    expect(INIT_PROMPT).toContain('update_memory');
    expect(INIT_PROMPT).toContain('项目概况');
  });
});
