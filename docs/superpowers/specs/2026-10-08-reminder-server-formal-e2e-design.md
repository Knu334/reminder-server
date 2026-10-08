# reminder-server 正式ローカルE2E設計案

作成日: 2026-10-08。状態: **レビュー待ち・未承認・実装未着手**。

製品AWS設計とSDD実行方式は承認済み。正式E2Eの設計・計画は未承認。
[今回のハンドオフ](../handoffs/2026-10-08-reminder-server-formal-e2e-sdd.md)が許可した
調査、検証対応表の作成、文書作成の範囲で、この設計と[計画案](../plans/2026-10-08-reminder-server-formal-e2e.md)を同時に提示する。
計画案があるだけでは実行許可とみなさない。両文書の承認後にSDDを開始し、実行方式や製品設計の再承認は求めない。

## まず何を確認するか

正式E2Eは次の順で実行する。Terraformによる構築と設定の確認を、すべての実経路ケースの前提とする。

1. 現行ソースからZIPを作り、既存の本番Terraformの3rootを使ってFlociにサービスを構築する。
2. 設定を読み戻し、認証・ルート・保存先・実行するZIP・保持期間が意図どおりであることを確認する。
3. 合成ユーザーで認証し、実HTTPで登録・更新・削除・不正な入力を送る。
4. HTTP応答に加えて、DynamoDB、S3、CloudWatchの結果を確認する。
5. 検証結果の記録後、当該実行のリソースだけを回収し、漏れがないことを確認する。削除防止の解除はこの後片付け段階だけで行う。

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
[費用・ログ方針](../../operations/formal-e2e-cost-and-logging.md)に記載する。Terraformは既存のresource定義を再利用し、共通module化や本番ファイルの書き換えを計画しない。
接続先以外は本番と同じ設定を目標とし、下記§8で必要な隔離・接続・後片付けの差分を区別する。
以下はこの表を実装するための詳細である。

## 1. 意図、成功条件、現在の状態

目的は「主要経路が動く」確認を、要件に紐付いた正常・異常・境界・状態遷移の検証へ進めること。
利用者は本リポジトリの保守者。各ケースのHTTP応答、永続状態、副作用と未検証範囲を確認し、
依存関係の準備から後片付けまで再現できることを成功条件とする。ケース件数を網羅性の根拠にしない。

2026-10-08の調査で、rootは `/workspace` / `feature/aws-modernization`、アプリは
リンクされたworktree `/workspace/.worktrees/aws-sdd` / `feature/aws-sdd-implementation`、
調査開始時のHEADは `c13272424a3bcb65b6a4613682889be02335c978` と確認した。再開時は実際のHEADと変更状態を確認する。
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

## 2. Terraformの再利用方針

既存の `infra/bootstrap`、`infra/platform/production`、`infra/application/production` を再利用する。
各rootの公開ソースを実行ごとの一時ディレクトリへ配置し、接続設定とローカルbackendだけを追加する。
resource定義の複製をリポジトリへ新設せず、共通moduleへの切り出しやresource addressの移動も行わない。
元ファイルと配置後ファイルのdigest一致、追加設定の差分許可リスト、実際の設定読み戻しで同一性を確認する。

| 方式 | 利点 | 制約 | 判断 |
| --- | --- | --- | --- |
| A: 本番3rootを一時ディレクトリで再利用 | 既存のresource定義と初期構築手順を検証できる。本番ソースを変更せずに進められる | Flociの不足API、接続URLの検証、後片付けの保護解除を扱う必要がある | 推奨 |
| B: 共通moduleへ切り出す | 本番とE2Eの定義を共有できる | 既存IaCの構造・resource address・回帰確認の変更が増える | 今回は採らない |
| C: E2E専用のresource定義を新設する | ローカル構築だけに合わせやすい | 本番との設定ずれや二重管理が残る | 採らない |

## 3. 実行順序と検証層

### 実行順序

§4〜9は、次の実行順序の準備・判定・例外を定義する。節番号自体は実行順序を表さない。

| 順序 | 行うこと | 次へ進む条件 | 詳細・計画 |
| --- | --- | --- | --- |
| 1 | 接続先を確認し、現行ソースからZIPを作る | ローカル接続の確認、生成元digestとZIP整合 | §4〜5、Task1/3 |
| 2 | 本番3rootを再利用してFlociへapplyする | bootstrap/platform/applicationの最終構築成功。途中のseedだけでは通過しない | §8、Task3 |
| 3 | 実サービスの設定を読み戻す | 本番設定との一致、接続・隔離差分の許可範囲、同一ZIP、保護設定、log配信のsmokeを確認 | §8、Task4 |
| 4 | ケース固有の合成データ・userを用意し、入力を送る | 前提が成立し、通常APIは実PKCE/JWT/Gateway経由で送信 | §5〜7、Task5〜10 |
| 5 | HTTP・DDB・S3・CloudWatchの結果を照合する | ケースに定義した出力がすべて一致。HTTP成功だけでは合格にしない | §6〜8、Task4〜11 |
| 6 | 結果を確定してから保護解除・回収する | 全ケースの実施/未実施が残り、回収error/leakが0 | §5/8/9、Task3/4/12 |

現案ではsuiteごとに独立した基盤を使い、順序2〜6を繰り返す。ZIPはrun内で共通にする。
ケースごとのapplyは行わず、合成user・データを分離する。別poolや復旧先が必要なケースだけ追加stackを使う。
これは一度のapplyで全suiteが同じ基盤を共有する構成とは異なるが、各ケースは必ず構築・設定確認後に開始する。

### ケースをどの経路で確認するか

U/I/E/L/Aは検証経路の区分であり、実行順序ではない。Terraform構築・設定確認はLに分類する。
全体を合格にするには、上表の構築・設定確認と、対応表の必須ケースの両方が必要である。

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
Terraform applyと設定確認、CloudWatchへの結果ログ配信は必須。構築・設定確認が失敗した場合、
当該基盤を使うE/Lはnot-runにする。SDKで基盤を作り直して正式E2E成功とはしない。
入力送信後に保存状態やログが不一致だった場合は、実施したケースをfailにする。not-runへ戻して実施証拠を消さない。
故障注入Iで確認する依存先障害と容量境界は、実HTTP/CloudWatch配信のEとは別に報告する。
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
| `scripts/e2e/terraform-source.ts` | 本番3rootの公開ソース配置、digest照合、追加差分の検査。合成inputs/local backendは実行時に生成 |
| `docs/operations/formal-e2e-{README,results,limitations}.md` | 日本語実行手順、fresh結果、層別の制限 |

入口の予定は `e2e:preflight`、`test:integration:e2e`、`test:e2e:floci`、`test:e2e:terraform`。
現在のpackage scriptsには存在せず、承認後に追加する。
通常の `npm test` は外部Flociを必要としない既存suiteを維持する。
`test:e2e:floci` の既定は構築・設定確認と必須E/L/loggingの全群。Scheduler起動probeも実行して互換性結果を残す。
`--suite auth|api|storage|images|cleanup|operations|logging|scheduler` は
単独診断用で、部分実行を全体成功にしない。suite内のケースIDで選択できる。
layerはU/I/E/L/Aだけとする。TFは要件IDの区分であり、実apply・設定確認はL、driver/sourceの決定的な負例はIとして保存する。
`--layer floci|terraform` は既存案の実行入口の選択値であり、結果のlayerへそのまま転記しない。
構築・設定確認、通常API、清掃/合成運用、故障注入の件数をそれぞれ示し、合計成功件数だけで完了を判断しない。

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
各ケースに合成user A/Bを割り当て、別ケースのRATEや保存状態を共有しない。
負例用の同pool別clientやone-time scheduleは追加のcontrol資源としてmanifestに登録し、基盤構築の代わりには使わない。
別poolや復旧用3tableが必要な場合は、同じ本番3rootを別owned prefix/stateで再利用する。
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
途中で失敗してもfinallyで回収を試す。検証終了を記録してから保護解除・合成データ回収・逆順destroyを行う。解除は当該runの一時rootとownedリソースだけに限定する。
Schedulerは最初に停止/削除し、処理終了を確認する。SDKはuser・bucket内容とサービス側削除保護を扱い、Terraform管理資源は
後片付け用overrideを追加した同じ一時root/stateでdestroyする。例外時の補助回収もrun manifestのowned IDに限定し、stateとの整合を記録する。
永久version削除はfixture全体の回収clientだけに許可し、清掃roleに付けない。
回収後にowned IDの不在を確認し、cleanup errorsとleaksを本体結果と別件数にする。
prefixが一致するだけの未知資源や、他runのmanifestを採用しない。
SIGINT/SIGTERMでは期限付き回収、SIGKILL/host crash後はrun固有manifestによる回収手順を残す。
SDK retriesで失敗を隠さず、readiness/GSI/Schedulerの観測pollのみ期限・条件・試行数を記録する。

## 6. ケースの組み立てと判定

### 入力と最終結果の対応

各ケースでは「構築・設定確認済みの前提→入力→HTTP/headers→DDBの強い整合性のある読み取り→S3/job/counter→CloudWatchログ」の順に確認する。
ケース定義にはHTTP・DDB・S3・ログの期待をそれぞれ記載する。画像のない操作でもS3への書き込みがないことを確認し、
条件に当てはまらない出力は理由を示す。ログだけ、またはHTTPだけの成功で、保存状態の確認を省略しない。
期待するassert名と実際の照合結果も出力ごとに残す。必須assertが未確認なら、その出力とケースをpassにしない。

| 出力 | 正常系で確認すること | 異常系で確認すること |
| --- | --- | --- |
| HTTP | operationごとのstatus、DTO、ETag等 | 想定status/code。Gateway拒否とAPI拒否を区別 |
| DynamoDB | 登録・更新後の項目/revision/画像参照/job/counter。削除後はtombstoneとcounter減少 | 入力拒否時の保存不変。故障時はcommit確定または再実行可能な追跡状態 |
| S3 | 登録・差し替え後の元bytes/version/checksum。API削除直後は保持、清掃後は現行GET404・元version保持 | 入力拒否時の追加保存なし。Put成功後のDB失敗では孤児jobによる追跡と元画像保護 |
| CloudWatch | APIのoperation/status、GatewayのrequestId/status、清掃のoperation/status/件数を実log groupで確認 | APIに到達した拒否はHTTPと同じstatus/code。認証拒否はGatewayログとAPI結果ログ不在。故障注入Iのcaptureは実配信と区別 |

具体的な入力値と期待値は対応表の各要件からケースへ展開し、ログの照合方法は§8に従う。
ログが60秒以内に確認できない場合、HTTPや保存結果が正しくても、そのログ必須ケースはfailとする。

### 境界・競合・認証の判定

認証・入力検証で拒否されたリクエストでは、項目/counter/job/画像が変わらないことをassertする。ただし認証済みの入力不正は
rateを消費するので、RATE行とSTORAGE行を分けて期待値を指定する。
画像Put後の重複登録409や依存先故障は、期待する孤児pending jobと画像保持を確認する。すべてのエラーを保存不変として扱わない。
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
refresh graceは実10秒を跨ぐ限定waitを許可し、旧tokenの再利用で10秒の起点が延びないことをEで確認する。
refreshの30日絶対期限と、更新してもその期限が延びないことはAへ残す。既存Floci回帰は補助資料として区別する。
Chromeのsingle-flight/worker停止/cookie/実ブラウザ認証はこのリポジトリで実施済みにしない。

画像はPNG/JPEG/GIF/WebPの合成bytesをBASE64/data URL入力し、DDB参照/jobと
S3 pinned versionのbytes/MIME/サイズ/SHA-256を照合する。DBに画像bytesがないことも確認する。
URL取得はBearerなし、900秒とversion固定、再発行前後の本文/ETag不変を確認する。
APIの所有者境界を検証し、既知の署名URLを別ownerが取得できないという要件は作らない。
期限/署名拒否は短い期限の独立S3署名controlと改ざんcontrolで調べ、APIの15分発行と区別する。
設定上SigV4検査が任意であるFlociでは取得200だけで署名強制を証明しない。

既定本文2097152±1、画像1048576±1を実経路でも確認する。
実E/Lでは `runtime_limits={}` として容量128MiB/1000件、rate120を維持し、小容量やrate3へ変更しない。
容量の等号・超過・競合・回復は、規定値を設定したIで上限直前の合成状態を用意して確認する。
実Eは登録・差し替え・削除に伴うcounterの整合を確認し、容量境界のIを実HTTP試験と呼ばない。
rate境界は実上限120のまま、合成ownerの当該minuteにcount119と正しいexpiresAtをseedし、
二つのtokenでGETを一回ずつ送り、200→429/Retry-Afterとcount120を確認する。
準備した状態を記録し、121回の実リクエストを送った試験とは説明しない。
rate試験は分境界を跨いだrunを合格にせず、事前に窓の余裕を確認して開始する。

## 7. 清掃、障害、移行・復旧

この節も§3の構築・設定確認済みの基盤で実行する。APIの登録・削除から清掃へ続く正常系は、
実HTTPで作った画像/jobを起点とし、清掃後のDDB/S3と実清掃ログまで照合する。
清掃Lambdaの手動invokeと合成運用CLIはL、故障注入はIとして通常APIのEと区別する。

実際の清掃handlerは、同じZIPの別Lambda/aliasを `{}` で手動invokeする。FunctionErrorとpayloadを別々に確認する。
APIで生じたcommitted/retired/pendingの状態を使い、fixtureの合成jobだけをcondition付きで古い時刻に更新する。
created/transition/updated/due/cleanupPartition/cleanupSortKeyを一致させる。
24時間の両側を十分な時計余裕でseedし、正確な等号はIでclockを制御して検証する。
deletingのactive/expired lease20分、done/committedのsparse GSI除外、version/checksum不一致保護、
50候補を跨ぐ同shard51件、次回巡回のcursor reset、二回invokeの収束をLで検証する。
delete marker作成後も元versionが残ることをGETで確認する。
未公開の清掃はcleanup_start、skippedUnpublishedの応答、保存不変を確認し、通常のcleanup終了ログを要求しない。
不正eventは開始ログより前に拒否されるため、FunctionErrorと保存不変を確認し、アプリケーションログ照合の対象外理由を残す。
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
復旧は別owned stackの同じ定義で作成した3tableへ合成データをseedし、未公開prepare、default read-only照合、
非現行version→新key現行保全、再実行、明示remap、source不変を確認する。
これはPITR APIやデータ切替/rollbackを実証しない。

## 8. 本番Terraformの再利用とFloci互換性

[調査記録](../../operations/formal-e2e-research.md)に根拠を記載する。
本番Terraformの公開ソースを使うローカル構築を必須基盤とする。実AWSの本番環境には接続しない。
変更対象はE2Eのdriverと文書であり、既存の本番 `.tf` / lock / resource addressは変更しない。

### 同じ設定で検証する範囲

本番の認証設定、16route/scopes、DDB schema/GSI/TTL/PITR35日、S3 versioning/暗号化/公開防止/
旧version60日、IAM policy/trust、Lambda runtime/handler/memory/timeout/concurrency/alias、log group30日、
Schedulerと9alarmの定義を再利用する。容量・rate・清掃上限、CORSやcallbackの検証条件も維持する。
削除防止とS3のTLS必須policyも、構築から結果確認まで本番どおりに保持する。
Flociが設定を受け付けることと、IAM/TLS/alarm等をAWSと同様に強制・実行することは区別する。
後者の本番同等性はAの未検証範囲である。

### 差分の扱い

| 区分 | 差分 | 適用する段階 |
| --- | --- | --- |
| 接続 | providerのlocal endpoint/dummy credential、metadata/profile遮断、Flociのissuer/Hosted UI URL、必要なruntime endpoint | 構築・検証 |
| 隔離 | 本番backendを使わないlocal state、owned prefix、合成account/repository/origin/callback/user、実行時に作られたID | 構築・検証。既存の入力検証を満たす値を使う |
| 後片付け | 一時rootのprevent_destroy解除、owned資源のサービス側削除保護・削除拒否policyの解除 | 結果の確定後、または失敗時の回収段階だけ |
| 変更しない設定 | 認証・route・保存schema・容量/rate・保持期間・実行設定・保護policy等 | 検証中の追加差分は認めない |

接続先以外の差分も上表のとおり存在するため「完全に同一」とは記録しない。
接続・隔離に必要な差分だけで構築できるかは未実測。必要APIが非対応なら、設定を省略・緩和せず
failedActionと独立probeを保存し、該当TFケースをunsupportedまたはfail、未開始の依存E/Lをnot-run、正式E2Eを未完了とする。
partial applyはphaseとowned manifestへ記録する。共通型にないpartialというcase statusは追加しない。
S3のHTTP接続がTLS必須policyで拒否される場合も、policyを削って成功にしない。
接続先の変更に伴うURL検証の追加は、discoveryで確認したowned Floci URLだけに限定する。
API ID形式等の接続と無関係な検証を緩めない。必要な差分が上表を超える場合は原因と具体的差分を提示する。

### 一時rootの準備・apply・回収

各rootの公開 `.tf`（本番backend定義を除く）と公開lockを明示したpathだけから配置する。
本番backend/private inputs/state/plan・実データを読まず、run固有の0700 directoryにlocal backendと合成inputsを作る。
通常ファイルを保持し、生成する接続overrideの変更先を許可リストで制限する。
overrideはnested blockを丸ごと置き換える場合があるため、元のvalidationやpolicyを落としていないことを検査する。
TF1.16.5/provider6.67.0を固定し、全使用service endpointとアカウント照合を確認する。

構築順は本番の初期構築手順に沿って、bootstrap→platform→applicationのAPI-only seed→
API IDを渡すbootstrap更新→現行ZIP登録→application全体applyとする。
seedは本番の既存手順どおり同じresource addressだけをtargetとし、通常applyではseed flagを外す。
root間はallowlisted outputsを合成inputsへ渡し、別rootのstateを読まない。
初期化・seed・一部resourceだけの成功を基盤成功にせず、3rootの最終構築と設定読み戻しを要求する。

すべての結果を記録してから、Scheduler停止・処理終了確認、owned資源のサービス側削除保護やbucket削除拒否の解除、
合成user・全bucket version/marker回収、一時rootの後片付けoverride、application→platform→bootstrapのdestroyを行う。
保護解除は回収専用clientからowned IDにだけ行い、検証中のroleやpolicyを変更しない。
partial applyや試験失敗でもこの回収を試し、解除/回収失敗とleakを本体結果と別に報告する。
後片付け設定で再びケースを実行しない。実行開始時と結果確定前には保護設定を読み戻し、検証中の変更がないことを確認する。

Schedulerの日次03:00 UTC/OFF/DISABLED/cleanup alias/retry2/age3600は同じ定義で読み戻す。
起動経路は別のowned one-time `at(...)` schedule、input `{}`、同aliasで試し、
最大90秒の短いpollでjob/checkpointの実変化を確認する。daily scheduleをテスト用へ変更しない。
日次の実運転・AWS async再試行/IAM/監視はAへ残す。
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
API LambdaはHTTPのstatus/codeとの一致と1件であること、Gatewayは同じrequestId/statusを照合する。
清掃の開始ログはlambdaRequestIdを持ち、終了ログのrequestIdはservice内で作る別のrunIdである。同じIDとして照合しない。
手動清掃は同一fixtureで逐次実行し、Scheduler停止と前回処理終了を確認する。同じlog stream内の開始・終了を当該invokeの観測区間で対応づけ、status/処理件数と保存状態を照合する。
Scheduler probeで対応関係を特定できない場合も、別invokeの終了ログを採用せず失敗・制限として残す。
配送の再取得による同一eventの重複はevent IDで除外する。
Gateway認証拒否はGatewayログを確認する。現行access logにはアプリケーションerror codeがないため、その値を要求しない。
故障注入Iでも同じwrapperでcreateApiHandlerを包み、ログをcaptureして契約を検証する。CloudWatch配信の証拠とは数えない。
FlociでLogs配送ができない場合、raw consoleや手動PutLogEventsを代替の成功証拠にせず、必須ケースの未完了を記録する。
rawログはメモリ内で照合し、公開結果へは許可項目とassert結果だけを保存する。

## 9. 証拠、失敗、CI、完了条件

run固有のGit追跡対象外の `artifacts/formal-e2e/<runId>/` に、0700 directory/0600 manifest・JSON結果を保存する。
証拠はcaseId、requirementId、layer、pass/fail/not-run/unsupported/out-of-scope、
phase、許可されたstatus/code、HTTP/DDB/S3/ログごとのassert名・照合結果・対象外理由、件数、duration、cleanupとleak件数、非秘密のtool/ZIP/本番公開ソースdigest、差分区分と件数だけ。
fixtureの前提が満たせない場合は依存ケースをnot-runとし、独立したsuiteは継続する。必須ケースは自動skipにしない。
全ケースを列挙してから実行し、fixture初期化に失敗しても集計対象からケースを除外しない。
全assertはbody/token/URL等を含まない固定メッセージに包み、node:testの差分・stack、SDK例外、
子プロセスstdout/stderr、Terraform出力もrawのまま保存・転送しない。
token/code/cookie/password/credential/署名URL/private data/全envを出力しない。

終了コードは0=選択した必須ケース全成功かつcleanup/leak0、1=本体/cleanup/leak/必要case未実施、
2=preflightまたは不正選択。必須TF/Logsのunsupportedはexit1とする。
基盤初期化前に阻害されたケースはnot-run、入力や処理を実行してから不一致が分かったケースはfailとして残す。
結果の統合にはexitだけでなくcase inventoryを照合し、部分実行やTF非対応を全体GREENにしない。
CIでは固定toolのrunnerと現在の修正済みFlociをホスト側で準備し、同じnpm入口を呼ぶ設計とする。
Docker socketはFlociのみ。今回はGHA起動・workflow変更・devcontainer/FW変更をしない。

承認後の完了条件は、Terraform構築・設定読み戻し・実ログ配信と、対応表の必須E/L/Iを所定の入口から新たに実行し、
HTTP・DDB・S3・ログの期待assertがすべて一致し、
既存test/typecheck/lint/build/package/verify:zip/packaging/必要infra回帰が成功、
cleanup/leak0、秘密不使用、日本語README・結果・制限・review・rulingsの保存がすべて揃うこと。
TF/Logsの非対応は必須ケースの未完了、Scheduler起動/署名強制の非対応は調査結果として明記する。
A/Chromeの未実施も明記する。必要E/LをFloci非互換が阻害する場合は未完了。
製品バグやFloci修正が必要なら根本原因と独立失敗ケースを先に示す。
API結果ログの追加は本書の承認対象に含める。それ以外の製品動作変更は別承認を得るまでE2E実装へ混ぜない。

## 10. 自己レビュー・承認対象

出典、層、必須ケース、実HTTPとclaims注入の区別、現行ソース/ZIP証拠、
時刻合成と実期限、本番設定の維持、接続・隔離・後片付けの差分、Terraform採否と未検証の区別を確認した。
本書と対応表/計画案は未承認である。実装ファイルは作成していない。
承認対象は本番3rootの再利用、上表の接続・隔離・後片付け差分、対応表の必須範囲、制限、API結果ログの追加、計画案のタスク順。
実AWS/GHA/push/PR/merge・実データ・製品設計変更を承認対象へ拡張しない。
