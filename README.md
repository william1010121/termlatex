# TermLatex

**Markdown stays text. Math gets real typesetting.**

[![npm](https://img.shields.io/npm/v/termlatex)](https://www.npmjs.com/package/termlatex)
[![CI](https://github.com/william1010121/view-latex-md/actions/workflows/ci.yml/badge.svg)](https://github.com/william1010121/view-latex-md/actions/workflows/ci.yml)
[![MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%E2%89%A522-339933.svg)](https://nodejs.org/)

A terminal Markdown reader that keeps prose, headings and code as **native terminal text**, and renders only LaTeX formulas as transparent images. MathJax provides the glyphs, spacing and baseline; Kitty graphics places the formulas between your text.

No Chromium download. No TeX installation. No Rust toolchain.

[繁體中文](README.zh-TW.md) · [Reusable JS package](packages/terminal-math/README.md) · [Performance notes](NATIVE_PERFORMANCE.md)

![Gaussian integral rendered by the formula engine](assets/gaussian.svg)

*Actual formula-engine SVG output; this illustration is not a terminal screenshot.*

## Try it

```sh
npx termlatex notes.md
```

Or install the command:

```sh
npm install -g termlatex
termlatex notes.md
```

Requires **Node.js 22+** and a terminal supporting the **Kitty graphics protocol**. The CLI probes graphics support and cell pixel dimensions; unsupported terminals show the original LaTeX. The renderer uses a prebuilt resvg native addon; supported binaries must be available for your OS/architecture.

```md
# A small example

A native-text sentence with $x^2 + y^2 = z^2$ inside it.

$$
\int_{-\infty}^{\infty} e^{-x^2}\,dx = \sqrt{\pi}
$$

Code stays literal: `$this_is_not_math$`.
```

## What you get

- **Actual math layout:** local MathJax SVG with standalone glyph definitions, rendered into transparent PNGs.
- **Inline alignment:** formulas share a text baseline; tall fractions and integrals reserve enough rows to avoid overlap.
- **Native prose:** CJK, emoji and combining marks wrap by terminal cell width. Headings, lists, quotes, emphasis, links, code and basic tables retain text styles.
- **Fast revisits:** cached formulas share textures; warm direct-terminal scrolling changes placements/crops without uploading them again.
- **Formula zoom:** size-independent TeX layout cache avoids typesetting again when size or color changes.
- **Edit and reload:** open your editor, return to the reader, or reload a changed file.
- **Reusable engine:** embed the same renderer and layout component in a JavaScript TUI with `view-latex-md-math`.

## Controls

| Key | Action |
| --- | --- |
| ↑ / ↓, `k` / `j`, mouse wheel | Scroll by terminal rows |
| Space, PgDn / PgUp, `f` / `b` | Page down / up |
| `g` / `G` | Go to start / end |
| `+` or `=` / `-` | Enlarge / shrink formulas |
| `s` | Toggle rendered math / source |
| `e` | Edit with `$VISUAL`, `$EDITOR`, or `vi`, then reload |
| `r` | Reload from disk; unchanged content keeps the existing layout |
| `q`, Ctrl-C | Exit and restore the terminal |

Prose uses your terminal's font and zoom controls. Formula images follow terminal cell-size changes after resize. Use your terminal's selection modifier to select native text while mouse capture is enabled; source mode also releases mouse capture.

```sh
termlatex notes.md --font-size 22
termlatex notes.md --math-scale 1.2
termlatex notes.md --text-baseline 16
termlatex notes.md --text
termlatex notes.md --light
```

`--font-size` sets the initial formula em size in pixels (10–48); `--math-scale` multiplies it (0.5–3). Terminals expose cell dimensions, but not exact font ascent: the default text baseline is estimated at 80% of cell height, and `--text-baseline PX` lets you calibrate it.

## Terminal support

| Environment | Status |
| --- | --- |
| Kitty graphics terminal | Supported protocol path, with capability probing |
| Zellij 0.45.1 + a supporting host terminal | Verified in an isolated real Zellij session; padded image crops work around forwarding/crop behavior |
| cmux / Ghostty | Depends on the host's Kitty graphics and pixel-offset support; the CLI probes capability |
| iTerm2 | Its separate inline-image protocol is not implemented; source fallback is available |
| tmux | Image passthrough is not implemented |
| Terminals without Kitty graphics | Native Markdown text and LaTeX source |

Zellij creates and uploads a padded image the first time it encounters a new crop; revisiting a cached crop avoids that work. Scroll remains row-based, and native character-grid spacing cannot exactly match browser inline layout.

## Embed math in your own TUI

```sh
npm install view-latex-md-math
```

```js
import { createFormulaRenderer, layoutMarkdown } from 'view-latex-md-math';

const renderer = createFormulaRenderer();
const formula = await renderer.render(String.raw`\frac{a}{b}`, {
  fontSize: 24,
  color: '#d8dee9',
});
// formula: { key, svg, png, width, height, baseline }

const document = await layoutMarkdown('Native text and $x^2$.', {
  columns: 80, cellWidth: 10, cellHeight: 20,
  fontSize: 24, renderer,
});
// document.rows contains native text runs and formula placements.
renderer.close();
```

The host owns input, raw mode and native text drawing; `createTerminalGraphics` serializes Kitty image updates alongside the host's ANSI text. See the [complete package API and host integration example](packages/terminal-math/README.md).

This is an embeddable component: an existing TUI must integrate it to display math. Installing the package does not automatically add rendering to arbitrary applications.

## PNG export

```sh
termlatex notes.md --render preview.png --width 900
termlatex notes.md --render preview-2x.png --raster-scale 2
```

Exports use vector math and system SVG fonts, without a browser. The output is an offline layout preview; terminal font rendering may differ. `--raster-scale` accepts 1 or 2 and applies only to export.

## Performance and validation

A local Gaussian-formula zoom sweep (20 sizes, median of 10 rounds) took **224.927 ms when re-typesetting each size versus 57.911 ms when reusing the SVG layout**: about **3.9× faster formula work**. This is not a full-reader speed or terminal FPS claim. The warm viewport benchmark uploads no additional textures.

[Benchmark methodology and remaining costs](NATIVE_PERFORMANCE.md) include startup/module load, full-document layout, memory retention, terminal output and Zellij crop costs.

```sh
npm ci
npm test
python3 native-terminal.test.py
python3 native-zellij.test.py  # requires Zellij 0.45.1
npm run bench:native
node cli.js native-demo.md
```

Tests cover transparent math pixels, exact baselines, size/color cache reuse, macro isolation, Unicode wrapping, clipping, repeated placements, backpressure, and CLI zoom/reload/resize/exit. The PTY checks reject browser/Rust/TeX rendering subprocesses. Real Zellij verification checks forwarded RGBA pixels.

## Scope

Dollar and bracket math delimiters are supported: `$...$`, `$$...$$`, `\(...\)`, `\[...\]`. Code spans and fences keep their contents literal. Invalid math stays visible as source.

Markdown images currently become text labels; links have styling without click handling. Tables are basic text layouts. Syntax highlighting, complex multiline table alignment and cross-formula macro definitions are not implemented. Each formula has independent TeX state. This is not a full LaTeX document engine.

Initial math work runs on the JS thread, yielding between small batches; it does not yet use background workers. Renderer and graphics caches are bounded, but a loaded document retains formula references.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, meaningful checks and release steps. Bug reports should include terminal/version, multiplexer/version, Node version, a minimal Markdown sample, and whether source mode works.

Earlier Chromium and Ratatui experiments remain local development history; the published npm packages use the native-text JavaScript pipeline.

## License and acknowledgements

MIT. Built with [MathJax](https://github.com/mathjax/MathJax-src), [resvg](https://github.com/linebender/resvg), [markdown-it](https://github.com/markdown-it/markdown-it), [string-width](https://github.com/sindresorhus/string-width), and the [Kitty graphics protocol](https://sw.kovidgoyal.net/kitty/graphics-protocol/). Their licenses remain their own.
