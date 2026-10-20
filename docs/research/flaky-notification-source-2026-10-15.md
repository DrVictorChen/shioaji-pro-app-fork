# 全域通知插隊的共同來源調查（2026-10-15）

## 結論：測試隔離問題

PR #320 的 checks job 使用公開 modules stub。本機則有私有 modules overlay。
本次沒有修改產品程式、`DESKTOP_MODULES_REF`、私有 modules 或既有 commit。

`odd-spread` 的 mount／import 本身沒有發起回報訂閱。真正來源是**先前測試的未知下單結果**：

1. `src/components/odd-spread.tsx` 的點價 catch 在結果未確認時呼叫
   `reconcileAfterUnknownOutcome()`。`candle-chart` 的未知結果則透過
   `reportOrderError()` 進入相同路徑。
2. `src/lib/order-outcome.ts` 非同步 `import('./trading-state')`，呼叫
   `reconcileOrdersOnce()`，沒有回傳讓元件等待的 Promise。
3. `src/lib/trading-state.ts` 的 `refreshTradingState('orders')` 按照
   subscribe-before-snapshot 規則先呼叫 `boot.subscribeTradeReports()`。
4. `src/lib/boot.ts` 在 try 區塊內呼叫 `loadAccountsShared()`。
   元件測試只 mock 了 `ensureAccounts`／`useAccounts`，沒有 mock
   `loadAccountsShared`；同時也沒有隔離背景對帳服務。
5. Vitest 丟出以下錯誤，被 boot 的 catch 當成訂閱失敗通知：

   ```text
   [vitest] No "loadAccountsShared" export is defined on the "../lib/account-store" mock.
   ```

6. 動態 import 可能到後續案例才完成；`vi.clearAllMocks()` 不會取消已開始的
   Promise。晚到通知因此覆蓋測試所讀的「最後一則」，不是產品把操作通知刪掉。

以暫時的 caller/error 探針與公開 stub 重播，取得完整呼叫鏈：

```text
order-outcome.ts → reconcileOrdersOnce
→ refreshTradingState → timedRead('subscribe')
→ boot.subscribeTradeReports → 缺少 loadAccountsShared mock
```

最小案例讓一次點價回傳「連線逾時」，等待實際動態 import 與對帳完成後讀最後通知：
預期「點價委託結果未確認」，實得「委託回報訂閱失敗」，1 次執行即失敗。
紀錄：`/tmp/flaky-report-source.log`。

本機私有 overlay 的相同動態 import 還可能先遇到 `customs is not iterable`：
測試的 localStorage mock 對所有 key 都回傳費用物件，私有模組匯入指標程式時
需要的是陣列。這會提早截斷對帳，掩蓋公開 checks job 的缺少 export 錯誤。
紀錄：`/tmp/flaky-report-import.log`。

產品的未知結果自動對帳與對帳前訂閱符合 ADR 0002／0003；這次失敗來自測試提供的
不完整模組介面，沒有發現元件 mount 就多發訂閱失敗通知的產品問題。

## 修正

- 共用 `src/test/mock-order-reconciliation.ts`，由十個隔離元件測試明確匯入，
  mock `trading-state.reconcileOrdersOnce`，保留實際的錯誤分類、通知與動態 import
  路徑。每個案例結束時用 `vi.dynamicImportSettled()` 排空匯入，避免跨案例工作。
  不在全域 Vitest 設定 mock boot，底層訂閱／對帳測試繼續測真正實作。
- 在既有 odd-spread 未知結果案例等待上述動態 import，驗證只要求一次對帳，
  且只有該操作的通知。反向把共用 mock 換回真實模組時，此案例失敗；恢復後通過。
  紀錄：`/tmp/flaky-source-mutation.log`。
- 全 repo 搜尋 `notify.mock.calls.at(-1)`、`toHaveBeenLastCalledWith`、
  `lastNotice()`、依呼叫位置取通知及通知陣列 `at(-1)`，統一改為
  `operationNotice` 依操作標題選取；同案例重複操作用各次開始的 call offset。
  helper 要求**恰好一則**匹配通知，保留原有 kind／title／body／送單次數斷言。
  另測無關通知先到／後到、缺失、重複及重複操作，缺失或重複都必須失敗。
- odd-spread 的環境切換案例重播無關通知先到／後到，兩種順序均精確驗證拒單。
  candle-chart-order 上一輪的同型回歸保留兩種順序，改用共用 helper 簡化選取。
- 沒有加入 retry、skip 或放寬下單行為；沒有對產品通知做過濾或靜音。

## 驗證方式

本機 macOS arm64、12 個可用 CPU；Vitest 4.1.10。
公開設定只用暫存的 `vitest.flaky-public.config.ts` 將 `@modules` alias 指到
`src/modules-stub/index.ts`，不移動 modules symlink、不改 pin；驗證後移除暫存設定。

負載驗證由四個額外 CPU worker 持續運算，另外兩條 lane 同時執行測試，
每條 lane 的 Vitest `maxWorkers=4`。每輪是獨立的新程序，失敗會記錄，不補跑。
測試編排使用 Node.js，沒有執行 Python，也沒有使用 pkill／killall。

負載驗證共 **150 個獨立 Vitest 程序、42,750 個案例執行，0 失敗**。
16 個檔案在公開 stub／私有 overlay 各 50 輪（每個案例合計 100 次）；
擴大搜尋補出的 trade-exit 另在同一負載期間交替兩種設定各 25 輪，合計 50 次。
主負載區間：2026-10-15 21:33:25–21:37:02（Asia/Taipei）。
odd-spread 環境切換與 candle 信用重查各有先／後兩種插隊順序，分別執行 200 個案例。

| 測試檔（src/ 下） | 每輪案例 | 獨立執行次數 | 失敗 |
| --- | ---: | ---: | ---: |
| `components/bottom-dock-positions-account.test.tsx` | 11 | 100 | 0 |
| `components/candle-chart-order.test.tsx` | 125 | 100 | 0 |
| `components/combo-ticket-risk.test.tsx` | 11 | 100 | 0 |
| `components/flash-order-account.test.tsx` | 3 | 100 | 0 |
| `components/flash-order-credit.test.tsx` | 28 | 100 | 0 |
| `components/flash-order-odd.test.tsx` | 8 | 100 | 0 |
| `components/flash-order-ordertype.test.tsx` | 10 | 100 | 0 |
| `components/flash-order-qty-memory.test.tsx` | 16 | 100 | 0 |
| `components/flash-order-trigger.test.tsx` | 22 | 100 | 0 |
| `components/grid-ticket-account.test.tsx` | 11 | 100 | 0 |
| `components/grid-ticket-odd.test.tsx` | 23 | 100 | 0 |
| `components/odd-spread.test.tsx` | 52 | 100 | 0 |
| `lib/execution/pending-confirm.test.ts` | 24 | 100 | 0 |
| `lib/odd-spread-service.test.ts` | 35 | 100 | 0 |
| `lib/trade-exit.test.ts` | 27 | 50 | 0 |
| `lib/trigger-restore.test.ts` | 31 | 100 | 0 |
| `test/operation-notice.test.ts` | 4 | 100 | 0 |

| 最終檢查 | 結果 |
| --- | --- |
| `pnpm vitest run`（私有 overlay） | 326 檔、5,774 測試通過 |
| 公開 stub 全套 Vitest | 326 檔、5,774 測試通過 |
| `pnpm exec tsc -b` | 通過 |
| `pnpm build`（含 tsc -b） | 通過 |
| `git diff --check` | 通過 |

原始 JSON／逐輪日誌：`/tmp/flaky-source-stress/`；編排程式：
`/tmp/flaky-source-stress.mjs`、`/tmp/flaky-trade-exit-stress.mjs`。
每輪命令為 `pnpm vitest run <表中指定測試檔> --maxWorkers=4 --reporter=json --outputFile=<逐輪 JSON>`，
公開 lane 另加 `--config vitest.flaky-public.config.ts`；trade-exit 使用 `--maxWorkers=1`。

全套與型別／build 日誌：`/tmp/flaky-full-overlay-final.log`、
`/tmp/flaky-full-public-final.log`、`/tmp/flaky-tsc-final.log`、`/tmp/flaky-build-final.log`。
本次為測試與調查文件變更，證據範圍是本機測試／編譯，未宣稱遠端 CI、原生 App 或券商 QA。
所有額外 CPU worker 已由建立它們的編排程式結束，沒有停止使用者程序。
