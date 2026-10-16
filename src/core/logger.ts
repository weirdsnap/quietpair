/**
 * 双通道日志：VS Code Output 面板（实时）+ JSONL transcript 落盘（复盘）。
 * 按时间记录用户消息、AI 回答、工具调用、审批决定、守望决策链、打断等事件。
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export type LogKind =
  | 'lifecycle'
  | 'user'
  | 'assistant'
  | 'tool_call'
  | 'tool_result'
  | 'approval'
  | 'companion'
  | 'usage'
  | 'interrupt'
  | 'error';

// 双通道日志：
// 1. VS Code Output 面板「VS Agent」——实时查看
// 2. JSONL transcript 落盘（globalStorage/logs/session-*.jsonl）——复盘整次会话
export class Logger implements vscode.Disposable {
  private channel = vscode.window.createOutputChannel('VS Agent', { log: true });
  private stream: fs.WriteStream;
  readonly filePath: string;

  constructor(context: vscode.ExtensionContext) {
    const dir = path.join(context.globalStorageUri.fsPath, 'logs');
    fs.mkdirSync(dir, { recursive: true });
    this.filePath = path.join(dir, `session-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
    this.stream = fs.createWriteStream(this.filePath, { flags: 'a' });
    this.event('lifecycle', { summary: `session started → ${this.filePath}` });
  }

  event(kind: LogKind, data: Record<string, unknown>): void {
    const entry = { ts: new Date().toISOString(), kind, ...data };
    this.stream.write(JSON.stringify(entry) + '\n');
    const summary = typeof data.summary === 'string' ? data.summary : JSON.stringify(data).slice(0, 300);
    this.channel.info(`[${kind}] ${summary}`);
  }

  error(message: string): void {
    this.event('error', { summary: message });
    this.channel.error(message);
  }

  async showTranscript(): Promise<void> {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(this.filePath));
    await vscode.window.showTextDocument(doc, { preview: true });
  }

  showOutput(): void {
    this.channel.show();
  }

  async openLogsFolder(): Promise<void> {
    await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(path.dirname(this.filePath)));
  }

  dispose(): void {
    this.stream.end();
    this.channel.dispose();
  }
}
