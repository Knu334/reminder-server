# Reminder Server Formal E2E Implementation Plan（未承認案）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 要件別に必要なローカルE2Eを再現し、実HTTP・永続状態・副作用・失敗・未実施を証拠で区別する。

**Architecture:** 接続先を明示したローカルtransportと、この実行が所有するfixtureを使い、実Hosted UI PKCE→JWT Gateway→現行ZIP Docker Lambda→DDB/S3を実行する。清掃/合成運用は同じartifactまたは既存の実adapterを使う。決定的に再現する故障とIaC互換性は、独立した層で記録する。

**Tech Stack:** Node24.21.0/npm11.11.1、Python3.13.16、TypeScript/CommonJS/tsx/node:test/node:assert、既存固定AWS SDK v3。Terraform1.16.5/AWS provider6.67.0（独立local rootのみ）。

**Spec:** [正式E2E設計案](../specs/2026-10-08-reminder-server-formal-e2e-design.md)、[要件対応表](../../operations/formal-e2e-coverage.md)、[調査記録](../../operations/formal-e2e-research.md)。製品契約は[承認済みAWS設計](../specs/2026-10-02-reminder-server-aws-design.md)と現行API/運用文書。

**Status:** 2026-10-08レビュー待ち。設計/対応表/本計画の承認前は、実装・Flociリソース作成・applyを開始しない。
ハンドオフが許可した文書作成の範囲で、設計案と計画案を同時に提示した。SDD方式は選択済みのため、再確認は不要。

## Global Constraints

- 既存worktree `/workspace/.worktrees/aws-sdd` / `feature/aws-sdd-implementation` を使用し、reset/checkout/historyの改変はしない。旧19タスクを再dispatchしない。
- 未コミットのnull-body修正、過去の未追跡成果物、root FWのユーザー変更を保持する。新E2Eの明示したpathだけをstageする。
- 実AWS/GHA/push/PR/mergeは禁止。実データ/私有.env/AWS credentials/private mapping/state/plan/画像backupの読み取り・hash計算・表示・コピーも禁止する。
- Node24.21.0/npm11.11.1/Python3.13.16、TFを使う場合1.16.5/provider6.67.0。全npm/npx/Python/準備commandは `PATH=/tmp/aws-sdd-tools/node_modules/.bin:/tmp/aws-sdd-tools/bin:$PATH` を付ける。
- 接続先は `http://floci:4566` とそのdiscoveryで確認した同一RFC1918 IPv4/owned S3 hostだけ。SDK/providerは明示region `ap-northeast-1`、local dummyまたはFloci発行の合成role credential、maxAttempts=1、profile/metadata/default endpoint fallbackなし。
- Floci image `floci-local:2.2.0-refresh.1-native` / health `2.2.0-local-refresh.1-native` を維持。MiniStack/LocalStackへ変更しない。Docker socketはFlociのみ、FW/devcontainer編集なし。
- 実Hosted UI PKCE/S256・JWKS署名・Gateway JWT・Docker Lambdaを維持。偽authorizer context/API直接invoke/route削除・並べ替え/認証や入力緩和をEへ混ぜない。
- 製品値はaccess/ID300秒・refresh30日・rotation grace10秒、画像URL900秒、本文2097152/画像1048576 bytes、item1000/image134217728 bytes/rate120。Eの縮小quota/rate fixtureは正式overrideとして値を記録し、規定値のU/Iを維持する。
- cleanupは24h=86400000ms、lease20分=1200000ms、GSI12partition/KEYS_ONLY/page50、候補10000/delete5000/600秒/残り60秒/並行4とする。製品へtest clock/cap overrideを追加しない。
- 現行sourceからbuild/packageした同じZIPをAPI/cleanupへ登録し、SHA-256/S3 pinned version/checksum/CodeSha256/aliasを照合する。dirty非秘密入力digestを保存する。
- 元画像を変換しない。入力はBASE64/data URLとし、DBにはmetadataだけを保存する。直接upload APIを追加しない。
- random owned prefixとrun manifestを用意し、finallyで全リソースを回収して不在を確認する。cleanup errors/leaksは別々に集計する。例外/子プロセス/TF出力に秘密・raw body・全envを出さない。
- TFは新E2E root/local backend/run固有の合成inputs/stateだけを使う。本番root/backend/state/plan/private inputsは参照しない。所有するリソースだけをdestroyする。
- 必須のE/L/Iに未実施が残れば完了としない。TF/Scheduler/署名強制は必ず調査し、非対応は別に記載する。実AWS/IAM/TLS/PITR/Chrome/性能との同等性を推定しない。
- 製品バグ/Floci非互換は独立した失敗ケースと原因を記録する。製品動作の修正は、内容を提示して別途承認されるまでE2E実装へ含めない。host rebuild/接続先追加が必要なら、成果物と再開手順を保存して停止する。

## Review Focus

1. fixture初期化や一ケースの失敗で後続ケースが消え、全体がGREENに見える問題を確認する。inventoryを先に作り、not-runを残し、独立したケースを継続する（Task1/2/10）。
2. auth負例でsignature/期限/scopeの複数条件が同時に不正となり、偶然検証が通って拒否理由を誤認する問題を確認する。正常な対照と一条件の負例、実際に署名された期限切れtoken、層別のtoken_use検証を使う（Task3）。
3. S3 hostname/redirect/SDK endpointのfallbackやassert diffから秘密が漏れる問題を確認する。DNS pin、未知hostの拒否、全出力のcanary検査で確認する（Task1/2/6）。
4. image transaction失敗やcleanupの結果不明時に参照中のbytesを削除し、counterやcursorを重複させたり飛ばしたりする問題を確認する。実際の保存状態を照合し、before/after faultを使う（Task5/6/7/8）。
5. 未コミット変更のあるソース、古いZIP、partial apply、cleanup失敗を成功と扱う問題を確認する。snapshot hash/両CodeSha、stateの所有関係、終了コードの集約を確認する（Task2/9/10）。

## 承認後のSDD準備と実行手順

using-git-worktreesでリンクされたworktreeを再確認する。新worktreeの作成や未コミット変更のコピーは不要。
指定toolに不足があれば、そのtoolだけを復元する。まず必要なbuild/packageを行ってから既存回帰を実行し、開始時の実際の状態を記録する。
本計画を読み、新計画専用workspaceを `subagent-driven-development/scripts/sdd-workspace <本計画path>` で作る。
`progress.md` 第一行は `# SDD ledger — plan: docs/superpowers/plans/2026-10-08-reminder-server-formal-e2e.md`。
Task completionを読み、同じTaskを再dispatchしない。過去台帳は開かず、流用もしない。
preflightでは全Taskの内部整合性と、共有file/interfaceの全組み合わせを表にする。矛盾はspecに照らして判断し、rulingへ記録する。
ここに示す依存関係の要約だけで、この確認を代替しない。

順序はTask1→2→3→4→5→6→7→8→9→10。共有fixture実装者の並列は禁止。
各TaskでBASE記録→task-brief file→新規実装者→RED/最小/GREEN/self-review/explicit commit→
review-package→独立task reviewer（spec/quality両判定）の順に進める。実装者によるsubagentの起動は禁止する。
修正round1〜3は元実装者、4〜5は上位modelの新実装者が担当する。controllerは実装を直さない。
Taskのreviewerに、同じコードですでに通ったtestを再実行させない。
最終レビューでは、利用可能な中で最も能力の高いmodelの新規reviewer（現allowlistならgpt-6-astra、高いreasoning）がE2E全体を確認する。
mechanicalはgpt-6-luna、integrationはgpt-6.1-sol、architecture/judgmentはgpt-6-astraを目安に、
dispatch時のallowlistを確認しmodel/effort/fork_turns:noneを明示する。
最終findingsは、一回にまとめた修正dispatchと、修正範囲に限定した一回のレビューで対応する。残件はrulingsと影響を保存する。
最後に新台帳の全Rulingを公開結果へ転記してから、この計画のscratchだけを整理する。branchは保持し、push等はしない。

## 共通interface

Task1で型を、Task2で実fixtureを定義する。

`tests/e2e/floci/support/types.ts` に以下の契約を置く。秘密の値はメモリ内だけで扱う。

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
- `OwnedManifest` はrunId、resource kind/name/IDとcreated/removed状態だけを含む。secret/token/user-dataは含めない。
- `E2EFixture` はtarget/prefix/config/artifact/manifest、local clients、auth、`request(path: string, options?: { token?: string; method?: string; headers?: Record<string,string>; body?: string }): Promise<HttpResult>`、`setPublication(published: boolean): Promise<void>`、`dispose(): Promise<CleanupSummary>`。
- `LocalClients` は明示設定のDynamoDBDocumentClient/S3Client/LambdaClient/CloudWatchClient/STSClient。
- `AuthSession = { accessToken: string; idToken?: string; refreshToken: string; claims: { iss: string; sub: string; client_id: string; iat: number; exp: number; scope: string } }`。
- `FixtureAuth` は `login(owner: 'a'|'b', scopes: string[], client: 'primary'|'sibling'|'foreign'): Promise<AuthSession>` と `refresh(session: AuthSession): Promise<AuthSession>`。負例用の低水準exchange/refresh/revoke/disableはTask3のauth.tsで型を追記する。

## ファイル責務・依存

Task1がtransport/evidence/preflight/run registry、Task2がartifact/fixture/auth/storage/cleanupの共通基盤を所有する。
auth supportを拡張するのはTask3だけとする。Task4〜6は各suiteファイルと合成fixtureだけを作る。
Task7はcleanup suiteとfault support、Task8はoperations supportとfault suite、Task9はTF/compatibility、
Task10はdocsと最終集約・inventory回帰を担当する。各Taskでは新しいcase registry entryだけを追加し、既存entryは維持する。
`package.json` はTask1の入口追加、Task9のTF入口追加、Task10の文書照合だけ。lock依存変更は原則不要。

### Task 1: ローカルtransport・ケース一覧・安全な検証記録・実行入口

**Files:** Create `tests/e2e/floci/support/{types,transport,evidence,cases}.ts`, `scripts/e2e/{preflight,run}.ts`, `tests/integration/formal-e2e/harness.test.ts`; Modify `package.json`。

**Interfaces:** 上記型、`preflight(): Promise<LocalTarget>`、`localRequest(target: LocalTarget, url: URL, options: { method?: string; headers?: Record<string,string>; body?: string|Buffer }): Promise<HttpResult>`、`createEvidence(definitions: CaseDefinition[], runDirectory: string): Promise<Evidence>`、`runCase(definition: CaseDefinition, evidence: Evidence, action: () => Promise<void>): Promise<void>`、`runMain(argv: string[]): Promise<0|1|2>`。

- [ ] Step 1 RED: `harness.test.ts` に `reject_public_redirect_unknown_host_before_socket`、`dns_drift_preserves_host`、`failed_case_keeps_inventory_and_siblings`、`canary_never_reaches_report_or_stderr`、`cleanup_failure_changes_exit` を作る。外部hostへのsocket接続が0であることと、秘密canaryを含むAssertionErrorのdiff/stackも表示されないことをassertする。selected3でpass1/fail1/not-run1が残り、cleanup.errors1ならexit1となることもassertする。
- [ ] Step 2 RED実行: `PATH=… npx tsx --test tests/integration/formal-e2e/harness.test.ts`。未実装interfaceまたは期待安全性の失敗を記録。通信環境失敗をREDと呼ばない（以下の`PATH=…`はGlobal Constraintsの完全prefix）。
- [ ] Step 3 最小実装: 既存のpinnedRequestを参照して、DNS pin/元Host/no-redirect/30秒deadline、証拠allowlist/0700・0600、先行するcase registryの作成を実装する。子プロセスのenvはallowlistから安全な値だけで構築し、raw stderrを転送しない。入口は `e2e:preflight=tsx scripts/e2e/preflight.ts`、`test:integration:e2e=tsx --test tests/integration/formal-e2e/*.test.ts`、`test:e2e:floci=tsx scripts/e2e/run.ts --layer floci` とする。未知のsuite/caseはexit2とし、部分選択であることを表示する。失敗後の継続と、最上位の失敗情報からの秘密除去を保証する。
- [ ] Step 4 GREEN: harnessとpreflight、typecheck/lintを実行し、case assertionと安全な結果だけが出ることを確認する。現在のhealth/version/IPが不適合ならpreflightを失敗させ、fallbackしない。
- [ ] Step 5 commit/review: 上記create fileを個別列挙 + package.jsonだけstage、`test: add isolated formal E2E harness`。SAFE-01〜03、Review Focus1/3を独立レビュー。

### Task 2: 現行artifactと再利用可能なowned Floci fixture

**Files:** Create `scripts/e2e/prepare-artifact.ts`, `tests/e2e/floci/support/{artifact,fixture,auth,storage,cleanup}.ts`, `tests/e2e/floci/fixture.test.ts`; Modify `support/cases.ts`, `tests/integration/formal-e2e/harness.test.ts`。

**Interfaces:** `prepareArtifact(runDirectory: string): Promise<ArtifactSnapshot>`、`createFixture(options: FixtureOptions, artifact: ArtifactSnapshot, evidence: Evidence): Promise<E2EFixture>`、`readOwnerState(fixture: E2EFixture, ownerId: string): Promise<{ itemCount: number; imageBytes: number }>`、`readReminder(fixture: E2EFixture, ownerId: string, id: string): Promise<StoredReminder|null>`。DTO/typesは既存sourceを使う。fixture assertionsの期待データは独立して用意する。

- [ ] Step 1 RED: `fresh_zip_matches_both_pinned_functions`、`stale_manifest_and_tampered_zip_rejected_before_register`、`fixture_setup_failure_disposes_every_created_resource`、`hosted_pkce_health_publication_smoke` を作る。両CodeSha/S3 checksum/versionが一致し、aliasが選択したpublished versionを指すことを確認する。ready503→200、health200、未認証v2で401となることも確認する。各作成段階で疑似的に失敗させ、残存リソースが0となることをharnessでassertする。
- [ ] Step 2 RED実行: offline harnessを先に実行し、環境preflight後にfixture.testを実行する。exportの欠落または整合性検証によるFAILを記録する。
- [ ] Step 3 最小実装: 毎runでbuild→package→verify:zip、一つの0700 snapshotを作り、非秘密input path allowlistは `src/**/*.ts`, `scripts/build/{bundle,notices}.ts`, `scripts/build/package.py`, `package.json`, `package-lock.json`, `tsconfig.json`。symlink/outside pathを拒否しpath+bytesでinputDigest。build前後でinputDigest一致を要求し、途中のsource変更を拒否する。秘密pathは探索対象外。ZIPを別versioned owned bucketに登録、2handler/version/alias、3table/GSI、画像bucket、role/log/pool/client/scope/16route/CORS。fixture API LambdaはGatewayだけ、cleanup invokeは専用role。resource success後即manifest、reverse cleanupを用意し各ID不在確認。標準fixtureはproduction defaults、quota/rate試験だけ明示override。
- [ ] Step 4 GREEN: build/package検証、fixtureの実smoke、setup途中で失敗するharness、typecheck/lintを実行する。secret/ZIP raw dataを出力せず、cleanup errors/leaksがすべて0であることを確認する。OPS-05とSAFE-02の結果を記録する。
- [ ] Step 5 commit/review: 明示create/modifyのみ、`test: provision owned Floci fixtures from current ZIP`。Review Focus3/5とauth経路・IAM分離・artifact provenanceをレビュー。

### Task 3: 認証正常系・独立負例・rotation

**Files:** Create `tests/e2e/floci/auth.test.ts`, `tests/integration/formal-e2e/auth-claims.test.ts`; Modify `support/auth.ts`, `support/cases.ts`。

**Interfaces:** Task2 FixtureAuth。追加 `exchangeCode(fields: Record<string,string>): Promise<{ status:number; error?:string; session?:AuthSession }>`、`requestRefresh(token:string, client:'primary'|'sibling'): Promise<{ status:number; error?:string; session?:AuthSession }>`、`revoke(session:AuthSession):Promise<void>`、`disable(owner:'a'|'b'):Promise<void>`、`verifySession(session:AuthSession):void`。valueやerror_descriptionをpublic証拠へコピーしない。

- [ ] Step 1 RED: AUTH-01〜12をcasesへ展開する。一条件だけが不正な各負例の前後で、有効tokenによる200とRATE/storage不変を確認する。signatureだけの改変→401、same-pool sibling401、read-only POST403/write-only GET403、ID403を確認する。実際に署名されたtokenでexp前200/exp後401/refresh後200を確認する。PKCE wrong/missing verifier、callback mismatch、code reuse、S256以外を別codeで試す。Iには、既存requireOwnerを実際に呼び出してtoken_use/issuerを単独で検証する401ケースを作る。
- [ ] Step 2 RED実行: `PATH=… npx tsx --test tests/integration/formal-e2e/auth-claims.test.ts` と auth単独runner。負例準備自体の障害はnot-runで、REDの対象を新harness不足に限定する。
- [ ] Step 3 最小実装: 正常に発行されたtokenをlocal JWKSで検証し、署名/claimsの対照を値を含めずに保存する。AUTH-05で期待JWKSがforeign tokenを検証しない場合は、複合条件での拒否と単独条件のIを別resultにする。token lifetimeは300秒のままとし、expiry待ちを他authケースの後に置く。全体330秒・waitは30秒以下とする。refreshではgrant identity/scopes/ownerの保持、10秒grace前後、original deadlineの不延長、missing/malformed/sibling、revoke family、synthetic disableを確認する。30日絶対期限とChromeは、out-of-scope/Aの既知の制限として記録する。
- [ ] Step 4 GREEN: `test:e2e:floci -- --suite auth`、auth I、type/lint。case inventoryとpass/fail/not-run/unsupported、cleanup0を確認。FlociがPKCE負例を通すなら独立失敗記録、認証緩和しない。
- [ ] Step 5 commit/review: 明示path、`test: verify formal PKCE JWT and refresh contracts`。Review Focus2とscope/token_use/issuer独立性をレビュー。

### Task 4: API契約・入力境界・ページング

**Files:** Create `tests/e2e/floci/api.test.ts`, `tests/e2e/floci/support/input-fixtures.ts`; Modify `support/cases.ts`。

**Interfaces:** Task2 request/readReminderと`makeInput(overrides: Record<string,unknown>): Record<string,unknown>`、`makeJsonBodyBytes(bytes: number): string`。inputは合成のURL/title/date/booleansを使い、任意のownerId入力は禁止する。makeJsonBodyBytesはvalid JSONの余白で正確なUTF-8長を作る。

- [ ] Step 1 RED: API-01〜13、API-14の認証/入力gate順をparameter IDsへ展開。旧POST/PUT410、known6paths405/Allow、unknown404、DTO/header全field、owner全操作404、CORS/OPTIONS、media400/415、fields422、ID/codepoint128±1/URL4096±1/title1024±1、日時offset/閏日/invalid、JSON2097152±1。list51metadata・limit1/20/50/0/51、tombstone先頭empty page→cursor、BへA cursorと不正422をassert。
- [ ] Step 2 RED実行: api選択runner。不足case/harnessの失敗を記録。fixture初期化に失敗した時は全caseがnot-runになることもassert。
- [ ] Step 3 最小実装: suiteごとにfixtureを用意し、各caseはowner/item prefixで独立させる。入力拒否時にsnapshot storage/job/S3が変わらず、RATEは認証済みなら増えることを確認する。51個の初期seedは実APIを使い、rateの分境界の影響を避ける実行順を定める。encoded slashはURLを改変せず、Flociへの実pathで評価する。CORSはHTTP headersで確認し、実拡張ブラウザは未実施とする。負例が失敗した後も独立したcasesを実行する。
- [ ] Step 4 GREEN: api runner、既存api/contracts/boundaries/reads-rate covering、type/lint。旧APIやANYを触るproduct/Floci変更はしない。
- [ ] Step 5 commit/review: 明示path、`test: cover API contracts boundaries and pagination`。Gateway edge errorとLambda独自codeの区別をレビュー。

### Task 5: 強いETag・同時競合・quota/rateと保存状態の整合性

**Files:** Create `tests/e2e/floci/storage.test.ts`, `tests/integration/formal-e2e/concurrency.test.ts`; Modify `support/cases.ts`。

**Interfaces:** FixtureOptions.limits、Task2 readOwnerState/readReminder、Task4 input-fixtures。共通fixture本体の変更は不要。

- [ ] Step 1 RED: STORE-01〜06とAPI-14を独立したcasesにする。生HTTP body SHAによるexact rN-hexと、弱い/*/list/欠落/同revision別hash/逐次staleの拒否を確認する。barrierからPATCH/PATCH・DELETE/DELETE・PATCH/DELETEの2requestを送り、一方が200で他方が拒否され、revision/countersの変更が一回だけとなることを確認する。PATCH同士は412とし、DELETEが先に成功した後のcurrent readでは404を許容する。この分岐は、双方が旧activeを読むIのcontrolで分離する。create競合で一方が201、他方が409となること、different itemの保持、exact tombstone、再送で二重処理がないことを確認する。quota fixtureはitem2/image24、12byte PNG、rate3/two sessionsとし、4件目429とRetry-After一致を確認する。
- [ ] Step 2 RED実行: storage runnerとconcurrency I。real service成功を得るためretryを追加しない。開始window余裕をpreconditionとして固定し、窓を跨いだ結果はfail。
- [ ] Step 3 最小実装: request Promiseを同時releaseするhelperをsuite内で定義し、成功した要求と競合に負けた要求の保存snapshotを強い整合性のある読み取りで確認する。concurrency Iはreal service/storeのget portを限定してwrapする。双方が強い整合性のある読み取りで旧activeを読んだ後、barrierからcommitへ進めて一成功/一412を確認する。これはclaims注入HTTPとは別層とする。容量の上限手前をprepareし、二つのcreateを競合させ、一成功/一413、counter最大2を確認する。imageBytesは12bytesを二つ保存して第三の保存を拒否し、削除/clearで回復することを確認する。規定120/1000/128MiBとlowered-cap回復は既存U/Iを同時に記録する。ratefixtureの診断readはDDB control clientで行い、API数を増やさない。
- [ ] Step 4 GREEN: storage runner、concurrency I、writes/reads-rate/lowered-quotas covering、type/lint。I fakeの並行とE client同時送信を別layer表示する。
- [ ] Step 5 commit/review: 明示path、`test: assert concurrent revisions quotas and tombstones`。Review Focus4をレビュー。

### Task 6: 元画像・実URL取得・差し替え・孤児

**Files:** Create `tests/e2e/floci/images.test.ts`, `tests/e2e/floci/support/image-fixtures.ts`, `tests/fixtures/synthetic/formal-e2e/image-fixtures.md`; Modify `support/cases.ts`, `support/transport.ts`, `tests/integration/formal-e2e/harness.test.ts`。

**Interfaces:** `imageBytes(format:'png'|'jpeg'|'gif'|'webp', bytes?:number):Buffer`、`fetchOwnedImage(fixture:E2EFixture, url:string, ref:ImageRef):Promise<HttpResult>`。image fixtureは合成のsignature bytesを使い、元dataはメモリ内で扱う。生成規則は文書に記載する。URL/refはraw証拠に渡さない。

- [ ] Step 1 RED: IMG-01〜09。4形式BASE64/dataURL/null/empty/省略、bad BASE64/MIME、1048576±1、S3 pinned bytes/checksum/metadata/versions、DB no bytes。API URL900秒/GET元bytes/no Bearer/body/ETag不変。差し替え/clear/deleteのcommitted/retired/due/counter、新画像付きduplicate409→orphan pending。未知bucket/host/redirect/改変署名URLのtransport拒否をoffline harnessでassert。
- [ ] Step 2 RED実行: offline harness→images runnerの順に実行する。hostnameが解決できない場合は診断上の制限として記録し、URL/Host/queryを書き換えて成功にしない。
- [ ] Step 3 最小実装: private IP discoveryに整合するowned bucket hostだけをsocket pinへ追加する。fetch前にowned key/version/endpointを検査し、URLはメモリ内だけで扱う。署名強制probeでは、正常なcontrol、signatureだけの改変、短期限の独立URLに対するexp後の拒否を比較する。実APIの900秒とは別resultにする。Flociが改ざんを許可した場合はunsupportedを記録し、runtime設定変更は差分の提案までとする。必須の画像Eの保存/取得が阻害されるなら、正式E2Eは未完了とする。
- [ ] Step 4 GREEN: images runner、既存images/contracts covering、harness/type/lint。valid取得だけをSigV4強制成功としない。画像fixtureのfake PNGを実画像decoder検証済みとしない（製品はsignature検査契約）。
- [ ] Step 5 commit/review: 明示path、`test: preserve original images through authenticated API`。Review Focus3/4、secret URL診断、孤児job条件をレビュー。

### Task 7: 実清掃の状態遷移・合成日時・中断と上限

**Files:** Create `tests/e2e/floci/cleanup.test.ts`, `tests/e2e/floci/support/cleanup-fixtures.ts`, `tests/integration/formal-e2e/{fault-transport,cleanup-resume.test}.ts`; Modify `support/cases.ts`。

**Interfaces:** `invokeCleanup(fixture:E2EFixture):Promise<{ functionError?:string; result?:CleanupResult }>`、`seedCleanupJobs(fixture:E2EFixture, jobs:ImageJob[]):Promise<void>`、`FaultRule={command:string; occurrence:number; phase:'before'|'after'|'delay'; effect:'throw'|'abort'}`、`createFaultTransport(delegate:RequestHandler,rules:FaultRule[]):{handler:RequestHandler; trace:ReadonlyArray<{command:string; occurrence:number; phase:string}>}`。RequestHandlerは既存SDK client configが受ける型からderiveし、secret/body非保存。FaultRule.commandはSDK command名への明示対応表。

- [ ] Step 1 RED: CLEAN-01〜09。unpublished0、activelease保持/expireddone、24h両側/retired起点、committed/current画像保護、version/checksum mismatch保持、marker後version読取、same shard51/page50、二invoke収束、event injection拒否。Iはpage途中abort→cursor開始を維持、GSI stale/current read condition、claim/upload race、marker after-response-lost、checkpoint/metric失敗を単独注入。
- [ ] Step 2 RED実行: cleanup-resume Iとcleanup runnerを実行する。HTTP200が返ってもFunctionErrorを見落とさない。seedjobがowned合成tableで正しいschema/GSI属性を持つことを、準備時にassertする。
- [ ] Step 3 最小実装: Task6のreal APIから作ったcommitted/retired/orphanを再現するfixtureと、独立した合成jobを用意する。時刻の両側に5秒以上の余裕を取り、正確な等号はclockを制御したIで検証する。12partitionの末尾reset/51件は、GSI反映を期限付きpollで確認した後にinvokeする。fault adapterは送信前の故障と実送信後の応答遮断を区別し、traceへ固定codeだけを記録する。規定10000/5000/600/60/4の既存limit試験を保持し、小さなinventoryで実adapterの中断・再開を検証するケースを追加する。製品overrideは作らない。
- [ ] Step 4 GREEN: cleanup runner、cleanup-resume I、既存jobs/cleanup/images covering、type/lint。削除actorがVersionId永久削除を送信しないことはI trace、実version保持はLで確認。
- [ ] Step 5 commit/review: 明示path、`test: verify durable cleanup leases checkpoints and protections`。Review Focus4、fake索引遅延とreal GSI観測の区別をレビュー。

### Task 8: 合成移行・復旧・依存先故障と実adapterの結合

**Files:** Create `tests/e2e/floci/operations.test.ts`, `tests/e2e/floci/support/operation-fixtures.ts`, `tests/integration/formal-e2e/faults.test.ts`; Modify `support/cases.ts`。

**Interfaces:** `localMigrationRuntime(fixture:E2EFixture):MigrationRuntime`、`localRecoveryRuntime(fixture:E2EFixture):RecoveryRuntime`、`writeSyntheticOperationInputs(fixture:E2EFixture, directory:string):Promise<{source:string; mapping:string; config:string; restoredConfig:string; ownerIdentities:string; ownerMap:string}>`。型は既存migrate-json/verify-recoveryのexportを使用。

- [ ] Step 1 RED: OPS-01〜04、STORE-07、IMG-08。two owners（空owner/特殊key含む）dry-run/import/verify/publish→ready503/200、source hash不変（合成のみ）、rerun counts/versions不増。changed bytes/map/limits拒否・corrupt image禁止。restored-only prepare/verify/preserve/remap/rerun、source table/version不変・Cognito復元false。before/after Put/commit/read/rate失敗で503/未公開/committed保護/counter不重複、abort settlementをassert。API-01の `ready_dependency_failure_keeps_health200` はcreateApiHandlerの実depsへprobe faultを渡して確認する。
- [ ] Step 2 RED実行: faults Iとoperations runnerを実行する。ローカルSTS accountと明示した合成targetの一致を事前確認し、共有AWSへのfallbackを許可しない。
- [ ] Step 3 最小実装: 既存 `migrationMain(argv,io,runtime?)` / `recoveryMain(argv,io,runtime?)` の注入interfaceを使い、local clientsで `createMigrationStore/createMigrationImagesStore/createRecoveryStore` を構成する。createMigrationDeps/createRecoveryDepsのdefault credential chainは呼ばない。raw IOから転送するのはsafe fieldsだけとする。運用用の全table scansはowned resourcesへ限定し、通常API/cleanupのScan禁止と区別する。復旧は本物のPITRではなく、合成snapshotを持つ別3table、同じ画像bucket、read-onlyのsourceを使う。role/環境/handlerの製品変更はしない。
- [ ] Step 4 GREEN: operations runner、faults I、既存legacy/migration/recovery covering、type/lint。画像保全後の強いread/pinned bytes、default verify前後のrestoredも不変を確認。
- [ ] Step 5 commit/review: 明示path、`test: integrate synthetic migration recovery and uncertain outcomes`。Review Focus4とsource不変/未公開gate/再実行安全性をレビュー。

### Task 9: 独立Terraform apply/destroyとScheduler互換性の採否

**Files:** Create `tests/e2e/floci/{terraform,scheduler}.test.ts`, `scripts/e2e/terraform.ts`, `tests/e2e/floci/infra/{versions,variables,main,outputs}.tf`, `tests/e2e/floci/infra/.terraform.lock.hcl`, `tests/integration/formal-e2e/terraform-driver.test.ts`; Modify `support/cases.ts`, `package.json`, `docs/operations/formal-e2e-research.md`。

**Interfaces:** `TerraformProbeResult={status:'pass'|'fail'|'unsupported'; failedAction?:string; cleanup:CleanupSummary; assertions:string[]}`、`runTerraformProbe(fixture:E2EFixture,directory:string):Promise<TerraformProbeResult>`。state directoryはrun manifestに紐付け、他runや対象外のpathは禁止する。共通API assertionsはfixture.requestと互換性のあるbindingをTF outputsから生成し、値を公開出力へdumpしない。

- [ ] Step 1 RED: TF-01/02、OPS-06、`unknown_endpoint_and_foreign_state_rejected_before_spawn`、`partial_apply_always_attempts_owned_destroy`、`provider_output_canary_not_logged` を作る。分離したprocess fakeで、default endpoint/foreign stateではspawnが0であることを確認する。partial失敗でも回収を試み、errorsを別集計し、unsupportedをpassに数えないことを確認する。実Schedulerではdaily configを読み戻し、owned atからcleanup checkpoint/jobが変化することを確認する。
- [ ] Step 2 RED実行: offline terraform-driver。その後version/schema/endpoint/APIのread-only preflight。Context7のlibrary→docsをsandbox外、各質問最大3command、quotaは明示。6.67.0は実schemaを確認、索引mainだけでversion適合を確定しない。
- [ ] Step 3 最小実装: 新rootはlocal backend、pinned lock、dummy keys、metadata/profile閉鎖、全使用service endpoints明示。ZIP uploadとsynthetic Cognito userはSDK fixture、TFはowned3table/bucket/role/両ZIP functions/version/alias/Gateway/16routes/CORSを必要APIの段階ごとに追加。providerの付随read/Tag/waiterが不足ならfailedActionと最小probeを保存してunsupported。production tfを編集しない。supportedならTF outputs上でhealth/ready/auth拒否/CRUD/画像bytes/CodeSha共通assert→finally destroy→owned不在確認。`test:e2e:terraform=tsx scripts/e2e/run.ts --layer terraform`。
- [ ] Step 4 Scheduler/互換性記録: 別owned groupでdaily03UTC/OFF/DISABLED/retry2/3600/cleanup alias設定を読み戻す。独立at+input{}は90秒以内の期限付きpollで確認する。確認後はschedule停止/削除→invocation終了確認→リソース回収の順に進める。runtimeが起動しない場合はunsupported/failの理由を区別し、日次運転/IAM/asyncの同等性を主張しない。hostの再設定が必要なら、差分・再開手順を保存して停止する。
- [ ] Step 5 GREEN/採否: offlinedriver/type/lint/fmt/validateと、対応している場合のapply testを実行する。SDK daily/one-time probeの実測をservice API表へ記載する。unsupportedのsuite選択でexit1となるのは期待された互換性判定であり、GREENとは書かない。cleanup/leaksは常に0が必要。
- [ ] Step 6 commit/review: 明示pathと研究記録のみ、`test: probe isolated Terraform and Scheduler integration`。Review Focus5、local state ownership・AWS送信防止・非対応の証拠をレビュー。

### Task 10: 日本語手順・全case照合・新たな実行結果

**Files:** Create `docs/operations/formal-e2e-{README,results,limitations}.md`, `tests/integration/formal-e2e/coverage.test.ts`; Modify `README.md`, `docs/operations/formal-e2e-coverage.md`, `support/cases.ts`, `scripts/e2e/run.ts`（最終inventory統合のみ）。

**Interfaces:** CaseDefinition/CaseResult/RunSummary。`coverage.test.ts`は対応表のID集合とregistryのrequirementId、required/layer/source、all suite inventoryを照合する。

- [ ] Step 1 RED: `every_required_case_has_result_and_source`、`partial_selection_cannot_claim_full_completion`、`unsupported_not_run_cleanup_are_separate` を作る。fixtureの最上位での失敗/timeoutでは、全caseがnot-runとして残りexit1となることをassertする。結果から消えたcaseや出力されたbody canaryが0であり、U/AだけのrowをE必須にしないこともassertする。
- [ ] Step 2 RED実行: coverage/harness/terraform-driverのoffline試験を実行する。ケースplaceholderを未実施のままpassにしない。
- [ ] Step 3 最小完成: registry/matrix/READMEの実存在入口を一致させ、依存準備・fixture生成・suite選択・失敗診断・owned recovery・後片付け・CI runner準備を日本語で記載。現在のpatched imageのhost準備は既存手順へリンク、GHA/workflow変更なし。結果reportはfresh UTC、HEAD/dirty入力digest/tool/ZIP/API-cleanup hashes、layer別counts/required not-run/unsupported、cleanup/leaks、review/rulings、既知制限を保持。
- [ ] Step 4 fresh検証: prefix付き `npm ci`（必要時）、typecheck/lint→build/package/verify:zip→`npm test`→test:packaging→必要infra:check→audit:runtime/audit:all→test:integration:e2e→test:e2e:floci→test:e2e:terraform。ZIPはE2E prepareでも現行buildから作る。Floci必須groupsを全実行、TF非対応はfail/unsupportedとして別結果。順序/実際のcommand/exit/count/安全なwarningsを記録。今回のuser baseline diffはstageしていない新E2E pathだけを検査。
- [ ] Step 5 commit/task review: 日本語docs/registry/runner限定path、`docs: record reproducible formal E2E evidence and limits`。未実施/cleanupが漏れず、既存337件等をfresh結果なしで流用していないことをレビュー。
- [ ] Step 6 controller final review: Task1〜10の範囲のreview packageと、deferred/parked/rulings全件を、最も能力の高いreviewerへ渡す。修正waveの上限を守る。必須E/L/Iが未完了なら未完了と報告し、製品修正の承認を求める前に独立した失敗の証拠を提示する。

## 実行計画の自己レビューと承認対象

AUTH→Task3、API→Task4/5、STORE→Task5/8、IMG→Task6/8、CLEAN→Task7、
OPS→Task2/8/9、TF→Task9、SAFE→Task1/2/10。Review Focusの全項目に失敗ケースを割り当てた。
共通型・署名と既存operationsのexportsを照合した。製品ソースの変更やprivate入力の参照は含めず、
現行ソースからのartifactと新たな検証記録の準備・cleanup・非対応判定を計画に含めた。
承認待ちの対象は、新E2Eの設計/対応表とこの計画である。実行方式はSDDを維持する。
旧taskは再開せず、新計画専用台帳を承認後に作成する。
