/**
 * 行级 diff：公共前后缀夹逼，不引依赖。
 *
 * 精度取舍：多处分散的编辑会被夹成一个大变化区（保守方向）——
 * 但「未变的前缀/后缀」是逐行精确为真的，这正是确定性豁免需要的保证：
 * 落在未变区里的行，其内容与前序上下文和旧版逐字节一致。
 */

export interface LineDiff {
  /** 开头未变的行数（1-based 行号 ≤ prefixLines 的行未变） */
  prefixLines: number;
  /** 结尾未变的行数（旧文件行号 > oldLineCount - suffixLines 的行未变） */
  suffixLines: number;
  oldLineCount: number;
  newLineCount: number;
}

/** 两版文本的行级差异；完全一致返回 null */
export function lineDiff(oldText: string, newText: string): LineDiff | null {
  if (oldText === newText) {
    return null;
  }
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const minLen = Math.min(oldLines.length, newLines.length);
  let prefix = 0;
  while (prefix < minLen && oldLines[prefix] === newLines[prefix]) {
    prefix++;
  }
  let suffix = 0;
  while (
    suffix < minLen - prefix &&
    oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix++;
  }
  return { prefixLines: prefix, suffixLines: suffix, oldLineCount: oldLines.length, newLineCount: newLines.length };
}

/**
 * 旧坐标 line 是否远离一切编辑（该行及其邻近上下文必然没变）。
 * margin 给「问题依赖周边几行上下文」留余量。
 * 注意保证的方向：为真时该行内容确定未变；为假只是说「不确定」，不代表一定变了。
 */
export function isLineOutsideEdits(line: number, diff: LineDiff, margin = 3): boolean {
  return line <= diff.prefixLines - margin || line > diff.oldLineCount - diff.suffixLines + margin;
}
