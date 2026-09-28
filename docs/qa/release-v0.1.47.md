# v0.1.47 發布前核對

狀態：2026-09-14 維護者明確授權發布 v0.1.47，優先讓正式 App 使用 Shioaji 1.7.5。
本次指示：「先去把這次發佈沒有完整驗過的issue確認好還開著要把完整要驗的內容補充進去
就先發佈版本吧主要是為了先讓shioaji pro 開始用 1.7.5的shioaji」。
這是本版新的未完成 QA 延後授權，不沿用 v0.1.46 豁免，也不代表下列原生／wire 驗收通過。
未完成 issue 已補上案例與完成條件並保持 OPEN；release PR 最新 head 的 CI、review、
精確 private pin、四平台 release build 與發布產物驗證仍須完成。只由 public main tag 發布。

## 兩個 repo 的版本範圍

- 上一版：public v0.1.46；其 release asset desktop-rev.txt 記錄 private
  `a75104e1ff5cd9b63aece09a326d50ee57b10341`。
- 本輪原先的 private／public pin 基線：`409c0d1901f4bc81b53e6dd405a0f2615bdd5598`。
  private #9／#10 包含圖表指標工具、回測數值基線、1.7.5 bootstrap 與正式 Auto，
  以及 tool permission／內容 approval ID 的修正。private 沒有發版或版本 bump。
- public 已合併：#79 首頁旗標／主題／文件；#81（含 #77）1.7.5、用量監控、
  正式 Harness、圖表指標與 dev identity；#82 設定 UX；#83 重啟前停止 native Agent；
  #84 CI 觸發／取消修正。
- 本次已合併：#108 熱圖冷開／模擬昨餘顯示修正，merge commit
  `2d09d9bccb2f047792814bf8ee09520bbd42f775`，其四項 CI 均 SUCCESS。
- #103 帳務／行情查詢用量及快照一檔已合併，merge commit
  `0e86bd608103748859f0978357d903d83537ff8a`；本 release 分支已 merge 此 main。
  #87、#89–#93、#95–#101、#105 已關閉；#85／#86 的實際 wire、#88／#94 的
  原生異常退出驗收仍開放。#75、#57、#102 保持 OPEN，不列為全面解決。
- #111 子視窗 notification 初始化修正由 private #11／public #112 paired PR 承接，
  private #11 已合併為 `a254e739ddfbf43619c90ca76b2cb0078a14ac7d`。
  public #112 repin 此 merge SHA後，head `24df2a6` 四項 CI 成功，
  已合併為 `1d32c6e80bc751d2a12e33db15a2f32988c72d78`。
  release 分支同步該 main 與精確 pin；剩餘原生驗收依本次授權延後，見下方 OPEN issue 清單。
- RELEASE_NOTES.md 沿用 v0.1.46／v0.1.45 的版本標題、功能段落、驗證範圍與
  結尾風險／下載格式；只寫預計 v0.1.47，不修改 package/Cargo/Tauri 版本。

## 已取得證據

- private #10 真正 desktop-ci：
  [34689974496](https://github.com/Sinotrade/shioaji-pro-app/actions/runs/34689974496) 成功；
  private 先 merge、public repin 與合成 CI、public #81 merge 的順序已完成。
- #103 合併前 head `a5891bc998e13b2e35679e48558bcdac8baf60ca` 的完整 checks 全部 SUCCESS：
  [34807942449](https://github.com/Sinotrade/shioaji-pro-app/actions/runs/34807942449)、
  [34807942195](https://github.com/Sinotrade/shioaji-pro-app/actions/runs/34807942195)、
  [34807942205](https://github.com/Sinotrade/shioaji-pro-app/actions/runs/34807942205)。
  合併完成不等於實際 broker wire 或原生異常退出 gate 完成。
- private #11 真正 desktop-ci
  [34809395865](https://github.com/Sinotrade/shioaji-pro-app/actions/runs/34809395865) SUCCESS。
  public #112 head `2773987a` 的必要 CI、web 與 Linux/Windows 合成
  [34809442757](https://github.com/Sinotrade/shioaji-pro-app/actions/runs/34809442757)
  四項均 SUCCESS。repin 後 `24df2a6` 的必要 CI34810349177、web34810349120
  與Linux/Windows composite34810349122亦全部SUCCESS，才合併public #112。
- 本機 #103 pinned overlay：69 檔／575 tests、tsc -b／Vite build 通過。
  #108 main-based 拆分：58 檔／509 tests、build 通過，另有獨立 source QA。
- macOS arm64 既有原生 dev App／1.7.5 模擬 sidecar：帳戶分頁更新隔離、
  估算持倉隨行情更新、快照第一檔、熱圖兩次冷開、昨餘未知提示、SSE LIVE 與 heartbeat。
  此為先前 dev · 57846951 的歷史證據，不涵蓋其後發現的 #111 啟動錯誤。
- #111 修正後重新建置的原生 dev · 2773987a／1.7.5 模擬 sidecar 為 LIVE；
  首個 3374 熱圖小視窗冷開不需 resize 即正常繪圖、無 fatal。第二次測試因使用者
  操作切換焦點而未完成，後續再次觀察小視窗正常顯示快照一檔；不算第二次受控冷開
  通過，也不宣稱所有子視窗已驗收。
- Claude CLI 已實際修正 QA 發現的資訊回應競爭並補回歸；獨立 code-review agent
  與 QA agent 驗收。Mock、實際 sidecar 唯讀與 native UI 證據分開記錄。

## 授權延後的驗收與 OPEN issues

每張 issue 的「v0.1.47 未完成驗收」均列完整操作／預期與關閉條件。
實際回報、原生程序與乾淨機器證據不能由 schema fixture 或 CI 取代；不為 QA 送真實委託。

| 未完成範圍 | 持續 OPEN 的 issue |
| --- | --- |
| 持倉實際回報、單位、部分成交與 snapshot 邊界 | [#85](https://github.com/Sinotrade/shioaji-pro-app/issues/85)；上游 [#232](https://github.com/Sinotrade/Shioaji/issues/232)、[#233](https://github.com/Sinotrade/Shioaji/issues/233) |
| 委託實際回報、亂序／重複／重連與未知結果 | [#86](https://github.com/Sinotrade/shioaji-pro-app/issues/86) |
| 多視窗帳務共用與異常退出 | [#88](https://github.com/Sinotrade/shioaji-pro-app/issues/88) |
| 行情訂閱 owner、異常退出與孤兒清理 | [#94](https://github.com/Sinotrade/shioaji-pro-app/issues/94) |
| 整體用量對照與 App／SDK 共存長測 | [#75](https://github.com/Sinotrade/shioaji-pro-app/issues/75)、[#57](https://github.com/Sinotrade/shioaji-pro-app/issues/57) |
| 保護單另案：實作未納入本版，既有查詢保留 | [#102](https://github.com/Sinotrade/shioaji-pro-app/issues/102) |
| notification 子視窗修正後完整原生矩陣 | [#111](https://github.com/Sinotrade/shioaji-pro-app/issues/111) |
| 正式三 provider、confirm／明確選擇 Auto 的授權與撤權 | [#47](https://github.com/Sinotrade/shioaji-pro-app/issues/47)、[#51](https://github.com/Sinotrade/shioaji-pro-app/issues/51) |
| 乾淨機器與 provider onboarding／復原 | [#68](https://github.com/Sinotrade/shioaji-pro-app/issues/68)、[#56](https://github.com/Sinotrade/shioaji-pro-app/issues/56)、[#69](https://github.com/Sinotrade/shioaji-pro-app/issues/69)、[#70](https://github.com/Sinotrade/shioaji-pro-app/issues/70) |
| 四平台原生 bootstrap／approval／Dashboard／Debug、安裝與更新 | [#113](https://github.com/Sinotrade/shioaji-pro-app/issues/113) |

證據至少包括 OS／架構、public commit、private 完整 SHA、sidecar／provider runtime 版本、
安裝來源、操作／預期／實際及未驗範圍；公開附件去識別。成功派送使用隔離 broker fixture，
實際成交格式來自既有授權回報，不以真實下單製造測試資料。發布後仍維持上述 issue 開啟。

## 仍須完成的發布檢查

1. release PR 的最新 head 經獨立 review，必要 CI、web、Linux/Windows 合成全部 SUCCESS；
   不忽略失敗、取消或 pending。以 merge commit 合入 main，不修改版本檔。
2. public main 的 `DESKTOP_MODULES_REF` 為 `a254e739ddfbf43619c90ca76b2cb0078a14ac7d`，
   與 private main 相同；其真正 desktop-ci 已通過。tag 前再次核對。
3. public main 的 v0.1.47 tag 觸發四平台 build／簽章／上傳，全部成功後 workflow 才發布。
4. 發布後依 docs/RELEASE.md 驗證正式標題、非 Draft、18 個 assets、11 個 latest.json
   平台 key、URL／簽章與 desktop-rev.txt；實際結果寫回 release PR。此文件記錄發布決策，
   不預先宣稱 tag workflow 或產物驗證已通過。
