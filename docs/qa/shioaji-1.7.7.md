# Shioaji 1.7.7 sidecar 升級驗收（2026-09-29）

範圍：`chore/shioaji-1.7.7`，只測 macOS arm64 的 1.7.7 **模擬** sidecar。
隔離 sidecar 使用 21396；Vite App 使用 5190，同源 `/api` 與 SSE proxy 指向 21396。
未使用 21322、8080、21399、21398；未送出正式委託。

- `/api/v1/info`：`version=1.7.7`、`simulation=true`。1.7.7 `/openapi.json` 的
  `TradeCacheHealth` 仍有 `state` 和 `reasons[]`；`NotSubscribed` 是 `reasons[].reason` 的值。
- 首次 App 載入前，兩個已簽署帳戶的 health 均含 `NotSubscribed`。Playwright
  觀察到各帳戶一次 health 與一次 `subscribe_trade`，App 顯示 LIVE。
- 精確停止並以同一組 key 重啟 21396 sidecar；server 記錄顯示 cached token 有效並重用。
  重啟後兩帳戶 health 為 `Unknown/NoBaseline`，沒有 `NotSubscribed`。App 載入及重新整理
  共送出 4 次 health、0 次 `subscribe_trade`、2 條 SSE 連線，畫面顯示 LIVE。
- 模擬 TXF（實際合約代碼由 TXFR1 解析）買進 1 口、LMT／ROD，當時買價 48117，
  測試限價 47617。App 收到一筆 `FuturesOrder/New` `order_event`；取消該筆後收到
  一筆 `FuturesOrder/Cancel`，`refresh:false` 快取最終狀態為 `Cancelled`。
  沒有保留本次測試的在途委託。
- `tsc -b`、`vitest run`（`TZ=UTC` 與 `TZ=Asia/Taipei`，各 932 passed／2 skipped）、
  `vite build` 通過。build 有既有的 BigInt 目標與 chunk 大小警告。

證據界線：這是模擬環境的瀏覽器 App、HTTP 與 SSE 驗證；未涵蓋正式環境或原生桌面視窗。
未把 1.7.6 的歷史 fixture 與實測紀錄改稱為 1.7.7。
