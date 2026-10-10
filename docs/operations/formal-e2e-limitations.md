# 正式E2E 既知の限界と未検証事項

[結果](formal-e2e-results.md)の数値の読み方を補う。ここに書いたものは、合格として扱わない。2026-10-10〜11の記録である。

## 解決済みの失敗

| 項目 | 内容 | 状態 |
| --- | --- | --- |
| API-09/id-percent | refresh.6では、`%25` を含むIDの読み戻しがFlociの500になった。host filterが保存したpathを、後続の `@PreMatching` filterが `UriInfo.getPath()` で再度decodeし、末尾の `%` で例外になるためである | refresh.7（host filterで `%` を `%25` にしてから組み立てる）で解決。e2e-4e5b822aでAPI-09の全21件が合格 |
| API-09/id-slash（`a%2Fb`） | refresh.5では失敗だったが、refresh.6で合格した | 解決 |

現在、失敗のcaseはない。ただし、下記の未対応・未実施の項目と、layer Iがliveで実行されない点により、正式E2Eはliveの実行としては完了と言えない。

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

- layer Iの24件は、live実行ではnot-runのまま残る（既存のharnessの設計）。offline試験で実施し、[結果](formal-e2e-results.md)に対応を記録した。そのため `complete` はliveの実行だけでは真にならない。この扱いを変える場合は、harnessの設計判断が必要になる。
- 対応表のOPS-05とTF-04には、専用のcaseがない（TF-01、TF-03のcaseとoffline試験が担う）。AUTH-08、OBS-01、SAFE-04も専用のcaseを持たず、既存の回帰とAに残る。
- 清掃ログの「60秒以内」は、最後の入力から60.5秒の観測窓と、その後の有界な完了pollである。最悪で約120.5秒かかる。
- ZIPは、run時点のworking treeから作る。最新のrun（e2e-4e5b822a）にも、ユーザーの未commitのnull-body修正（`src/api/event.ts`）が含まれる。
- `infra:check` は、このsandboxではTerraform initがprovider installで失敗した。3rootの検証としては数えない。
- Gateway v2のaccess logとScheduler、Terraformの一部のread APIは、Flociの実装に依存する。read APIが501を返す場合は、独立した読み取りで確認したときだけunsupportedとし、それ以外は失敗とする。
- 画像のS3 URLはBearer相当のcapabilityである。URLを知る者の共有は、別の契約である。
- 費用は変更していない。東京の総額は、未取得の単価で再計算していない。
