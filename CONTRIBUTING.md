# 貢獻指南 / Contributing

歡迎提交 issue 與 PR！提交 PR 即表示你同意以 AGPL-3.0 授權你的貢獻，
並同意維護者可將其納入雙授權（dual-licensed）發行版本（見 [README](README.md#license)）。

開發環境、commit 慣例與品質基線請見 [docs/DEV.md](docs/DEV.md)。

## 外部 fork PR 的 CI 流程

本 repo 的桌面版（Tauri、AI Agent 等）需要疊入**私有模組**才能完整 build，
CI 以唯讀 deploy key 拉取。GitHub 不會把 secrets 提供給 fork PR，
而且把私有金鑰交給未經審查的程式碼並不安全，所以 fork PR 的 CI 分兩段：

| 檢查 | fork PR 何時執行 | 是否 merge 必要 |
| --- | --- | --- |
| `CI / checks`（tsc＋vitest＋vite build） | 自動（首次貢獻者需維護者按一次 Approve and run） | **是** |
| `web-build`（不含私有模組的開源 build） | 自動 | 否 |
| `desktop-agent-ci / combined-agent` | 顯示 **skipped**（不是失敗），summary 會說明原因 | 否 |
| `desktop-agent-ci-fork`＋status `desktop-agent-ci (maintainer-approved)` | 維護者 review 後加上 `run-desktop-ci` label 才執行 | 否（維護者判斷） |

1. 你開 PR 後，公開檢查會照常跑；請先讓 `CI / checks` 綠燈。
2. 維護者**逐行 review** 你的變更後，加上 `run-desktop-ci` label，
   對「加 label 當下的 commit」跑完整 desktop CI（Linux／Windows），
   結果會出現在 PR 的 checks。
3. 之後你每 push 一次新 commit，label 都會**自動移除**，需要維護者重新
   review 再加一次。這是刻意的：避免 review 後被換成未審查的程式碼。

你不需要、也不會拿到私有模組的存取權；純前端／web 的修改在本機
`pnpm build && pnpm test` 即可完整驗證。

### 給維護者：加 label 前務必確認

`run-desktop-ci` 會讓 PR 的程式碼（`package.json` scripts、依賴、測試、
`build.rs` 等）在**私有模組已在磁碟上、deploy key 仍在 runner 記憶體中**的
環境執行。惡意 PR 有能力外流私有原始碼或 deploy key，這是「用私有模組測
外部程式碼」本質上無法消除的風險。所以：

- 加 label 前完整 review diff，特別注意 `package.json`／`pnpm-lock.yaml`、
  新依賴、`build.rs`、測試檔、任何網路存取與 `.github/` 變更。
- label 只代表核准**當下那個 commit**；新 push 會自動撤銷。
- 若曾對可疑 PR 加過 label，請輪換 `AGENT_SSH_KEY` deploy key。

已做的防護：workflow／overlay action／私有 SHA pin 一律取自 `main`（PR 改不到）；
checkout 不保留 credentials；SSH key 只存在 overlay 那一個 step；build job 的
`GITHUB_TOKEN` 只有 `contents: read`；untrusted 模式不使用 pnpm cache，
降低在 `main` scope 寫入被污染 cache 的機會（無法完全排除，因 runner 上的程式
理論上可取得 cache token；`release.yml` 會讀 main 的 cache）。

---

## English summary

- Fork PRs run the public checks automatically: `CI / checks` (the only required
  check) and `web-build`.
- The private desktop CI (`combined-agent`) is **skipped** on fork PRs because it
  needs a read-only deploy key for the private desktop modules. A job summary
  explains this.
- After reviewing the code, a maintainer adds the **`run-desktop-ci`** label. A
  `pull_request_target` workflow then builds the exact head SHA present at label
  time with the private overlay and reports the commit status
  `desktop-agent-ci (maintainer-approved)`.
- Any new push removes the label automatically; re-review and re-label to run again.
- Residual risk (maintainers): the PR's code runs with the private modules on disk
  and the deploy key in runner memory, so a malicious PR could exfiltrate them.
  Review before labeling; rotate the deploy key if a suspicious PR was ever labeled.
