#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { emitKeypressEvents } from 'node:readline';
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { createGraphics, graphicsCommand as graphics } from './graphics.js';

const ESC = '\x1b';
const out = process.stdout;
const input = process.stdin;
const write = text => out.write(text);
let sender;
const clearImage = () => sender?.clear();
const cleanText = value => value.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
let active = false;

function enter() {
  input.setRawMode(true);
  input.resume();
  write(`${ESC}[?1049h${ESC}[?25l${ESC}[?1000h${ESC}[?1006h`);
  active = true;
}
async function leave() {
  if (active) {
    await clearImage();
    write(`${ESC}[?1006l${ESC}[?1000l${ESC}[?25h${ESC}[?1049l`);
    active = false;
  }
  if (input.isTTY) input.setRawMode(false);
  input.pause();
}

async function queryTerminal() {
  let response = '';
  let complete;
  const received = new Promise(resolve => { complete = resolve; });
  const listener = data => {
    response += data.toString();
    if (/\x1b_Gi=31;[^\x1b]*\x1b\\/.test(response) &&
        /\x1b\[(?:6|4);\d+;\d+t/.test(response) &&
        /10;rgb:[a-f\d]+\/[a-f\d]+\/[a-f\d]+(?:\x07|\x1b\\)/i.test(response)) complete();
  };
  input.on('data', listener);
  write(`${ESC}[16t${ESC}[14t${ESC}]10;?${ESC}\\`);
  write(graphics('a=q,t=d,f=24,s=1,v=1,i=31', 'AAAA'));
  const timer = setTimeout(complete, 350);
  await received;
  clearTimeout(timer);
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
      'raster-scale': { type: 'string' },
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
Native terminal pixels by default; --raster-scale 2 enables supersampling.
Rendering is offline. Raw HTML and remote images are disabled.`);
    return;
  }
  if (positionals.length !== 1) throw new Error('Expected one Markdown file.');
  const file = path.resolve(positionals[0]);
  await fs.access(file);
  let fontSize = Number(values['font-size']);
  const initialFontSize = fontSize;
  const mathScale = Number(values['math-scale']);
  const rasterScale = Number(values['raster-scale'] || (values.render ? '2' : '1'));
  const exportWidth = Number(values.width);
  if (!Number.isFinite(fontSize) || fontSize < 10 || fontSize > 48) throw new Error('--font-size must be between 10 and 48.');
  if (!Number.isFinite(mathScale) || mathScale < .5 || mathScale > 3) throw new Error('--math-scale must be between 0.5 and 3.');
  if (![1, 2].includes(rasterScale)) throw new Error('--raster-scale must be 1 or 2.');
  if (!Number.isInteger(exportWidth) || exportWidth < 200 || exportWidth > 8000) throw new Error('--width must be an integer between 200 and 8000.');
  let terminal;
  if (!values.render && (!input.isTTY || !out.isTTY)) throw new Error('Run in an interactive terminal, or use --render output.png.');
  // Start the local browser while terminal capability replies are in flight.
  // Help/argument errors never need to load MathJax or Chromium.
  const rendererPromise = import('./render.js').then(module => module.createRenderer());
  rendererPromise.catch(() => {});
  if (!values.render) {
    input.setRawMode(true);
    input.resume();
    try { terminal = await queryTerminal(); } finally { input.setRawMode(false); input.pause(); }
    if (!terminal.supported) {
      await rendererPromise.then(renderer => renderer.close(), () => {});
      throw new Error('Terminal did not acknowledge Kitty graphics. Try cmux, Ghostty, or Kitty (directly, without tmux).');
    }
  }
  const renderer = await rendererPromise;
  try {
    if (values.render) {
      await renderer.load(file, { width: exportWidth, height: 800, fontSize, mathScale, scale: rasterScale, foreground: values.light ? '#24292f' : '#d8dee9' });
      await renderer.exportPNG(path.resolve(values.render));
      console.log(`Rendered ${values.render}`);
      return;
    }
    let y = 0, targetY = 0, maxScroll = 0, height = 0, rows = 0, columns = 0;
    let scrolling = false;
    let pendingImmediate = false, scrollRevision = 0;
    let prefetch = null, lastFrameY = 0, direction = 1, generation = 0;
    let requestedFontSize = fontSize, loadPending = false, loadMessage = '';
    let errorMessage = '', status = '', quitting = false, graphicsFailures = 0;
    let queue = Promise.resolve();
    const footerText = () => {
      const percent = maxScroll ? Math.round(y / maxScroll * 100) : 100;
      const zoom = Math.round(fontSize / initialFontSize * 100);
      const text = errorMessage || `${path.basename(file)}  ${percent}%  zoom ${zoom}% (${fontSize}px)${status ? '  ' + status : ''}  ↑↓/jk scroll · Space page · +/- zoom · e edit · r reload · q quit`;
      return `${ESC}[${rows + 1};1H${ESC}[2K${ESC}[?7l${ESC}[7m${cleanText(text).slice(0, columns)}${ESC}[0m${ESC}[?7h`;
    };
    const footer = () => write(footerText());
    sender = createGraphics(out, { input, onError: error => {
      errorMessage = error.message;
      // Recover a terminal-evicted texture on the next serialized draw.
      if (active && !quitting && ++graphicsFailures <= 1) schedule(() => draw());
      else footer();
    } });
    async function draw() {
      y = Math.max(0, Math.min(y, maxScroll));
      const frameY = y;
      const tile = await renderer.tile(frameY);
      const id = await sender.ensure(tile);
      if (id === null) return;
      const scale = tile.scale || 2;
      const placed = await sender.present(id, {
        y: Math.round((frameY - tile.start) * scale), width: tile.width,
        height: height * scale, columns, rows, after: footerText(),
      });
      if (!placed) return draw();
      if (frameY !== lastFrameY) direction = Math.sign(frameY - lastFrameY);
      lastFrameY = frameY;
      const next = tile.start + direction * tile.stride;
      if (!prefetch && !quitting && next >= 0 && next <= maxScroll) {
        const version = generation;
        prefetch = renderer.tile(next).then(ahead => {
          if (version === generation && active && !quitting) return sender.ensure(ahead, { prefetch: true });
        }).catch(() => {}).finally(() => { prefetch = null; });
      }
    }
    async function load(message = '') {
      if (columns !== out.columns || rows !== out.rows - 1) {
        await clearImage();
        write(`${ESC}[2J${ESC}[H`);
      }
      columns = Math.max(1, out.columns || 100);
      rows = Math.max(1, (out.rows || 35) - 1);
      height = Math.max(1, Math.floor(rows * terminal.cellHeight));
      status = 'rendering…';
      graphicsFailures = 0;
      footer();
      const loaded = await renderer.load(file, {
        width: Math.max(1, Math.floor(columns * terminal.cellWidth)), height, fontSize, mathScale, scale: rasterScale,
        foreground: values.light ? '#24292f' : terminal.foreground,
      });
      maxScroll = loaded.maxScroll;
      status = message;
      if (loaded.changed !== false) await clearImage();
      y = targetY = Math.max(0, Math.min(y, maxScroll));
      lastFrameY = y;
      await draw();
    }
    let finish;
    const done = new Promise(resolve => { finish = resolve; });
    function schedule(action, interruptScroll = false) {
      if (interruptScroll) {
        ++scrollRevision;
        targetY = y;
        pendingImmediate = false;
      }
      queue = queue.then(async () => {
        if (quitting) return;
        try { errorMessage = ''; await action(); }
        catch (error) { errorMessage = error.message; footer(); }
      });
    }
    function quit() { quitting = true; finish(); }
    function requestLoad(message = '') {
      ++generation;
      loadMessage = message;
      if (loadPending) return;
      loadPending = true;
      schedule(async () => {
        loadPending = false;
        fontSize = requestedFontSize;
        await load(loadMessage);
        if (columns !== out.columns || rows !== out.rows - 1) requestLoad();
      }, true);
    }
    function scrollTo(next, immediate = false) {
      targetY = Math.max(0, Math.min(next, maxScroll));
      if (immediate) pendingImmediate = true;
      if (scrolling) return;
      scrolling = true;
      const revision = scrollRevision;
      schedule(async () => {
        try {
          let previous = performance.now() - 16;
          do {
            if (quitting || !active || revision !== scrollRevision) return;
            const started = performance.now();
            const remaining = targetY - y;
            const blend = 1 - Math.exp(-Math.max(1, started - previous) / 24);
            previous = started;
            y = pendingImmediate || Math.abs(remaining) < 1 ? targetY : y + remaining * blend;
            pendingImmediate = false;
            await draw();
            if (y !== targetY) await new Promise(resolve => setTimeout(resolve, Math.max(0, 16 - (performance.now() - started))));
          } while (y !== targetY);
        } finally {
          scrolling = false;
          if (!quitting && targetY !== y) scrollTo(targetY);
        }
      });
    }
    async function keypress(str, key = {}) {
      if (!active) return;
      if (str === 'q' || (key.ctrl && key.name === 'c')) return quit();
      const step = fontSize * 1.65;
      if (key.name === 'down' || str === 'j') return scrollTo(targetY + step);
      if (key.name === 'up' || str === 'k') return scrollTo(targetY - step);
      if (key.name === 'pagedown' || str === ' ' || str === 'f') return scrollTo(targetY + height * .9);
      if (key.name === 'pageup' || str === 'b') return scrollTo(targetY - height * .9);
      if (str === 'g' || key.name === 'home') return scrollTo(0, true);
      if (str === 'G' || key.name === 'end') return scrollTo(maxScroll, true);
      if (!['+', '=', '-', 'r', 'e'].includes(str)) return;
      if (str === '+' || str === '=' || str === '-') {
        requestedFontSize = Math.max(10, Math.min(48, requestedFontSize + (str === '-' ? -2 : 2)));
        return requestLoad();
      }
      if (str === 'r') return requestLoad(`reloaded ${new Date().toLocaleTimeString('en-GB')}`);
      ++generation;
      schedule(async () => {
        if (str === 'e') {
          await leave();
          try { await edit(file); } finally { if (!quitting) enter(); }
          return load('reloaded after editor');
        }
      }, true);
    }
    let mouseTail = '';
    function mouse(data) {
      if (!active) return;
      const sequence = mouseTail + data.toString();
      mouseTail = sequence.match(/\x1b(?:\[(?:<[\d;]*)?)?$/)?.[0] || '';
      for (const match of sequence.matchAll(/\x1b\[<(64|65);\d+;\d+M/g)) {
        scrollTo(targetY + (match[1] === '64' ? -1 : 1) * fontSize * 1.65);
      }
    }
    // The pixel size per cell remains fixed when only the pane dimensions change.
    const resize = () => requestLoad();
    // Replies are protocol traffic, not shortcut keys. Retain split APCs until
    // their terminator arrives, then let the graphics sender consume them.
    const keys = new PassThrough();
    let replyTail = '';
    function routeInput(data) {
      if (!active) return;
      let text = replyTail + data.toString();
      replyTail = '';
      const start = text.lastIndexOf(`${ESC}_G`);
      if (start >= 0 && !text.slice(start).includes(`${ESC}\\`)) {
        replyTail = text.slice(start);
        text = text.slice(0, start);
      }
      const partial = text.match(/\x1b_?$/)?.[0];
      if (partial) { replyTail = partial + replyTail; text = text.slice(0, -partial.length); }
      text = text.replace(/\x1b_G[^\x1b]*\x1b\\/g, '');
      if (text) { mouse(Buffer.from(text)); keys.write(text); }
    }
    emitKeypressEvents(keys);
    enter();
    process.on('SIGTERM', quit);
    process.on('SIGINT', quit);
    try {
      keys.on('keypress', keypress);
      input.on('data', routeInput);
      out.on('resize', resize);
      sender.probeFile().catch(() => {});
      schedule(() => load());
      await done;
      await queue;
    } finally {
      keys.off('keypress', keypress);
      input.off('data', routeInput);
      keys.destroy();
      out.off('resize', resize);
      process.off('SIGTERM', quit);
      process.off('SIGINT', quit);
      await leave();
      await sender.dispose();
      input.pause();
    }
  } finally { await renderer.close(); }
}

main().catch(async error => {
  await leave();
  input.pause();
  console.error(`view-latex-md: ${error.message}`);
  process.exitCode = 1;
});
