import MarkdownIt from 'markdown-it';
import stringWidth from 'string-width';

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function glyphWidth(glyph) {
  return stringWidth(glyph);
}

/** Terminal cell width, measured by grapheme rather than UTF-16 code unit. */
export function textWidth(text) {
  return stringWidth(text);
}

function escaped(source, offset) {
  let backslashes = 0;
  while (offset > 0 && source[--offset] === '\\') backslashes++;
  return backslashes % 2 === 1;
}

function installMath(md) {
  md.inline.ruler.before('escape', 'terminal_math', (state, silent) => {
    const start = state.pos;
    const source = state.src;
    let open, close, display;
    if (source.startsWith('\\(', start)) { open = '\\('; close = '\\)'; display = false; }
    else if (source.startsWith('\\[', start)) { open = '\\['; close = '\\]'; display = true; }
    else if (source.startsWith('$$', start)) { open = close = '$$'; display = true; }
    else if (source[start] === '$' && !/\s/.test(source[start + 1] || ' ')) {
      open = close = '$'; display = false;
    } else return false;
    let end = start + open.length;
    while ((end = source.indexOf(close, end)) !== -1 && end < state.posMax) {
      if (!escaped(source, end) && end > start + open.length &&
          (display || !/\s/.test(source[end - 1])) &&
          !(close === '$' && /\d/.test(source[end + 1] || ''))) break;
      end += close.length;
    }
    if (end === -1 || end >= state.posMax) return false;
    const tex = source.slice(start + open.length, end);
    if (!display && tex.includes('\n')) return false;
    if (!silent) {
      const token = state.push('terminal_math', '', 0);
      token.content = tex;
      token.meta = { display, source: source.slice(start, end + close.length) };
    }
    state.pos = end + close.length;
    return true;
  });
  md.block.ruler.before('fence', 'terminal_math_block', (state, startLine, endLine, silent) => {
    const begin = state.bMarks[startLine] + state.tShift[startLine];
    const first = state.src.slice(begin, state.eMarks[startLine]);
    const open = first.startsWith('$$') ? '$$' : first.startsWith('\\[') ? '\\[' : null;
    if (!open) return false;
    const close = open === '$$' ? '$$' : '\\]';
    let end = startLine, content = first.slice(open.length), closing = content.indexOf(close);
    while (closing < 0 && ++end < endLine) {
      content += '\n' + state.src.slice(state.bMarks[end] + state.tShift[end], state.eMarks[end]);
      closing = content.indexOf(close);
    }
    if (closing < 0 || content.slice(closing + close.length).trim()) return false;
    if (silent) return true;
    const token = state.push('terminal_math_block', '', 0);
    token.block = true;
    token.content = content.slice(0, closing).trim();
    token.meta = { display: true, source: open + content.slice(0, closing) + close };
    token.map = [startLine, end + 1];
    state.line = end + 1;
    return true;
  }, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });
}

const markdown = new MarkdownIt({ html: false, linkify: false, breaks: false }).use(installMath);

// Markdown may contain literal controls or numeric entities that decode into
// them. A native-text host must never receive document-controlled CSI/OSC bytes.
function safeText(text) {
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu, character => {
    const code = character.codePointAt(0);
    return code < 32 ? String.fromCodePoint(0x2400 + code) : code === 127 ? '␡' : '�';
  });
}
function textAtom(text, style = {}) { return { type: 'text', text: safeText(text), style }; }
function mathAtom(token) { return { type: 'math', tex: token.content, display: token.meta.display, source: token.meta.source }; }

function inlineAtoms(tokens, baseStyle = {}) {
  const out = [], stack = [baseStyle];
  for (const token of tokens || []) {
    const style = stack.at(-1);
    if (token.type.endsWith('_open')) {
      const addition = token.type === 'strong_open' ? { bold: true } :
        token.type === 'em_open' ? { italic: true } :
        token.type === 's_open' ? { strikethrough: true } :
        token.type === 'link_open' ? { underline: true, href: token.attrGet('href') } : {};
      stack.push({ ...style, ...addition });
    } else if (token.type.endsWith('_close')) {
      if (stack.length > 1) stack.pop();
    } else if (token.type === 'terminal_math') out.push(mathAtom(token));
    else if (token.type === 'hardbreak') out.push({ type: 'break' });
    else if (token.type === 'softbreak') out.push(textAtom(' ', style));
    else if (token.type === 'code_inline') out.push(textAtom(token.content, { ...style, code: true }));
    else if (token.type === 'image') out.push(textAtom(`[image: ${token.content || token.attrGet('src') || ''}]`, { ...style, dim: true }));
    else if (token.type === 'text' || token.type === 'html_inline') out.push(textAtom(token.content, style));
  }
  return out;
}

function parseBlocks(source) {
  const tokens = markdown.parse(source, {}), blocks = [];
  const lists = [], items = []; let quote = 0, itemPrefix = '', heading = false;
  const prefix = () => '│ '.repeat(quote) + itemPrefix;
  const emit = atoms => {
    blocks.push({ atoms, prefix: prefix(), continuation: '│ '.repeat(quote) + ' '.repeat(textWidth(itemPrefix)) });
    if (itemPrefix) itemPrefix = ' '.repeat(textWidth(itemPrefix));
  };
  const blank = () => {
    if (blocks.length && (blocks.at(-1).atoms?.length || blocks.at(-1).table)) blocks.push({ atoms: [], prefix: '', continuation: '' });
  };
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    switch (token.type) {
      case 'blockquote_open': quote++; break;
      case 'blockquote_close': quote--; blank(); break;
      case 'bullet_list_open': lists.push({ ordered: false, next: 1 }); break;
      case 'ordered_list_open': lists.push({ ordered: true, next: Number(token.attrGet('start') || 1) }); break;
      case 'bullet_list_close': case 'ordered_list_close': lists.pop(); itemPrefix = ' '.repeat(items.at(-1) || 0); if (!lists.length) blank(); break;
      case 'list_item_open': {
        const list = lists.at(-1);
        itemPrefix = '  '.repeat(Math.max(0, lists.length - 1)) + (list?.ordered ? `${list.next++}. ` : '• ');
        items.push(textWidth(itemPrefix));
        break;
      }
      case 'list_item_close': items.pop(); itemPrefix = ' '.repeat(items.at(-1) || 0); break;
      case 'heading_open': heading = true; break;
      case 'heading_close': heading = false; blank(); break;
      case 'inline': emit(inlineAtoms(token.children, heading ? { bold: true } : {})); break;
      case 'paragraph_close': if (!token.hidden && !lists.length) blank(); break;
      case 'fence': case 'code_block': {
        const lines = token.content.replace(/\n$/, '').split('\n');
        for (const line of lines) emit([textAtom(line, { code: true })]);
        blank(); break;
      }
      case 'terminal_math_block': emit([mathAtom(token)]); blank(); break;
      case 'hr': emit([textAtom('─'.repeat(24), { dim: true })]); blank(); break;
      case 'table_open': {
        const table = []; let cells = [], header = false;
        while (++i < tokens.length && tokens[i].type !== 'table_close') {
          const child = tokens[i];
          if (child.type === 'thead_open') header = true;
          if (child.type === 'thead_close') header = false;
          if (child.type === 'tr_open') cells = [];
          if (child.type === 'inline') cells.push(inlineAtoms(child.children, header ? { bold: true } : {}));
          if (child.type === 'tr_close') table.push(cells);
        }
        blocks.push({ table, prefix: prefix(), continuation: prefix() }); blank(); break;
      }
    }
  }
  while (blocks.length && !blocks.at(-1).atoms?.length && !blocks.at(-1).table) blocks.pop();
  return blocks;
}

function splitText(atom) {
  const out = []; let word = '';
  const flush = () => { if (word) out.push({ ...atom, text: word, width: textWidth(word) }); word = ''; };
  for (const { segment } of graphemes.segment(atom.text.replace(/\t/g, '    '))) {
    if (segment === '\n') { flush(); out.push({ type: 'break' }); }
    else if (/^\s$/u.test(segment) || glyphWidth(segment) === 2) {
      flush(); out.push({ ...atom, text: segment, width: glyphWidth(segment), whitespace: /^\s$/u.test(segment) });
    } else word += segment;
  }
  flush(); return out;
}

/**
 * Native terminal text with formula-only images. Each returned row is a logical
 * line group: accumulate heightRows to locate it, paint text at textRow, and
 * place formula pixels at topPx relative to the group. textBaselinePx is an
 * estimate of the terminal font's baseline and may be supplied by the host.
 */
export async function layoutMarkdown(source, options = {}) {
  const columns = Math.max(1, Math.floor(options.columns || 80));
  const cellWidth = options.cellWidth || 8, cellHeight = options.cellHeight || 16;
  const textBaselinePx = options.textBaselinePx ?? cellHeight * .8;
  const fontSize = (options.fontSize || cellHeight) * (options.mathScale || 1);
  const renderer = options.renderer, warnings = [], rows = [];
  const blocks = parseBlocks(safeText(source.replace(/\r\n?/g, '\n')));
  async function prepare(atoms, available) {
    const prepared = [];
    for (const atom of atoms) {
      if (atom.type !== 'math') { prepared.push(...(atom.type === 'text' ? splitText(atom) : [atom])); continue; }
      try {
        if (!renderer?.render) throw new Error('No formula renderer supplied');
        let formula = await renderer.render(atom.tex, { display: atom.display, fontSize, color: options.foreground || '#d8dee9' });
        if (formula.width > available * cellWidth) {
          formula = await renderer.render(atom.tex, { display: atom.display, fontSize: fontSize * available * cellWidth / formula.width * .99, color: options.foreground || '#d8dee9' });
        }
        if (![formula.width, formula.height, formula.baseline].every(Number.isFinite) || formula.width < 0 || formula.height < 0) throw new Error('Invalid formula metrics');
        const width = Math.max(1, Math.ceil(formula.width / cellWidth));
        if (width > available) throw new Error('Formula exceeds available terminal columns');
        prepared.push({ ...atom, formula, width });
      } catch (error) {
        warnings.push({ tex: atom.tex, message: error.message });
        prepared.push(...splitText(textAtom(atom.source, { dim: true })));
      }
    }
    return prepared;
  }
  function wrap(atoms, prefix, continuation) {
    let line = [], column = 0;
    const addPrefix = value => {
      // Extremely narrow panes cannot accommodate a whole list/quote prefix.
      for (const unit of splitText(textAtom(value, { dim: true }))) {
        if (unit.type === 'text' && column + unit.width <= Math.max(0, columns - 1)) { line.push({ ...unit, column }); column += unit.width; }
      }
    };
    const finish = () => {
      while (line.at(-1)?.whitespace) line.pop();
      const math = line.filter(a => a.type === 'math');
      const ascent = Math.max(textBaselinePx, ...math.map(a => a.formula.baseline));
      const descent = Math.max(cellHeight - textBaselinePx, ...math.map(a => a.formula.height - a.formula.baseline));
      const textRow = Math.max(0, Math.ceil((ascent - textBaselinePx) / cellHeight));
      const baselinePx = textRow * cellHeight + textBaselinePx;
      const textRuns = [];
      for (const atom of line) if (atom.type === 'text') {
        const last = textRuns.at(-1);
        if (last && last.column + textWidth(last.text) === atom.column && JSON.stringify(last.style) === JSON.stringify(atom.style)) last.text += atom.text;
        else textRuns.push({ column: atom.column, text: atom.text, style: atom.style });
      }
      rows.push({ textRuns, formulas: math.map(a => ({ column: a.column, formula: a.formula, topPx: baselinePx - a.formula.baseline, tex: a.tex, display: a.display, source: a.source })),
        heightRows: Math.max(1, Math.ceil((baselinePx + descent) / cellHeight)), textRow, baselinePx });
      line = []; column = 0;
    };
    addPrefix(prefix);
    const newLine = () => { finish(); addPrefix(continuation); };
    for (const atom of atoms) {
      if (atom.type === 'break') { newLine(); continue; }
      const available = columns - column;
      if (atom.whitespace && !atom.style.code && column === textWidth(continuation) && !line.some(a => !a.style.dim)) continue;
      if (atom.width > available && column > textWidth(continuation)) newLine();
      if (atom.type === 'text' && atom.width > columns - column) {
        for (const { segment } of graphemes.segment(atom.text)) {
          const width = glyphWidth(segment);
          if (width > columns - column && column > 0) newLine();
          // One-column panes cannot fit any wide glyph. Keep a visible marker
          // instead of silently discarding source text or writing outside them.
          const fits = width <= columns - column;
          const visibleWidth = fits ? width : 1;
          line.push({ ...atom, text: fits ? segment : '�', width: visibleWidth, column }); column += visibleWidth;
        }
      } else if (!(atom.whitespace && !atom.style.code && column === 0)) {
        line.push({ ...atom, column }); column += atom.width;
      }
    }
    finish();
  }
  for (const block of blocks) {
    if (block.table) {
      const available = Math.max(1, columns - textWidth(block.prefix));
      const count = Math.max(1, ...block.table.map(cells => cells.length));
      const cellLimit = Math.max(1, Math.floor((available - (count - 1) * 3) / count));
      const preparedRows = [];
      for (const cells of block.table) preparedRows.push(await Promise.all(cells.map(cell => prepare(cell, cellLimit))));
      const widths = Array.from({ length: count }, (_, i) => Math.min(cellLimit, Math.max(1, ...preparedRows.map(cells => (cells[i] || []).reduce((sum, a) => sum + (a.width || 0), 0)))));
      for (const cells of preparedRows) {
        const atoms = [];
        for (let i = 0; i < cells.length; i++) {
          if (i) atoms.push(...splitText(textAtom(' │ ', { dim: true })));
          atoms.push(...cells[i]);
          const width = cells[i].reduce((sum, a) => sum + (a.width || 0), 0);
          if (width < widths[i]) atoms.push(...splitText(textAtom(' '.repeat(widths[i] - width))));
        }
        wrap(atoms, block.prefix, block.continuation);
      }
    } else {
      const available = Math.max(1, columns - Math.min(columns - 1, textWidth(block.prefix)));
      const atoms = await prepare(block.atoms, available);
      if (atoms.length === 1 && atoms[0].type === 'math' && atoms[0].display && !block.prefix) {
        // Formula-only groups have no native glyph baseline to satisfy. Fit
        // them tightly to whole terminal rows and distribute spare pixels
        // equally above and below, rather than adding text-baseline padding.
        const atom = atoms[0];
        const heightRows = Math.max(1, Math.ceil(atom.formula.height / cellHeight));
        const topPx = Math.max(0, (heightRows * cellHeight - atom.formula.height) / 2);
        rows.push({ textRuns: [], formulas: [{
          column: Math.max(0, Math.floor((columns - atom.width) / 2)),
          formula: atom.formula, topPx, tex: atom.tex, display: true, source: atom.source,
        }], heightRows, textRow: 0, baselinePx: topPx + atom.formula.baseline });
      } else wrap(atoms, block.prefix, block.continuation);
    }
  }
  return { rows, totalRows: rows.reduce((sum, row) => sum + row.heightRows, 0), warnings };
}
