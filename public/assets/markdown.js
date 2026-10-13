/**
 * 极简 Markdown 渲染器。
 * 先整体转义 HTML，再套用格式，并把代码块/行内代码用占位符隔离 —— 因此天然免疫 XSS，
 * 也不会被 AI 输出的 HTML 注入。支持流式渲染（未闭合的代码围栏也能正常显示）。
 */

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

function codeBlockHtml({ lang, code }) {
  return (
    '<div class="code-block">' +
    '<div class="code-head"><span>' + escapeHtml(lang || '代码') + '</span>' +
    '<button type="button" data-copy>复制</button></div>' +
    '<pre><code>' + escapeHtml(code) + '</code></pre>' +
    '</div>'
  );
}

/** 行内格式（输入已是转义过的文本） */
function inlineFormat(text) {
  return text
    .replace(/\*\*\*([^*\n]+)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^\w*])\*([^*\n]+)\*(?![\w*])/g, '$1<em>$2</em>')
    .replace(/(^|[^\w_])_([^_\n]+)_(?![\w_])/g, '$1<em>$2</em>')
    .replace(/~~([^~\n]+)~~/g, '<del>$1</del>')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g,
      '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
}

const isHr = (l) => /^\s{0,3}([-*_])\s*(\1\s*){2,}$/.test(l);
const isHeading = (l) => /^\s{0,3}#{1,6}\s+/.test(l);
// 注意：分块阶段文本已完成 HTML 转义，' > ' 此时是 '&gt;'
const isQuote = (l) => /^\s{0,3}(?:>|&gt;)\s?/.test(l);
const stripQuote = (l) => l.replace(/^\s{0,3}(?:>|&gt;)\s?/, '');
const isFence = (l) => /^\s{0,3}\u0000C\d+\u0000\s*$/.test(l);
const UL = /^\s{0,6}[-*+]\s+(.*)$/;
const OL = /^\s{0,6}(\d+)[.)]\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function splitRow(line) {
  return line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
}

export function renderMarkdown(input) {
  let text = String(input ?? '').replace(/\r\n?/g, '\n');

  // 1. 抽出围栏代码块（未闭合时一直吃到结尾，保证流式输出可用）
  const blocks = [];
  text = text.replace(/```([^\n`]*)\n?([\s\S]*?)(?:```|$)/g, (_m, lang, code) => {
    blocks.push({ lang: String(lang).trim(), code: code.replace(/\n$/, '') });
    return '\u0000C' + (blocks.length - 1) + '\u0000';
  });

  // 2. 抽出行内代码
  const inlines = [];
  text = text.replace(/`([^`\n]+)`/g, (_m, code) => {
    inlines.push(code);
    return '\u0000I' + (inlines.length - 1) + '\u0000';
  });

  // 3. 转义剩余文本，之后的所有格式操作都在安全文本上进行
  text = escapeHtml(text);

  // 4. 分块
  const lines = text.split('\n');
  const html = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) { i++; continue; }

    if (isFence(line)) { html.push(line.trim()); i++; continue; }

    if (isHr(line)) { html.push('<hr>'); i++; continue; }

    if (isHeading(line)) {
      const m = line.match(/^\s{0,3}(#{1,6})\s+(.*)$/);
      const level = Math.min(m[1].length, 4);
      html.push(`<h${level}>${inlineFormat(m[2].trim())}</h${level}>`);
      i++;
      continue;
    }

    // 表格
    if (line.includes('|') && TABLE_SEP.test(lines[i + 1] || '')) {
      const head = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      let t = '<table><thead><tr>' + head.map((c) => `<th>${inlineFormat(c)}</th>`).join('') + '</tr></thead><tbody>';
      for (const r of rows) {
        t += '<tr>' + head.map((_c, ci) => `<td>${inlineFormat(r[ci] ?? '')}</td>`).join('') + '</tr>';
      }
      html.push(t + '</tbody></table>');
      continue;
    }

    // 引用
    if (isQuote(line)) {
      const buf = [];
      while (i < lines.length && (isQuote(lines[i]) || (buf.length && lines[i].trim()))) {
        buf.push(stripQuote(lines[i]));
        i++;
      }
      // 此处 buf 已是转义后的文本，不能再走一遍 renderMarkdown（会二次转义）
      html.push('<blockquote>' + inlineFormat(buf.join('<br>')) + '</blockquote>');
      continue;
    }

    // 列表
    if (UL.test(line) || OL.test(line)) {
      const ordered = OL.test(line);
      const items = [];
      while (i < lines.length) {
        const m = ordered ? lines[i].match(OL) : lines[i].match(UL);
        if (m) { items.push(ordered ? m[2] : m[1]); i++; continue; }
        // 列表项内的续行
        if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) {
          items[items.length - 1] += ' ' + lines[i].trim();
          i++;
          continue;
        }
        break;
      }
      const tag = ordered ? 'ol' : 'ul';
      html.push(`<${tag}>` + items.map((it) => `<li>${inlineFormat(it)}</li>`).join('') + `</${tag}>`);
      continue;
    }

    // 段落
    const buf = [];
    while (
      i < lines.length && lines[i].trim() &&
      !isHr(lines[i]) && !isHeading(lines[i]) && !isQuote(lines[i]) &&
      !isFence(lines[i]) && !UL.test(lines[i]) && !OL.test(lines[i])
    ) {
      buf.push(lines[i]);
      i++;
    }
    if (buf.length) html.push('<p>' + inlineFormat(buf.join('<br>')) + '</p>');
  }

  // 5. 回填代码
  return html
    .join('\n')
    .replace(/\u0000C(\d+)\u0000/g, (_m, n) => codeBlockHtml(blocks[+n] || { code: '' }))
    .replace(/\u0000I(\d+)\u0000/g, (_m, n) => '<code>' + escapeHtml(inlines[+n] ?? '') + '</code>');
}
