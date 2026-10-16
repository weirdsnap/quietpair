/**
 * Agent 工具注册表（OpenAI function calling 格式）。
 * 一个工具 = TOOLS 里的一条记录：schema + execute + 权限标记（readonly / parallelSafe）。
 * toolDefinitions / readOnlyToolDefinitions / executeTool / groupToolCalls 全部从注册表派生——
 * 加新工具只需在 TOOLS 加一条，不可能出现「schema 加了但执行忘了接」。
 *
 * 权限模型：写类/交互类工具依赖 ToolContext 注入的能力（审批/记忆/选项/分析），
 * 缺哪个能力对应工具默认拒绝；所有文件路径强制限制在工作区根目录内（见 resolveWorkspacePath）。
 */
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { exec } from 'child_process';
import type { MemoryStore } from '../memory/store';

const MAX_FILE_CHARS = 20000;
const MAX_OUTPUT_CHARS = 8000;
const COMMAND_TIMEOUT_MS = 60000;

export interface ChoiceOption {
  label: string;
  description?: string;
}

export interface ToolContext {
  // 写类工具的开关：缺了哪个能力，对应工具直接拒绝执行（见各工具的 execute）
  memory?: MemoryStore;
  requestApproval?(action: string, detail: string): Promise<boolean>;
  onFileWritten?(absolutePath: string): void;
  // 对话中触发守望分析（「帮我看看这段代码」），由装配层接到 Companion
  requestAnalysis?(path?: string): Promise<string>;
  // ask_user 工具：弹出 A/B/C 选项卡 + 自定义输入，挂起等用户回答
  requestChoice?(question: string, options: ChoiceOption[]): Promise<string>;
}

type ToolArgs = Record<string, any>;

export interface ToolSpec {
  /** OpenAI function calling schema（工具名在 function.name 内） */
  definition: {
    type: 'function';
    function: { name: string; description: string; parameters: Record<string, unknown> };
  };
  execute(args: ToolArgs, ctx: ToolContext): Promise<string> | string;
  /** 守望模式（只读取证）可用：只看，不改任何东西 */
  readonly?: boolean;
  /** 纯读无副作用：同一轮里连续的此类调用可并发执行 */
  parallelSafe?: boolean;
}

function workspaceRoot(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    throw new Error('No workspace folder is open');
  }
  return folder.uri.fsPath;
}

function resolveWorkspacePath(p: string): string {
  const root = workspaceRoot();
  const resolved = path.normalize(path.isAbsolute(p) ? p : path.join(root, p));
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`Path escapes the workspace: ${p}`);
  }
  return resolved;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n... (truncated, ${text.length} chars total)` : text;
}

// ---- 各工具的执行实现（schema 见下方 TOOLS 注册表） ----

async function readFile(args: { path: string }): Promise<string> {
  const abs = resolveWorkspacePath(args.path);
  const content = await fs.readFile(abs, 'utf8');
  return truncate(content, MAX_FILE_CHARS);
}

async function writeFile(args: { path: string; content: string }, ctx: ToolContext): Promise<string> {
  // 没有审批能力的上下文（如守望只读模式、discuss 权限模式）直接拒绝，默认安全
  if (!ctx.requestApproval) {
    return 'Tool not allowed here: write_file';
  }
  const abs = resolveWorkspacePath(args.path);
  const rel = path.relative(workspaceRoot(), abs);
  const preview = args.content.length > 400 ? `${args.content.slice(0, 400)}\n...` : args.content;
  const approved = await ctx.requestApproval(
    'Write file',
    `${rel} (${args.content.length} chars)\n\n${preview}`
  );
  if (!approved) {
    return 'User rejected the file write.';
  }
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, args.content, 'utf8');
  ctx.onFileWritten?.(abs);
  return `Wrote ${args.content.length} chars to ${rel}`;
}

async function listFiles(args: { glob?: string }): Promise<string> {
  const uris = await vscode.workspace.findFiles(
    args.glob || '**/*',
    '{**/node_modules/**,**/.git/**,**/out/**}',
    200
  );
  if (uris.length === 0) {
    return 'No files matched.';
  }
  return uris.map((u) => vscode.workspace.asRelativePath(u)).join('\n');
}

// ---- 只读命令白名单 ----
// 判定逻辑保守，三道闸门：
// 1. 复合命令按 | ; && || 切「段」，每段独立过白名单——每段都写不了、又没有重定向，组合起来也写不了
// 2. 重定向 / 命令替换 / 变量展开 / 后台执行 / 换行：不可静态判定，整条拒
// 3. 参数里的路径不得越出工作区（绝对路径、~、.. 一律拒）——只读 ≠ 无害，防的是数据外泄
// 注意：这是「减少弹窗的便利层」，不是安全边界；拿不准的一律升级走审批。
const READONLY_COMMANDS = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'file', 'stat', 'du', 'df', 'pwd', 'tree',
  'echo', 'basename', 'dirname', 'realpath', 'which', 'date', 'uname',
  'grep', 'egrep', 'fgrep', 'rg', 'sort', 'uniq', 'diff', 'comm', 'cut', 'tr',
  'find', 'git',
]);
const READONLY_GIT_SUBCOMMANDS = new Set([
  'status', 'log', 'diff', 'show', 'blame', 'ls-files', 'rev-parse', 'grep', 'shortlog', 'describe',
  'branch', 'tag', 'remote', // 这三个有写参数，下面单独查
]);
// 命令自带的「看似只读其实会写」参数
const FIND_WRITE_FLAGS = ['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprintf', '-fls'];
const GIT_WRITE_TOKENS = ['-d', '-D', '--delete', '--force', '-f', '-m', '-M', '-c', '-C'];

// 参数 token 是否指向工作区外：绝对路径、~、..，以及 --opt=/abs 这种等号连写形式
function isOutsideWorkspaceToken(t: string): boolean {
  if (t.startsWith('-')) {
    return /=(\/|~|\.{2}(\/|$))/.test(t);
  }
  return t.startsWith('/') || t.startsWith('~') || t === '..' || t.startsWith('../') || t.endsWith('/..') || t.includes('/../');
}

function isSimpleReadonlySegment(seg: string): boolean {
  const tokens = seg.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return false;
  }
  const name = path.basename(tokens[0]);
  if (!READONLY_COMMANDS.has(name)) {
    return false;
  }
  if (tokens.slice(1).some(isOutsideWorkspaceToken)) {
    return false;
  }
  if (name === 'find') {
    return !tokens.some((t) => FIND_WRITE_FLAGS.some((f) => t === f || t.startsWith(f)));
  }
  if (name === 'sort') {
    // sort -o file / --output=file 会写
    return !tokens.some((t) => t === '-o' || t.startsWith('--output'));
  }
  if (name === 'git') {
    const sub = tokens[1];
    if (!sub || !READONLY_GIT_SUBCOMMANDS.has(sub)) {
      return false;
    }
    // git log/diff --output=<file> 会写
    if (tokens.some((t) => t.startsWith('--output'))) {
      return false;
    }
    if (sub === 'remote') {
      // 只允许裸 `git remote` 和 `git remote -v`（add/remove/update 都会改仓库）
      return tokens.length === 2 || (tokens.length === 3 && ['-v', '--verbose'].includes(tokens[2]));
    }
    if (['branch', 'tag'].includes(sub)) {
      return !tokens.some((t) => GIT_WRITE_TOKENS.includes(t));
    }
  }
  return true;
}

export function isReadonlyCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) {
    return false;
  }
  // 重定向 / 命令替换 / 变量展开 / 换行 / 反斜杠：整条拒
  if (/[<>`$\n\\]/.test(trimmed)) {
    return false;
  }
  // && 归一化为 ; 之后，剩下的 & 只能是后台执行（cmd1 & cmd2），拒
  const normalized = trimmed.replace(/&&/g, ';');
  if (normalized.includes('&')) {
    return false;
  }
  // 管道 |、链式 ; 或 || 逐段检查。引号内的 | 会被误切（如 grep "a|b"），
  // 误切结果是误拒（安全方向），不会误放
  const segments = normalized.split(/\|\||[;|]/).map((s) => s.trim()).filter(Boolean);
  return segments.length > 0 && segments.every(isSimpleReadonlySegment);
}

function runCommand(args: { command: string }, ctx: ToolContext): Promise<string> {
  return (async () => {
    // 白名单只读命令免审批直接跑（可用 vsAgent.autoRunReadonlyCommands 关掉）；其余照旧审批
    const autoRun = vscode.workspace.getConfiguration('vsAgent').get<boolean>('autoRunReadonlyCommands', true);
    if (!(autoRun && isReadonlyCommand(args.command))) {
      if (!ctx.requestApproval) {
        return 'Tool not allowed here: run_command';
      }
      const approved = await ctx.requestApproval('Run command', args.command);
      if (!approved) {
        return 'User rejected the command.';
      }
    }
    return new Promise<string>((resolve) => {
      exec(
        args.command,
        { cwd: workspaceRoot(), timeout: COMMAND_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
        (error, stdout, stderr) => {
          const output = truncate(`${stdout}${stderr}`.trim() || '(no output)', MAX_OUTPUT_CHARS);
          if (error) {
            resolve(`Command failed: ${error.message}\n${output}`);
          } else {
            resolve(output);
          }
        }
      );
    });
  })();
}

function getActiveEditor(): string {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return 'No active editor.';
  }
  const doc = editor.document;
  const selected = doc.getText(editor.selection);
  const info: Record<string, unknown> = {
    file: vscode.workspace.asRelativePath(doc.uri),
    language: doc.languageId,
  };
  if (selected) {
    info.selectedText = truncate(selected, MAX_FILE_CHARS);
  } else {
    info.content = truncate(doc.getText(), MAX_FILE_CHARS);
  }
  return JSON.stringify(info, null, 2);
}

async function updateMemory(args: ToolArgs, ctx: ToolContext): Promise<string> {
  if (!ctx.memory) {
    return '记忆存储未接入（memory 未配置）。';
  }
  await ctx.memory.write(String(args.content ?? ''));
  return '项目记忆已更新（.vs-agent/memory.md）';
}

function askUser(args: ToolArgs, ctx: ToolContext): Promise<string> | string {
  if (!ctx.requestChoice) {
    return '选项交互不可用（requestChoice 未配置），改为直接在回复里列出选项。';
  }
  const options: ChoiceOption[] = Array.isArray(args.options) ? args.options : [];
  if (options.length === 0) {
    return 'ask_user 需要至少一个选项。';
  }
  return ctx.requestChoice(String(args.question ?? ''), options);
}

function analyzeCode(args: ToolArgs, ctx: ToolContext): Promise<string> | string {
  return ctx.requestAnalysis
    ? ctx.requestAnalysis(typeof args.path === 'string' && args.path.trim() ? args.path.trim() : undefined)
    : '分析能力未接入（requestAnalysis 未配置）。';
}

// ---- 工具注册表：加新工具在这里加一条即可 ----

const TOOLS: ToolSpec[] = [
  {
    definition: {
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Read the content of a file in the workspace.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path relative to the workspace root' },
          },
          required: ['path'],
        },
      },
    },
    readonly: true,
    parallelSafe: true,
    execute: (a) => readFile(a as { path: string }),
  },
  {
    definition: {
      type: 'function',
      function: {
        name: 'write_file',
        description: 'Write content to a file in the workspace, creating it (and parent directories) if needed. Overwrites existing content. Requires user approval.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path relative to the workspace root' },
            content: { type: 'string', description: 'Full content to write' },
          },
          required: ['path', 'content'],
        },
      },
    },
    execute: (a, ctx) => writeFile(a as { path: string; content: string }, ctx),
  },
  {
    definition: {
      type: 'function',
      function: {
        name: 'list_files',
        description: 'List files in the workspace, optionally filtered by a glob pattern.',
        parameters: {
          type: 'object',
          properties: {
            glob: { type: 'string', description: 'Glob pattern such as **/*.ts. Defaults to **/*' },
          },
        },
      },
    },
    readonly: true,
    parallelSafe: true,
    execute: (a) => listFiles(a as { glob?: string }),
  },
  {
    definition: {
      type: 'function',
      function: {
        name: 'run_command',
        description: 'Run a shell command in the workspace root and return its output. Read-only commands on the allowlist (ls, cat, grep, rg, find without -delete/-exec, git status/log/diff/show etc.; pipelines and && chains are fine when every segment is on the allowlist; paths must stay inside the workspace) run directly; everything else requires user approval.',
        parameters: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'The shell command to run' },
          },
          required: ['command'],
        },
      },
    },
    execute: (a, ctx) => runCommand(a as { command: string }, ctx),
  },
  {
    definition: {
      type: 'function',
      function: {
        name: 'get_active_editor',
        description: 'Get information about the file currently open in the editor: path, language, selected text (or full content if nothing is selected).',
        parameters: { type: 'object', properties: {} },
      },
    },
    parallelSafe: true,
    execute: () => getActiveEditor(),
  },
  {
    definition: {
      type: 'function',
      function: {
        name: 'update_memory',
        description: 'Overwrite the project memory file (.vs-agent/memory.md) with updated content. Read the current content first with read_file, then add/update/remove one-line entries under the fixed sections. Use for durable facts only: project conventions, user preferences, important decisions, rejected suggestions.',
        parameters: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'The full new content of the memory file' },
          },
          required: ['content'],
        },
      },
    },
    execute: updateMemory,
  },
  {
    definition: {
      type: 'function',
      function: {
        name: 'ask_user',
        description: 'Present the user with multiple-choice options (rendered as clickable A/B/C buttons plus a free-text input in the chat panel) and wait for their pick. Use when offering alternative approaches or decisions during discussion, instead of writing an A/B/C list in plain text.',
        parameters: {
          type: 'object',
          properties: {
            question: { type: 'string', description: 'The question to ask the user' },
            options: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  label: { type: 'string', description: 'Short option label (1-5 words)' },
                  description: { type: 'string', description: 'Brief explanation or trade-off of this option' },
                },
                required: ['label'],
              },
              description: '2-4 distinct options; the UI adds a free-text custom input automatically',
            },
          },
          required: ['question', 'options'],
        },
      },
    },
    execute: askUser,
  },
  {
    definition: {
      type: 'function',
      function: {
        name: 'analyze_code',
        description: 'Run the companion deep analysis on a file: produces structured L1/L2/L3 suggestions, annotates them in the editor, and returns them as text. Use when the user asks to analyze, review, or check code ("帮我分析一下", "看看这段有没有问题"). Defaults to the file in the active editor.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path relative to the workspace root. Omit to analyze the active editor file' },
          },
        },
      },
    },
    execute: analyzeCode,
  },
];

const TOOL_MAP = new Map(TOOLS.map((t) => [t.definition.function.name, t]));
const PARALLEL_SAFE_TOOLS = new Set(
  TOOLS.filter((t) => t.parallelSafe).map((t) => t.definition.function.name)
);

// ---- 从注册表派生的公开接口 ----

export const toolDefinitions = TOOLS.map((t) => t.definition);

// 守望模式可用的只读子集（derived：标了 readonly 的工具）
export const readOnlyToolDefinitions = TOOLS.filter((t) => t.readonly).map((t) => t.definition);

export async function executeReadOnlyTool(name: string, argsJson: string): Promise<string> {
  const spec = TOOL_MAP.get(name);
  if (!spec || !spec.readonly) {
    return `Tool not allowed here: ${name}`;
  }
  // 只读工具不触碰任何上下文能力，传空对象即可
  return executeTool(name, argsJson, {});
}

export async function executeTool(name: string, argsJson: string, ctx: ToolContext): Promise<string> {
  const spec = TOOL_MAP.get(name);
  if (!spec) {
    return `Unknown tool: ${name}`;
  }
  let args: ToolArgs;
  try {
    args = argsJson ? JSON.parse(argsJson) : {};
  } catch {
    return `Invalid tool arguments: ${argsJson.slice(0, 200)}`;
  }
  try {
    return await spec.execute(args, ctx);
  } catch (err) {
    return `Tool error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// 把一轮工具调用分组：连续的可并行工具合成一批（并发执行），其余各自成批（串行）。
// 顺序保持不变，tool result 按 tool_call_id 对应回灌。
// 写类（write_file/update_memory）和交互类（run_command 可能弹审批、ask_user 弹选项卡、
// analyze_code 改编辑器标注）必须串行——并发的弹窗和并发写都是灾难
export function groupToolCalls<T extends { name: string }>(calls: T[]): T[][] {
  const groups: T[][] = [];
  let batch: T[] = [];
  for (const call of calls) {
    if (PARALLEL_SAFE_TOOLS.has(call.name)) {
      batch.push(call);
    } else {
      if (batch.length > 0) {
        groups.push(batch);
        batch = [];
      }
      groups.push([call]);
    }
  }
  if (batch.length > 0) {
    groups.push(batch);
  }
  return groups;
}
