import { createHash } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { Resvg } from '@resvg/resvg-js';
import { mathjax } from '@mathjax/src/js/mathjax.js';
import { TeX } from '@mathjax/src/js/input/tex.js';
import { SVG } from '@mathjax/src/js/output/svg.js';
import { liteAdaptor } from '@mathjax/src/js/adaptors/liteAdaptor.js';
import { RegisterHTMLHandler } from '@mathjax/src/js/handlers/html.js';
import '@mathjax/src/js/util/asyncLoad/esm.js';
import '@mathjax/src/js/input/tex/ams/AmsConfiguration.js';
import '@mathjax/src/js/input/tex/newcommand/NewcommandConfiguration.js';
import '@mathjax/src/js/input/tex/textmacros/TextMacrosConfiguration.js';
import '@mathjax/src/js/input/tex/color/ColorConfiguration.js';

const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);
// MathJax 4 otherwise splits inline expressions into multiple SVG fragments
// around operators. The terminal layout owns wrapping and needs one complete
// image per formula, while display:false still selects genuine inline style.
const output = new SVG({ fontCache: 'local', linebreaks: { inline: false } });
// New Computer Modern glyphs are installed with MathJax; no CDN or browser.
await output.font.loadDynamicFiles();
const packages = ['base', 'ams', 'newcommand', 'textmacros', 'color'];
const stateful = /\\(?:newcommand|renewcommand|providecommand|def|gdef|edef|xdef|let|DeclareMathOperator|label|ref|eqref|tag|require|config|setOptions)\b/;
const MAX_TEX_BYTES = 16 * 1024;
const MAX_PIXELS = 4 * 1024 * 1024;

function typeset(tex, display) {
  // reset() does not remove \newcommand definitions. Each formula is deliberately
  // independent, so cached formulas cannot inherit another document's macros.
  const input = new TeX({
    packages, maxBuffer: MAX_TEX_BYTES,
    formatError(_jax, error) { throw new SyntaxError(error.message); },
  });
  const document = mathjax.document('', { InputJax: input, OutputJax: output });
  const container = document.convert(tex, { display, em: 16, ex: 16 * output.font.params.x_height });
  const node = adaptor.tags(container, 'svg')[0];
  if (!node) throw new Error('MathJax did not produce an SVG');
  const viewBox = adaptor.getAttribute(node, 'viewBox').split(/\s+/).map(Number);
  if (viewBox.length !== 4 || !viewBox.every(Number.isFinite)) throw new Error('Invalid formula viewBox');
  return { svg: adaptor.outerHTML(node), viewBox };
}

function rasterize(vector, { fontSize, color }, key) {
  const viewBox = vector.viewBox;
  // Retain the exact TeX layout in normalized em units when changing size.
  const scale = fontSize / 1000;
  const width = Math.max(1, Math.ceil(viewBox[2] * scale));
  const height = Math.max(1, Math.ceil(viewBox[3] * scale));
  if (width * height > MAX_PIXELS || width > 16384 || height > 16384) {
    throw new RangeError('Formula exceeds the raster size limit');
  }
  const baseline = -viewBox[1] * scale;
  const svg = vector.svg.replace(/^<svg\b[^>]*>/, tag => {
    const clean = tag.replace(/\s(?:width|height|viewBox|color|style)="[^"]*"/g, '').slice(0, -1);
    return `${clean} width="${width}px" height="${height}px" viewBox="${viewBox[0]} ${viewBox[1]} ${width / scale} ${height / scale}" color="${color}" style="color:${color}">`;
  });
  const image = new Resvg(svg, {
    // Math glyphs are SVG paths. System fonts are only needed when MathJax
    // emits a text fallback (for example, CJK within \text{...}).
    font: { loadSystemFonts: /<text\b/.test(svg) },
  }).render();
  const png = Buffer.from(image.asPng());
  return Object.freeze({ key, svg, png, width, height, baseline });
}

/** Browser-free, independently scoped formulas. Sizes and baseline are pixels. */
export function createFormulaRenderer({ maxBytes = 32 * 1024 * 1024, maxEntries = 256 } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || !Number.isSafeInteger(maxEntries) || maxEntries < 0) {
    throw new RangeError('Cache limits must be non-negative safe integers');
  }
  const cache = new Map(), vectors = new Map();
  const vectorBudget = Math.floor(maxBytes / 4), rasterBudget = maxBytes - vectorBudget;
  const inflight = new Map();
  let bytes = 0, vectorBytes = 0, typesets = 0;
  let hits = 0;
  let misses = 0;
  let renders = 0;
  let generation = 0;
  let closed = false;
  let queue = Promise.resolve();
  return {
    render(tex, { display = false, fontSize = 18, color = '#d8dee9', signal } = {}) {
      if (signal?.aborted) return Promise.reject(signal.reason);
      if (closed) return Promise.reject(new Error('Formula renderer is closed'));
      if (typeof tex !== 'string' || Buffer.byteLength(tex) > MAX_TEX_BYTES) {
        return Promise.reject(new RangeError(`Formula must be a string of at most ${MAX_TEX_BYTES} bytes`));
      }
      if (!Number.isFinite(fontSize) || fontSize <= 0 || fontSize > 512) {
        return Promise.reject(new RangeError('fontSize must be greater than 0 and at most 512'));
      }
      if (typeof color !== 'string' || !/^#[\da-f]{6}(?:[\da-f]{2})?$/i.test(color)) {
        return Promise.reject(new TypeError('color must be a six- or eight-digit hexadecimal color'));
      }
      display = Boolean(display);
      const key = createHash('sha256').update(JSON.stringify([tex, display, fontSize, color])).digest('hex');
      const cacheable = !stateful.test(tex);
      if (cacheable && cache.has(key)) {
        const entry = cache.get(key);
        cache.delete(key);
        cache.set(key, entry);
        hits++;
        return Promise.resolve(entry.value);
      }
      if (cacheable && inflight.get(key)?.has(signal)) {
        hits++;
        return inflight.get(key).get(signal);
      }
      misses++;
      const currentGeneration = generation;
      const promise = queue.then(async () => {
        signal?.throwIfAborted();
        // SVG conversion/rasterization is synchronous. Yield between small
        // batches so large documents do not starve input and resize handling.
        if (renders > 0 && renders % 16 === 0) await setImmediate();
        signal?.throwIfAborted();
        if (closed) throw new Error('Formula renderer is closed');
        renders++;
        const vectorKey = createHash('sha256').update(JSON.stringify([tex, display])).digest('hex');
        let prepared = cacheable ? vectors.get(vectorKey) : undefined;
        if (prepared) { vectors.delete(vectorKey); vectors.set(vectorKey, prepared); }
        else {
          typesets++;
          const value = typeset(tex, display);
          const size = Buffer.byteLength(value.svg) + 128;
          prepared = { value, size };
          if (cacheable && currentGeneration === generation && maxEntries > 0 && size <= vectorBudget) {
            vectors.set(vectorKey, prepared); vectorBytes += size;
            while (vectors.size > maxEntries || vectorBytes > vectorBudget) {
              const oldest = vectors.keys().next().value;
              vectorBytes -= vectors.get(oldest).size; vectors.delete(oldest);
            }
          }
        }
        const value = rasterize(prepared.value, { fontSize, color }, key);
        const size = value.png.byteLength + Buffer.byteLength(value.svg);
        if (cacheable && currentGeneration === generation && maxEntries > 0 && size <= rasterBudget) {
          bytes -= cache.get(key)?.size || 0;
          cache.set(key, { value, size });
          bytes += size;
          while (cache.size > maxEntries || bytes > rasterBudget) {
            const oldest = cache.keys().next().value;
            bytes -= cache.get(oldest).size;
            cache.delete(oldest);
          }
        }
        return value;
      });
      queue = promise.catch(() => {});
      if (cacheable) {
        if (!inflight.has(key)) inflight.set(key, new Map());
        inflight.get(key).set(signal, promise);
      }
      const cleanup = () => {
        const requests = inflight.get(key);
        if (requests?.get(signal) === promise) {
          requests.delete(signal);
          if (!requests.size) inflight.delete(key);
        }
      };
      promise.then(cleanup, cleanup);
      return promise;
    },
    clear() { generation++; cache.clear(); vectors.clear(); bytes = 0; vectorBytes = 0; },
    stats() { return { entries: cache.size, bytes: bytes + vectorBytes, vectorEntries: vectors.size, typesets, hits, misses, renders, inflight: inflight.size }; },
    close() { closed = true; generation++; cache.clear(); vectors.clear(); bytes = 0; vectorBytes = 0; },
  };
}
