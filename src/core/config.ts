/**
 * 配置与凭据。baseUrl / model 等走 VS Code 设置（vsAgent.*）；
 * API key 优先存 SecretStorage（系统级加密），vsAgent.apiKey 明文设置仅作后备。
 *
 * 设计思路：按安全级别分两级存储——
 * - 非敏感配置（baseUrl、model）放在普通设置里，方便用户直接改；
 * - 敏感凭据（API key）放进 SecretStorage，底层走操作系统钥匙串，
 *   不落在任何明文文件中，避免随 settings.json 被同步/提交而泄漏。
 */
import * as vscode from 'vscode';

// SecretStorage 中存 API key 用的键名，与设置项同名以便对应
const API_KEY_SECRET = 'vsAgent.apiKey';
export { API_KEY_SECRET };

/** 非敏感的运行配置，调用方只管拿结果，不用关心来自哪里 */
export interface AgentConfig {
  baseUrl: string;
  model: string;
}

/** 从 VS Code 设置（settings.json 中的 vsAgent.*）读取配置 */
export function getConfig(): AgentConfig {
  const cfg = vscode.workspace.getConfiguration('vsAgent');
  return {
    // 剥掉末尾多余斜杠，避免拼出 .../v1//chat/completions 这种 URL
    baseUrl: cfg.get<string>('baseUrl', 'https://api.deepseek.com/v1').replace(/\/+$/, ''),
    // 用户没配置 model 时的默认值（与 package.json 中的声明保持一致）
    model: cfg.get<string>('model', 'deepseek-chat'),
  };
}

/** 输出语言：模型对用户可见内容的语言（zh 默认 / en） */
export function responseLanguage(): 'zh' | 'en' {
  return vscode.workspace.getConfiguration('vsAgent').get<string>('responseLanguage', 'zh') === 'en' ? 'en' : 'zh';
}

/** 学习模式开关：开启后聊天 Agent 叠加引导式教学姿态（见 prompts.ts LEARNING_POSTURE） */
export function learningMode(): boolean {
  return vscode.workspace.getConfiguration('vsAgent').get<boolean>('learningMode', false);
}

/** 注入到 system prompt 的语言指令（聊天与守望分析共用） */
export function languageDirective(): string {
  return responseLanguage() === 'en'
    ? '\n\n## 输出语言\n用 English 交流——所有给用户看的内容（回复、建议标题、卡片）都用 English。'
    : '\n\n## 输出语言\n用中文交流——所有给用户看的内容（回复、建议标题、卡片）都用中文。';
}

/** 读取 API key：SecretStorage 优先，明文设置仅作后备 */
export async function getApiKey(context: vscode.ExtensionContext): Promise<string | undefined> {
  // 首选：系统加密存储中的 key
  const secret = await context.secrets.get(API_KEY_SECRET);
  if (secret) {
    return secret;
  }
  // 后备：设置里的明文 key（不推荐，见设置描述中的警告）
  // 注意这个分支只在 SecretStorage 没有时才生效，迁移用户后不会冲突
  const fromSettings = vscode.workspace.getConfiguration('vsAgent').get<string>('apiKey', '').trim();
  return fromSettings || undefined;
}

/** 弹输入框让用户设置 API key，存进 SecretStorage 后返回 */
export async function promptForApiKey(context: vscode.ExtensionContext): Promise<string | undefined> {
  const key = await vscode.window.showInputBox({
    title: 'QuietPair: Set API Key',
    prompt: 'Enter an API key for your OpenAI-compatible provider. It is stored in VS Code SecretStorage, never in settings files.',
    // 输入内容显示为圆点，防止旁人窥屏看到 key
    password: true,
    // 焦点切到其他窗口时输入框不关闭，避免 key 白输
    ignoreFocusOut: true,
  });
  if (key) {
    // 用户按 Esc 取消时 key 为 undefined，不写入存储
    await context.secrets.store(API_KEY_SECRET, key.trim());
    return key.trim();
  }
  return undefined;
}
