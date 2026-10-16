/**
 * vscode 模块的测试桩：vitest 通过 vitest.config.ts 的 alias 把 'vscode' 指向这里。
 * 只实现被测代码用到的最小 API 面，状态可通过下面的 setters 注入。
 */
import * as path from 'path';

const state = {
  workspaceRoot: '',
  config: {} as Record<string, unknown>,
  activeEditor: undefined as unknown,
};

/** 设置当前工作区根目录（workspaceFolders[0]） */
export function setWorkspaceRoot(dir: string): void {
  state.workspaceRoot = dir;
}

/** 注入 vsAgent.* 设置值（key 不带前缀，如 'autoRunReadonlyCommands'） */
export function setConfig(values: Record<string, unknown>): void {
  state.config = { ...values };
}

/** 注入当前活动编辑器（gate.ts 测试用） */
export function setActiveEditor(editor: unknown): void {
  state.activeEditor = editor;
}

export const workspace = {
  get workspaceFolders() {
    return state.workspaceRoot ? [{ uri: { fsPath: state.workspaceRoot } }] : undefined;
  },
  asRelativePath(u: { fsPath: string } | string): string {
    return path.relative(state.workspaceRoot, typeof u === 'string' ? u : u.fsPath);
  },
  async findFiles(): Promise<never[]> {
    return [];
  },
  getConfiguration(section: string) {
    void section;
    return {
      get<T>(key: string, defaultValue: T): T {
        return key in state.config ? (state.config[key] as T) : defaultValue;
      },
    };
  },
};

export const window = {
  get activeTextEditor() {
    return state.activeEditor;
  },
};

export const Uri = {
  file: (p: string) => ({ fsPath: p }),
};
