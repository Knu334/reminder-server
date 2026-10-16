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
- 利用期限は `registered-release` と `release-review` だけ。元の preview の `createdAt` から24時間（`now >= expiresAt` で失効）。`createdAt` が `now` より5分以上未来なら拒否（5分未満は通す）。期限を引き継いだ bundle の `expiresAt` は元の値と完全に一致しなければ拒否。
- 入力 `expected_review_sha256` は「元の preview の `release-review/.../manifest.json` の SHA-256（16進数64桁）」。apply と ZIP 再利用 preview の両方で必須。
- 取り出したファイルはディレクトリ 0700、ファイル 0600。ファイル名に `/`・`\`・`..` を含むもの、symlink は拒否。
- GitHub の artifact を一切使わない（`ci.yml` の private 時だけの診断を除く）。ledger を標準出力に出さない。
- 文書は日本語、汎用の内容。実 AWS の操作、GHA の手動実行、push はしない。stage は path を明示する。

## Review Focus

1. 一部の job だけを再実行し、`needs.<job>.outputs` の custody の場所が欠けたとき、読む job（plan と apply の両方）は止まり、自分の `run_attempt` で推測して読まない（plan は Task 3、apply は Task 4 に試験）。
2. `reviewed_run` の plan の job が run の最新の試行と違う試行で成功しているとき、plan の job の成功した試行の `run_attempt` を読む（Task 2 に試験）。
3. lifecycle の失効の後に同じ key へ同じ内容の manifest を作り直されたとき、SHA-256 は一致しても利用期限で止まる（Task 1 に試験）。
4. runner の時計のずれ: `createdAt` が5分未満の未来なら通り、ちょうど5分以上で止まる（Task 1 に試験）。
5. plan・apply が失敗したとき、標準出力・標準エラー・job summary に合成 fixture の秘密の値（入力の値、API URL、ARN）が出ない（plan は Task 3、apply は Task 4 に、`workflowMain` の CLI 境界での試験）。

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
  - `writeCustody(store: CustodyStore, location: CustodyLocation, directory: string, fields: Pick<CustodyManifest, "root" | "planReviewSha256" | "custodySha256" | "sourceManifestSha256" | "expiresAt">, now: Date, options?: { initialPlatform?: boolean }): Promise<{ manifestSha256: string; manifestSha256Base64: string }>`（`directory` のファイル集合を `requiredFiles(kind, root, options)` と完全一致で検査してから書く）
  - `readCustody(store: CustodyStore, location: CustodyLocation, expectedManifestSha256: string, destination: string, expected: { root: ReleaseRoot | null; now: Date; initialPlatform?: boolean; inheritedExpiresAt?: string }): Promise<CustodyManifest>`
  - `assertUsable(manifest: CustodyManifest, now: Date, inheritedExpiresAt?: string): void`（利用期限の検査。`inheritedExpiresAt` が無ければ `expiresAt === createdAt + 24h` を要求し、あれば `expiresAt === inheritedExpiresAt` を要求する。apply の直前にも呼ぶ）

期限の継承元: apply 経路の plan job は、元の preview の検証済み manifest の `expiresAt` を新しい `release-review` の `fields.expiresAt` に入れる。plan job が元の manifest を読むときは継承が無い（元の preview 自体は `createdAt + 24h`）。apply job は、まず元の preview の `manifest.json` だけを `reviewed_run`・`reviewed_attempt` の場所から取得し、その SHA-256 が `EXPECTED_REVIEW_SHA256` と一致することを確かめる（`readOriginalManifest(store, location, expectedManifestSha256): Promise<CustodyManifest>`、Task 1 で `custody.ts` に置く。ファイルは取り出さない）。その `expiresAt` を `inheritedExpiresAt` として同じ run の `release-review` の `readCustody` に渡し、その `planReviewSha256` が同じ run の manifest の値と一致することも確かめる。ZIP 再利用 preview の新しい manifest は継承しない。
  - `readOriginalManifest(store: CustodyStore, location: CustodyLocation, expectedManifestSha256: string): Promise<CustodyManifest>`（`manifest.json` だけを取得し、SHA-256・zod・location の一致を確かめる。期限は検査しない）
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
void test("expiry_boundaries", ...)  // createdAt+24h ちょうどで reject、23:59:59 で通る、createdAt=now+4min59s 通る、now+5min ちょうどで reject、不正な日時 reject、expiresAt≠createdAt+24h（引き継ぎ無し）reject
void test("inherited_expiry_must_match_original", ...)  // inheritedExpiresAt と一致すれば createdAt+24h と違っても通る、1秒でも違えば reject、継承期限を過ぎていれば reject
void test("write_requires_initial_platform_file_set", ...)  // release-result: initialPlatform なら ledger.json+post-baseline.json が必須、そうでなければ ledger.json だけ（post-baseline.json が余分にあれば reject）
void test("read_original_manifest_checks_digest_without_extracting", ...)
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
  - 既存の `checkCustody(c)` を `checkCustody(directory: string, root: ReleaseRoot, expectedCustodySha256?: string): Promise<void>` に変え、今の run の directory と、取り出した元の bundle の directory の両方に使う。
  - `planRelease(c, config, source: { location: CustodyLocation; manifestSha256: string } | undefined, services): Promise<{ manifestSha256: string; manifestSha256Base64: string; planReviewSha256: string }>`
  - `workflowMain` の phase に `register-custody`（register job の最後に `$RUNNER_TEMP/registered` を `registered-release` として書き、`GITHUB_OUTPUT` に `custody_run_id`、`custody_attempt`、`custody_manifest_sha256` を出す）を加える。
  - plan phase の `GITHUB_OUTPUT`: `custody_run_id`、`custody_attempt`、`custody_manifest_sha256`、`review_sha256`（= manifest の SHA-256）。
  - 環境変数: `CUSTODY_BUCKET`、`GITHUB_RUN_ID`、`GITHUB_RUN_ATTEMPT`、`SOURCE_RUN_ID`・`SOURCE_ATTEMPT`・`SOURCE_MANIFEST_SHA256`（同じ run の register の output、または `reviewed_run`・`reviewed_attempt`・`EXPECTED_REVIEW_SHA256`）。`SOURCE_RUN_ID` は10進数、`SOURCE_ATTEMPT` は1以上の整数、`SOURCE_MANIFEST_SHA256` は16進数64桁でなければ、S3 を読む前・Terraform を実行する前に throw する（自分の `GITHUB_RUN_ATTEMPT` で代用しない）。

動作（仕様書「reviewed_run を使う2つの経路」と「3つの digest の区別」）:
- source が `registered-release` なら読み取って今の `readManifest`・`copyEvidence` に渡す。source が `release-review` なら `readCustody` の後に、仕様書「読み取りの手順」8 のとおり、元の bundle に対して今の `checkCustody`（`custody.json` と必須のファイルの集合）と `verifySavedPlan`（元の `saved.tfplan` の `terraform show -json` と元の `review.json`）を独立して行い、続けて今の preview の確認（`preview.json`、root、commit、artifact）を行う。apply 経路と ZIP 再利用 preview の両方で行う。
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
void test("original_bundle_with_valid_manifest_but_bad_inner_custody_is_rejected", ...)  // manifest と各ファイルの hash は整合、custody.json だけ不正 → apply・ZIP 再利用とも reject
void test("original_bundle_with_saved_plan_not_matching_review_is_rejected", ...)        // saved.tfplan と review.json の対応が不正 → apply・ZIP 再利用とも reject、terraform plan を呼ばない
void test("plan_rejects_missing_or_malformed_source_outputs_before_s3_or_terraform", ...) // SOURCE_* の欠落・不正形式で store.get も terraform も呼ばれない。register が attempt 1、plan が attempt 2 のとき SOURCE_ATTEMPT=1 を読む
void test("register_custody_outputs_location_and_manifest_digest", ...)
void test("plan_summary_lists_only_allowed_fields", ...)                          // summary に inputs の値・ARN・URL が無い
void test("plan_failure_leaks_no_fixture_values_at_cli_boundary", ...)            // Review Focus 5：workflowMain の plan phase で合成の terraform 失敗を起こし、stdout・stderr・GITHUB_STEP_SUMMARY のどれにも入力の値・API URL・ARN が無い
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
  - apply phase は `REVIEWED_RUN_ID`・`REVIEWED_ATTEMPT`・`EXPECTED_REVIEW_SHA256` も必須とする（`inputs.reviewed_run`、`needs.authorize.outputs.reviewed_attempt`、`inputs.expected_review_sha256`）。
  - `applyRelease` は `readOriginalManifest`（元の preview）→ `readCustody`（同じ run の `release-review`、`inheritedExpiresAt` = 元の `expiresAt`）→ 同じ run の manifest に `sourceManifestSha256` が無いこと、`planReviewSha256` が元の manifest と一致することを確かめる → `checkCustody(directory, root, manifest.custodySha256)`・`verifySavedPlan` → `assertUsable(manifest, now(), 元の expiresAt)` を apply の直前に呼ぶ → apply → `release-result` 用の別ディレクトリに `ledger.json` と、初回の platform（`root === "platform" && baseline === null`）のときだけ `post-baseline.json` を置き、`writeCustody(..., { initialPlatform })`。
  - 今の `workflow.ts:129` の `manifest.reviewSha256 !== c.expectedReviewSha256` は、`review.json` の `reviewSha256` と検証済み manifest の `planReviewSha256` の比較に置き換える（入力の値は manifest の digest なので、plan の digest とは比べない）。
  - `diagnostics` phase の job 名は GHA が自動で設定する `GITHUB_JOB` から読む（`deploy.yml` に `JOB` は足さない）。`GITHUB_JOB` が無ければ throw。
  - `workflowMain` の apply phase は ledger を標準出力に出さない。job summary には root、commit、`result`、`release-result` の run ID と `run_attempt` だけを書く。
  - `diagnostics` phase: `$RUNNER_TEMP/release-diagnostics/*.json` と `$RUNNER_TEMP/infra-diagnostics/*.json` を `failure-diagnostics/<run_id>/<run_attempt>/<GITHUB_JOB>/` に書く。ファイルが無ければ何もしない。失敗しても exit code は 0 にせず、呼び出し側の step は `continue-on-error` にしない（job は元から失敗している）。

- [ ] **Step 1: 失敗する試験を書く**

```ts
void test("apply_reads_plan_job_location_and_rejects_missing_outputs", ...)     // Review Focus 1
void test("apply_rechecks_expiry_immediately_before_terraform_apply", ...)      // now を apply 直前に失効させると terraform apply が呼ばれない
void test("apply_accepts_three_distinct_digests", ...)                            // 入力（元の manifest の SHA-256）、同じ run の manifest の SHA-256、plan の digest がすべて違う値の正常ケースが通る
void test("apply_rejects_inherited_expiry_changed_or_reuse_bundle", ...)          // 同じ run の manifest の expiresAt が元と1秒違う、または sourceManifestSha256 がある → reject、terraform apply を呼ばない
void test("apply_rejects_plan_digest_differing_from_original_manifest", ...)
void test("apply_writes_ledger_and_initial_platform_baseline_to_release_result", ...)  // 初回の platform は ledger.json+post-baseline.json、既存の platform と application は ledger.json だけ
void test("apply_never_writes_ledger_or_fixture_values_to_stdout_or_stderr", ...)  // Review Focus 5：workflowMain の apply phase を、成功と合成の失敗（terraform apply の失敗、verify の失敗）の両方で実行し、stdout・stderr・GITHUB_STEP_SUMMARY のどれにも入力の値・API URL・ARN・ledger が無い
void test("diagnostics_phase_uses_github_job_and_requires_it", ...)
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
- apply job: `PLAN_CUSTODY_*` を `needs.plan.outputs` から、`REVIEWED_RUN_ID`・`REVIEWED_ATTEMPT`・`EXPECTED_REVIEW_SHA256` を `inputs.reviewed_run`・`needs.authorize.outputs.reviewed_attempt`・`inputs.expected_review_sha256` から渡す（apply job の `needs` に `authorize` が無ければ足す）。`EXPECTED_CUSTODY_SHA256` を削除する。
- 各 AWS job の最後に `if: failure()` で `diagnostics` phase を実行する step を置く（assume が成功したときだけ意味がある。assume 前の失敗では認証が無く S3 に書けないので、step は失敗してよい）。authorize job には置かない。
- `CUSTODY_BUCKET: ${{ vars.CUSTODY_BUCKET }}` を workflow の `env` に足す。入力 `expected_review_sha256` と `reviewed_run` の description を「元の preview の manifest の SHA-256。apply と ZIP 再利用に必要」に直す。

- [ ] **Step 1: 失敗する試験を書く**

```ts
void test("deploy_uses_no_github_artifacts_or_visibility_gate", ...)   // upload-artifact/download-artifact/repository.private が deploy.yml に無い
void test("custody_runs_only_after_role_assumption", ...)              // register/plan/apply の各 job で configure-aws-credentials の index < release:workflow の register-custody/plan/apply の index、failure 時の diagnostics はその後
void test("custody_location_flows_through_job_outputs", ...)           // plan の env が needs.register.outputs と needs.authorize.outputs.reviewed_attempt を参照、apply の env が needs.plan.outputs.custody_* と needs.authorize.outputs.reviewed_attempt・inputs.reviewed_run・inputs.expected_review_sha256 を参照。deploy.yml に JOB の env が無い
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

既存の `maximum_bucket_name_keeps_policies_in_aws_limits` に、custody bucket 名が63文字以内であることの assert を足す。

既存の assertion のうち、次の3つ（今の `bootstrap.tftest.hcl` の80・84・92行目付近）は custody の statement を拒否するので書き換える。既存の制限は保ち、custody bucket の上の表の prefix だけを例外にする。
- artifact role は ZIP の prefix だけ（error_message "Registration only reads/writes the release ZIP prefix."）→ ZIP の prefix に加え、`WriteRegisteredCustody`・`WriteFailureDiagnostics` の Resource（`PutObject` だけ）を許す。
- plan role の `PutObject` は state の lockfile だけ（"Plan may write only the two production state lockfiles."）→ lockfile に加え、custody の `release-review/*`・`failure-diagnostics/*` を許す。`length(s.Resource) == 2` の lockfile の statement は残す。
- 全 role の `GetObject`・`PutObject` の Resource が既存の一覧に入る、の assertion → 一覧に custody の4つの prefix の ARN を足す。`required_gateway_logging_and_iam_size` の IAM のサイズの上限も通ること。

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
- Modify: `scripts/e2e/terraform.ts:116`（所有を確かめる bucket の一覧に `custody`）
- Modify: `scripts/e2e/terraform.ts:265`（`withTerraformTransport` に渡す、通信を許す bucket の一覧に `custody`）
- Modify: `scripts/e2e/terraform.ts:477`（構築後の検査の `buckets.length === 3`・`versions.length === 3`・`policies.length === 3` を4に。`state`・`artifacts`・`custody`・`images`）
- Modify: `tests/e2e/floci/support/evidence.ts:51`（所有を記録してよい bucket に `custody`）
- Modify: `tests/e2e/floci/support/fixture.ts:101`（`readDeployedSettings` の bucket の設定の読み戻しに `custody` と lifecycle）
- Modify: `tests/e2e/floci/support/expected-iam.ts:56`（bucket policy の期待値に `custody`）
- Modify: `scripts/e2e/terraform-source.ts`（`publicFiles.bootstrap` に新しいファイルがあれば追加。Task 6 が既存ファイルだけを変えるなら変更なし）
- Test: `tests/integration/formal-e2e/*.test.ts`、`tests/e2e/floci/*.test.ts`

新しい case は作らない。custody bucket の設定の確認は、既存の case `TF-03/settings`（`runFixturePrerequisites` が `readDeployedSettings` を実行する）の s3 の assertion `version-encryption-public-block-lifecycle-cors-policy-pinned-zip` に含める。case の一覧と結果の文書の行は変わらないので、`coverage.test.ts` の1対1の検査はこの Task では変わらない。

**Interfaces:**
- Consumes: Task 6 の `custody_bucket` output と bucket 設定

- [ ] **Step 1: 失敗する試験を書く** — `tests/e2e/floci/fixture.test.ts` などの harness 試験に「bootstrap の bucket 一覧が `state`・`artifacts`・`custody` で、`readDeployedSettings` が custody の versioning・暗号化・PAB・lifecycle・policy を読み戻し、どれか1つが違えば `TF-03/settings` が fail する」assert を足す。terraform.ts の通信許可の一覧と構築後の検査が4 bucket を前提にすることも assert する。
- [ ] **Step 2: 失敗を確かめる** — Run: `npm run test:integration:e2e && npm run test:e2e:harness` / Expected: FAIL
- [ ] **Step 3: 実装する**（清掃は既存の「policy を外し、全 version と delete marker を消してから destroy」をそのまま custody bucket に適用する）
- [ ] **Step 4: 通ることを確かめる** — Run: `npm run test:integration:e2e && npm run test:e2e:harness` / Expected: PASS
- [ ] **Step 5: Commit**

```bash
git add scripts/e2e tests/e2e tests/integration/formal-e2e
git commit -m "test(e2e): cover the release custody bucket on Floci"
```

### Task 8: custody のモジュールを Floci で動かす case

**Files:**
- Create: `tests/e2e/floci/support/custody-cases.ts`
- Modify: `tests/e2e/floci/support/evidence.ts`（互換性の理由 `conditional-write-unsupported` の登録）、`tests/e2e/floci/support/cases.ts`（`measurementUnsupportedReasons` の型と値に `conditional-write-unsupported` を足す）、`scripts/e2e/run.ts`（`import '../../tests/e2e/floci/support/custody-cases.ts'` を既存の `storage-cases.ts` の import の隣に足す）
- Modify: `docs/operations/formal-e2e-coverage.md`（要件の表に新しい行 `REL-01`。release custody の S3 の書き込みと読み取り、条件付き書き込み）、`tests/integration/formal-e2e/coverage.test.ts`（`coverageIds.size` を 69 から 70 に）
- Modify: `docs/operations/formal-e2e-results.md`（2つの case の行を `not-run`、理由 `implementation-pending` で足し、件数を更新する。Task 9 で実測の結果に書き換える）
- Test: `tests/e2e/floci/custody.test.ts`（harness の試験）

実行の経路: `custody-cases.ts` は既存の `storage-cases.ts` と同じ形にする。`definitions` に2つの定義（suite `custody`）を push し、`caseActions.set(id, action)` で action を登録する。`run.ts` は `caseActions` にある case を既存の `executeSuites` で実行するので、runner の分岐は足さない。条件付き書き込みの case は `caseMeasurements` にも登録し、Floci が2回目の書き込みを受け入れたときは `measurementUnsupportedReasons` の `conditional-write-unsupported` で unsupported にする。

**Interfaces:**
- Consumes: Task 1 の `writeCustody`・`readCustody`・`createS3CustodyStore`、Task 7 の custody bucket
- Produces: case `REL-01/custody-roundtrip`（required、layer L）と `REL-01/custody-conditional-write`（互換性、`unsupported` の理由 `conditional-write-unsupported`）

- [ ] **Step 1: 失敗する試験を書く**

```ts
void test("roundtrip_case_fails_on_transport_or_auth_errors_not_unsupported", ...)
void test("conditional_write_case_records_only_registered_reason", ...)   // 理由が conditional-write-unsupported 以外の unsupported は fail、既定の signature-enforcement-unsupported は使わない
void test("custody_cases_are_registered_with_requirements", ...)          // definitions に2件、caseActions.has(id) が true、requirementId が REL-01
void test("custody_cases_are_executed_by_the_runner", ...)                // fake の evidence で run.ts の suite 実行を通し、2つの id に not-run 以外の結果が付く（tests/e2e/floci/storage.test.ts の selected の試験と同じ形）
```

`coverage.test.ts` の1対1の検査は、この Task の結果の文書の行で通る。

- [ ] **Step 2: 失敗を確かめる** — Run: `npx tsx --test tests/e2e/floci/custody.test.ts` / Expected: FAIL
- [ ] **Step 3: 実装する**（roundtrip: release-review 相当の合成ファイルを書き、manifest の SHA-256 で読み、hash を照合する。conditional write: 同じ key への2回目の `PutObject`（`IfNoneMatch: "*"`）が拒否されれば pass、Floci が受け入れれば測定結果付きで unsupported）
- [ ] **Step 4: 通ることを確かめる** — Run: `npx tsx --test tests/e2e/floci/custody.test.ts && npm run test:e2e:harness && npm run test:integration:e2e` / Expected: PASS
- [ ] **Step 5: Commit**

```bash
git add tests/e2e/floci/support/custody-cases.ts tests/e2e/floci/support/cases.ts tests/e2e/floci/support/evidence.ts scripts/e2e/run.ts tests/e2e/floci/custody.test.ts tests/integration/formal-e2e/coverage.test.ts docs/operations/formal-e2e-coverage.md docs/operations/formal-e2e-results.md
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
- [ ] **Step 3: README の確認コマンドを順に実行する** — Run: `npm ci && npm run typecheck && npm run lint && npm run build && npm run package && npm run verify:zip && npm test && npm run test:packaging && npm run infra:check && npm run audit:runtime && npm run audit:all && npm sbom --sbom-format cyclonedx > artifacts/sbom.json` / Expected: すべて exit 0。`artifacts/sbom.json` などの生成物は stage しない。`npm test` の最後の JSON が `complete: true`、`failed: 0`、`notRun: 0`。件数と unsupported の内訳を記録する
- [ ] **Step 4: Commit**

```bash
git add docs/operations/deployment.md README.md docs/operations/formal-e2e-coverage.md docs/operations/formal-e2e-results.md
git commit -m "docs: describe release custody in S3 and the reviewed digest flow"
```
