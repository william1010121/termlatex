# 效能驗證（2026-10-07）

測試機為 Apple M4、macOS，內建螢幕 60 Hz。下列 PTY 數字量的是程式送出 Kitty placement 指令的時間，並非螢幕實際呈現的 FPS。400 段含中文與行內公式的 Markdown，模擬 40 Hz 滾輪輸入；小畫面 900×580、大畫面 2400×1700 個實際像素。比較使用各版本預設設定：舊版在終端像素上再做 2× supersampling，新版直接使用終端回報的實際像素，文字大小與排版不變。

| 情境 | 優化前 | 優化後 |
| --- | --- | --- |
| 小畫面跨區段的相鄰 placement 間隔 | 23–33 ms | 15–18 ms |
| 大畫面跨區段的相鄰 placement 間隔 | 39–55 ms | 15–18 ms |
| 連按 6 次放大，完成最終更新 | 1.89–2.09 秒、6 次重繪 | 約 0.12–0.21 秒、1 次重繪 |
| 一般快取捲動 | 約 16 ms | 約 16 ms；改善集中在跨區段 |
| 未改內容的 reload | — | 約 13–22 ms，沒有重新傳 PNG |
| 已快取的文末跳轉 | — | 小於 1 ms 送出指令 |

數字是多次開發量測的觀察範圍，並非延遲上限。背景工作會影響 Chromium 截圖與排版時間。完全沒快取的文末跳轉仍需新截圖，在大畫面約 80–145 ms；這是目前主要的冷路徑成本。

## 已採用的改動

- 終端幾何已是實際像素，預設不再額外放大 2×，截圖／解碼像素數降到原本四分之一。`--raster-scale 2` 保留額外抗鋸齒選項。
- 下一區段在背景截圖並上傳。捲動命中快取只更新裁切座標；短文件所有位置共用一張圖片。
- MathJax 共用 SVG 字形定義；純公式在同一文件內去重；500 個重複公式的 TeX 轉換從 321–377 ms 降到約 3 ms。整份已排好的 HTML 供 zoom／resize 重用。含定義、顏色、引用或未知指令時停用公式去重，保留 TeX 執行順序。
- zoom／resize 合併連續請求；reload 仍每次讀磁碟，內容未變時保留圖片。本地圖片會重讀，即使修改時間未變。
- PNG 使用無損快速編碼。Chromium 使用 `--disable-gpu-rasterization` 避免相同 SVG 偶發缺字／像素變化，保留 GPU compositor；對照截圖速度沒有顯著退步。
- 圖片指令排成單一傳輸佇列，4096-byte APC 合併成約 64 KiB 寫入，尊重背壓。可用時以私有本機檔案傳 PNG，收到 ACK 才刪除，失敗退回直接傳輸。
- 實際 cmux ACK 測試中，337 KB PNG 的直接傳輸約 3.78 ms、本機檔案約 2.93 ms（含建立檔案）；這量的是終端接收與解碼回覆，仍不是 GPU 呈現時間。
- 終端與 Chromium 同時啟動，查詢收到完整回覆立即繼續；help 不載入排版器。

## 重現

```sh
python3 benchmark.py direct small
python3 benchmark.py direct large
python3 benchmark.py file large
npm test
python3 terminal.test.py
python3 verification.test.py
VERIFY_RASTER_SCALE=2 python3 verification.test.py
```

`benchmark.py` 只用 Python 標準函式庫，在獨立 PTY 和暫存文件中測試，不碰目前終端內容。`direct` 明確拒絕本機檔案探測；`file` 模擬成功 ACK。此基準不模擬終端解碼與顯示成本，因此不能拿模擬 ACK 比較兩種傳輸的實際解碼速度。

獨立驗證包括完整 PNG 重建、裁切／首屏／文末像素、分段指令不能交錯、快取／預載不驅逐目前圖片、錯誤後重傳、檔案傳輸回退與清理、連續捲動中的 reload／zoom／edit／resize／quit。重複 zoom 與極寬公式的全新排版另做嚴格 PNG 位元組相等驗證，避免效能改動掩蓋公式畫錯。

## 尚未採用的候選

目前螢幕 60 Hz，增加輸出頻率主要會增加指令與終端工作。更小的圖片區段會增加截圖次數；預先截取文末會佔掉一般捲動快取。這些改動對現有量測沒有足夠收益，暫不加入。若還要明顯降低完全冷的跳頁延遲，下一步應量 Chromium 的截圖成本與替代光柵化器，而非繼續調捲動 easing。
