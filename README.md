# view-latex-md

在 cmux、Ghostty 或 Kitty 裡閱讀 Markdown 和 LaTeX 的獨立命令列工具。
Markdown 與數學先在本機一起排版，再用 Kitty graphics protocol 顯示透明圖片，
中文和行內公式使用同一套排版，不受終端固定字格的基線限制。

```sh
view-latex-md test.md
view-latex-md notes.md --font-size 20
```

支援標題、清單、表格、引用、連結文字、程式碼區塊、本地圖片，以及
`$...$`、`$$...$$`、`\(...\)`、`\[...\]` 數學。數學使用 KaTeX 支援的 LaTeX 子集，
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
```

PNG 保留透明背景，方便在無互動終端的環境檢查排版。
PTY 整合測試會比較縮放／重載後的圖片內容，並檢查捲動、編輯返回、視窗大小變更與退出。
