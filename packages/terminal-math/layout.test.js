import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutMarkdown, textWidth } from './layout.js';

const flatten = doc => doc.rows.flatMap(row => row.textRuns).map(run => run.text).join('\n');
function fakeRenderer(metrics = { width: 24, height: 20, baseline: 15 }) {
  const calls = [];
  return { calls, async render(tex, options) {
    calls.push({ tex, ...options });
    return { key: tex, png: Buffer.alloc(0), svg: '', ...metrics };
  } };
}

test('math delimiters preserve TeX and do not parse inline or fenced code', async () => {
  const renderer = fakeRenderer();
  const document = await layoutMarkdown('Formula $x_1$ and \\(\\alpha\\). `literal $code$`\n\n```tex\n  $$not math$$\n```\n\n\\[\n\\frac{a}{b}\n\\]', { renderer });
  assert.deepEqual(renderer.calls.map(call => call.tex), ['x_1', '\\alpha', '\\frac{a}{b}']);
  assert.deepEqual(renderer.calls.map(call => call.display), [false, false, true]);
  assert.ok(flatten(document).includes('literal $code$'));
  assert.ok(flatten(document).includes('  $$not math$$'));
  assert.equal(document.rows.flatMap(row => row.formulas)[0].source, '$x_1$');
});

test('escaped dollars, currency and unterminated math remain native text', async () => {
  const renderer = fakeRenderer();
  const doc = await layoutMarkdown('Pay \\$10 or $20 today. An unfinished $x', { renderer });
  assert.equal(renderer.calls.length, 0);
  assert.equal(flatten(doc), 'Pay $10 or $20 today. An unfinished $x');
});

test('tall inline formulas share a baseline and expand logical rows without overlap', async () => {
  const renderer = fakeRenderer({ width: 32, height: 57, baseline: 42 });
  const doc = await layoutMarkdown('before $\\frac{a}{b}$ after\n\nnext paragraph', {
    columns: 40, cellWidth: 8, cellHeight: 16, textBaselinePx: 12, renderer,
  });
  const row = doc.rows[0], image = row.formulas[0];
  assert.equal(row.textRow, 2);
  assert.equal(row.baselinePx, row.textRow * 16 + 12);
  assert.equal(image.topPx + image.formula.baseline, row.baselinePx);
  assert.ok(image.topPx >= 0);
  assert.ok(image.topPx + image.formula.height <= row.heightRows * 16);
  assert.ok(row.heightRows > 1);
  assert.equal(doc.totalRows, doc.rows.reduce((sum, row) => sum + row.heightRows, 0));
});

test('standalone display formulas fit tightly without native text baseline padding', async () => {
  const renderer = fakeRenderer({ width: 32, height: 57, baseline: 42 });
  const doc = await layoutMarkdown('$$\\frac{a}{b}$$', {
    columns: 40, cellWidth: 8, cellHeight: 16, textBaselinePx: 12, renderer,
  });
  assert.equal(doc.rows.length, 1);
  const row = doc.rows[0], image = row.formulas[0];
  assert.deepEqual(row.textRuns, []);
  assert.equal(row.heightRows, Math.ceil(57 / 16));
  assert.equal(image.column, 18);
  assert.equal(image.topPx, (row.heightRows * 16 - 57) / 2);
  assert.equal(row.baselinePx, image.topPx + image.formula.baseline);
  assert.equal(row.textRow, 0);
  assert.equal(doc.totalRows, row.heightRows);
});

test('CJK, combining characters and joined emoji use terminal cell widths', async () => {
  assert.equal(textWidth('中文'), 4);
  assert.equal(textWidth('e\u0301'), 1);
  assert.equal(textWidth('👩‍💻'), 2);
  assert.equal(textWidth('🇹🇼'), 2);
  assert.equal(textWidth('❤'), 1);
  assert.equal(textWidth('❤\uFE0E'), 1);
  assert.equal(textWidth('❤\uFE0F'), 2);
  const doc = await layoutMarkdown('甲乙丙丁 e\u0301 👩‍💻', { columns: 5 });
  for (const row of doc.rows) for (const run of row.textRuns) assert.ok(run.column + textWidth(run.text) <= 5);
  assert.ok(flatten(doc).includes('👩‍💻'));
});

test('oversized formulas are rerendered to fit and renderer errors preserve original source', async () => {
  const calls = [];
  const renderer = { async render(tex, options) {
    calls.push(options.fontSize);
    if (tex === 'bad') throw new Error('invalid TeX');
    return { width: options.fontSize * 20, height: options.fontSize, baseline: options.fontSize * .8 };
  } };
  const doc = await layoutMarkdown('$wide$ and $bad$', { renderer, columns: 12, cellWidth: 8, cellHeight: 16 });
  assert.ok(calls[1] < calls[0]);
  const formula = doc.rows.flatMap(row => row.formulas)[0];
  assert.ok(formula.column + Math.ceil(formula.formula.width / 8) <= 12);
  assert.ok(flatten(doc).includes('$bad$'));
  assert.deepEqual(doc.warnings, [{ tex: 'bad', message: 'invalid TeX' }]);
});

test('headings, list indentation, quotes, links and tables retain semantic text styles', async () => {
  const doc = await layoutMarkdown('# Heading\n\n1. **bold** [link](https://example.com)\n2. second\n\n> quoted *italic*\n\n| Name | Value |\n| --- | --- |\n| x | 1 |', { columns: 40 });
  const runs = doc.rows.flatMap(row => row.textRuns);
  assert.ok(runs.some(run => run.text === 'Heading' && run.style.bold));
  assert.ok(runs.some(run => run.text.includes('1. ')));
  assert.ok(runs.some(run => run.text.includes('2. ')));
  assert.ok(runs.some(run => run.text === 'bold' && run.style.bold));
  assert.ok(runs.some(run => run.text === 'link' && run.style.href === 'https://example.com'));
  assert.ok(runs.some(run => run.text.includes('│ ')));
  assert.ok(runs.some(run => run.text === 'italic' && run.style.italic));
  assert.ok(runs.some(run => run.text === 'Name' && run.style.bold));
  assert.equal(doc.warnings.length, 0);
});

test('narrow nested lists keep formula placement and text within terminal columns', async () => {
  const renderer = fakeRenderer({ width: 8, height: 12, baseline: 10 });
  const doc = await layoutMarkdown('- item\n  - 中文 $x$ longword', { columns: 6, renderer });
  for (const row of doc.rows) {
    for (const run of row.textRuns) assert.ok(run.column + textWidth(run.text) <= 6);
    for (const formula of row.formulas) assert.ok(formula.column + Math.ceil(formula.formula.width / 8) <= 6);
  }
});

test('literal and entity-decoded terminal controls cannot reach native text runs', async () => {
  const doc = await layoutMarkdown('literal \u001b[31m and &#x1b;[32m and \u009b2J\n\n```\n\u001b]52;c;payload\u0007\n```');
  const text = flatten(doc);
  assert.doesNotMatch(text, /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u);
  assert.ok(text.includes('␛[31m'));
  assert.ok(text.includes('[32m'));
  assert.ok(text.includes('␇'));
});

test('one-column panes replace unfittable wide glyphs visibly rather than dropping them', async () => {
  const doc = await layoutMarkdown('甲乙', { columns: 1 });
  assert.equal(flatten(doc), '�\n�');
  for (const row of doc.rows) for (const run of row.textRuns) assert.ok(run.column + textWidth(run.text) <= 1);
});
