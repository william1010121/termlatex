import fs from 'node:fs/promises';
import { Resvg } from '@resvg/resvg-js';

const xml = text => String(text).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&apos;' }[c]));
const graphemes = new Intl.Segmenter(undefined,{granularity:'grapheme'});

/** Offline preview/export. Interactive prose stays native terminal text;
 * this artifact uses system SVG fonts, so it is not a terminal screenshot. */
export async function exportDocumentPNG(layout, file, { columns, cellWidth, cellHeight, foreground = '#d8dee9', scale = 1 } = {}) {
  const width = Math.max(1, Math.round(columns*cellWidth));
  const height = Math.max(1, layout.totalRows*cellHeight);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width*height*scale*scale > 64*1024*1024) throw new RangeError('PNG export exceeds 64 million pixels; use a shorter document or smaller width/scale.');
  const { textWidth } = await import('./layout.js');
  let top = 0, body = '';
  for (const group of layout.rows) {
    for (const run of group.textRuns) {
      let column = run.column;
      const style = run.style || {};
      const attributes = `fill="${xml(style.color || foreground)}" font-family="monospace" font-size="${cellHeight*.75}"${style.bold ? ' font-weight="bold"' : ''}${style.italic ? ' font-style="italic"' : ''}${style.strikethrough ? ' text-decoration="line-through"' : ''}`;
      for (const {segment} of graphemes.segment(run.text)) {
        body += `<text x="${column*cellWidth}" y="${top+group.baselinePx}" ${attributes}>${xml(segment)}</text>`;
        column += textWidth(segment);
      }
    }
    for (const placed of group.formulas) body += placed.formula.svg.replace(/<svg\b/, `<svg x="${placed.column*cellWidth}" y="${top+placed.topPx}"`);
    top += group.heightRows*cellHeight;
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`;
  const image = new Resvg(svg,{font:{loadSystemFonts:true},fitTo:{mode:'zoom',value:scale}}).render();
  await fs.writeFile(file,image.asPng());
}
