# 熱圖冷開與模擬昨餘顯示 QA

## 範圍

本次從 #103 拆出不依賴委託／成交回報投影的 #106／#107 顯示修正。
public 基準 `95bff4a1135f7ab134de898aed3243b6ebb9485d`；private pin 維持
`409c0d1901f4bc81b53e6dd405a0f2615bdd5598`，無 private 變更。

- #106：熱圖容器與 canvas 由 flex 分配高度，修正小視窗冷開留白；未新增
  timer、行情查詢或資料重繪機制。
- #107：1.7.5 模擬 sidecar 在 Common／Share 的唯讀比較中，quantity 隨單位
  改變但 yd_quantity 不變。上游追蹤 [Shioaji#233](https://github.com/Sinotrade/Shioaji/issues/233)。
  App 保留 SDK 原值，對已確認的版本／模式顯示「待確認」與原因，不猜倍率。
  尚無 server info 時亦明示未知；正式模式與其他版本沿用原顯示。
- 只觀測既有 fetchInfo 回應；以 API base 及請求序號隔離晚到成功／失敗。
  不增加輪詢，不修改帳務、委託、保護單或安全檢查。

## 驗證

- 2026-09-14 macOS arm64 原生 dev App／1.7.5 模擬 sidecar：同一份 CSS
  連續兩次冷開熱圖小視窗，無需縮放或 resize 即繪製；昨餘提示原生畫面通過。
  原生整合畫面使用 #103 候選 `57846951`，主視窗／Debug／伺服器面板 identity
  一致、SSE LIVE 與新 heartbeat 通過。拆分分支沒有切走使用者試用的完整候選版。
- 拆分分支重新疊入同一 private pin：58 個測試檔／509 tests 全數通過；
  tsc -b 與 Vite build 通過。原有 ineffective dynamic import 警告仍存在。
- Claude CLI 修正資訊回應競爭並補測試；獨立 source review 已核對完整候選的
  顯示修正，拆分後另做獨立 QA。回歸涵蓋同 base 舊回應、跨 server、503 原錯誤
  傳遞與版本／模式限制，沒有網路或下單。
- 必要 CI、web-build、Linux／Windows composite 以 PR 最終 head 的完整
  rollup 驗收，結果回填 PR，不能沿用 #103 的 CI 當作拆分分支 CI。

## 限制

原生證據為既有 macOS 模擬環境，不代表其他平台、全新登入或乾淨機器已驗收。
此 PR 不修改 broker callback wire，#103 的實際回報 gate 仍獨立追蹤。
#107 上游單位定義未修正，App 只是避免顯示誤導數字；升級 sidecar 時應重新驗證。
未使用正式下單、未打 tag、未發布。
