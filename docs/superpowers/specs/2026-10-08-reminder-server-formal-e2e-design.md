# reminder-server 正式ローカルE2E設計案

作成日: 2026-10-08。状態: **レビュー待ち・未承認・実装未着手**。

製品AWS設計とSDD実行方式は承認済み。正式E2Eの設計・計画は未承認。
[今回のハンドオフ](../handoffs/2026-10-08-reminder-server-formal-e2e-sdd.md)が許可した
調査、検証対応表の作成、文書作成の範囲で、この設計と[計画案](../plans/2026-10-08-reminder-server-formal-e2e.md)を同時に提示する。
計画案があるだけでは実行許可とみなさない。両文書の承認後にSDDを開始し、実行方式や製品設計の再承認は求めない。

## まず何を確認するか

正式E2Eは次の順で実行する。Terraformによる構築と設定の確認を、すべての実経路ケースの前提とする。

1. 現行ソースからZIPを作り、E2E専用TerraformでFlociにサービスを構築する。
2. 設定を読み戻し、認証・ルート・保存先・実行するZIP・保持期間が意図どおりであることを確認する。
3. 合成ユーザーで認証し、実HTTPで登録・更新・削除・不正な入力を送る。
4. HTTP応答に加えて、DynamoDB、S3、CloudWatchの結果を確認する。
5. Terraformで当該実行のリソースを削除し、漏れがないことを確認する。

| ケース | 入力 | DynamoDBの結果 | S3の結果 | CloudWatchの結果 |
| --- | --- | --- | --- | --- |
| 構築確認 | Terraform apply | 3table、key/GSI、TTL/PITR設定 | versioning、暗号化、公開防止、旧version60日保持 | API・清掃・Gatewayのlog group、保持30日 |
| 画像付き登録 | 有効tokenでPOST | 項目追加、画像参照・job・counter整合 | 元画像bytesを新key/versionへ保存 | API Lambdaのcreate/201、Gatewayの201 |
| 画像差し替え | 現ETagでPATCH | 新画像参照、旧jobはretired | 新画像保存、旧画像は保護期間中保持 | API Lambdaのpatch/200 |
| 削除直後 | 現ETagでDELETE | 項目はdeleted=trueのtombstone、counter減少 | 画像は保持、jobはretired | API Lambdaのremove/200 |
| 削除後の清掃 | 合成日時で24時間保護期間を過ぎたjobを用意し、実清掃Lambdaを実行 | jobがdone、tombstoneは保持 | 現行取得は404、delete marker追加。復旧用の元versionは残る | 清掃Lambdaのcleanup/200、処理件数 |
| 入力不正 | 不正なJSONや項目を送信 | 項目・画像job・容量counterは不変。認証済みならrateは消費 | 新画像なし | API Lambdaのstatusと安全なerror codeがHTTP応答と一致 |
| 認証拒否 | token欠落・署名不正・scope不足 | 不変 | 不変 | Gatewayの401/403。API Lambdaは呼ばれず、その結果ログは発生しない |
| 依存先故障 | 決定的な故障注入（I層） | 故障位置ごとの整合性・再実行安全性 | 孤児jobによる追跡・参照中画像保護 | Lambda境界の結果ログ契約を結合試験で確認。実配信は通常Eで確認 |

「削除」は、即時の物理削除ではない。DBは再送・競合を扱うtombstoneを残し、画像は24時間保護後に
現行取得をできなくする。過去versionは35日分のDB復旧に備え、非現行になってから60日保持する。
60日後の実際の物理削除を待つ試験は行わず、lifecycle設定を読み戻す。
異常系でもログだけで合否を決めず、意図しない書き込みがないこと、または追跡可能な孤児が残ることを確認する。

東京リージョン・月100リクエスト未満という利用見込みでは、旧version60日保持を維持し、
API Lambdaに1呼び出し1件の結果ログを追加する案を採る。費用の前提と比較は
[費用・ログ方針](../../operations/formal-e2e-cost-and-logging.md)に記載する。以下はこの表を実装するための詳細である。

## 1. 意図、成功条件、現在の状態

目的は「主要経路が動く」確認を、要件に紐付いた正常・異常・境界・状態遷移の検証へ進めること。
利用者は本リポジトリの保守者。各ケースのHTTP応答、永続状態、副作用と未検証範囲を確認し、
依存関係の準備から後片付けまで再現できることを成功条件とする。ケース件数を網羅性の根拠にしない。

2026-10-08の調査で、rootは `/workspace` / `feature/aws-modernization`、アプリは
リンクされたworktree `/workspace/.worktrees/aws-sdd` / `feature/aws-sdd-implementation`、
HEADは `c13272424a3bcb65b6a4613682889be02335c978` と確認した。
アプリの `src/api/event.ts`、`tests/runtime/api.test.ts`、`tests/runtime/boundaries.test.ts` の
未コミットのnull-body修正と、未追跡の過去報告書・ハンドオフ・計画は保持する。
rootのFWとFloci READMEのユーザー変更も保持する。旧19タスクを再実行しない。

現在のソースをビルドすると、未コミット修正も含まれる。今後の検証記録にはHEADだけでなく、
**非秘密のビルド入力**について、対象pathを限定したdigestと未コミット変更の状態、ZIPの実測digestを残す。
`HEAD`だけで生成元を特定したと主張しない。過去の固定ZIPだけが通る検証は、新E2E内でのみ廃止する。
過去スクリプト・報告書は履歴として保持する。

現在のFlociに対する読み取り専用のhealth確認では、HTTP200 / `2.2.0-local-refresh.1-native` が返った。
準備用のPATHでNode24.21.0、Python3.13.16を確認した。npmは11.19.0だったため、
`/tmp/aws-sdd-tools` に11.11.1だけ復元し、同じPATHで確認した。
この調査ではbuild、既存suite再実行、Flociリソース作成、Terraform applyは行っていない。
過去の337 Node / 3 Python / 12 Flociテストの成功は保存文書の記録であり、今回実行した結果ではない。

## 2. 方式比較と推奨

| 方式 | 利点 | 費用・制約 | 判断 |
| --- | --- | --- | --- |
| A: E2E専用Terraform構築・設定確認 → 実HTTP → 保存状態・ログ確認 | 構築から最終結果まで追える。障害注入は別の結合試験で再現できる | Flociの必要APIが非対応なら、正式E2Eは未完了。本番IaC全体のapplyを証明するものではない | **推奨** |
| B: 本番3rootの完全applyを全ケースの前提にする | 設定から実行まで一続きで追える | 保護設定・backend・IAM・OIDC・未知のAPIが全テストを阻害する。本番設定の変更を促す圧力が生じる | 採らない |
| C: 既存の単一CRUDへ全ケースを足す | 初期差分が小さい | 先頭で失敗すると後続が未実施になる。fixture間の依存と古いZIPへの固定も残る | 採らない |

## 3. 検証層と必須範囲

[要件別対応表](../../operations/formal-e2e-coverage.md)をケースの根拠とする。
対応表で付与する `AUTH/API/STORE/IMG/CLEAN/OPS/TF/OBS/SAFE` のIDは新しい検証IDであり、
既存R/O/DタスクやF/B要件IDを置き換えない。出典の節を併記する。

| 層 | 実行内容 | 証明する範囲 |
| --- | --- | --- |
| U | 既存runtime/operations/delivery/packaging | 純粋な境界値、claimsの条件、設定、fakeを使った全状態・上限の検証 |
| I | 製品のservice/adapter + 限定した故障注入用portまたはrequestHandler | before/after/unknown/abortの決定的な再現、保存・checkpoint・再試行の意味 |
| E | Terraform構築・設定確認後、Hosted UI PKCE → 公開JWKS → Gateway JWT → Dockerの現行ZIP → Floci DDB/S3/Logs | HTTP経路、保存、ログ配信の実結合。API Lambdaの直接invoke/claims注入をしない |
| L | 同じZIPの清掃Lambda手動invoke、合成移行/復旧adapter、Terraformローカルapply | 非HTTPの運用経路。API認証E2Eと別表記する |
| A | 別承認の実AWS・実Chrome受け入れ | IAM強制、実JWT/JWKS cache、TLS、PITR、実ランタイム・配信・性能 |

Eの必須群は、認証・独立負例、health/ready/旧API/v2契約、所有者境界、入力境界、
一覧/cursor、逐次ETagと同時競合、画像元bytes/metadata/URL/差し替え/孤児。
Lの必須群は、実際の清掃処理における合成状態/時刻・保護・lease・ページ巡回・再実行と、合成移行/復旧での実adapter結合。
Iではunknown outcome、ページ途中中断、GSI遅延、処理上限等を再現する。
Terraform applyと設定確認、CloudWatchへの結果ログ配信は必須。非対応は基盤のunsupportedとして記録し、
依存するE/Lケースをnot-runにする。SDKで基盤を作り直して正式E2E成功とはしない。
Schedulerのone-time起動とS3署名強制は互換性調査を必須とし、実AWSの保証とは区別する。
必須のE/Lケースに未実施が残れば「正式E2E完了」としない。

## 4. ファイル構成と実行入口

`tests/e2e/floci/` を通常のリポジトリ内テストsuiteとする。既存node:test/node:assert/tsx/SDKを使用し、
新しいテストフレームワークや独自AWSエミュレーターを導入しない。

| 配置（承認後に作成） | 責務 |
| --- | --- |
| `tests/e2e/floci/support/{types,transport,evidence,fixture,auth,artifact,storage,cleanup,logs}.ts` | 明示ローカル通信、証拠、Terraform出力への接続、実PKCE、保存・ログ照合、回収 |
| `tests/e2e/floci/{auth,api,storage,images,cleanup,operations,terraform,logging,scheduler}.test.ts` | 対応表のケース群。suiteごとに独立fixture |
| `tests/integration/formal-e2e/{faults,cleanup-resume,harness}.test.ts` | 決定的な障害と検証基盤自体の意味のある負例 |
| `scripts/e2e/{preflight,run,prepare-artifact,terraform}.ts` | 準備、明示ケース選択、結果集約、ローカルIaCの管理 |
| `tests/fixtures/synthetic/formal-e2e/` | 生成規則・小さな合成画像/JSON。実画像・私有mappingなし |
| `tests/e2e/floci/infra/` | 独立したlocal backend / synthetic variables / pinned provider |
| `docs/operations/formal-e2e-{README,results,limitations}.md` | 日本語実行手順、fresh結果、層別の制限 |

入口の予定は `e2e:preflight`、`test:integration:e2e`、`test:e2e:floci`、`test:e2e:terraform`。
現在のpackage scriptsには存在せず、承認後に追加する。
通常の `npm test` は外部Flociを必要としない既存suiteを維持する。
`test:e2e:floci` の既定は構築・設定確認と必須E/L/loggingの全群。Scheduler起動probeも実行して互換性結果を残す。
`--suite auth|api|storage|images|cleanup|operations|logging|scheduler` は
単独診断用で、部分実行を全体成功にしない。suite内のケースIDで選択できる。
E/LとIとTFの結果は異なるlayer値で保存し、混ぜた「成功件数」を唯一の結果にしない。

preflightは指定バージョン・依存関係・ローカルFloci・必要な通信を確認し、既定endpointへのfallbackを拒否する。
`prepare-artifact` は実行ごとに既存build/package/verify:zipを順に実行し、snapshot ZIPをfixtureへ渡す。
既存artifactは非秘密の生成物だけを対象にする。依存関係の導入には、必要な場合に `npm ci` を使う。
全npm/npx/Python/準備commandは `PATH=/tmp/aws-sdd-tools/node_modules/.bin:/tmp/aws-sdd-tools/bin:$PATH` を付ける。
Node24.21.0/npm11.11.1/Python3.13.16、TFを使う場合1.16.5/provider6.67.0を厳守する。

## 5. 隔離、通信、秘密、後片付け

suiteごとに `e2e-<random owned prefix>` のpool、role、3table、画像/ZIP bucket、
API、API/cleanup Lambda/version/alias、log groupをTerraformで作る。SDKは合成user・データの準備、ZIP upload、
設定・保存状態・ログの読み取り、清掃呼び出しに使う。user/passwordは合成値とし、メモリ内だけで扱う。
所有者A/B、read-only、write-only、同pool別clientと別poolを用途ごとに用意する。
本番の16route（具体method10 + 有限ANY6）を同じJWT/scopeで登録し、削除・並べ替えで成功させない。
CORSは本番設定に揃え、callback originをCORS originと混同しない。

制御clientは明示region `ap-northeast-1`、endpoint `http://floci:4566`、dummy credentials、
maxAttempts=1。HTTP/SDK transportはDNSで確認したRFC1918 IPv4にsocketを固定し、
元URL/Hostを維持する。issuer/JWKSはdiscoveryから取得し、そのhostが同じFlociの
検証済みIP、port4566、owned pool pathであることを検証する。JWT値から接続先を自動許可しない。
callbackは登録した合成URLを検査するだけで、外部へアクセスしない。
redirect、public IP、未知host、userinfo、metadata、共有profileを拒否する。

Lambda側はFlociが注入するlocal region/endpoint/ローカル一時role credentialを用い、
私有AWS設定をmountせず、共有config/credential fileは `/dev/null`、metadataを無効化する。
Floci生成のcredentialは実AWS credentialではなく、保存・表示しない。
元スクリプトの環境変数だけを根拠に、実際にdummy keyが優先されたと推定しない。
service endpointはdiscoveryと一致するprivate IPへ明示し、未知のruntime接続先を許可しない。
S3はvirtual-host形式を含む可能性があるため、署名URLのbucket/owned key/version/endpointを
メモリ内で照合し、**検証クライアント内のDNS固定のみ**で接続する。URL/Host/queryを書き換えない。
このalias対応で足りなければ失敗/制限として示し、FW/Docker/host設定を勝手に変更しない。

Terraform管理リソースはrun専用stateとowned manifestに対応づける。SDKで作った合成データも成功直後に回収手順を登録する。
途中で失敗してもfinallyで回収を試す。SDKでbucket全version/markerやuserを回収後、同じroot/stateでdestroyする。
Schedulerは最初に停止/削除し、処理終了を確認する。SDKはuser・bucket内容を回収し、Terraform管理資源は
destroyで回収する。例外時の補助回収もrun manifestのowned IDに限定し、stateとの整合を記録する。
永久version削除はfixture全体の回収clientだけに許可し、清掃roleに付けない。
回収後にowned IDの不在を確認し、cleanup errorsとleaksを本体結果と別件数にする。
prefixが一致するだけの未知資源や、他runのmanifestを採用しない。
SIGINT/SIGTERMでは期限付き回収、SIGKILL/host crash後はrun固有manifestによる回収手順を残す。
SDK retriesで失敗を隠さず、readiness/GSI/Schedulerの観測pollのみ期限・条件・試行数を記録する。

## 6. ケースの組み立てと判定

各ケースでは「構築・設定確認済みの前提→操作→HTTP/headers→DDBの強い整合性のある読み取り→必要なS3/job/counter→ログ照合」の順に確認する。
拒否されたリクエストでは、項目/counter/job/画像が変わらないことをassertする。ただし認証済みの入力不正は
rateを消費するので、RATE行とSTORAGE行を分けて期待値を指定する。
同時競合は共通ETag取得後のbarrier releaseとPromise.allSettledで2要求を送る。
逐次stale ETagは別ケース。クライアントで同時に送ったことを、AWS内部処理の同時実行保証とは説明しない。
PATCH同士では、競合に負けた要求は412となる。DELETEが先に完了し、後発の強い整合性のある読み取りがtombstoneを読む場合は404となる現行契約を保持する。
DELETEを含むEでは、一方が成功し他方が412または404となることと、保存が一回だけ行われることをassertする。双方が旧activeを読んだtransaction競合は、Iで412をassertする。

認証の負例では、前後に有効tokenで200が返ることを確認し、失敗条件を一つに絞る。
signature改ざんではsignatureだけを変更する。別clientの検証には同poolで実際に署名されたtokenを使い、期限の検証では署名済みtokenの実expを待つ。
期限試験では、他ケースの実行中にtokenの期限が近づくようにし、残り時間だけを30秒以下の非同期waitで待つ。全体は330秒以内とする。
5分を短縮したclient設定やpayload編集で代用しない。
別issuerの負例は期待JWKSで署名検証可能かも確認し、鍵が別ならissuer単独拒否の証明には使わない。
`token_use=id`はscopeも欠けるためGateway403をtoken_use単独証明としない。
token_useの条件やiat/nbf、30日絶対期限は、条件を単独で検証するU/Iと実AWS受け入れへ割り当てる。
refresh graceは実10秒を跨ぐ限定waitを許可し、再利用で期限が延びないことをI/Floci回帰でも確認する。
Chromeのsingle-flight/worker停止/cookie/実ブラウザ認証はこのリポジトリで実施済みにしない。

画像はPNG/JPEG/GIF/WebPの合成bytesをBASE64/data URL入力し、DDB参照/jobと
S3 pinned versionのbytes/MIME/サイズ/SHA-256を照合する。DBに画像bytesがないことも確認する。
URL取得はBearerなし、900秒とversion固定、再発行前後の本文/ETag不変を確認する。
APIの所有者境界を検証し、既知の署名URLを別ownerが取得できないという要件は作らない。
期限/署名拒否は短い期限の独立S3署名controlと改ざんcontrolで調べ、APIの15分発行と区別する。
設定上SigV4検査が任意であるFlociでは取得200だけで署名強制を証明しない。

既定本文2097152±1、画像1048576±1を実経路でも確認する。
容量128MiB/1000件とrate120の規定値はU/Iで検証し、実Eは正規のoverrideを使う
小容量専用fixture（itemCount2/imageBytes24、PNG12bytes、rate3）で境界・競合・回復を確認する。
override値は証拠へ記録し、1000件/128MiB/120並行の実AWS負荷試験と呼ばない。
rate試験は分境界を跨いだrunを合格にせず、事前に窓の余裕を確認して開始する。

## 7. 清掃、障害、移行・復旧

実際の清掃handlerは、同じZIPの別Lambda/aliasを `{}` で手動invokeする。FunctionErrorとpayloadを別々に確認する。
APIで生じたcommitted/retired/pendingの状態を使い、fixtureの合成jobだけをcondition付きで古い時刻に更新する。
created/transition/updated/due/cleanupPartition/cleanupSortKeyを一致させる。
24時間の両側を十分な時計余裕でseedし、正確な等号はIでclockを制御して検証する。
deletingのactive/expired lease20分、done/committedのsparse GSI除外、version/checksum不一致保護、
50候補を跨ぐ同shard51件、次回巡回のcursor reset、二回invokeの収束をLで検証する。
delete marker作成後も元versionが残ることをGETで確認する。
GSI反映のpollでbase itemの条件検証を代替しない。pollがtimeoutした場合はskipせず、当該ケースの失敗とする。

10,000候補/5,000削除/600秒/残り60秒/並行4とページ途中中断は、既存Iを根拠に
追加Iの実adapter結合で検証する。製品へtest clockや清掃上限overrideを足さない。
故障注入では製品のservice/adapterへ限定したport/requestHandlerを渡し、before-send、
after-response-lost、delay/abort、checkpoint/metric/cleanup失敗を独立制御する。
可能なケースはFlociへ実送信後に応答だけ遮断する。fake transportと実送信は必ず区別する。
ZIPのAPI認証を迂回するfault harnessをEとして集計しない。

移行は公開可能な合成JSONをrun専用pathへ生成し、同じsource/mapping/target/runで
import→verify→publish、空owner・特殊key・拒否・再実行を実Floci adapterで確認する。
通常CLIが共有credential chainを作る場合はそのまま実行せず、既存注入interfaceに
明示ローカルclientを渡すE2E wrapperを使う。製品CLIを変更しない。
復旧は合成データを別3tableへseedし、未公開prepare、default read-only照合、
非現行version→新key現行保全、再実行、明示remap、source不変を確認する。
これはPITR APIやデータ切替/rollbackを実証しない。

## 8. Terraform・Schedulerの採否と互換性

調査と採否の詳細は[調査記録](../../operations/formal-e2e-research.md)に記載している。
Terraformを必須基盤に採用する。**E2E専用の独立root**で、必要な認証・Gateway・両Lambda・保存先・ログを構築する。
bootstrap applyでZIP bucket等を準備し、SDKで現行ZIPをuploadする。discoveryで得たissuer/ローカルendpoint等を
合成入力へ渡してruntime applyを行う。最終設定を読み戻すまでE/Lケースを開始しない。
部分applyだけで構築確認成功とはしない。providerが必要とするread/Tag/waiterも調査対象とする。
公開された本番resource定義は設定比較に使うが、本番rootのapplyやbackend/private inputs、state/planの参照は行わない。
本番設定をFlociへ合わせて変更しない。
provider6.67.0の必要API/endpoint schemaを先に確認し、API単位の対応表を作る。
metadata/profile/default endpointの利用を無効にし、使用サービスのendpointをすべて明示する。
取得したproviderはpinned lockで検証する。ローカルstate/planはrun固有の0700 directoryだけに置き、公開証拠へ含めない。
applyが失敗しても同じroot/stateのowned resourceをdestroyし、残存リソースはmanifestで照合する。

本番との差分はlocal endpoint、使い捨てリソース名、削除保護等のfixtureの寿命、ローカルHTTP接続の扱いに限定して列挙する。
IAM/TLS強制の同等性はAで確認する。差分一覧にない設定を黙って省略しない。
JWT/scopes/route/同一artifact/保存schema/cleanup契約を変えて互換性を得ない。
API不足があれば失敗actionと最小独立probeを記録し、TFをunsupportedまたはpartialと判定する。
TF非対応時は依存するE/Lをnot-runとし、独立したU/Iは継続する。正式E2Eは未完了とする。
TFの成功も本番3root全体のapply成功を意味しない。
未知互換性を事前に「対応済み」と扱わない。

構築確認では3tableのkey/GSI/TTL/PITR35日、S3のversioning/暗号化/公開防止/lifecycle60日/CORS、
CognitoのPKCE/client/scope/期限、16route/JWT authorizer/integration/alias/CORS、両Lambdaのhandler/runtime/
timeout/concurrency/同一ZIP、3log groupの30日保持、Schedulerの日次設定を実際に読み戻す。
規定値fixtureとquota/rate縮小fixtureは、それぞれTerraform入力と読み戻した値を照合する。

Schedulerは日次03:00 UTC/OFF/DISABLED/cleanup alias/retry2/age3600の設定を読み戻し、Lで確認する。
起動経路は別のowned one-time `at(...)` schedule、input `{}`、同aliasで試す。
最大90秒の観測pollでjob/checkpointの実変化を確認し、delivery受付だけで完了としない。
日次を待たず、日次時刻の実運転・AWS async再試行/IAM/監視はAへ残す。
設定に接続先追加・host rebuildが必要なら具体的差分と再開手順を保存して停止する。

### API結果ログと観測方法

追加する製品コードはAPI Lambdaの結果ログだけとする。共通の結果ログwrapperで外側のhandlerを包み、通常応答・入力拒否・依存先失敗・
初期化失敗を含めて1呼び出し1件のJSONを出す。既存の安全なlogging helperを使い、HTTP応答の契約は保つ。
記録項目は `requestId/lambdaRequestId/operation/status/code/durationMs`。
operation/codeは固定の許可値、各IDは最大128文字の安全な文字列とし、不正なIDはログから省略する。
正常時はstatusで成功を示し、error codeは省略する。
本文・画像・owner/item ID・生path/query・token・署名URL・例外message/stackは記録しない。
JSONは512bytes以内を契約とし、費用計算は配信時の追加情報を見込んで1KiB/呼び出しと仮定する。
consoleの出力を既存Lambda log groupへ配信し、APIからPutLogEventsを呼ばない。保持30日を維持する。
ログ用の新しいalarm・custom metric・subscription・常時クエリは追加しない。

E2Eではrunの開始時刻とrequestIdを使い、owned log groupのLogs APIから期限60秒・短いpollで結果を取得する。
API LambdaはHTTPのstatus/codeとの一致と1件であること、Gatewayは同じrequestId/status、清掃はLambda request IDと
cleanup/status/処理件数を照合する。配送の再取得による同一eventの重複はevent IDで除外する。
Gateway認証拒否はGatewayログを確認する。現行access logにはアプリケーションerror codeがないため、その値を要求しない。
故障注入Iでも同じwrapperでcreateApiHandlerを包み、ログをcaptureして契約を検証する。CloudWatch配信の証拠とは数えない。
FlociでLogs配送ができない場合、raw consoleや手動PutLogEventsを代替の成功証拠にせず、必須ケースの未完了を記録する。
rawログはメモリ内で照合し、公開結果へは許可項目とassert結果だけを保存する。

## 9. 証拠、失敗、CI、完了条件

run固有のGit追跡対象外の `artifacts/formal-e2e/<runId>/` に、0700 directory/0600 manifest・JSON結果を保存する。
証拠はcaseId、requirementId、layer、pass/fail/not-run/unsupported/out-of-scope、
phase、許可されたstatus/code、assert名、件数、duration、cleanupとleak件数、非秘密のtool/ZIP digestだけ。
fixtureの前提が満たせない場合は依存ケースをnot-runとし、独立したsuiteは継続する。必須ケースは自動skipにしない。
全ケースを列挙してから実行し、fixture初期化に失敗しても集計対象からケースを除外しない。
全assertはbody/token/URL等を含まない固定メッセージに包み、node:testの差分・stack、SDK例外、
子プロセスstdout/stderr、Terraform出力もrawのまま保存・転送しない。
token/code/cookie/password/credential/署名URL/private data/全envを出力しない。

終了コードは0=選択した必須ケース全成功かつcleanup/leak0、1=本体/cleanup/leak/必要case未実施、
2=preflightまたは不正選択。必須TF/Logsのunsupportedはexit1とし、依存する全ケースのnot-runを残す。
結果の統合にはexitだけでなくcase inventoryを照合し、部分実行やTF非対応を全体GREENにしない。
CIでは固定toolのrunnerと現在の修正済みFlociをホスト側で準備し、同じnpm入口を呼ぶ設計とする。
Docker socketはFlociのみ。今回はGHA起動・workflow変更・devcontainer/FW変更をしない。

承認後の完了条件は、対応表の必須E/L/Iを所定の入口から新たに実行し、保存・副作用assertが一致し、
既存test/typecheck/lint/build/package/verify:zip/packaging/必要infra回帰が成功、
cleanup/leak0、秘密不使用、日本語README・結果・制限・review・rulingsの保存がすべて揃うこと。
TF/Logsの非対応は必須ケースの未完了、Scheduler起動/署名強制の非対応は調査結果として明記する。
A/Chromeの未実施も明記する。必要E/LをFloci非互換が阻害する場合は未完了。
製品バグやFloci修正が必要なら根本原因と独立失敗ケースを先に示す。
API結果ログの追加は本書の承認対象に含める。それ以外の製品動作変更は別承認を得るまでE2E実装へ混ぜない。

## 10. 自己レビュー・承認対象

出典、層、必須ケース、実HTTPとclaims注入の区別、現行ソース/ZIP証拠、
時刻合成と実期限、既定値とoverride、Terraform採否と未検証の区別を確認した。
本書と対応表/計画案は未承認である。実装ファイルは作成していない。
承認対象は方式A、対応表の必須範囲、制限、API結果ログの追加、計画案のタスク順。
実AWS/GHA/push/PR/merge・実データ・製品設計変更を承認対象へ拡張しない。
