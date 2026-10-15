# 圖表信用下單測試偶發失敗調查（2026-10-15）

## 結論：測試問題

`src/components/candle-chart-order.test.tsx` 的 `post-confirmation re-check`
用 `m.notify.mock.calls.at(-1)` 讀取全域最後一則通知，誤把「圖表拒單後不會有其他通知」
當成下單契約。委託回報訂閱是獨立的非同步工作，可能在圖表拒單之後通知失敗。

事件順序與證據：

1. `candle-chart.tsx` 的 `sendPointOrder` 將 `prepareCreditOrder` 的
   `afterConfirm` 傳給 `placeQuickOrder`；確認後查到融資單位為 0 會拋錯。
2. 同函式的 catch 呼叫 `reportOrderError('圖表下單', ...)`，送出
   `圖表下單失敗`／`不能融資買進`。拒絕發生在 `beforeSend` 及真正送單之前。
3. `src/lib/boot.ts` 的 `subscribeTradeReports` catch 可獨立呼叫
   `notify({ title: '委託回報訂閱失敗', ... })`。
4. `src/lib/trade.ts` 的 `notify` 逐則通知 listener，`logNotice` 追加紀錄；
   `src/components/event-toasts.tsx` 的 `push` 追加 toast。兩則通知不會互相覆寫。
   測試的「最後一則」才會改變。

沒有修改產品程式。回歸測試明確重播無關通知先到／後到兩種順序，精確比對
所有「圖表下單」通知只有一則正確拒單通知；另外驗證信用查詢共兩次、
`placeQuickOrder` 呼叫一次，且模擬的真正送出階段完全沒有執行。
未加入 retry、ignore 或放寬拒單行為。

## 驗證

環境：macOS arm64；pnpm／Vitest 4.1.10，使用本工作樹及私有 modules 合成。

| 情境 | 結果 |
| --- | --- |
| 未修改的目標測試，50 次獨立 Vitest 執行，maxWorkers 前 25 次為 1、後 25 次為 8，另加 8 個 CPU worker | 50 過、0 失敗；自然失敗未在本機重現 |
| 在舊斷言前重播晚到的訂閱失敗通知 | 1 失敗／1 次，實得 title 與 CI 相同 |
| 修正後相同 50 次執行與負載，每次包含通知先到／後到兩個案例 | 100 案例通過、0 失敗 |
| `pnpm vitest run`（合成 modules） | 325 檔案、5,769 測試通過 |
| `pnpm exec tsc -b` | 通過 |
| `pnpm build` | 通過（含私有 modules 合成） |

重複執行的單次命令：

```sh
pnpm vitest run src/components/candle-chart-order.test.tsx \
  -t 'post-confirmation re-check' --maxWorkers=1
# 後半輪改用 --maxWorkers=8；每次都是新的程序，不對失敗補跑。
```

本機原始紀錄：`/tmp/flaky-before-vitest/`、`/tmp/flaky-after-vitest/`、
`/tmp/flaky-vitest-replay-before.log`、`/tmp/flaky-vitest-full.log`、`/tmp/flaky-tsc.log`。
受控重播與自然重現分開記錄；此結果不等於 Windows 原生 QA 或真實券商下單驗證。
