# view-latex-md-math

JS 的終端 Markdown／數學排版元件：文字保持原生終端文字，只將公式渲染為圖片。
MathJax 4 → 自包含 SVG → resvg PNG → Kitty graphics。沒有 Chrome、Puppeteer、
TeX 子程序或 Ratatex 依賴。resvg 底層是 Rust，但 npm 使用預編譯 native addon；
開發／安裝這個 JS 套件不需要 Cargo 或 Rust toolchain。

公開套件名稱為 `view-latex-md-math`。閱讀器 CLI 是 `view-latex-md`；可分別安裝。

```sh
npm install view-latex-md-math
```

## 三個介面

```js
import {
  createFormulaRenderer,
  layoutMarkdown,
  createTerminalGraphics,
} from 'view-latex-md-math';

const renderer = createFormulaRenderer({ maxBytes: 32 * 1024 * 1024 });
const formula = await renderer.render(String.raw`\frac{x^2}{y}`, {
  display: false,
  fontSize: 18,
  color: '#d8dee9',
});
// formula = {key, svg, png, width, height, baseline}
// 所有尺寸都是像素；baseline 是圖片頂端到數學基線的距離。

// 同一公式換大小或顏色時重用 TeX SVG 排版，只重新 rasterize。
const larger = await renderer.render(String.raw`\frac{x^2}{y}`, {
  fontSize: 28,
});

const layout = await layoutMarkdown('中文 $x^2$ 和文字。', {
  columns: 80,
  cellWidth: 10,
  cellHeight: 20,
  textBaselinePx: 16,
  fontSize: 18,
  renderer,
});
// layout = {rows, totalRows, warnings}
// 每個 row 是邏輯 line group：
// {textRuns:[{column,text,style}], formulas:[{column,formula,topPx,...}],
//  heightRows,textRow,baselinePx}
// 累加 heightRows 得到 group 的實際終端起始行。
```

`column` 是終端格數；`topPx` 相對於 line group 頂端。
`fontSize` 是公式 em 像素大小，單一公式接受 0 < fontSize ≤ 512；
整份 Markdown 可設定 `fontSize` 與 `mathScale`（有效大小為兩者乘積）。
尺寸變動後需重新呼叫 `layoutMarkdown`，讓換行、基線與行高一起更新。
`textRuns` 在 `textRow` 印出；公式可以比文字高，line group 會保留整格行高，
確保上下行不重疊。獨立公式用自己的緊密行高，不額外套用文字基線。

輸出由宿主控制，避免其他 TUI 繪圖與 Kitty 分段傳輸互相插入：

```js
const graphics = createTerminalGraphics(process.stdout);
await graphics.present([
  { formula, xPx: 20, yPx: 16 - formula.baseline },
], {
  cellWidth: 10, cellHeight: 20,
  viewportCols: 80, viewportRows: 24,
  before: nativeTextAnsi, // 宿主產生的原生文字畫面／diff
  after: footerAnsi,
  refreshCrops: false,
});
await graphics.dispose();
renderer.close();
```

`present` 自己包 synchronized update，先上傳缺少的 texture，再更新文字和各個
placement。裁切座標是原始 PNG 像素，包含子字格 X/Y；同一公式的多個位置共用圖片，
用不同 placement id。暖快取捲動只改位置／裁切。`clear` 和 `dispose` 只刪自己的圖片。
宿主持有 raw mode、鍵盤輸入、捲動位置、終端探測與重排時機。
第一次 present 前，先等終端回覆 Kitty graphics 能力與字格像素尺寸；
特別是在新建立的 Zellij session，不能在協商完成前直接送圖片。

## 排版與範圍

- 支援 `$...$`、`$$...$$`、`\(...\)`、`\[...\]`；code span／fence 不解析公式。
- 基本 Markdown 標題、清單、引用、粗體、斜體、刪除線、連結樣式、程式碼與表格。
- 字寬使用 `string-width`，分割使用 grapheme；中文、emoji、combining mark 不按 UTF-16 截斷。
- 公式太寬時縮小以容納視窗；無效公式保留原始來源，並列入 `warnings`。
- 本地／遠端 Markdown 圖片目前呈現文字標籤；不自動載入圖片或遠端資源。
- 表格是基本文字布局；跨多行 cell 的列對齊、點擊連結、語法高亮仍未實作。

MathJax 的數學基線可精確取得；終端協定只提供字格像素尺寸，沒有字型基線。
因此 `textBaselinePx` 預設估計為 cellHeight × 0.8，宿主可校準。
字格量化使 inline 水平留白與行高仍不能完全等同瀏覽器。

公式用各自的 TeX 狀態，支援在同一公式內定義巨集，尚未支援跨公式定義巨集或完整
TeX 文件／任意套件。第一次 typeset／raster 在 JS 主執行緒，每 16 個新公式讓出
事件迴圈；有快取與並行請求去重，**尚非 background worker**。
TeX SVG 與不同大小／顏色的 PNG 分開快取；兩者合計受 `maxBytes` 限制。
`renderer.stats()` 的 `typesets` 計算 TeX 排版次數，`renders` 計算圖片產生次數；
`clear()` 清除兩層快取，重新渲染會重新排版。
文件 layout 持有公式引用；超大型多樣公式文件的總記憶體未由 renderer LRU 完全限制。

Kitty graphics 與像素偏移需由終端支援。Zellij 0.45.1 使用 `refreshCrops: true`：
公式可見裁切以透明整格 PNG 另存，c/r 比例是 1:1，避開舊版裁切快取與原生裁切座標問題。
第一次造訪新裁切會產生／上傳圖片；重訪同一裁切可快取。tmux 尚未接入透傳。

`./export` 提供無瀏覽器 PNG 匯出；公式使用 SVG 向量重新 rasterize，所以 2× 不只是
放大原 PNG。文字使用 SVG 系統字型，是離線預覽，不是實際終端的螢幕截圖。
