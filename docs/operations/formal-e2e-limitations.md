# 正式E2E 既知の限界と未検証事項

[結果](formal-e2e-results.md)の数値の読み方を補う。ここに書いたものは、合格として扱わない。2026-10-10時点の記録である。

## 未解決の失敗（open item）

| 項目 | 内容 | 状態 |
| --- | --- | --- |
| API-09/id-percent | `%25` を含むIDの読み戻しがFlociの500になる。host filterが保存したpathを、後続の `@PreMatching` filter（DLM、ResourceExplorer2、EmrServerless、AppConfig、GlobalCors）が `UriInfo.getPath()` で再度decodeし、末尾の `%` で例外になる。診断は[診断記録](../../.superpowers/sdd/2026-10-08-reminder-server-formal-e2e/api09-percent-diagnosis.md)（ソース読解、確度約90%、liveの診断runなし） | Floci側の問題。refresh.7（host filterで残りのpathの `%` を `%25` にしてから組み立てる案）はユーザーの承認待ち。承認・適用・再実行までは失敗のまま |
| API-09/id-slash（`a%2Fb`） | refresh.5では失敗だったが、refresh.6で合格した | 解決 |

これが解決しない限り、正式E2Eの完了とは言えない。

## Floci patchの検証の欠落

Floci本体へのパッチ（refresh.2のSourceAccount、refresh.3のListVersionsByFunction順序、refresh.4のCloudWatch alarm percentile項目、refresh.5のHTTP API CORSとraw path、refresh.6のhost経由のraw path）に付けたJava回帰試験は、一度もcompileも実行もしていない。開発コンテナにJDKが無く、Dockerfileが `-DskipTests` でbuildするためである。パッチの動作は、live runでの観測だけで確認している。JDKの導入とJava試験の実行は、ユーザーが検討中である。

## 測定の結果、未対応と判明した項目（unsupported）

| case | 内容 |
| --- | --- |
| OBS-04/gateway-delivery | stageのaccessLogSettingsは読み戻せるが、Flociはgateway log groupへ配信しない（event 0件）。API結果ログと清掃ログの配信は別caseで合格した |
| AUTH-11/hosted-revoke-endpoint | Flociにhosted `/oauth2/revoke` のrouteが無く、S3のcatch-all 400が返る。失効自体はRevokeToken APIで確認した |
| IMG-09/signature-enforcement | 改ざんした署名と期限切れのURLを、Flociは拒否しない。S3の署名・期限の強制は検証できていない。対照は正常に取得できる |

互換性調査としては、実際の採否と制限が記録されたので完了である。各機能の動作確認とは区別する。

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
- ZIPは、run時点のworking treeから作る。今回のrunには、ユーザーの未commitのnull-body修正（`src/api/event.ts`）が含まれる。
- `infra:check` は、このsandboxではTerraform initがprovider installで失敗した。3rootの検証としては数えない。
- Gateway v2のaccess logとScheduler、Terraformの一部のread APIは、Flociの実装に依存する。read APIが501を返す場合は、独立した読み取りで確認したときだけunsupportedとし、それ以外は失敗とする。
- 画像のS3 URLはBearer相当のcapabilityである。URLを知る者の共有は、別の契約である。
- 費用は変更していない。東京の総額は、未取得の単価で再計算していない。
