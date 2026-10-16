# 受け入れ記録

2026-10-06更新。この記録は、完了したローカルの合成検証と、将来の本番受け入れを区別する。19タスクのgateはすべて完了した。ブランチ全体のレビューで5件の問題が見つかった。まとめた修正（fix wave）は`63c1512f75d8cdf687083d71412be522b504efe1` としてcommit済みである。controllerによる最終ローカル検証の全体は合格した。1回限りの、範囲を限定した独立の再レビューは完了した。5件の指摘はすべて対処され、新たなCritical/Importantはない。ダウンロードした診断ファイルの権限に関するMinor 1件は、明示的に先送りした。[最終レビューとcontrollerの処置](../implementation-final-review.md)を参照。

下の表は、そのコードcommitでのcontrollerの実際の結果を記録する。コンテナの生のtimestampは `2026-10-05T19:42:04.110074+00:00` である。上の文書の更新日は、10月6日のセッションの日付に従う。過去のD08の試験303件、mock 56件、ZIPの測定値は置き換え済みであり、変更後のコードに当てはめて推定しない。

## ローカルで再現できるコマンドとartifact

Node24.21.0/npm11.11.1/Python3.13.16/Terraform1.16.5/AWS provider6.67.0を使う。[READMEの検証ブロック](../../README.md)をそのとおりに実行する。build/packageは、npm testより前に行う。`infra:check` は、backendを使わないvalidation/schemaの検査、bootstrap/platform/applicationにわたるmockのTerraform実行、fmtを行う。AWSアカウントへの呼び出しはしない。合成試験は、認証/所有権、ETagの競合、storage/不確定な書き込み、cleanup/checkpoint、移行/復旧、immutableなartifactの登録、saved planの保管（custody）、aliasとworkflowのgateを扱う。secret ruleの試験は、コマンド文字列と、空のcanaryを置いた隔離したGit
リポジトリを使う。untrackingで保持されることの試験で読むのは、一時的なbyteだけである。実際の私的データ、credential、環境のdumpは調べていない。

| 証拠 | ローカルの結果 |
| --- | --- |
| controllerのコマンド記録 | 17コマンドすべてが、コード `63c1512f75d8cdf687083d71412be522b504efe1` でexit 0だった |
| typecheck / lint / build / package / verify:zip | 合格 |
| Nodeの試験 | 331/331: runtime160 / operations74 / delivery97、失敗0 |
| Pythonのpackaging | 3/3合格 |
| Terraformのroot/mock | controllerによる3 rootすべてのschema/validate/fmtが合格。fix waveを網羅する証拠: bootstrap31 / platform17 / application30 =78 mock |
| runtime/全依存のaudit | どちらも、info/low/moderate/high/criticalを含む全severityで0 |
| package SHA-256 hex | `e4f5a215942fe8aa4c58f755698564a491cd5a88b13b4810f8c20fdb0d52594c` |
| package SHA-256 Base64 | `5PWiFZQv6KpMWPdVaYVkpJHNWoixO0gQ+MIP2w1SWUw=` |
| 圧縮後 / 展開後のbyte数 | 1,387,083 / 8,900,746 |
| S3 key/versionId | 未登録。実際のversionIdはない |
| Lambda CodeSha256 / versions / aliases | 未デプロイ。liveでの検証もしていない |
| .devcontainer baseline253e5e2 | git diff --exit-codeが合格。変更なし |
| 保護対象を除外したworking/stagedのdiff検査 | 合格 |
| AGENTSのlink / 補助ルール | D08に絞った合成試験8/8、AGENTS→CLAUDEが解決する |

ZIPに含まれるのは、dist/*.js、dist/*.js.map、THIRD_PARTY_NOTICESだけである。リポジトリの依存なしに、Node24で両方のhandlerを読み込める。immutableなS3のversion/checksumと、両方のLambdaのversion/CodeSha
が証明されるまでは、AWSのreleaseではない。ローカルで測定した同じdigestを、登録済みのartifactと表示してはならない。現在のCycloneDX1.5 SBOMは、157 components、209,092 bytes、SHA-256
`c9f10560b1928f6161ec2cd6472060d288be03338d4c9185344b3cd95aa1f5eb` である。過去のD08のnpm ciは成功した（157 packages /158 audited）。既存のESLint9.39のunsupported/deprecatedの警告が出た。安全な合成runtimeのログノイズと、Terraformのtargetの警告は、既知のものとして残る。出力に警告がないとは主張しない。SBOM/auditの詳細と、新しく取ったコマンドのログは、ignore対象のdelivery ledgerのcontroller-final-metadata.json、controller-final-verification.json、controller-final-00.logからcontroller-final-16.logまでに保管している。78 mockの網羅的な証拠は、final-fixの報告にある。それより前のD08の報告は、過去の記録として残る。私的なplan/state/内容は、どれも公開artifactではない。

## 別途の承認の後にだけ記入する本番の記録

| 項目 | 現在の値 / 将来必要な証拠 |
| --- | --- |
| Serverのimmutable commit | 選んだ40桁の完全なcommitと、それに一致するmainのcheckoutを記録する |
| ZIPのdigestと登録 | 検証済みのSHA/size、S3のbucket/key/versionId、証拠のIDを記録する |
| API/cleanupのversion | 両方の本番alias、公開されたversion番号、実際のCodeSha256を記録する |
| Gateway/認証のidentity | レビュー済みのregion/API ID/URL、Cognitoのissuer/client/domainのbaselineを記録する |
| 拡張機能のversionとID | 未提供。インストールしたrelease/version、正確な拡張機能ID、callback/logout URLを記録する |
| 合成試験のID | `acceptance-d08-001`（CRUD/画像なし）、`acceptance-d08-image-001`（元のbyte）、`acceptance-d08-conflict-001`（ETag）を予約する。liveではどれも作成していない |
| 日付 / operator / 結果 | UTCの時刻、承認されたoperator、実際に観測した結果。パスワード/token/ユーザーの内容は書かない |

将来のoperatorは、まず[デプロイ手順](deployment.md)のとおりに、privateリポジトリへのアクセス、main/environment/OIDCのsubject、reviewer保護が使えることを確認する。bootstrap/platform/operatorのAPI-only seed/既知IDの引き渡しと、applicationのpreview→レビュー済みdigest→apply、保存したbinaryの来歴（provenance）/保管（custody）、両方のaliasを検証する。この実装では、AWSのprovisioning、実際の登録、GHAの実行、seed/apply、statusだけのlive
smokeのいずれも実施していない。

次に、ownerが、正確な拡張機能versionで[Chromeの認証確認](../chrome-extension-cognito-auth.md)を行う。対象は、consoleで最初に作成したuserの一時パスワードの変更、code/PKCE/state、classic Hosted UI、OAuth scope、公開のdirect SRP/password/user/custom認証の拒否、5分の期限とsingle-flightのrefresh、30日のrefreshの寿命/10秒のrotationの猶予、再起動/offline/logout、不正なcallbackである。**IAMで制限したadmin専用のflowと、classic Hosted UIの互換性、公開direct認証の閉鎖は、合わせてliveで受け入れ確認する必要がある**。Terraformのmockは、Cognitoの動作の証明ではない。ここでは、clientのリポジトリ/製品の変更も、実際のChromeのloginもしていない。

承認された合成IDだけを使い、v2のCRUD全体と競合の応答、他のownerへのアクセスがないこと、元画像のchecksum/MIME、独立した15分の署名付きURL、token/URL/bodyをログに出さないことを検証する。削除するのはそれらの試験項目だけとし、最新のETagを使う。userの無効化/logoutの後も、APIへのアクセスが約5分、新しく発行された画像URLがさらに15分（最大約20分）残ることがある。キャッシュされたofflineのbyteは別である。自動のsmokeでは、ownerを無効化したり、liveの項目を削除したりすることは決してしてはならない。

最後に、移行/公開、毎日のcleanup/手動syncのalias、alarm、2つのaliasによるrollback、新しいtableへの実際のPITRリハーサルを、別途承認する。3つのtable/counter/job/画像のすべて、60日のsource versionの失効より前に保存した現行のコピー、既知のconsoleのidentity/明示的なremap、未公開のgate、制御されたtable参照の切り替え、その後の一時リソースの清掃を検証する。PITRはCognitoのcredentialを復元しない。コードのrollbackはデータを復元しない。実際の移行、公開、画像の削除、Cognitoの操作、PITR、rollbackは、いずれも実行していない。費用は予算の入力値のままであり、実測の請求額やlatencyはない。過去のaudit/承認の資料は、過去の記録のままである。

## 2026-10-10 追記: 正式ローカルE2Eの結果

以下はローカルのFloci上の実測であり、実AWS・Chrome・PITRの受け入れではない。上の記録と、旧19タスクの検証結果は、そのまま保持する。手順は[正式E2E手順](formal-e2e-README.md)、結果は[結果](formal-e2e-results.md)、制限は[限界](formal-e2e-limitations.md)にある。

- 全suite実行（run `e2e-90d3b042-447f-41ed-a28f-44dac22b54a4`、833秒、期限は実行75分と回収15分）は、268件中240件が合格、失敗1件（API-09/id-percent、Floci側の二重decode、未解決）、未実行24件（layer I。offline試験で実施）、未対応3件（OBS-04、AUTH-11のhosted revoke、IMG-09）である。したがって正式E2Eは未完了である。
- 回収は18/18で、errors 0、leaks 0。所有リソース83件の不在を独立した読み取りで確認した。
- S3のTLS強制（SecureTransport）は、policyの保持を読み戻しただけで、強制は未検証である。署名と期限の強制も未検証である。
- 実AWSでの検証（IAMの強制、PITRの実復旧、Chromeの実login、GHA、本番Terraformの適用）は、この追記の対象外であり、別途の承認が必要である。

## 2026-10-11 追記: 正式ローカルE2Eの再実行（Floci refresh.7）

2026-10-10の追記（refresh.6の実行）は当時の記録として残す。以下は、ローカルのFlociでの最新の実測である。

- 全suite実行（run `e2e-4e5b822a-19de-46c4-8f1e-bbc3b27d8bc6`、821秒）は、268件中241件が合格、失敗0件、未実行24件（layer I。offline試験で実施）、未対応3件（OBS-04、AUTH-11のhosted revoke、IMG-09）である。前回失敗したAPI-09/id-percentは、refresh.7で合格した。
- 回収は18/18で、errors 0、leaks 0。所有リソース83件の不在を独立して確認した。
- layer Iがliveで実行されず、未対応3件があるため、正式E2Eはliveの実行としては完了と言えない。S3のTLS・署名・期限の強制は未検証のままである。
- Floci patchのJava回帰試験は、Temurin JDK 25で実行し、refresh.7の対象11クラスが300/300合格した。上流のDocker依存の試験は実行していない。
- 実AWS、IAMの強制、PITR、Chromeは対象外であり、別途の承認が必要である。

補記（2026-10-12）: `npm test` は、offline試験の後にFlociの全suite（約15分、`artifacts/` にevidenceを書く）を実行する。上の「READMEの検証ブロック」でFlociが使えない場合は、`npm test` の代わりに、Floci無しの `npm run test:offline` を実行する。

## 2026-10-12 追記: 正式E2Eの完了

2026-10-12のユーザー判断（layer Iは、同じrunの中で、対応するoffline試験の実測から判定する）の基準で、正式E2Eは完了した。`npm test`（HEAD 07744fc、exit 0、974秒）のrun `e2e-d5c47097-978c-4c02-8270-49d047e2783e` は、268件中265件が合格、失敗0、未実行0、未対応3（OBS-04、AUTH-11のhosted revoke、IMG-09。測定済みの互換性調査）、cleanup 18/18（errors 0、leaks 0）、`complete` は真だった。layer別は、E 228 pass、L 13 pass と 3 unsupported、I 24 pass（offline）。layer Iの24件は、監査で全件が有効と判定された。全case一覧は[結果](formal-e2e-results.md)にある。

残る限界: 未対応3件はFlociでの測定結果であり、実AWS、IAMとTLSの強制、PITR、Chromeは実行していない。上流FlociのDocker依存の試験は実行していない。このrunはユーザーの未commitの `src/api/event.ts` を含む。Flociはエミュレーターであり、AWSではない。上の2026-10-11までの記述（layer Iがnot-run、完了と言えない）は、当時の基準の記録として残す。

## 2026-10-12 追記（その2）: 未commitの変更を含まないrun

HEAD 6daf48b（ユーザーがnull-body修正をcommit済み）の `npm test`（869秒、exit 0）の run `e2e-da96a6b1-9b45-4a5c-beba-12ce628eabbc` は、268件中265件が合格、失敗0、未実行0、未対応3、cleanup 18/18（errors 0、leaks 0）、`complete` は真、ZIPの `dirtyPaths` は空だった。これはREL-01を加える前の時点の主たる結果で、未commitの変更を含まない。上の追記のrun（e2e-d5c47097）は、未commitの `src/api/event.ts` を含んでいた。実AWS、IAMとTLSの強制、PITR、Chromeは対象外のままで、別途の承認が要る。結果は[結果](formal-e2e-results.md)、判断の経緯は[判断の記録](formal-e2e-decisions.md)にある。

## 追記: release custodyのcaseを加えたrun

run `e2e-1c662e0f-5687-4c77-858f-e39110c24109`（HEAD d6fc5c0、`npm test`、exit 0、1043秒）は、release custodyのcase（REL-01の2件）を加えたregistry全270件を選び、267件が合格、失敗0、未実行0、未対応3（OBS-04、AUTH-11のhosted revoke、IMG-09）、cleanup 20/20（errors 0、leaks 0）、`complete` は真だった。offline部分はruntime 188、operations 74、delivery 142、integration 184、harness 115がすべて合格した。REL-01の2件（custodyの往復と条件付き書き込み）は合格し、Flociは同じkeyへの2回目の書き込みを `If-None-Match` で拒否した。TF-03/settingsは、custody bucketの設定とlifecycleの読み戻しを含めて合格した。これが現在の主たる結果である。上のe2e-da96a6b1は、REL-01を加える前の記録として残す。bucket policyとIAMの強制、lifecycleによる実際の削除、`deploy.yml` のGHAでの実行、実AWSでのbootstrapの更新とdeployは実行しておらず、別途の承認が要る。限界は[限界](formal-e2e-limitations.md)、結果は[結果](formal-e2e-results.md)にある。
