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
const svg = new SVG({ fontCache: 'none' });
// Preload the installed New Computer Modern outlines: no web fonts or CDN requests.
await svg.font.loadDynamicFiles();
const mathDocument = mathjax.document('', {
  InputJax: new TeX({ packages: ['base', 'ams', 'newcommand', 'noundefined', 'textmacros', 'color'] }),
  OutputJax: svg,
});
const mathCSS = adaptor.cssText(svg.styleSheet(mathDocument));
const md = new MarkdownIt({ html: false, linkify: true, typographer: true })
  .use(texmath, {
    engine: {
      renderToString(source, { displayMode }) {
        return adaptor.outerHTML(mathDocument.convert(source, { display: displayMode }));
      },
    },
    delimiters: ['dollars', 'brackets'],
  });

export function markdown(source) {
  mathDocument.inputJax[0].reset();
  return md.render(source);
}

export async function createRenderer() {
  // This browser is a local typesetting engine, not an interactive browser session.
  const browser = await puppeteer.launch({ headless: true });
  try {
    const page = await browser.newPage();
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
        await request.respond({ status: 200, contentType: mime, body: await fs.readFile(file) });
      } catch {
        if (!request.isInterceptResolutionHandled()) await request.abort();
      }
    });
    let docHeight = 0;
    let viewHeight = 0;
    let viewWidth = 0;
    let tileHeight = 0;
    let cacheLimit = 3;
    const tiles = new Map();
    return {
      async load(file, { width, height, fontSize = 18, mathScale = 1, foreground = '#d8dee9' }) {
        tiles.clear();
        viewWidth = width;
        root = await fs.realpath(path.dirname(file));
        const body = markdown(await fs.readFile(file, 'utf8'));
        await page.setViewport({ width, height, deviceScaleFactor: 2 });
        await page.setContent(`<!doctype html><html><head><meta charset="utf-8">
          <base href="https://view-latex-md.invalid/">
          <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src https://view-latex-md.invalid data:; font-src https://view-latex-md.invalid">
          <style>${mathCSS}
          * { box-sizing: border-box; }
          html,body { margin:0; background:transparent; }
          body { color:${foreground}; font:${fontSize}px/1.65 -apple-system,BlinkMacSystemFont,'PingFang TC','Noto Sans CJK TC',sans-serif; overflow:hidden; }
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
          mjx-container { font-size:${mathScale}em; }
          </style></head><body><main>${body}</main></body></html>`, { waitUntil: 'load' });
        await page.evaluate(async () => {
          await document.fonts.ready;
          await Promise.all([...document.images].map(image => image.complete ? undefined : new Promise(resolve => {
            image.onload = image.onerror = resolve;
          })));
          // Fit display equations without affecting inline baselines.
          for (const equation of document.querySelectorAll('mjx-container[display]')) {
            const math = equation.querySelector('svg');
            const available = equation.clientWidth;
            const actual = math?.getBoundingClientRect().width || 0;
            if (actual > available) equation.style.fontSize = `${parseFloat(getComputedStyle(equation).fontSize) * available / actual}px`;
          }
        });
        viewHeight = height;
        // Always cover at least two screens, even in a large pane; a one-screen
        // strip would require a fresh screenshot for every pixel of movement.
        tileHeight = Math.max(height * 2, Math.min(height * 3, 4096, Math.floor(64 * 1024 * 1024 / (width * 16))));
        cacheLimit = Math.max(1, Math.min(3, Math.floor(192 * 1024 * 1024 / (width * tileHeight * 16))));
        docHeight = await page.evaluate(() => Math.ceil(document.querySelector('main').getBoundingClientRect().height));
        return { height: docHeight, maxScroll: Math.max(0, docHeight - viewHeight) };
      },
      async frame(offset = 0) {
        await page.setViewport({ width: viewWidth, height: viewHeight, deviceScaleFactor: 2 });
        offset = Math.max(0, Math.min(offset, Math.max(0, docHeight - viewHeight)));
        await page.evaluate(y => { document.querySelector('main').style.transform = `translateY(-${y}px)`; }, offset);
        return Buffer.from(await page.screenshot({ type: 'png', omitBackground: true }));
      },
      async tile(offset = 0) {
        const stride = Math.max(1, tileHeight - viewHeight);
        const start = Math.floor(Math.max(0, offset) / stride) * stride;
        if (tiles.has(start)) {
          const cached = tiles.get(start);
          tiles.delete(start);
          tiles.set(start, cached);
          return cached;
        }
        await page.setViewport({ width: viewWidth, height: tileHeight, deviceScaleFactor: 2 });
        await page.evaluate(y => { document.querySelector('main').style.transform = `translateY(-${y}px)`; }, start);
        const tile = {
          start, width: viewWidth * 2, height: tileHeight * 2, cacheLimit,
          png: Buffer.from(await page.screenshot({ type: 'png', omitBackground: true })),
        };
        tiles.set(start, tile);
        if (tiles.size > cacheLimit) tiles.delete(tiles.keys().next().value);
        return tile;
      },
      async exportPNG(file) {
        await page.evaluate(() => { document.querySelector('main').style.transform = ''; });
        await page.screenshot({ path: file, type: 'png', omitBackground: true, fullPage: true });
      },
      close: () => browser.close(),
    };
  } catch (error) {
    await browser.close();
    throw error;
  }
}
