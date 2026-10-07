# view-latex-md

在終端閱讀 Markdown 和 LaTeX：**文字保持原生終端文字，只有公式是透明圖片**。
現在預設使用 repo 裡的 npm 元件 [view-latex-md-math](packages/terminal-math/README.md)，
MathJax SVG → resvg PNG → Kitty graphics，不需要 Chrome、TeX 或 Rust toolchain。

```sh
view-latex-md native-demo.md
view-latex-md test.md --font-size 22
view-latex-md notes.md --math-scale 1.2
view-latex-md notes.md --text-baseline 16
view-latex-md notes.md --text
```

支援 `$...$`、`$$...$$`、`\(...\)`、`\[...\]`。程式碼中的公式保留原文。
原生文字支援中文、emoji、標題、清單、引用、粗體、斜體、刪除線、程式碼及基本表格。
inline 公式共用文字基線；高分數、積分等會擴張該行的保留高度，避免蓋住上下行。
獨立公式置中。公式用本機 MathJax New Computer Modern 字形，不需要網路字型。

一般文字可使用終端的選取功能（滑鼠捕捉時按住終端的 selection modifier，通常是 Shift）。
公式圖片不提供原生公式文字選取；按 `s` 顯示原始 LaTeX，並解除滑鼠捕捉。
`--text` 可在無圖片協定的終端閱讀；終端未確認 Kitty graphics 也會保留公式原文。
本地／遠端圖片目前顯示文字標籤；連結有樣式但尚未接入點擊。
跨公式巨集、複雜跨行表格與 syntax highlighting 也尚未實作。

## 安裝

需要 Node.js 22+。npm 安裝預編譯 resvg addon，沒有 Chromium 下載。

```sh
cd ~/tool/cli/view-latex-md
npm ci
mkdir -p ~/.local/bin
ln -s "$PWD/cli.js" ~/.local/bin/view-latex-md
```

已存在的 `view-latex-md` symlink 不需要重建。閱讀器安裝方式：`npm install -g view-latex-md`。
套件可獨立打包給其他 JS 專案使用，見 [套件 README](packages/terminal-math/README.md)。

## 操作與大小

| 按鍵 | 動作 |
| --- | --- |
| ↑ / ↓、k / j、滑鼠滾輪 | 按終端行捲動 |
| Space / PgDn / f、PgUp / b | 翻頁 |
| g / G | 首／尾 |
| + 或 = / - | 放大／縮小公式 |
| s | 切換公式圖片／原始來源 |
| e | 使用 `$VISUAL`、`$EDITOR` 或 `vi` 編輯，返回後重讀 |
| r | 重讀磁碟檔案；內容未變時保留排版與圖片 |
| q / Ctrl-C | 離開並恢復終端 |

`--font-size` 是公式初始 em 像素大小（10–48），`--math-scale` 再乘上倍率（0.5–3）。
**+/- 只調公式，一般文字使用終端自己的字體縮放**；終端縮放造成 resize 時會重新
探測字格像素尺寸，讓公式與新的終端字格一起縮放。
終端沒有提供真正的字型基線，預設估計為字格高度的 80%；可用 `--text-baseline PX` 校準。
原生文字受字格限制，水平間距與高公式行距不能完全等同網頁。

文字只更新變動的可見行；直接終端的熱快取捲動不重新排版公式或上傳圖片。
公式縮放重用已排版的 SVG，只重新 rasterize；回到快取中的大小可直接使用 PNG。
輸入事件會合併成最新畫面，採終端行捲動，不再使用整頁圖片的像素動畫。
Zellij 0.45.1 已驗證：用透明整格裁切圖片避開裁切快取問題；首次新裁切仍需 raster／上傳，
返回已見裁切可以快取。tmux 暫未支援圖片透傳。

## 驗證與匯出

```sh
npm test
python3 native-terminal.test.py
python3 native-zellij.test.py
node native-benchmark.js
view-latex-md native-demo.md --render /tmp/preview.png --width 900
view-latex-md native-demo.md --render /tmp/preview-2x.png --raster-scale 2
```

PNG 匯出不使用 Chrome；公式以 SVG 向量 rasterize，文字用系統 SVG 字型。
這是離線布局預覽，與真正終端字型的畫面可能不同。
`--raster-scale` 僅供匯出使用。`--light` 使用深色前景。
效能量測與目前限制見 [NATIVE_PERFORMANCE.md](NATIVE_PERFORMANCE.md)。

## 舊原型

`browser-cli.js`／`render.js` 保留先前整頁 Chromium 圖片原型，既有 browser 測試與
`benchmark.py` 明確指向該入口。它的 Puppeteer 依賴已移出目前安裝；需要另行
安裝 Puppeteer 和 markdown-it-texmath 才能執行。舊量測留在 [PERFORMANCE.md](PERFORMANCE.md)。
Ratatui 試作保留於 `ratatui/`；目前 JS 套件與閱讀器不使用它。
