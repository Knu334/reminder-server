# Reminder Server API Result Logging Implementation Plan（承認済み）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** API Lambdaの成功・失敗を1呼び出し1件で記録する。HTTP応答、秘密の扱い、既存保持期間を維持する。

**Status:** 2026-10-08承認済み・実装未着手。ユーザーが本計画と正式E2Eの設計・対応表・計画を承認した。[承認記録と実装引き継ぎ](../handoffs/2026-10-08-reminder-server-formal-e2e-implementation.md)に従い、別セッションで本計画を先に実装する。製品コードの独立した変更として、検証・レビュー・コミットする。その完了commitを確認してから[正式E2E計画](2026-10-08-reminder-server-formal-e2e.md)を実装する。今回の承認は本計画の製品変更を含むため、同じ範囲の承認を取り直さない。SDD方式は選択済みであり、再確認しない。

**Design:** [正式E2E設計§8](../specs/2026-10-08-reminder-server-formal-e2e-design.md#api結果ログと観測方法)のログ契約を適用する。外側のhandlerを包み、初期化失敗、cold/warm、通常応答、入力拒否、503を覆う。JSON本体は512bytes以内、IDは各128文字以内。記録項目はrequestId/lambdaRequestId/operation/status/code/durationMs。operation/codeは固定許可値、正常時のcodeと不正IDは省略する。本文・画像・owner/item ID・生path/query・token・署名URL・例外message/stackを出さない。console経由で既存log groupへ配信し、保持30日を維持する。SDK呼び出し、新依存、alarm、metric、subscription、常時クエリを追加しない。

**Cost:** 東京・月100リクエスト未満、追加1KiB/呼び出しの仮定を[費用・ログ方針](../../operations/formal-e2e-cost-and-logging.md)で示した。512bytesはJSONの契約であり、請求量の上限保証ではない。CloudWatchへの実配信は後続E2Eで検証する。

## 制約と承認後の実行

既存worktreeと未コミットのnull-body修正を保持する。変更は下記Filesだけを対象にし、実AWS/GHA/push/PR/merge、Flociリソース作成、Terraform applyを含めない。私有inputs/state/plan/credentials、実データを読まない。Node24.21.0/npm11.11.1/Python3.13.16を使用し、全npm/npx/Python/準備commandに `PATH=/tmp/aws-sdd-tools/node_modules/.bin:/tmp/aws-sdd-tools/bin:$PATH` を付ける。

承認後は本計画専用のSDD workspaceと台帳を作る。progress.mdの第一行は `# SDD ledger — plan: docs/superpowers/plans/2026-10-08-reminder-server-api-result-logging.md`。旧台帳・E2E台帳を流用しない。BASE、task brief、新規実装者、RED/最小/GREEN/self-review/明示commit、review package、独立reviewerの順で進める。controllerは実装を直さず、実装者はsubagentを起動しない。修正round1〜3は元実装者、4〜5は上位modelの新実装者、最終レビューは利用可能な最も能力の高いmodelを使う。許可されたmodel/effortをdispatch時に確認する。同じ成功済み試験をreviewerに再実行させない。

## 実装タスク

### Task 1: API Lambdaの成功・失敗を1件の安全な結果ログで記録する

**Files:** Modify `src/api.ts`（必要な場合だけ `src/shared/logging.ts`）; Create `tests/runtime/api-logging.test.ts`。

**Interfaces:** 既存のhandler応答とSafeLogEvent、`withApiResultLogging(delegate:ApiHandler):ApiHandler`。productionの初期化を含む外側のhandlerを一度だけ包む。Iでは同じwrapperにcreateApiHandlerを渡す。Lambda contextのrequest IDを受け取り、ログ分類は固定operation/codeに限定する。

- [ ] Step 1 RED: POST201、PATCH/DELETE200、入力拒否、依存先503、初期化503、health、cold/warm invocationで各1件をassertする。requestId/status/error codeと応答の一致、各ID最大128文字・不正ID省略、512bytes以内、本文/token/画像/例外canaryの不在を確認する。loggerが失敗してもHTTP応答が変わらないケースを作る。
- [ ] Step 2 RED実行: prefix付きでapi-logging単独試験を実行する。現行APIが結果ログを出さないことによる失敗を記録し、既存null-body修正は保持する。
- [ ] Step 3 最小実装: 既存logging helperを再利用し、通常・早期return・catch・初期化失敗を覆う最外側境界にwrapperを置く。内側のhandlerと二重に記録しない。安全なID、固定operation/status/code、durationだけをJSON出力する。APIからPutLogEventsを呼ばず、HTTP契約を変えない。import時のconfig/client/I/O初期化禁止を維持する。
- [ ] Step 4 GREEN: api-logging、関連API/runtime回帰、typecheck/lintを実行する。JSON本体512bytes契約と秘密canary検査を確認する。stdoutのJSONをCloudWatch配信の証拠とは数えない。
- [ ] Step 5 commit/review: 上記変更だけを個別stage、`feat: record safe API invocation outcomes`。OBS-01/04、cold/warmの一回性、応答維持、secret不在を独立レビュー。

## 完了と引き渡し

独立承認、上記試験、レビュー、製品変更だけのcommit、安全な結果記録が揃ったことを確認する。承認済み版・commit・実施した試験をE2E計画Task2へ渡す。docs/implementation-results.mdのF10追補には日付付きで新結果を追記し、過去の337件等を今回の成功へ流用しない。公開結果には秘密・生ログを保存しない。E2E基盤の障害と、この機能の回帰失敗を別に報告する。
