# 正式E2Eに伴う画像保持・APIログの費用判断

2026-10-08。設計・計画のレビュー資料。製品コード、AWS設定、Flociリソースは変更していない。
利用見込みはユーザー回答の「東京リージョン、月100リクエスト未満」。比較では100回/月を使う。

## 推奨する方針

画像の過去versionは費用が発生するが、現行の60日保持を維持する。DynamoDBの35日分のPITRから
復旧した参照先画像を確保するためで、想定利用量では保持短縮による節約は小さい。
APIには成功・失敗の結果ログを1呼び出し1件追加する。本文や画像を含めず、既存の30日保持を使う。

追加件数はAPI Lambdaの実呼び出し数を基準とする。Gatewayで拒否された要求やS3への直接取得では、API結果ログを追加しない。
正常・異常ケースのログ期待は各ケースで登録し、suite末尾にまとめて照合する。既存のGateway/清掃ログの項目や保持期間を増やさない。Floci HTTP API v2のGateway配信は互換性調査であり、API/清掃Lambdaの実配信は必須とする。
[設計案](../superpowers/specs/2026-10-08-reminder-server-formal-e2e-design.md)と
[E2E計画案](../superpowers/plans/2026-10-08-reminder-server-formal-e2e.md)、[独立APIログ計画案](../superpowers/plans/2026-10-08-reminder-server-api-result-logging.md)に実装範囲と順序を定義する。

## S3の保存費

S3は各versionの全bytesを課金対象とする。清掃時のDeleteObjectはdelete markerを作るため、
過去versionの保存費は続く。差分だけの課金ではない。
[AWSのversioning説明](https://docs.aws.amazon.com/AmazonS3/latest/userguide/Versioning.html)

現行設定は `infra/platform/production/storage.tf` のversioning有効・非現行version60日である。
非現行になってから日数を数える。lifecycle期限で永久削除の対象となり、期限後の実処理は非同期である。
[AWSのlifecycle説明](https://docs.aws.amazon.com/AmazonS3/latest/userguide/lifecycle-expire-general-considerations.html)

2026-02-04のAWS公式記事は東京のS3 Standard保存単価をUSD0.025/GB・月としている。
以下はこの参考単価による概算であり、現在の請求単価を直接取得した見積書ではない。
円換算には既存見積もりと同じ予算用仮定USD1=150円を使う。現在の為替レートではない。
[AWS公式記事](https://aws.amazon.com/jp/blogs/news/cloudwatch-get-telemetry-data-logs/)

| 保存量の仮定 | 60日保持による過去versionの平均保存量 | 追加保存費の目安/月 |
| --- | --- | --- |
| 月100回すべてで100KiB画像を差し替え・削除 | 約20MiB | 約0.07円 |
| 月100回すべてで上限1MiB画像を差し替え・削除 | 約200MiB | 約0.73円 |
| 過去versionが平均1GiB存在 | 1GiB | 約3.75円 |

これは月ごとの変更量が一定になった場合の近似で、過去versionだけの費用である。
現行画像、S3リクエスト、他サービス、税は含まない。初期移行・過去の蓄積・失敗upload・再試行・外部操作では
API回数だけから保存量を限定できない。delete markerのkey分の保存費や清掃までの待機分も別にある。
製品の128MiB上限は現行画像の集計であり、bucketの全versionの上限ではない。

| 案 | 保存費への効果 | 復旧への影響 | 判断 |
| --- | --- | --- | --- |
| 60日維持 | 上記の費用 | PITR35日との間に25日の余裕 | 推奨 |
| 40日へ短縮 | 定常状態の過去version費用が約1/3減る | 余裕が5日になる | 想定利用量では節約より復旧の余裕を優先 |
| 清掃時に永久削除 | 該当versionの保存費をなくす | 過去DBの参照先を失い、画像付き復旧ができなくなる | 採らない |

保持方針は見直したうえで、今回は設定を変更しない案とする。

## API結果ログの追加費用

追加ログを配信時の情報込みで1KiB/呼び出しと仮定すると、100回/月で約100KiB、約0.0001GiB/月。
JSON本体は512bytes以内とし、保存期間は30日。取り込み量と保存量はそれぞれ課金対象になる。
東京の保存参考単価はUSD0.033/GB・月で、圧縮を考慮せず100KiBを1か月保存しても約0.0005円。
[AWS公式記事](https://aws.amazon.com/jp/blogs/news/cloudwatch-get-telemetry-data-logs/)

東京の取り込みの現在単価は地域別料金表から取得できなかったため、確定単価として掲載しない。
取り込み単価を比較用にUSD1/GBと仮定しても、追加取り込みは約0.015円/月。
これはAWSの提示単価ではなく、費用の規模を見る計算である。追加保存費と合わせても約0.02円/月で、
この利用量ではAPI結果ログを見送る理由になる増額とは考えない。
実際の配信情報・ログ量・料金で変わるため、請求額の上限保証ではない。

CloudWatchにはLogsの無料枠があるが、同じアカウントの他用途と共有するため、必ず無料とは扱わない。
今回の判断は無料枠を使わない概算に基づく。
[CloudWatch料金表](https://aws.amazon.com/cloudwatch/pricing/)

APIの既存Lambdaシステムログ・Gatewayログ・日次清掃ログは、この追加量に含めていない。
既存の製品費用見積もりにはログ量の予算があるため、全体費用に今回の概算を重ねて加算しない。
新しいcustom metric、alarm、転送先、常時クエリは設けず、結果のJSONだけを既存log groupへ出す。

## 実装・試験の範囲

APIの外側のhandlerに結果ログを追加し、成功、入力拒否、503、初期化失敗、cold/warm invocationで
各1件となることを確認する。固定のoperation/status/code、制限したrequest ID、durationだけを残す。
APIからCloudWatch SDKで送信せず、既存の安全なlogging helperとLambdaのログ配信を使う。
ログ失敗の扱いもテストし、結果ログのために成功応答を別のHTTP応答へ変えない。

E2E用にはCloudWatch Logs読取clientをdevDependencyへ追加する。これはローカル検証用で、
APIの本番ZIPに新しいLogs clientや課金処理を加えるものではない。
API結果ログは独立計画として承認・実装・検証・コミットする。正式E2Eは、その完了とE2E設計・計画の承認後にSDDで実装・実行・レビューする。費用仮定と保持方針は今回の構成変更でも変えない。
