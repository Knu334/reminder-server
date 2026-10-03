# Reminder Server AWS Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 監査で指摘された対象内の全件を、承認済みAWS構成への移行と回帰検証で解消する。

**Architecture:** API Gateway HTTP APIとCognitoが認証を担当し、API/画像清掃の2つのLambdaがDynamoDBとS3を使う。共通のZIPをS3のversionIdとSHA-256で固定し、GitHub ActionsからTerraformの保存済みplanを適用する。初回JSON移行と復旧照合は個別スクリプトで行う。

**Tech Stack:** TypeScript/CommonJS、Node24、esbuild、AWS SDK v3、DynamoDB/S3、Cognito、EventBridge Scheduler、CloudWatch、Terraform、GitHub Actions。テストはnode:test/node:assertとtsx、ZIP生成・検査はPython標準ライブラリ。

**Spec:** [承認済みAWS設計](../specs/2026-10-02-reminder-server-aws-design.md)、[監査](../../repository-audit-2026-10-02.md)、[Chrome認証契約](../../chrome-extension-cognito-auth.md)。旧SQLite設計は実装対象にしない。

## Global Constraints

- `.devcontainer`配下のファイルは一切変更しない。現在の作業ブランチは`feature/aws-modernization`。
- 常設AWS環境は`production`のみ。AWSアカウントと`aws_region`は必須入力で、推測してapplyしない。
- Lambdaのマネージドランタイムは`nodejs24.x`、architectureは`x86_64`。APIは512 MiB/10秒/reserved concurrency10、清掃は512 MiB/660秒/reserved concurrency1。
- 元画像を変換しない。本文2 MiB、画像1 MiB/項目、有効項目1000件、画像合計128 MiB、所有者120回/UTC分。
- APIのアクセストークン5分、IDトークン5分、refresh token30日、rotation猶予10秒。画像URLは要求有効期間15分。
- JSON原本は変更・削除せず、実データ・秘密値・state・planをGit、ログ、配布ZIPへ含めない。
- 画像清掃は日次`cron(0 3 * * ? *)`/`UTC`/`OFF`、初回`DISABLED`。24時間猶予、20分lease、候補10000件/S3削除5000件/600秒/並行4。
- PITR35日、S3非現行画像60日、ログ30日。9アラーム、独自メトリクス2個を維持する。
- ECR、Caddy、管理CLI、常設dev/staging、削除復元API、独自Authorizer、毎回の失効照会を追加しない。Chrome拡張の製品コードはこのリポジトリの対象外。
- 本計画はリポジトリ実装を対象とする。AWS構築、実データ移行、GHA起動、デプロイは、具体的な成果物・対象・planをレビューできる状態にしてから別の操作として実施する。

## Review Focus

1. Unicode・エンコードされたIDと偽装されたcursorで、他所有者の項目を読まず、同じIDを別の文字列へ二重デコードしない（runtime R02/R03/R08）。
2. S3保存後にDynamoDBの結果が不明になっても、反映済みの画像を清掃せず、再送で件数・容量を二重加算しない（runtime R04/R05、operations O02）。
3. GSI遅延とページ途中の停止が重なっても、候補を飛ばさず、committed画像を削除しない（runtime R06/R07）。
4. 移行の再開で対応ファイル・原本・対象環境が変わった場合、未公開データを別の所有者へ公開しない（operations O01/O02/O03）。
5. 設定ブロック削除・unknown output・前後aliasの食い違いによって、通常リリースで公開URLや認証主体を変更しない（delivery D05/D06/D07）。

---

## 計画の分割と実行順

保存と清掃は状態遷移を共有するため同じ計画に置き、AWS運用ツールと配布基盤は別の計画に分ける。各計画は合成入力のみで動くテストと成果物を持つ。

| 順番 | 計画 | 独立して確認できる成果物 | 前提 |
| --- | --- | --- | --- |
| 1 | [runtime](2026-10-03-reminder-server-aws-runtime.md) R01〜R08 | Gatewayイベントを直接処理するAPI/清掃handler、保存契約と障害テスト | 現行コードと設計 |
| 2 | [operations](2026-10-03-reminder-server-aws-operations.md) O01〜O03 | dry-run可能なJSON移行・復旧照合、原本不変と公開gateの検証 | runtimeの型、保存・画像ports |
| 3 | [delivery](2026-10-03-reminder-server-aws-delivery.md) D01〜D08 | 自己完結ZIP、Terraform3root、CI/CD、運用・開発文書 | 両handler、個別運用スクリプト |

計19タスク。順番を入れ替える場合もInterfacesの依存を守る。タスクのコミットはfeatureブランチに積み、mainへ直接実装しない。実行時の隔離方法はusing-git-worktreesの手順で確認する。

## ファイル構成の責務

| パス | 責務 |
| --- | --- |
| `src/config.ts`, `src/shared/` | 設定、実行期限、分類したエラー、許可された構造化ログ |
| `src/reminders/` | DTO/永続型、入力検証、ETag、cursor、所有者単位のサービス・DynamoDB処理 |
| `src/images/` | 元画像検証、S3処理、画像jobの状態と期限、DynamoDB job操作 |
| `src/api/`, `src/api.ts` | HTTP API v2イベント境界、JWT claims、ルート、応答、APIエントリー |
| `src/cleanup/`, `src/cleanup.ts` | 上限付き巡回、checkpoint、清掃メトリクス、清掃エントリー |
| `scripts/operations/` | JSON原本の検証、移行、復旧照合。普段のユーザー管理・清掃CLIにはしない |
| `scripts/build/`, `scripts/release/` | notices/SBOM、固定ZIP、成果物登録、plan保護、リリース照合 |
| `infra/bootstrap/` | state/ZIPバケットとGHA OIDC基盤 |
| `infra/platform/production/` | Cognito、3テーブル、画像バケット、API/清掃role、ログ |
| `infra/application/production/` | ZIP Lambda/version/alias、Gateway、Scheduler、アラーム |
| `tests/runtime/`, `tests/operations/`, `tests/delivery/`, `tests/support/` | node:testによる合成データとAWS command検査、stateful fake、リリース/plan試験 |
| `tests/packaging/`, `tests/fixtures/synthetic/` | Python ZIP試験と公開可能な合成fixture |
| `docs/api-v2.md`, `docs/operations/`, `README.md`, `CLAUDE.md` | クライアント契約、実行できるコマンド、初回/復旧/切り戻し手順 |

現行の`src/app.ts`、`src/router/index.ts`、`src/middleware/reminderMiddleware.ts`、`src/util/reminderUtils.ts`、`src/types/types.ts`はruntime R08で置換する。ルートDocker/Compose/tsup/nodemonと旧Docker workflowはdelivery D01/D07で撤去する。`.devcontainer`のファイルと参照先は編集しない。削除されたルートDocker手順に関係する差分はREADMEでAWS/ローカルテスト手順へ更新する。

## 共通の検証方針

通常のテストはAWS認証なしで実行する。AWS SDK command検査だけでは条件付き書き込みの競合を証明できないため、runtime R04/R05/R07は状態を持つfakeで並行操作と故障を検証する。fakeの成功は実AWSのIAM・署名・Gateway/PITRの検証結果として扱わない。

`npm run test:runtime`、`npm run test:operations`、`npm run test:delivery`は`tsx --test tests/<suite>/*.test.ts`を実行する。`npm test`はこの3suite、`npm run test:packaging`はPythonの`unittest`を実行する。テスト単位のRED/GREENコマンドは各タスクに示す。起動時に秘密ファイルを読むことなく、合成設定・fixtureを明示的に渡す。

全体の完了確認は`npm ci`、`npm run typecheck`、`npm run lint`、`npm run build`、`npm run package`、`npm test`、`npm run test:packaging`、`npm run verify:zip`、`npm run infra:check`、`npm run audit:all`、`git diff --check`、`git diff --exit-code 253e5e2 -- .devcontainer`。ZIPを読むdelivery試験があるためbuild/package後にnpm testを実行する。各コマンドは担当タスクで追加する。実行不可や監査の残件は理由を記録し、成功と報告しない。今のNode25環境をNode24試験の代わりにしない。

## 指摘・仕様の対応表

| 指摘 | 担当 | 受け入れの中心 |
| --- | --- | --- |
| F01/F03/F09/F26 | R01/R02/R03/R08、O01 | 型、入力、own property、owner/cursor、JSONエラー |
| F02/F11/B02/B03 | R04/R05、O02/O03 | revision、transaction、容量、画像commit、不明結果、復旧 |
| F04/F12/F15 | R03/R08、O02、D03/D04/D05 | 空一覧、Query、公開gate、初回順序、ready |
| F05/F06/B01 | R02/R03/R04/R08、D04/D05 | Cognito claims・owner、本文/容量/rate、最小IAM |
| F07/F08 | R02/R08、D04/D05/D08 | DNS廃止、sourceIp、Gateway/S3 CORS、OPTIONS |
| F10/F16/F17 | R02/R07/R08、D05/D06/D07 | redaction、await/期限、health、9アラーム、smoke |
| F13/F14/F18/B05 | R08、D04/D05/D08 | 直接TLS/listen/watch廃止、Gateway終端、Lambda権限・上限 |
| F19/F20/F21/F22/B06 | R01/R08、D01/D07 | Node24、依存固定、esbuild、ZIP/hash/notices/SBOM/監査 |
| F23/F24/F25 | R01、D01/D03/D05/D06/D07 | 型/lint/test、plan/lock/OIDC/SHA、更新自動化 |
| F27/F31/F32 | R08、D01/D08 | 独立handler、ローカル手順、README/CLAUDE/AGENTS |
| F30 | D08 | ローカルを保持してuntrack、ignore、対応する権限・ガード |
| B04 | R01/R04、O03、D08 | offset付き日時。削除復元APIは作らず、PITRとの違いを記載 |
| F28/F29 | 対象外 | `.devcontainer`全体を除外するユーザー指示を維持 |

F19/F21/F27/F30の`.devcontainer`内の指摘も対象外として残す。監査書は当時の記録として書き換えず、完了時に`docs/implementation-results.md`へ対応/置換/対象外/実AWS未検証を別々に記録する。

## リポジトリ実装後の別操作

レビュー可能な成果物が揃った後に、次を運用者と実施する。これらは本計画作成・ローカル実装の完了条件には含めず、未実行を明示する。

1. アカウント/リージョン、GitHub repository/environmentと実際のOIDC subject、origin、拡張ID/callback/logout URLを確定する。reserved concurrencyのアカウントquotaとGitHub Environment保護の利用可否を確認する。
2. 短期管理認証でbootstrapのplanをレビューして作成し、stateをS3へ移行する。platformをplan/applyし、Cognitoユーザーをコンソールで作成する。
3. 信頼したmainのコミットでZIPを一度生成・検証・S3登録し、versionId/hashを固定したapplication planをレビューして適用する。公開gate=false、schedule=DISABLED、heartbeat評価無効の状態を確認する。
4. 原本の作業用コピーと明示した所有者対応でdry-run→未公開移行→全件照合→公開gate切替を行う。本人がクライアント契約への対応を確認した後、Terraformでschedule/heartbeatを有効化する。
5. health/ready/URL/未認証拒否を自動smokeで、本人の合成項目だけの認証CRUD・画像・ETag/競合とChrome PKCE/refreshを手動で確認する。テスト項目だけをETag付きで削除する。
6. 必要時の一時復旧先でPITR/S3照合をレビューして実施する。実測duration/容量/旧version/転送/ログ/ZIP量で費用を再計算する。未実施なら復旧・料金を実証済みとしない。

## 計画のセルフレビュー結果

- 設計§1〜§17を上記19タスクへ割り当てた。§14の全F/Bは対応表で追跡し、除外も明記した。
- 5つのReview Focusには担当タスクのREDテストを割り当てた。Interfacesの型・関数名、job/GSI/公開状態キー、ZIP/handler名は全計画で統一する。
- 本文は作るファイル、境界、値、試験、コマンドに絞り、関数本体は実装者に委ねた。各タスクは検証とコミットで完結する。
- 2026-10-03にユーザーがSDD（Subagent-driven Development）を選択し、新セッションでの実行を指示した。[新セッション用プロンプト](../handoffs/2026-10-03-reminder-server-aws-sdd.md)に承認状態、作業範囲、進捗とレビューの運用を記録する。各サブ計画の数字のTask番号はSDDツール用、R/O/D識別子は全体計画の追跡用として維持する。
