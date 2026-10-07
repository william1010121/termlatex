import { performance } from 'node:perf_hooks';
import { Writable } from 'node:stream';
const started = performance.now();
const { createFormulaRenderer, layoutMarkdown, createTerminalGraphics } = await import('view-latex-md-math');
const imported = performance.now();
const renderer = createFormulaRenderer();
const tex = String.raw`\int_{-\infty}^{\infty}e^{-x^2}\,dx=\sqrt{\pi}`;
await renderer.render(tex,{display:true,fontSize:20});
const first = performance.now();
for (let i=0;i<1000;i++) await renderer.render(tex,{display:true,fontSize:20});
const cached = performance.now();
// Compare resizing a prepared vector with typesetting again at each size.
// Both paths rasterize every size; this measures formula work, not full CLI FPS.
async function zoomSweep(cache) {
  const timings = [];
  for (let round = 0; round < 11; round++) {
    const r = createFormulaRenderer(cache ? { maxEntries: 1 } : { maxBytes: 0 });
    await r.render(tex, { display: true, fontSize: 24 });
    const start = performance.now();
    for (let size = 10; size <= 48; size += 2) await r.render(tex, { display: true, fontSize: size });
    if (round) timings.push(performance.now() - start);
    r.close();
  }
  return timings.sort((a, b) => a - b)[timings.length >>> 1];
}
const zoomTypesetMs = await zoomSweep(false);
const zoomPreparedMs = await zoomSweep(true);
const layoutStart = performance.now();
const source = ('原生文字中文 $x^2$ end.\n\n$$\\frac{a}{b}$$\n\n').repeat(1000);
const document = await layoutMarkdown(source,{columns:80,cellWidth:10,cellHeight:20,fontSize:18,renderer});
const laidOut = performance.now();
let top=0;
const groups=document.rows.map(group=>{const entry={...group,start:top,end:top+group.heightRows};top=entry.end;return entry;});
let bytes=0;
const output=new Writable({write(chunk,_encoding,callback){bytes+=chunk.length;callback();}});
const graphics=createTerminalGraphics(output);
function viewport(scroll) {
  let lo=0,hi=groups.length;
  while(lo<hi){const mid=(lo+hi)>>>1;if(groups[mid].end<=scroll)lo=mid+1;else hi=mid;}
  const placements=[];
  for(let i=lo;i<groups.length&&groups[i].start<scroll+24;i++)for(const p of groups[i].formulas)placements.push({formula:p.formula,xPx:p.column*10,yPx:(groups[i].start-scroll)*20+p.topPx});
  return placements;
}
const options={cellWidth:10,cellHeight:20,viewportCols:80,viewportRows:24};
await graphics.present(viewport(0),options);
const uploads=graphics.stats().uploads;
const beforeBytes=bytes;
const frames=2000;
const frameStart=performance.now();
for(let i=0;i<frames;i++)await graphics.present(viewport(i*7%(document.totalRows-24)),options);
const frameTime=performance.now()-frameStart;
console.log(JSON.stringify({moduleLoadMs:+(imported-started).toFixed(3),firstFormulaMs:+(first-imported).toFixed(3),cached1000Ms:+(cached-first).toFixed(3),zoomSweep:{sizes:'10–48 px, step 2',medianOf:10,typesetEachSizeMs:+zoomTypesetMs.toFixed(3),reuseVectorMs:+zoomPreparedMs.toFixed(3),speedup:+(zoomTypesetMs/zoomPreparedMs).toFixed(2)},layout1000ParagraphPairsMs:+(laidOut-layoutStart).toFixed(3),documentRows:document.totalRows,scrollFrames:frames,averageFrameCPUms:+(frameTime/frames).toFixed(4),warmExtraUploads:graphics.stats().uploads-uploads,frameCommandBytes:bytes-beforeBytes,formulaCache:renderer.stats()},null,2));
await graphics.dispose();renderer.close();
