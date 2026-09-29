# ADR 0006 — 多視窗共用一條行情 SSE

日期：2026-09-29  
狀態：已採用（#180）

## 背景

每個主視窗與 popout 都建立 `EventSource`。HTTP/1.1 對同一 host 的連線數有限；六條長連線足以讓下單及查詢請求在瀏覽器排隊。

## 決策

- 以 Web Locks 為同一 origin、API base、串流 base 的唯一 SSE 所有權仲裁；以 BroadcastChannel 轉送原始事件名稱與 JSON 字串，既有行情資料格式及本地 store 不變。主視窗出現時要求 popout owner 讓位；owner 離開後，其他 popout 在數秒內取得鎖並重新連線。Chrome 與 WebView2 都支援這兩個瀏覽器 API，因此桌面版也採用同一機制，不另維護 Tauri event 路徑。
- owner 一律監聽聚合 SSE 的特殊事件名稱，使只有 follower 使用的面板也能收到事件。一般報價由新 owner 接手維護跨視窗訂閱；每個 popout 自己的 capability 訂閱在重新連線與維護訊號後重播。
- 下單與成交回報仍交給每個視窗現有的 `event_id` ledger 去重。切換 owner 時不以「新 SSE」當成新回報；相同 `event_id` 不會再次套用。
- 主視窗提供帳務狀態的定期快照。主視窗離開後，popout 在 2.5 秒內停止使用過期帳務狀態送單；行情 owner 可繼續移交，交易狀態則須等主視窗恢復。
- 瀏覽器若缺少 BroadcastChannel 或 Web Locks，停止建立 SSE 並顯示連線中斷，避免退回每視窗一條長連線。
- Web 與 Tauri HTTP plugin 的送單及刪單 fetch 在三秒時 Abort。若請求已到達 sidecar，Abort 無法證明券商沒有接單，因此結果標為未知並提示先查委託，絕不自動重送。

## 限制

- 私有桌面模組啟用 Agent Harness 時，送單經由 native `agent_harness_post`；Tauri `invoke` 沒有可取消訊號。此倉庫無法保證該路徑在三秒內中止，需由私有桌面模組另行提供 native 取消或送出前期限檢查。
- 若主視窗關閉，popout 的行情與訂閱會移交，但主視窗負責的帳務投影不在 popout 重建；popout 下單會停用，直到主視窗重新提供快照。
