# view-latex-md

在 cmux、Ghostty 或 Kitty 裡閱讀 Markdown 和 LaTeX 的獨立命令列工具。
Markdown 與數學先在本機一起排版，再用 Kitty graphics protocol 顯示透明圖片，
中文和行內公式使用同一套排版，不受終端固定字格的基線限制。
附近幾頁會快取成圖片（終端依畫面大小保留 1–3 個區段），並在背景預先截取、上傳捲動方向的下一區段。
快取命中時只更新裁切位置，動畫以約 60Hz 輸出；短文件整份共用一張圖片。
截圖採用較快的無損 PNG 編碼。SVG 字形共用，純公式在同一文件內去重；縮放重用已排好的公式，連按 zoom 會合併處理。
捲動途中按 reload、zoom 或 edit，會中斷動畫直接處理；reload 每次重讀檔案，內容未變時保留圖片快取。
終端支援本機檔案傳輸時會使用它，否則自動退回分段圖片傳輸；暫存圖片在收到回覆後移除。
在 Zellij 內會自動啟用裁切更新相容處理：0.45.1 會保留舊的縮放圖片，因此改變裁切位置時需重傳快取 PNG。
公式與截圖仍會快取，捲動指令改以約 30Hz 輸出，避免累積傳輸；直接在 cmux／Ghostty／Kitty 執行維持原本約 60Hz 的快取路徑。

```sh
view-latex-md test.md
view-latex-md notes.md --font-size 20
view-latex-md notes.md --math-scale 1.2
view-latex-md notes.md --raster-scale 2
```

支援標題、清單、表格、引用、連結文字、程式碼區塊、本地圖片，以及
`$...$`、`$$...$$`、`\(...\)`、`\[...\]` 數學。公式使用 MathJax 4 的 SVG 輸出與預設
New Computer Modern 字形、基線與間距，不依賴終端或瀏覽器的數學替代字型。
`--math-scale` 只調整公式大小（預設 1；範圍 0.5–3）；`--font-size` 調整整頁大小。
終端預設按實際像素渲染，避免在 Retina 上重複放大。`--raster-scale 2` 可啟用額外抗鋸齒，增加截圖與圖片記憶體成本；字體大小與排版不變。
數學使用 MathJax 支援的 LaTeX 子集（base、ams、newcommand、noundefined、textmacros、color），
不是完整 TeX 文件編譯器。原始 HTML 與遠端圖片不載入；閱讀時不需網路。

| 按鍵 | 動作 |
| --- | --- |
| ↑ / ↓ 或 k / j | 捲動 |
| 滑鼠滾輪 | 捲動 |
| Space / PgDn / f | 下一頁 |
| PgUp / b | 上一頁 |
| g / G | 最上／最下 |
| + 或 = / - | 放大／縮小（狀態列顯示比例與字體大小） |
| e | 使用 `$VISUAL`、`$EDITOR` 或 `vi` 編輯；退出編輯器後重新渲染 |
| r | 從磁碟重新讀取並渲染，完成後顯示重載時間 |
| q / Ctrl-C | 離開 |

畫面是圖片，因此不提供終端的文字選取、可點擊連結或直接在預覽上輸入。
編輯會切到外部編輯器。外部變更按 `r` 重載。
預設前景色讀取終端設定；若無法取得，使用淺色文字；`--light` 強制深色文字。
遇到 Kitty graphics 未回覆的終端會明確報錯，不會退化成 Unicode 公式。
第一版請在終端直接執行；尚未支援 tmux 的圖片透傳。

## 安裝

需要 Node.js 22+。Puppeteer 首次安裝會下載供本機排版使用的 Chromium。

```sh
cd ~/tool/cli/view-latex-md
npm ci
mkdir -p ~/.local/bin
ln -s "$PWD/cli.js" ~/.local/bin/view-latex-md
```

可用 `VISUAL='vim' view-latex-md notes.md` 指定編輯器。
若系統缺少中文字型，安裝 Noto Sans CJK；macOS 預設使用 PingFang TC。

## 匯出與驗證

```sh
view-latex-md test.md --render /tmp/preview.png --width 1000
npm test
python3 terminal.test.py
python3 verification.test.py
VERIFY_RASTER_SCALE=2 python3 verification.test.py
python3 zellij.test.py
```

PNG 保留透明背景，方便在無互動終端的環境檢查排版。
PTY 整合測試會比較縮放／重載後的圖片內容，並檢查連續滾動時的重載、截圖途中跳頁、編輯返回、視窗大小變更與退出。
獨立驗證器會重建每張 Kitty 圖片、解碼首屏與文末的像素，並檢查分段傳輸、快取、錯誤回覆、檔案傳輸回退、編輯器輸入與資源清理。
Zellij 測試會開獨立的暫存 session，檢查 1×／2× 的正向與反向裁切實際送到外層終端的像素，不碰既有 session。

效能量測、重現指令與目前的冷截圖限制見 [PERFORMANCE.md](PERFORMANCE.md)。
