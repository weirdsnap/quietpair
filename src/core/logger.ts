/**
 * 双通道日志：VS Code Output 面板（实时）+ JSONL transcript 落盘（复盘）。
 * 按时间记录用户消息、AI 回答、工具调用、审批决定、守望决策链、打断等事件。
 *
 * 每条事件带两个索引字段（都在 data 里透传，这里只负责打 envelope）：
 * - track：轨道分类（chat / watch / metrics / system），由 kind 推导，Activity 视图按它过滤
 * - turnId：一次「观察→思考→行动」闭环的圈定（chat-N = 一次 Agent 运行；watch-N = 一次决策→分析），
 *   由调用方生成并透传，日志层不发明
 *
 * 内存里保留最近 BUFFER_CAP 条（ring buffer），供面板的 Activity 视图拉取和实时订阅。
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
  | 'reasoning'
  | 'approval'
  | 'companion'
  | 'metric'
  | 'usage'
  | 'interrupt'
  | 'error';

export type LogTrack = 'chat' | 'watch' | 'metrics' | 'system';

export interface LogEntry {
  ts: string;
  kind: LogKind;
  track: LogTrack;
  turnId?: string;
  summary?: string;
  [key: string]: unknown;
}

/** kind → 展示轨道：聊天闭环 / 守望闭环 / 埋点与用量 / 系统噪音 */
export function trackOf(kind: LogKind): LogTrack {
  switch (kind) {
    case 'user':
    case 'assistant':
    case 'tool_call':
    case 'tool_result':
    case 'reasoning':
    case 'approval':
    case 'interrupt':
      return 'chat';
    case 'companion':
      return 'watch';
    case 'metric':
    case 'usage':
      return 'metrics';
    default:
      return 'system';
  }
}

const BUFFER_CAP = 1000;

// 双通道日志：
// 1. VS Code Output 面板「QuietPair」——实时查看
// 2. JSONL transcript 落盘（globalStorage/logs/session-*.jsonl）——复盘整次会话
export class Logger implements vscode.Disposable {
  private channel = vscode.window.createOutputChannel('QuietPair', { log: true });
  private stream: fs.WriteStream;
  readonly filePath: string;
  private buffer: LogEntry[] = [];
  private listeners: Array<(entry: LogEntry) => void> = [];

  constructor(context: vscode.ExtensionContext) {
    const dir = path.join(context.globalStorageUri.fsPath, 'logs');
    fs.mkdirSync(dir, { recursive: true });
    this.filePath = path.join(dir, `session-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
    this.stream = fs.createWriteStream(this.filePath, { flags: 'a' });
    this.event('lifecycle', { summary: `session started → ${this.filePath}` });
  }

  event(kind: LogKind, data: Record<string, unknown>): void {
    const entry: LogEntry = { ts: new Date().toISOString(), kind, ...data, track: trackOf(kind) };
    this.stream.write(JSON.stringify(entry) + '\n');
    this.buffer.push(entry);
    if (this.buffer.length > BUFFER_CAP) {
      this.buffer.splice(0, this.buffer.length - BUFFER_CAP);
    }
    for (const listener of this.listeners) {
      listener(entry);
    }
    const summary = typeof data.summary === 'string' ? data.summary : JSON.stringify(data).slice(0, 300);
    this.channel.info(`[${kind}] ${summary}`);
  }

  /** 内存中的最近事件（新→旧顺序保持写入序），给 Activity 视图用 */
  recent(track?: LogTrack): LogEntry[] {
    return track ? this.buffer.filter((e) => e.track === track) : [...this.buffer];
  }

  /** 订阅实时事件流（Activity 视图打开时推送到面板） */
  onEvent(listener: (entry: LogEntry) => void): vscode.Disposable {
    this.listeners.push(listener);
    return {
      dispose: () => {
        this.listeners = this.listeners.filter((l) => l !== listener);
      },
    };
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
