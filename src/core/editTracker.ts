/**
 * 编辑追踪器（纯模块，零 vscode 依赖）：记录每个文件最后一次编辑的时间戳。
 * 服务确认修复的闸门诚实化：「A 文件没变」不等于「什么都没变」——
 * 问题的身份是论断不是坐标，修复可能落在别的文件（改声明去对齐调用），
 * 所以闸门要问的是「这条建议打出之后，整个工作区动过没有」。
 * 与 ActivityTracker 的分工：那边记「用户活动轨迹」（排除 Agent 写入、15 分钟窗口、
 * 为 prompt 摘要服务）；这里记「一切改动」（含 Agent 写入、无窗口、为闸门判定服务）。
 */

const MAX_FILES = 1000;

export class EditTracker {
  private lastEditAt = new Map<string, number>(); // 插入序 = 时间序（重插到末尾）

  recordEdit(relFile: string, at: number = Date.now()): void {
    this.lastEditAt.delete(relFile);
    this.lastEditAt.set(relFile, at);
    if (this.lastEditAt.size > MAX_FILES) {
      let n = MAX_FILES / 2;
      for (const key of this.lastEditAt.keys()) {
        this.lastEditAt.delete(key);
        if (--n <= 0) {
          break;
        }
      }
    }
  }

  editedAfter(relFile: string, ts: number): boolean {
    return (this.lastEditAt.get(relFile) ?? 0) > ts;
  }

  /** ts 之后被编辑过的所有文件（可用 except 排除建议所在文件自身） */
  filesEditedAfter(ts: number, except?: string): string[] {
    const out: string[] = [];
    for (const [f, t] of this.lastEditAt) {
      if (t > ts && f !== except) {
        out.push(f);
      }
    }
    return out;
  }

  get size(): number {
    return this.lastEditAt.size;
  }
}
