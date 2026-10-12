# release custody の S3 移行 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `deploy.yml` の plan・入力・証拠・結果・診断を GitHub artifact から bootstrap 所有の private S3 bucket へ移し、public・private どちらのリポジトリでも同じ安全性で deploy できるようにする。

**Architecture:** `scripts/release/custody.ts` が種類ごとのファイル集合・manifest・SHA-256・利用期限を扱い、`workflow.ts` の各 phase が role の assume 後に S3 を読み書きする。レビューの digest は `release-review` の `manifest.json` の SHA-256 とし、plan の digest はその中に残す。bootstrap は bucket と prefix 単位の権限を追加だけで足す。

**Tech Stack:** TypeScript（tsx、node:test）、`@aws-sdk/client-s3`、zod、Terraform 1.16.5（AWS provider 6.67.0）、GitHub Actions、Floci（正式 E2E）。

**Spec:** `docs/superpowers/specs/2026-10-12-release-custody-s3-design.md`（実装者は計画と仕様書の両方を読む）

## Global Constraints

- ツールは Node 24.21.0、npm 11.11.1、Python 3.13.16、Terraform 1.16.5、AWS provider 6.67.0。npm・npx・Python のコマンドには `PATH=<リポジトリ直下>/.superpowers/tools/aws-sdd/node_modules/.bin:<リポジトリ直下>/.superpowers/tools/aws-sdd/bin:$PATH` を付ける。
- bucket 名は `<name_prefix>-<account_id>-<region>-custody`。output 名は `custody_bucket`、repository variable は `CUSTODY_BUCKET`。
- prefix は `<種類>/<run_id>/<run_attempt>/`（診断は `failure-diagnostics/<run_id>/<run_attempt>/<job>/`）。種類は `registered-release`、`release-review`、`release-result`、`failure-diagnostics`。
- lifecycle: `registered-release/`・`release-review/`・`failure-diagnostics/` は現行 version 1日、`release-result/` は30日。古い version は非現行になってから1日。delete marker は別規則の `ExpiredObjectDeleteMarker`。
- 書き込みは必ず `IfNoneMatch: "*"` と `ChecksumSHA256`。どの role にも `ListBucket`・`DeleteObject`・`DeleteObjectVersion` を与えない。bucket policy は HTTPS 以外、`If-None-Match` の無い `PutObject`、削除を拒否する。
- 利用期限は `registered-release` と `release-review` だけ。元の preview の `createdAt` から24時間（`now >= expiresAt` で失効）。`createdAt` が `now` より5分を超えて未来なら拒否。
- 入力 `expected_review_sha256` は「元の preview の `release-review/.../manifest.json` の SHA-256（16進数64桁）」。apply と ZIP 再利用 preview の両方で必須。
- 取り出したファイルはディレクトリ 0700、ファイル 0600。ファイル名に `/`・`\`・`..` を含むもの、symlink は拒否。
- GitHub の artifact を一切使わない（`ci.yml` の private 時だけの診断を除く）。ledger を標準出力に出さない。
- 文書は日本語、汎用の内容。実 AWS の操作、GHA の手動実行、push はしない。stage は path を明示する。

## Review Focus

1. 一部の job だけを再実行し、`needs.<job>.outputs` の custody の場所が欠けたとき、読む job は止まり、自分の `run_attempt` で推測して読まない（Task 4 に試験）。
2. `reviewed_run` の plan の job が run の最新の試行と違う試行で成功しているとき、plan の job の成功した試行の `run_attempt` を読む（Task 2 に試験）。
3. lifecycle の失効の後に同じ key へ同じ内容の manifest を作り直されたとき、SHA-256 は一致しても利用期限で止まる（Task 1 に試験）。
4. runner の時計のずれ: `createdAt` が5分以内の未来なら通り、5分を超えると止まる（Task 1 に試験）。
5. plan・apply が失敗したとき、標準出力・標準エラー・job summary に合成 fixture の秘密の値（入力の値、API URL、ARN）が出ない（Task 4 に試験）。

---

### Task 1: custody のモジュール

**Files:**
- Create: `scripts/release/custody.ts`
- Test: `tests/delivery/custody.test.ts`

**Interfaces:**
- Consumes: `ReleaseRoot`（`scripts/release/plan-guard.ts`）
- Produces:
  - `type CustodyKind = "registered-release" | "release-review" | "release-result" | "failure-diagnostics"`
  - `interface CustodyLocation { kind: CustodyKind; runId: string; runAttempt: number; job?: string }`
  - `interface CustodyManifest { version: 1; kind: CustodyKind; root: ReleaseRoot | null; runId: string; runAttempt: number; createdAt: string; expiresAt?: string; files: Record<string, string>; planReviewSha256?: string; custodySha256?: string; sourceManifestSha256?: string }`（`files` は名前→SHA-256 16進数）
  - `interface CustodyStore { put(key: string, body: Uint8Array, sha256Base64: string): Promise<void>; get(key: string): Promise<Uint8Array> }`
  - `custodyPrefix(location: CustodyLocation): string`
  - `requiredFiles(kind: CustodyKind, root: ReleaseRoot | null, options?: { initialPlatform?: boolean }): readonly string[]`（`failure-diagnostics` は空配列を返し、`writeCustody` 側で「`.json` だけ、最大8個」を検査する）
  - `writeCustody(store: CustodyStore, location: CustodyLocation, directory: string, fields: Pick<CustodyManifest, "root" | "planReviewSha256" | "custodySha256" | "sourceManifestSha256" | "expiresAt">, now: Date): Promise<{ manifestSha256: string; manifestSha256Base64: string }>`
  - `readCustody(store: CustodyStore, location: CustodyLocation, expectedManifestSha256: string, destination: string, expected: { root: ReleaseRoot | null; now: Date; initialPlatform?: boolean }): Promise<CustodyManifest>`
  - `assertUsable(manifest: CustodyManifest, now: Date): void`（利用期限の検査。apply の直前にも呼ぶ）
  - `createS3CustodyStore(bucket: string, client: S3Client): CustodyStore`

ファイル集合は仕様書「種類ごとのファイルの集合」の表をそのまま定数にする（`release-review` は `custodyNames` + `custody.json` + `plan.txt`、application は加えて `registered.json`・`audit.json`・`sbom.json`・`tests.txt`・`platform-outputs.json`。`registered-release` は `registered.json`・`audit-runtime.json`・`audit.json`・`sbom.json`・`tests.txt`。`release-result` は `ledger.json`、`initialPlatform` のときは `post-baseline.json` も）。

- [ ] **Step 1: 失敗する試験を書く**（fake の `CustodyStore` は `Map<string, Uint8Array>` と書き込み順の配列を持ち、既存 key への `put` で `PreconditionFailed` 相当の Error を投げる）

```ts
void test("write_puts_every_file_with_checksum_then_manifest_last", ...)        // 順序の最後が manifest.json、各 put の sha256Base64 が bytes と一致
void test("write_rejects_existing_key", ...)                                     // 2回目の writeCustody が reject
void test("read_rejects_missing_or_mismatched_manifest", ...)                    // manifest 無し、expectedManifestSha256 違いで reject
void test("read_rejects_location_kind_root_or_attempt_mismatch", ...)
void test("read_rejects_missing_required_and_extra_manifest_entries", ...)
void test("read_rejects_extra_file_in_destination_and_unsafe_names", ...)        // "../x"、"a/b"、symlink
void test("read_writes_0700_directory_and_0600_files", ...)
void test("read_rejects_file_hash_mismatch", ...)
void test("expiry_boundaries", ...)  // createdAt+24h ちょうどで reject、23:59:59 で通る、createdAt=now+5min 通る、now+5min+1s reject、不正な日時 reject、expiresAt≠createdAt+24h（引き継ぎ無し）reject
void test("recreated_identical_manifest_after_expiry_is_rejected", ...)          // 同じ bytes を新しい store に置き、now を25時間後にして reject
void test("result_and_diagnostics_have_no_expiry", ...)                          // release-result の manifest に expiresAt が無く、assertUsable を要求しない
void test("s3_store_sends_if_none_match_and_checksum", ...)                      // fake S3Client.send が受けた PutObjectCommand の IfNoneMatch==="*"、ChecksumSHA256
```

- [ ] **Step 2: 試験が失敗することを確かめる**

Run: `npx tsx --test tests/delivery/custody.test.ts`
Expected: FAIL（`scripts/release/custody` が無い）

- [ ] **Step 3: `scripts/release/custody.ts` を実装する**

manifest は `JSON.stringify(manifest, null, 2) + "\n"` の bytes を書き、その SHA-256 を返す。`expiresAt` は `fields.expiresAt` があればそれを使い、無ければ `release-review`・`registered-release` だけ `createdAt + 24h` を入れる。S3 の `get` は `GetObjectCommand` に `ChecksumMode: "ENABLED"` を付ける。zod で manifest を検証する。

- [ ] **Step 4: 試験が通ることを確かめる**

Run: `npx tsx --test tests/delivery/custody.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/release/custody.ts tests/delivery/custody.test.ts
git commit -m "feat(release): add S3 release custody with manifests and expiry"
```

### Task 2: 公開設定に依存しない来歴の確認と reviewed_run の試行の特定

**Files:**
- Modify: `scripts/release/workflow.ts`（`authorizeDispatch`、`verifyReviewedRunMetadata`、`workflowMain` の authorize phase）
- Test: `tests/delivery/workflow-driver.test.ts`

**Interfaces:**
- Produces:
  - `authorizeDispatch(input)` から `privateRepository` を削除する。`reviewedRun` があるときは `apply` に関係なく `expectedReviewSha256` を必須にする。
  - `verifyReviewedRunMetadata(input: unknown, repository: string): void` から `head.private` の条件を削除する。
  - `selectReviewedPlanAttempt(jobs: unknown): number` — GitHub の `GET /repos/{repo}/actions/runs/{id}/jobs?filter=all` の応答から、名前が `plan` の job のうち `conclusion === "success"` で最大の `run_attempt` を返す。無ければ throw。
  - authorize phase は `GITHUB_OUTPUT` に `reviewed_attempt=<n>`（`reviewed_run` が空なら出さない）を書く。

- [ ] **Step 1: 失敗する試験を書く**

```ts
void test("dispatch_accepts_public_or_private_main_dispatch", ...)   // 公開設定の引数自体が無いこと、main 以外・PR・非到達 commit は reject のまま
void test("reused_preview_requires_reviewed_digest", ...)            // apply=false でも reviewedRun があり digest が無ければ reject
void test("reviewed_run_metadata_accepts_public_repository", ...)    // head.private:false を通し、別 repository・別 path・failure・非 main は reject
void test("reviewed_plan_attempt_uses_successful_plan_job_attempt", ...) // plan が attempt 1 失敗・attempt 2 成功、apply 無し → 2。register だけ attempt 3 でも plan の 2 を返す。成功した plan 無し → throw
```

既存の `dispatch_rejects_public_pr_nonmain_unreviewed_apply_before_aws` は、公開設定の検査を外した内容に書き直す。

- [ ] **Step 2: 失敗を確かめる**

Run: `npx tsx --test tests/delivery/workflow-driver.test.ts`
Expected: FAIL（新しい試験）

- [ ] **Step 3: 実装する**（authorize phase の fetch に jobs API の呼び出しを足し、`selectReviewedPlanAttempt` の結果を `GITHUB_OUTPUT` に追記する）

- [ ] **Step 4: 通ることを確かめる**

Run: `npx tsx --test tests/delivery/workflow-driver.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/release/workflow.ts tests/delivery/workflow-driver.test.ts
git commit -m "feat(release): verify reviewed runs without relying on repository visibility"
```

### Task 3: plan phase と register phase の custody 化

**Files:**
- Modify: `scripts/release/workflow.ts`（`planRelease`、`workflowMain` の plan phase、新しい `register-custody` phase）
- Test: `tests/delivery/workflow-driver.test.ts`

**Interfaces:**
- Consumes: Task 1 の `readCustody`・`writeCustody`・`assertUsable`・`createS3CustodyStore`、Task 2 の `reviewed_attempt`
- Produces:
  - `WorkflowContext` に `custodyStore: CustodyStore`、`runId: string`、`runAttempt: number`、`now: () => Date` を加える。
  - `planRelease(c, config, source: { location: CustodyLocation; manifestSha256: string } | undefined, services): Promise<{ manifestSha256: string; manifestSha256Base64: string; planReviewSha256: string }>`
  - `workflowMain` の phase に `register-custody`（register job の最後に `$RUNNER_TEMP/registered` を `registered-release` として書き、`GITHUB_OUTPUT` に `custody_run_id`、`custody_attempt`、`custody_manifest_sha256` を出す）を加える。
  - plan phase の `GITHUB_OUTPUT`: `custody_run_id`、`custody_attempt`、`custody_manifest_sha256`、`review_sha256`（= manifest の SHA-256）。
  - 環境変数: `CUSTODY_BUCKET`、`GITHUB_RUN_ID`、`GITHUB_RUN_ATTEMPT`、`SOURCE_RUN_ID`・`SOURCE_ATTEMPT`・`SOURCE_MANIFEST_SHA256`（同じ run の register の output、または `reviewed_run`・`reviewed_attempt`・`EXPECTED_REVIEW_SHA256`）。

動作（仕様書「reviewed_run を使う2つの経路」と「3つの digest の区別」）:
- source が `registered-release` なら読み取って今の `readManifest`・`copyEvidence` に渡す。source が `release-review` なら `readCustody` の後に今の preview の確認（`preview.json`、root、commit、artifact）を行う。
- apply 経路では `manifest.planReviewSha256` と新しい plan の digest を比べる（入力の値とは比べない）。新しい `release-review` は元の `expiresAt` を引き継ぐ。
- ZIP 再利用 preview では plan の digest を比べず、新しい manifest に `sourceManifestSha256` を入れ、期限は新しい作成時刻から24時間。
- `terraform show -no-color <saved.tfplan>` の出力を `plan.txt`（0600）に書く。
- job summary は root、commit、action の件数、`review_sha256`（16進数と Base64）、custody の run ID と `run_attempt` だけ。「artifact を download」の文言を削除する。

- [ ] **Step 1: 失敗する試験を書く**（fixture の source を fake の `CustodyStore` に置き換える）

```ts
void test("preview_writes_release_review_with_plan_text_and_returns_manifest_digest", ...)
void test("apply_run_compares_inner_plan_digest_and_inherits_expiry", ...)        // 既存の「preview と apply の plan の digest が等しい」を manifest 内の planReviewSha256 で比べる形に書き直す
void test("apply_run_rejects_reviewed_manifest_digest_mismatch", ...)
void test("reused_preview_records_source_manifest_and_gets_new_expiry", ...)     // scheduler を変えた preview：plan digest は違ってよい
void test("expired_reviewed_bundle_is_rejected_for_apply_and_reuse", ...)
void test("register_custody_outputs_location_and_manifest_digest", ...)
void test("plan_summary_lists_only_allowed_fields", ...)                          // summary に inputs の値・ARN・URL が無い
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx tsx --test tests/delivery/workflow-driver.test.ts`
Expected: FAIL

- [ ] **Step 3: 実装する**

- [ ] **Step 4: 通ることを確かめる**

Run: `npx tsx --test tests/delivery/workflow-driver.test.ts tests/delivery/custody.test.ts tests/delivery/plan-guard.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/release/workflow.ts tests/delivery/workflow-driver.test.ts
git commit -m "feat(release): keep registration and review custody in S3"
```

### Task 4: apply phase、結果、診断の custody 化

**Files:**
- Modify: `scripts/release/workflow.ts`（`applyRelease`、`workflowMain` の apply phase、新しい `diagnostics` phase）
- Test: `tests/delivery/workflow-driver.test.ts`

**Interfaces:**
- Consumes: Task 1、Task 3 の plan job output（`custody_run_id`、`custody_attempt`、`custody_manifest_sha256`）
- Produces:
  - apply phase は `PLAN_CUSTODY_RUN_ID`、`PLAN_CUSTODY_ATTEMPT`、`PLAN_CUSTODY_MANIFEST_SHA256` を必須とし、欠けた・形式が不正なら throw（自分の `GITHUB_RUN_ATTEMPT` で代用しない）。`EXPECTED_CUSTODY_SHA256` は manifest の `custodySha256` から得るので廃止する。
  - `applyRelease` は `readCustody` → 今の `checkCustody`・`verifySavedPlan` → `assertUsable(manifest, now())` を apply の直前に呼ぶ → apply → `ledger.json`（と初回の platform では `post-baseline.json`）を `release-result` に `writeCustody`。
  - `workflowMain` の apply phase は ledger を標準出力に出さない。job summary には root、commit、`result`、`release-result` の run ID と `run_attempt` だけを書く。
  - `diagnostics` phase: `$RUNNER_TEMP/release-diagnostics/*.json` と `$RUNNER_TEMP/infra-diagnostics/*.json` を `failure-diagnostics/<run_id>/<run_attempt>/<JOB>/` に書く（`JOB` 環境変数）。ファイルが無ければ何もしない。失敗しても exit code は 0 にせず、呼び出し側の step は `continue-on-error` にしない（job は元から失敗している）。

- [ ] **Step 1: 失敗する試験を書く**

```ts
void test("apply_reads_plan_job_location_and_rejects_missing_outputs", ...)     // Review Focus 1
void test("apply_rechecks_expiry_immediately_before_terraform_apply", ...)      // now を apply 直前に失効させると terraform apply が呼ばれない
void test("apply_writes_ledger_and_initial_platform_baseline_to_release_result", ...)
void test("apply_never_writes_ledger_or_fixture_values_to_stdout_or_stderr", ...)  // Review Focus 5：成功と失敗の両方で process.stdout/stderr を捕まえる
void test("diagnostics_phase_writes_only_bounded_json_files", ...)
```

- [ ] **Step 2: 失敗を確かめる**

Run: `npx tsx --test tests/delivery/workflow-driver.test.ts`
Expected: FAIL

- [ ] **Step 3: 実装する**

- [ ] **Step 4: 通ることを確かめる**

Run: `npx tsx --test tests/delivery/workflow-driver.test.ts tests/delivery/custody.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/release/workflow.ts tests/delivery/workflow-driver.test.ts
git commit -m "feat(release): keep apply results and diagnostics in S3 and off the log"
```

### Task 5: deploy.yml

**Files:**
- Modify: `.github/workflows/deploy.yml`
- Test: `tests/delivery/workflows.test.ts`

**Interfaces:**
- Consumes: Task 2〜4 の phase（`authorize`、`register-custody`、`plan`、`apply`、`diagnostics`）と output 名

変更点:
- authorize job の `if` から `github.event.repository.private == true` を外す（`github.ref == 'refs/heads/main'` は残す）。job の `outputs` に `reviewed_attempt` を出す。
- `upload-artifact`・`download-artifact`・`secure` の step を全て削除する。
- register job: 登録の後に `register-custody` を実行し、`outputs` に `custody_run_id`・`custody_attempt`・`custody_manifest_sha256` を出す。
- plan job: S3 の読み書きは plan phase の中で行うので、step の順序は「install → assume → plan」。`SOURCE_*` を `inputs.reviewed_run` の有無で register の output か authorize の `reviewed_attempt` と `inputs.expected_review_sha256` から渡す。`outputs` に `custody_run_id`・`custody_attempt`・`custody_manifest_sha256`・`review_sha256`。
- apply job: `PLAN_CUSTODY_*` を `needs.plan.outputs` から渡す。`EXPECTED_CUSTODY_SHA256` を削除する。
- 各 AWS job の最後に `if: failure()` で `diagnostics` phase を実行する step を置く（assume が成功したときだけ意味がある。assume 前の失敗では認証が無く S3 に書けないので、step は失敗してよい）。authorize job には置かない。
- `CUSTODY_BUCKET: ${{ vars.CUSTODY_BUCKET }}` を workflow の `env` に足す。入力 `expected_review_sha256` と `reviewed_run` の description を「元の preview の manifest の SHA-256。apply と ZIP 再利用に必要」に直す。

- [ ] **Step 1: 失敗する試験を書く**

```ts
void test("deploy_uses_no_github_artifacts_or_visibility_gate", ...)   // upload-artifact/download-artifact/repository.private が deploy.yml に無い
void test("custody_runs_only_after_role_assumption", ...)              // register/plan/apply の各 job で configure-aws-credentials の index < release:workflow の register-custody/plan/apply の index、failure 時の diagnostics はその後
void test("custody_location_flows_through_job_outputs", ...)           // plan の env が needs.register.outputs と needs.authorize.outputs.reviewed_attempt を参照、apply の env が needs.plan.outputs.custody_* を参照
void test("ci_diagnostics_remain_private_only", ...)                   // ci.yml の upload-artifact の if に repository.private == true
```

既存の `private_custody_before_oidc_and_one_day_transfer` と `failure diagnostics upload follows commands ...` は新しい仕組みに合わせて書き直す（deploy.yml の upload 数の検査を削除し、ci.yml だけを検査する）。`all_actions_pinned_and_apply_not_cancelled` はそのまま通ること。

- [ ] **Step 2: 失敗を確かめる**

Run: `npx tsx --test tests/delivery/workflows.test.ts`
Expected: FAIL

- [ ] **Step 3: `deploy.yml` を直す**

- [ ] **Step 4: 通ることを確かめる**

Run: `npx tsx --test tests/delivery/workflows.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/deploy.yml tests/delivery/workflows.test.ts
git commit -m "ci(deploy): move release custody to S3 after role assumption"
```

### Task 6: bootstrap の custody bucket と権限

**Files:**
- Modify: `infra/bootstrap/storage.tf`（bucket、versioning、暗号化、公開アクセスのブロック、policy、lifecycle）
- Modify: `infra/bootstrap/oidc.tf`（`local.policies` の3 role に statement を追加）
- Modify: `infra/bootstrap/outputs.tf`（`output "custody_bucket"`）
- Test: `infra/bootstrap/tests/bootstrap.tftest.hcl`

**Interfaces:**
- Produces: `aws_s3_bucket.custody`、output `custody_bucket`。既存の `local.buckets`（`state`、`artifacts`）と、それを `for_each` に使う既存リソースの key は変えない（custody 用は別のリソースとして書き、既存 address を保つ）。

statement（Sid は次の名前にする）:
- artifact: `WriteRegisteredCustody`（`PutObject` on `registered-release/*`）、`WriteFailureDiagnostics`（`PutObject` on `failure-diagnostics/*`）
- plan: `ReadReleaseCustody`（`GetObject` on `registered-release/*`、`release-review/*`）、`WriteReviewCustody`（`PutObject` on `release-review/*`）、`WriteFailureDiagnostics`
- apply: `ReadReviewCustody`（`GetObject` on `release-review/*`）、`WriteResultCustody`（`PutObject` on `release-result/*`）、`WriteFailureDiagnostics`

- [ ] **Step 1: 失敗する試験を書く**（`command = plan` の run を追加する）

```hcl
run "custody_bucket_is_private_versioned_and_expiring" { ... }      # versioning Enabled、AES256、PAB 4項目 true、policy に DenyInsecureTransport・RequireCreateOnlyWrite・DenyCustodyDeletion、lifecycle の prefix ごとの Days（1/30）、NoncurrentDays 1、ExpiredObjectDeleteMarker の別規則
run "custody_access_is_prefix_scoped_without_list_or_delete" { ... } # 各 role の custody statement の Action/Resource が上の表と一致、ListBucket/Delete* を含まない
run "existing_bootstrap_addresses_are_unchanged" { ... }            # aws_s3_bucket.state、aws_s3_bucket.artifacts、aws_s3_bucket_versioning.private["state"/"artifacts"] などが残る
```

既存の `maximum_bucket_name_keeps_policies_in_aws_limits` に、custody bucket 名が63文字以内であることの assert を足す。`required_gateway_logging_and_iam_size` の IAM のサイズの上限も通ること。

- [ ] **Step 2: 失敗を確かめる**

Run: `terraform -chdir=infra/bootstrap init -backend=false -input=false && terraform -chdir=infra/bootstrap test`
Expected: FAIL（新しい run）

- [ ] **Step 3: Terraform を実装する**

- [ ] **Step 4: 通ることを確かめる**

Run: `terraform -chdir=infra/bootstrap test && npm run infra:check -- --root=bootstrap`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add infra/bootstrap/storage.tf infra/bootstrap/oidc.tf infra/bootstrap/outputs.tf infra/bootstrap/tests/bootstrap.tftest.hcl
git commit -m "infra(bootstrap): add the release custody bucket and prefix-scoped access"
```

### Task 7: 正式 E2E を custody bucket に対応させる

**Files:**
- Modify: `scripts/e2e/terraform.ts:116`（接続してよい bucket に `custody`）
- Modify: `tests/e2e/floci/support/evidence.ts:51`（所有を記録してよい bucket に `custody`）
- Modify: `tests/e2e/floci/support/fixture.ts:101`（bucket の設定の読み戻しに `custody` と lifecycle）
- Modify: `tests/e2e/floci/support/expected-iam.ts:56`（bucket policy の期待値に `custody`）
- Modify: `scripts/e2e/terraform-source.ts`（`publicFiles.bootstrap` に新しいファイルがあれば追加。Task 6 が既存ファイルだけを変えるなら変更なし）
- Modify: `tests/e2e/floci/support/cases.ts`（新しい case `TF-01/custody-bucket-settings`、layer L、required）
- Test: `tests/integration/formal-e2e/*.test.ts`、`tests/e2e/floci/*.test.ts`

**Interfaces:**
- Consumes: Task 6 の `custody_bucket` output と bucket 設定

- [ ] **Step 1: 失敗する試験を書く** — `tests/e2e/floci/fixture.test.ts` などの harness 試験に「bootstrap の bucket 一覧が `state`・`artifacts`・`custody` で、custody の lifecycle と policy-present を読み戻す」assert を足し、`coverage.test.ts` が新しい case を要件の対応表に要求するようにする。
- [ ] **Step 2: 失敗を確かめる** — Run: `npm run test:integration:e2e && npm run test:e2e:harness` / Expected: FAIL
- [ ] **Step 3: 実装する**（清掃は既存の「policy を外し、全 version と delete marker を消してから destroy」をそのまま custody bucket に適用する）
- [ ] **Step 4: 通ることを確かめる** — Run: `npm run test:integration:e2e && npm run test:e2e:harness` / Expected: PASS
- [ ] **Step 5: Commit**

```bash
git add scripts/e2e tests/e2e tests/integration/formal-e2e docs/operations/formal-e2e-coverage.md
git commit -m "test(e2e): cover the release custody bucket on Floci"
```

### Task 8: custody のモジュールを Floci で動かす case

**Files:**
- Create: `tests/e2e/floci/support/custody-cases.ts`
- Modify: `tests/e2e/floci/support/cases.ts`（case の登録）、`tests/e2e/floci/support/evidence.ts`（互換性の理由の登録）、`scripts/e2e/run.ts`（suite の実行）
- Test: `tests/e2e/floci/custody.test.ts`（harness の試験）

**Interfaces:**
- Consumes: Task 1 の `writeCustody`・`readCustody`・`createS3CustodyStore`、Task 7 の custody bucket
- Produces: case `REL-01/custody-roundtrip`（required、layer L）と `REL-01/custody-conditional-write`（互換性、`unsupported` の理由 `conditional-write-unsupported`）

- [ ] **Step 1: 失敗する試験を書く**

```ts
void test("roundtrip_case_fails_on_transport_or_auth_errors_not_unsupported", ...)
void test("conditional_write_case_records_only_registered_reason", ...)   // 理由が conditional-write-unsupported 以外の unsupported は fail、既定の signature-enforcement-unsupported は使わない
void test("custody_cases_are_registered_with_requirements", ...)
```

- [ ] **Step 2: 失敗を確かめる** — Run: `npx tsx --test tests/e2e/floci/custody.test.ts` / Expected: FAIL
- [ ] **Step 3: 実装する**（roundtrip: release-review 相当の合成ファイルを書き、manifest の SHA-256 で読み、hash を照合する。conditional write: 同じ key への2回目の `PutObject`（`IfNoneMatch: "*"`）が拒否されれば pass、Floci が受け入れれば測定結果付きで unsupported）
- [ ] **Step 4: 通ることを確かめる** — Run: `npx tsx --test tests/e2e/floci/custody.test.ts && npm run test:e2e:harness` / Expected: PASS
- [ ] **Step 5: Commit**

```bash
git add tests/e2e/floci/support/custody-cases.ts tests/e2e/floci/support/cases.ts tests/e2e/floci/support/evidence.ts scripts/e2e/run.ts tests/e2e/floci/custody.test.ts
git commit -m "test(e2e): exercise release custody against Floci S3"
```

### Task 9: 文書と全体の検証

**Files:**
- Modify: `docs/operations/deployment.md`、`README.md`、`docs/operations/formal-e2e-coverage.md`、`docs/operations/formal-e2e-results.md`

内容（仕様書「文書」の節）:
- deployment.md: custody bucket と `CUSTODY_BUCKET`、lifecycle と利用期限、S3 コンソールでのレビュー（同じ run と `run_attempt` の `plan.txt`・`inputs.json`・`baseline.json`・`request.json`・証拠、`manifest.json` の SHA-256 を自分で確かめて `expected_review_sha256` に入れる）、`post-baseline.json` を取り出して `PLATFORM_BASELINE_JSON` を更新する手順、「bootstrap の更新」と「リポジトリを public に切り替えるとき」、GitHub artifact と「private のリポジトリだけ」の記述の書き換え、ZIP 再利用 preview にも digest が要ること。
- README.md: CI/CD の表の `deploy.yml` の説明を「手動。実 AWS への ZIP 登録、Terraform の plan と apply。plan などは private な S3 に置く」に直す。

- [ ] **Step 1: 文書を直す**
- [ ] **Step 2: 文書の試験とリンクを確かめる** — Run: `npm run test:integration:e2e`（README の formal-e2e-README へのリンクを含む）/ Expected: PASS
- [ ] **Step 3: README の確認コマンドを順に実行する** — Run: `npm ci && npm run typecheck && npm run lint && npm run build && npm run package && npm run verify:zip && npm test && npm run test:packaging && npm run infra:check && npm run audit:runtime && npm run audit:all` / Expected: すべて exit 0。`npm test` の最後の JSON が `complete: true`、`failed: 0`、`notRun: 0`。件数と unsupported の内訳を記録する
- [ ] **Step 4: Commit**

```bash
git add docs/operations/deployment.md README.md docs/operations/formal-e2e-coverage.md docs/operations/formal-e2e-results.md
git commit -m "docs: describe release custody in S3 and the reviewed digest flow"
```
