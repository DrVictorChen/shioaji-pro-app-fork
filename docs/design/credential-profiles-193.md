# 桌面多帳號與系統憑證庫前端整合（desktop #193）

日期：2026-10-20。分支 `feat/193-os-credential-store`。
對應私有 desktop 同名分支；本次不改 `DESKTOP_MODULES_REF`、不 push、不開 PR。

## 前端資料與指令契約

`DesktopSettings` 是非秘密 read model：`profiles`、`activeProfileId`、`configured`、
`credentialRevision`、backend／遷移診斷，以及非秘密偏好。
`production`、`caPath`、`hasCaPassword` 由 active profile 衍生，方便沿用啟動與診斷流程。
read model 沒有 `apiKey`、`secretKey`、`caPassword` 或 `caPasswd`。

profile 與行動版共用 `id`（UUID）、`name`、`environment`（simulation／production）、
`createdAt`、`hasCA`。桌面另有非秘密 `caPath`、`apiKeyMasked`、`secretState`、backend 與 revision。
環境在各組編輯，不再另存全域 production。桌面沒有生物辨識設定。

`CredentialDraft` 僅是 write-only 提交資料；已存秘密不預填。表單提交時清空輸入與舊 draft
物件，bridge 在 native 回覆後也移除 payload 中的三個秘密欄位，再進行 server restart／health wait。
更新時秘密欄位省略表示保留；清除 CA 路徑會一併清除 CA 密碼。

| 前端 API | native 指令 |
| --- | --- |
| `loadDesktopSettings` | `credentials_status` |
| `saveDesktopSettings`（只接受偏好） | `credentials_preferences` |
| `saveCredentialProfile` | `credentials_save` |
| `selectCredentialProfile` | `credentials_select` |
| `deleteCredentialProfile` | `credentials_delete` |
| `logoutCredentialProfile` | `credentials_logout` |
| `.env` picker／candidate | `credentials_import_env` |

所有 native 憑證指令只允許 main window；前端也在 IPC 前拒絕子視窗。
`settings.json` 不再由此 bridge 透過 plugin-store 讀寫。
boot／gate 共用一個 in-flight status read；舊 read 或較早的設定回覆不能覆蓋較新的登出狀態。
子視窗仍只接收 `cacheDesktopConfigured` 的布林值。

## 互動決策

- 首次設定與伺服器完整設定共用 `CredentialProfiles`。列表顯示名稱、末四碼遮罩、
  模擬／正式、CA、秘密儲存狀態；圖示為 lucide。
- 新增、切換、刪除均須二次確認；可在同一組編輯環境。
  新增第一組會成為 active，已有帳號時新增不會靜默改變目前環境。
- `.env` 匯入先確認，再選檔或資料夾；有多檔時選候選檔。
  Rust 解析 API keys 與 CA 欄位並立即存成新帳號，前端只接收 profile 索引。
  UI 明確說明匯入會立即保存，不再聲稱取消編輯能撤銷已完成的匯入。
- 「僅儲存」不重啟伺服器；「儲存並啟動／重啟」明確選擇該組並依既有流程停止 Agent／server。
  操作期間鎖定表單、列表、關閉與對話框的其他動作。
- 切換先停止目前 App 管理的 server／Agent，再選擇 profile；按啟動才以新帳號連線。
  刪除 active 也先停 server；stop 失敗不呼叫 native delete。
- 登出先停止 server／Agent，再由一個 native 指令刪除 active 的整筆秘密（含 CA 密碼），
  清空 active 並重新載入首次設定。其他帳號保留，需明確重新選擇。
- 失敗遷移會顯示「明文設定已保留」，阻止憑證修改；Linux fallback 顯示明文路徑與 0600 警告。

## Spawn 與 native 儲存

前端 `serverStart`／`spawn_server` payload 不再攜帶任何券商秘密或 SJ_CA_PATH。
Rust 用 active UUID 讀憑證並決定環境，拒絕 renderer 提供這些 env 或替代 CLI 參數。
`spawn_server` 回覆實際 `{pid, credentialRevision}`；前端記錄此 revision。
啟動時與 boot 重新領養現有 server 時都比對 revision，避免使用舊 key 的程序被重新接上。
缺少舊 record 仍採單向相容判斷，避免 restart loop；外部 server 仍保留既有帳號辨識與所有權保護。

native service 是 `<app identifier>.credentials`，account 是純 UUID，值為
`{"apiKey":"…","secretKey":"…","caPassword":"…"}`。不同 QA／dev identifier 自然隔離。
settings 只保存非秘密索引。新增／遷移先寫 pending journal，秘密寫入讀回一致後才完成；
舊明文確認安全保存後才刪除。刪除先寫 pendingDelete，確認 NoEntry 後才移除索引，失敗可重試。
macOS／Windows 不退回檔案；Linux 缺 Secret Service 時新 profile 可退回獨立 0600 檔案。
已存在的 system／fallback profile 維持原 backend，避免雙份秘密或靜默降級。

## 修改檔案

新增：

- `src/lib/desktop-credentials.ts`
- `src/components/credential-profiles.tsx`
- `docs/design/credential-profiles-193.md`

產品程式與說明：

- `src/app-gate.tsx`
- `src/components/child-setup-notice.tsx`
- `src/components/onboarding-setup.tsx`
- `src/components/server-manager.tsx`
- `src/components/server-settings-dialog.tsx`
- `src/lib/boot.ts`
- `src/lib/desktop-setup-state.ts`
- `src/lib/server-diagnostics.ts`
- `src/lib/sidecar-ownership.ts`
- `src/lib/spawn-keys.ts`
- `src/lib/tauri.ts`
- `src/lib/window-role.ts`

測試：

- `src/app-gate.test.tsx`
- `src/components/onboarding-setup.test.tsx`
- `src/components/server-manager.test.tsx`
- `src/lib/boot-early-stream.test.ts`
- `src/lib/harness-failure-watch.test.ts`
- `src/lib/sidecar-ownership.test.ts`
- `src/lib/spawn-keys.test.ts`
- `src/lib/tauri-env-import.test.ts`
- `src/lib/tauri-settings-access.test.ts`
- `src/lib/tauri-start-path.test.ts`

私有側：`src-tauri/Cargo.toml`、`Cargo.lock`、`src/credentials.rs`、`src/lib.rs`、
`src/webview_capabilities.rs`、`docs/design/credential-store-193.md`。

## 驗證與限制

- 疊合 private modules，`pnpm tsc -b` 通過；完整 vitest 最後一輪
  Asia/Taipei 326 檔／5778 tests 通過。UTC 完整一輪 5777 tests 通過，
  後續新增的 boot revision 回歸亦納入最終 targeted 檢查。
- `pnpm vite build` 通過；只有既有 dynamic-import 分包提醒。
- native `cargo test --lib` 547 passed／14 ignored、clippy `-D warnings`、fmt check 通過。
  原有 ps bearer 測試需 sandbox 外執行，實際檢查的是測試自行建立的假程序。
- macOS 專用假資料 Keychain smoke 通過：不帶 `-w` 查詢確認存在，刪除後確認不存在，
  最後清除測試項目。只操作專用測試 service 與新 UUID。
- Chrome 的隔離假資料設定頁確認列表、切換二次確認、環境／CA 與版面；
  臨時 Vite 24193、分頁與 fixture 已清理。
- 沒有讀使用者 `.env`、既有 Keychain，沒有啟停 Shioaji server／使用者 App，
  沒有存取 21322／8080；測試中的相關數字都是 mock。
- 未在 Windows／Linux 實機驗證，也沒有啟動原生 App 做券商登入或 SSE QA；
  本次 browser fixture／Keychain smoke 的驗證範圍不包含實際交易登入。
- CA 原檔不會被刪除；只清除已存秘密與索引。歷史備份與 JavaScript GC 記憶體殘留無法保證清除。
  sidecar 仍以 env 接收秘密；降版需重新輸入 key。此版未提供不保存的單次輸入模式，
  fallback 不會自動搬回 Secret Service；初始化失敗需重啟 native App 才重新初始化連線。

合併與發佈前仍須依兩邊 DEV／RELEASE 規範完成 paired review／合成 CI，再處理 pin；
這次只提供兩邊各自的本機 commit。
