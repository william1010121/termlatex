import test from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { inflateSync } from 'node:zlib';
import { createTerminalGraphics } from './terminal.js';

class Output extends Writable {
  constructor(slow = false) { super({ highWaterMark: slow ? 16 : 1 << 20 }); this.parts = []; this.slow = slow; }
  _write(chunk, encoding, done) { this.parts.push(chunk.toString()); if (this.slow) setImmediate(done); else done(); }
  text() { return this.parts.join(''); }
  commands() {
    return [...this.text().matchAll(/\x1b_G([^;]*);([^\x1b]*)\x1b\\/g)].map(([, controls, data]) => ({
      ...Object.fromEntries(controls.split(',').map(part => part.split('='))), data,
    }));
  }
}
const options = { cellWidth: 10, cellHeight: 20, viewportCols: 20, viewportRows: 8 };
const formula = (key = 'x', width = 28, height = 47, length = 100) => ({ key, width, height, png: Buffer.alloc(length, 7), baseline: 30 });

function pixels(png) {
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20), chunks = [];
  assert.equal(png[24], 8); assert.equal(png[25], 6);
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    if (png.toString('ascii', offset + 4, offset + 8) === 'IDAT') chunks.push(png.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const raw = inflateSync(Buffer.concat(chunks)), rgba = Buffer.alloc(width * height * 4), stride = width * 4;
  const paeth = (a, b, c) => {
    const p = a + b - c, x = Math.abs(p - a), y = Math.abs(p - b), z = Math.abs(p - c);
    return x <= y && x <= z ? a : y <= z ? b : c;
  };
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const index = y * stride + x, a = x >= 4 ? rgba[index - 4] : 0;
      const b = y ? rgba[index - stride] : 0, c = y && x >= 4 ? rgba[index - stride - 4] : 0;
      const predictor = [0, a, b, Math.floor((a + b) / 2), paeth(a, b, c)][filter];
      rgba[index] = raw[y * (stride + 1) + x + 1] + predictor;
    }
  }
  return (x, y) => [...rgba.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)];
}

test('warm scroll preserves one texture and crops in original pixels', async () => {
  const out = new Output(), graphics = createTerminalGraphics(out, { startId: 100 });
  const asset = formula();
  await graphics.present([{ formula: asset, xPx: 13, yPx: 25 }], options);
  await graphics.present([{ formula: asset, xPx: 13, yPx: -12 }], options);
  const commands = out.commands();
  assert.equal(commands.filter(c => c.a === 't').length, 1);
  const placements = commands.filter(c => c.a === 'p');
  assert.deepEqual(placements.map(c => [c.i, c.p, c.x, c.y, c.w, c.h, c.X, c.Y]), [
    ['100', '1', '0', '0', '28', '47', '3', '5'],
    ['100', '1', '0', '12', '28', '35', '3', '0'],
  ]);
  assert.ok(placements.every(c => c.C === '1' && !('c' in c) && !('r' in c)));
  assert.match(out.text(), /\x1b\[2;2H/);
  assert.match(out.text(), /\x1b\[1;2H/);
  await graphics.dispose();
});

test('repeated inline formulas get distinct placement ids, leaving one does not delete the other texture', async () => {
  const out = new Output(), graphics = createTerminalGraphics(out, { startId: 200 });
  const asset = formula();
  await graphics.present([{ formula: asset, xPx: 7, yPx: 20 }, { formula: asset, xPx: 60, yPx: 20 }], options);
  await graphics.present([{ formula: asset, xPx: 60, yPx: 20 }], options);
  const commands = out.commands();
  assert.equal(commands.filter(c => c.a === 't').length, 1);
  assert.deepEqual(commands.filter(c => c.a === 'p').map(c => c.p), ['1', '2', '1']);
  assert.deepEqual(commands.filter(c => c.a === 'd').map(c => [c.d, c.i, c.p]), [['i', '200', '2']]);
  assert.equal(graphics.stats().visiblePlacements, 1);
  await graphics.dispose();
});

test('viewport clips every edge and omits fully invisible formulas', async () => {
  const out = new Output(), graphics = createTerminalGraphics(out, { startId: 300 });
  await graphics.present([
    { formula: formula('left'), xPx: -8, yPx: -10 },
    { formula: formula('right'), xPx: 195, yPx: 155 },
    { formula: formula('invisible'), xPx: 220, yPx: 0 },
  ], options);
  const placements = out.commands().filter(c => c.a === 'p');
  assert.deepEqual(placements.map(c => [c.x, c.y, c.w, c.h, c.X, c.Y]), [
    ['8', '10', '20', '37', '0', '0'], ['0', '0', '5', '5', '5', '15'],
  ]);
  assert.equal(graphics.stats().uploads, 2);
  await graphics.dispose();
});

test('LRU eviction keeps every visible texture even when visible set exceeds quota', async () => {
  const out = new Output(), graphics = createTerminalGraphics(out, { startId: 400, maxBytes: 100 });
  const a = formula('a'), b = formula('b');
  await graphics.present([{ formula: a, xPx: 0, yPx: 0 }, { formula: b, xPx: 50, yPx: 0 }], options);
  assert.equal(graphics.stats().cacheImages, 2);
  await graphics.present([{ formula: b, xPx: 50, yPx: 0 }], options);
  assert.equal(graphics.stats().cacheImages, 1);
  assert.deepEqual(out.commands().filter(c => c.a === 'd' && c.d === 'I').map(c => c.i), ['400']);
  await graphics.clear();
  assert.equal(graphics.stats().cacheBytes, 0);
  assert.ok(out.commands().filter(c => c.a === 'd').every(c => c.i && c.d !== 'a'));
  await graphics.dispose();
});

test('concurrent frames and backpressure never interleave multipart image uploads', async () => {
  const out = new Output(true), graphics = createTerminalGraphics(out, { startId: 500 });
  const a = formula('a', 28, 47, 90_000), b = formula('b', 28, 47, 90_000);
  await Promise.all([
    graphics.present([{ formula: a, xPx: 0, yPx: 0 }], { ...options, before: 'FRAME-A' }),
    graphics.present([{ formula: b, xPx: 0, yPx: 0 }], { ...options, before: 'FRAME-B' }),
  ]);
  let image, complete = 0, base64 = '';
  for (const c of out.commands()) {
    assert.ok(c.data.length <= 4096);
    if (c.a === 't') { assert.equal(image, undefined); image = c.i; base64 = ''; }
    if (image) {
      assert.ok(c.a === 't' || c.a === undefined, 'no placement/delete can split an upload');
      base64 += c.data;
      if (c.m === '0') {
        assert.deepEqual(Buffer.from(base64, 'base64'), image === '500' ? a.png : b.png);
        image = undefined; complete++;
      }
    }
  }
  assert.equal(complete, 2);
  assert.ok(out.parts.every(part => Buffer.byteLength(part) <= 64 * 1024));
  assert.ok(out.text().indexOf('FRAME-A') < out.text().indexOf('FRAME-B'));
  assert.equal((out.text().match(/\x1b\[\?2026h/g) || []).length, 2);
  assert.equal((out.text().match(/\x1b\[\?2026l/g) || []).length, 2);
  await graphics.dispose();
  await assert.rejects(graphics.present([], options), /disposed/);
});

test('invalid geometry fails before a frame or upload begins', async () => {
  const out = new Output(), graphics = createTerminalGraphics(out);
  await assert.rejects(graphics.present([{ formula: formula(), xPx: NaN, yPx: 0 }], options), /Invalid/);
  assert.equal(out.text(), '');
  await graphics.dispose();
});

test('Zellij padded variants preserve exact dimensions and return to a warm crop', async () => {
  const { Resvg } = await import('@resvg/resvg-js');
  const png = Buffer.from(new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="28" height="47"><rect width="28" height="47" fill="red"/></svg>').render().asPng());
  const asset = { ...formula(), png };
  const out = new Output(), graphics = createTerminalGraphics(out, { startId: 600 });
  const config = { ...options, refreshCrops: true };
  await graphics.present([{ formula: asset, xPx: 13, yPx: 25 }], config);
  await graphics.present([{ formula: asset, xPx: 13, yPx: -12 }], config);
  await graphics.present([{ formula: asset, xPx: 13, yPx: 25 }], config);
  const placements = out.commands().filter(c => c.a === 'p');
  assert.deepEqual(placements.map(c => [c.i, c.c, c.r]), [['600', '4', '3'], ['601', '4', '2'], ['600', '4', '3']]);
  assert.ok(placements.every(c => !('X' in c) && !('Y' in c) && !('x' in c) && !('y' in c)));
  assert.equal(graphics.stats().uploads, 2);
  assert.equal(graphics.stats().rasterizedCrops, 2);
  const uploaded = out.commands().filter(c => c.a === 't');
  assert.deepEqual(uploaded.map(c => {
    const data = Buffer.from(c.data, 'base64');
    return [data.readUInt32BE(16), data.readUInt32BE(20)];
  }), [[40, 60], [40, 40]]);
  const first = pixels(Buffer.from(uploaded[0].data, 'base64'));
  assert.deepEqual(first(2, 5), [0, 0, 0, 0]);
  assert.deepEqual(first(3, 4), [0, 0, 0, 0]);
  assert.deepEqual(first(3, 5), [255, 0, 0, 255]);
  assert.deepEqual(first(30, 51), [255, 0, 0, 255]);
  assert.deepEqual(first(31, 51), [0, 0, 0, 0]);
  assert.deepEqual(first(30, 52), [0, 0, 0, 0]);
  const topClip = pixels(Buffer.from(uploaded[1].data, 'base64'));
  assert.deepEqual(topClip(3, 0), [255, 0, 0, 255]);
  assert.deepEqual(topClip(30, 34), [255, 0, 0, 255]);
  assert.deepEqual(topClip(30, 35), [0, 0, 0, 0]);
  await graphics.dispose();
});
