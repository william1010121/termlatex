import fs from 'node:fs/promises';
import path from 'node:path';
import MarkdownIt from 'markdown-it';
import texmath from 'markdown-it-texmath';
import puppeteer from 'puppeteer';
import { mathjax } from '@mathjax/src/js/mathjax.js';
import { TeX } from '@mathjax/src/js/input/tex.js';
import { SVG } from '@mathjax/src/js/output/svg.js';
import { liteAdaptor } from '@mathjax/src/js/adaptors/liteAdaptor.js';
import { RegisterHTMLHandler } from '@mathjax/src/js/handlers/html.js';
import '@mathjax/src/js/util/asyncLoad/esm.js';
import '@mathjax/src/js/input/tex/ams/AmsConfiguration.js';
import '@mathjax/src/js/input/tex/newcommand/NewcommandConfiguration.js';
import '@mathjax/src/js/input/tex/noundefined/NoUndefinedConfiguration.js';
import '@mathjax/src/js/input/tex/textmacros/TextMacrosConfiguration.js';
import '@mathjax/src/js/input/tex/color/ColorConfiguration.js';

const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);
const svg = new SVG({ fontCache: 'global' });
// Preload the installed New Computer Modern outlines: no web fonts or CDN requests.
await svg.font.loadDynamicFiles();
const newMathDocument = () => mathjax.document('', {
  InputJax: new TeX({ packages: ['base', 'ams', 'newcommand', 'noundefined', 'textmacros', 'color'] }),
  OutputJax: svg,
});
let mathDocument = newMathDocument();
const mathCSS = adaptor.cssText(svg.styleSheet(mathDocument));
// These commands only typeset their arguments in the fixed packages above.
// Unknown commands anywhere in the source disable memoization for the whole
// document: definitions, colors, references and tags must execute in order.
// Re-audit this list if packages, custom macros or automatic tags change.
const pureMathCommands = new Set(`
  alpha beta gamma delta epsilon varepsilon zeta eta theta vartheta iota kappa
  lambda mu nu xi pi varpi rho varrho sigma varsigma tau upsilon phi varphi chi psi omega
  Gamma Delta Theta Lambda Xi Pi Sigma Upsilon Phi Psi Omega
  frac dfrac tfrac sqrt sum prod int iint iiint oint infty cdot times pm mp div
  le leq ge geq ne neq approx equiv sim simeq to rightarrow leftarrow leftrightarrow
  Rightarrow Leftarrow Leftrightarrow partial nabla ell Re Im
  lim log ln exp sin cos tan arcsin arccos arctan min max sup inf det gcd
  left right big Big bigg Bigg overline underline hat widehat bar vec dot ddot
  mathbf mathrm mathit mathsf mathtt mathcal mathbb mathfrak text operatorname limits nolimits
  begin end binom dbinom tbinom dots ldots cdots vdots ddots quad qquad
  underbrace overbrace overset underset langle rangle vert Vert lvert rvert lVert rVert
  forall exists in notin subseteq supseteq cup cap setminus oplus otimes
`.trim().split(/\s+/));
const pureMathEscapes = new Set(' ,;!:{}#%_$&|/\\');
const canMemoizeMath = source => {
  for (const [, command] of source.matchAll(/\\([A-Za-z]+|[\s\S]|$)/g)) {
    if (!pureMathCommands.has(command) && !pureMathEscapes.has(command)) return false;
  }
  return true;
};
let formulaCache = null;
const md = new MarkdownIt({ html: false, linkify: true, typographer: true })
  .use(texmath, {
    engine: {
      renderToString(source, { displayMode }) {
        const key = `${displayMode ? 'display' : 'inline'}:${source}`;
        if (formulaCache?.has(key)) return formulaCache.get(key);
        const html = adaptor.outerHTML(mathDocument.convert(source, { display: displayMode }));
        formulaCache?.set(key, html);
        return html;
      },
    },
    delimiters: ['dollars', 'brackets'],
  });

export function markdown(source) {
  // reset() clears tags, but retains \newcommand definitions. Give each source
  // its own TeX state while sharing the preloaded SVG font outlines.
  mathDocument = newMathDocument();
  svg.clearFontCache();
  formulaCache = canMemoizeMath(source) ? new Map() : null;
  let body;
  try { body = md.render(source); }
  finally { formulaCache = null; }
  // One set of glyph outlines serves the whole document. Stateful equations
  // still pass through TeX in order, preserving macro definitions and tags.
  return body + adaptor.outerHTML(svg.pageElements(mathDocument));
}

export async function createRenderer() {
  // This browser is a local typesetting engine, not an interactive browser session.
  // GPU SVG rasterization can lose glyph pixels between identical captures on
  // macOS. Keep compositing enabled, but rasterize vectors consistently in CPU.
  const browser = await puppeteer.launch({ headless: true, args: ['--disable-gpu-rasterization'] });
  try {
    const page = (await browser.pages())[0] || await browser.newPage();
    await page.setCacheEnabled(false);
    await page.setJavaScriptEnabled(false);
    await page.setRequestInterception(true);
    let root = '';
    page.on('request', async request => {
      try {
        const url = new URL(request.url());
        if (url.protocol === 'data:') return request.continue();
        if (url.hostname !== 'view-latex-md.invalid') return request.abort();
        const file = await fs.realpath(path.resolve(root, decodeURIComponent(url.pathname.slice(1))));
        if (!file.startsWith(root + path.sep)) return request.abort();
        const mime = {
          '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
          '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
        }[path.extname(file).toLowerCase()];
        if (!mime) return request.abort();
        await request.respond({ status: 200, contentType: mime, headers: { 'Cache-Control': 'no-store' }, body: await fs.readFile(file) });
      } catch {
        if (!request.isInterceptResolutionHandled()) await request.abort();
      }
    });
    let docHeight = 0;
    let viewHeight = 0;
    let viewWidth = 0;
    let viewScale = 2;
    let tileHeight = 0;
    let singleTile = false;
    let cacheLimit = 3;
    let lastSource;
    let lastBody;
    let lastRoot;
    let lastOptionsCSS;
    let domValid = false;
    let imageRevision = 0;
    const tiles = new Map();
    // Cache hits can run while a neighboring strip is being captured. All page
    // mutations stay serialized so prefetch cannot race with reload or zoom.
    let pageQueue = Promise.resolve();
    const withPage = action => {
      const result = pageQueue.then(action);
      pageQueue = result.catch(() => {});
      return result;
    };
    return {
      async load(file, { width, height, fontSize = 18, mathScale = 1, foreground = '#d8dee9', scale = 2 }) {
        return withPage(async () => {
          if (scale !== 1 && scale !== 2) throw new Error('Render scale must be 1 or 2');
          const nextRoot = await fs.realpath(path.dirname(file));
          const source = await fs.readFile(file, 'utf8');
          const unchangedSource = domValid && source === lastSource && lastRoot === nextRoot && !lastBody.includes('<img ');
          const optionsCSS = `body { color:${foreground}; font:${fontSize}px/1.65 -apple-system,BlinkMacSystemFont,'PingFang TC','Noto Sans CJK TC',sans-serif; } mjx-container { font-size:${mathScale}em; }`;
          if (unchangedSource && lastOptionsCSS === optionsCSS && viewWidth === width && viewHeight === height && viewScale === scale) {
            return { height: docHeight, maxScroll: Math.max(0, docHeight - viewHeight), changed: false };
          }
          // Zoom and resize change layout, not TeX. Cache the complete document
          // rather than individual formulas, whose macros can depend on order.
          const renderedBody = source === lastSource ? lastBody : markdown(source);
          tiles.clear();
          domValid = false;
          root = nextRoot;
          // Chromium retains decoded images across setContent(), even with
          // network caching disabled. MarkdownIt emits quoted, escaped src
          // attributes; changing only their query rereads local files on reload.
          const revision = ++imageRevision;
          const body = renderedBody.replace(/(<img\b[^>]*\bsrc=")([^"]*)(")/g, (match, before, url, after) => {
            if (url.startsWith('data:')) return match;
            const hash = url.indexOf('#');
            const sourceURL = hash < 0 ? url : url.slice(0, hash);
            const fragment = hash < 0 ? '' : url.slice(hash);
            return `${before}${sourceURL}${sourceURL.includes('?') ? '&amp;' : '?'}viewer-reload=${revision}${fragment}${after}`;
          });
          await page.setViewport({ width, height, deviceScaleFactor: scale });
          // Rebuild the DOM when layout changes. Chromium can retain stale SVG
          // glyph paint after font reflow even if visible/shared SVGs are cloned.
          // Cached TeX HTML avoids typesetting again without risking lost pixels.
          await page.setContent(`<!doctype html><html><head><meta charset="utf-8">
            <base href="https://view-latex-md.invalid/">
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src https://view-latex-md.invalid data:; font-src https://view-latex-md.invalid data:">
            <style>${mathCSS}
            * { box-sizing: border-box; }
            html,body { margin:0; background:transparent; }
            body { overflow:hidden; }
            main { padding:18px 26px 30px; overflow-wrap:anywhere; }
            main > :first-child { margin-top:0; }
            h1,h2,h3,h4 { line-height:1.3; margin:1.3em 0 .6em; }
            h1 { font-size:1.8em; } h2 { font-size:1.4em; } h3 { font-size:1.15em; }
            p,ul,ol,blockquote,pre,table { margin:.8em 0; }
            a { color:#70b7e8; text-decoration:underline; }
            strong { font-weight:700; }
            code { font-family:'SFMono-Regular',Menlo,monospace; font-size:.86em; background:#8882; border-radius:4px; padding:.12em .25em; }
            pre { padding:12px 16px; background:#8882; border-radius:6px; white-space:pre-wrap; }
            pre code { background:none; padding:0; overflow-wrap:anywhere; }
            blockquote { border-left:3px solid #8888; padding-left:16px; margin-left:0; opacity:.9; }
            table { border-collapse:collapse; width:100%; table-layout:fixed; }
            th,td { border:1px solid #8887; padding:7px 10px; text-align:left; }
            th { background:#8882; }
            hr { border:0; border-top:1px solid #8887; margin:1.4em 0; }
            img { max-width:100%; height:auto; }
            </style><style id="viewer-options">${optionsCSS}</style></head><body><main>${body}</main></body></html>`, { waitUntil: 'load' });
          await page.evaluate(async () => {
            // setContent(waitUntil: 'load') already waits for local images.
            // MathJax's embedded zero-width face controls inline break spacing;
            // load it before measuring so late font activation cannot reflow.
            await document.fonts.load('16px MJX-ZERO');
            await document.fonts.ready;
            // Fit display equations without affecting inline baselines.
            for (const equation of document.querySelectorAll('mjx-container[display]')) {
              const math = equation.querySelector('svg');
              const available = equation.clientWidth;
              const actual = math?.getBoundingClientRect().width || 0;
              if (actual > available) equation.style.fontSize = `${parseFloat(getComputedStyle(equation).fontSize) * available / actual}px`;
            }
          });
          viewHeight = height;
          viewWidth = width;
          viewScale = scale;
          docHeight = await page.evaluate(() => Math.ceil(document.querySelector('main').getBoundingClientRect().height));
          // Always cover at least two screens, even in a large pane; a one-screen
          // strip in a long document would require a screenshot for every pixel.
          // Short documents need only their real height, with one strip serving
          // every scroll position instead of capturing transparent extra screens.
          const pixelBytes = 4 * scale * scale;
          const overscanHeight = Math.max(height * 2, Math.min(height * 3, 4096, Math.floor(64 * 1024 * 1024 / (width * pixelBytes))));
          tileHeight = Math.max(height, Math.min(docHeight, overscanHeight));
          singleTile = docHeight <= tileHeight;
          cacheLimit = Math.max(1, Math.min(3, Math.floor(192 * 1024 * 1024 / (width * tileHeight * pixelBytes))));
          lastOptionsCSS = optionsCSS;
          lastRoot = nextRoot;
          lastBody = renderedBody;
          lastSource = source;
          domValid = true;
          return { height: docHeight, maxScroll: Math.max(0, docHeight - viewHeight), changed: true };
        });
      },
      async frame(offset = 0) {
        return withPage(async () => {
          await page.setViewport({ width: viewWidth, height: viewHeight, deviceScaleFactor: viewScale });
          offset = Math.max(0, Math.min(offset, Math.max(0, docHeight - viewHeight)));
          await page.evaluate(y => { document.querySelector('main').style.transform = `translateY(-${y}px)`; }, offset);
          return Buffer.from(await page.screenshot({ type: 'png', omitBackground: true }));
        });
      },
      async tile(offset = 0) {
        const stride = singleTile ? tileHeight : Math.max(1, tileHeight - viewHeight);
        const start = singleTile ? 0 : Math.floor(Math.max(0, offset) / stride) * stride;
        if (tiles.has(start)) {
          const cached = tiles.get(start);
          tiles.delete(start);
          tiles.set(start, cached);
          return cached;
        }
        return withPage(async () => {
          // Another request may have populated the cache while this one waited.
          if (tiles.has(start)) return tiles.get(start);
          await page.setViewport({ width: viewWidth, height: tileHeight, deviceScaleFactor: viewScale });
          await page.evaluate(y => { document.querySelector('main').style.transform = `translateY(-${y}px)`; }, start);
          const tile = {
            start, stride, scale: viewScale, width: viewWidth * viewScale, height: tileHeight * viewScale, cacheLimit,
            png: Buffer.from(await page.screenshot({ type: 'png', omitBackground: true, optimizeForSpeed: true })),
          };
          tiles.set(start, tile);
          // Compressed PNGs are small; keep three even when terminal texture
          // memory only permits one decoded strip. This makes prefetch useful in
          // large panes without increasing terminal graphics memory.
          if (tiles.size > 3) tiles.delete(tiles.keys().next().value);
          return tile;
        });
      },
      async exportPNG(file) {
        return withPage(async () => {
          await page.evaluate(() => { document.querySelector('main').style.transform = ''; });
          await page.screenshot({ path: file, type: 'png', omitBackground: true, fullPage: true });
        });
      },
      close: async () => { await pageQueue; await browser.close(); },
    };
  } catch (error) {
    await browser.close();
    throw error;
  }
}
