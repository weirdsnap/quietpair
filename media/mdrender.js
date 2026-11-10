/**
 * 迷你 markdown 渲染的纯逻辑（零依赖，CSP 安全）：
 * 围栏代码、GFM 表格、链接（markdown 链接 + 裸 URL，只放行 http/https）、行内代码、加粗。
 * UMD：浏览器挂 window.MdRender（chat.js 只做 DOM 组装），Node/vitest 走 module.exports。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  root.MdRender = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function renderInline(escaped) {
    // 先按行内代码切段：代码段内不做链接/加粗替换。链接一次扫描两种形态——
    // markdown 链接优先匹配（它的 URL 随之被整体消费），裸 URL 不会匹配进已生成的标签里
    return escaped
      .split(/(`[^`\n]+`)/g)
      .map(function (seg, i) {
        if (i % 2 === 1) {
          return '<code>' + seg.slice(1, -1) + '</code>';
        }
        return seg
          .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s<()"'`]+)/g, function (m, text, mdUrl, bareUrl) {
            if (mdUrl) {
              return '<a href="' + mdUrl + '" target="_blank" rel="noreferrer">' + text + '</a>';
            }
            // 裸 URL 末尾的句读标点（句子结尾的 . , 等）不属于 URL
            let trail = '';
            let u = bareUrl;
            while (u && /[.,;:!?]/.test(u.charAt(u.length - 1))) {
              trail = u.charAt(u.length - 1) + trail;
              u = u.slice(0, -1);
            }
            return '<a href="' + u + '" target="_blank" rel="noreferrer">' + u + '</a>' + trail;
          })
          .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      })
      .join('');
  }

  // markdown 表格分隔行：| --- | :-: | ---: | 这类
  function isTableSeparator(line) {
    return /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line) && line.indexOf('-') !== -1;
  }

  function splitRow(line) {
    let l = line.trim();
    if (l.charAt(0) === '|') {
      l = l.slice(1);
    }
    if (l.charAt(l.length - 1) === '|') {
      l = l.slice(0, -1);
    }
    return l.split('|').map(function (c) {
      return c.trim();
    });
  }

  // 代码围栏分段：``` 奇偶切换；奇数段=代码（首行语言标记剥离、末尾换行剥离），偶数段=文本
  function splitFences(text) {
    const parts = text.split('```');
    const out = [];
    parts.forEach(function (part, i) {
      if (i % 2 === 1) {
        let code = part;
        const nl = part.indexOf('\n');
        if (nl === 0) {
          code = part.slice(1); // 围栏标记后紧跟的换行属于语法，不属于内容
        } else if (nl > 0 && nl <= 20 && !part.slice(0, nl).includes(' ')) {
          code = part.slice(nl + 1); // 首行是语言标记
        }
        out.push({ type: 'code', content: code.replace(/\n$/, '') });
      } else if (part.length > 0) {
        out.push({ type: 'text', content: part });
      }
    });
    return out;
  }

  // 文本段分块：连续表格行收成 table 块（表头行 + 分隔行 + 表体行），
  // 其余累积为 text 块（全空白的块不产出）
  function splitBlocks(text) {
    const lines = text.split('\n');
    const out = [];
    let buf = [];
    function flush() {
      const plain = buf.join('\n');
      buf = [];
      if (plain.trim()) {
        out.push({ type: 'text', text: plain });
      }
    }
    let i = 0;
    while (i < lines.length) {
      if (lines[i].indexOf('|') !== -1 && lines[i].trim() && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
        flush();
        const tbl = [lines[i], lines[i + 1]];
        i += 2;
        while (i < lines.length && lines[i].trim() && lines[i].indexOf('|') !== -1) {
          tbl.push(lines[i]);
          i++;
        }
        out.push({ type: 'table', lines: tbl });
      } else {
        buf.push(lines[i]);
        i++;
      }
    }
    flush();
    return out;
  }

  return {
    escapeHtml: escapeHtml,
    renderInline: renderInline,
    isTableSeparator: isTableSeparator,
    splitRow: splitRow,
    splitFences: splitFences,
    splitBlocks: splitBlocks,
  };
});
