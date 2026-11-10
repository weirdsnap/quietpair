/**
 * Import 关系图（纯模块）：从源码文本解析模块引用，维护文件级双向索引。
 * 召回优先的启发式：正则解析 + 相对路径解析。被注释/动态 import 骗过只是多圈一个
 * 候选文件（模型多看一眼，无害）；服务场景是确认修复时回答「这条建议的相关文件
 * 有哪些」——修复可能落在被 import 的文件里（改声明对齐调用），也可能落在
 * import 了本文件的文件里（改调用对齐声明）。
 * 更精确的关系（实例持有、方法调用指向）留给 LSP 按需查询，不在此建图。
 */

export interface Relation {
  file: string;
  why: string;
}

export interface ImportSpecifier {
  specifier: string;
  relative: boolean;
}

/** 同包文件无需 import 即可互相可见的语言（按扩展名判断） */
const SAME_PACKAGE_EXTS = new Set(['.go', '.java', '.kt']);

const RESOLVE_EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.c', '.cc', '.cpp', '.cxx', '.h', '.hh', '.hpp'];

export function normPath(p: string): string {
  return p.replace(/\\/g, '/');
}

function dirOf(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

function extOf(p: string): string {
  const i = p.lastIndexOf('.');
  return i < 0 ? '' : p.slice(i).toLowerCase();
}

/** 相对 specifier 拼到所在目录上，消化 . 和 .. */
function joinRel(dir: string, spec: string): string {
  const out: string[] = [];
  for (const part of `${dir}/${spec}`.split('/')) {
    if (part === '' || part === '.') {
      continue;
    }
    if (part === '..') {
      out.pop();
    } else {
      out.push(part);
    }
  }
  return out.join('/');
}

/** 从文件路径推断语言 ID（后台扫描建图时没有 TextDocument 可用） */
export function languageIdFromPath(p: string): string {
  switch (extOf(p)) {
    case '.ts':
      return 'typescript';
    case '.tsx':
      return 'typescriptreact';
    case '.js':
    case '.mjs':
    case '.cjs':
      return 'javascript';
    case '.jsx':
      return 'javascriptreact';
    case '.py':
      return 'python';
    case '.c':
    case '.h':
      return 'c';
    case '.cc':
    case '.cpp':
    case '.cxx':
    case '.hh':
    case '.hpp':
      return 'cpp';
    case '.go':
      return 'go';
    case '.java':
      return 'java';
    case '.kt':
      return 'kotlin';
    default:
      return '';
  }
}

/** 各语言的引用语法解析；不认识的语种返回空（靠同包启发式兜底） */
export function parseImportSpecifiers(languageId: string, text: string): ImportSpecifier[] {
  const out: ImportSpecifier[] = [];
  const seen = new Set<string>();
  const push = (specifier: string, relative: boolean): void => {
    if (specifier && !seen.has(specifier)) {
      seen.add(specifier);
      out.push({ specifier, relative });
    }
  };
  switch (languageId) {
    case 'typescript':
    case 'typescriptreact':
    case 'javascript':
    case 'javascriptreact': {
      const re = /(?:import|export)\s[^'"\n]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)/g;
      for (let m; (m = re.exec(text)); ) {
        const spec = m[1] ?? m[2] ?? m[3];
        push(spec, spec.startsWith('.'));
      }
      break;
    }
    case 'python': {
      // from X import a, b：X 本身与 X.a / X.b 都是候选（a 可能是子模块也可能是名字，解析时按存在性过滤）
      const fromRe = /^\s*from\s+([.\w]+)\s+import\s+([^#\n]+)/gm;
      for (let m; (m = fromRe.exec(text)); ) {
        push(m[1], m[1].startsWith('.'));
        for (const name of m[2].split(',')) {
          const id = name.trim().split(/\s+as\s+/)[0].trim();
          if (/^\w+$/.test(id)) {
            // 纯点 base（`from . import x`）直接拼接；否则补一个分隔点（`from .a import b` → .a.b）
            const joined = /^\.+$/.test(m[1]) ? `${m[1]}${id}` : `${m[1]}.${id}`;
            push(joined, m[1].startsWith('.'));
          }
        }
      }
      const importRe = /^\s*import\s+([^#\n]+)/gm;
      for (let m; (m = importRe.exec(text)); ) {
        for (const part of m[1].split(',')) {
          const id = part.trim().split(/\s+as\s+/)[0].trim();
          if (/^[.\w]+$/.test(id)) {
            push(id, id.startsWith('.'));
          }
        }
      }
      break;
    }
    case 'c':
    case 'cpp': {
      // 只收引号 include（项目内头文件）；尖括号是系统头
      const re = /^\s*#\s*include\s*"([^"]+)"/gm;
      for (let m; (m = re.exec(text)); ) {
        push(m[1], true);
      }
      break;
    }
  }
  return out;
}

/** python specifier → 路径基底；点前导个数 = 向上层级（PEP 328） */
function pythonBase(fromRel: string, spec: string): string {
  let dots = 0;
  while (spec[dots] === '.') {
    dots++;
  }
  const rest = spec.slice(dots).replace(/\./g, '/');
  if (dots === 0) {
    return rest;
  }
  let dir = dirOf(fromRel);
  for (let i = 1; i < dots; i++) {
    dir = dirOf(dir);
  }
  return rest ? joinRel(dir, rest) : dir;
}

export class ImportGraph {
  private files = new Set<string>();
  private outgoing = new Map<string, Set<string>>();
  private incoming = new Map<string, Set<string>>();

  registerFile(rel: string): void {
    this.files.add(normPath(rel));
  }

  removeFile(rel: string): void {
    rel = normPath(rel);
    this.files.delete(rel);
    this.setEdges(rel, new Set());
    // 清掉所有指向它的入边（别人 import 了一个已删除的文件）
    for (const src of this.incoming.get(rel) ?? []) {
      this.outgoing.get(src)?.delete(rel);
    }
    this.incoming.delete(rel);
  }

  /** 登记文件并重解析它的出边（内容变化时整体重算该文件的边，双向索引同步维护） */
  updateFile(rel: string, languageId: string, text: string): void {
    rel = normPath(rel);
    this.files.add(rel);
    const targets = new Set<string>();
    for (const spec of parseImportSpecifiers(languageId, text)) {
      const hit = this.resolve(rel, languageId, spec);
      if (hit && hit !== rel) {
        targets.add(hit);
      }
    }
    this.setEdges(rel, targets);
  }

  /** 双向相关文件：我 import 的（修复可能在那）+ import 我的（修复可能在这）+ 同包 */
  related(rel: string): Relation[] {
    rel = normPath(rel);
    const out = new Map<string, string>();
    for (const f of this.outgoing.get(rel) ?? []) {
      out.set(f, 'imported by this file');
    }
    for (const f of this.incoming.get(rel) ?? []) {
      if (!out.has(f)) {
        out.set(f, 'imports this file');
      }
    }
    if (SAME_PACKAGE_EXTS.has(extOf(rel))) {
      const dir = dirOf(rel);
      for (const f of this.files) {
        if (f !== rel && !out.has(f) && dirOf(f) === dir && SAME_PACKAGE_EXTS.has(extOf(f))) {
          out.set(f, 'same package');
        }
      }
    }
    return [...out].map(([file, why]) => ({ file, why }));
  }

  private setEdges(rel: string, targets: Set<string>): void {
    for (const old of this.outgoing.get(rel) ?? []) {
      const inc = this.incoming.get(old);
      if (inc) {
        inc.delete(rel);
        if (inc.size === 0) {
          this.incoming.delete(old);
        }
      }
    }
    this.outgoing.delete(rel);
    if (targets.size > 0) {
      this.outgoing.set(rel, targets);
    }
    for (const t of targets) {
      let inc = this.incoming.get(t);
      if (!inc) {
        inc = new Set();
        this.incoming.set(t, inc);
      }
      inc.add(rel);
    }
  }

  private resolve(fromRel: string, languageId: string, spec: ImportSpecifier): string | undefined {
    const bases: string[] = [];
    if (languageId === 'python') {
      const base = pythonBase(fromRel, spec.specifier);
      bases.push(base);
      if (!spec.relative) {
        // 绝对 import 先按工作区根解析，再退到同目录（脚本式项目常见）
        bases.push(joinRel(dirOf(fromRel), base));
      }
    } else if (languageId === 'c' || languageId === 'cpp') {
      bases.push(joinRel(dirOf(fromRel), spec.specifier), spec.specifier); // 引号 include：相对所在目录，根目录兜底
    } else {
      if (!spec.relative) {
        return undefined; // 包名 import（lodash/react…）指向 node_modules，不是工作区文件
      }
      bases.push(joinRel(dirOf(fromRel), spec.specifier));
    }
    for (const base of bases) {
      const hit = this.tryCandidates(base);
      if (hit) {
        return hit;
      }
    }
    return undefined;
  }

  private tryCandidates(base: string): string | undefined {
    if (!base) {
      return undefined;
    }
    const candidates = [base];
    for (const e of RESOLVE_EXTS) {
      candidates.push(base + e);
    }
    candidates.push(`${base}/__init__.py`);
    for (const e of ['.ts', '.tsx', '.js', '.jsx']) {
      candidates.push(`${base}/index${e}`);
    }
    for (const c of candidates) {
      if (this.files.has(c)) {
        return c;
      }
    }
    return undefined;
  }
}
