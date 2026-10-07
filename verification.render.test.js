import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { createRenderer } from './render.js';

test('independent repeated paint: identical equations remain stable after zoom and fresh document rendering', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'view-latex-md-paint-'));
  const file = path.join(directory, 'document.md');
  const renderer = await createRenderer();
  try {
    await fs.writeFile(file, '# 中文 $x^2$\n\n' + 'A paragraph with $\\alpha_i$.\n\n'.repeat(50));
    await renderer.load(file, { width: 640, height: 480 });
    const original = await renderer.frame();
    for (let cycle = 0; cycle < 3; cycle++) {
      await renderer.load(file, { width: 640, height: 480, mathScale: 1.4 });
      await renderer.frame();
      await renderer.load(file, { width: 640, height: 480, fontSize: 28 });
      await renderer.frame();
      await renderer.load(file, { width: 640, height: 480 });
      assert.ok((await renderer.frame()).equals(original), `font restoration must preserve glyph pixels, cycle ${cycle}`);
    }
    // Tiny fitted SVGs exposed Chromium's GPU bitmap cache changing edge
    // antialiasing even with identical DOM geometry. Repeated fresh renders
    // catch this separately from TeX memoization and unchanged reloads.
    let source = '$$' + 'x+'.repeat(100) + 'y$$';
    let first;
    for (let cycle = 0; cycle < 5; cycle++) {
      source += '\n';
      await fs.writeFile(file, source);
      const loaded = await renderer.load(file, { width: 320, height: 480, fontSize: 28, mathScale: 1.4 });
      assert.notEqual(loaded.changed, false, 'the control must force a fresh document');
      const current = await renderer.frame();
      first ??= current;
      assert.ok(current.equals(first), `identical fresh SVGs must preserve glyph pixels, cycle ${cycle}`);
    }
  } finally {
    await renderer.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('independent font readiness: the packaged MathJax zero font is accessible offline under the actual page CSP', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'view-latex-md-font-'));
  const file = path.join(directory, 'document.md');
  let browser;
  const launch = puppeteer.launch;
  puppeteer.launch = async function (...args) {
    browser = await launch.apply(this, args);
    return browser;
  };
  let renderer;
  try { renderer = await createRenderer(); }
  finally { puppeteer.launch = launch; }
  try {
    await fs.writeFile(file, '中文 $\\alpha_i + \\sqrt{2}$\n');
    await renderer.load(file, { width: 640, height: 480 });
    const page = (await browser.pages())[0];
    const fonts = await page.evaluate(async () => {
      const before = document.fonts.status;
      await document.fonts.load('16px MJX-ZERO');
      await document.fonts.ready;
      return {
        before, after: document.fonts.status,
        available: document.fonts.check('16px MJX-ZERO'),
        zero: [...document.fonts].find(face => face.family === 'MJX-ZERO')?.status,
      };
    });
    assert.equal(fonts.before, 'loaded', 'used fonts must finish before load returns');
    assert.equal(fonts.after, 'loaded');
    assert.equal(fonts.available, true, 'the actual CSP must permit the packaged data font');
    assert.equal(fonts.zero, 'loaded');
  } finally {
    await renderer.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
