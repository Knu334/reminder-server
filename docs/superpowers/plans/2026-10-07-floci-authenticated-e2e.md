# Floci 認証付き CRUD E2E Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan.

**Goal:** 承認済みのローカル Floci 検証を、公開 PKCE・JWT Gateway・Docker Lambda・DynamoDB を通る CRUD へ進める。

**Architecture:** アプリの認証条件と本番 Terraform を維持する。Floci 2.2.0 の既存設定で private literal IPv4 の issuer/JWKS を使用する。Compose 起動時に自身の IPv4 を検出し、ローカル専用の private JWT targets を明示許可する。クライアントの通信先は引き続き `http://floci:4566`。issuer は discovery から読み取り、Gateway と検証 Lambda の設定を一致させる。合成リソースを各試行で生成し、finally で削除する。

**Scope/authorization:** ユーザーは issuer/JWKS 接続と認証付き CRUD の継続、Floci コンテナ変更、Floci のみの Docker socket を承認済み。元の19タスクは完了しており再実行しない。AWS 構築・デプロイ・実データ移行・push/PR/merge は対象外。private data/credentials/state/plan/env dumps を読まない。root の FW script に触れない。開発コンテナへ Docker socket/CLI を追加しない。

**Verification boundary:** 実コンテナの変更はホストの Dev Containers リビルドが必要。変更前の401再現、別の loopback JVM における設定確認、構成レビューを先に完了する。リビルド後の実コンテナ E2E 成功を先取りしない。

### Task 1: 再実行できる認証付き CRUD harness

Worktree: `/workspace/.worktrees/aws-sdd` (removed on 2026-10-18; use the repository root `/workspace`).
Create `tools/local-e2e/floci/authenticated-crud.test.mjs` and, if needed, focused helper modules in that directory. Do not alter `src`, production Terraform, refresh patch, or existing refresh tests. Read AGENTS.md, README.md, `docs/operations/local-e2e-floci-null-body-fix-results.md`, `infra/platform/production/storage.tf`, `infra/application/production/gateway.tf`, and refresh.test.mjs first.

Use Node 24.21.0/npm11.11.1, prefix all Node/npm/preparation commands with `PATH=/tmp/aws-sdd-tools/node_modules/.bin:/tmp/aws-sdd-tools/bin:$PATH`. Shell needs require_escalated. Manage only explicit `http://floci:4566` endpoint and dummy credentials/region ap-northeast-1. Fail before mutation for other endpoint, redirects/network escapes, or missing artifact. Existing `artifacts/reminder-server.zip` is the approved null-body-fixed synthetic-test artifact; verify its SHA256 against `6d3780c466a142039876a02f4ec99e389da874a8e9b22508ff90d1a194913915` without rebuilding app.

Create resources under a random `localauth-` prefix: owned pool/resource-server(public reminder-api read/write)/public code PKCE client, two synthetic users, 3 DynamoDB tables with production keys/GSI, synthetic S3 bucket, owned IAM execution role, Lambda using existing ZIP, HTTP API/default stage/JWT authorizer/production CRUD route scopes. SDK endpoint+credentials must be explicit; no credential chain or real-AWS default. Cognito APIs can use existing raw local JSON helper pattern, Gateway management local REST endpoints, IAM local query protocol. Use production Cognito explicit flow `ALLOW_ADMIN_USER_PASSWORD_AUTH`, secret false, access/ID5min, refresh30days and rotation10sec. Do not weaken Gateway/app token_use/client/issuer/scope/expiry checks. Obtain access tokens through real Hosted UI authorization code + PKCE with state/cookie checks, not synthetic Gateway claims or password grant. Transport origin may be Floci's currently resolved private IPv4 with port4566 as well as the fixed service endpoint, strictly validate location before following it. Do not log JWTs, codes, passwords, cookies, signed URLs or response bodies containing them.

Tests: health200; ready503 then publication marker ready200; missing JWT rejected401; forged-signature JWT rejected401; ID token rejected; read-only token cannot write; wrong-client token rejected; owner create/list/get/update/delete, If-Match missing428/stale412; second user's get/update/delete isolation; refresh rotates and refreshed access token still reads same owner's item; tombstone prevents recreation. Verify actual resource state/HTTP bodies/headers as appropriate. All CRUD must go through actual Gateway→Docker Lambda. Use token payload only for expected identity and verify signing via local JWKS. No fabricated authorizer context. Cleanup in reverse order including owned S3 versions/delete markers and owned auto log groups; collect cleanup errors independently, fail if any. Ensure test failures cannot skip cleanup.

Run against current container to reproduce issuer/JWKS failure and record exact phase without interpreting all dependent skipped checks as successful. If 401 blocks valid JWT, report it; no bypass or Java/config edits. Save safe diagnostic log/report in this plan's SDD directory. Self-review, run node --check and relevant lint. No commit required yet; stage nothing. Report status and file paths. Parent will configure local issuer afterward and re-run after rebuild.

### Task 2: ローカル issuer/JWKS 設定と診断

Files: root `/workspace/.devcontainer/docker-compose.yml`, optional root `/workspace/.devcontainer/floci/local-jwt-command.sh`, root `/workspace/.devcontainer/floci/README.md`, app `docs/operations/local-e2e-floci-authenticated-results.md`. Keep root FW script untouched. Current custom image remains `floci-local:2.2.0-refresh.1`, pinned source/refresh patch unchanged.

Use existing Floci security setting `FLOCI_SECURITY_ALLOW_PRIVATE_JWT_TARGETS=true` only on Floci. Its HTTP exception requires private literal IP, including discovery JWKS URL; `http://floci:4566` is not accepted. Choose dynamic own-container private IPv4 at startup, fail on ambiguous/invalid/public values; export FLOCI_HOSTNAME and FLOCI_BASE_URL consistently before Java runs. Do not pin an ephemeral Docker IP or add a fixed network subnet. Preserve upstream entrypoint privilege/socket handling, JVM current flags and healthcheck. Compose dollar escaping must be verified. If script mounted read-only is chosen, command invokes bash explicitly; no need image rebuild for script executable mode. Script should be small and independently checkable. No JWT verifier changes/SSL bypass/global AWS endpoint/credentials.

Before claiming configuration verified, test failing old configuration vs new private literal issuer on isolated loopback JVM (port4567, synthetic pool/tokens/Gateway, HTTP_PROXY health backend if no Docker socket), using existing built JVM artifact and Java25 archive in `/workspace/.worktrees/floci-oauth/.task/tools/jdk25.tar.gz`. All mutable paths/logs owned local scratch, clean resources and terminate JVM. At minimum verify a signed PKCE token, real JWKS/discovery, JWT authorizer acceptance vs missing/forged/wrong-client JWT rejection; distinguish HTTP_PROXY diagnostic from application Lambda E2E. Prefer a focused persistent configuration probe helper if useful. Validate source/mount paths and compose parsing without dumping full compose environment. Read current Context7 Floci docs/source for config API; controller has resolved `/floci-io/floci`, docs available for reference but no credentials queries. Report independently observed evidence; if runtime blocked, record concrete limitation rather than invent success.

Japanese README/report must explain generated IP is an ephemeral issuer while service endpoint stays floci, private targets setting local only, why hostname alone fails, state/tokens reset on rebuild, commands to run refresh and authenticated CRUD after rebuild, expected current vs pending result, cleanup, and limitations (no full Terraform apply/real AWS/full Floci suite/security policy equivalence). Do not claim actual rebuilt container CRUD passes before running it. Parent owns final current-harness results section after Task1. Self-review and scoped checks; no commit/stage. Fresh task reviewer before final handoff.

### Task 3: リビルド後の readiness fixture 修正と経路診断

実コンテナの失敗を境界ごとに観測する。証拠に基づき、harness の Lambda Environment の AWS_ENDPOINT_URL 上書きを除去し、Floci が注入する到達可能 endpoint を使う。管理クライアントの固定接続先と通信ガードは維持する。owned bucket のみに s3:ListBucket を追加し、本番 readiness の IAM 契約と fixture を揃える。アプリ、本番 Terraform、認証要件は変更しない。実コンテナで再実行し、通過したチェック、停止箇所、cleanup を独立して記録する。個別取得の404は、owned echo Lambda が routeKey/httpMethod/hasJWT boolean のみを返す診断で実際に選ばれた route を確定する。全イベントや秘密値を出力しない。Task3 のレビュー完了後に次の実装へ進む。

### Task 4: 同じ path template の具体的 HTTP method と ANY の優先順位

Task3 で Floci 側の選択不具合が確定した場合のみ実装する。固定2.2.0ソースの ApiGatewayV2Service.findMatchingRoute を狭く修正し、同じ path template に具体的 method と ANY が存在する場合、具体的 method を選ぶ。未知 method の ANY fallback、既存の literal exact match と $default を維持する。ルート削除・登録順変更、JWT bypass、アプリの fallback 緩和で回避しない。異なる template 間の優先順位を全面的に変更することは対象外。

まず両登録順の GET/PATCH/DELETE 対 ANY の回帰を RED にし、最小修正後に GREEN にする。未知 method、literal exact、$default、route 不在と HTTP/API integration の関係する既存試験を検証する。Java25、focused Maven tests、checkstyle、JVM package を実行し、全Floci試験成功とは主張しない。既存 refresh patch は内容を維持し、routing 専用 patch を root と app tools の両方へ保存する。固定 upstream への適用を確認し、Dockerfile が両 patch を順番に適用するよう更新する。image/version は 2.2.0-refresh.2 に揃え、日本語 README/報告書へ原因、修正範囲、今回の実測、リビルド後に残る E2E 検証を明記する。root FW、startup script、Docker socket の共有範囲は変更しない。新しい実イメージの全 CRUD 成功はホストリビルド後にのみ判定する。task review 後に具体的なリビルド手順を渡す。

#### 2026-10-08 再開時の構成更新を反映した実行 ruling

上記のパッケージ構成は保存時点のもの。再開時、root は承認済み native `floci-local:2.2.0-refresh.1-native` と OAuth/routing 合成 patch へ更新されており、同じルート修正が稼働していることを source hash と実 E2E で確認した。この native 構成と合成 patch を保持する。専用 patch、refresh.2/JVM image、追加リビルドは作成しない。

残作業は現在の合成 patch の固定 upstream 適用・source 一致、作業コピーの補足回帰14件と checkstyle、日本語報告書の更新、タスクレビューと本 followup の最終レビュー。現在の native コンテナで12テスト（CRUD18チェック）が成功した fresh log を一次証拠とする。過去の10回成功・上流2,280件/84失敗の記録を今回の再実行結果へ混ぜない。アプリ認証要件、FW、本番 Terraform は維持する。
