# view-latex-md-math

**Real LaTeX formulas. Native terminal text. A JavaScript API.**

[![npm](https://img.shields.io/npm/v/view-latex-md-math)](https://www.npmjs.com/package/view-latex-md-math)
[![MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/william1010121/termlatex/blob/main/LICENSE)

Browser-free formula rendering and mixed Markdown layout for JavaScript terminal UIs. MathJax → standalone SVG → resvg PNG → Kitty graphics. No Chromium, TeX subprocess, or Rust toolchain installation; resvg uses a precompiled native addon.

Looking for the reader? Install [`view-latex-md`](https://www.npmjs.com/package/view-latex-md).

## Install

```sh
npm install view-latex-md-math
```

Node.js 22+, ESM. A supported resvg native binary must be available for your platform. Only image display requires a Kitty graphics terminal; SVG/PNG generation works independently and offline.

## Render a formula

```js
import { createFormulaRenderer } from 'view-latex-md-math';

const renderer = createFormulaRenderer({ maxBytes: 32 * 1024 * 1024 });
const formula = await renderer.render(String.raw`\frac{x^2}{y}`, {
  display: false,
  fontSize: 24,
  color: '#d8dee9',
});
// { key, svg, png, width, height, baseline }

const larger = await renderer.render(String.raw`\frac{x^2}{y}`, {
  fontSize: 32,
  color: '#d8dee9',
});
// Reuses the TeX SVG layout; only rasterization changes.
renderer.close();
```

All metrics are **pixels**. `baseline` is the distance from the image's top to the mathematical baseline. `png` is a Node Buffer containing transparent RGBA PNG; `svg` has local glyph definitions and can be used independently.

| Render option | Default | Meaning |
| --- | --- | --- |
| `display` | `false` | True inline math or display math style |
| `fontSize` | `18` | Formula em pixels; finite, > 0 and ≤ 512 |
| `color` | `'#d8dee9'` | Six- or eight-digit hexadecimal foreground |
| `signal` | none | Optional AbortSignal; skips queued work when aborted |

`createFormulaRenderer({ maxBytes, maxEntries })` defaults to 32 MiB and 256 entries **per cache layer**. Size-independent SVG and size/color-specific PNG caches share the byte budget. Duplicate concurrent requests with the same AbortSignal (or no signal) share work. Independent cancellation scopes do not share pending promises; completed cached pixels remain reusable. `stats()` reports `typesets`, `renders`, `hits`, `misses`, `entries`, `vectorEntries`, `bytes` and `inflight`. `clear()` empties both caches; `close()` also prevents further work.

Each expression has independent TeX state. Definitions inside an expression work; cross-expression macros do not. Stateful expressions bypass caches. Invalid TeX rejects without poisoning subsequent work. Inputs and raster dimensions have explicit size limits.

## Lay out native Markdown

```js
import { createFormulaRenderer, layoutMarkdown } from 'view-latex-md-math';

const renderer = createFormulaRenderer();
const document = await layoutMarkdown('中文 $x^2$ and **native text**.', {
  columns: 80,
  cellWidth: 10,
  cellHeight: 20,
  textBaselinePx: 16,
  fontSize: 24,
  mathScale: 1,
  foreground: '#d8dee9',
  renderer,
});
// { rows, totalRows, warnings }
```

`rows` contains logical line groups, each occupying `heightRows` physical terminal rows:

```js
{
  textRuns: [{ column, text, style }],
  formulas: [{ column, formula, topPx, tex, display, source }],
  heightRows,
  textRow,
  baselinePx,
}
```

`column` is a terminal-cell offset. `topPx` is relative to the group's top. Draw native text at `textRow`; reserve all `heightRows` before the next group. Inline formula ascent/descent expands the group to prevent overlap. Display math is centered in its own tightly fitted group.

The effective formula size is `fontSize × mathScale`; when changing it or the viewport dimensions, call `layoutMarkdown` again. Text baseline defaults to `cellHeight × 0.8`, because terminals report cell dimensions but not font ascent. Hosts can calibrate `textBaselinePx`.

`layoutMarkdown` also accepts an optional `signal: controller.signal`. Aborting rejects with the signal reason rather than returning a partial document or formula warning. Layout stops scheduling new blocks/formulas, checks late renderer results, and periodically yields even for cached formulas or prose. Hosts must discard obsolete generations before presenting a frame. Markdown parsing, individual text-block wrapping, and a running synchronous MathJax/resvg call are not preemptible.

Supported delimiters: `$...$`, `$$...$$`, `\(...\)`, `\[...\]`; code spans/fences are protected. Styles cover headings, lists, quotes, emphasis, links, code and basic tables. CJK/emoji/combining marks use grapheme-aware terminal widths. Oversized formulas shrink to fit; invalid formulas retain source and add `{tex, message}` to `warnings`. Text controls are sanitized before native rendering.

## Place images alongside your text

The host owns raw mode, input, terminal capability queries, scrolling and text-to-ANSI conversion. Wait for graphics support and cell-size replies before drawing. Send the host's text update through the same graphics transaction so multipart image uploads and text cannot interleave.

```js
import { createTerminalGraphics } from 'view-latex-md-math';

const graphics = createTerminalGraphics(process.stdout);
await graphics.present([
  { formula, xPx: 20, yPx: 16 - formula.baseline },
], {
  cellWidth: 10,
  cellHeight: 20,
  viewportCols: 80,
  viewportRows: 24,
  before: '\x1b[2J\x1b[1;1HNative text', // host-generated ANSI frame/diff
  after: '\x1b[24;1Hq: quit',
  refreshCrops: false,
});
await graphics.dispose();
```

`present()` returns a Promise and serializes frames with backpressure and synchronized updates. It uploads missing textures, updates the host's text and formula placements, then evicts unused LRU textures. The complete placements list is the current frame; omitted placements are removed. Coordinates are viewport-relative pixels; all edges clip. Repeated formulas use separate placement IDs and share a texture. Warm scrolling updates positions/crops without re-uploading.

`createTerminalGraphics(output, { maxBytes, startId, onError })` defaults to a 64 MiB texture budget and a randomized image-ID start. Use distinct ID ranges when multiple components share a terminal. `clear()` removes owned images; `dispose()` also removes the output error listener. The component does not clear other components' textures. `stats()` reports frames, uploads, bytes, placements, evictions and rasterized crops.

For **Zellij 0.45.1**, pass `refreshCrops: true`: visible crops become transparent whole-cell PNG variants, avoiding crop/forwarding behavior. New crops cost rasterization/upload once; revisits reuse them. Capability negotiation must finish first, especially in newly created sessions. tmux passthrough and iTerm2's separate image protocol are not implemented.

## Offline export

```js
import { exportDocumentPNG } from 'view-latex-md-math/export';

await exportDocumentPNG(document, 'preview.png', {
  columns: 80, cellWidth: 10, cellHeight: 20,
  foreground: '#d8dee9', scale: 2,
});
```

Math is rerasterized from vectors. Native prose is represented with system SVG fonts in this offline artifact; it is not a terminal screenshot.

Subpath exports: `/formula`, `/layout` (also exports `textWidth`), `/terminal`, `/export`.

## Performance and limits

Size-independent SVG caching reduced one measured 20-size formula zoom sweep from 224.927 ms to 57.911 ms (median of 10 rounds). This measures formula CPU work, not full-reader FPS. [Methodology, tests and remaining costs](https://github.com/william1010121/termlatex/blob/main/NATIVE_PERFORMANCE.md).

First typesetting/rasterization runs on the JS thread, yielding every 16 new formula renders; background workers and lazy full-document layout are not implemented. Loaded documents retain formula references beyond the LRU budget. Character-grid spacing and row scrolling remain terminal constraints. Markdown images become text labels; complex multiline tables and clickable links are not implemented.

This package is a host integration API. It cannot add math rendering to arbitrary existing TUI applications without their cooperation.

## License

MIT. MathJax, resvg, markdown-it and string-width keep their own licenses.
