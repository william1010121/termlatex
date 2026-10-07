#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { emitKeypressEvents } from 'node:readline';
import { spawn } from 'node:child_process';
import { createRenderer } from './render.js';

const ESC = '\x1b';
const out = process.stdout;
const input = process.stdin;
const imageId = Math.floor(Math.random() * 0x7ffffffe) + 1;
const write = text => out.write(text);
const graphics = (control, data = '') => `${ESC}_G${control};${data}${ESC}\\`;
const clearImage = () => write(graphics(`a=d,d=I,i=${imageId},q=2`));
const cleanText = value => value.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
let active = false;

function enter() {
  input.setRawMode(true);
  input.resume();
  write(`${ESC}[?1049h${ESC}[?25l${ESC}[?1000h${ESC}[?1006h`);
  active = true;
}
function leave() {
  if (active) {
    clearImage();
    write(`${ESC}[?1006l${ESC}[?1000l${ESC}[?25h${ESC}[?1049l`);
    active = false;
  }
  if (input.isTTY) input.setRawMode(false);
  input.pause();
}

async function queryTerminal() {
  let response = '';
  const listener = data => { response += data.toString(); };
  input.on('data', listener);
  write(`${ESC}[16t${ESC}[14t${ESC}]10;?${ESC}\\`);
  write(graphics('a=q,t=d,f=24,s=1,v=1,i=31', 'AAAA'));
  await new Promise(resolve => setTimeout(resolve, 350));
  input.off('data', listener);
  const cell = response.match(/\x1b\[6;(\d+);(\d+)t/);
  const window = response.match(/\x1b\[4;(\d+);(\d+)t/);
  const rgb = response.match(/10;rgb:([a-f\d]+)\/([a-f\d]+)\/([a-f\d]+)/i);
  const columns = out.columns || 100, rows = out.rows || 35;
  return {
    supported: /\x1b_Gi=31;OK/.test(response),
    cellWidth: cell ? Number(cell[2]) : window ? Number(window[2]) / columns : 9,
    cellHeight: cell ? Number(cell[1]) : window ? Number(window[1]) / rows : 18,
    foreground: rgb ? '#' + rgb.slice(1).map(v => Math.round(parseInt(v, 16) * 255 / (16 ** v.length - 1)).toString(16).padStart(2, '0')).join('') : '#d8dee9',
  };
}

async function transmit(png, columns, rows) {
  clearImage();
  write(`${ESC}[H`);
  const data = png.toString('base64');
  for (let offset = 0; offset < data.length; offset += 4096) {
    const more = offset + 4096 < data.length ? 1 : 0;
    const header = offset === 0 ? `a=T,t=d,f=100,i=${imageId},p=1,c=${columns},r=${rows},C=1,q=2,m=${more}` : `m=${more}`;
    if (!write(graphics(header, data.slice(offset, offset + 4096)))) {
      await new Promise(resolve => out.once('drain', resolve));
    }
  }
}

async function edit(file) {
  // Honor the user's configured editor, including flags; the filename is a positional argument.
  const command = process.env.VISUAL || process.env.EDITOR || 'vi';
  await new Promise((resolve, reject) => {
    const child = spawn(process.env.SHELL || '/bin/sh', ['-c', `${command} "$1"`, 'view-latex-md', file], { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`Editor exited with ${signal || code}`)));
  });
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      light: { type: 'boolean' },
      render: { type: 'string' },
      width: { type: 'string', default: '1000' },
      'font-size': { type: 'string', default: '18' },
      'math-scale': { type: 'string', default: '1' },
    },
  });
  if (values.help || positionals.length === 0) {
    console.log(`Usage: view-latex-md file.md [--light] [--font-size 18] [--math-scale 1]
       view-latex-md file.md --render output.png [--width 1000]

Markdown + $inline math$, $$display math$$, \\(math\\), \\[math\\].
Keys: ↑/↓ j/k scroll · PgUp/PgDn Space page · g/G top/bottom
      +/- zoom · e edit ($VISUAL/$EDITOR, default vi) · r reload · q quit
Requires Kitty graphics support (cmux, Ghostty, Kitty).
MathJax SVG equations; --math-scale adjusts only formula size (0.5–3).
Rendering is offline. Raw HTML and remote images are disabled.`);
    return;
  }
  if (positionals.length !== 1) throw new Error('Expected one Markdown file.');
  const file = path.resolve(positionals[0]);
  await fs.access(file);
  let fontSize = Number(values['font-size']);
  const initialFontSize = fontSize;
  const mathScale = Number(values['math-scale']);
  const exportWidth = Number(values.width);
  if (!Number.isFinite(fontSize) || fontSize < 10 || fontSize > 48) throw new Error('--font-size must be between 10 and 48.');
  if (!Number.isFinite(mathScale) || mathScale < .5 || mathScale > 3) throw new Error('--math-scale must be between 0.5 and 3.');
  if (!Number.isInteger(exportWidth) || exportWidth < 200 || exportWidth > 8000) throw new Error('--width must be an integer between 200 and 8000.');
  let terminal;
  if (!values.render) {
    if (!input.isTTY || !out.isTTY) throw new Error('Run in an interactive terminal, or use --render output.png.');
    input.setRawMode(true);
    input.resume();
    try { terminal = await queryTerminal(); } finally { input.setRawMode(false); input.pause(); }
    if (!terminal.supported) throw new Error('Terminal did not acknowledge Kitty graphics. Try cmux, Ghostty, or Kitty (directly, without tmux).');
  }
  const renderer = await createRenderer();
  try {
    if (values.render) {
      await renderer.load(file, { width: exportWidth, height: 800, fontSize, mathScale, foreground: values.light ? '#24292f' : '#d8dee9' });
      await renderer.exportPNG(path.resolve(values.render));
      console.log(`Rendered ${values.render}`);
      return;
    }
    let y = 0, maxScroll = 0, height = 0, rows = 0, columns = 0;
    let errorMessage = '', status = '', quitting = false, busy = false;
    let queue = Promise.resolve();
    const footer = () => {
      const percent = maxScroll ? Math.round(y / maxScroll * 100) : 100;
      const zoom = Math.round(fontSize / initialFontSize * 100);
      const text = errorMessage || `${path.basename(file)}  ${percent}%  zoom ${zoom}% (${fontSize}px)${status ? '  ' + status : ''}  ↑↓/jk scroll · Space page · +/- zoom · e edit · r reload · q quit`;
      write(`${ESC}[${rows + 1};1H${ESC}[2K${ESC}[?7l${ESC}[7m${cleanText(text).slice(0, columns)}${ESC}[0m${ESC}[?7h`);
    };
    async function draw() {
      y = Math.max(0, Math.min(y, maxScroll));
      await transmit(await renderer.frame(y), columns, rows);
      footer();
    }
    async function load(message = '') {
      if (columns !== out.columns || rows !== out.rows - 1) {
        clearImage();
        write(`${ESC}[2J${ESC}[H`);
      }
      columns = Math.max(1, out.columns || 100);
      rows = Math.max(1, (out.rows || 35) - 1);
      height = Math.max(1, Math.floor(rows * terminal.cellHeight));
      status = 'rendering…';
      footer();
      ({ maxScroll } = await renderer.load(file, {
        width: Math.max(1, Math.floor(columns * terminal.cellWidth)), height, fontSize, mathScale,
        foreground: values.light ? '#24292f' : terminal.foreground,
      }));
      status = message;
      await draw();
    }
    let finish;
    const done = new Promise(resolve => { finish = resolve; });
    function schedule(action) {
      queue = queue.then(async () => {
        if (quitting) return;
        busy = true;
        try { errorMessage = ''; await action(); }
        catch (error) { errorMessage = error.message; footer(); }
        finally { busy = false; }
      });
    }
    function quit() { quitting = true; finish(); }
    async function keypress(str, key = {}) {
      if (!active) return;
      if (str === 'q' || (key.ctrl && key.name === 'c')) return quit();
      // Keep zoom/reload commands even while a frame is rendering.
      if (busy && !['+', '=', '-', 'r', 'e'].includes(str)) return;
      schedule(async () => {
        const step = fontSize * 1.65 * 3;
        if (key.name === 'down' || str === 'j') y += step;
        else if (key.name === 'up' || str === 'k') y -= step;
        else if (key.name === 'pagedown' || str === ' ' || str === 'f') y += height * .9;
        else if (key.name === 'pageup' || str === 'b') y -= height * .9;
        else if (str === 'g' || key.name === 'home') y = 0;
        else if (str === 'G' || key.name === 'end') y = maxScroll;
        else if (str === '+' || str === '=' || str === '-') {
          fontSize = Math.max(10, Math.min(48, fontSize + (str === '-' ? -2 : 2)));
          return load();
        } else if (str === 'r') return load(`reloaded ${new Date().toLocaleTimeString('en-GB')}`);
        else if (str === 'e') {
          leave();
          try { await edit(file); } finally { if (!quitting) enter(); }
          return load('reloaded after editor');
        } else return;
        await draw();
      });
    }
    function mouse(data) {
      if (!active || busy) return;
      for (const match of data.toString().matchAll(/\x1b\[<(64|65);\d+;\d+M/g)) {
        schedule(async () => { y += (match[1] === '64' ? -1 : 1) * fontSize * 3; await draw(); });
      }
    }
    // The pixel size per cell remains fixed when only the pane dimensions change.
    const resize = () => schedule(() => load());
    emitKeypressEvents(input);
    enter();
    process.on('SIGTERM', quit);
    process.on('SIGINT', quit);
    try {
      input.on('keypress', keypress);
      input.on('data', mouse);
      out.on('resize', resize);
      schedule(() => load());
      await done;
      await queue;
    } finally {
      input.off('keypress', keypress);
      input.off('data', mouse);
      out.off('resize', resize);
      process.off('SIGTERM', quit);
      process.off('SIGINT', quit);
      leave();
      input.pause();
    }
  } finally { await renderer.close(); }
}

main().catch(error => {
  leave();
  input.pause();
  console.error(`view-latex-md: ${error.message}`);
  process.exitCode = 1;
});
