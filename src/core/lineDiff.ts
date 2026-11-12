/**
 * 行级 diff：公共前后缀夹逼，不引依赖。
 *
 * 精度取舍：多处分散的编辑会被夹成一个大变化区（保守方向）——
 * 但「未变的前缀/后缀」是逐行精确为真的。当前消费者：confirmFix 复审 prompt
 * 的变更集线索（告诉模型「用户改了哪几行」）；区域级判定需要时在此基础上加。
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
