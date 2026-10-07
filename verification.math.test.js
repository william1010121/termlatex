import test from 'node:test';
import assert from 'node:assert/strict';
import { markdown } from './render.js';

const equations = html => [...html.matchAll(/<mjx-container[\s\S]*?<\/mjx-container>/g)].map(match => match[0]);

test('independent formula differential: repeated, malformed and nested TeX preserves uncached output', () => {
  const fixtures = [
    String.raw`x^2+\frac{\alpha}{\sqrt{2\pi}}`,
    String.raw`\operatorname*{argmax}_{x}\limits f(x)`,
    String.raw`\left\{\frac{x}{y}\right\}\Bigg|_{0}^{1}`,
    String.raw`\text{中文 and }\mathbf{A}\mathbb{R}\mathfrak{g}`,
    String.raw`\widehat{abc}+\overline{x+y}+\ddot{x}`,
    String.raw`\sum_{i=0}^{\infty}\prod_{j=1}^n a_{ij}`,
    String.raw`\sqrt`,
    String.raw`\left(`,
    String.raw`x^{`,
    String.raw`\text{^^5cdef^^5cfoo{a}}`,
    String.raw`\text{&#92;newcommand{&#92;foo}{a}}`,
    String.raw`\text{\mathbf{nested}}`,
    String.raw`\frac{\text{\color{red}{x}}}{y}`,
    String.raw`\unsupportedCommand{x}`,
    String.raw`\gdef\flux{\alpha}`,
    String.raw`\begin{matrix}a&b\\c&d\end{matrix}`,
  ];
  for (const formula of fixtures) {
    const source = `$${formula}$ $z+1$ $${formula}$\n\n$$${formula}$$\n\n$$${formula}$$`;
    const cached = markdown(source);
    const bypassed = markdown(source + '\n\n`\\independentMemoizationBypass`');
    assert.deepEqual(equations(cached), equations(bypassed), formula);
    const ids = [...cached.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
    assert.equal(ids.length, new Set(ids).size, `repeated expressions must not duplicate SVG IDs: ${formula}`);
    const references = [...cached.matchAll(/(?:xlink:href|href)="#([^"]+)"/g)].map(match => match[1]);
    for (const id of references) assert(ids.includes(id), `undefined outline ${id}: ${formula}`);
  }
});

test('independent state fixtures: definitions, color and document resets cannot be memoized incorrectly', () => {
  const changes = [
    [String.raw`\newcommand{\flux}{\alpha}`, String.raw`\renewcommand{\flux}{\beta}`],
    [String.raw`\def\flux{\alpha}`, String.raw`\def\flux{\beta}`],
    [String.raw`\let\flux\alpha`, String.raw`\let\flux\beta`],
  ];
  for (const [initial, changed] of changes) {
    const html = markdown(`$${initial}$ $\\flux$ $${changed}$ $\\flux$`);
    const converted = equations(html);
    assert.equal(converted.length, 4);
    assert.match(converted[1], /data-c="1D6FC"/, initial);
    assert.match(converted[3], /data-c="1D6FD"/, changed);
    assert.match(markdown('$\\flux$'), /data-mml-node="mtext" fill="red"/, 'new documents must reset even global definitions');
  }
  const color = equations(markdown(String.raw`$\definecolor{brand}{rgb}{1,0,0}$ $\color{brand}{x}$ $\definecolor{brand}{rgb}{0,0,1}$ $\color{brand}{x}$`));
  assert.match(color[1], /fill="#ff0000"/);
  assert.match(color[3], /fill="#0000ff"/);
  const untouched = markdown('$x$');
  markdown(String.raw`$\color{red}{x}$`);
  assert.equal(markdown('$x$'), untouched, 'color and shared SVG outlines must not leak across documents');
});
