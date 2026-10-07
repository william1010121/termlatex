import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { createFormulaRenderer } from './formula.js';

function pngInfo(png) {
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
  assert.equal(png[25], 6, 'PNG contains RGBA pixels');
  const data = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    if (png.toString('ascii', offset + 4, offset + 8) === 'IDAT') data.push(png.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const packed = inflateSync(Buffer.concat(data));
  const pixels = Buffer.alloc(width * height * 4);
  const stride = width * 4;
  let position = 0;
  const paeth = (a, b, c) => {
    const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < height; y++) {
    const filter = packed[position++];
    for (let x = 0; x < stride; x++) {
      const index = y * stride + x;
      const a = x >= 4 ? pixels[index - 4] : 0;
      const b = y ? pixels[index - stride] : 0;
      const c = y && x >= 4 ? pixels[index - stride - 4] : 0;
      const prediction = [0, a, b, Math.floor((a + b) / 2), paeth(a, b, c)][filter];
      assert.notEqual(prediction, undefined);
      pixels[index] = (packed[position++] + prediction) & 255;
    }
  }
  return { width, height, pixels };
}

test('formula emits self-contained SVG and transparent PNG without a browser', async () => {
  const renderer = createFormulaRenderer();
  const formula = await renderer.render('x^2 + y^2', { color: '#123456' });
  const info = pngInfo(formula.png);
  assert.equal(info.width, formula.width);
  assert.equal(info.height, formula.height);
  const alpha = [...info.pixels].filter((_value, index) => index % 4 === 3);
  assert(alpha.some(value => value === 0));
  assert(alpha.some(value => value > 0));
  const painted = [...Array(info.width * info.height).keys()].find(index => info.pixels[index * 4 + 3] === 255);
  assert.notEqual(painted, undefined);
  assert.deepEqual([...info.pixels.subarray(painted * 4, painted * 4 + 3)], [0x12, 0x34, 0x56]);
  const ids = new Set([...formula.svg.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]));
  for (const match of formula.svg.matchAll(/(?:xlink:)?href="#([^"]+)"/g)) assert(ids.has(match[1]));
  assert(formula.baseline > 0 && formula.baseline <= formula.height);
});

test('inline fractions use true inline math and preserve ascent/descent metrics', async () => {
  const renderer = createFormulaRenderer();
  const simple = await renderer.render('x', { fontSize: 20 });
  const inline = await renderer.render('\\frac{a}{b}', { fontSize: 20 });
  const display = await renderer.render('\\frac{a}{b}', { fontSize: 20, display: true });
  assert(inline.baseline > simple.baseline);
  assert(inline.height - inline.baseline > simple.height - simple.baseline);
  assert(display.height > inline.height);
  assert.notEqual(display.key, inline.key);
  const doubled = await renderer.render('x', { fontSize: 40 });
  assert(Math.abs(doubled.width - simple.width * 2) <= 1);
  assert(Math.abs(doubled.baseline - simple.baseline * 2) < 0.001);
});

test('inline operators remain in one SVG instead of losing MathJax break fragments', async () => {
  const renderer = createFormulaRenderer();
  const single = await renderer.render('x', { fontSize: 24 });
  const inline = await renderer.render('x+y=z', { fontSize: 24 });
  const display = await renderer.render('x+y=z', { fontSize: 24, display: true });
  assert.equal([...inline.svg.matchAll(/<svg\b/g)].length, 1);
  assert(inline.width > single.width * 3);
  assert.equal(inline.width, display.width);
  assert.match(inline.svg, /data-latex="y"/);
  assert.match(inline.svg, /data-latex="z"/);
});

test('size and color changes reuse TeX layout while retaining exact pixels and baseline', async () => {
  const renderer = createFormulaRenderer();
  const tex = String.raw`\frac{a+b}{\sqrt{c}}`;
  const small = await renderer.render(tex, { fontSize: 18, color: '#123456' });
  const large = await renderer.render(tex, { fontSize: 36, color: '#abcdef' });
  assert.equal(renderer.stats().typesets, 1);
  assert.equal(renderer.stats().renders, 2);
  assert.equal(large.baseline, small.baseline * 2);
  const fresh = createFormulaRenderer({ maxBytes: 0 });
  const reference = await fresh.render(tex, { fontSize: 36, color: '#abcdef' });
  assert.deepEqual(pngInfo(large.png), pngInfo(reference.png));
  await renderer.render(tex, { display: true });
  assert.equal(renderer.stats().typesets, 2, 'display mode has distinct TeX layout');
  renderer.clear();
  assert.equal(renderer.stats().vectorEntries, 0);
  await renderer.render(tex);
  assert.equal(renderer.stats().typesets, 3);
});

test('vector and raster caches share a bounded memory budget', async () => {
  const maxBytes = 16000;
  const renderer = createFormulaRenderer({ maxBytes, maxEntries: 2 });
  for (const tex of ['x', 'y', 'z', 'w']) {
    for (const fontSize of [18, 24, 36]) {
      await renderer.render(tex, { fontSize });
      const stats = renderer.stats();
      assert(stats.bytes <= maxBytes);
      assert(stats.entries <= 2 && stats.vectorEntries <= 2);
    }
  }
  renderer.close();
  assert.equal(renderer.stats().bytes, 0);
});

test('cache deduplicates concurrent work and bounds entries and bytes', async () => {
  const renderer = createFormulaRenderer({ maxEntries: 1, maxBytes: 1024 * 1024 });
  const [a, b] = await Promise.all([renderer.render('x'), renderer.render('x')]);
  assert.equal(a, b);
  assert.equal(renderer.stats().renders, 1);
  await renderer.render('y');
  assert.equal(renderer.stats().entries, 1);
  await renderer.render('x');
  assert.equal(renderer.stats().renders, 3);
  renderer.clear();
  assert.equal(renderer.stats().bytes, 0);
  const tiny = createFormulaRenderer({ maxBytes: 1 });
  await tiny.render('x');
  assert.equal(tiny.stats().entries, 0);
});

test('formula macro state is isolated and definitions are not cached', async () => {
  const renderer = createFormulaRenderer();
  await renderer.render('\\newcommand{\\localfoo}{x}\\localfoo');
  await renderer.render('\\newcommand{\\localfoo}{y}\\localfoo');
  assert.equal(renderer.stats().entries, 0);
  await assert.rejects(renderer.render('\\localfoo'), /Undefined control sequence/);
  await renderer.render('x');
  assert.equal(renderer.stats().entries, 1);
});

test('invalid inputs and TeX reject without poisoning the queue', async () => {
  const renderer = createFormulaRenderer();
  await assert.rejects(renderer.render('x', { color: 'red; background:black' }), /color/);
  await assert.rejects(renderer.render('x', { fontSize: 0 }), /fontSize/);
  await assert.rejects(renderer.render('x'.repeat(17000)), /at most/);
  await assert.rejects(renderer.render('\\frac{'), SyntaxError);
  const valid = await renderer.render('x');
  assert(valid.png.byteLength > 0);
  renderer.close();
  await assert.rejects(renderer.render('x'), /closed/);
});
