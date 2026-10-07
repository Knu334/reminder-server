# Reminder Server Formal E2E Implementation Plan（未承認案）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 要件別に必要なローカルE2Eを再現し、実HTTP・永続状態・副作用・失敗・未実施を証拠で区別する。

**Architecture:** 明示ローカルtransport/owned fixtureで実Hosted UI PKCE→JWT Gateway→現行ZIP Docker Lambda→DDB/S3を実行する。清掃/合成運用は同artifactまたは既存実adapterを使い、決定的故障とIaC互換性は独立層で記録する。

**Tech Stack:** Node24.21.0/npm11.11.1、Python3.13.16、TypeScript/CommonJS/tsx/node:test/node:assert、既存固定AWS SDK v3。Terraform1.16.5/AWS provider6.67.0（独立local rootのみ）。

**Spec:** [正式E2E設計案](../specs/2026-10-08-reminder-server-formal-e2e-design.md)、[要件対応表](../../operations/formal-e2e-coverage.md)、[調査記録](../../operations/formal-e2e-research.md)。製品契約は[承認済みAWS設計](../specs/2026-10-02-reminder-server-aws-design.md)と現行API/運用文書。

**Status:** 2026-10-08レビュー待ち。設計/対応表/本計画への承認前は実装・Floci資源作成・applyを開始しない。
ハンドオフが許可した文書作成として計画案を同時提示した。SDD方式は選択済み、再確認不要。

## Global Constraints

- 既存worktree `/workspace/.worktrees/aws-sdd` / `feature/aws-sdd-implementation` を使用し、reset/checkout/history改変しない。旧19タスクを再dispatchしない。
- 未コミットnull-body修正・過去untracked成果物・root FWユーザー変更を保持し、新E2Eの明示pathだけをstageする。
- 実AWS/GHA/push/PR/merge、実データ/私有.env/AWS credentials/private mapping/state/plan/画像backupのread/hash/display/copyは禁止。
- Node24.21.0/npm11.11.1/Python3.13.16、TFを使う場合1.16.5/provider6.67.0。全npm/npx/Python/準備commandは `PATH=/tmp/aws-sdd-tools/node_modules/.bin:/tmp/aws-sdd-tools/bin:$PATH` を付ける。
- 接続先は `http://floci:4566` とそのdiscoveryで確認した同一RFC1918 IPv4/owned S3 hostだけ。SDK/providerは明示region `ap-northeast-1`、local dummyまたはFloci発行の合成role credential、maxAttempts=1、profile/metadata/default endpoint fallbackなし。
- Floci image `floci-local:2.2.0-refresh.1-native` / health `2.2.0-local-refresh.1-native` を維持。MiniStack/LocalStackへ変更しない。Docker socketはFlociのみ、FW/devcontainer編集なし。
- 実Hosted UI PKCE/S256・JWKS署名・Gateway JWT・Docker Lambdaを維持。偽authorizer context/API直接invoke/route削除・並べ替え/認証や入力緩和をEへ混ぜない。
- 製品値はaccess/ID300秒・refresh30日・rotation grace10秒、画像URL900秒、本文2097152/画像1048576 bytes、item1000/image134217728 bytes/rate120。Eの縮小quota/rate fixtureは正式overrideとして値を記録し、規定値のU/Iを維持する。
- cleanupは24h=86400000ms、lease20分=1200000ms、GSI12partition/KEYS_ONLY/page50、候補10000/delete5000/600秒/残り60秒/並行4。製品へtest clock/cap overrideを追加しない。
- 現行sourceからbuild/packageした同じZIPをAPI/cleanupへ登録し、SHA-256/S3 pinned version/checksum/CodeSha256/aliasを照合する。dirty非秘密入力digestを保存する。
- 元画像を変換しない。BASE64/data URL入力、DBはmetadataだけ。直接upload APIを追加しない。
- random owned prefixとrun manifest、finally全回収、不在確認、cleanup errors/leaks別集計。例外/子process/TF出力に秘密・raw body・全envを出さない。
- TFは新E2E root/local backend/run固有合成inputs/stateのみ。production root/backend/state/plan/private inputs参照なし。owned資源だけdestroyする。
- E/L/I必須の未実施が残れば完了にしない。TF/Scheduler/署名強制は調査必須で非対応を別記。実AWS/IAM/TLS/PITR/Chrome/性能同等性を推定しない。
- 製品バグ/Floci非互換は独立失敗ケースと原因を記録し、製品動作修正は内容提示・別承認まで混ぜない。host rebuild/接続先追加が必要なら成果物と再開手順を保存して停止する。

## Review Focus

1. fixture初期化/一ケース失敗で後続ケースが消え、全体GREENに見える → inventory先行・not-run・独立継続（Task1/2/10）。
2. auth負例がsignature/期限/scope複合で偶然通り、拒否理由を誤認する → 正の対照と一条件、実署名expired、層別token_use（Task3）。
3. S3 hostname/redirect/SDK endpointのfallbackとassert diffが秘密を漏らす → DNS pin・未知host拒否・canary全出力（Task1/2/6）。
4. failed image transaction/cleanup unknown outcomeで参照中bytesを削除し、counterやcursorを重複/飛ばす → 実保存照合とbefore/after fault（Task5/6/7/8）。
5. dirtyソース、古いZIP、partial apply、cleanup失敗を成功にする → snapshot hash/両CodeSha・state ownership・exit集約（Task2/9/10）。

## 承認後のSDD setup

using-git-worktreesでlinked worktreeを再確認（新worktree作成/未コミットcopy不要）。
指定toolの不足だけ復元。まず必要なbuild/package後に既存回帰を実行し、開始時の実状態を記録する。
本計画を読み、新計画専用workspaceを `subagent-driven-development/scripts/sdd-workspace <本計画path>` で作る。
`progress.md` 第一行は `# SDD ledger — plan: docs/superpowers/plans/2026-10-08-reminder-server-formal-e2e.md`。
Task completionを読み、同じTaskを再dispatchしない。過去台帳は開かない/流用しない。
preflightでは全Taskの内部整合とshared file/interfaceの全pairを表にし、矛盾をspecに照らしてruling記録。
ここに示す依存要約だけをscanの代替にしない。

順序はTask1→2→3→4→5→6→7→8→9→10。共有fixture実装者の並列は禁止。
各TaskでBASE記録→task-brief file→新規実装者→RED/最小/GREEN/self-review/explicit commit→
review-package→独立task reviewer（spec/quality両判定）。実装者のsubagent禁止。
修正round1〜3は元実装者、4〜5は上位model新実装者。controllerが実装を直さない。
Taskのreviewerに既に通った同コードのtestを再実行させない。
最終は新しい最も能力の高い利用可能model（現allowlistならgpt-6-astra、高いreasoning）でwhole E2E review。
mechanicalはgpt-6-luna、integrationはgpt-6.1-sol、architecture/judgmentはgpt-6-astraを目安に、
dispatch時のallowlistを確認しmodel/effort/fork_turns:noneを明示する。
最終findingsは一回のcombined fix dispatch + 一回のscoped review、残件はrulingsと影響を保存。
最後に新台帳の全Rulingを公開結果へ転記してから、この計画のscratchだけを整理する。branchは保持、push等しない。

## 共通interface（Task1で型、Task2で実fixtureを定義）

`tests/e2e/floci/support/types.ts` に以下の契約を置く。秘密の値はメモリ内専用。

- `Layer = 'U' | 'I' | 'E' | 'L' | 'A'`、`CaseStatus = 'pass' | 'fail' | 'not-run' | 'unsupported' | 'out-of-scope'`。今回のrunnerはE/L/Iを実行し、Uは別回帰証拠、Aはout-of-scopeとして区別する。
- `CaseDefinition = { id: string; requirementId: string; layer: Layer; required: boolean; suite: string; source: string; assertions: string[] }`。
- `CaseResult = { id: string; status: CaseStatus; phase: string; httpStatus?: number; code?: string; durationMs: number; reason?: string }`。reasonは固定enum文言。
- `Evidence` は `runId: string` と `record(result: CaseResult): Promise<void>`、`finish(cleanup: CleanupSummary): Promise<RunSummary>`。
- `CleanupSummary = { attempted: number; succeeded: number; errors: number; leaks: number }`。
- `RunSummary = { selected: number; passed: number; failed: number; notRun: number; unsupported: number; outOfScope: number; cleanup: CleanupSummary; exitCode: 0 | 1 | 2 }`。
- `LocalTarget = { endpoint: 'http://floci:4566'; region: 'ap-northeast-1'; addresses: ReadonlyMap<string, string> }`。
- `HttpResult = { status: number; headers: Headers; bytes: Buffer }`。raw結果は証拠へserializeしない。
- `ArtifactSnapshot = { zipPath: string; sha256Hex: string; sha256Base64: string; compressedBytes: number; inputDigest: string; dirtyPaths: string[] }`。
- `FixtureOptions = { suite: string; publication: boolean; limits?: Partial<Config['limits']> }`。Configは現行`src/config.ts`をtype import。
- `OwnedManifest` はrunId、resource kind/name/IDとcreated/removed状態のみ。secret/token/user-dataなし。
- `E2EFixture` はtarget/prefix/config/artifact/manifest、local clients、auth、`request(path: string, options?: { token?: string; method?: string; headers?: Record<string,string>; body?: string }): Promise<HttpResult>`、`setPublication(published: boolean): Promise<void>`、`dispose(): Promise<CleanupSummary>`。
- `LocalClients` は明示設定のDynamoDBDocumentClient/S3Client/LambdaClient/CloudWatchClient/STSClient。
- `AuthSession = { accessToken: string; idToken?: string; refreshToken: string; claims: { iss: string; sub: string; client_id: string; iat: number; exp: number; scope: string } }`。
- `FixtureAuth` は `login(owner: 'a'|'b', scopes: string[], client: 'primary'|'sibling'|'foreign'): Promise<AuthSession>` と `refresh(session: AuthSession): Promise<AuthSession>`。負例用の低水準exchange/refresh/revoke/disableはTask3のauth.tsで型を追記する。

## ファイル責務・依存

Task1がtransport/evidence/preflight/run registry、Task2がartifact/fixture/auth/storage/cleanupの共通基盤を所有する。
Task3だけauth supportを拡張。Task4〜6は各suiteファイルと合成fixtureだけを作る。
Task7はcleanup suiteとfault support、Task8はoperations supportとfault suite、Task9はTF/compatibility、
Task10はdocsと最終集約・inventory回帰。各Taskで新case registry entryだけを追加し、既存entryは維持する。
`package.json` はTask1の入口追加、Task9のTF入口追加、Task10の文書照合だけ。lock依存変更は原則不要。

### Task 1: ローカルtransport・ケースinventory・安全な証拠と入口

**Files:** Create `tests/e2e/floci/support/{types,transport,evidence,cases}.ts`, `scripts/e2e/{preflight,run}.ts`, `tests/integration/formal-e2e/harness.test.ts`; Modify `package.json`。

**Interfaces:** 上記型、`preflight(): Promise<LocalTarget>`、`localRequest(target: LocalTarget, url: URL, options: { method?: string; headers?: Record<string,string>; body?: string|Buffer }): Promise<HttpResult>`、`createEvidence(definitions: CaseDefinition[], runDirectory: string): Promise<Evidence>`、`runCase(definition: CaseDefinition, evidence: Evidence, action: () => Promise<void>): Promise<void>`、`runMain(argv: string[]): Promise<0|1|2>`。

- [ ] **Step 1 RED:** `harness.test.ts` に `reject_public_redirect_unknown_host_before_socket`、`dns_drift_preserves_host`、`failed_case_keeps_inventory_and_siblings`、`canary_never_reaches_report_or_stderr`、`cleanup_failure_changes_exit` を作る。外host/socket0、秘密canaryを含むAssertionErrorのdiff/stackも非表示、selected3でpass1/fail1/not-run1、cleanup.errors1ならexit1をassert。
- [ ] **Step 2 RED実行:** `PATH=… npx tsx --test tests/integration/formal-e2e/harness.test.ts`。未実装interfaceまたは期待安全性の失敗を記録。通信環境失敗をREDと呼ばない（以下の`PATH=…`はGlobal Constraintsの完全prefix）。
- [ ] **Step 3 最小実装:** old pinnedRequestを参照してDNS pin/元Host/no-redirect/30秒deadline、証拠allowlist/0700・0600、case registry先行を実装。子processはsanitized envをallowlist構築し、raw stderrを転送しない。`e2e:preflight=tsx scripts/e2e/preflight.ts`、`test:integration:e2e=tsx --test tests/integration/formal-e2e/*.test.ts`、`test:e2e:floci=tsx scripts/e2e/run.ts --layer floci`。unknown suite/caseはexit2、partial selectedを表示。post-failure継続とtoplevel failureのsanitizationを保証する。
- [ ] **Step 4 GREEN:** harnessとpreflight、typecheck/lint。case assertionと安全な結果だけが出ること。現在health/version/IPが不適合ならpreflight失敗、fallbackしない。
- [ ] **Step 5 commit/review:** 上記create fileを個別列挙 + package.jsonだけstage、`test: add isolated formal E2E harness`。SAFE-01〜03、Review Focus1/3を独立レビュー。

### Task 2: 現行artifactと再利用可能なowned Floci fixture

**Files:** Create `scripts/e2e/prepare-artifact.ts`, `tests/e2e/floci/support/{artifact,fixture,auth,storage,cleanup}.ts`, `tests/e2e/floci/fixture.test.ts`; Modify `support/cases.ts`, `tests/integration/formal-e2e/harness.test.ts`。

**Interfaces:** `prepareArtifact(runDirectory: string): Promise<ArtifactSnapshot>`、`createFixture(options: FixtureOptions, artifact: ArtifactSnapshot, evidence: Evidence): Promise<E2EFixture>`、`readOwnerState(fixture: E2EFixture, ownerId: string): Promise<{ itemCount: number; imageBytes: number }>`、`readReminder(fixture: E2EFixture, ownerId: string, id: string): Promise<StoredReminder|null>`。DTO/typesは既存sourceを使用、fixture assertionsは独立のexpected data。

- [ ] **Step 1 RED:** `fresh_zip_matches_both_pinned_functions`、`stale_manifest_and_tampered_zip_rejected_before_register`、`fixture_setup_failure_disposes_every_created_resource`、`hosted_pkce_health_publication_smoke`。両CodeSha/S3 checksum/version一致、aliasが選択published version、ready503→200、health200、unauth v2 401。疑似各作成段階失敗で残存0をharnessでassert。
- [ ] **Step 2 RED実行:** offline harnessを先に実行、環境preflight後fixture.test。欠落export/整合検証でFAILを記録。
- [ ] **Step 3 最小実装:** 毎runでbuild→package→verify:zip、一つの0700 snapshotを作り、非秘密input path allowlistは `src/**/*.ts`, `scripts/build/{bundle,notices}.ts`, `scripts/build/package.py`, `package.json`, `package-lock.json`, `tsconfig.json`。symlink/outside pathを拒否しpath+bytesでinputDigest。build前後でinputDigest一致を要求し、途中のsource変更を拒否する。秘密pathは探索対象外。ZIPを別versioned owned bucketに登録、2handler/version/alias、3table/GSI、画像bucket、role/log/pool/client/scope/16route/CORS。fixture API LambdaはGatewayだけ、cleanup invokeは専用role。resource success後即manifest、reverse cleanupを用意し各ID不在確認。標準fixtureはproduction defaults、quota/rate試験だけ明示override。
- [ ] **Step 4 GREEN:** build/package検証、fixture実smoke、setup途中失敗harness、typecheck/lint。secret/ZIP raw dataを出力しない。全cleanup errors/leaks0。OPS-05とSAFE-02の結果を記録。
- [ ] **Step 5 commit/review:** 明示create/modifyのみ、`test: provision owned Floci fixtures from current ZIP`。Review Focus3/5とauth経路・IAM分離・artifact provenanceをレビュー。

### Task 3: 認証正常系・独立負例・rotation

**Files:** Create `tests/e2e/floci/auth.test.ts`, `tests/integration/formal-e2e/auth-claims.test.ts`; Modify `support/auth.ts`, `support/cases.ts`。

**Interfaces:** Task2 FixtureAuth。追加 `exchangeCode(fields: Record<string,string>): Promise<{ status:number; error?:string; session?:AuthSession }>`、`requestRefresh(token:string, client:'primary'|'sibling'): Promise<{ status:number; error?:string; session?:AuthSession }>`、`revoke(session:AuthSession):Promise<void>`、`disable(owner:'a'|'b'):Promise<void>`、`verifySession(session:AuthSession):void`。valueやerror_descriptionをpublic証拠へコピーしない。

- [ ] **Step 1 RED:** AUTH-01〜12をcasesへ展開。各一条件負例の前後valid200とRATE/storage不変。signatureだけflip→401、same-pool sibling401、read-only POST403/write-only GET403、ID403。actual signed exp前200/exp後401/refresh後200。PKCE wrong/missing verifier、callback mismatch、code reuse、S256以外を別codeで試す。Iにtoken_use/issuer単独401（既存requireOwnerを実呼出し）を作る。
- [ ] **Step 2 RED実行:** `PATH=… npx tsx --test tests/integration/formal-e2e/auth-claims.test.ts` と auth単独runner。負例準備自体の障害はnot-runで、REDの対象を新harness不足に限定する。
- [ ] **Step 3 最小実装:** 正常発行tokenをlocal JWKSで検証し署名/claimsの対照を保存（値なし）。AUTH-05で期待JWKSがforeign tokenを検証しない場合は複合拒否と単独Iを別result。token lifetimeは300秒のまま、expiry待ちを他authケース後に置き全体330秒・waitは30秒以下。refreshはgrant identity/scopes/owner保持、10秒grace前後、original deadline不延長、missing/malformed/sibling、revoke family、synthetic disable。30日絶対期限とChromeはout-of-scope/Aの既知制限。
- [ ] **Step 4 GREEN:** `test:e2e:floci -- --suite auth`、auth I、type/lint。case inventoryとpass/fail/not-run/unsupported、cleanup0を確認。FlociがPKCE負例を通すなら独立失敗記録、認証緩和しない。
- [ ] **Step 5 commit/review:** 明示path、`test: verify formal PKCE JWT and refresh contracts`。Review Focus2とscope/token_use/issuer独立性をレビュー。

### Task 4: API契約・入力境界・ページング

**Files:** Create `tests/e2e/floci/api.test.ts`, `tests/e2e/floci/support/input-fixtures.ts`; Modify `support/cases.ts`。

**Interfaces:** Task2 request/readReminderと`makeInput(overrides: Record<string,unknown>): Record<string,unknown>`、`makeJsonBodyBytes(bytes: number): string`。inputはsynthetic URL/title/date/booleans、任意ownerId入力禁止。後者はvalid JSONの余白で正確UTF-8長を作る。

- [ ] **Step 1 RED:** API-01〜13、API-14の認証/入力gate順をparameter IDsへ展開。旧POST/PUT410、known6paths405/Allow、unknown404、DTO/header全field、owner全操作404、CORS/OPTIONS、media400/415、fields422、ID/codepoint128±1/URL4096±1/title1024±1、日時offset/閏日/invalid、JSON2097152±1。list51metadata・limit1/20/50/0/51、tombstone先頭empty page→cursor、BへA cursorと不正422をassert。
- [ ] **Step 2 RED実行:** api選択runner。不足case/harnessの失敗を記録。fixture初期化に失敗した時は全caseがnot-runになることもassert。
- [ ] **Step 3 最小実装:** fixture per suite、各case per owner/item prefixで独立。入力拒否時snapshot storage/job/S3不変、RATEはauth済みなら増加。51個の初期seedは実APIを使い、rate分境界の影響を避ける実行順を定める。encoded slashはURLを改変せずFlociへの実pathで評価。CORSはHTTP headers、実拡張ブラウザは未実施。negative失敗後も独立casesを実行する。
- [ ] **Step 4 GREEN:** api runner、既存api/contracts/boundaries/reads-rate covering、type/lint。旧APIやANYを触るproduct/Floci変更はしない。
- [ ] **Step 5 commit/review:** 明示path、`test: cover API contracts boundaries and pagination`。Gateway edge errorとLambda独自codeの区別をレビュー。

### Task 5: 強いETag・同時競合・quota/rateの保存整合

**Files:** Create `tests/e2e/floci/storage.test.ts`, `tests/integration/formal-e2e/concurrency.test.ts`; Modify `support/cases.ts`。

**Interfaces:** FixtureOptions.limits、Task2 readOwnerState/readReminder、Task4 input-fixtures。共通fixture本体の変更は不要。

- [ ] **Step 1 RED:** STORE-01〜06とAPI-14を独立casesにする。生HTTP body SHAによるexact rN-hex、弱い/*/list/欠落/同revision別hash/逐次stale拒否。barrierからPATCH/PATCH・DELETE/DELETE・PATCH/DELETEの2request、一200/一拒否、revision/counters一回。PATCH同士は412、DELETE先勝ち後のcurrent readは404を許容し、その分岐はIの双方旧active読取controlで分離する。create競合一201/一409、different item保持、exact tombstone、再送二重なし。quota fixture item2/image24、12byte PNG、rate3/two sessions/4件目429とRetry-After一致。
- [ ] **Step 2 RED実行:** storage runnerとconcurrency I。real service成功を得るためretryを追加しない。開始window余裕をpreconditionとして固定し、窓を跨いだ結果はfail。
- [ ] **Step 3 最小実装:** request Promiseを同時releaseするhelperをsuite内で定義、成功と敗者の保存snapshotを強いreadで確認。concurrency Iはreal service/storeのget portを狭くwrapし、双方の旧active強いreadが完了したbarrierからcommitへ進めて一成功/一412を確認する（claims注入HTTPとは別層）。容量の上限手前をprepare→二create争い→一成功/一413、counter最大2。imageBytesは12bytes二つ→第三拒否、削除/clearで回復。規定120/1000/128MiBとlowered-cap回復は既存U/Iを同時記録する。ratefixtureの診断readはDDB control clientで行いAPI数を増やさない。
- [ ] **Step 4 GREEN:** storage runner、concurrency I、writes/reads-rate/lowered-quotas covering、type/lint。I fakeの並行とE client同時送信を別layer表示する。
- [ ] **Step 5 commit/review:** 明示path、`test: assert concurrent revisions quotas and tombstones`。Review Focus4をレビュー。

### Task 6: 元画像・実URL取得・差し替え・孤児

**Files:** Create `tests/e2e/floci/images.test.ts`, `tests/e2e/floci/support/image-fixtures.ts`, `tests/fixtures/synthetic/formal-e2e/image-fixtures.md`; Modify `support/cases.ts`, `support/transport.ts`, `tests/integration/formal-e2e/harness.test.ts`。

**Interfaces:** `imageBytes(format:'png'|'jpeg'|'gif'|'webp', bytes?:number):Buffer`、`fetchOwnedImage(fixture:E2EFixture, url:string, ref:ImageRef):Promise<HttpResult>`。image fixtureはsynthetic signature bytesで元dataはmemory、文書に生成規則。URL/refはraw証拠に渡さない。

- [ ] **Step 1 RED:** IMG-01〜09。4形式BASE64/dataURL/null/empty/省略、bad BASE64/MIME、1048576±1、S3 pinned bytes/checksum/metadata/versions、DB no bytes。API URL900秒/GET元bytes/no Bearer/body/ETag不変。差し替え/clear/deleteのcommitted/retired/due/counter、新画像付きduplicate409→orphan pending。未知bucket/host/redirect/改変署名URLのtransport拒否をoffline harnessでassert。
- [ ] **Step 2 RED実行:** offline harness→images runner。hostname未解決はdiagnostic制限として記録、URL/Host/queryをrewriteして成功にしない。
- [ ] **Step 3 最小実装:** private IP discoveryに整合するowned bucket hostだけsocket pinへ追加。fetch前のowned key/version/endpoint検査、URLはmemoryのみ。署名強制probeは正control/一signature改変/短期限独立URLのexp後拒否を比較し、actual API900秒とは別result。Flociがtamperを許可した場合unsupportedを記録し、runtime設定変更は差分提案まで。必要画像Eの保存/取得が阻害されるなら正式未完了。
- [ ] **Step 4 GREEN:** images runner、既存images/contracts covering、harness/type/lint。valid取得だけをSigV4強制成功としない。画像fixtureのfake PNGを実画像decoder検証済みとしない（製品はsignature検査契約）。
- [ ] **Step 5 commit/review:** 明示path、`test: preserve original images through authenticated API`。Review Focus3/4、secret URL診断、孤児job条件をレビュー。

### Task 7: 実清掃の状態遷移・合成日時・中断と上限

**Files:** Create `tests/e2e/floci/cleanup.test.ts`, `tests/e2e/floci/support/cleanup-fixtures.ts`, `tests/integration/formal-e2e/{fault-transport,cleanup-resume.test}.ts`; Modify `support/cases.ts`。

**Interfaces:** `invokeCleanup(fixture:E2EFixture):Promise<{ functionError?:string; result?:CleanupResult }>`、`seedCleanupJobs(fixture:E2EFixture, jobs:ImageJob[]):Promise<void>`、`FaultRule={command:string; occurrence:number; phase:'before'|'after'|'delay'; effect:'throw'|'abort'}`、`createFaultTransport(delegate:RequestHandler,rules:FaultRule[]):{handler:RequestHandler; trace:ReadonlyArray<{command:string; occurrence:number; phase:string}>}`。RequestHandlerは既存SDK client configが受ける型からderiveし、secret/body非保存。FaultRule.commandはSDK command名への明示対応表。

- [ ] **Step 1 RED:** CLEAN-01〜09。unpublished0、activelease保持/expireddone、24h両側/retired起点、committed/current画像保護、version/checksum mismatch保持、marker後version読取、same shard51/page50、二invoke収束、event injection拒否。Iはpage途中abort→cursor開始を維持、GSI stale/current read condition、claim/upload race、marker after-response-lost、checkpoint/metric失敗を単独注入。
- [ ] **Step 2 RED実行:** cleanup-resume Iとcleanup runner。FunctionErrorをHTTP200で覆わない。seedjobはowned合成tableで正schema/GSI属性を持つことを準備assert。
- [ ] **Step 3 最小実装:** Task6 real APIから作ったcommitted/retired/orphanを再現するfixture + standalone synthetic job。時刻の両側に5秒以上の余裕、exact等号はclock制御I。12partitionの末尾reset/51件をGSI反映bounded poll後にinvoke。fault adapterはsend before/実送信応答遮断を区別してtraceへ固定codeだけ記録。規定10000/5000/600/60/4の既存limit試験を保持し、実adapter小inventoryの中断再開を追加、製品overrideを作らない。
- [ ] **Step 4 GREEN:** cleanup runner、cleanup-resume I、既存jobs/cleanup/images covering、type/lint。削除actorがVersionId永久削除を送信しないことはI trace、実version保持はLで確認。
- [ ] **Step 5 commit/review:** 明示path、`test: verify durable cleanup leases checkpoints and protections`。Review Focus4、fake索引遅延とreal GSI観測の区別をレビュー。

### Task 8: 合成移行・復旧と依存故障の実adapter結合

**Files:** Create `tests/e2e/floci/operations.test.ts`, `tests/e2e/floci/support/operation-fixtures.ts`, `tests/integration/formal-e2e/faults.test.ts`; Modify `support/cases.ts`。

**Interfaces:** `localMigrationRuntime(fixture:E2EFixture):MigrationRuntime`、`localRecoveryRuntime(fixture:E2EFixture):RecoveryRuntime`、`writeSyntheticOperationInputs(fixture:E2EFixture, directory:string):Promise<{source:string; mapping:string; config:string; restoredConfig:string; ownerIdentities:string; ownerMap:string}>`。型は既存migrate-json/verify-recoveryのexportを使用。

- [ ] **Step 1 RED:** OPS-01〜04、STORE-07、IMG-08。two owners（空owner/特殊key含む）dry-run/import/verify/publish→ready503/200、source hash不変（合成のみ）、rerun counts/versions不増。changed bytes/map/limits拒否・corrupt image禁止。restored-only prepare/verify/preserve/remap/rerun、source table/version不変・Cognito復元false。before/after Put/commit/read/rate失敗で503/未公開/committed保護/counter不重複、abort settlementをassert。API-01の `ready_dependency_failure_keeps_health200` はcreateApiHandlerの実depsへprobe faultを渡して確認する。
- [ ] **Step 2 RED実行:** faults Iとoperations runner。ローカルSTS accountとexplicit synthetic targetの一致を事前確認し、共有AWS fallbackなし。
- [ ] **Step 3 最小実装:** 既存 `migrationMain(argv,io,runtime?)` / `recoveryMain(argv,io,runtime?)` の注入interfaceを使い、local clientsで `createMigrationStore/createMigrationImagesStore/createRecoveryStore` を構成。createMigrationDeps/createRecoveryDepsのdefault credential chainを呼ばない。raw IOの転送はsafe fieldsだけ。運用用全table scansはowned resourcesへ限定、通常API/cleanup Scan禁止と区別。復旧は本物PITRでなく合成snapshotの別3table、同画像bucket、source read-only。role/環境/handlerの製品変更なし。
- [ ] **Step 4 GREEN:** operations runner、faults I、既存legacy/migration/recovery covering、type/lint。画像保全後の強いread/pinned bytes、default verify前後のrestoredも不変を確認。
- [ ] **Step 5 commit/review:** 明示path、`test: integrate synthetic migration recovery and uncertain outcomes`。Review Focus4とsource不変/未公開gate/再実行安全性をレビュー。

### Task 9: 独立Terraform apply/destroyとScheduler互換性の採否

**Files:** Create `tests/e2e/floci/{terraform,scheduler}.test.ts`, `scripts/e2e/terraform.ts`, `tests/e2e/floci/infra/{versions,variables,main,outputs}.tf`, `tests/e2e/floci/infra/.terraform.lock.hcl`, `tests/integration/formal-e2e/terraform-driver.test.ts`; Modify `support/cases.ts`, `package.json`, `docs/operations/formal-e2e-research.md`。

**Interfaces:** `TerraformProbeResult={status:'pass'|'fail'|'unsupported'; failedAction?:string; cleanup:CleanupSummary; assertions:string[]}`、`runTerraformProbe(fixture:E2EFixture,directory:string):Promise<TerraformProbeResult>`。state directoryはrun manifestへbound、foreign/outside path禁止。共通API assertionsはfixture.request互換bindingをTF outputsから生成し、値をpublicへdumpしない。

- [ ] **Step 1 RED:** TF-01/02、OPS-06、`unknown_endpoint_and_foreign_state_rejected_before_spawn`、`partial_apply_always_attempts_owned_destroy`、`provider_output_canary_not_logged`。isolated process fakeでdefault endpoint/foreign state0spawn、partial失敗も回収attempt、errors別、unsupportedはpassに数えない。実Schedulerはdaily config read-back、owned at→cleanup checkpoint/job変化。
- [ ] **Step 2 RED実行:** offline terraform-driver。その後version/schema/endpoint/APIのread-only preflight。Context7のlibrary→docsをsandbox外、各質問最大3command、quotaは明示。6.67.0は実schemaを確認、索引mainだけでversion適合を確定しない。
- [ ] **Step 3 最小実装:** 新rootはlocal backend、pinned lock、dummy keys、metadata/profile閉鎖、全使用service endpoints明示。ZIP uploadとsynthetic Cognito userはSDK fixture、TFはowned3table/bucket/role/両ZIP functions/version/alias/Gateway/16routes/CORSを必要APIの段階ごとに追加。providerの付随read/Tag/waiterが不足ならfailedActionと最小probeを保存してunsupported。production tfを編集しない。supportedならTF outputs上でhealth/ready/auth拒否/CRUD/画像bytes/CodeSha共通assert→finally destroy→owned不在確認。`test:e2e:terraform=tsx scripts/e2e/run.ts --layer terraform`。
- [ ] **Step 4 Scheduler/互換性記録:** 別owned groupでdaily03UTC/OFF/DISABLED/retry2/3600/cleanup alias設定read-back、独立at+input{}を90秒以内bounded poll。確認後schedule停止/削除→invocation settle→資源回収。runtime未起動はunsupported/fail理由を区別、日次運転/IAM/async同等性を主張しない。host再設定必要なら差分・再開手順を保存して停止。
- [ ] **Step 5 GREEN/採否:** offlinedriver/type/lint/fmt/validate、supported apply test、SDK daily/one-time probeの実測をservice API表へ記載。unsupportedのsuite選択exit1は期待された互換性判定であり、GREENとは書かない。cleanup/leaksは常に0が必要。
- [ ] **Step 6 commit/review:** 明示pathと研究記録のみ、`test: probe isolated Terraform and Scheduler integration`。Review Focus5、local state ownership・AWS送信防止・非対応の証拠をレビュー。

### Task 10: 日本語手順・全case照合・fresh実行結果

**Files:** Create `docs/operations/formal-e2e-{README,results,limitations}.md`, `tests/integration/formal-e2e/coverage.test.ts`; Modify `README.md`, `docs/operations/formal-e2e-coverage.md`, `support/cases.ts`, `scripts/e2e/run.ts`（最終inventory統合のみ）。

**Interfaces:** CaseDefinition/CaseResult/RunSummary。`coverage.test.ts`は対応表のID集合とregistryのrequirementId、required/layer/source、all suite inventoryを照合する。

- [ ] **Step 1 RED:** `every_required_case_has_result_and_source`、`partial_selection_cannot_claim_full_completion`、`unsupported_not_run_cleanup_are_separate`。fixture top-level failure/timeoutで全caseがnot-runとして残りexit1、見えていないcaseやbody canary0、rowのU/AだけをE必須にしないことをassert。
- [ ] **Step 2 RED実行:** coverage/harness/terraform-driverのoffline試験。ケースplaceholderを未実施のままpassにしない。
- [ ] **Step 3 最小完成:** registry/matrix/READMEの実存在入口を一致させ、依存準備・fixture生成・suite選択・失敗診断・owned recovery・後片付け・CI runner準備を日本語で記載。現在のpatched imageのhost準備は既存手順へリンク、GHA/workflow変更なし。結果reportはfresh UTC、HEAD/dirty入力digest/tool/ZIP/API-cleanup hashes、layer別counts/required not-run/unsupported、cleanup/leaks、review/rulings、既知制限を保持。
- [ ] **Step 4 fresh検証:** prefix付き `npm ci`（必要時）、typecheck/lint→build/package/verify:zip→`npm test`→test:packaging→必要infra:check→audit:runtime/audit:all→test:integration:e2e→test:e2e:floci→test:e2e:terraform。ZIPはE2E prepareでも現行buildから作る。Floci必須groupsを全実行、TF非対応はfail/unsupportedとして別結果。順序/実際のcommand/exit/count/安全なwarningsを記録。今回のuser baseline diffはstageしていない新E2E pathだけを検査。
- [ ] **Step 5 commit/task review:** 日本語docs/registry/runner限定path、`docs: record reproducible formal E2E evidence and limits`。未実施/cleanupが漏れず、既存337件等をfresh結果なしで流用していないことをレビュー。
- [ ] **Step 6 controller final review:** Task1〜10 rangeのreview package、deferred/parked/rulings全件を最も能力の高いreviewerへ。修正wave上限を守る。必要E/L/I未完了なら未完了報告、製品修正承認へ誘導する前に独立失敗証拠を提示。

## 実行計画の自己レビューと承認境界

AUTH→Task3、API→Task4/5、STORE→Task5/8、IMG→Task6/8、CLEAN→Task7、
OPS→Task2/8/9、TF→Task9、SAFE→Task1/2/10。Review Focusの全項目に失敗ケースを割り当てた。
共通型・署名とexisting operations exportsを照合、source product変更なし、private入力参照なし、
fresh artifact/証拠の準備・cleanup・非対応判定を含めた。
承認待ちは新E2Eの設計/対応表とこの計画。実行方式はSDDを維持する。
旧taskは再開せず、新計画専用台帳を承認後に作成する。
