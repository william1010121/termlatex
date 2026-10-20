import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { layoutMarkdown } from './layout.js';
import { createFormulaRenderer } from './formula.js';

const metrics = { width: 8, height: 16, baseline: 12 };
const document = Array.from({ length: 100 }, (_, i) => `$x_${i}$`).join('\n\n');

test('abort stops future formulas, rejects instead of warning, and permits recovery', async () => {
  const controller = new AbortController();
  let calls = 0;
  const renderer = { async render(_tex, { signal }) {
    assert.equal(signal, controller.signal);
    await setImmediate();
    if (++calls === 3) controller.abort();
    return metrics; // Deliberately ignores cancellation: layout must discard this result.
  } };
  await assert.rejects(layoutMarkdown(document, { renderer, signal: controller.signal }), { name: 'AbortError' });
  assert.equal(calls, 3);
  const recovered = await layoutMarkdown('$x$', { renderer: { render: async () => metrics } });
  assert.equal(recovered.warnings.length, 0);
  assert.equal(recovered.rows[0].formulas.length, 1);
});

test('pre-aborted layout does not call renderer, including custom reasons', async () => {
  const controller = new AbortController();
  const reason = new Error('superseded'); controller.abort(reason);
  await assert.rejects(layoutMarkdown(document, { signal: controller.signal,
    renderer: { render() { assert.fail('not called'); } } }), error => error === reason);
});

test('abort after oversized formula does not schedule shrink pass', async () => {
  const controller = new AbortController(); let calls = 0;
  await assert.rejects(layoutMarkdown('$x$', { columns: 1, signal: controller.signal,
    renderer: { async render() { calls++; controller.abort(); return { ...metrics, width: 100 }; } } }), { name: 'AbortError' });
  assert.equal(calls, 1);
});

test('table Promise.all cells stop subsequent formulas and rows after abort', async () => {
  const controller = new AbortController(); const calls = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const renderer = { async render(tex) { calls.push(tex); await gate; return metrics; } };
  const pending = layoutMarkdown('| $a$ $b$ | $c$ $d$ |\n|---|---|\n| $e$ | $f$ |', { renderer, signal: controller.signal });
  await setImmediate();
  assert.deepEqual(calls, ['a', 'c']);
  controller.abort(); release();
  await assert.rejects(pending, { name: 'AbortError' });
  await setImmediate();
  assert.deepEqual(calls, ['a', 'c']);
});

test('prose and immediately resolved cached formulas yield to cancellation', async () => {
  for (const source of ['plain paragraph\n\n'.repeat(1000), document]) {
    const controller = new AbortController(); let calls = 0;
    const pending = layoutMarkdown(source, { signal: controller.signal,
      renderer: { async render() { calls++; return metrics; } } });
    setImmediate().then(() => controller.abort());
    await assert.rejects(pending, { name: 'AbortError' });
    assert(calls < 100);
  }
});

test('renderer skips queued aborted work without poisoning subsequent requests', async () => {
  const renderer = createFormulaRenderer();
  const controller = new AbortController();
  const obsolete = Array.from({ length: 20 }, (_, i) => renderer.render(`x_${i}`, { signal: controller.signal }));
  const settled = Promise.allSettled(obsolete);
  controller.abort();
  assert((await settled).every(result => result.status === 'rejected' && result.reason.name === 'AbortError'));
  assert.equal(renderer.stats().renders, 0);
  assert.equal(renderer.stats().typesets, 0);
  await renderer.render('x');
  assert.equal(renderer.stats().renders, 1);
  renderer.close();
});

test('duplicate work shares only the same cancellation scope; independent caller survives', async () => {
  const renderer = createFormulaRenderer();
  const a = new AbortController(), b = new AbortController();
  const obsolete = renderer.render('x', { signal: a.signal });
  assert.equal(renderer.render('x', { signal: a.signal }), obsolete);
  const survivor = renderer.render('x', { signal: b.signal });
  a.abort();
  await assert.rejects(obsolete, { name: 'AbortError' });
  const formula = await survivor;
  assert.equal(await renderer.render('x'), formula);
  assert.equal(renderer.stats().renders, 1);
  renderer.close();
});

test('independent duplicate requests preserve byte accounting and pixels', async () => {
  const renderer = createFormulaRenderer();
  const [a, b] = await Promise.all([renderer.render('x', { signal: new AbortController().signal }), renderer.render('x')]);
  assert.deepEqual(a.png, b.png);
  assert.equal(a.baseline, b.baseline);
  const bytes = renderer.stats().bytes;
  renderer.clear();
  await renderer.render('x');
  assert.equal(renderer.stats().bytes, bytes);
  renderer.close();
});

test('real layout and renderer cancel cold work, then recover with identical pixels', async () => {
  const renderer = createFormulaRenderer();
  const controller = new AbortController();
  const pending = layoutMarkdown(document, { renderer, signal: controller.signal });
  setImmediate().then(() => controller.abort());
  await assert.rejects(pending, { name: 'AbortError' });
  assert(renderer.stats().renders > 0 && renderer.stats().renders < 100);
  assert.equal(renderer.stats().inflight, 0);
  const recovered = await layoutMarkdown('$x_0$', { renderer, signal: new AbortController().signal });
  const normal = await layoutMarkdown('$x_0$', { renderer });
  assert.deepEqual(recovered, normal);
  renderer.close();
});
