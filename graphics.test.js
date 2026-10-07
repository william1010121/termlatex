import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { createGraphics } from './graphics.js';

function sink(delay = 0) {
  const chunks = [];
  const out = new Writable({ highWaterMark: 16 * 1024, write(chunk, encoding, done) {
    chunks.push(chunk.toString());
    if (delay) setTimeout(done, delay); else done();
  } });
  return { out, chunks };
}
function tile(start, bytes = 100, cacheLimit = 3) {
  return { start, width: 100, height: 100, cacheLimit, png: Buffer.alloc(bytes, start + 1) };
}
const placement = { y: 20, width: 100, height: 80, columns: 20, rows: 4, after: 'footer' };
function commands(text) {
  return [...text.matchAll(/\x1b_G([^;]*);([^\x1b]*)\x1b\\/g)];
}

test('batched upload preserves <=4096 payloads and serializes overlapping frames', async () => {
  const { out, chunks } = sink(1);
  const sender = createGraphics(out, { startId: 10 });
  const first = sender.ensure(tile(0, 300000));
  const second = sender.ensure(tile(100, 100000));
  const id = await first;
  await sender.present(id, placement);
  await second;
  await sender.flush();
  const text = chunks.join('');
  const sequence = commands(text);
  assert(chunks.length < 20, `expected batch writes, got ${chunks.length}`);
  assert(sequence.length > 100);
  const transmissions = [];
  let transfer = null;
  for (const [, control, data] of sequence) {
    if (control.startsWith('a=t')) { assert.equal(transfer, null); transfer = { control, data: '' }; }
    if (transfer) {
      assert(data.length <= 4096);
      assert(control.startsWith('a=t') || /^m=[01]$/.test(control));
      transfer.data += data;
      if (control.endsWith('m=0')) { transmissions.push(transfer); transfer = null; }
    }
  }
  assert.equal(transmissions.length, 2);
  assert.deepEqual(Buffer.from(transmissions[0].data, 'base64'), tile(0, 300000).png);
  assert.deepEqual(Buffer.from(transmissions[1].data, 'base64'), tile(100, 100000).png);
  assert(text.includes('footer\x1b[?2026l'));
  await sender.dispose(); out.end();
});

test('deduplicates preload and protects the visible image under memory pressure', async () => {
  const { out, chunks } = sink();
  const sender = createGraphics(out, { startId: 10, maxBytes: 80000 });
  const first = tile(0), next = tile(100), last = tile(200);
  const id = await sender.ensure(first);
  await sender.present(id, placement);
  const pending = sender.ensure(next, { prefetch: true });
  assert.equal(sender.ensure(next, { prefetch: true }), pending);
  const nextId = await pending;
  await sender.ensure(last, { prefetch: true });
  assert(await sender.present(id, placement), 'visible image must survive speculative upload');
  assert.equal(await sender.present(nextId, placement), false, 'old speculative image should be evicted');
  assert(commands(chunks.join('')).some(([, control]) => control === `a=d,d=I,i=${nextId},q=2`));
  await sender.dispose(); out.end();
});

test('foreground replacement permits one transient texture and evicts in the same frame', async () => {
  const { out, chunks } = sink();
  const sender = createGraphics(out, { startId: 1, maxBytes: 40000 });
  const first = await sender.ensure(tile(0, 100, 1));
  await sender.present(first, placement);
  assert.equal(await sender.ensure(tile(100, 100, 1), { prefetch: true }), null);
  const next = await sender.ensure(tile(100, 100, 1));
  await sender.present(next, placement);
  assert.equal(await sender.present(first, placement), false);
  assert(chunks.at(-1).includes(`a=d,d=I,i=${first},q=2`));
  await sender.dispose(); out.end();
});

test('clear invalidates pending upload and never reuses old generation', async () => {
  const { out, chunks } = sink(1);
  const sender = createGraphics(out, { startId: 10 });
  const old = sender.ensure(tile(0, 300000));
  await new Promise(resolve => setTimeout(resolve, 1));
  const clear = sender.clear();
  const next = sender.ensure(tile(0));
  assert.equal(await old, null);
  await clear;
  const id = await next;
  assert.equal(id, 11);
  assert(await sender.present(id, placement));
  await sender.flush();
  const sequence = commands(chunks.join(''));
  const deleteAt = sequence.findIndex(([, control]) => control === 'a=d,d=I,i=10,q=2');
  const uploadAt = sequence.findIndex(([, control]) => control.startsWith('a=t') && control.includes('i=11,'));
  assert(deleteAt > 0 && deleteAt < uploadAt);
  await sender.dispose(); out.end();
});

test('split terminal error invalidates cached id and can recover through reupload', async () => {
  const { out } = sink();
  const input = new EventEmitter(), errors = [];
  const sender = createGraphics(out, { input, startId: 10, onError: error => errors.push(error) });
  const first = await sender.ensure(tile(0));
  input.emit('data', Buffer.from('\x1b_Gi=10;ENOENT: Image'));
  input.emit('data', Buffer.from(' not found\x1b\\'));
  assert.equal(errors.length, 1);
  assert.equal(await sender.present(first, placement), false);
  const next = await sender.ensure(tile(0));
  assert.equal(next, 11);
  assert(await sender.present(next, placement));
  await sender.dispose(); out.end();
});

test('backpressure errors reject callers without hanging the graphics queue', async () => {
  const { out } = sink(2);
  const sender = createGraphics(out);
  const result = sender.ensure(tile(0, 300000));
  setTimeout(() => out.destroy(new Error('broken pipe')), 3);
  await assert.rejects(result, /broken pipe/);
  await sender.flush();
  await sender.dispose();
});

test('preload cannot evict a foreground texture between ensure and present', async () => {
  const { out } = sink();
  const sender = createGraphics(out, { startId: 1, maxBytes: 80000 });
  const first = await sender.ensure(tile(0));
  await sender.present(first, placement);
  const next = await sender.ensure(tile(100));
  assert.equal(await sender.ensure(tile(200), { prefetch: true }), null);
  assert(await sender.present(next, placement));
  await sender.dispose(); out.end();
});

test('file transport requires a successful real probe and removes private files after ACK', async () => {
  const fs = await import('node:fs/promises');
  const input = new EventEmitter(), files = [];
  const out = new Writable({ write(chunk, encoding, done) {
    for (const [, control, data] of commands(chunk.toString())) {
      if (!control.includes('t=f')) continue;
      const filename = Buffer.from(data, 'base64').toString();
      const id = Number(control.match(/i=(\d+)/)[1]);
      files.push(filename);
      fs.stat(filename).then(stat => {
        assert.equal(stat.mode & 0o777, 0o600);
        input.emit('data', Buffer.from(`\x1b_Gi=${id};OK\x1b\\`));
      }).catch(done);
    }
    done();
  } });
  const sender = createGraphics(out, { input, startId: 1 });
  assert(await sender.probeFile());
  const id = await sender.ensure(tile(0));
  assert.equal(id, 2);
  assert.equal(files.length, 2);
  for (const file of files) await assert.rejects(fs.stat(file), { code: 'ENOENT' });
  await sender.dispose();
  await assert.rejects(fs.stat(files[0].replace(/\/probe\.rgb$/, '')), { code: 'ENOENT' });
  out.end();
});

test('unsupported file probe uses direct transport and failed file upload falls back without losing texture', async () => {
  for (const supported of [false, true]) {
    const input = new EventEmitter(), chunks = [];
    const out = new Writable({ write(chunk, encoding, done) {
      const text = chunk.toString(); chunks.push(text);
      for (const [, control] of commands(text)) {
        if (!control.includes('t=f')) continue;
        const id = Number(control.match(/i=(\d+)/)[1]);
        const response = supported && control.startsWith('a=q') ? 'OK' : 'EBADF: Failed to read image file';
        queueMicrotask(() => input.emit('data', Buffer.from(`\x1b_Gi=${id};${response}\x1b\\`)));
      }
      done();
    } });
    const sender = createGraphics(out, { input, startId: 1 });
    assert.equal(await sender.probeFile(), supported);
    const id = await sender.ensure(tile(0));
    assert(await sender.present(id, placement));
    assert(chunks.some(text => text.includes('a=t,t=d,f=100')));
    await sender.dispose(); out.end();
  }
});


test('terminal replies split at every byte still invalidate evicted textures', async () => {
  const { out } = sink();
  const input = new EventEmitter(), errors = [];
  const sender = createGraphics(out, { input, startId: 42, onError: error => errors.push(error) });
  const id = await sender.ensure(tile(0));
  for (const byte of Buffer.from('\x1b_Gi=42,p=1;ENOENT: Image not found\x1b\\')) input.emit('data', Buffer.from([byte]));
  assert.equal(errors.length, 1);
  assert.equal(await sender.present(id, placement), false);
  await sender.dispose(); out.end();
});
