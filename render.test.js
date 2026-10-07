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
  assert.equal((html.match(/<mjx-container /g) || []).length, 3);
  assert.match(html, /<path id="MJX-/, 'math glyphs must be SVG outlines shared by the document');
});

test('shared glyph outlines preserve ordered macros and contain every reference', () => {
  const html = markdown('$\\newcommand{\\example}{\\alpha}$ $\\example+\\example+\\beta$');
  assert.doesNotMatch(html, /data-mjx-error/);
  const definitions = new Set([...html.matchAll(/<path id="([^"]+)"/g)].map(match => match[1]));
  const references = [...html.matchAll(/xlink:href="#([^"]+)"/g)].map(match => match[1]);
  assert.ok(references.length >= 4);
  for (const reference of references) assert.ok(definitions.has(reference), `${reference} must have an outline`);
  assert.equal(references.filter(id => /-1D6FC$/.test(id)).length, 2, 'both macro uses produce alpha');
  const next = markdown('$z$');
  assert.doesNotMatch(next, /id="MJX-[^"]*-1D6FC"/, 'a new document must not retain unused glyphs');
  assert.ok(next.indexOf('</p>') < next.indexOf('id="MJX-SVG-global-cache"'), 'hidden glyph definitions must follow content to preserve first-child styling');
  assert.match(markdown('$\\example$'), /data-mml-node="mtext" fill="red"/, 'new documents must not inherit user-defined macros');
  assert.match(markdown('$\\color{blue}{x}$'), /fill="blue"/, 'shared outlines must preserve formula color');
});

test('raw HTML cannot run scripts and invalid math remains visible', () => {
  assert.doesNotMatch(markdown('<script>alert(1)</script>'), /<script>/);
  assert.match(markdown('$\\unsupportedCommand$'), /unsupportedCommand/);
  assert.match(markdown('\\(x^2\\)'), /<svg /);
});

test('formula memoization matches uncached TeX and bypasses changing document state', () => {
  const source = String.raw`$x^2$ $x^2$ $\frac{1}{\sqrt{2\pi}}$ $\frac{1}{\sqrt{2\pi}}$

$$x^2$$

$$x^2$$

$\operatorname*{argmax}_{x} f(x)$ $\operatorname*{argmax}_{x} f(x)$ $\sqrt$ $\sqrt$

$$\begin{pmatrix}a&b\\c&d\end{pmatrix}$$

$$\begin{pmatrix}a&b\\c&d\end{pmatrix}$$

$\binom{n}{k}+\cdots+\lVert x\rVert$ $\binom{n}{k}+\cdots+\lVert x\rVert$`;
  const equations = html => [...html.matchAll(/<mjx-container[\s\S]*?<\/mjx-container>/g)].map(match => match[0]);
  assert.deepEqual(equations(markdown(source)), equations(markdown(source + '\n\n`\\unknownCacheBypass`')));
  const macros = equations(markdown('$\\def\\changing{\\alpha}$ $\\changing$ $\\def\\changing{\\beta}$ $\\changing$'));
  assert.match(macros[1], /data-c="1D6FC"/);
  assert.match(macros[3], /data-c="1D6FD"/, 'the identical macro expression must execute after redefinition');
  const colors = equations(markdown('$\\definecolor{brand}{rgb}{1,0,0}$ $\\color{brand}{x}$ $\\definecolor{brand}{rgb}{0,0,1}$ $\\color{brand}{x}$'));
  assert.match(colors[1], /fill="#ff0000"/);
  assert.match(colors[3], /fill="#0000ff"/, 'the identical colored expression must use the current color definition');
  const refs = equations(markdown('$\\ref{here}$\n\n$$\\tag{A}\\label{here}x$$\n\n$\\ref{here}$'));
  assert.notEqual(refs[0], refs[2], 'the identical reference must execute after its label is defined');
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
    assert.ok(!first.equals(last), 'scroll must change the rendered pixels');
    const tile = await renderer.tile(0);
    assert.strictEqual(await renderer.tile(100), tile, 'nearby scrolling must reuse the rendered strip');
    const unchanged = await renderer.load(file, { width: 640, height: 480 });
    assert.equal(unchanged.changed, false, 'reload still reads the file but preserves unchanged pixels');
    assert.strictEqual(await renderer.tile(0), tile, 'unchanged reload must preserve rendered strips');
    assert.equal(tile.png.readUInt32BE(16), 1280);
    assert.ok(tile.height > 960);
    assert.notStrictEqual(await renderer.tile(maxScroll), tile, 'distant scrolling must use a different strip');
    await renderer.load(file, { width: 640, height: 480, mathScale: 1.4 });
    assert.ok(!(await renderer.frame()).equals(first), 'formula size must change the rendered pixels');
    await renderer.load(file, { width: 640, height: 480, fontSize: 28 });
    assert.ok(!(await renderer.frame()).equals(first), 'zoom must change the rendered pixels');
    await renderer.load(file, { width: 640, height: 480 });
    assert.ok((await renderer.frame()).equals(first), 'cached TeX after zoom must preserve the original pixels');
    const oneScale = await renderer.load(file, { width: 640, height: 480, scale: 1 });
    assert.equal(oneScale.maxScroll, maxScroll, 'raster scale must not change layout');
    const oneScaleTile = await renderer.tile(0);
    assert.equal(oneScaleTile.scale, 1);
    assert.equal(oneScaleTile.width, 640);
    assert.equal(oneScaleTile.png.readUInt32BE(16), 640);
    assert.equal((await renderer.frame()).readUInt32BE(20), 480);
    await fs.writeFile(file, '# Changed\n\n$\\sqrt{2}$');
    const reloaded = await renderer.load(file, { width: 640, height: 480 });
    assert.equal(reloaded.maxScroll, 0);
    assert.notStrictEqual(await renderer.tile(0), tile, 'reload must invalidate the strip cache');
    assert.ok(!(await renderer.frame()).equals(first), 'file changes must change the rendered pixels');
    const shortTile = await renderer.tile(0);
    assert.equal(shortTile.height, 960, 'a one-screen document must not capture empty overscan screens');
    await fs.writeFile(file, 'A paragraph with $\\alpha_i$.\n\n'.repeat(15));
    const shortScroll = await renderer.load(file, { width: 640, height: 480 });
    assert.ok(shortScroll.maxScroll > 0 && shortScroll.height < 1440);
    const wholeDocument = await renderer.tile(0);
    assert.equal(wholeDocument.height, shortScroll.height * 2);
    assert.strictEqual(await renderer.tile(shortScroll.maxScroll), wholeDocument, 'a complete document strip serves every scroll position');
    await fs.writeFile(file, 'A long paragraph with $\\alpha_i$.\n\n'.repeat(200));
    await renderer.load(file, { width: 2400, height: 1700 });
    const largePaneTile = await renderer.tile(0);
    assert.ok(largePaneTile.height >= 6800, 'large panes still need overscan to avoid per-pixel screenshots');
    assert.strictEqual(await renderer.tile(100), largePaneTile);
    const ahead = renderer.tile(largePaneTile.stride);
    assert.strictEqual(await renderer.tile(100), largePaneTile, 'cache hits must not wait for background capture');
    await ahead;
    assert.strictEqual(await renderer.tile(100), largePaneTile, 'prefetch must retain the current PNG even with a one-texture terminal budget');
    const pendingCapture = renderer.tile(largePaneTile.stride * 2);
    const pendingReload = renderer.load(file, { width: 640, height: 480 });
    await Promise.all([pendingCapture, pendingReload]);
    const fresh = await renderer.tile(0);
    assert.equal(fresh.width, 1280, 'reload must follow background capture without stale dimensions');
    assert.notStrictEqual(fresh, largePaneTile);
    await fs.writeFile(file, '$$' + 'x+'.repeat(100) + 'y$$');
    await renderer.load(file, { width: 640, height: 480 });
    await renderer.load(file, { width: 320, height: 480, fontSize: 28, mathScale: 1.4 });
    const cachedFit = await renderer.frame();
    await fs.appendFile(file, '\n');
    await renderer.load(file, { width: 320, height: 480, fontSize: 28, mathScale: 1.4 });
    assert.ok((await renderer.frame()).equals(cachedFit), 'cached display math must fit exactly like freshly parsed TeX');
    const imageFile = path.join(dir, 'image.svg');
    const localImage = color => `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="${color}"/></svg>`;
    await fs.writeFile(imageFile, localImage('red'));
    await fs.writeFile(file, '![local](image.svg)');
    await renderer.load(file, { width: 640, height: 480 });
    const red = await renderer.frame();
    await fs.writeFile(imageFile, localImage('blue'));
    await renderer.load(file, { width: 640, height: 480 });
    assert.ok(!(await renderer.frame()).equals(red), 'unchanged Markdown must reload changed local images');
    await fs.writeFile(file, '# After failed load');
    await assert.rejects(renderer.load(file, { width: -1, height: 480 }));
    const recovered = await renderer.load(file, { width: 640, height: 480 });
    assert.equal(recovered.changed, true, 'a failed load must not mark an old DOM reusable');
    const recoveredPixels = await renderer.frame();
    await fs.appendFile(file, '\n');
    await renderer.load(file, { width: 640, height: 480 });
    assert.ok((await renderer.frame()).equals(recoveredPixels), 'retry after failure must match a fresh render');
  } finally {
    await renderer.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
