import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import MarkdownIt from 'markdown-it';
import texmath from 'markdown-it-texmath';
import katex from 'katex';
import puppeteer from 'puppeteer';

const require = createRequire(import.meta.url);
const katexDir = path.dirname(require.resolve('katex/package.json'));
const md = new MarkdownIt({ html: false, linkify: true, typographer: true })
  .use(texmath, {
    engine: katex, delimiters: ['dollars', 'brackets'],
    katexOptions: { throwOnError: false, trust: false, strict: 'ignore' },
  });

export function markdown(source) {
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
        const isFont = url.pathname.startsWith('/katex/fonts/');
        const base = isFont ? path.join(katexDir, 'dist/fonts') : root;
        const relative = decodeURIComponent(isFont ? url.pathname.slice(13) : url.pathname.slice(1));
        const file = await fs.realpath(path.resolve(base, relative));
        if (!file.startsWith(base + path.sep)) return request.abort();
        const mime = {
          '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
          '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
          '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
        }[path.extname(file).toLowerCase()];
        if (!mime) return request.abort();
        await request.respond({ status: 200, contentType: mime, body: await fs.readFile(file) });
      } catch {
        if (!request.isInterceptResolutionHandled()) await request.abort();
      }
    });
    const mathCSS = (await fs.readFile(path.join(katexDir, 'dist/katex.min.css'), 'utf8'))
      .replaceAll('url(fonts/', 'url(https://view-latex-md.invalid/katex/fonts/');
    let docHeight = 0;
    let viewHeight = 0;
    return {
      async load(file, { width, height, fontSize = 18, foreground = '#d8dee9' }) {
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
          .katex { font-size:1.08em; }
          .katex-display { margin:1em 0; }
          </style></head><body><main>${body}</main></body></html>`, { waitUntil: 'load' });
        await page.evaluate(async () => {
          await document.fonts.ready;
          await Promise.all([...document.images].map(image => image.complete ? undefined : new Promise(resolve => {
            image.onload = image.onerror = resolve;
          })));
          // Fit display equations without affecting inline baselines.
          for (const equation of document.querySelectorAll('.katex-display > .katex')) {
            const math = equation.querySelector('.katex-html');
            const available = equation.parentElement.clientWidth;
            const actual = math?.getBoundingClientRect().width || 0;
            if (actual > available) equation.style.fontSize = `${parseFloat(getComputedStyle(equation).fontSize) * available / actual}px`;
          }
        });
        viewHeight = height;
        docHeight = await page.evaluate(() => Math.ceil(document.querySelector('main').getBoundingClientRect().height));
        return { height: docHeight, maxScroll: Math.max(0, docHeight - viewHeight) };
      },
      async frame(offset = 0) {
        offset = Math.max(0, Math.min(offset, Math.max(0, docHeight - viewHeight)));
        await page.evaluate(y => { document.querySelector('main').style.transform = `translateY(-${y}px)`; }, offset);
        return Buffer.from(await page.screenshot({ type: 'png', omitBackground: true }));
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
