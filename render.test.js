import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { markdown, createRenderer } from './render.js';

test('inline/display math, Markdown, and literal code coexist', () => {
  const html = markdown('# Title\n\n中文 $x^2$。\n\n$$\n\\frac{1}{2}\n$$\n\n`$literal$`\n\n```tex\n$x^2$\n```\n\n| A | B |\n|---|---|\n| 1 | $y$ |');
  assert.match(html, /<h1>Title<\/h1>/);
  assert.match(html, /<mjx-container[^>]*display="true"/);
  assert.match(html, /<table>/);
  assert.match(html, /<code>\$literal\$<\/code>/);
  assert.match(html, /<code class="language-tex">\$x\^2\$/);
  assert.equal((html.match(/<svg /g) || []).length, 3);
  assert.match(html, /<path data-c=/, 'math glyphs must be SVG outlines');
});

test('raw HTML cannot run scripts and invalid math remains visible', () => {
  assert.doesNotMatch(markdown('<script>alert(1)</script>'), /<script>/);
  assert.match(markdown('$\\unsupportedCommand$'), /unsupportedCommand/);
  assert.match(markdown('\\(x^2\\)'), /<svg /);
});

test('offline rendering produces PNGs at viewport size, including scroll and reload', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'view-latex-md-test-'));
  const file = path.join(dir, 'test.md');
  const renderer = await createRenderer();
  try {
    await fs.writeFile(file, '# 中文 $x^2$\n\n' + 'A paragraph with $\\alpha_i$.\n\n'.repeat(50));
    const { maxScroll } = await renderer.load(file, { width: 640, height: 480 });
    assert.ok(maxScroll > 480);
    const first = await renderer.frame(0), last = await renderer.frame(maxScroll);
    assert.equal(first.subarray(1, 4).toString(), 'PNG');
    assert.equal(first.readUInt32BE(16), 1280);
    assert.equal(first.readUInt32BE(20), 960);
    assert.notDeepEqual(first, last);
    const tile = await renderer.tile(0);
    assert.strictEqual(await renderer.tile(100), tile, 'nearby scrolling must reuse the rendered strip');
    assert.equal(tile.png.readUInt32BE(16), 1280);
    assert.ok(tile.height > 960);
    assert.notStrictEqual(await renderer.tile(maxScroll), tile, 'distant scrolling must use a different strip');
    await renderer.load(file, { width: 640, height: 480, mathScale: 1.4 });
    assert.notDeepEqual(await renderer.frame(), first, 'formula size must change the rendered pixels');
    await renderer.load(file, { width: 640, height: 480, fontSize: 28 });
    assert.notDeepEqual(await renderer.frame(), first, 'zoom must change the rendered pixels');
    await fs.writeFile(file, '# Changed\n\n$\\sqrt{2}$');
    const reloaded = await renderer.load(file, { width: 640, height: 480 });
    assert.equal(reloaded.maxScroll, 0);
    assert.notStrictEqual(await renderer.tile(0), tile, 'reload must invalidate the strip cache');
    assert.notDeepEqual(await renderer.frame(), first);
    await renderer.load(file, { width: 2400, height: 1700 });
    const largePaneTile = await renderer.tile(0);
    assert.ok(largePaneTile.height >= 6800, 'large panes still need overscan to avoid per-pixel screenshots');
    assert.strictEqual(await renderer.tile(100), largePaneTile);
  } finally {
    await renderer.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
