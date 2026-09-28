# 1.7.5 / production Agent Harness candidate QA

Status: on 2026-09-14 the maintainer explicitly authorized v0.1.47 publication
with unfinished native/wire QA deferred into OPEN issues. This is fresh, version-specific
authorization, not a claim that QA passed. No v0.1.46 onboarding waiver applies. The maintainer explicitly chose production Auto;
issue #51's original production-Auto prohibition is superseded by that decision.

## Integration status (2026-09-14)

- Private #10 merged as `409c0d1901f4bc81b53e6dd405a0f2615bdd5598`;
  public #81 merged after repinning and composed CI. Subsequent private #11 /
  public #112 merged and the current pin is private main
  `a254e739ddfbf43619c90ca76b2cb0078a14ac7d`. Its actual desktop-ci
  [34809395865](https://github.com/Sinotrade/shioaji-pro-app/actions/runs/34809395865)
  passed. v0.1.47 publication is now explicitly authorized; deferred acceptance
  stays OPEN in #47 / #51 / #68 / #113 (see [release record](qa/release-v0.1.47.md)).
- Private #10's actual `desktop-ci` passed in public run
  [34689974496](https://github.com/Sinotrade/shioaji-pro-app/actions/runs/34689974496).
  Public main `95bff4a` also passed desktop CI in run
  [34696874122](https://github.com/Sinotrade/shioaji-pro-app/actions/runs/34696874122).
  These historical results do not replace the final follow-up head's required
  CI and Linux/Windows composed checks.
- Public #103 is the usage/market-data follow-up; it does not modify the private
  runtime. Its native simulation evidence and remaining actual broker-callback
  validation are tracked in [API usage QA](qa/api-usage.md) and the PR.
- The next release is planned as v0.1.47. The provider/platform/clean-machine
  checks below remain open; existing merges do not establish those checks.

## Evidence

- Official macOS arm64 Shioaji 1.7.5 binary: real Rust anonymous stdin pipe
  bootstrap (`SJAHIPC1`, 64 hex bytes, EOF), isolated temporary HOME, explicit
  simulation environment. `/api/v1/info` returned version 1.7.5,
  `simulation=true`, `bootstrap=one_shot_ipc`, enabled capability v1,
  compact keyed BLAKE3. No order endpoint was called.
- Actual OpenAPI and monitor metrics/subscriptions/settings endpoints returned
  200. This verifies upstream wire availability, not production broker execution.
- Independent browser QA: valid/missing/invalid usage, owned/external server,
  expand/collapse, document hidden/unmount, Auto scope copy and one-second
  approval expiry. Fixtures only; no native approval was submitted.
- Frontend unit tests and production build, Rust capability/runtime/approval
  tests, native pipe process test, plugin packaging checks and independent
  code review are recorded with exact results in the paired PRs.
- Rust loopback/process tests run outside the restrictive local sandbox.
  Fixture tests do not certify the real native provider or broker.

## Review dispositions

Independent security review and Claude Code final source review found no
remaining blocking source defect after the fixes recorded in the PR. QA agent
approved its frontend fixture scope. This is not approval of the native gates.

- Lifecycle read lock spans a proposal: accepted bounded liveness tradeoff
  (production TTL 15 seconds); generation changes still fail closed.
- The first non-blocking transport poll is synchronized with revocation:
  accepted dispatch boundary; once started, the request is allowed to report
  its result rather than being cancelled into an ambiguous outcome.
- Cancellation compares current status/remaining quantity with the displayed
  proposal. A fill during approval deliberately requires a fresh proposal.
- Native Dashboard origin isolation/CSP behavior remains an explicit real
  WebView gate, not established by the browser fixture.

## Deferred native acceptance and required release checks

1. Fresh native Codex, Claude Code and Pi sessions against the candidate:
   production readonly access, per-order proposal deny/expiry, first Auto
   scope deny/revoke, account/environment/runtime restart changes. Do not
   submit real orders; use denied proposals and an isolated broker fixture
   for successful dispatch and ambiguous-response paths.
2. Actual bootstrap and native approval-window behavior on macOS arm64/x64,
   Windows and Linux; clean-machine installation/onboarding. Current real
   sidecar smoke covers macOS arm64 simulation only.
3. Native WKWebView/WebView2/WebKitGTK Dashboard rendering, CSP/iframe behavior,
   subscription diagnostics and collection lifecycle with the real sidecar.
   Capture dark zh-TW privacy-mode release screenshots from that verified UI;
   current browser fixture screenshots are QA evidence, not release images.
4. Private `desktop-ci`, public required CI and Linux/Windows composed tests
   must be green at the pinned immutable private SHA. These are build/test
   gates, separate from the native checks above.
5. Ready follow-up PRs require their own review, QA and exact-head green CI
   before merge. The original paired integration sequence is complete (above).
   Any new private change must repeat private merge, public repin and composed
   CI before public merge. The maintainer supplied fresh explicit v0.1.47 release authorization
   on 2026-09-14; requirements 1–3 remain tracked as unverified in OPEN issues,
   while the build/review checks in 4–5 remain required before publication.

## Safety and cleanup

No real orders are used for testing. Unknown outcomes are never retried.
Only task-owned fixture/browser/sidecar processes are stopped. Unmerged
worktrees remain for review. Signing secrets, bootstrap credentials and raw
account data are excluded from committed evidence.
