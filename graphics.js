import { once } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const ESC = '\x1b';
export const graphicsCommand = (control, data = '') => `${ESC}_G${control};${data}${ESC}\\`;

// Graphics commands cannot be interleaved with a multi-part Kitty transmission.
// Keep each transmission atomic, but batch its individual (<=4096 byte) APCs
// into larger writes to avoid a syscall and drain wait for every APC.
export function createGraphics(out, { input, maxBytes = 192 * 1024 * 1024,
  startId = Math.floor(Math.random() * 0x7ffffffe) + 1, onError = () => {} } = {}) {
  const cache = new Map(), replies = new Map();
  let directory, fileTransport = false;
  let queue = Promise.resolve(), epoch = 0, nextId = startId, current = null;
  let bytes = 0, responseTail = '', failure;
  const streamError = error => { failure = error; };
  out.on('error', streamError);
  function enqueue(action) {
    const result = queue.then(action);
    queue = result.catch(() => {});
    return result;
  }
  async function write(text) {
    if (failure) throw failure;
    if (!out.write(text)) await once(out, 'drain');
    if (failure) throw failure;
  }
  function remove(entry) {
    if (cache.get(entry.key) !== entry) return;
    cache.delete(entry.key);
    if (entry.resident) bytes -= entry.bytes;
    if (current === entry.id) current = null;
  }
  function touch(entry) {
    cache.delete(entry.key);
    cache.set(entry.key, entry);
  }
  const responses = data => {
    const text = responseTail + data.toString();
    const expression = /\x1b_G([^;]*);([^\x1b]*)\x1b\\/g;
    for (const match of text.matchAll(expression)) {
      const id = Number(match[1].match(/(?:^|,)i=(\d+)/)?.[1]);
      if (!id) continue;
      const reply = replies.get(id);
      if (reply) { reply(match[2]); continue; }
      if (match[2] === 'OK') continue;
      const entry = [...cache.values()].find(entry => entry.id === id);
      if (!entry) continue;
      remove(entry);
      onError(new Error(`Terminal graphics: ${match[2]}`));
    }
    // Only retain an unfinished APC, never ordinary keyboard input.
    const start = text.lastIndexOf(`${ESC}_G`);
    responseTail = start >= 0 && !text.slice(start).includes(`${ESC}\\`)
      ? text.slice(start).slice(-4096) : text.match(/\x1b_?$/)?.[0] || '';
  };
  input?.on('data', responses);

  async function request(control, data, id, timeout) {
    let timer;
    const reply = new Promise(resolve => {
      replies.set(id, resolve);
      timer = setTimeout(() => resolve('TIMEOUT'), timeout);
    });
    try { await write(graphicsCommand(control, data)); return await reply; }
    finally { clearTimeout(timer); replies.delete(id); }
  }
  async function probeFile({ timeout = 150 } = {}) {
    if (!input) return false;
    return enqueue(async () => {
      try {
        directory ??= await fs.mkdtemp(path.join(os.tmpdir(), 'tty-graphics-protocol-view-latex-md-'));
        const file = path.join(directory, 'probe.rgb');
        await fs.writeFile(file, Buffer.alloc(3), { mode: 0o600 });
        const id = nextId++;
        const answer = await request(`a=q,t=f,f=24,s=1,v=1,i=${id}`, Buffer.from(file).toString('base64'), id, timeout);
        await fs.unlink(file);
        return fileTransport = answer === 'OK';
      } catch { return fileTransport = false; }
    });
  }
  async function upload(png, id) {
    if (fileTransport) {
      const file = path.join(directory, `${id}.png`);
      try {
        await fs.writeFile(file, png, { mode: 0o600 });
        const answer = await request(`a=t,t=f,f=100,i=${id}`, Buffer.from(file).toString('base64'), id, 500);
        if (answer === 'OK') return;
      } catch {}
      finally { await fs.unlink(file).catch(() => {}); }
      // The capability can disappear (e.g. reconnecting to a remote terminal).
      // A failed file transmission leaves the texture untrusted; overwrite it
      // through the universally supported direct transport.
      fileTransport = false;
    }
    const data = png.toString('base64');
    let batch = '';
    for (let offset = 0; offset < data.length; offset += 4096) {
      const more = offset + 4096 < data.length ? 1 : 0;
      const control = offset === 0 ? `a=t,t=d,f=100,i=${id},q=1,m=${more}` : `m=${more}`;
      const chunk = graphicsCommand(control, data.slice(offset, offset + 4096));
      if (batch.length + chunk.length > 64 * 1024) { await write(batch); batch = ''; }
      batch += chunk;
    }
    if (batch) await write(batch);
  }
  function ensure(tile, { prefetch = false } = {}) {
    let entry = cache.get(tile.start);
    if (entry) { if (!prefetch) entry.pinned = true; touch(entry); return entry.ready; }
    const generation = epoch;
    entry = { key: tile.start, id: nextId++, bytes: tile.width * tile.height * 4, tile, pinned: !prefetch };
    if (nextId > 0x7fffffff) nextId = 1;
    cache.set(entry.key, entry);
    entry.ready = enqueue(async () => {
      if (generation !== epoch) return null;
      // Retain the visible texture until a replacement is presented. Speculative
      // preloads never displace it and never exceed the configured byte limit.
      const deletions = [];
      while (bytes + entry.bytes > maxBytes || cache.size > tile.cacheLimit) {
        const victim = [...cache.values()].find(candidate => candidate !== entry && candidate.id !== current && !candidate.pinned && candidate.resident);
        if (!victim) break;
        remove(victim);
        deletions.push(graphicsCommand(`a=d,d=I,i=${victim.id},q=2`));
      }
      const residents = [...cache.values()].filter(candidate => candidate.resident).length;
      if (prefetch && (bytes + entry.bytes > maxBytes || residents + 1 > tile.cacheLimit)) {
        cache.delete(entry.key);
        if (deletions.length) await write(deletions.join(''));
        return null;
      }
      if (deletions.length) await write(deletions.join(''));
      try {
        await upload(tile.png, entry.id);
        if (cache.get(entry.key) !== entry || generation !== epoch) return null;
        entry.resident = true;
        bytes += entry.bytes;
        return entry.id;
      } catch (error) {
        cache.delete(entry.key);
        throw error;
      }
    });
    return entry.ready;
  }
  function present(id, { y, width, height, columns, rows, before = '', after = '' }) {
    return enqueue(async () => {
      const entry = [...cache.values()].find(entry => entry.id === id && entry.resident);
      if (!entry) return false;
      let text = `${ESC}[?2026h${ESC}[H${before}`;
      if (current !== null && current !== id) text += graphicsCommand(`a=d,d=i,i=${current},q=2`);
      text += graphicsCommand(`a=p,i=${id},p=1,x=0,y=${y},w=${width},h=${height},c=${columns},r=${rows},C=1,q=1`);
      current = id;
      entry.pinned = false;
      touch(entry);
      // A foreground miss may need one temporary extra texture while replacing
      // the currently visible one. Remove that texture in the same frame.
      while (bytes > maxBytes || cache.size > entry.tile.cacheLimit) {
        const victim = [...cache.values()].find(candidate => candidate.id !== id && !candidate.pinned && candidate.resident);
        if (!victim) break;
        remove(victim);
        text += graphicsCommand(`a=d,d=I,i=${victim.id},q=2`);
      }
      text += `${after}${ESC}[?2026l`;
      await write(text);
      return true;
    });
  }
  function clear() {
    ++epoch;
    const ids = [...cache.values()].map(entry => entry.id);
    cache.clear(); bytes = 0; current = null;
    return enqueue(() => ids.length ? write(ids.map(id => graphicsCommand(`a=d,d=I,i=${id},q=2`)).join('')) : undefined);
  }
  return { ensure, present, clear, probeFile,
    flush: async () => {
      await queue;
      if (failure) return;
      await new Promise((resolve, reject) => out.write('', error => error ? reject(error) : resolve()));
    },
    async dispose() {
      await queue;
      input?.off('data', responses); out.off('error', streamError);
      if (directory) await fs.rm(directory, { recursive: true, force: true });
    },
  };
}
