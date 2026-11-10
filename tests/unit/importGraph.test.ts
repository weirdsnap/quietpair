/**
 * ImportGraph 的单元测试：各语言引用解析、相对路径解析、双向索引维护、同包启发式。
 * 召回优先的启发式，但已覆盖的形态必须钉死——确认修复的候选圈定依赖它。
 */
import { describe, it, expect } from 'vitest';
import { ImportGraph, parseImportSpecifiers } from '../../src/core/importGraph';

function graphWith(files: Record<string, { lang: string; text: string }>): ImportGraph {
  const g = new ImportGraph();
  for (const rel of Object.keys(files)) {
    g.registerFile(rel);
  }
  for (const [rel, { lang, text }] of Object.entries(files)) {
    g.updateFile(rel, lang, text);
  }
  return g;
}

describe('parseImportSpecifiers', () => {
  it('TS/JS：from / 副作用 import / require', () => {
    const specs = parseImportSpecifiers(
      'typescript',
      `import { a } from './b';\nimport './side';\nexport * from '../c';\nconst d = require('./d');\nimport lodash from 'lodash';`
    ).map((s) => s.specifier);
    expect(specs).toEqual(['./b', './side', '../c', './d', 'lodash']);
  });

  it('Python：from import 展开子模块候选 + import 语句', () => {
    const specs = parseImportSpecifiers(
      'python',
      `from .utils import helper\nfrom pkg.mod import A, B as Bee\nimport os, sys\nimport pkg.sub as s`
    ).map((s) => s.specifier);
    expect(specs).toContain('.utils');
    expect(specs).toContain('.utils.helper');
    expect(specs).toContain('pkg.mod');
    expect(specs).toContain('pkg.mod.A');
    expect(specs).toContain('os');
    expect(specs).toContain('pkg.sub');
  });

  it('C/C++：只收引号 include', () => {
    const specs = parseImportSpecifiers('cpp', `#include "util.h"\n# include "sub/dep.hpp"\n#include <vector>`).map(
      (s) => s.specifier
    );
    expect(specs).toEqual(['util.h', 'sub/dep.hpp']);
  });

  it('不认识的语种返回空', () => {
    expect(parseImportSpecifiers('go', 'import "fmt"')).toEqual([]);
  });
});

describe('ImportGraph', () => {
  it('TS 相对 import：双向关系都可见', () => {
    const g = graphWith({
      'src/a.ts': { lang: 'typescript', text: `import { b } from './b';` },
      'src/b.ts': { lang: 'typescript', text: `export const b = 1;` },
    });
    expect(g.related('src/a.ts')).toEqual([{ file: 'src/b.ts', why: 'imported by this file' }]);
    expect(g.related('src/b.ts')).toEqual([{ file: 'src/a.ts', why: 'imports this file' }]);
  });

  it('包名 import 不产生边；../ 与 index 解析', () => {
    const g = graphWith({
      'src/ui/panel.ts': { lang: 'typescript', text: `import x from 'react';\nimport { y } from '../core';` },
      'src/core/index.ts': { lang: 'typescript', text: `export const y = 1;` },
    });
    expect(g.related('src/ui/panel.ts')).toEqual([{ file: 'src/core/index.ts', why: 'imported by this file' }]);
    expect(g.related('src/ui/panel.ts')).toHaveLength(1);
  });

  it('Python 相对 import：from . import x 解析到同目录模块', () => {
    const g = graphWith({
      'app/main.py': { lang: 'python', text: `from . import utils\nimport os` },
      'app/utils.py': { lang: 'python', text: `def helper(): pass` },
    });
    expect(g.related('app/main.py')).toEqual([{ file: 'app/utils.py', why: 'imported by this file' }]);
  });

  it('C++ 引号 include 解析到同目录头文件', () => {
    const g = graphWith({
      'src/socket.cpp': { lang: 'cpp', text: `#include "socket.h"\n#include <vector>` },
      'src/socket.h': { lang: 'cpp', text: `#pragma once` },
    });
    expect(g.related('src/socket.cpp')).toEqual([{ file: 'src/socket.h', why: 'imported by this file' }]);
  });

  it('updateFile 重解析：删掉 import 后双向边都消失', () => {
    const g = graphWith({
      'a.ts': { lang: 'typescript', text: `import './b';` },
      'b.ts': { lang: 'typescript', text: `` },
    });
    expect(g.related('b.ts')).toHaveLength(1);
    g.updateFile('a.ts', 'typescript', '// no imports');
    expect(g.related('a.ts')).toEqual([]);
    expect(g.related('b.ts')).toEqual([]);
  });

  it('removeFile 清理路径与边', () => {
    const g = graphWith({
      'a.ts': { lang: 'typescript', text: `import './b';` },
      'b.ts': { lang: 'typescript', text: `` },
    });
    g.removeFile('b.ts');
    expect(g.related('a.ts')).toEqual([]);
  });

  it('Go 同包启发式：同目录 .go 互相关联，不同目录无关', () => {
    const g = graphWith({
      'pkg/a.go': { lang: 'go', text: `package pkg` },
      'pkg/b.go': { lang: 'go', text: `package pkg` },
      'other/c.go': { lang: 'go', text: `package other` },
    });
    const rel = g.related('pkg/a.go');
    expect(rel).toEqual([{ file: 'pkg/b.go', why: 'same package' }]);
  });

  it('Windows 反斜杠路径归一化', () => {
    const g = new ImportGraph();
    g.registerFile('src\\b.ts');
    g.updateFile('src\\a.ts', 'typescript', `import './b';`);
    expect(g.related('src/a.ts')).toEqual([{ file: 'src/b.ts', why: 'imported by this file' }]);
  });

  // 等价类补充：自引用 / 循环引用 / 解析失败 / 上窜钳制——
  // 每个类一个代表，钉死「不产生坏边、不产生环、不抛异常」
  describe('等价类：异常形态的引用', () => {
    it('自引用不产生边', () => {
      const g = graphWith({
        'a.ts': { lang: 'typescript', text: `import './a';` },
      });
      expect(g.related('a.ts')).toEqual([]);
    });

    it('循环引用：双向边都建立，标签按先出边优先', () => {
      const g = graphWith({
        'a.ts': { lang: 'typescript', text: `import './b';` },
        'b.ts': { lang: 'typescript', text: `import './a';` },
      });
      // a → b 与 b → a 同时存在；related 的 why 先填出边标签，入边不覆盖
      expect(g.related('a.ts')).toEqual([{ file: 'b.ts', why: 'imported by this file' }]);
      expect(g.related('b.ts')).toEqual([{ file: 'a.ts', why: 'imported by this file' }]);
    });

    it('解析失败的相对引用静默跳过', () => {
      const g = graphWith({
        'a.ts': { lang: 'typescript', text: `import './ghost';` },
      });
      expect(g.related('a.ts')).toEqual([]);
    });

    it('../ 上窜超出根目录时钳制在根，不抛异常', () => {
      const g = graphWith({
        'src/deep/mod/a.ts': { lang: 'typescript', text: `import '../../../../../b';` },
        'b.ts': { lang: 'typescript', text: `` },
      });
      expect(g.related('src/deep/mod/a.ts')).toEqual([{ file: 'b.ts', why: 'imported by this file' }]);
    });
  });
});
