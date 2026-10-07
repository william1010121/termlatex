import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { Writable } from 'node:stream';
import { createFormulaRenderer } from './formula.js';
import { layoutMarkdown, textWidth } from './layout.js';
import { createTerminalGraphics } from './terminal.js';

function decodeRGBA(png) {
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  let width, height, channels, bytes = [];
  for (let at = 8; at < png.length;) {
    const length = png.readUInt32BE(at), kind = png.toString('ascii', at + 4, at + 8);
    const data = png.subarray(at + 8, at + 8 + length);
    if (kind === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      assert.equal(data[8], 8); assert.equal(data[9], 6, 'formula PNG must preserve transparency');
      assert.equal(data[12], 0); channels = 4;
    }
    if (kind === 'IDAT') bytes.push(data);
    at += length + 12;
  }
  const raw = inflateSync(Buffer.concat(bytes)), stride = width * channels;
  const rgba = Buffer.alloc(height * stride);
  const paeth = (a, b, c) => {
    const p = a + b - c, da = Math.abs(p - a), db = Math.abs(p - b), dc = Math.abs(p - c);
    return da <= db && da <= dc ? a : db <= dc ? b : c;
  };
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    assert.ok(filter <= 4);
    for (let x = 0; x < stride; x++) {
      const index = y * stride + x, a = x >= channels ? rgba[index - channels] : 0;
      const b = y ? rgba[index - stride] : 0, c = y && x >= channels ? rgba[index - stride - channels] : 0;
      const delta = [0, a, b, Math.floor((a + b) / 2), paeth(a, b, c)][filter];
      rgba[index] = (raw[y * (stride + 1) + 1 + x] + delta) & 255;
    }
  }
  return { width, height, rgba };
}

test('browser-free formula PNG contains transparent margins and real glyph pixels', async () => {
  const renderer = createFormulaRenderer();
  const formula = await renderer.render(String.raw`\frac{x^2+1}{\sqrt{y}}`, { fontSize: 22 });
  const image = decodeRGBA(formula.png);
  assert.equal(image.width, formula.width); assert.equal(image.height, formula.height);
  assert.ok(formula.baseline >= 0 && formula.baseline <= formula.height);
  const alpha = Array.from(image.rgba).filter((_, index) => index % 4 === 3);
  assert.ok(alpha.some(value => value > 0), 'must contain visible formula pixels');
  assert.ok(alpha.some(value => value === 0), 'must preserve transparent space');
  assert.match(formula.svg, /<path\b/);
  assert.doesNotMatch(formula.svg, /https?:\/\/[^"']+\.(?:woff|ttf)/);
  assert.strictEqual(await renderer.render(String.raw`\frac{x^2+1}{\sqrt{y}}`, { fontSize: 22 }), formula);
  assert.equal(renderer.stats().renders, 1, 'repeat formula must reuse raster output');
  const [single, expression] = await Promise.all([
    renderer.render('x', { fontSize: 22 }), renderer.render('x+x+x+x+x', { fontSize: 22 }),
  ]);
  assert.ok(expression.width > single.width * 5, 'inline SVG must retain every operator and following term');
  assert.equal((expression.svg.match(/<svg\b/g) || []).length, 1);
});

test('mixed Markdown keeps prose and code native while math is independently rasterized', async () => {
  const renderer = createFormulaRenderer();
  const document = await layoutMarkdown('# 中文公式\n\n左邊 $x^2$ 右邊。\n\n`$code$`\n\n```tex\n$notmath$\n```\n\n$$\n\\frac{a}{b}\n$$\n', {
    columns: 30, cellWidth: 10, cellHeight: 20, fontSize: 16, renderer,
  });
  const text = document.rows.flatMap(row => row.textRuns.map(run => run.text)).join('\n');
  assert.match(text, /中文公式/); assert.match(text, /左邊/); assert.match(text, /右邊/);
  assert.match(text, /\$code\$/); assert.match(text, /\$notmath\$/);
  assert.doesNotMatch(text, /x\^2|\\frac/);
  const formulas = document.rows.flatMap(row => row.formulas);
  assert.equal(formulas.length, 2, 'inline and display formulas only, code remains native');
  for (const placement of formulas) assert.equal(placement.formula.png.subarray(1, 4).toString(), 'PNG');
});

test('CJK wrapping and tall inline formulas reserve nonoverlapping terminal rows', async () => {
  const columns = 18, cellWidth = 10, cellHeight = 20;
  const document = await layoutMarkdown('前面文字中文 $\\frac{\\frac{a}{b}}{\\sqrt{c}}$ 後面文字中文很多很多。\n\n下一段 $z$ 結尾。', {
    columns, cellWidth, cellHeight, fontSize: 20, renderer: createFormulaRenderer(),
  });
  let rows = 0;
  for (const row of document.rows) {
    assert.ok(Number.isInteger(row.heightRows) && row.heightRows >= 1);
    assert.ok(row.textRow >= 0 && row.textRow < row.heightRows);
    const occupied = [];
    for (const run of row.textRuns) {
      const end = run.column + textWidth(run.text);
      assert.ok(run.column >= 0 && end <= columns, `native text outside viewport: ${run.text}`);
      if (end > run.column) occupied.push([run.column * cellWidth, end * cellWidth]);
    }
    for (const placement of row.formulas) {
      const { formula, column, topPx } = placement;
      assert.ok(column >= 0 && column * cellWidth + formula.width <= columns * cellWidth);
      assert.ok(topPx >= 0 && topPx + formula.height <= row.heightRows * cellHeight);
      assert.ok(Math.abs(topPx + formula.baseline - row.baselinePx) < .001, 'math baselines align within group');
      occupied.push([column * cellWidth, column * cellWidth + formula.width]);
    }
    occupied.sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < occupied.length; i++) assert.ok(occupied[i][0] >= occupied[i - 1][1], 'text and formula rectangles overlap');
    rows += row.heightRows;
  }
  assert.equal(document.totalRows, rows);
  assert.ok(document.rows.some(row => row.heightRows > 1), 'tall formula must reserve space');
  assert.equal(textWidth('中文'), 4);
});

test('actual math textures use independent placements and warm scrolling only updates crops', async () => {
  const renderer = createFormulaRenderer();
  const [first, second] = await Promise.all([
    renderer.render(String.raw`\frac{a}{b}`, { fontSize: 24 }),
    renderer.render('x^2', { fontSize: 24 }),
  ]);
  const chunks = [];
  const output = new Writable({ write(data, _encoding, done) { chunks.push(data.toString()); done(); } });
  const graphics = createTerminalGraphics(output, { startId: 100 });
  const options = { cellWidth: 10, cellHeight: 20, viewportCols: 30, viewportRows: 4 };
  await graphics.present([
    { formula: first, xPx: 3, yPx: 5 }, { formula: first, xPx: 60, yPx: 5 },
    { formula: second, xPx: 120, yPx: 5 },
  ], options);
  assert.equal(graphics.stats().uploads, 2, 'same formula at multiple positions shares one upload');
  assert.equal(graphics.stats().visiblePlacements, 3);
  chunks.length = 0;
  await graphics.present([
    { formula: first, xPx: 3, yPx: -7 }, { formula: first, xPx: 60, yPx: -7 },
    { formula: second, xPx: 120, yPx: -7 },
  ], options);
  const frame = chunks.join('');
  assert.doesNotMatch(frame, /a=t,/);
  const controls = Array.from(frame.matchAll(/\x1b_G(a=p,[^;]*);/g), match => match[1]);
  assert.equal(controls.length, 3);
  assert.ok(controls.every(control => /,y=7,/.test(control)), 'each independent formula clips its own top pixels');
  assert.match(controls[0], /,p=1,/); assert.match(controls[1], /,p=2,/);
  assert.equal(graphics.stats().uploads, 2);
  await graphics.dispose();
});

test('Zellij padded crop retains exact visible glyph pixels and transparent cell padding', async () => {
  const renderer = createFormulaRenderer();
  const formula = await renderer.render(String.raw`\frac{a}{b}`, { fontSize: 24 });
  const source = decodeRGBA(formula.png), chunks = [];
  const output = new Writable({ write(data, _encoding, done) { chunks.push(data.toString()); done(); } });
  const graphics = createTerminalGraphics(output, { startId: 200 });
  const options = { cellWidth: 10, cellHeight: 20, viewportCols: 30, viewportRows: 4, refreshCrops: true };
  await graphics.present([{ formula, xPx: 3, yPx: -7 }], options);
  let encoded = '';
  for (const match of chunks.join('').matchAll(/\x1b_G([^;]*);([^\x1b]*)\x1b\\/g)) {
    if (match[1].includes('a=t,') || match[1].startsWith('m=')) encoded += match[2];
  }
  const padded = decodeRGBA(Buffer.from(encoded, 'base64'));
  assert.equal(padded.width % 10, 0); assert.equal(padded.height % 20, 0);
  const visibleHeight = formula.height - 7;
  for (let y = 0; y < padded.height; y++) {
    for (let x = 0; x < padded.width; x++) {
      const pixel = padded.rgba.subarray((y * padded.width + x) * 4, (y * padded.width + x + 1) * 4);
      if (x >= 3 && x < 3 + source.width && y < visibleHeight) {
        const at = ((y + 7) * source.width + x - 3) * 4;
        assert.deepEqual(pixel, source.rgba.subarray(at, at + 4), `cropped glyph pixel ${x},${y}`);
      } else assert.equal(pixel[3], 0, `cell padding ${x},${y} must be transparent`);
    }
  }
  chunks.length = 0;
  await graphics.present([{ formula, xPx: 3, yPx: -7 }], options);
  assert.doesNotMatch(chunks.join(''), /a=t,/);
  assert.equal(graphics.stats().rasterizedCrops, 1);
  await graphics.dispose();
});
