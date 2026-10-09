# Reminder Server Formal E2E Implementation Plan（承認済み）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Terraformで意図どおりに構築されたことを確認し、入力に対するHTTP・DynamoDB・S3・CloudWatchの結果を検証する。失敗と未実施を証拠で区別する。

**Architecture:** 接続先を明示したローカルtransportと、この実行が所有するfixtureを使い、実Hosted UI PKCE→JWT Gateway→現行ZIP Docker Lambda→DDB/S3を実行する。清掃/合成運用は同じartifactまたは既存の実adapterを使う。先に本番3rootの公開ソースを一時ディレクトリで再利用してFlociに構築し、設定を読み戻してから、その基盤で入力に対するDDB/S3/CloudWatchの最終結果を確認する。決定的な故障は独立した結合試験で記録する。

**Tech Stack:** Node24.21.0/npm11.11.1、Python3.13.16、TypeScript/CommonJS/tsx/node:test/node:assert、既存固定AWS SDK v3。Terraform1.16.5/AWS provider6.67.0（本番3rootを再利用、stateはlocal）。

**Spec:** [正式E2E設計](../specs/2026-10-08-reminder-server-formal-e2e-design.md)、[要件対応表](../../operations/formal-e2e-coverage.md)、[調査記録](../../operations/formal-e2e-research.md)。製品契約は[承認済みAWS設計](../specs/2026-10-02-reminder-server-aws-design.md)と現行API/運用文書。

**Status:** 2026-10-08承認済み・実装未着手。6指摘への改訂（commit 2d275c0）提示後、ユーザーが設計/対応表/本計画と独立API結果ログ計画を承認した。E2E実装は先行APIログ変更の完了commitを前提とする。[承認記録と実装引き継ぎ](../handoffs/2026-10-08-reminder-server-formal-e2e-implementation.md)に従い、別セッションで実装を開始する。同じ範囲の承認を再確認しない。
ハンドオフが許可した文書作成の範囲で、設計案と計画案を同時に提示した。SDD方式は選択済みのため、再確認は不要。

## 作る順序と、テストを実行する順序

Task1〜12は実装する順序であり、完成したE2Eの実行順序とは異なる。
実行時は、preflight/ZIP準備→本番3rootのlocal apply→設定読み戻し/ログsmoke→
合成user/データ準備→実入力→HTTP/DDB/S3/CloudWatch照合→結果確定→保護解除/回収の順とする。
runにつき一組の3root基盤とZIPを用意し、全suiteを逐次実行する。suite間は合成データ回収と公開状態/checkpoint等の復元・読み戻しを行う。基盤destroyはrun末尾だけ。初期seed/引き渡しと復旧入力の切替・戻し以外は再applyしない。
Task3が構築、Task4が設定確認とrunnerへの組み込み、Task5〜10が各ケースの入力と出力照合、Task12が全体集約を担当する。
Task5〜10はTask4の保存状態・ログobserverを使う。保存状態は各ケース内、ログは期待登録後にsuite末尾の一括flushで確認し、全出力が揃うまでpassにしない。
Task11ではログの配信先・相関・件数を追加検証する。各ケースのログ確認をTask11だけに任せない。
TFの実apply・設定確認はL、driver/sourceの負例はI。`--layer floci|terraform`は実行入口の選択値とする。

### 設計変更を反映するタスク

| 設計で定めたこと | 計画で実装・確認すること | 担当 |
| --- | --- | --- |
| apply成功と本番設定の一致を先に確認 | 本番3root再利用、設定読み戻し、確認前のケース開始を防ぐrunner | Task3/4 |
| 入力に対する最終出力で合否を決める | HTTP/DDB/S3/ログの期待と照合結果をケースごとに記録。対象外には理由を付ける | Task1/5〜10/12 |
| API削除直後と清掃後の結果を分ける | tombstone・counter減少・画像保持から、清掃後の現行GET404・元version保持まで確認 | Task7〜9 |
| エラーの発生元と内容を確認 | Lambda到達時はAPIのstatus/code、認証拒否はHTTP/保存不変と正常対照付きAPI結果ログ不在。Gateway配信probeとI captureは必須実配信と区別 | Task2/4〜11 |
| 未実施と実行後の失敗を分ける | 初期化で阻害された未開始ケースはnot-run、入力後の保存・ログ不一致はfail | Task1/4/12 |

## Global Constraints

- 既存worktree `/workspace/.worktrees/aws-sdd` / `feature/aws-sdd-implementation` を使用し、reset/checkout/historyの改変はしない。旧19タスクを再dispatchしない。
- 未コミットのnull-body修正、過去の未追跡成果物、root FWのユーザー変更を保持する。本計画では新E2Eの明示したpathだけをstageする。API結果ログは独立計画で先に完了させる。
- 実AWS/GHA/push/PR/mergeは禁止。実データ/私有.env/AWS credentials/private mapping/state/plan/画像backupの読み取り・hash計算・表示・コピーも禁止する。
- Node24.21.0/npm11.11.1/Python3.13.16、TFを使う場合1.16.5/provider6.67.0。全npm/npx/Python/準備commandは `PATH=/tmp/aws-sdd-tools/node_modules/.bin:/tmp/aws-sdd-tools/bin:$PATH` を付ける。
- 接続先は `http://floci:4566` とそのdiscoveryで確認した同一RFC1918 IPv4/owned S3 hostだけ。SDK/providerは明示region `ap-northeast-1`、local dummyまたはFloci発行の合成role credential、maxAttempts=1、profile/metadata/default endpoint fallbackなし。
- Floci image `floci-local:2.2.0-refresh.2-native` / health `2.2.0-local-refresh.2-native` を維持。MiniStack/LocalStackへ変更しない。Docker socketはFlociのみ、FW/devcontainer編集なし。 2026-10-09にユーザー承認のうえ、Lambda AddPermissionのSourceAccount保持修正を追加したrefresh.2へ更新した（root commit 7a9b60f）。
- 実Hosted UI PKCE/S256・JWKS署名・Gateway JWT・Docker Lambdaを維持。偽authorizer context/API直接invoke/route削除・並べ替え/認証や入力緩和をEへ混ぜない。
- 製品値はaccess/ID300秒・refresh30日・rotation grace10秒、画像URL900秒、本文2097152/画像1048576 bytes、item1000/image134217728 bytes/rate120。E/Lはruntime_limits={}として規定値を維持する。容量境界は規定値のI、rate境界は合成count119から実HTTPで確認する。
- cleanupは24h=86400000ms、lease20分=1200000ms、GSI12partition/KEYS_ONLY/page50、候補10000/delete5000/600秒/残り60秒/並行4とする。製品へtest clock/cap overrideを追加しない。
- 現行sourceからbuild/packageした同じZIPをAPI/cleanupへ登録し、SHA-256/S3 pinned version/checksum/CodeSha256/aliasを照合する。dirty非秘密入力digestを保存する。
- 元画像を変換しない。入力はBASE64/data URLとし、DBにはmetadataだけを保存する。直接upload APIを追加しない。
- random owned prefixとrun manifestを用意し、finallyで全リソースを回収して不在を確認する。cleanup errors/leaksは別々に集計する。例外/子プロセス/TF出力に秘密・raw body・全envを出さない。
- 既存の本番3rootの公開ソースを再利用し、module化・本番.tf/lockの編集・resource address移動をしない。本番backend/state/plan/private inputsを読まず、local backend/run固有の合成inputs/stateを使う。接続・隔離以外の設定差分は検証中に加えない。保護解除はowned資源の後片付け段階だけで行う。
- Terraform apply・設定確認・CloudWatch結果ログ配信は必須。基盤初期化失敗では依存E/Lをnot-run、入力後の保存/ログ不一致はfailとして残す。正式E2Eは未完了とし、独立U/Iは継続する。Gateway配信/Scheduler起動/署名強制の互換性調査結果は別に記載する。必須E/L/Iに未実施が残れば完了としない。実AWS/IAM/TLS/PITR/Chrome/性能との同等性を推定しない。
- 製品バグ/Floci非互換は独立した失敗ケースと原因を記録する。API結果ログは[独立計画](2026-10-08-reminder-server-api-result-logging.md)で先行承認・実装・検証・コミットする。本計画で製品動作の修正は行わず、内容を提示して別途承認されるまでE2E実装へ含めない。host rebuild/接続先追加が必要なら、成果物と再開手順を保存して停止する。

## Review Focus

1. fixture初期化や一ケースの失敗で後続ケースが消え、全体がGREENに見える問題を確認する。inventoryを先に作り、not-runを残し、独立したケースを継続する（Task1/3/4/12）。
2. auth負例でsignature/期限/scopeの複数条件が同時に不正となり、偶然検証が通って拒否理由を誤認する問題を確認する。正常な対照と一条件の負例、実際に署名された期限切れtoken、層別のtoken_use検証を使う（Task5）。
3. S3 hostname/redirect/SDK endpointのfallbackやassert diffから秘密が漏れる問題を確認する。DNS pin、未知hostの拒否、全出力のcanary検査で確認する（Task1/4/8）。
4. image transaction失敗やcleanupの結果不明時に参照中のbytesを削除し、counterやcursorを重複させたり飛ばしたりする問題を確認する。実際の保存状態を照合し、before/after faultを使う（Task7/8/9/10）。
5. 未コミット変更のあるソース、古いZIP、partial apply、cleanup失敗を成功と扱う問題を確認する。snapshot hash/両CodeSha、stateの所有関係、終了コードの集約を確認する（Task3/4/12）。

## 承認後のSDD準備と実行手順

using-git-worktreesでリンクされたworktreeを再確認する。新worktreeの作成や未コミット変更のコピーは不要。
指定toolに不足があれば、そのtoolだけを復元する。まず必要なbuild/packageを行ってから既存回帰を実行し、開始時の実際の状態を記録する。
本計画を読み、新計画専用workspaceを `subagent-driven-development/scripts/sdd-workspace <本計画path>` で作る。
`progress.md` 第一行は `# SDD ledger — plan: docs/superpowers/plans/2026-10-08-reminder-server-formal-e2e.md`。
Task completionを読み、同じTaskを再dispatchしない。過去台帳は開かず、流用もしない。
preflightでは全Taskの内部整合性と、共有file/interfaceの全組み合わせを表にする。矛盾はspecに照らして判断し、rulingへ記録する。
ここに示す依存関係の要約だけで、この確認を代替しない。

先行APIログ計画の完了を確認後、順序はTask1→2→3→4→5→6→7→8→9→10→11→12。Task2は前提の確認であり、新機能のTDD実装は独立計画へ置く。共有fixture実装者の並列は禁止。
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

Task1で型、Task3でTerraform構築、Task4でその出力に接続するfixtureを定義する。

`tests/e2e/floci/support/types.ts` に以下の契約を置く。秘密の値はメモリ内だけで扱う。

- `Layer = 'U' | 'I' | 'E' | 'L' | 'A'`、`CaseStatus = 'pass' | 'fail' | 'not-run' | 'unsupported' | 'out-of-scope'`。今回のrunnerはE/L/Iを実行し、Uは別回帰証拠、Aはout-of-scopeとして区別する。
- `OutputKind = 'http' | 'dynamodb' | 's3' | 'logs'`、`OutputExpectation = { kind: OutputKind; assertions: string[]; notApplicableReason?: string }`。各caseに4種類を定義し、対象外はassertionsを空にして理由を付ける。画像のないAPI操作ではS3の追加保存なしをassertする。
- `OutputResult = { kind: OutputKind; status: 'pass' | 'fail' | 'not-applicable'; assertions: { name: string; status: 'pass' | 'fail' }[]; reason?: string }`。passを記録する前に、定義済みの全assert名と成功結果を確認する。not-applicableはassertionsが空で、ケース定義の理由と一致する場合だけ使用する。assert名・理由に実データを含めない。
- `CaseDefinition = { id: string; requirementId: string; layer: Layer; required: boolean; acceptance: 'behavior' | 'compatibility'; suite: string; source: string; outputs: OutputExpectation[] }`。Gateway配信/Scheduler起動/署名強制probeはrequired=trueかつacceptance=compatibility。実測・固定reason・制限付きunsupportedで調査完了とできるが、not-run/harness failは未完了。behaviorのunsupportedはexit1とする。
- `CaseResult = { id: string; status: CaseStatus; phase: string; httpStatus?: number; code?: string; durationMs: number; outputs?: OutputResult[]; reason?: string }`。reasonは固定enum文言。passには定義済みの全出力の照合結果が必要で、not-runでは未確認の出力をpassとして埋めない。
- `Evidence` は `runId: string` と `record(result: CaseResult): Promise<void>`、`finish(cleanup: CleanupSummary): Promise<RunSummary>`。
- `CleanupSummary = { attempted: number; succeeded: number; errors: number; leaks: number }`。
- `RunSummary = { selected: number; passed: number; failed: number; notRun: number; unsupported: number; outOfScope: number; cleanup: CleanupSummary; exitCode: 0 | 1 | 2 }`。
- `LocalTarget = { endpoint: 'http://floci:4566'; region: 'ap-northeast-1'; addresses: ReadonlyMap<string, string> }`。
- `HttpResult = { status: number; headers: Headers; bytes: Buffer }`。raw結果は証拠へserializeしない。
- `ArtifactSnapshot = { zipPath: string; sha256Hex: string; sha256Base64: string; compressedBytes: number; inputDigest: string; dirtyPaths: string[] }`。
- `FixtureOptions = { publication: boolean }` はrun共通基盤の初期設定。`SuiteOptions = { suite: string; publication: boolean }` は共有基盤に接続するsuite用view。実E/Lのruntime_limitsは空、Configの規定値を使用する。
- `OwnedManifest` はrunId、resource kind/name/IDとcreated/removed状態だけを含む。secret/token/user-dataは含めない。
- `E2EFixture` はrun共通のtarget/prefix/config/artifact/manifest、local clients、auth、`request(path: string, options?: { token?: string; method?: string; headers?: Record<string,string>; body?: string }): Promise<HttpResult>`、`setPublication(published: boolean): Promise<void>`、`resetSuite(): Promise<CleanupSummary>`（suite ownedデータ・controlの回収と設定復元）、`dispose(): Promise<CleanupSummary>`（runnerだけがrun末尾に一回呼ぶ）。`SuiteFixture = Omit<E2EFixture, 'dispose'>` をsuiteへ渡し、run所有者だけがdisposeを保持する。
- `LocalClients` は明示設定のDynamoDBDocumentClient/S3Client/LambdaClient/CloudWatchClient/CloudWatchLogsClient/STSClient。
- `AuthSession = { accessToken: string; idToken?: string; refreshToken: string; claims: { iss: string; sub: string; client_id: string; iat: number; exp: number; scope: string } }`。
- `PreparedTerraformRoots` はbootstrap/platform/applicationのrun専用path、sourceDigest、transformedDigest、2validationの構造差分、生成設定の区分と変更先一覧。秘密と生成state/planを公開結果へ含めない。
- `ProvisionedStack` はtarget/artifact/manifest、非秘密resource bindings、run専用state directory、`destroy(): Promise<CleanupSummary>`。state/outputsは公開証拠へdumpしない。
- `LogExpectation = { service: 'api'|'gateway'|'cleanup'; requestId?: string; lambdaRequestId?: string; since: number; mode: 'present'|'absent'; until?: number; status?: number; operation?: string; code?: string }`、`SafeLogMatch`は許可項目とevent件数だけ。API結果にはrequestId/statusを必須とし、Gateway配信probeは取得可能な場合だけrequestId/statusを照合する。statusを出さない既存cleanup_startにはoperation/lambdaRequestIdを指定する。
  清掃の終了ログのrequestIdはservice runIdとして区別する。開始・終了の対応と件数はTask4のexpectCleanupLogsで確認する。
- `FixtureAuth` は `login(owner: 'a'|'b', scopes: string[], client: 'primary'|'sibling'|'foreign'): Promise<AuthSession>` と `refresh(session: AuthSession): Promise<AuthSession>`。負例用の低水準exchange/refresh/revoke/disableはTask5のauth.tsで型を追記する。

- `PendingLogCheck` はcaseIdと許可された期待条件を保持する内部型。CaseStatusへpendingを追加しない。`CaseRecorder = { recordOutput(result:OutputResult):void; deferLogs(check:PendingLogCheck):void }` とし、action終了後もログ照合前のケースは内部保留にする。suite flushの結果を統合してからEvidence.recordを呼ぶ。観測失敗でも実施情報・部分結果を保存し、実施済みcaseをfailにする。

## ファイル責務・依存

Task1がtransport/evidence/preflight/run registry、Task2が独立APIログ変更の前提確認、Task3がartifact/Terraform driverを所有する。
Task4がfixture/auth/storage/cleanup/logsと設定読み戻しを実装し、Task3と接続してrunnerの実行順序を完成させる。auth拡張はTask5、API/保存/画像suiteはTask6〜8、
cleanupはTask9、合成運用はTask10、Scheduler起動とサービス別ログ確認はTask11、全体集約はTask12。
各Taskは新しいcase entryを追加し、既存entryを維持する。共有ファイルの変更は逐次実装する。
`package.json` はTask1の入口、Task3のTerraform入口、Task4のLogs読取devDependency、Task12の入口照合。
Task4で既存SDK固定versionに合わせた `@aws-sdk/client-cloudwatch-logs` の公開versionを確認し、必要なlock更新だけを行う。
本番runtime依存へは追加しない。

### Task 1: ローカルtransport・ケース一覧・安全な検証記録・実行入口

**Files:** Create `tests/e2e/floci/support/{types,transport,evidence,cases}.ts`, `scripts/e2e/{preflight,run}.ts`, `tests/integration/formal-e2e/harness.test.ts`; Modify `package.json`。

**Interfaces:** 上記型、`preflight(): Promise<LocalTarget>`、`localRequest(target: LocalTarget, url: URL, options: { method?: string; headers?: Record<string,string>; body?: string|Buffer }): Promise<HttpResult>`、`createEvidence(definitions: CaseDefinition[], runDirectory: string): Promise<Evidence>`、`runCase(definition: CaseDefinition, evidence: Evidence, action: (recorder:CaseRecorder) => Promise<void>): Promise<void>`、`runMain(argv: string[]): Promise<0|1|2>`。actionは照合のたびにrecorder.recordOutputへ結果を渡し、ログ期待はrecorder.deferLogsへ登録する。runCaseは出力の照合結果が不足・重複・不一致ならpassにしない。actionが途中で失敗した場合も、入力実施情報と、それまでに得た照合結果を記録する。

- [ ] Step 1 RED: `harness.test.ts` に `reject_public_redirect_unknown_host_before_socket`、`dns_drift_preserves_host`、`failed_case_keeps_inventory_and_siblings`、`canary_never_reaches_report_or_stderr`、`cleanup_failure_changes_exit` を作る。外部hostへのsocket接続が0であることと、秘密canaryを含むAssertionErrorのdiff/stackも表示されないことをassertする。selected3でpass1/fail1/not-run1が残り、cleanup.errors1ならexit1となることもassertする。構築前の阻害はnot-run、入力後のログ欠落はfailでHTTP実施情報が残ること、TF実構築のlayerがL、driver負例がIとなることも確認する。HTTPだけ一致し、定義されたDDB/S3/ログの照合結果が欠けたケースはpassにならないことをassertする。
  suite一括flush前の早期passと、observer失敗時に入力済みcaseがnot-runへ戻ることを拒否する。前後対照ログが欠けた不在確認をpassにしない。出力4種類が揃っても、定義したassert名の一部が欠けたケースはpassにしない。対象外理由なし・期待外の対象外・assert名の重複も拒否する。
- [ ] Step 2 RED実行: `PATH=… npx tsx --test tests/integration/formal-e2e/harness.test.ts`。未実装interfaceまたは期待安全性の失敗を記録。通信環境失敗をREDと呼ばない（以下の`PATH=…`はGlobal Constraintsの完全prefix）。
- [ ] Step 3 最小実装: 既存のpinnedRequestを参照して、DNS pin/元Host/no-redirect/30秒deadline、証拠allowlist/0700・0600、先行するcase registryの作成を実装する。子プロセスのenvはallowlistから安全な値だけで構築し、raw stderrを転送しない。run本体75分/回収15分/全体90分と設計§3の工程別期限を実装し、子process timeoutはsafe診断とmanifestへ記録する。入口は `e2e:preflight=tsx scripts/e2e/preflight.ts`、`test:integration:e2e=tsx --test tests/integration/formal-e2e/*.test.ts`、`test:e2e:floci=tsx scripts/e2e/run.ts --layer floci` とする。未知のsuite/caseはexit2とし、部分選択であることを表示する。失敗後の継続と、最上位の失敗情報からの秘密除去を保証する。
- [ ] Step 4 GREEN: harnessとpreflight、typecheck/lintを実行し、case assertionと安全な結果だけが出ることを確認する。現在のhealth/version/IPが不適合ならpreflightを失敗させ、fallbackしない。
- [ ] Step 5 commit/review: 上記create fileを個別列挙 + package.jsonだけstage、`test: add isolated formal E2E harness`。SAFE-01〜03、Review Focus1/3を独立レビュー。

### Task 2: 独立API結果ログ変更の完了を確認する

**Files:** Modify `docs/operations/formal-e2e-research.md`（前提の記録だけ）。製品コード・runtime試験を変更しない。

**Interfaces:** 独立計画で確定したwithApiResultLogging/ApiHandlerの契約と、その承認・完了commit・試験記録。

- [ ] Step 1 前提確認: [API結果ログ計画](2026-10-08-reminder-server-api-result-logging.md)の独立承認・review・commitと変更範囲を確認する。未完了ならE2E実装を進めない。
- [ ] Step 2 検証: 既存api-logging試験と関連API/runtime回帰、typecheck/lintの新たな結果を確認する。独立計画完了直後の同一sourceで結果が有効なら再実行しない。sourceが変わった場合だけ必要範囲を実行する。
- [ ] Step 3 記録: 承認済み版・非秘密commit・実施試験・JSON契約を調査記録へ保存する。stdoutはCloudWatch配信の証拠としない。
- [ ] Step 4 判定: 前提回帰が失敗した場合は製品ログ変更の問題として切り分け、Floci構築へ進まない。製品コードをE2Eタスク内で修正しない。
- [ ] Step 5 review: 前提と判定の記録を独立レビューし、文書差分があればその明示pathだけをcommitする。OBS-01/04の製品検証とEの配送検証を区別する。

### Task 3: 本番3rootの再利用・現行artifact・最小差分の構築と回収

**Files:** Create `scripts/e2e/{prepare-artifact,terraform,terraform-source}.ts`, `tests/e2e/floci/support/artifact.ts`, `tests/e2e/floci/terraform.test.ts`, `tests/integration/formal-e2e/terraform-driver.test.ts`; Modify `support/cases.ts`, `package.json`, `docs/operations/formal-e2e-research.md`。既存本番infraは読取専用。E2E専用resource定義やmoduleを新設しない。

**Interfaces:** `prepareArtifact(runDirectory:string):Promise<ArtifactSnapshot>`、`prepareProductionRoots(target:LocalTarget, directory:string):Promise<PreparedTerraformRoots>`、`provisionStack(target:LocalTarget, options:FixtureOptions, artifact:ArtifactSnapshot, evidence:Evidence):Promise<ProvisionedStack>`。Task4のfixtureには依存しない。driverはrun専用0700 directoryで3つのlocal stateを管理する。

- [ ] Step 1 RED: TF-01〜04、OPS-05の負例を作る。source/変換後digest不一致、2validation以外の変換、issuer hostをIPへ書き換えた差異、未知override、接続以外の保護/容量/route変更を拒否する。default endpoint/foreign stateはspawn0、tampered/stale ZIPは登録前拒否、partial applyでも回収試行、出力canary不在、unsupported時の依存not-runを確認する。validation/postconditionをoverride fileで上書きできないこととprevent_destroy scalar override時のpostcondition保持を固定TF版のprovider不要offline試験で確認する。同一account run競合・未知OIDC所有を資源作成前に拒否する。保護解除前に結果確定、回収設定での再試験拒否、逆順回収と解除失敗の別集計もassertする。
- [ ] Step 2 RED実行: offline driver/artifact/source試験を実行する。固定TF/provider schema、override merge、endpoint/必要APIをContext7のlibrary→docsで調査する。sandbox外・各質問最大3command、索引mainだけで6.67.0固有の適合を断定しない。
- [ ] Step 3 最小実装: build→package→verify:zipでsnapshotを作る。input allowlistは `src/**/*.ts`, `scripts/build/{bundle,notices}.ts`, `scripts/build/package.py`, `package.json`, `package-lock.json`, `tsconfig.json`。build前後のdigest一致を要求する。

  公開infraは `infra/bootstrap`, `infra/platform/production`, `infra/application/production` の明示した通常.tfと公開lockだけを配置し、backend.tf・private inputs/state/plan・symlink/outside pathは読まない。配置直後の元bytes/digestを保持し、設計§8のcognito_issuer/cognito_auth_base_urlの2validationだけを一時コピーで構造変換する。変換後digestと差分を記録する。platformの同名2output.valueもlocal issuer/auth baseへoverrideし、生成local backend/接続overrideを明示許可リストで検査する。

  provider endpoints/dummy keys/profile・metadata遮断、owned Floci URLと完全一致する2validationへの置換だけを許可し、認証・上限・削除防止・TLS必須policy等を変えない。

  bootstrap→platform→既存手順のapplication API-only seed→API IDを渡すbootstrap更新→create-only ZIP登録→seed flagを外したapplication全体applyを行う。root間はallowlisted outputsを合成inputsへ渡す。9alarm/OIDCを含む定義を省略せず、不足APIは基盤未完了として記録する。
- [ ] Step 4 GREEN/互換性判定: offline試験、type/lint、3つの生成rootのfmt/validate、local applyと回収を確認する。必要API非対応や許可外差分が必要ならunsupportedと依存not-runを記録し、設定を削って成功にしない。結果確定後にScheduler停止/処理終了確認、ownedサービス側削除保護・bucket削除拒否解除、合成user/全version/marker回収、一時rootだけのprevent_destroy scalar解除（既存postcondition保持、再定義禁止）、application→platform→bootstrapのdestroyを行う。解除失敗も回収を継続して別集計し、errors/leaks0を要求する。`test:e2e:terraform=tsx scripts/e2e/run.ts --layer terraform` は構築診断用の独立run。通常E/L入口もこの構築をrunにつき一組だけ通す。bootstrapをsuiteや復旧先で再作成しない。
- [ ] Step 5 commit/review: 明示pathのみ、`test: reuse production Terraform with minimal local differences`。本番infraの差分0、source/変換後digest、2validation/output.value許可差分、postcondition保持、接続/隔離/回収の区分、保護維持、state所有関係、default AWS送信防止をレビュー。

### Task 4: 構築設定の読み戻し・合成fixture・保存状態とログの照合

**Files:** Create `tests/e2e/floci/support/{fixture,auth,storage,cleanup,logs}.ts`, `tests/e2e/floci/fixture.test.ts`, `tests/integration/formal-e2e/log-observer.test.ts`; Modify `support/cases.ts`, `scripts/e2e/run.ts`, `tests/integration/formal-e2e/harness.test.ts`, `package.json`, `package-lock.json`。

**Interfaces:** run所有者が一回だけ `createRunFixture(stack:ProvisionedStack, evidence:Evidence):Promise<E2EFixture>` を呼び、各suiteへ `createFixture(options:SuiteOptions, runFixture:E2EFixture):Promise<SuiteFixture>`、`createCaseAuth(fixture:SuiteFixture, caseId:string):Promise<FixtureAuth>`、`readOwnerState(fixture:SuiteFixture, ownerId:string):Promise<{itemCount:number; imageBytes:number}>`、`readReminder(fixture:SuiteFixture, ownerId:string, id:string):Promise<StoredReminder|null>`、`registerLogCheck(fixture:SuiteFixture, caseId:string, expected:LogExpectation):PendingLogCheck`、`flushSuiteLogs(fixture:SuiteFixture):Promise<Map<string,OutputResult>>`、`expectCleanupLogs(fixture:SuiteFixture, caseId:string, expected:{since:number; until:number; status?:number; evaluated?:number; deletes?:number; skippedUnpublished?:boolean}):PendingLogCheck`。DTO/typesは既存sourceを使い、期待データは独立して用意する。

- [ ] Step 1 RED: TF-03/OBS-02〜04、両CodeSha/S3 version/checksum/alias一致、ready503→200、health200、未認証v2の401を作る。設定差異・必須Lambdaログ欠落・別request ID・別log groupで失敗する負例、secret canaryとpoll期限、初期化失敗で全owned資源を回収するharnessを作る。runnerがapply→設定読み戻し/ログsmoke→ケース開始→結果確定→保護解除/回収の順に進み、設定確認失敗時には入力を送らないことを確認する。
  清掃開始のlambdaRequestIdと終了のservice runIdが異なる場合でも対応づけられること、別log streamや別invokeの終了ログを拒否することを確認する。
- [ ] Step 2 RED実行: offline harness/log-observerを先に実行し、Task3の構築後にfixture試験を行う。構築失敗は依存not-runとして残し、REDの実装不足と区別する。
- [ ] Step 3 最小実装: Terraform出力にlocal clientsを接続する。各ケース用の合成user A/BをSDKで用意し、RATE/保存状態を別ケースと共有しない。同pool別clientは独立した負例controlとしてSDKで追加し、主client設定やGateway audienceを変えない。別poolはSDKでowned Cognito pool/resource server/clientだけを作り、主poolと同じ認証設定を読み戻す。OIDC/bootstrapを追加しない。

  3table/key/GSI/TTL/PITR35日、S3 versioning/暗号化/公開防止/旧version60日/CORS、Cognito/16route/JWT/alias/CORS、両Lambda runtime/handler/timeout/concurrency/ZIP、3log group30日、daily Scheduler、9alarm、OIDC provider/role/subject、bootstrap/platformのrole/policy/trust・bucket設定を読み戻して本番定義と比較する。runtime_limits={}と保護設定を開始時/結果確定前に照合する。

  owned Lambda Logsはgroupごとに単一observerで継続収集し、各caseの期待を登録する。suite末尾の一括flushで最終対象入力から60秒を上限とする。APIログ不在の負例を個別に60秒待たない。HTTP200/実配信の前後対照、HTTP拒否、拒否直前/直後のRATE/DDB/S3不変も確認する。Gateway拒否の相関IDが取れない場合はowned group/時間窓内の全API結果ログを既知の到達要求と照合し、余分な結果ログを検出する。対照ログ欠落時は不在をpassにしない。rawログはメモリ内だけで照合し、公開結果は許可項目のみ。console captureや手動ログ投入をEの配信成功にしない。

  resetSuiteはログ結果確定→suite合成データ/control回収→公開状態・合成checkpoint等の復元/読み戻しとする。disposeはrunnerがrun末尾に一回だけ呼び、Task3の保護解除/全owned回収/逆順destroy/不在確認を行う。
  runnerにTask3の一回の構築とcreateRunFixture、suiteごとのcreateFixtureを組み込み、設定確認を通ったsuiteだけで入力を開始する。ケースを選択する前に全inventoryを確保し、ZIPと基盤はrun内で共通、suiteは逐次実行する。同一accountのrunロックとOIDCの単独所有を確認し、未知の既存providerを採用しない。残存データや未終了清掃、復元不良があれば依存する未開始ケースをnot-runにする。finallyでpartial applyも回収し、回収結果を最終集計へ反映する。
  清掃ログは同じlog streamとinvokeの観測区間で開始・終了を対応づける。手動invokeはScheduler停止と前回処理終了を確認して逐次実行し、対応が曖昧ならfailとする。既存の清掃ログ形式を変える製品修正は含めない。
- [ ] Step 4 GREEN: 実fixture smoke、API/清掃ログ配信・正常対照付きGateway拒否、Gateway配信probe、offline負例、type/lintを確認する。CloudWatch Logs devDependencyは既存SDK固定versionに合わせ、runtime ZIPへ混入させない。必要設定またはAPI/清掃実ログ配信が非対応なら正式E2E未完了と記録する。
- [ ] Step 5 commit/review: 明示pathのみ、`test: verify deployed settings storage and log delivery`。TF-03、OBS-02〜04、Review Focus1/3/5、秘密不在と本番設定差分をレビュー。

### Task 5: 認証正常系・独立負例・rotation

**Files:** Create `tests/e2e/floci/auth.test.ts`, `tests/integration/formal-e2e/auth-claims.test.ts`; Modify `support/auth.ts`, `support/cases.ts`。

**Interfaces:** Task4 FixtureAuth。追加 `exchangeCode(fields: Record<string,string>): Promise<{ status:number; error?:string; session?:AuthSession }>`、`requestRefresh(token:string, client:'primary'|'sibling'): Promise<{ status:number; error?:string; session?:AuthSession }>`、`revoke(session:AuthSession):Promise<void>`、`disable(owner:'a'|'b'):Promise<void>`、`verifySession(session:AuthSession):void`。valueやerror_descriptionをpublic証拠へコピーしない。

- [ ] Step 1 RED: AUTH-01〜12をcasesへ展開する。一条件だけが不正な各負例の前後で、有効tokenによる200とRATE/storage不変を確認する。signatureだけの改変→401、same-pool sibling401、read-only POST403/write-only GET403、ID403を確認する。実際に署名されたtokenでexp前200/exp後401/refresh後200を確認する。PKCE wrong/missing verifier、callback mismatch、code reuse、S256以外を別codeで試す。Iには、既存requireOwnerを実際に呼び出してtoken_use/issuerを単独で検証する401ケースを作る。
- [ ] Step 2 RED実行: `PATH=… npx tsx --test tests/integration/formal-e2e/auth-claims.test.ts` と auth単独runner。負例準備自体の障害はnot-runで、REDの対象を新harness不足に限定する。
- [ ] Step 3 最小実装: 正常に発行されたtokenをlocal JWKSで検証し、署名/claimsの対照を値を含めずに保存する。AUTH-05で期待JWKSがforeign tokenを検証しない場合は、複合条件での拒否と単独条件のIを別resultにする。token lifetimeは300秒のままとし、expiry待ちを他authケースの後に置く。全体330秒・waitは30秒以下とする。refreshではgrant identity/scopes/ownerの保持、10秒grace前後、旧tokenの再利用で10秒の起点が延びないこと、missing/malformed/sibling、revoke family、synthetic disableを確認する。APIへの正常入力はAPI結果ログ、Gateway拒否はHTTP401/403と正常対照付きAPI結果ログ不在をTask4の一括observerで照合し、拒否後のDDB/S3不変も確認する。PKCE/token endpointだけのケースにはAPI結果ログを要求せず、対象外の理由を記録する。30日絶対期限と更新時の不延長、Chromeは、out-of-scope/Aの既知の制限として記録する。既存Floci回帰は補助資料とし、新しいIの実施証拠へ転記しない。
- [ ] Step 4 GREEN: `test:e2e:floci -- --suite auth`、auth I、type/lint。case inventoryとpass/fail/not-run/unsupported、cleanup0を確認。FlociがPKCE負例を通すなら独立失敗記録、認証緩和しない。
- [ ] Step 5 commit/review: 明示path、`test: verify formal PKCE JWT and refresh contracts`。Review Focus2とscope/token_use/issuer独立性をレビュー。認証拒否ケースのRATE不変は正常対照の前後を含めず、拒否直前/直後で照合する。

### Task 6: API契約・入力境界・ページング

**Files:** Create `tests/e2e/floci/api.test.ts`, `tests/e2e/floci/support/input-fixtures.ts`; Modify `support/cases.ts`。

**Interfaces:** Task4 request/readReminderと`makeInput(overrides: Record<string,unknown>): Record<string,unknown>`、`makeJsonBodyBytes(bytes: number): string`。inputは合成のURL/title/date/booleansを使い、任意のownerId入力は禁止する。makeJsonBodyBytesはvalid JSONの余白で正確なUTF-8長を作る。

- [ ] Step 1 RED: API-01〜13、API-14の認証/入力gate順をparameter IDsへ展開。旧POST/PUT410、known6paths405/Allow、unknown404、DTO/header全field、owner全操作404、CORS/OPTIONS、media400/415、fields422、ID/codepoint128±1/URL4096±1/title1024±1、日時offset/閏日/invalid、JSON2097152±1。list51metadata・limit1/20/50/0/51、tombstone先頭empty page→cursor、BへA cursorと不正422をassert。
- [ ] Step 2 RED実行: api選択runner。不足case/harnessの失敗を記録。fixture初期化に失敗した時は、そのfixtureに依存する未開始caseがnot-runになることもassert。
- [ ] Step 3 最小実装: run共通基盤へのsuite用viewを用意し、各caseはowner/item prefixで独立させる。正常・入力拒否の結果ログはTask4のobserverで照合する。入力拒否時にsnapshot storage/job/S3が変わらず、RATEは認証済みなら増えることを確認する。51個の初期seedは実APIを使い、rateの分境界の影響を避ける実行順を定める。encoded slashはURLを改変せず、Flociへの実pathで評価する。CORSはHTTP headersで確認し、実拡張ブラウザは未実施とする。負例が失敗した後も独立したcasesを実行する。
  画像のない正常操作はS3への追加保存なしも確認する。Gatewayが応答するOPTIONS等はAPI結果ログを要求せず、実際の応答元に応じてログ期待を定義する。
- [ ] Step 4 GREEN: api runner、既存api/contracts/boundaries/reads-rate covering、type/lint。旧APIやANYを触るproduct/Floci変更はしない。
- [ ] Step 5 commit/review: 明示path、`test: cover API contracts boundaries and pagination`。Gateway edge errorとLambda独自codeの区別をレビュー。

### Task 7: 強いETag・同時競合・quota/rateと保存状態の整合性

**Files:** Create `tests/e2e/floci/storage.test.ts`, `tests/integration/formal-e2e/{concurrency,quota}.test.ts`; Modify `support/cases.ts`。

**Interfaces:** Task4 readOwnerState/readReminder、Task6 input-fixtures。`seedRateBeforeLimit(fixture:SuiteFixture, ownerId:string, minute:number):Promise<void>`をstorage suite内に置く。実E/Lの設定は変更しない。

- [ ] Step 1 RED: STORE-01〜06とAPI-14を独立したcasesにする。生HTTP body SHAによるexact rN-hexと、弱い/*/list/欠落/同revision別hash/逐次staleの拒否を確認する。barrierからPATCH/PATCH・DELETE/DELETE・PATCH/DELETEの2requestを送り、一方が200で他方が拒否され、revision/countersの変更が一回だけとなることを確認する。PATCH同士は412とし、DELETEが先に成功した後のcurrent readでは404を許容する。この分岐は、双方が旧activeを読むIのcontrolで分離する。create競合で一方が201、他方が409となること、different itemの保持、exact tombstone、再送で二重処理がないことを確認する。容量境界Iは1000件/128MiBの規定値で等号・超過・競合・削除回復を確認する。rate Eはcount119/正しいexpiresAtを合成seedし、二tokenの実GETで200→429、Retry-After/count120を確認する。
- [ ] Step 2 RED実行: storage runnerとconcurrency/quota I。real service成功を得るためretryを追加しない。開始window余裕をpreconditionとして固定し、窓を跨いだ結果はfail。
- [ ] Step 3 最小実装: request Promiseを同時releaseするhelperをsuite内で定義し、成功した要求と競合に負けた要求の保存snapshotを強い整合性のある読み取りで確認する。concurrency Iはreal service/storeのget portを限定してwrapする。双方が強い整合性のある読み取りで旧activeを読んだ後、barrierからcommitへ進めて一成功/一412を確認する。これはclaims注入HTTPとは別層とする。規定値の容量境界Iは上限直前の合成状態から二つのcreateを競合させ、一成功/一413を確認する。画像byte境界も規定128MiBでIに割り当て、既存lowered-cap回復U/Iは別証拠とする。実Eでは通常操作のcounter保存/解放を確認する。rate seedには既存keys.rate/keys.rateExpiresAtを使い、count119を強いreadで確認後に実GETを送る。minuteを跨いだらfailとする。診断readはDDB clientとし、余分なAPI呼び出しをしない。
  実HTTPの各要求はTask4のobserverでAPI結果ログをstatus/codeに照合する。競合する二要求もrequest ID別に確認する。DELETE成功後はtombstone・counter減少・画像の即時保持をassertし、容量境界Iには実CloudWatch配信を要求しない。
- [ ] Step 4 GREEN: storage runner、concurrency/quota I、writes/reads-rate/lowered-quotas covering、type/lint。I fakeの並行とE client同時送信を別layer表示する。
- [ ] Step 5 commit/review: 明示path、`test: assert concurrent revisions quotas and tombstones`。Review Focus4をレビュー。

### Task 8: 元画像・実URL取得・差し替え・孤児

**Files:** Create `tests/e2e/floci/images.test.ts`, `tests/e2e/floci/support/image-fixtures.ts`, `tests/fixtures/synthetic/formal-e2e/image-fixtures.md`; Modify `support/cases.ts`, `support/transport.ts`, `tests/integration/formal-e2e/harness.test.ts`。

**Interfaces:** `imageBytes(format:'png'|'jpeg'|'gif'|'webp', bytes?:number):Buffer`、`fetchOwnedImage(fixture:SuiteFixture, url:string, ref:ImageRef):Promise<HttpResult>`。image fixtureは合成のsignature bytesを使い、元dataはメモリ内で扱う。生成規則は文書に記載する。URL/refはraw証拠に渡さない。

- [ ] Step 1 RED: IMG-01〜09。4形式BASE64/dataURL/null/empty/省略、bad BASE64/MIME、1048576±1、S3 pinned bytes/checksum/metadata/versions、DB no bytes。API URL900秒/GET元bytes/no Bearer/body/ETag不変。差し替え/clear/deleteのcommitted/retired/due/counter、新画像付きduplicate409→orphan pending。未知bucket/host/redirect/改変署名URLのtransport拒否をoffline harnessでassert。
- [ ] Step 2 RED実行: offline harness→images runnerの順に実行する。hostnameが解決できない場合は診断上の制限として記録し、URL/Host/queryを書き換えて成功にしない。
- [ ] Step 3 最小実装: private IP discoveryに整合するowned bucket hostだけをsocket pinへ追加する。fetch前にowned key/version/endpointを検査し、URLはメモリ内だけで扱う。署名強制probeでは、正常なcontrol、signatureだけの改変、短期限の独立URLに対するexp後の拒否を比較する。実APIの900秒とは別resultにする。Flociが改ざんを許可した場合はunsupportedを記録し、runtime設定変更は差分の提案までとする。必須の画像Eの保存/取得が阻害されるなら、正式E2Eは未完了とする。
  登録・差し替え・clear・削除ごとにDDB参照/job/counterとS3 bytes/version/保持状態を照合し、APIの正常・拒否ログをTask4のobserverで確認する。入力拒否では新しいS3 versionなし、duplicate409では期待する孤児jobと画像保持をassertする。署名URLを直接取得する要求にはAPI Lambdaログを要求しない。
- [ ] Step 4 GREEN: images runner、既存images/contracts covering、harness/type/lint。valid取得だけをSigV4強制成功としない。画像fixtureのfake PNGを実画像decoder検証済みとしない（製品はsignature検査契約）。
- [ ] Step 5 commit/review: 明示path、`test: preserve original images through authenticated API`。Review Focus3/4、secret URL診断、孤児job条件をレビュー。

### Task 9: 実清掃の状態遷移・合成日時・中断と上限

**Files:** Create `tests/e2e/floci/cleanup.test.ts`, `tests/e2e/floci/support/cleanup-fixtures.ts`, `tests/integration/formal-e2e/{fault-transport,cleanup-resume.test}.ts`; Modify `support/cases.ts`。

**Interfaces:** `invokeCleanup(fixture:SuiteFixture):Promise<{ startedAt:number; finishedAt:number; functionError?:string; result?:CleanupResult }>`、`seedCleanupJobs(fixture:SuiteFixture, jobs:ImageJob[]):Promise<void>`、`FaultRule={command:string; occurrence:number; phase:'before'|'after'|'delay'; effect:'throw'|'abort'}`、`createFaultTransport(delegate:RequestHandler,rules:FaultRule[]):{handler:RequestHandler; trace:ReadonlyArray<{command:string; occurrence:number; phase:string}>}`。時刻は観測区間としてTask4のexpectCleanupLogsの期待へ登録し、suite末尾に照合する。RequestHandlerは既存SDK client configが受ける型からderiveし、secret/body非保存。FaultRule.commandはSDK command名への明示対応表。

- [ ] Step 1 RED: CLEAN-01〜09。unpublished0、activelease保持/expireddone、24h両側/retired起点、committed/current画像保護、version/checksum mismatch保持、marker後version読取、same shard51/page50、二invoke収束、event injection拒否。Iはpage途中abort→cursor開始を維持、GSI stale/current read condition、claim/upload race、marker after-response-lost、checkpoint/metric失敗を単独注入。
- [ ] Step 2 RED実行: cleanup-resume Iとcleanup runnerを実行する。HTTP200が返ってもFunctionErrorを見落とさない。seedjobがowned合成tableで正しいschema/GSI属性を持つことを、準備時にassertする。
- [ ] Step 3 最小実装: Task8のreal APIから作ったcommitted/retired/orphanを再現するfixtureと、独立した合成jobを用意する。時刻の両側に5秒以上の余裕を取り、正確な等号はclockを制御したIで検証する。12partitionの末尾reset/51件は、GSI反映を期限付きpollで確認した後にinvokeする。fault adapterは送信前の故障と実送信後の応答遮断を区別し、traceへ固定codeだけを記録する。規定10000/5000/600/60/4の既存limit試験を保持し、小さなinventoryで実adapterの中断・再開を検証するケースを追加する。製品overrideは作らない。
  他ケースの清掃候補を混ぜないよう、DDB/S3照合と入力記録後にケースownedデータだけを回収する。ログ期待はsuite flushまで保持し、失敗時も実施証拠を消さない。API登録→削除/差し替え→合成日時準備→実清掃invokeを一つのケースとしてつなぐ。各段階のAPIログ、清掃後のjob/counter、S3現行GET404と元version GET200、実清掃ログのstatus/件数を照合する。unpublishedではcleanup_startとskippedUnpublishedの応答・保存不変を確認し、通常清掃の終了ログを要求しない。不正eventは開始ログより前に拒否されるため、FunctionErrorと保存不変を確認し、アプリケーションログ照合が対象外となる理由を記録する。
- [ ] Step 4 GREEN: cleanup runner、cleanup-resume I、既存jobs/cleanup/images covering、type/lint。削除actorがVersionId永久削除を送信しないことはI trace、実version保持はLで確認。実清掃成功ログの処理件数を保存状態と照合する。
- [ ] Step 5 commit/review: 明示path、`test: verify durable cleanup leases checkpoints and protections`。Review Focus4、fake索引遅延とreal GSI観測の区別をレビュー。

### Task 10: 合成移行・復旧・依存先故障と実adapterの結合

**Files:** Create `tests/e2e/floci/operations.test.ts`, `tests/e2e/floci/support/operation-fixtures.ts`, `tests/integration/formal-e2e/faults.test.ts`; Modify `support/cases.ts`, `scripts/e2e/terraform.ts`, `tests/integration/formal-e2e/terraform-driver.test.ts`（restored_tables切替と戻し）。

**Interfaces:** `localMigrationRuntime(fixture:SuiteFixture):MigrationRuntime`、`RestoredTarget={tableNames:Record<string,string>; tableArns:Record<string,string>}`、`localRecoveryRuntime(fixture:SuiteFixture, restored:RestoredTarget):RecoveryRuntime`、`writeSyntheticOperationInputs(fixture:SuiteFixture, restored:RestoredTarget, directory:string):Promise<{source:string; mapping:string; config:string; restoredConfig:string; ownerIdentities:string; ownerMap:string}>`。型は既存migrate-json/verify-recoveryのexportを使用。restoredはSDKで作るownedの合成3tableの記述子で、別stack/fixtureではない。本番schema/GSI/TTL/PITR/削除保護と完全一致させ、既存restored_tables/data sourceへ渡す。Task10でTask3のdriverに `setRestoredTables(stack:ProvisionedStack, target:RestoredTarget|null):Promise<void>` を追加し、同じ3root/stateへ一貫したmapを適用・読み戻す。nullは{}へ戻す。

- [ ] Step 1 RED: OPS-01〜04、STORE-07、IMG-08。同schema以外/削除保護不足/PITR不足/foreign ARNのrestored_tablesを拒否する負例と、同じ3root/stateの{}復元失敗で後続APIを止める負例を追加する。two owners（空owner/特殊key含む）dry-run/import/verify/publish→ready503/200、source hash不変（合成のみ）、rerun counts/versions不増。changed bytes/map/limits拒否・corrupt image禁止。restored-only prepare/verify/preserve/remap/rerun、source table/version不変・Cognito復元false。before/after Put/commit/read/rate失敗で503/未公開/committed保護/counter不重複、abort settlementをassert。API-01の `ready_dependency_failure_keeps_health200` はcreateApiHandlerの実depsへprobe faultを渡して確認する。
- [ ] Step 2 RED実行: faults Iとoperations runnerを実行する。ローカルSTS accountと明示した合成targetの一致を事前確認し、共有AWSへのfallbackを許可しない。
- [ ] Step 3 最小実装: 既存 `migrationMain(argv,io,runtime?)` / `recoveryMain(argv,io,runtime?)` の注入interfaceを使い、local clientsで `createMigrationStore/createMigrationImagesStore/createRecoveryStore` を構成する。createMigrationDeps/createRecoveryDepsのdefault credential chainは呼ばない。raw IOから転送するのはsafe fieldsだけとする。運用用の全table scansはowned resourcesへ限定し、通常API/cleanupのScan禁止と区別する。復旧は合成snapshotを持つ同schemaの別3table、同じ画像bucket、read-onlyのsourceを使う。実PITRの未検証は制限へ残す。

  通常API群の終了後にScheduler停止・処理終了・API入力停止・source未公開を確認してからsource snapshotを記録する。合成復旧tableは本番schemaとPAY_PER_REQUEST/削除保護/TTL/PITR35日をSDKで準備し、CLI検証中のsource row/version不変を確認する。

  Task3の同じ3root/stateへrestored_tablesを渡し、platform data sourceのARN/schema/protection検証とbootstrap/platform policy・application環境の読み戻しを行う。途中のroot不一致ではAPIを送らない。

  検証後に全rootの{}入力と設定を復元してから公開する。復元失敗時は後続APIをnot-runとする。本番.tf/handlerの製品変更、追加OIDC/bootstrap、実PITRを含めない。
  移行・復旧の出力をDDB/S3で照合し、readyの実HTTP確認にはAPI結果ログ照合を含める。API故障注入Iは先行独立計画のwrapperでcreateApiHandlerを包み、503/codeのcaptureと保存状態を照合する。CLIやadapter単独のIはCloudWatch配信の対象外として理由を残す。
- [ ] Step 4 GREEN: operations runner、faults I、既存legacy/migration/recovery covering、type/lint。画像保全後の強いread/pinned bytes、default verify前後のrestoredも不変を確認。
- [ ] Step 5 commit/review: 明示path、`test: integrate synthetic migration recovery and uncertain outcomes`。Review Focus4とsource不変/未公開gate/再実行安全性をレビュー。

### Task 11: Scheduler起動経路とサービスごとの結果ログ

**Files:** Create `tests/e2e/floci/{scheduler,logging}.test.ts`; Modify `support/cases.ts`, `docs/operations/formal-e2e-research.md`。

**Interfaces:** Task4の期待登録/一括flushとexpectCleanupLogs、fixture.request、Task9 invokeCleanup。one-time scheduleはowned manifestに登録し、日次設定を変更しない。

- [ ] Step 1 RED: OPS-06/OBS-02/03を展開する。POST201/PATCH200/DELETE200、入力拒否は実API log groupでrequest ID/status/codeに紐づける。Gateway401/403はHTTP/保存不変と正常対照付きAPIログ不在を確認し、Gateway配信は別の互換性probeへ展開する。清掃の開始・終了とstatus/件数はTask4のexpectCleanupLogsで照合する。Gateway拒否群のログ不在はsuite末尾にまとめて観測期限まで確認する。対照ログ欠落・余分なAPI結果ログ・一括観測失敗の負例を確認し、実施済みcaseはfailとして入力情報を残す。
- [ ] Step 2 RED実行: logging suiteとScheduler probeを実行する。ログ内容の不一致と未配信を区別し、既存mock/consoleを配送証拠にしない。
- [ ] Step 3 最小実装: daily03UTC/OFF/DISABLED/retry2/age3600/cleanup aliasの読み戻しを確認後、独立したowned one-time at/input{}を作る。90秒以内の短いpollでjob/checkpoint実変化と清掃ログを照合する。delivery受付だけで処理成功としない。通常のAPI結果ログはevent IDで再取得重複を除外して1件を確認する。Gateway配信はaccessLogSettings保持・実HTTP結果との照合をprobeする。配信非対応は理由付きunsupportedとして制限へ記録する。v1直接proxyログをv2/JWTの代用にしない。API/清掃実配信は必須。S3 TLS policy保持の証拠はpolicy-present、強制未検証はenforcement-unverifiedと分けて記録する。
- [ ] Step 4 GREEN/採否: logging必須群を実行し、Gateway配信/Scheduler起動は実測・不足API・非対応理由をサービス表へ記録する。schedule停止/削除→処理終了→回収の順を守る。日次運転、実AWS IAM/async再試行は未検証とし、host再設定が必要なら具体的差分と再開手順を保存して停止する。
- [ ] Step 5 commit/review: 明示pathのみ、`test: observe invocation outcomes and Scheduler delivery`。通常ログ/認証拒否/清掃の出力元、実配信とI captureの区別、処理完了と受付の区別をレビュー。

### Task 12: 日本語手順・全case照合・新たな実行結果

**Files:** Create `docs/operations/formal-e2e-{README,results,limitations}.md`, `tests/integration/formal-e2e/coverage.test.ts`; Modify `README.md`, `docs/operations/formal-e2e-{coverage,research,document-impact}.md`, `docs/operations/cleanup.md`, `docs/implementation-results.md`, `docs/operations/acceptance.md`, `support/cases.ts`, `scripts/e2e/run.ts`（最終inventory統合のみ）。

**Interfaces:** CaseDefinition/CaseResult/RunSummary。`coverage.test.ts`は対応表のID集合とregistryのrequirementId、required/acceptance/layer/source、全suiteのinventory、4種類の出力期待と対象外理由、実施済みケースの照合結果を確認する。

- [ ] Step 1 RED: `every_required_case_has_result_and_source`、`partial_selection_cannot_claim_full_completion`、`unsupported_not_run_cleanup_are_separate` を作る。fixture初期化の失敗/timeoutでは未開始caseがnot-runとして残りexit1となることをassertする。入力後の保存/ログ不一致をnot-runへ戻さずfailとすることも確認する。HTTP成功でもDDB/S3/ログの必須照合結果が欠ければ全体完了にならず、理由のない対象外指定も拒否する。required compatibility probeの実測済みunsupportedと未実施not-runを区別し、behaviorのunsupportedはexit1とする。結果から消えたcaseや出力されたbody canaryが0であり、U/AだけのrowをE必須にしないこともassertする。
- [ ] Step 2 RED実行: coverage/harness/terraform-driverのoffline試験を実行する。ケースplaceholderを未実施のままpassにしない。
- [ ] Step 3 最小完成: registry/matrix/READMEの実存在入口を一致させ、依存準備・fixture生成・suite選択・失敗診断・owned recovery・後片付け・CI runner準備を日本語で記載。現在のpatched imageのhost準備は既存手順へリンク、GHA/workflow変更なし。結果reportはfresh UTC、HEAD/dirty入力digest/tool/ZIP/API-cleanup hashes、本番公開ソース・変換後digest/差分区分・件数、layer別counts/required not-run/unsupported、cleanup/leaks、review/rulings、既知制限を保持。
  [関連文書の確認結果](../../operations/formal-e2e-document-impact.md)に従い、API結果ログと正式E2Eの実測を既存の実装結果・受け入れ記録へ日付付きで追記する。過去の件数・承認済み設計・旧計画・旧E2E結果は書き換えない。cleanup手順には実測したログの読み方と新READMEへの参照を追加し、ローカル証拠と本番操作手順を区別する。東京の総額は未取得単価で再計算せず、費用資料の前提変更がある場合だけ更新する。
- [ ] Step 4 fresh検証: prefix付き `npm ci`（必要時）、typecheck/lint→build/package/verify:zip→`npm test`→test:packaging→必要infra:check→audit:runtime/audit:all→test:integration:e2e→test:e2e:flociの全群（TFケースを含む）。test:e2e:terraformは単独診断入口の選択/registryをofflineで確認し、全群成功後に同じ構築を再実行しない。ZIPはE2E prepareでも現行buildから作る。Floci必須groupsを全実行、TF/API・清掃ログ非対応はfail/unsupportedと未開始の依存caseのnot-runを記録する。入力後に判明したログ欠落は当該caseのfailとし、正式E2Eは未完了。順序/実際のcommand/exit/count/安全なwarningsを記録。今回のuser baseline diffはstageしていない新E2E pathだけを検査。
- [ ] Step 5 commit/task review: 日本語docs/registry/runner限定path、`docs: record reproducible formal E2E evidence and limits`。未実施/cleanupが漏れず、22〜65分という実測前見積もりと実測時間、75分+回収15分の期限、Gateway互換性結果、TLS強制未検証が明記され、既存337件等をfresh結果なしで流用していないことをレビュー。
- [ ] Step 6 controller final review: Task1〜12の範囲のreview packageと、deferred/parked/rulings全件を、最も能力の高いreviewerへ渡す。修正waveの上限を守る。必須TF/API・清掃ログ/E/L/Iが未完了なら未完了と報告し、製品修正の承認を求める前に独立した失敗の証拠を提示する。

## 実行計画の自己レビューと承認対象

本番3root再利用→設定読み戻し→入力→HTTP/DDB/S3/CloudWatch確認→結果確定→保護解除/回収の順序と、未実施を残す集計を確認した。
AUTH→Task5、API→Task6/7、STORE→Task7/10、IMG→Task8/10、CLEAN→Task9、
OPS→Task3/10/11、TF→Task3/4、OBS→Task2/4/11、SAFE→Task1/3/4/12。
既存null-body修正を保持し、本計画に製品コード変更やprivate入力の参照は含めない。API結果ログは独立計画を先に完了させる。
承認済みの対象は設計/対応表、本計画、2validationの一時コピー変換を含む接続・隔離・後片付けの限定差分。API結果ログも独立計画として承認済み。先行変更として完了させる。本番Terraformの変更は計画に含めない。S3旧version60日保持とログ保持30日は維持する案。
費用判断は[費用・ログ方針](../../operations/formal-e2e-cost-and-logging.md)に記載する。
SDD方式は選択済み。旧taskは再開せず、新計画専用台帳を承認後に作成する。
