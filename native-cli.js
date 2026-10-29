import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { emitKeypressEvents } from 'node:readline';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import stringWidth from 'string-width';

const ESC = '\x1b';
const safe = text => String(text).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
const rgb = color => {
  const n = Number.parseInt(color.slice(1), 16);
  return `${ESC}[38;2;${n >>> 16};${n >> 8 & 255};${n & 255}m`;
};
const styleEscape = (style, foreground) => {
  let value = `${ESC}[0m${rgb(style?.color || foreground)}`;
  if (style?.code) value += `${ESC}[38;2;229;192;123m`;
  if (style?.dim) value += `${ESC}[2m`;
  if (style?.bold) value += `${ESC}[1m`;
  if (style?.italic) value += `${ESC}[3m`;
  if (style?.underline) value += `${ESC}[4m`;
  if (style?.strikethrough) value += `${ESC}[9m`;
  return value;
};
function fit(text, columns) {
  let result = '', width = 0;
  for (const { segment } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(safe(text))) {
    const size = stringWidth(segment);
    if (width + size > columns) break;
    result += segment; width += size;
  }
  return result;
}
async function queryTerminal(input, output) {
  let response = '', resolve;
  const done = new Promise(r => { resolve = r; });
  const listener = data => {
    response += data.toString();
    if (/\x1b_Gi=31;[^\x1b]*\x1b\\/.test(response) && /\x1b\[(?:6|4);\d+;\d+t/.test(response) && /10;rgb:[a-f\d]+\/[a-f\d]+\/[a-f\d]+(?:\x07|\x1b\\)/i.test(response)) resolve();
  };
  input.on('data', listener);
  output.write(`${ESC}[16t${ESC}[14t${ESC}]10;?${ESC}\\${ESC}_Ga=q,t=d,f=24,s=1,v=1,i=31;AAAA${ESC}\\`);
  const timer = setTimeout(resolve, 350);
  await done;
  clearTimeout(timer); input.off('data', listener);
  const cell = response.match(/\x1b\[6;(\d+);(\d+)t/);
  const window = response.match(/\x1b\[4;(\d+);(\d+)t/);
  const color = response.match(/10;rgb:([a-f\d]+)\/([a-f\d]+)\/([a-f\d]+)/i);
  const columns = output.columns || 100, rows = output.rows || 35;
  const cellWidth = Math.max(1, Math.round(cell ? Number(cell[2]) : window ? Number(window[2]) / columns : 10));
  const cellHeight = Math.max(1, Math.round(cell ? Number(cell[1]) : window ? Number(window[1]) / rows : 20));
  return {
    supported: /\x1b_Gi=31;OK/.test(response), cellWidth, cellHeight,
    pendingInput: response.replace(/\x1b_G[^\x1b]*\x1b\\/g, '').replace(/\x1b\[(?:4|6);\d+;\d+t/g, '').replace(/\x1b\](?:10|11);[^\x07\x1b]*(?:\x07|\x1b\\)/g, ''),
    foreground: color ? '#' + color.slice(1).map(v => Math.round(parseInt(v, 16) * 255 / (16 ** v.length - 1)).toString(16).padStart(2, '0')).join('') : '#d8dee9',
  };
}
async function edit(file) {
  const command = process.env.VISUAL || process.env.EDITOR || 'vi';
  await new Promise((resolve, reject) => {
    const child = spawn(process.env.SHELL || '/bin/sh', ['-c', `${command} "$1"`, 'termlatex', file], { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`Editor exited with ${signal || code}`)));
  });
}

export async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    help: { type: 'boolean', short: 'h' }, light: { type: 'boolean' }, text: { type: 'boolean' }, source: { type: 'boolean' },
    render: { type: 'string' }, width: { type: 'string', default: '1000' },
    'font-size': { type: 'string', default: '18' }, 'math-scale': { type: 'string', default: '1' },
    'text-baseline': { type: 'string' }, 'raster-scale': { type: 'string', default: '1' },
  } });
  if (values.help || !positionals.length) {
    console.log(`Usage: termlatex file.md [--math-scale 1] [--text] [--source]
       termlatex file.md --render output.png [--width 1000]

Native terminal Markdown text + MathJax formula images. No Chrome or TeX install.
Keys: ↑/↓ j/k scroll · Space/PgDn/PgUp page · g/G ends
      +/- zoom formulas · s formula source · e edit · r reload · q quit
--font-size 18       Formula em size in pixels (terminal prose font is unchanged).
--math-scale 1       Formula size multiplier (0.5–3).
--text-baseline PX  Terminal glyph baseline from top of cell (default 80% of cell).
--text / --source   Keep equations as selectable LaTeX source.
--light             Dark foreground. --raster-scale 2 is for PNG export.
Kitty graphics required for formulas; unsupported terminals keep source.
Scroll uses terminal rows; tall inline formulas expand the surrounding line height.`);
    return;
  }
  if (positionals.length !== 1) throw new Error('Expected one Markdown file.');
  const file = path.resolve(positionals[0]);
  let fontSize = Number(values['font-size']);
  const initialFontSize = fontSize;
  const mathScale = Number(values['math-scale']);
  const rasterScale = Number(values['raster-scale']);
  const exportWidth = Number(values.width);
  const baseline = values['text-baseline'] === undefined ? undefined : Number(values['text-baseline']);
  if (!Number.isFinite(fontSize) || fontSize < 10 || fontSize > 48) throw new Error('--font-size must be between 10 and 48.');
  if (!Number.isFinite(mathScale) || mathScale < .5 || mathScale > 3) throw new Error('--math-scale must be between 0.5 and 3.');
  if (!values.render && rasterScale !== 1) throw new Error('--raster-scale is only used with --render.');
  if (![1,2].includes(rasterScale)) throw new Error('--raster-scale must be 1 or 2.');
  if (!Number.isInteger(exportWidth) || exportWidth < 200 || exportWidth > 8000) throw new Error('--width must be between 200 and 8000.');
  if (baseline !== undefined && (!Number.isFinite(baseline) || baseline < 0 || baseline > 200)) throw new Error('--text-baseline must be between 0 and 200 pixels.');
  let source = await fs.readFile(file, 'utf8');
  const output = process.stdout, input = process.stdin;
  if (!values.render && (!input.isTTY || !output.isTTY)) throw new Error('Run in an interactive terminal, or use --render output.png.');
  const { createFormulaRenderer, layoutMarkdown, createTerminalGraphics } = await import('view-latex-md-math');
  const renderer = createFormulaRenderer();
  const rawRenderer = { render: async () => { throw new Error('source view'); } };
  let profile = { supported: false, cellWidth: Math.round(fontSize * .6), cellHeight: Math.round(fontSize * 1.4), foreground: '#d8dee9' };
  let referenceCellHeight = profile.cellHeight;
  const layoutOptions = columns => ({ columns, cellWidth: profile.cellWidth, cellHeight: profile.cellHeight,
    fontSize: fontSize*profile.cellHeight/referenceCellHeight, mathScale, textBaselinePx: baseline, foreground: values.light ? '#24292f' : profile.foreground,
    renderer: sourceMode || !profile.supported ? rawRenderer : renderer, baseDir: path.dirname(file) });
  let sourceMode = Boolean(values.source || values.text);
  if (values.render) {
    profile.supported = !sourceMode;
    const columns = Math.max(1, Math.floor(exportWidth / profile.cellWidth));
    const layout = await layoutMarkdown(source, layoutOptions(columns));
    const { exportDocumentPNG } = await import('./native-export.js');
    await exportDocumentPNG(layout, path.resolve(values.render), { columns, ...profile, foreground: values.light ? '#24292f' : profile.foreground, scale: rasterScale });
    console.log(`Rendered ${values.render}`);
    renderer.close?.(); return;
  }
  let active = false, quitting = false, busy = false, timer, layout, groups = [], totalRows = 0;
  let columns = 1, rows = 1, scroll = 0, dirty = false, needsLayout = true;
  let previousLines = [], status = '', lastSource = '', lastSettings = '';
  let sender, probePending = false;
  let layoutGeneration = 0, layoutController;
  let finish;
  const done = new Promise(resolve => { finish = resolve; });
  const enter = () => {
    input.setRawMode(true); input.resume();
    output.write(`${ESC}[?1049h${ESC}[?25l${ESC}[?7l${ESC}[?1000${sourceMode ? 'l' : 'h'}${ESC}[?1006${sourceMode ? 'l' : 'h'}`);
    active = true; previousLines = [];
  };
  const leave = async () => {
    try {
      if (active) {
        try { await sender?.clear(); }
        finally {
          output.write(`${ESC}[0m${ESC}[?7h${ESC}[?1006l${ESC}[?1000l${ESC}[?25h${ESC}[?1049l`);
          active = false;
        }
      }
    } finally {
      if (input.isTTY) input.setRawMode(false);
      input.pause();
    }
  };
  const maxScroll = () => Math.max(0, totalRows - rows);
  const request = (relayout = false) => {
    if (relayout) { layoutGeneration++; layoutController?.abort(); }
    dirty = true; needsLayout ||= relayout;
    if (!busy && !timer && !quitting) timer = setTimeout(() => { timer = null; void update(); }, 16);
  };
  async function update() {
    if (busy || quitting || !active) return;
    busy = true;
    const generation = layoutGeneration;
    const controller = new AbortController();
    layoutController = controller;
    const current = () => !quitting && active && generation === layoutGeneration && !controller.signal.aborted;
    try {
      dirty = false;
      if (probePending) {
        probePending = false;
        input.off('data', routeInput);
        try {
          profile = await queryTerminal(input,output);
          if (profile.pendingInput) routeInput(Buffer.from(profile.pendingInput));
        } finally { input.on('data', routeInput); }
      }
      if (!current()) return;
      columns = Math.max(1, output.columns || 100); rows = Math.max(1, (output.rows || 35)-1);
      if (needsLayout) {
        needsLayout = false;
        const settings = `${columns}:${fontSize}:${sourceMode}:${profile.cellWidth}:${profile.cellHeight}:${profile.foreground}:${profile.supported}`;
        if (!layout || source !== lastSource || settings !== lastSettings) {
          const nextSource = source;
          const next = await layoutMarkdown(nextSource, { ...layoutOptions(columns), signal: controller.signal });
          if (!current()) return;
          layout = next; totalRows = next.totalRows ?? next.rows.reduce((n, group) => n + group.heightRows, 0);
          let start = 0;
          groups = next.rows.map(group => { const entry = { ...group, start, end: start + group.heightRows }; start = entry.end; return entry; });
          lastSource = nextSource; lastSettings = settings;
          previousLines = [];
        }
      }
      if (!current()) return;
      scroll = Math.max(0, Math.min(scroll, maxScroll()));
      const screen = Array.from({ length: rows }, () => '');
      const placements = [];
      let lo = 0, hi = groups.length;
      while (lo < hi) { const mid = (lo+hi) >>> 1; if (groups[mid].end <= scroll) lo = mid+1; else hi = mid; }
      for (let index = lo; index < groups.length && groups[index].start < scroll+rows; index++) {
        const group = groups[index];
        const textRow = group.start - scroll + (group.textRow ?? Math.floor((group.baselinePx ?? profile.cellHeight*.8) / profile.cellHeight));
        if (textRow >= 0 && textRow < rows) {
          screen[textRow] = group.textRuns.map(run => `${ESC}[${textRow+1};${run.column+1}H${styleEscape(run.style, layoutOptions(columns).foreground)}${safe(run.text)}`).join('');
        }
        for (const placed of group.formulas) placements.push({ formula: placed.formula, xPx: placed.column*profile.cellWidth, yPx: (group.start-scroll)*profile.cellHeight+placed.topPx });
      }
      let before = '';
      for (let row = 0; row < rows; row++) if (screen[row] !== previousLines[row]) before += `${ESC}[${row+1};1H${ESC}[0m${ESC}[2K${screen[row]}`;
      const percent = maxScroll() ? Math.round(scroll/maxScroll()*100) : 100;
      const footer = `${path.basename(file)} ${percent}% math ${Math.round(fontSize/initialFontSize*100)}% · ${sourceMode || !profile.supported ? 'source' : 'native'} · ${status} · +/- math s source r reload e edit q quit`;
      const after = `${ESC}[${rows+1};1H${ESC}[0m${ESC}[2K${ESC}[7m${fit(footer,columns)}${ESC}[0m`;
      await sender.present(placements, { before, after, cellWidth: profile.cellWidth, cellHeight: profile.cellHeight, viewportCols: columns, viewportRows: rows, refreshCrops: process.env.ZELLIJ !== undefined });
      if (current()) previousLines = screen;
    } catch (error) {
      if (!current() || error?.name === 'AbortError') return;
      status = error.message;
      output.write(`${ESC}[${rows+1};1H${ESC}[2K${fit(status,columns)}`);
    } finally {
      if (layoutController === controller) layoutController = undefined;
      busy = false;
      if (dirty || needsLayout) request();
    }
  }
  function quit() { quitting = true; layoutGeneration++; layoutController?.abort(); clearTimeout(timer); finish(); }
  let actions = Promise.resolve();
  function action(fn) {
    actions = actions.then(async () => {
      while (busy) await new Promise(resolve => setTimeout(resolve, 1));
      if (quitting) return;
      try { await fn(); } catch (error) { status = error.message; request(); }
    });
  }
  function keypress(str, key = {}) {
    if (!active) return;
    if (str === 'q' || key.ctrl && key.name === 'c') return quit();
    if (str === 'j' || key.name === 'down') scroll++;
    else if (str === 'k' || key.name === 'up') scroll--;
    else if (str === ' ' || str === 'f' || key.name === 'pagedown') scroll += Math.max(1, rows-2);
    else if (str === 'b' || key.name === 'pageup') scroll -= Math.max(1, rows-2);
    else if (str === 'g' || key.name === 'home') scroll = 0;
    else if (str === 'G' || key.name === 'end') scroll = maxScroll();
    else if (['+', '=', '-'].includes(str)) { fontSize = Math.max(10, Math.min(48, fontSize+(str === '-' ? -2 : 2))); return request(true); }
    else if (str === 's') {
      sourceMode = !sourceMode;
      output.write(sourceMode ? `${ESC}[?1000l${ESC}[?1006l` : `${ESC}[?1000h${ESC}[?1006h`);
      return request(true);
    } else if (str === 'r') return action(async () => {
      const next = await fs.readFile(file,'utf8');
      status = next === source ? 'unchanged' : 'reloaded'; source = next; request(true);
    });
    else if (str === 'e') return action(async () => {
      await leave();
      try { await edit(file); source = await fs.readFile(file,'utf8'); }
      finally { if (!quitting) { enter(); request(true); } }
      status = 'reloaded after editor';
    });
    else return;
    request();
  }
  const keys = new PassThrough(); emitKeypressEvents(keys);
  let tail = '', mouseTail = '';
  function routeInput(data) {
    if (!active) return;
    let text = tail+data.toString(); tail = '';
    const start = text.lastIndexOf(`${ESC}_G`);
    if (start >= 0 && !text.slice(start).includes(`${ESC}\\`)) { tail = text.slice(start); text = text.slice(0,start); }
    const partial = text.match(/\x1b_?$/)?.[0];
    if (partial) { tail = partial+tail; text = text.slice(0,-partial.length); }
    text = text.replace(/\x1b_G[^\x1b]*\x1b\\/g,'').replace(/\x1b\[(?:4|6);\d+;\d+t/g,'').replace(/\x1b\](?:10|11);[^\x07\x1b]*(?:\x07|\x1b\\)/g,'');
    const mouse = mouseTail+text;
    mouseTail = mouse.match(/\x1b(?:\[(?:<[\d;]*)?)?$/)?.[0] || '';
    for (const match of mouse.matchAll(/\x1b\[<(64|65);\d+;\d+M/g)) { scroll += match[1] === '64' ? -3 : 3; request(); }
    if (text) keys.write(text);
  }
  const resize = () => { previousLines = []; probePending = !values.text; request(true); };
  process.on('SIGINT',quit); process.on('SIGTERM',quit);
  try {
    input.setRawMode(true); input.resume();
    profile = values.text ? profile : await queryTerminal(input,output);
    input.setRawMode(false); input.pause();
    if (quitting) return;
    referenceCellHeight = profile.cellHeight;
    if (baseline !== undefined && baseline > profile.cellHeight) throw new Error('--text-baseline must not exceed terminal cell height.');
    sender = createTerminalGraphics(output);
    enter(); keys.on('keypress',keypress); input.on('data',routeInput); output.on('resize',resize);
    if (profile.pendingInput) routeInput(Buffer.from(profile.pendingInput));
    request(true); await done;
    await actions;
    while (busy) await new Promise(resolve => setTimeout(resolve,1));
  } finally {
    keys.off('keypress',keypress); input.off('data',routeInput); output.off('resize',resize);
    process.off('SIGINT',quit); process.off('SIGTERM',quit); keys.destroy();
    try { await leave(); } finally {
      try { await sender?.dispose(); } finally { renderer.close?.(); }
    }
  }
}
