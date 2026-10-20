# Browser-free native text pipeline

2026-10-08 local verification, Apple M4 / Node 24. The benchmark is
`node native-benchmark.js`; these are application-side timings, not terminal FPS.

| Measurement | First recorded run |
| --- | ---: |
| Import MathJax/fonts/layout/graphics modules | 489.020 ms |
| First Gaussian formula, typeset + PNG | 32.648 ms |
| 1000 identical formula cache hits | 4.715 ms |
| 1000 paragraph/display pairs, 4999 terminal rows | 127.882 ms |
| 2000 warmed viewport frames, 80×24 | 0.0395 ms/frame average |
| Additional texture uploads during those frames | 0 |

Frames use an in-memory Writable and real Kitty commands; timings include viewport
lookup, geometry and serialized command generation, but exclude stdout kernel
throughput, terminal compositor and display refresh. Prose-diff generation is not
included in the frame figure. Do not compare this directly to Ratatex's TeX engine
or claim a GPU/frame-rate multiplier. Initial render timings vary with module load
and concurrent system activity; cold figures are one run, not a statistical estimate.

## What changed

- The CLI imports the workspace npm component, not a browser renderer.
- Only formulas are rasterized; headings/prose/code remain terminal text.
- SVG has standalone local glyph definitions and exact math ascent/depth.
- TeX SVG layout is cached independently of font size/color; zoom only rasterizes
  the prepared vector. Vector and PNG caches share the configured byte budget.
- Cached formulas share one uploaded texture across independent placements.
- Direct Kitty warm scroll updates pixel crop/position without rendering/upload.
- Visible document groups use a binary-search index; unchanged reload retains layout.
- Tall inline groups reserve enough native rows; display groups use tight image height.
- Terminal resize re-queries cell pixel dimensions; formulas scale relative to the
  initial cell height and all text reflows for the current columns.

## Verification

The zoom microbenchmark sweeps a Gaussian formula over 20 sizes (10–48 px),
warming each renderer first and taking the median of 10 rounds. It compares
re-typesetting each size with reusing the vector; both paths rasterize each size.
One local run measured 224.927 ms versus 57.911 ms (3.88×). This is formula CPU
work under concurrent local verification, not a full-reader or scrolling speedup.
`node native-benchmark.js` reproduces the comparison. Separate before/after
checks found byte-identical PNGs, dimensions and baselines for 24 combinations
of four expressions, inline/display mode and three font sizes.

Node tests cover math pixels, baseline, full inline operators, cache and macro
isolation, CJK/emoji wrapping, code protection, styles, controls, viewport clipping,
multiple placements, backpressure and exact Zellij padded pixels.
`native-terminal.test.py` runs the real CLI and rejects Chrome/Rust/TeX rendering
subprocesses while exercising wheel bursts, partial protocol packets, zoom,
source mode, disk reload, editor return, resize, exit and 1×/2× PNG exports.
`native-zellij.test.py` starts an isolated real Zellij 0.45.1 session and checks
forwarded host RGBA across forward/reverse and simultaneous top/left crops.

## Remaining limits

Cold MathJax/resvg work happens on the JS main thread, yielding every 16 new
formulas. Interactive layout now carries an AbortSignal: quit, resize, zoom and
source-mode changes stop obsolete work at cooperative checkpoints; only the
current generation can submit a new frame. Cached/prose layout also yields
every 32 block/atom checkpoints. A synchronous formula conversion/rasterization,
Markdown parse, individual text-block wrap or already-submitted graphics frame
cannot be interrupted mid-operation. Initial layout visits the full document; it is not yet a lazy/streaming
background-worker layout. Formula LRU and terminal textures are bounded, but a
loaded document retains references to its formulas, so total document memory is
not bounded solely by the renderer cache. Text baseline is a configurable estimate
because the terminal does not expose exact font ascent. Character-grid gaps and
whole-row scrolling remain inherent to native terminal prose.

Zellij's new crop variants require a raster/upload once; revisits reuse them.
Zellij still forwards decoded RGBA, so slow remote links or many newly seen crops
have additional cost. Multiple image placements may also be composited differently
by terminal implementations; these CPU measurements do not establish GUI smoothness.


## Cooperative cancellation verification (2026-10-20)

On Linux / Node 24, a deterministic fake renderer delayed each of 100 formulas
by 5 ms and aborted after the third call. Main at `813e0fd` still called the
renderer 100 times and resolved (~524 ms); the signal-aware layout called it
three times and rejected with `AbortError` (~35 ms). Counts, not wall-clock
thresholds, are the regression assertion. These timings are synthetic workload
measurements, not terminal FPS or a guarantee for individual TeX expressions.

`npm test` covers queued renderer cancellation, independent cancellation scopes,
table `Promise.all` siblings, shrink-pass cancellation, cache byte accounting,
late signal-ignorant renderer results, recovery and cached/prose yields.
`python3 native-cancellation.test.py` wraps the real CLI in a PTY with a
deterministic 15 ms signal-ignorant renderer. It exercises repeated superseding
zoom requests plus resize, an entirely signal-ignorant obsolete layout (which
must not present), and quit/SIGINT/SIGTERM mid-layout. Interactive exit paths check raw
mode, cursor, wrapping, mouse and alternate-screen restoration. SIGINT/SIGTERM
during the initial capability probe also restore raw mode; that probe can take
up to its existing 350 ms timeout to finish. The existing
`native-terminal.test.py` still checks real pixels, baseline-dependent clipping,
cache reuse, source, reload, editor, resize and 1×/2× export. Both PTY suites run
in the CI Node/OS matrix. Full-document parsing/layout and retained document
formula references remain; this is not worker-based or lazy layout.
