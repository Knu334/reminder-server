# reminder-server 正式ローカルE2E設計案

作成日: 2026-10-08。状態: **レビュー待ち・未承認・実装未着手**。

製品AWS設計とSDD実行方式は承認済み。正式E2Eの設計・計画は未承認。
[今回のハンドオフ](../handoffs/2026-10-08-reminder-server-formal-e2e-sdd.md)が許可した
調査・検証対応表・文書作成として、この設計と[計画案](../plans/2026-10-08-reminder-server-formal-e2e.md)を同時提示する。
計画案の存在を実行許可にしない。両文書の承認後にSDDを開始し、実行方式や製品設計は再承認しない。

## 1. 意図、成功条件、現在の状態

目的は「主要経路が動く」確認を、要件に紐付いた正常・異常・境界・状態遷移の検証へ進めること。
利用者は本リポジトリの保守者。各ケースのHTTP応答、永続状態、副作用と未検証範囲を確認し、
依存準備から後片付けまで再現できることを成功条件とする。ケース件数を網羅性の根拠にしない。

2026-10-08の調査で、rootは `/workspace` / `feature/aws-modernization`、アプリは
linked worktree `/workspace/.worktrees/aws-sdd` / `feature/aws-sdd-implementation`、
HEADは `c13272424a3bcb65b6a4613682889be02335c978` と確認した。
アプリの `src/api/event.ts`、`tests/runtime/api.test.ts`、`tests/runtime/boundaries.test.ts` の
未コミットnull-body修正、untrackedの過去報告書・ハンドオフ・計画は保持する。
rootのFWとFloci READMEのユーザー変更も保持する。旧19タスクを再実行しない。

現在のソースからのbuildは未コミット修正を含む。将来の証拠にはHEADだけでなく、
**非秘密のビルド入力**のpath限定digestとdirty状態、ZIPの実測digestを残す。
`HEAD`だけで生成元を特定したと主張しない。過去の固定ZIPだけが通る検証を廃止するのは新E2E内だけ。
過去スクリプト・報告書は履歴として保持する。

現在のFlociへの読み取りhealthはHTTP200 / `2.2.0-local-refresh.1-native`。
準備PATHでNode24.21.0、Python3.13.16を確認。npmは11.19.0だったため、
`/tmp/aws-sdd-tools` に11.11.1だけ復元し、同じPATHで確認した。
この調査ではbuild、既存suite再実行、Flociリソース作成、Terraform applyは行っていない。
過去の337 Node / 3 Python / 12 Flociテストの成功は保存文書の記録であり、今回のfresh証拠ではない。

## 2. 方式比較と推奨

| 方式 | 利点 | 費用・制約 | 判断 |
| --- | --- | --- | --- |
| A: SDK fixture + 実HTTP E2E + 決定的な結合試験 + 独立Terraform互換性確認 | 実認証経路を保ち、障害と実通信を区別できる。既存スクリプトを参考に分割できる | fixture・証拠の管理が必要。production IaCの全体apply証明にはならない | **推奨** |
| B: production 3rootの完全applyを全ケースの前提にする | 設定から実行まで一本で追える | 保護・backend・IAM・OIDC・未知APIが全テストを阻害。production設定改変の圧力が生じる | 採らない |
| C: 既存の単一CRUDへ全ケースを足す | 初期差分が小さい | 先頭失敗で後続が未実施、fixture結合、古いZIP固定が残る | 採らない |

## 3. 検証層と必須範囲

[要件別対応表](../../operations/formal-e2e-coverage.md)をケースの根拠とする。
そこで付与する `AUTH/API/STORE/IMG/CLEAN/OPS/TF/SAFE` のIDは新しい検証IDであり、
既存R/O/DタスクやF/B要件IDを置き換えない。出典の節を併記する。

| 層 | 実行内容 | 証明する範囲 |
| --- | --- | --- |
| U | 既存runtime/operations/delivery/packaging | 純粋境界、claims条件、設定、fakeでの全状態・上限 |
| I | production service/adapter + 狭い故障portまたはrequestHandler | 決定的なbefore/after/unknown/abort、保存・checkpoint・再試行の意味 |
| E | Hosted UI PKCE → 公開JWKS → Gateway JWT → Dockerの現行ZIP → Floci DDB/S3 | HTTP経路と保存の実結合。API Lambdaの直接invoke/claims注入をしない |
| L | 同じZIPの清掃Lambda手動invoke、合成移行/復旧adapter、Terraformローカルapply | 非HTTPの運用経路。API認証E2Eと別表記する |
| A | 別承認の実AWS・実Chrome受け入れ | IAM強制、実JWT/JWKS cache、TLS、PITR、実ランタイム・配信・性能 |

Eの必須群は、認証・独立負例、health/ready/旧API/v2契約、所有者境界、入力境界、
一覧/cursor、逐次ETagと同時競合、画像元bytes/metadata/URL/差し替え/孤児。
Lの必須群は、実清掃の合成状態/時刻・保護・lease・ページ巡回・再実行、合成移行/復旧の実adapter結合。
Iではunknown outcome、ページ途中中断、GSI遅延、処理上限等を再現する。
Terraform/Schedulerの互換性は必ず調査・試行結果を保存するが、非対応をEの失敗と混同しない。
必要E/Lケースの未実施が残れば「正式E2E完了」としない。

## 4. ファイル境界と実行入口

`tests/e2e/floci/` を通常のリポジトリ内suiteとする。既存node:test/node:assert/tsx/SDKを使用し、
新しいテストフレームワークや独自AWSエミュレーターを導入しない。

| 配置（承認後に作成） | 責務 |
| --- | --- |
| `tests/e2e/floci/support/{types,transport,evidence,fixture,auth,artifact,storage,cleanup}.ts` | 明示ローカル通信、証拠、owned資源、実PKCE、同一ZIP、保存照合、回収 |
| `tests/e2e/floci/{auth,api,storage,images,cleanup,operations,terraform}.test.ts` | 対応表のケース群。suiteごとに独立fixture |
| `tests/integration/formal-e2e/{faults,cleanup-resume,harness}.test.ts` | 決定的な障害と検証基盤自体の意味のある負例 |
| `scripts/e2e/{preflight,run,prepare-artifact,terraform}.ts` | 準備、明示ケース選択、結果集約、ローカルIaCの管理 |
| `tests/fixtures/synthetic/formal-e2e/` | 生成規則・小さな合成画像/JSON。実画像・私有mappingなし |
| `tests/e2e/floci/infra/` | 独立したlocal backend / synthetic variables / pinned provider |
| `docs/operations/formal-e2e-{README,results,limitations}.md` | 日本語実行手順、fresh結果、層別の制限 |

入口の予定は `e2e:preflight`、`test:integration:e2e`、`test:e2e:floci`、`test:e2e:terraform`。
現在のpackage scriptsには存在せず、承認後に追加する。
通常の `npm test` は外部Flociを必要としない既存suiteを維持する。
`test:e2e:floci` の既定は必須E/Lの全群。`--suite auth|api|storage|images|cleanup|operations` は
単独診断用で、部分実行を全体成功にしない。suite内のケースIDで選択できる。
E/LとIとTFの結果は異なるlayer値で保存し、混ぜた「成功件数」を唯一の結果にしない。

preflightは指定版・依存・ローカルFloci・必要通信を確認し、default endpointへのfallbackを拒否。
`prepare-artifact` が毎runで既存build/package/verify:zipを順に実行し、snapshot ZIPをfixtureへ渡す。
既存artifactは非秘密の生成物だけを対象にし、依存導入は必要時の `npm ci`。
全npm/npx/Python/準備commandは `PATH=/tmp/aws-sdd-tools/node_modules/.bin:/tmp/aws-sdd-tools/bin:$PATH` を付ける。
Node24.21.0/npm11.11.1/Python3.13.16、TFを使う場合1.16.5/provider6.67.0を厳守する。

## 5. 隔離、通信、秘密、後片付け

suiteごとに `e2e-<random owned prefix>` のpool、user、role、3table、画像/ZIP bucket、
API、API/cleanup Lambda/version/alias、log groupを作る。user/passwordは合成、メモリ内のみ。
所有者A/B、read-only、write-only、同pool別clientと別poolを用途ごとに用意する。
productionの16route（具体method10 + 有限ANY6）を同じJWT/scopeで登録し、削除・並べ替えで成功させない。
CORSはproduction設定に揃え、callback originをCORS originと混同しない。

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

owned manifestに作成成功直後のIDと逆順cleanupを登録。途中失敗もfinallyで全actionを試す。
Schedulerは最初に停止/削除し、処理終了を確認後にLambda、Gateway、table、S3全version/marker、
policy/role/log/poolを回収。永久version削除はfixture全体の回収clientだけに許可し、清掃roleに付けない。
回収後にowned IDの不在を確認し、cleanup errorsとleaksを本体結果と別件数にする。
prefixが一致するだけの未知資源や、他runのmanifestを採用しない。
SIGINT/SIGTERMでは期限付き回収、SIGKILL/host crash後はrun固有manifestによる回収手順を残す。
SDK retriesで失敗を隠さず、readiness/GSI/Schedulerの観測pollのみ期限・条件・試行数を記録する。

## 6. ケースの組み立てと判定

各ケースは「前提→操作→HTTP/headers→強いDDB read→必要なS3/job/counter照合」で成立する。
拒否リクエストでは項目/counter/job/画像の不変をassertする。ただし認証済み入力不正は
rateを消費するので、RATE行とSTORAGE行を分けて期待値を指定する。
同時競合は共通ETag取得後のbarrier releaseとPromise.allSettledで2要求を送る。
逐次stale ETagは別ケース。クライアントで同時に送ったことを、AWS内部処理の同時実行保証とは説明しない。
PATCH同士の敗者は412。DELETEが先に完了し後発の強いreadがtombstoneを見る場合は404となる現行契約を保持する。
DELETEを含むEでは一成功/一412または404と保存一回をassertし、双方が旧activeを読んだtransaction競合はIで412をassertする。

認証負例は前後の有効token200を対照に置き、失敗条件を一つにする。
signature改ざんはsignatureだけ変更、別clientは同poolの実署名token、期限は署名済みtokenの実expを待つ。
期限試験は他ケースの間にtokenをagingし、不足分だけ30秒以下の非同期waitで待つ。全体は330秒以内。
5分を短縮したclient設定やpayload編集で代用しない。
別issuerの負例は期待JWKSで署名検証可能かも確認し、鍵が別ならissuer単独拒否の証明には使わない。
`token_use=id`はscopeも欠けるためGateway403をtoken_use単独証明としない。
その条件やiat/nbf、30日絶対期限は単独U/Iと実AWS受け入れへ割り当てる。
refresh graceは実10秒を跨ぐ限定waitを許可し、再利用で期限が延びないことをI/Floci回帰でも確認する。
Chromeのsingle-flight/worker停止/cookie/実ブラウザ認証はこのリポジトリで実施済みにしない。

画像はPNG/JPEG/GIF/WebPの合成bytesをBASE64/data URL入力し、DDB参照/jobと
S3 pinned versionのbytes/MIME/サイズ/SHA-256を照合する。DBへ画像bytesが無いことも確認。
URL取得はBearerなし、900秒とversion固定、再発行前後の本文/ETag不変を確認する。
APIの所有者境界を検証し、既知の署名URLを別ownerが取得できないという要件は作らない。
期限/署名拒否は短い期限の独立S3署名controlと改ざんcontrolで調べ、APIの15分発行と区別する。
設定上SigV4検査が任意であるFlociでは取得200だけで署名強制を証明しない。

既定本文2097152±1、画像1048576±1を実経路でも確認する。
容量128MiB/1000件とrate120の規定値はU/Iで担保し、実Eは正規のoverrideを使う
小容量専用fixture（itemCount2/imageBytes24、PNG12bytes、rate3）で境界・競合・回復を確認する。
override値は証拠へ記録し、1000件/128MiB/120並行の実AWS負荷試験と呼ばない。
rate試験は分境界を跨いだrunを合格にせず、事前に窓の余裕を確認して開始する。

## 7. 清掃、障害、移行・復旧

実清掃handlerは同じZIPの別Lambda/aliasを `{}` で手動invokeする。FunctionErrorとpayloadを別々に確認。
APIで生じたcommitted/retired/pendingの状態を使い、fixtureの合成jobだけをcondition付きでagingする。
created/transition/updated/due/cleanupPartition/cleanupSortKeyを一致させる。
24時間の両側を十分な時計余裕でseedし、正確な等号はIでclockを制御して検証する。
deletingのactive/expired lease20分、done/committedのsparse GSI除外、version/checksum不一致保護、
50候補を跨ぐ同shard51件、次回巡回のcursor reset、二回invokeの収束をLで検証する。
delete marker作成後も元versionが残ることをGETで確認する。
GSI反映pollはbase itemの条件検証を代替せず、poll timeoutはskipせず当該ケースの失敗。

10,000候補/5,000削除/600秒/残り60秒/並行4とページ途中中断は、既存Iを根拠に
追加Iの実adapter結合で検証する。製品へtest clockや清掃上限overrideを足さない。
故障注入はproduction service/adapterへ狭いport/requestHandlerを渡し、before-send、
after-response-lost、delay/abort、checkpoint/metric/cleanup失敗を独立制御する。
可能なケースはFlociへ実送信後に応答だけ遮断する。fake transportと実送信は必ず区別する。
ZIPのAPI認証を迂回するfault harnessをEとして集計しない。

移行は公開可能な合成JSONをrun専用pathへ生成し、同じsource/mapping/target/runで
import→verify→publish、空owner・特殊key・拒否・再実行を実Floci adapterで確認する。
通常CLIが共有credential chainを作る場合はそのまま実行せず、既存注入interfaceに
明示ローカルclientを渡すE2E wrapperを使う。製品CLIを変更しない。
復旧は合成データを別3tableへseedし、未公開prepare、default read-only照合、
非現行version→新key現行保全、再実行、明示remap、source不変を確認。
これはPITR APIやデータ切替/rollbackを実証しない。

## 8. Terraform・Scheduler採否と互換性

調査と採否の詳細は[調査記録](../../operations/formal-e2e-research.md)。
SDK fixtureを必須基盤に採用。Terraformは**E2E専用の独立root**で対応する最小構成の
apply→両ZIP Lambda/Gateway/保存の同じ動作assert→destroyを試す。
production root/backend/private inputs、state/planを参照せず、production設定をFlociへ合わせない。
provider6.67.0の必要API/endpoint schemaを先に確認し、API単位の対応表を作る。
metadata/profile/default endpointを閉じ、使用サービスのendpointをすべて明示する。
取得providerはpinned lockで検証する。ローカルstate/planはrun固有0700 directoryのみ、公開証拠へ含めない。
失敗applyでも同じroot/stateのowned resourceをdestroyし、残存はmanifestで照合する。

SDK/TFの差分はlocal endpoint、disposable名、削除保護等のfixture寿命に限定して列挙する。
JWT/scopes/route/同一artifact/保存schema/cleanup契約を変えて互換性を得ない。
API不足があれば失敗actionと最小独立probeを記録し、TFをunsupportedまたはpartialと判定する。
TF非対応時にも、必須E/LとIを実行できる。TF成功もproduction 3root全体apply成功ではない。
未知互換性を事前に「対応済み」と扱わない。

Schedulerは日次03:00 UTC/OFF/DISABLED/cleanup alias/retry2/age3600の設定read-backをLで確認。
起動経路は別のowned one-time `at(...)` schedule、input `{}`、同aliasで試す。
最大90秒の観測pollでjob/checkpointの実変化を確認し、delivery受付だけで完了としない。
日次を待たず、日次時刻の実運転・AWS async再試行/IAM/監視はAへ残す。
設定に接続先追加・host rebuildが必要なら具体的差分と再開手順を保存して停止する。

## 9. 証拠、失敗、CI、完了条件

run固有のignored `artifacts/formal-e2e/<runId>/` に0700 directory/0600 manifest・JSON結果を保存する。
証拠はcaseId、requirementId、layer、pass/fail/not-run/unsupported/out-of-scope、
phase、許可されたstatus/code、assert名、件数、duration、cleanupとleak件数、非秘密のtool/ZIP digestだけ。
fixture前提失敗は依存ケースをnot-run、独立suiteは継続。必須ケースは自動skipにしない。
全ケースを列挙してから実行し、fixture初期化失敗でも分母を失わない。
全assertはbody/token/URL等を含まない固定メッセージに包み、node:testの差分・stack、SDK例外、
子プロセスstdout/stderr、Terraform出力もrawのまま保存・転送しない。
token/code/cookie/password/credential/署名URL/private data/全envを出力しない。

退出値は0=選択した必須ケース全成功かつcleanup/leak0、1=本体/cleanup/leak/必要case未実施、
2=preflightまたは不正選択。TF probeはunsupportedを結果分類し、選択していればexit1にする。
結果の統合にはexitだけでなくcase inventoryを照合し、部分実行やTF非対応を全体GREENにしない。
CIは固定toolのrunnerと現在のpatched Flociをホスト側で準備し、同じnpm入口を呼ぶ設計。
Docker socketはFlociのみ。今回はGHA起動・workflow変更・devcontainer/FW変更をしない。

承認後の完了条件は、対応表の必須E/L/Iがfresh入口から実行され、保存・副作用assertが一致し、
既存test/typecheck/lint/build/package/verify:zip/packaging/必要infra回帰が成功、
cleanup/leak0、秘密不使用、日本語README・結果・制限・review・rulingsの保存が揃うこと。
TF/Schedulerの非対応とA/Chromeの未実施は明記する。必要E/LをFloci非互換が阻害する場合は未完了。
製品バグやFloci修正が必要なら根本原因と独立失敗ケースを先に示す。
製品動作変更は別承認を得るまでE2E実装へ混ぜない。

## 10. 自己レビュー・承認対象

出典、層、必須ケース、実HTTPとclaims注入の境界、現行ソース/ZIP証拠、
時刻合成と実期限、既定値とoverride、Terraform採否と未検証の区別を確認した。
本書と対応表/計画案は未承認。実装ファイルは作成していない。
承認対象は方式A、対応表の必須範囲、制限、計画案のタスク順。
実AWS/GHA/push/PR/merge・実データ・製品設計変更を承認対象へ拡張しない。
