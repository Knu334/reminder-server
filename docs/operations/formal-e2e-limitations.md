# 正式E2E 既知の限界と未検証事項

[結果](formal-e2e-results.md)の数値の読み方を補う。ここに書いたものは、合格として扱わない。2026-10-10〜11の記録である。

## 解決済みの失敗

| 項目 | 内容 | 状態 |
| --- | --- | --- |
| API-09/id-percent | refresh.6では、`%25` を含むIDの読み戻しがFlociの500になった。host filterが保存したpathを、後続の `@PreMatching` filterが `UriInfo.getPath()` で再度decodeし、末尾の `%` で例外になるためである | refresh.7（host filterで `%` を `%25` にしてから組み立てる）で解決。e2e-4e5b822aでAPI-09の全21件が合格 |
| API-09/id-slash（`a%2Fb`） | refresh.5では失敗だったが、refresh.6で合格した | 解決 |

refresh.7までのrunには、失敗のcaseはなかった。ただし、そのrunではlayer Iを実行していなかった。layer Iは、2026-10-12のユーザー判断により、同じrunの中でoffline試験の実測から判定する。この判定を含むFlociでの再実行は実施済みで、結果は[結果](formal-e2e-results.md)にある（2026-10-12、run e2e-d5c47097）。下記の未対応・未実施の項目は、引き続き合格として扱わない。

## Floci patchの検証

Floci本体へのパッチ（refresh.2のSourceAccount、refresh.3のListVersionsByFunction順序、refresh.4のCloudWatch alarm percentile項目、refresh.5のHTTP API CORSとraw path、refresh.6のhost経由のraw path、refresh.7の `%25` の再encode）のJava回帰試験は、Temurin JDK 25.0.1+8と `./mvnw` で実行した（上流17c99047にパッチを適用したclone）。

- refresh.6のパッチ: パッチの回帰11クラスが299件中1件失敗した（`100%25` が200ではなく500）。API-09/id-percentの診断どおりの失敗である。
- refresh.7のパッチ: 同じ11クラスが300/300合格した。apigateway・apigatewayv2・coreのpackageは1853件で失敗0（skip 6）、checkstyle:checkも成功した。
- 未実施: 上流のDocker依存のLambda・WebSocket試験は開発コンテナで動かせないため、`./mvnw test` の全件実行はしていない。

## 測定の結果、未対応と判明した項目（unsupported）

| case | 内容 |
| --- | --- |
| OBS-04/gateway-delivery | stageのaccessLogSettingsは読み戻せるが、Flociはgateway log groupへ配信しない（event 0件）。API結果ログと清掃ログの配信は別caseで合格した |
| AUTH-11/hosted-revoke-endpoint | Flociにhosted `/oauth2/revoke` のrouteが無く、S3のcatch-all 400が返る。失効自体はRevokeToken APIで確認した |
| IMG-09/signature-enforcement | 改ざんした署名と期限切れのURLを、Flociは拒否しない。S3の署名・期限の強制は検証できていない。対照は正常に取得できる |

互換性調査としては、Flociが対応しているかどうかと、その制限が記録されたので完了である。各機能の動作確認とは区別する。

## 実施していないこと

- 実AWS上の動作。全てローカルのFlociである。本番相当の同等性は主張しない。
- IAMの強制。設定gateはroleやpolicyの内容を読み戻して期待と比較したが、Flociは権限の判定をしない。
- TLSの強制。S3のDeny policy（SecureTransport）の保持（policy-present）は読み戻したが、評価されるか（enforcement）は未検証である。HTTPの成功は強制の証拠にならない。
- PITR（35日）の実復旧。設定値の確認と、合成データによる復旧手順の試験にとどまる。
- Chromeの実ブラウザによるログインと拡張機能の動作。
- GHAの実行、本番Terraformの変更、実Cognitoの本番userの操作、デプロイ、移行。
- 30日の絶対期限、24時間や60日、15分のURL期限を実時間で待つ検証。境界は合成時刻のI/Uで確認した。

## 結果の読み方に関わる制約

- layer Iの24件は、liveの環境では実行できない（Floci上に再現できない故障の注入や合成時刻を使う）。そのため、2026-10-12のユーザー判断で、同じrunの中でoffline試験を実行し、その実際の結果が有効（対応する試験がすべて実行され、すべて合格）なときだけ、他のcaseと同じに数える。実行されなかった、または失敗した場合は、fail（`offline-test-missing`、`offline-test-failed`、`offline-run-failed`）であり、passにはしない。対応は[結果](formal-e2e-results.md)にある。これは実AWSやFlociでの観測ではない。2026-10-11までのrun（refresh.7を含む）の `complete` は、この判断より前の基準で、layer Iがnot-runだった。
- 対応表のOPS-05とTF-04には、専用のcaseがない（TF-01、TF-03のcaseとoffline試験が担う）。AUTH-08、OBS-01、SAFE-04も専用のcaseを持たず、既存の回帰とAに残る。
- 清掃ログの「60秒以内」は、最後の入力から60.5秒の観測窓と、その後の有界な完了pollである。最悪で約120.5秒かかる。
- ZIPは、run時点のworking treeから作る。2026-10-11時点の最新のrun（e2e-4e5b822a。2026-10-12のe2e-d5c47097も同様）にも、ユーザーの未commitのnull-body修正（`src/api/event.ts`）が含まれる。
- `infra:check` は、このsandboxではTerraform initがprovider installで失敗した。3rootの検証としては数えない。
- Gateway v2のaccess logとScheduler、Terraformの一部のread APIは、Flociの実装に依存する。read APIが501を返す場合は、独立した読み取りで確認したときだけunsupportedとし、それ以外は失敗とする。
- 画像のS3 URLはBearer相当のcapabilityである。URLを知る者の共有は、別の契約である。
- 費用は変更していない。東京の総額は、未取得の単価で再計算していない。


## 2026-10-12 追記: 完了の判定と残る限界

2026-10-12のユーザー判断（layer Iは、同じrunの中で、対応するoffline試験を実行して、その実際の結果から判定し、有効なら他のcaseと同じに数える）の基準で、正式E2Eは**完了**した。run `e2e-d5c47097-978c-4c02-8270-49d047e2783e`（HEAD 07744fc、`npm test`、exit 0）は、268件中265件が合格、失敗0、未実行0、未対応3、`partial` は偽、`complete` は真である。layer Iの24件は、別の監査で全件が有効（VALID）と判定された。これより上の記述（layer Iがnot-runで完了と言えない、など）は、2026-10-11までの基準での記録として残す。

完了とは言っても、次の限界は残る。合格として扱わない。

- 未対応3件（OBS-04のGateway access log配信、AUTH-11のhosted `/oauth2/revoke`、IMG-09のS3の署名・期限の強制）は、Flociでの測定結果であり、互換性調査として完了しているだけである。各機能の動作は確認していない。
- 実AWS、IAMの強制、TLSの強制、PITRの実復旧、Chromeの実ブラウザ、GHAの実行は実行していない。Flociはエミュレーターであり、AWSではない。
- 上流FlociのDocker依存の試験（Lambda、WebSocketなど）は、開発コンテナで動かせないため実行していない。
- このrunのZIPは、ユーザーの未commitの `src/api/event.ts`（null-body修正）を含む。`tests/runtime/api.test.ts` と `tests/runtime/boundaries.test.ts` の未commitの変更も同様に、commitされていない。
- layer Iの24件は、Floci上の観測ではなく、合成のfakeとfault注入によるoffline試験の実測である。
- `npm run infra:check` は、このsandboxで3 rootの検証が成功していない（2026-10-10の記録のまま）。同じ3 rootの構築はlive runで成功している。


## 2026-10-12 追記（その2）: 未commitの変更を含まないrun

run `e2e-da96a6b1-9b45-4a5c-beba-12ce628eabbc`（HEAD 6daf48b、`npm test`、exit 0、869秒）は、268件中265件が合格、失敗0、未実行0、未対応3、`complete` は真で、ZIPの `dirtyPaths` は空だった。このrunには、未commitの変更が含まれない。上の「ユーザーの未commitの `src/api/event.ts` を含む」という限界は、e2e-ba02c537以前のrun（e2e-d5c47097、e2e-4e5b822a）についての記録であり、e2e-da96a6b1には当てはまらない（null-body修正は、ユーザーが6daf48bでcommitした）。その他の限界（未対応3件、実AWS・IAM・TLSの強制・PITR・Chromeの未実行、上流FlociのDocker依存試験の未実行、Flociがエミュレーターであること、layer Iが合成のfakeによるoffline試験の実測であること）は変わらない。判断の経緯は[判断の記録](formal-e2e-decisions.md)にある。

## 2026-10-12 追記（その3）: GHAでの実行

ユーザーの判断により、正式E2Eを `main` へのpushごとにGHAで実行する（`.github/workflows/floci-e2e.yml`、手順は[README](formal-e2e-README.md#ciでの実行)）。上の「GHAの実行は実行していない」は、デプロイ用のworkflowと本番の受け入れについての記述として残る。確認run（GHA run 38216808905、E2E run `e2e-8559f77c`）は、268件中265件が合格、失敗0、未実行0、未対応3、`complete` は真だった。

- CIのFlociはJVM版（`2.2.0-local-refresh.7-jvm`）である。sourceとpatchはnative版と同じだが、native版に固有の問題は検出できない。
- CIのrunもFloci上の観測であり、実AWS、IAMの強制、TLSの強制の証拠ではない。未対応3件も変わらない。

## 追記: release custodyのcaseを加えたrun

run `e2e-1c662e0f-5687-4c77-858f-e39110c24109`（HEAD d6fc5c0、`npm test`、exit 0、1043秒）は、release custodyのcase（REL-01の2件）を加えたregistry全270件を選び、267件が合格、失敗0、未実行0、未対応3（OBS-04、AUTH-11のhosted revoke、IMG-09）、cleanup 20/20（errors 0、leaks 0）、`complete` は真だった。offline部分はruntime 188、operations 74、delivery 142、integration 184、harness 115がすべて合格した。REL-01の2件（custodyの往復と条件付き書き込み）は合格し、Flociは同じkeyへの2回目の書き込みを `If-None-Match` で拒否した。TF-03/settingsは、custody bucketの設定とlifecycleの読み戻しを含めて合格した。以前のrun（e2e-da96a6b1など）は、その時点の記録として上に残す。上の限界（未対応3件、実AWS・IAM・TLSの強制・PITR・Chromeの未実行、上流FlociのDocker依存試験の未実行、Flociがエミュレーターであること、layer Iが合成のfakeによるoffline試験の実測であること）は変わらない。

release custodyについては、次の限界が加わる。

- custody bucketのbucket policy（HTTPSの強制、`If-None-Match: *` の無い書き込みの拒否、削除の拒否）は、設定されていること（policy-present）だけを読み戻した。Flociでも実AWSでも、強制は確かめていない。prefixごとのroleの権限の強制も同様である。
- lifecycleは、規則の読み戻しだけを確かめた。lifecycleによる実際の失効と削除は実行していない。
- `REL-01/custody-conditional-write` は、2回目の書き込みの拒否（412、または409 ConditionalRequestConflict）で合格したが、どちらのstatusだったかは文書に記録していない。実AWSのS3での動作の証拠でもない。
- `deploy.yml` のGHAでの実行、実AWSでのbootstrapの更新とcustody bucketの作成、S3コンソールでのレビューの手順は実行していない。
