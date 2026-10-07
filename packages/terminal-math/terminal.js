import { once } from 'node:events';

const ESC = '\x1b';
const command = (control, data = '') => `${ESC}_G${control};${data}${ESC}\\`;
const deleteTexture = id => command(`a=d,d=I,i=${id},q=2`);
const deletePlacement = (id, placement) => command(`a=d,d=i,i=${id},p=${placement},q=2`);

/** Own only this component's image ids. The caller retains raw mode and input. */
export function createTerminalGraphics(output, {
  maxBytes = 64 * 1024 * 1024, onError = () => {},
  startId = Math.floor(Math.random() * 0x7ffffffe) + 1,
} = {}) {
  if (!(maxBytes > 0) || !Number.isFinite(maxBytes)) throw new RangeError('maxBytes must be positive');
  if (!Number.isInteger(startId) || startId < 1 || startId > 0xffffffff) throw new RangeError('Invalid image id');
  const cache = new Map();
  let active = new Map(), queue = Promise.resolve(), nextId = startId;
  let bytes = 0, failure, closing = false;
  const counters = { frames: 0, uploads: 0, uploadedBytes: 0, placements: 0, evictions: 0, rasterizedCrops: 0 };
  const errorListener = error => { failure = error; };
  output.on('error', errorListener);

  function enqueue(action) {
    const result = queue.then(action);
    queue = result.catch(error => { try { onError(error); } catch {} });
    return result;
  }
  async function write(text) {
    if (failure) throw failure;
    if (text && !output.write(text)) await once(output, 'drain');
    if (failure) throw failure;
  }
  async function upload(entry) {
    const data = entry.png.toString('base64');
    let batch = '';
    for (let offset = 0; offset < data.length; offset += 4096) {
      const more = offset + 4096 < data.length ? 1 : 0;
      const controls = offset === 0 ? `a=t,t=d,f=100,i=${entry.id},q=2,m=${more}` : `m=${more}`;
      const part = command(controls, data.slice(offset, offset + 4096));
      if (batch.length + part.length > 64 * 1024) { await write(batch); batch = ''; }
      batch += part;
    }
    if (batch) await write(batch);
    counters.uploads++;
    counters.uploadedBytes += entry.png.length;
  }
  function touch(entry) { cache.delete(entry.key); cache.set(entry.key, entry); }
  async function trim(visible, incomingBytes = 0) {
    for (const entry of cache.values()) {
      if (bytes + incomingBytes <= maxBytes) break;
      if (visible.has(entry.key)) continue;
      await write(deleteTexture(entry.id));
      cache.delete(entry.key); bytes -= entry.bytes; counters.evictions++;
    }
  }

  function geometry(placement, cw, ch, columns, rows) {
    const { formula } = placement;
    if (!formula || !Buffer.isBuffer(formula.png) || formula.png.length === 0 ||
      !Number.isInteger(formula.width) || !Number.isInteger(formula.height) ||
      formula.width <= 0 || formula.height <= 0 || typeof formula.key !== 'string' ||
      !Number.isFinite(placement.xPx) || !Number.isFinite(placement.yPx)) {
      throw new TypeError('Invalid formula placement');
    }
    const x = Math.round(placement.xPx), y = Math.round(placement.yPx);
    const left = Math.max(0, x), top = Math.max(0, y);
    const right = Math.min(columns * cw, x + formula.width);
    const bottom = Math.min(rows * ch, y + formula.height);
    if (right <= left || bottom <= top) return null;
    return { formula, left, top, x: left - x, y: top - y,
      width: right - left, height: bottom - top,
      column: Math.floor(left / cw), row: Math.floor(top / ch),
      offsetX: left % cw, offsetY: top % ch };
  }

  async function imageFor(g, cw, ch, padded) {
    if (!padded) return { key: JSON.stringify(['formula', g.formula.key]),
      png: g.formula.png, width: g.formula.width, height: g.formula.height };
    // Zellij 0.45.1 ignores native source crops and caches scaled crops by id.
    // Crop and pad locally, use a distinct id, and scale a whole-cell image 1:1.
    // Transparent padding preserves inline metrics without touching native text.
    const width = Math.ceil((g.offsetX + g.width) / cw) * cw;
    const height = Math.ceil((g.offsetY + g.height) / ch) * ch;
    const key = JSON.stringify(['padded', g.formula.key, g.x, g.y, g.width,
      g.height, g.offsetX, g.offsetY, cw, ch]);
    const existing = cache.get(key);
    if (existing) return existing;
    const { Resvg } = await import('@resvg/resvg-js');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><image x="${g.offsetX - g.x}" y="${g.offsetY - g.y}" width="${g.formula.width}" height="${g.formula.height}" xlink:href="data:image/png;base64,${g.formula.png.toString('base64')}"/></svg>`;
    const png = Buffer.from(new Resvg(svg, { font: { loadSystemFonts: false } }).render().asPng());
    counters.rasterizedCrops++;
    return { key, png, width, height };
  }

  function present(placements, { before = '', after = '', cellWidth, cellHeight,
    viewportCols = output.columns, viewportRows = output.rows, refreshCrops = false } = {}) {
    if (closing) return Promise.reject(new Error('Graphics component is disposed'));
    return enqueue(async () => {
      const cw = Math.round(cellWidth), ch = Math.round(cellHeight);
      if (![cw, ch, viewportCols, viewportRows].every(value => Number.isInteger(value) && value > 0)) {
        throw new RangeError('Positive cell and viewport dimensions are required');
      }
      const geometries = placements.map(p => geometry(p, cw, ch, viewportCols, viewportRows)).filter(Boolean);
      const images = [], prepared = new Map();
      for (const g of geometries) {
        // Share newly prepared variants even before they have reached the terminal.
        const variantKey = JSON.stringify([g.formula.key, g.x, g.y, g.width, g.height, g.offsetX, g.offsetY, cw, ch]);
        let image = prepared.get(variantKey);
        if (!image) { image = await imageFor(g, cw, ch, refreshCrops); prepared.set(variantKey, image); }
        images.push(image);
      }
      const visible = new Set(images.map(image => image.key));
      let syncStarted = false;
      try {
        await write(`${ESC}[?2026h`); syncStarted = true;
        // Compute the visible set before uploads, keeping its textures pinned.
        const nextActive = new Map(), counts = new Map();
        for (const image of images) {
          let entry = cache.get(image.key);
          if (!entry) {
            await trim(visible, image.width * image.height * 4 + image.png.length);
            entry = { ...image, id: nextId++, bytes: image.width * image.height * 4 + image.png.length };
            if (nextId > 0xffffffff) nextId = 1;
            await upload(entry);
            cache.set(entry.key, entry); bytes += entry.bytes;
          }
          touch(entry);
          const p = (counts.get(entry.id) || 0) + 1;
          counts.set(entry.id, p);
          nextActive.set(`${entry.id}:${p}`, { id: entry.id, p });
        }
        let frame = '';
        for (const [key, previous] of active) {
          if (!nextActive.has(key)) frame += deletePlacement(previous.id, previous.p);
        }
        frame += before;
        counts.clear();
        for (let n = 0; n < geometries.length; n++) {
          const g = geometries[n], entry = cache.get(images[n].key);
          const p = (counts.get(entry.id) || 0) + 1;
          counts.set(entry.id, p);
          frame += `${ESC}[${g.row + 1};${g.column + 1}H`;
          frame += refreshCrops
            ? command(`a=p,i=${entry.id},p=${p},c=${entry.width / cw},r=${entry.height / ch},C=1,q=2`)
            : command(`a=p,i=${entry.id},p=${p},x=${g.x},y=${g.y},w=${g.width},h=${g.height},X=${g.offsetX},Y=${g.offsetY},C=1,q=2`);
          counters.placements++;
        }
        frame += after;
        await write(frame);
        active = nextActive;
        await trim(visible);
        counters.frames++;
      } finally {
        if (syncStarted) await write(`${ESC}[?2026l`);
      }
    });
  }
  async function clearOwned() {
    if (cache.size) await write([...cache.values()].map(entry => deleteTexture(entry.id)).join(''));
    cache.clear(); active.clear(); bytes = 0;
  }
  return {
    present,
    clear() { return closing ? Promise.resolve() : enqueue(clearOwned); },
    stats() { return { ...counters, cacheImages: cache.size, cacheBytes: bytes, visiblePlacements: active.size }; },
    dispose() {
      if (closing) return queue;
      closing = true;
      return enqueue(async () => {
        try { await clearOwned(); }
        finally { output.off('error', errorListener); }
      });
    },
  };
}
