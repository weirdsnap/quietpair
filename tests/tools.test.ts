/**
 * tools.ts 的测试：白名单判定、工具分组、权限守卫、只读通道。
 * vscode 由 vitest alias 指向 tests/vscode-stub.ts。
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { setWorkspaceRoot, setConfig } from './vscode-stub';
import {
  isReadonlyCommand,
  groupToolCalls,
  executeTool,
  executeReadOnlyTool,
  toolDefinitions,
  readOnlyToolDefinitions,
} from '../src/agent/tools';

let tmpWs: string;

beforeAll(() => {
  tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), 'vsagent-test-'));
  fs.writeFileSync(path.join(tmpWs, 'hello.ts'), 'export const hi = 1;\n');
  setWorkspaceRoot(tmpWs);
});

beforeEach(() => {
  setConfig({ autoRunReadonlyCommands: true });
});

afterAll(() => {
  fs.rmSync(tmpWs, { recursive: true, force: true });
});

describe('isReadonlyCommand：放行', () => {
  const yes = [
    'ls', 'ls -la src/', 'cat hello.ts', 'grep -rn foo .', 'rg TODO', 'find . -name "*.ts"',
    'git status', 'git log --oneline -5', 'git diff HEAD', 'git branch', 'git remote', 'git remote -v',
    'wc -l *.ts', 'tree -L 2', 'pwd', 'echo hello',
    // 管道 / 链式组合（每段都白名单）
    'cat hello.ts | grep export', 'ls src | grep ts | wc -l', 'git log --oneline | head -5',
    'cat hello.ts && ls', 'grep -rn foo src ; wc -l hello.ts', 'cat x || echo missing',
  ];
  for (const cmd of yes) {
    it(`放行: ${cmd}`, () => {
      expect(isReadonlyCommand(cmd)).toBe(true);
    });
  }
});

describe('isReadonlyCommand：拒绝', () => {
  const no = [
    // 写与执行
    'rm -rf x', 'cat a > b', 'cat x | tee out.txt', 'ls | sh', 'cat `which rm`', 'ls $(whoami)',
    'ls & cat x', 'echo $HOME', 'FOO=bar ls', 'sh -c ls',
    // 工作区外路径（外泄通道）
    'cat /etc/passwd', 'cat ~/.ssh/id_rsa', 'cat ../../etc/passwd', 'cat ..', 'ls ~/Downloads',
    'grep -r secret --file=/etc/pat x',
    // 写参数黑名单
    'sort -o out.txt in.txt', 'sort --output=out.txt in.txt', 'find . -delete', 'find . -exec rm {} ;',
    'find . -fprintf out.txt %p', 'git log --output=/tmp/x', 'git diff --output=/tmp/x',
    'git remote update', 'git remote add origin x', 'git branch -D f', 'git branch -m a b', 'git push',
    'sed -i s/a/b/ f', 'npm test',
    // 引号内的 | 误切 → 误拒（安全方向）
    'grep "a|b" hello.ts',
  ];
  for (const cmd of no) {
    it(`拒绝: ${cmd}`, () => {
      expect(isReadonlyCommand(cmd)).toBe(false);
    });
  }
});

describe('groupToolCalls：连续纯读合并并发，其余串行', () => {
  const names = (gs: { name: string }[][]) => gs.map((g) => g.map((c) => c.name).join('+')).join(' | ');
  const t = (name: string) => ({ name });

  it('连续读合并成一批', () => {
    expect(names(groupToolCalls([t('read_file'), t('list_files'), t('get_active_editor')]))).toBe(
      'read_file+list_files+get_active_editor'
    );
  });

  it('混合场景分组', () => {
    expect(
      names(groupToolCalls([t('read_file'), t('read_file'), t('write_file'), t('read_file'), t('ask_user')]))
    ).toBe('read_file+read_file | write_file | read_file | ask_user');
  });

  it('顺序保持', () => {
    const input = [t('read_file'), t('run_command'), t('list_files')];
    const flat = groupToolCalls(input).flat();
    expect(flat).toEqual(input);
  });

  it('全串行工具各自成组', () => {
    expect(names(groupToolCalls([t('write_file'), t('run_command')]))).toBe('write_file | run_command');
  });

  it('空数组与单个', () => {
    expect(groupToolCalls([])).toEqual([]);
    expect(names(groupToolCalls([t('analyze_code')]))).toBe('analyze_code');
  });

  it('边界：纯读在开头结尾', () => {
    expect(names(groupToolCalls([t('list_files'), t('write_file'), t('read_file')]))).toBe(
      'list_files | write_file | read_file'
    );
  });
});

describe('注册表派生', () => {
  it('8 个工具齐全', () => {
    const all = toolDefinitions.map((t) => t.function.name);
    expect(all).toHaveLength(8);
    for (const n of ['read_file', 'write_file', 'list_files', 'run_command', 'get_active_editor', 'update_memory', 'ask_user', 'analyze_code']) {
      expect(all).toContain(n);
    }
  });

  it('只读子集 = read_file + list_files', () => {
    expect(readOnlyToolDefinitions.map((t) => t.function.name)).toEqual(['read_file', 'list_files']);
  });
});

describe('executeTool：权限守卫', () => {
  it('update_memory 无 memory 注入被拒绝', async () => {
    expect(await executeTool('update_memory', JSON.stringify({ content: 'x' }), {})).toContain('未接入');
  });

  it('update_memory 注入后写入', async () => {
    const memFile = path.join(tmpWs, 'memory.md');
    const memory = { write: async (c: string) => fs.promises.writeFile(memFile, c, 'utf8') };
    const r = await executeTool('update_memory', JSON.stringify({ content: '# 测试记忆' }), { memory: memory as never });
    expect(r).toContain('已更新');
    expect(fs.readFileSync(memFile, 'utf8')).toBe('# 测试记忆');
  });

  it('write_file 无审批能力被拒绝', async () => {
    expect(await executeTool('write_file', JSON.stringify({ path: 'a.ts', content: '1' }), {})).toContain('not allowed');
  });

  it('write_file 审批通过后写入并回调 onFileWritten', async () => {
    let writtenCb: string | null = null;
    const r = await executeTool('write_file', JSON.stringify({ path: 'sub/a.ts', content: 'export const a = 1;' }), {
      requestApproval: async () => true,
      onFileWritten: (abs) => { writtenCb = abs; },
    });
    expect(r).toMatch(/^Wrote /);
    expect(fs.existsSync(path.join(tmpWs, 'sub/a.ts'))).toBe(true);
    expect(writtenCb).toBe(path.join(tmpWs, 'sub/a.ts'));
  });

  it('write_file 审批拒绝不落盘', async () => {
    const r = await executeTool('write_file', JSON.stringify({ path: 'b.ts', content: '1' }), {
      requestApproval: async () => false,
    });
    expect(r).toContain('rejected');
    expect(fs.existsSync(path.join(tmpWs, 'b.ts'))).toBe(false);
  });

  it('ask_user 无交互能力时回退提示', async () => {
    expect(await executeTool('ask_user', JSON.stringify({ question: 'q', options: [{ label: 'A' }] }), {})).toContain('不可用');
  });

  it('ask_user 透传问题与选项并返回选择', async () => {
    const ctx = {
      requestChoice: async (q: string, opts: { label: string }[]) => {
        expect(q).toBe('选哪个方案？');
        expect(opts).toHaveLength(2);
        return 'B. 方案B';
      },
    };
    const r = await executeTool('ask_user', JSON.stringify({
      question: '选哪个方案？',
      options: [{ label: '方案A' }, { label: '方案B' }],
    }), ctx);
    expect(r).toBe('B. 方案B');
  });

  it('ask_user 空选项被拒', async () => {
    const ctx = { requestChoice: async () => 'x' };
    expect(await executeTool('ask_user', JSON.stringify({ question: 'q', options: [] }), ctx)).toContain('至少一个');
  });

  it('analyze_code 未接入时提示', async () => {
    expect(await executeTool('analyze_code', '{}', {})).toContain('未接入');
  });

  it('未知工具与坏参数', async () => {
    expect(await executeTool('nope', '{}', {})).toContain('Unknown tool');
    expect(await executeTool('read_file', '{bad json', {})).toContain('Invalid tool arguments');
  });

  it('路径逃逸被拦截', async () => {
    expect(await executeTool('read_file', JSON.stringify({ path: '../../etc/passwd' }), {})).toContain('escapes the workspace');
  });
});

describe('executeReadOnlyTool：守望只读通道', () => {
  it('read_file 放行', async () => {
    expect(await executeReadOnlyTool('read_file', JSON.stringify({ path: 'hello.ts' }))).toContain('export const hi');
  });

  it('写工具按名字拒绝', async () => {
    expect(await executeReadOnlyTool('write_file', JSON.stringify({ path: 'c.ts', content: '1' }))).toContain('not allowed');
    expect(await executeReadOnlyTool('ask_user', JSON.stringify({ question: 'q', options: [{ label: 'A' }] }))).toContain('not allowed');
  });
});

describe('run_command：白名单与审批', () => {
  it('白名单命令无审批能力也直接执行', async () => {
    expect(await executeTool('run_command', JSON.stringify({ command: 'cat hello.ts' }), {})).toContain('export const hi');
  });

  it('管道命令无审批直接执行', async () => {
    expect(await executeTool('run_command', JSON.stringify({ command: 'cat hello.ts | grep export' }), {})).toContain('export const hi');
  });

  it('非白名单命令无审批能力被拒绝', async () => {
    expect(await executeTool('run_command', JSON.stringify({ command: 'npm test' }), {})).toContain('not allowed');
  });

  it('越界读取无审批能力被拒绝', async () => {
    expect(await executeTool('run_command', JSON.stringify({ command: 'cat /etc/passwd' }), {})).toContain('not allowed');
  });

  it('审批通过后执行', async () => {
    await executeTool('run_command', JSON.stringify({ command: 'echo hello > out.txt' }), { requestApproval: async () => true });
    expect(fs.existsSync(path.join(tmpWs, 'out.txt'))).toBe(true);
  });

  it('审批拒绝不执行', async () => {
    const r = await executeTool('run_command', JSON.stringify({ command: 'echo x > out2.txt' }), { requestApproval: async () => false });
    expect(r).toContain('rejected');
    expect(fs.existsSync(path.join(tmpWs, 'out2.txt'))).toBe(false);
  });

  it('关掉 autoRunReadonlyCommands 后白名单命令也走审批', async () => {
    setConfig({ autoRunReadonlyCommands: false });
    let asked = false;
    const r = await executeTool('run_command', JSON.stringify({ command: 'cat hello.ts' }), {
      requestApproval: async () => { asked = true; return true; },
    });
    expect(asked).toBe(true);
    expect(r).toContain('export const hi');
  });
});
