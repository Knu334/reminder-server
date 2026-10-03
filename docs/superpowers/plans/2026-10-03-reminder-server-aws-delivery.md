# Reminder Server AWS Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 自己完結したLambda ZIPと、公開URL・認証・データを守るTerraform/GHAの配布手順、運用文書を作る。

**Architecture:** ビルドした同じZIPをchecksum付き条件Putで専用S3へ登録し、versionId/hashをTerraformへ渡す。bootstrap/platform/applicationの3stateに分け、通常リリースの保存済みplanを保護検査してから手動applyする。静的・mock検証とproduction適用後の限定smokeを分離する。

**Tech Stack:** esbuild、Node24/CommonJS、Python3.13標準ライブラリ、AWS SDK v3、Terraform1.16.5、AWS Provider6.67.0、GitHub Actions。

**Spec:** [承認済みAWS設計](../specs/2026-10-02-reminder-server-aws-design.md) §3・§4・§6・§9〜§15、[全体計画](2026-10-03-reminder-server-aws.md)、[runtime](2026-10-03-reminder-server-aws-runtime.md)、[operations](2026-10-03-reminder-server-aws-operations.md)。

## Global Constraints

- `.devcontainer`は変更しない。常設環境はproductionのみ。実AWS/GHA実行は本計画のローカル実装時に行わない。
- Lambdaは`Zip`/`nodejs24.x`/`x86_64`、handler `dist/api.handler`/`dist/cleanup.handler`。同じZIPを2関数へ適用する。
- ZIPはdist/*.js、*.js.map、THIRD_PARTY_NOTICESのみ。node_modules、元JSON、.env、運用スクリプト、テストは収録しない。minify/難読化なし。
- 圧縮50 MB未満、展開250 MB未満。ZIP bytesのSHA-256 hex/Base64、S3 key/versionId、Lambda CodeSha256を一致させる。
- API512 MiB/10秒/concurrency10、清掃512 MiB/660秒/concurrency1、Gateway integration15秒/stage20rps/burst40。
- Cognito Essentials・コンソール管理、公開code/PKCE client、access/ID5分・refresh30日・rotation猶予10秒。read/write scopeを分ける。
- S3 stateロック`use_lockfile`、3つの別バケット、PITR35日/非現行画像60日/ログ30日。9アラームと独自metric2個。
- Scheduler `cron(0 3 * * ? *)`/`UTC`/window`OFF`、初回`DISABLED`。Scheduler配信/Lambda非同期は各retry2回/event age3600秒。
- OIDCはGHA→AWS、contents:readが既定、id-token:writeはAWS jobだけ、外部Actionは確認済み完全SHA、applyは途中キャンセルしない。
- ECR/Caddy/本番Docker/常設dev/管理CLI/maintenance workflowを作らない。state/plan/資格情報をログ・Git・公開artifactへ含めない。

## Review Focus

1. ZIPの余分な親dir・dynamic dependency・symlink・mtime差で、Lambdaがロード不能または別hashにならない（D01）。
2. 同じS3 keyが異なるbytes/checksumだった場合、既存物を成果物として再利用しない（D02）。
3. API/pool/clientのblock削除・replacementとunknown outputsを通常リリースで見逃さない（D06）。
4. plan/apply間のコミット・artifact・inputs変更やalias不一致を成功と扱わない（D06/D07）。
5. 秘密ファイルuntrackでローカルを消さず、未対応hookを有効な保護と説明しない（D08）。

---

## ファイル・値・外部資料

Terraformは3rootの各`versions.tf`, `backend.tf`, `variables.tf`, `outputs.tf`と責務別`.tf`を使い、大きな共通moduleを作らない。state keyは`bootstrap/terraform.tfstate`、`production/platform/terraform.tfstate`、`production/application/terraform.tfstate`。各rootでregion/accountIdを明示検証し、S3 backend値は公開可能な`backend.hcl.example`へテンプレートだけ置く。

platform→applicationの入力はtable名/ARN・image bucket名/ARN・API/cleanup role ARN・log group名・issuer/client ID/auth domain。`terraform_remote_state`で別rootの全state読み取りを必須にせず、GHAが許可されたoutputだけをprivate inputファイルへ渡す。AWSアカウント/region/GitHub OIDC subject/origin/callback/ZIP識別子は必須入力。production alias名は両関数とも`production`、stageは`$default`。

2026-10-03のContext7と公式tag資料で`code_sha256`、Cognito rotation/validity unitsを確認した。実装時にProvider6.67.0のschemaを確認し、3rootのlockをlinux_amd64/linux_arm64で固定する。指定版に必要fieldが存在しなければ依存更新を明示し、`source_code_hash`のみの検証へ後退しない。

- [AWS Provider6.67.0 Lambda: code_sha256](https://github.com/hashicorp/terraform-provider-aws/blob/v6.67.0/website/docs/r/lambda_function.html.markdown)
- [AWS Provider6.67.0 Cognito app client](https://github.com/hashicorp/terraform-provider-aws/blob/v6.67.0/website/docs/r/cognito_user_pool_client.html.markdown)
- [Terraform1.16.5 release](https://releases.hashicorp.com/terraform/1.16.5/)

### Task D01: esbuild・再現可能ZIP・展開後handler検証

**Files:** Create `scripts/build/bundle.ts`, `scripts/build/notices.ts`, `scripts/build/package.py`, `scripts/build/verify-zip.ts`, `tests/packaging/test_package.py`, `tests/delivery/bundle.test.ts`; Modify `package.json`, `package-lock.json`; Delete `tsup.config.ts`, `nodemon.json`, `Dockerfile`, `docker-compose.yml`。

**Interfaces:** Consumes runtime `src/api.ts`/`src/cleanup.ts`、operationsはZIP対象外。Produces `bundle(): Promise<void>`、`writeNotices(metafilePath: string, lockPath: string, destination: string): Promise<void>`、Python `create_package(root: Path, destination: Path) -> dict`、`verifyZip(path: string): Promise<ArtifactIdentity>`。ArtifactIdentityは`{sha256Hex: string; sha256Base64: string; compressedBytes: number; unpackedBytes: number}`。出力は`dist/api.js`, `dist/cleanup.js`, `.js.map`, `dist/meta.json`（metaはZIP対象外）、`artifacts/reminder-server.zip`, `artifacts/zip-manifest.json`, `artifacts/sbom.json`（SBOMはZIP対象外）。bundleは4つのJS/mapだけを`artifacts/staging/dist/`へコピーし、noticesを`artifacts/staging/THIRD_PARTY_NOTICES`へ生成する。package.pyのCLI既定rootは`artifacts/staging/`、destinationは`artifacts/reminder-server.zip`。SBOMは固定npmの`npm sbom --sbom-format cyclonedx`で生成する。

- [ ] **Step 1: RED試験を書く。** Python `test_same_bytes_despite_input_mtime`、`test_rejects_path_traversal_symlink_and_extra_entries`、`test_sizes_hash_modes_and_root_layout`、Node `unpacked_handlers_run_without_node_modules`を作る。

  ```python
  self.assertEqual(first_zip.read_bytes(), second_zip.read_bytes())
  self.assertEqual(names, ['THIRD_PARTY_NOTICES', 'dist/', 'dist/api.js', 'dist/api.js.map', 'dist/cleanup.js', 'dist/cleanup.js.map'])
  self.assertEqual(manifest['sha256Hex'], hashlib.sha256(first_zip.read_bytes()).hexdigest())
  self.assertLess(manifest['compressedBytes'], 50_000_000)
  self.assertLess(manifest['unpackedBytes'], 250_000_000)
  ```

  Node試験は元repoと別の一時directoryへZIPを展開し、NODE_PATHを空にしてNode24でrequireし、両moduleのhandler exportを確認する。同じbundleからexportしたcreateApiHandler/createCleanupHandlerへfake portsを渡し、APIのhealth200/ready503と非公開清掃skipを模擬イベントで実行する。実SDKを起動して公開gateを読む代わりに注入したportsを使い、AWS call0をassertする。source mapとnoticeに各bundle依存のlicenseがあること、esbuild metafileに外部非builtinがないことをassertする。
- [ ] **Step 2: Run `python3 -m unittest discover -s tests/packaging -v`、`npx tsx --test tests/delivery/bundle.test.ts` → FAIL。** Python3.13はローカルならuvで用意できる。Node25しかない現環境をNode24のGREENとみなさない。
- [ ] **Step 3: ビルドとZIP関数を実装する。** esbuildはbundle/platform=node/format=cjs/target=node24/sourcemap=external/sourcesContent=false/minify=false、Node組み込み以外をbundleする。固定依存licenseをnoticesへまとめる。ZIP entryを名前順、UTC1980-01-01 00:00:00、通常file644/directory755へ固定し、余分な親dir・absolute/`..`・symlinkを拒否する。Python zipfileとhashlibを使用し、入力をallowlistで限定する。同じbytesからhex/Base64を計算してmanifestへ記録する。
- [ ] **Step 4: scriptsと旧ビルド撤去を仕上げる。** `build=tsx scripts/build/bundle.ts`、`package=python3 scripts/build/package.py`、`verify:zip=tsx scripts/build/verify-zip.ts artifacts/reminder-server.zip`、`test:packaging=python3 -m unittest discover -s tests/packaging -v`。Node24 engines/CI方針を設定し、tsup/nodemonとDocker用手順を撤去する。
- [ ] **Step 5: 検証する。** Run `npm run build`、`npm run package`、`npm run test:packaging`、`npm run verify:zip`、`npx tsx --test tests/delivery/bundle.test.ts` → PASS、5file+dist directory・両handler実行・hash一致を報告する。
- [ ] **Step 6: `git add scripts/build tests/packaging tests/delivery/bundle.test.ts package.json package-lock.json tsup.config.ts nodemon.json Dockerfile docker-compose.yml` → `git commit -m "build: produce reproducible self-contained Lambda ZIP"`。**

### Task D02: 条件付きS3登録と成果物識別子の照合

**Files:** Create `scripts/release/artifact.ts`, `tests/delivery/artifact.test.ts`; Modify `package.json`, `package-lock.json`。

**Interfaces:** Consumes D01 ArtifactIdentity。Produces `registerArtifact(zip: Uint8Array, bucket: string, client: S3Client): Promise<RegisteredArtifact>`、`readRegisteredArtifact(input: RegisteredArtifact, client: S3Client): Promise<void>`。RegisteredArtifactは`ArtifactIdentity & {bucket: string; key: string; versionId: string; commit: string}`。release manifestはcommit/Node/npm/esbuild版、ZIP/hash/versionId、監査・SBOM・試験結果の識別を持つ。JSONは配布manifest用途のみで、リマインダー保存用JSONを復活させない。

- [ ] **Step 1: RED試験を書く。** `puts_once_with_conditional_checksum`、`existing_release_requires_server_checksum_and_version`、`mismatched_checksum_never_reused`、`transient_conflict_retry_is_bounded`。

  ```ts
  assert.equal(put.IfNoneMatch, '*'); assert.equal(put.ChecksumSHA256, expected.sha256Base64);
  assert.equal(put.Key, `releases/${expected.sha256Hex}/reminder-server.zip`);
  assert.equal(head.ChecksumMode, 'ENABLED'); assert.equal(result.versionId, 'synthetic-version');
  await assert.rejects(() => reuseWithWrongChecksum());
  ```

  command spyで単一Put、412時HEAD照合、409の限定再試行、version/checksum欠落、hex/Base64不一致、S3 ETagだけでは照合成功にしない、DeleteObject/Downloadなしをassertする。
- [ ] **Step 2: Run `npx tsx --test tests/delivery/artifact.test.ts` → FAIL。** 登録処理の未定義を確認する。
- [ ] **Step 3: 登録・再利用関数を実装する。** ZIP bytesからidentityを再計算し、key/version/checksum一致を要求する。既存物はchecksum付きHeadObjectで現在versionと照合してversionId固定。結果不明は同じkeyをHEADし、確定できなければ失敗にする。retryは3attemptまで、bucket/region/commitは明示入力。`release:register` scriptを追加するが実AWSで実行しない。
- [ ] **Step 4: Run `npx tsx --test tests/delivery/artifact.test.ts`、`npm run typecheck` → PASS。** 元bytes違いと結果不明のnegative casesも確認する。
- [ ] **Step 5: `git add scripts/release/artifact.ts tests/delivery/artifact.test.ts package.json package-lock.json` → `git commit -m "feat: register immutable checksum-verified release artifacts"`。**

### Task D03: bootstrapのS3 state/成果物/OIDC基盤

**Files:** Create `.terraform-version`, `infra/bootstrap/versions.tf`, `backend.tf`, `variables.tf`, `storage.tf`, `oidc.tf`, `outputs.tf`, `backend.hcl.example`, `terraform.tfvars.example`, `.terraform.lock.hcl`, `tests/bootstrap.tftest.hcl`（以上`infra/bootstrap/`配下）、`scripts/release/infra-check.ts`; Modify `package.json`。

**Interfaces:** Consumes明示accountId/region/repository/実際のOIDC subject/environment/名前prefix。Produces outputs `state_bucket`, `artifact_bucket`, `artifact_role_arn`, `plan_role_arn`, `apply_role_arn`。Terraform required_versionは`=1.16.5`、AWS providerは`=6.67.0`。backendは3rootともS3・use_lockfile、初回bootstrapだけlocal stateからの移行手順を使う。

- [ ] **Step 1: `bootstrap.tftest.hcl`へmock provider/planのRED試験を書く。** `private_versioned_buckets`、`trust_is_exact_oidc_subject`、`roles_cannot_delete_artifacts_or_manage_cognito_users`を定義する。

  ```hcl
  assert {
    condition = aws_s3_bucket.artifacts.force_destroy == false
    error_message = "Release bucket must retain versions."
  }
  ```

  versioning/encryption/public block/TLS policy、ZIP bucketの条件Put要求、artifact prefix-only Put/Get・Delete禁止、state key/lockfile限定権限、aud=`sts.amazonaws.com`と明示sub（wildcard禁止）、plan/apply/登録role分離をassertする。plan roleのstate lock書込を許可し、read-onlyと表示しない。provider schemaのcode_sha256存在もinfra-checkで検査する。
- [ ] **Step 2: Run `terraform -chdir=infra/bootstrap init -backend=false`、`terraform -chdir=infra/bootstrap test -filter=tests/bootstrap.tftest.hcl` → FAIL。** REDでは不足resource/assertが原因であり、AWS認証エラーを試験失敗の代わりにしない。
- [ ] **Step 3: bootstrapの設定とroleを実装する。** state/ZIP bucketを分け、SSE-S3・versioning・TLS-only・public block・prevent_destroy・force_destroy=false。OIDCは明示subjectをStringEqualsで検査する。roleごとに必要API/IAMのscopeを分け、PassRoleは所定Lambda/Scheduler roleとPassedToService条件のみ。create/list系でResource=`*`が必要な権限は理由を記載し、データ操作/利用者管理/直接API invokeをGHAへ付けない。実際のsubject未入力ならvalidation error。
- [ ] **Step 4: lockと静的検証scriptを追加する。** 各rootで`terraform providers lock -platform=linux_amd64 -platform=linux_arm64`を実行しlockを追跡。`infra:check`は3rootへinit -backend=false -lockfile=readonly→validate→mock test、全infraのfmt -checkを実行する。まだ未作成rootは後続で追加し、このtaskはbootstrapのみのコマンドでGREENにする。
- [ ] **Step 5: 検証する。** Run `terraform -chdir=infra/bootstrap validate`、同mock test、`terraform fmt -check -recursive infra/bootstrap` → PASS。AWS apply/state移行は行わない。
- [ ] **Step 6: `git add .terraform-version infra/bootstrap scripts/release/infra-check.ts package.json` → `git commit -m "infra: define private state artifact storage and GitHub OIDC"`。**

### Task D04: productionのCognito・保存・実行role・ログ

**Files:** Create `infra/platform/production/versions.tf`, `backend.tf`, `variables.tf`, `cognito.tf`, `storage.tf`, `iam.tf`, `logs.tf`, `outputs.tf`, `backend.hcl.example`, `terraform.tfvars.example`, `.terraform.lock.hcl`, `tests/platform.tftest.hcl`。

**Interfaces:** Consumes D03 buckets/state key、runtime Configとtable/GSIキー。Produces `reminders_table`, `owner_state_table`, `image_jobs_table`とARN、`images_bucket`/ARN、`api_role_arn`, `cleanup_role_arn`, `api_log_group`, `cleanup_log_group`, `gateway_log_group`, `cognito_issuer`, `cognito_client_id`, `cognito_auth_base_url`。reminders/owner_state/image_jobsのkeyはruntime計画と厳密一致する。

- [ ] **Step 1: `platform.tftest.hcl`へRED試験を書く。** `cognito_is_console_managed_public_code_client`、`token_units_and_rotation_are_exact`、`storage_keys_retention_and_roles_match_runtime`を作る。

  ```hcl
  assert {
    condition = aws_cognito_user_pool_client.chrome.access_token_validity == 5 && aws_cognito_user_pool_client.chrome.token_validity_units[0].access_token == "minutes"
    error_message = "API token must be five minutes."
  }
  ```

  Essentials/admin-create-only/COGNITO、secret=false、codeだけ、implicit/client_credentials/REFRESH_TOKEN_AUTHなし、ID5minutes/refresh30days、rotation ENABLED/grace10/revocation、read/write resource scopes、完全callback/logoutをassertする。3DDBのオンデマンド/PITR35/削除保護、rateTTL、sparse GSI属性・KEYS_ONLY、S3version/noncurrent60・現行期限切れなし、30日logs、API/清掃権限分離も検査する。
- [ ] **Step 2: Run `terraform -chdir=infra/platform/production init -backend=false`、`terraform -chdir=infra/platform/production test -filter=tests/platform.tftest.hcl` → FAIL。** mock不足resourceの失敗を確認する。
- [ ] **Step 3: 保存・Cognito・role・logを実装する。** pool deletion_protection=ACTIVEとprevent_destroy、client prevent_destroy。ユーザーresource/secretは作らない。API roleはGet/Query/Put/Update等のtransactionに必要な対応IAM action、image Put/Get/GetObjectVersion、readinessに必要なbucket/table readとlogs。清掃roleはowner gate Getだけ、image_jobs/GSI/checkpoint read/update、画像Head/Delete marker、logs/Namespace限定PutMetricData。cleanupへreminders/owner状態のwrite・Cognito admin・DeleteObjectVersion・state/ZIP権限を付けない。S3 CORSは完全originとGET/HEAD、credentialsなし。SDK操作とIAM actionの対応を公式資料で確認し、存在しないIAM actionを推測で記載しない。
- [ ] **Step 4: Run `terraform -chdir=infra/platform/production providers lock -platform=linux_amd64 -platform=linux_arm64`、`terraform -chdir=infra/platform/production validate`、`terraform -chdir=infra/platform/production test -filter=tests/platform.tftest.hcl`、`terraform fmt -check -recursive infra/platform/production` → PASS。** issuer/client/domainだけをoutputし、username/password/tokenをstateへ持ち込まないことを確認する。運用者用の移行/復旧に必要な短期権限はdocsで区別し、API/GHA roleへ追加しない。
- [ ] **Step 5: `git add infra/platform/production` → `git commit -m "infra: define production Cognito persistence and least-privilege runtime roles"`。**

### Task D05: ZIP Lambda・JWT Gateway・Scheduler・9アラーム

**Files:** Create `infra/application/production/versions.tf`, `backend.tf`, `variables.tf`, `lambda.tf`, `gateway.tf`, `scheduler.tf`, `monitoring.tf`, `outputs.tf`, `backend.hcl.example`, `terraform.tfvars.example`, `.terraform.lock.hcl`, `tests/application.tftest.hcl`。

**Interfaces:** Consumes D02 RegisteredArtifact、D04 outputs、runtime Config。Produces outputs `api_base_url`, `api_id`, `api_alias_arn`, `cleanup_alias_arn`, `api_version`, `cleanup_version`, `release_sha256_base64`, `scheduler_enabled`。input `scheduler_enabled=false`をdefaultにし、heartbeat評価も同じ公開運用状態に合わせる。

- [ ] **Step 1: mock/plan RED試験を書く。** `both_functions_use_same_versioned_zip`、`jwt_routes_and_cors_are_exact`、`schedule_is_disabled_until_publication`、`nine_alarms_have_correct_missing_data_policy`。

  ```hcl
  assert {
    condition = aws_lambda_function.api.code_sha256 == aws_lambda_function.cleanup.code_sha256 && aws_lambda_function.api.s3_object_version == aws_lambda_function.cleanup.s3_object_version
    error_message = "Both handlers must use the selected immutable ZIP."
  }
  ```

  handler/runtime/architecture、publish/production alias、2functions/10秒・660秒/reserved10・1、gatewayintegration15秒/20rps・burst40、$default/endpoint有効/API・stage prevent_destroy、scope/readwrite/healthready旧410routes/OPTIONS無認証、CORS完全origin/headers/ETag Location X-Request-Id Retry-After expose/credentials=falseを検査する。Scheduler trust SourceAccount/SourceArn group、target cleanup aliasのみ、日次UTC/windowOFF/2retry3600、別Lambda非同期2retry3600、Function URLなしをassertする。
- [ ] **Step 2: Run `terraform -chdir=infra/application/production init -backend=false`、`terraform -chdir=infra/application/production test -filter=tests/application.tftest.hcl` → FAIL。** resource不足でREDを確認する。
- [ ] **Step 3: application設定を実装する。** ZIPのbucket/key/versionId/code_sha256を両関数へ渡してpublish=true、production aliasをGateway/Schedulerへ接続。invoke許可はAPI/stage/aliasに限定、function URLなし、API directinvokeを保守/GHAに付けない。gateway JWT issuer/audience/client IDとroute scopeを設定する。v2だけにauthorizerを付け、旧POST/PUT /remindersは410handler用route、OPTIONSはGateway CORSで処理する。Scheduler roleのSourceArnはschedule groupで検査し、Lambda async configはcleanup production aliasへ設定する。
- [ ] **Step 4: monitoringとGREENを仕上げる。** 9alarmはGateway5xx、API Errors/Throttles/Duration p95>2000ms、cleanup Errors/AsyncEventsDropped、CleanupIncomplete、Scheduler InvocationDroppedCount、CleanupHeartbeat欠落。エラー系はperiod300/evaluation1/threshold>=1/missing notBreaching、duration period300/evaluation2/threshold>2000/低sample percentile ignore。custom metricはEnvironment=production、incompleteはperiod3600/Maximum>=1、heartbeatはperiod86400/Sum<1/missing breaching。schedule無効中はheartbeat alarmのactions無効・missing notBreachingとして評価停止を明示し、有効化と同時にbreachingへ切替。Schedulerは専用group dimension、route詳細metricは無効、SNS追加なし。
- [ ] **Step 5: 検証する。** Run `npm run infra:check` → 3rootのfmt/validate/mock PASS。
- [ ] **Step 6: `git add infra/application/production` → `git commit -m "infra: wire ZIP handlers JWT API and scheduled cleanup monitoring"`。**

### Task D06: planのURL/認証保護・保存済みplan同一性・リリース照合

**Files:** Create `scripts/release/plan-guard.ts`, `scripts/release/verify-release.ts`, `scripts/release/smoke.ts`, `tests/delivery/plan-guard.test.ts`, `tests/delivery/release.test.ts`, `tests/fixtures/synthetic/plans/`; Modify `package.json`, `package-lock.json`。

**Interfaces:** Consumes D02/D05 artifact/outputs。Produces `inspectPlan(plan: unknown, baseline: ReleaseBaseline | null): PlanReview`、`reviewPlanSha256(plan: unknown): string`、`verifyRelease(expected: RegisteredArtifact, aliases: ReleaseAliases, client: LambdaClient): Promise<void>`、`smoke(baseUrl: string, published: boolean): Promise<void>`。ReleaseBaselineはAPI URL/ID/issuer/client ID/auth domain、PlanReviewは`{allowed: boolean; violations: Array<{address: string; code: string}>}`、ReleaseAliasesは両aliasARN/version。保存planのSHA-256とcommit/input manifest hashをprivate release manifestへ記録する。reviewPlanSha256はrootのtimestampのみを除き、他のplan JSONを全てkey順canonical JSON化してSHA-256とする（配列順は維持）。これは手動レビュー対象を照合する値で、ZIP hashやbinary plan hashとは別。

- [ ] **Step 1: RED試験を書く。** `blocks_delete_replace_or_removed_protected_resource`、`blocks_changed_or_unknown_existing_url_and_auth`、`allows_first_creation_but_requires_verified_post_apply_url`、`blocks_signup_or_longer_access_token`、`aliases_must_match_selected_zip`、`smoke_does_not_write_personal_data`。

  ```ts
  for (const actions of [['delete'], ['delete', 'create'], ['create', 'delete']]) {
    assert.equal(inspectPlan(planFixture({ protectedActions: actions }), baseline).allowed, false);
  }
  assert.equal(inspectPlan(planFixture({ apiUrlUnknown: true }), baseline).allowed, false);
  assert.equal(inspectPlan(initialCreateFixture, null).allowed, true);
  await assert.rejects(() => verifyRelease(expected, wrongAliasHash, fakeLambdaClient));
  assert.equal(reviewPlanSha256(planFixture({ timestamp: 'a' })), reviewPlanSha256(planFixture({ timestamp: 'b' })));
  assert.notEqual(reviewPlanSha256(initialCreateFixture), reviewPlanSha256(changedInputsFixture));
  ```

  planFixture/各fixtureは同testで合成JSONを作るhelper。API/stage/pool/clientのresource addressだけでなくtypeとbefore identityで照合し、moved/import/no-opは許可、block消失deleteは拒否。issuer/client/domain変更、admin-create-only=false、5分超/units hours、required scopeの削除、ZIP hash/version入力違い、plan/input digest違いを拒否する。unknownは初回作成以外で一致扱いしない。Lambda GetAlias→選択version GetFunctionのCodeSha256一致を両関数でassertする。
- [ ] **Step 2: Run `npx tsx --test tests/delivery/plan-guard.test.ts tests/delivery/release.test.ts` → FAIL。** 置換・hash不一致が赤になることを確認する。
- [ ] **Step 3: guardとrelease照合を実装する。** strictなplan JSON解析と否定優先の検査。resource_changes/outputs/after_unknown/before/protected設定を調べ、通常リリースでdeleteを含むprotected actionを拒否する。状態/JSONはstdoutへ出さずaddress/codeだけ出す。保存plan bytes/hash/commit/input一致をapply直前にも確認する。verifyReleaseは同じartifactを指す両version/aliasが確定してから成功、zip再buildをしない。
- [ ] **Step 4: smokeを実装する。** GET health200、readyは未公開503/公開200、baseline URL一致、Bearerなしv2拒否だけを確認する。AWS error形の違いを許容しステータスを判定する。CRUD/画像/認証秘密は自動smokeに入れない。`release:inspect-plan`, `release:verify`, `release:smoke`を追加する。
- [ ] **Step 5: 検証する。** Run `npx tsx --test tests/delivery/plan-guard.test.ts tests/delivery/release.test.ts`、`npm run typecheck` → PASS。
- [ ] **Step 6: `git add scripts/release tests/delivery/plan-guard.test.ts tests/delivery/release.test.ts tests/fixtures/synthetic/plans package.json package-lock.json` → `git commit -m "feat: protect production plans and verify deployed release identity"`。**

### Task D07: AWS権限を持たないPR CIと保護された手動リリース

**Files:** Create `.github/workflows/ci.yml`, `.github/workflows/deploy.yml`, `.github/dependabot.yml`, `tests/delivery/workflows.test.ts`, `docs/operations/deployment.md`; Delete `.github/workflows/docker-compose-build.yml`; Modify `package.json`, `package-lock.json`。

**Interfaces:** Consumes D01〜D06 scripts/role outputs、operations procedures。Produces ci(PR/push)とdeploy(workflow_dispatch/main確定commit)の契約。deployのtargetは`platform`/`application`、`apply=false`が既定。保存planとapplyは同workflow runのjob依存でつなぐ。Environment承認が使える場合は生成した当該planを確認してapply jobを承認する。使えない場合はpreview runをレビューし、同じcommit/inputs/RegisteredArtifactと`expected_review_sha256`を指定してapply=trueの手動runを行う。新runのreviewPlanSha256がレビュー済み値と異なればapplyしない。そのrunで生成・検査した同じbinary planのみをapplyし、apply jobで再plan/再buildしない。初回createも同じレビュー照合を要求する。

applicationのZIP build/登録jobはpreview時だけ実行する。apply=trueのrunはレビュー済みRegisteredArtifactと元の検証結果を必須入力にし、build/登録jobをskipする。HEADでkey/versionId/checksumを再照合してplanへ渡す。手動リリースのpreview/planで既存RegisteredArtifactを指定した場合も再buildしない。platformにはZIP生成jobを置かない。

- [ ] **Step 1: RED試験を書く。** `pr_has_no_aws_permissions`、`apply_consumes_reviewed_plan_and_never_rebuilds_zip`、`all_actions_pinned_and_apply_not_cancelled`、`maintenance_or_user_admin_workflow_absent`。

  ```ts
  assert.equal(prHasIdTokenWrite, false); assert.equal(usesPullRequestTarget, false);
  assert.equal(applyCancelInProgress, false); assert.equal(applyBuildCommandCount, 0);
  assert.ok(allActionRefs.every(ref => /@[0-9a-f]{40}$/.test(ref)));
  assert.equal(awsLongLivedKeysInWorkflow, false);
  ```

  workflow parserは固定dev依存を使い、job/stepを構造で解析する。ローカル静的CI、最小permissions、main/environments条件、applyのneeds/hashcheck/saved plan、state lock、protected URL guard、ZIP登録一度、artifact保存非公開保持1日、ログへterraform show JSONなしをassertする。Apply停止中の新runが旧applyをcancelしないことを検査する。
- [ ] **Step 2: Run `npx tsx --test tests/delivery/workflows.test.ts` → FAIL。** 旧Docker workflowしかない状態で要求が満たされないことを確認する。
- [ ] **Step 3: ci.ymlと更新自動化を実装する。** Node24/npm ci→type/lint/runtime・operations試験→build/package一度→packaging/ZIP実行/delivery試験→infra fmt/validate/mock→runtime/dev監査/SBOM。deliveryのbundle試験は生成済みZIPだけを読む。Python3.13、Terraform1.16.5を固定、外部Actionを公式releaseの確認済みSHAで固定する。PRではAWS認証なし、.devcontainer変更なし検査を含める。Dependabotはnpm/Actions/Terraformを週次、.devcontainerと不要Dockerを対象外にする。`audit:runtime=npm audit --omit=dev --audit-level=high`、`audit:all=npm audit --audit-level=high`を追加し、全severityを報告・更新/到達経路評価、High/Critical未対応をCI成功にしない。残件を修正済みと記録しない。
- [ ] **Step 4: deploy.ymlとレビュー手順を実装する。** application previewでmain確定SHAのZIPを一度だけ生成し、登録role→plan role→apply roleを別jobへ限定。apply runはレビュー済みZIPと検証manifestを再利用しbuild/登録をskipする。Environmentのmain制限、明示リリース、production concurrency/cancel-in-progress=false、saved planとprivate inputsの同一hashを検査する。初回platformとapplicationを分け、ZIPはapplication段階だけ。applyへ選んだimmutable ZIP/hash/versionIdとplan summaryを渡し、platform outputsをprivate artifactで受け渡す。CodeSha256/aliases/URL/公開状態に応じたsmokeを確認する。release ledgerは個人情報なしのcommit/hash/version/URL/結果だけを記録。`docs/operations/deployment.md`にbootstrap→platform→ZIP→application、schedule有効化、旧ZIP切戻前のschedule停止と2alias非原子性を記載する。
- [ ] **Step 5: 検証する。** Run `npm run test:delivery`、`npm run lint`、`npm run infra:check` → PASS。GHAを起動しない。
- [ ] **Step 6: `git add .github tests/delivery/workflows.test.ts docs/operations/deployment.md package.json package-lock.json` → `git commit -m "ci: validate ZIP releases and gate Terraform production delivery"`。**

### Task D08: 秘密ファイル規則・README/CLAUDE/AGENTS・最終受け入れ資料

**Files:** Create `CLAUDE.md`, `.env.example`, `docs/operations/cleanup.md`, `docs/operations/acceptance.md`, `docs/implementation-results.md`, `tests/delivery/secret-rules.test.ts`; Modify `README.md`, `.gitignore`, `.claude/settings.json`, `.claude/hooks/check-bash-command.sh`, `.codex/config.toml`, `.codex/hooks/check-bash-command.sh`, `docs/chrome-extension-cognito-auth.md`, `docs/aws-cost-estimate-2026-10-02.md`。AGENTS.mdは既存symlinkを維持。`.env.actions`/`reminders.json`は内容を読まずローカルを保持してindexから外す。

**Interfaces:** Consumes全計画の実在commands/interfaces/outputs。Produces実行できるREADME、共通CLAUDE指示、個別運用手順、F/Bの証拠付き完了表。Shell guardは機密パス/環境全体表示に限定した補助で、sandboxや権限制御の代わりと説明しない。

- [ ] **Step 1: RED試験を書く。** `secret_samples_are_distinct_from_private_files`、`guards_reject_fake_sensitive_reads`、`untracking_preserves_local_bytes`、`agents_link_resolves_to_claude`。実秘密ではなくtemp Git repoと空のcanaryファイルで検査する。

  ```ts
  assert.equal(checkIgnore('.env.actions'), true); assert.equal(checkIgnore('.env.example'), false);
  assert.equal(checkIgnore('infra/application/production/private.tfplan'), true);
  assert.equal(fakeHook('cat .env.actions').decision, 'deny');
  assert.deepEqual(tempSecretAfterUntrack, tempSecretBeforeUntrack);
  assert.equal(readlinkSync('AGENTS.md'), 'CLAUDE.md');
  ```

  `.env.*`、credentials、terraform state/plan/.terraform、private config/mapping、画像/backup、generated artifactsを検査し、public `.example`だけ許可する。`cat .env`/`.env.actions`/引用パス/`printenv`の模擬入力を確認する。hook JSON/exit形式は公式対応を検証したものだけassertし、未対応のCodex hookは有効と主張しない。
- [ ] **Step 2: Run `npx tsx --test tests/delivery/secret-rules.test.ts` → FAIL。** CLAUDE欠落と現行の対象漏れを確認する。
- [ ] **Step 3: ignore/権限/補助guardを整合させ、ローカルを保持してuntrackする。** 秘密の内容を開かず`git rm --cached -- .env.actions reminders.json`、存在を`test -f`で確認する。Git履歴を書換えない。ClaudeのRead denyとhook schemaは公式対応に合わせる。Codexの[[hooks.PreToolUse]]はその時点の公式サポートを確認し、非対応なら誤った登録を削除し、CLAUDEの指示と利用環境の実権限に置換する。ガードへ未知の完全保護を追加しない。ユーザーのContext7 library→docs/最大3commands/外sandbox/秘密をqueryへ入れない手順をCLAUDEへ保持する。
- [ ] **Step 4: 文書と最終確認を完成する。** READMEにローカルNode24/Python/uv、全commands、必須inputs、Cognitoコンソール管理/Chrome PKCE/5分更新、v2完全例、画像URL15分/オフライン/無効化後最大約20分、Terraform/GHA OIDC、移行/復旧/料金を記載する。cleanup手順にはUTC日次/手動alias/配信と処理retryの違い/同期manualの再試行なし/残件・lease/checkpoint/9alarmとSNSなしを含める。acceptance資料はコマンド・ZIP/version/拡張版・合成test IDsを記録し、実ChromeやPITR未実施を区別する。費用の係数は予算入力として保持し、実測なしで数字を書換えない。
- [ ] **Step 5: 検証する。** Run 全体計画の最終検証commands → PASS。`git diff --exit-code 253e5e2 -- .devcontainer` → 差分なし。AGENTS→CLAUDE有効、リンク・例・commandの存在を確認する。
- [ ] **Step 6: 文書・設定・untrackをコミットする。** 明示した上記pathsを`git add`して`git commit -m "docs: align AWS operations contributor instructions and secret rules"`。`git status --short`、F/B完了表、実AWS未実行一覧を確認する。

## この計画の完了条件

配布ZIPが単独でNode24 handlerをロードでき、hash/versionIdに固定できる。3Terraform rootがAWS認証なしのmock/validateに合格し、置換/unknown/認証設定変更/alias不一致は拒否される。CI/CDがレビュー可能で、README/CLAUDE/運用手順が実装と一致する。AWS作成・成果物の実S3登録・GHA実行・Chrome実ログイン・実PITR・production smokeは未実行なら明示する。
