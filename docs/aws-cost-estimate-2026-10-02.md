# reminder-server AWS構成の費用試算

確認日: 2026-10-03。対象: [AWS設計書](superpowers/specs/2026-10-02-reminder-server-aws-design.md)の**productionのみ・本人1人**の構成。Cognito、HTTP APIの標準JWT Authorizer、API/清掃Lambda、DynamoDBの3表と清掃GSI、画像/配布ZIP用S3、CloudWatch、Terraform state、EventBridge Schedulerを含める。ZIPでLambdaへ配布するためECRを作らない。常設dev環境、認証Lambda、GHAでの定期清掃も設けない。

これは入力条件を置いた参考モデルで、実請求・費用上限の保証ではない。リージョン未指定のため、公式資料の料金例を確認できた**US East (N. Virginia)、us-east-1**を参考にする。東京リージョンの試算ではない。地域別Price Listの直接取得は通信制限で実行できなかったため、構築先リージョン決定後にAWS Pricing CalculatorまたはPrice Listと実測で更新する。

円換算は説明用に1 USD = 150円、税別とする。Cognito MAUとSchedulerは利用可能な共有無料枠内という条件で0とし、他サービスの無料枠・割引・期間限定クレジットは基本表から差し引かない。転送100 GB/月の無料枠だけを追加反映した列も示す。他のシステムと共有する無料枠に余裕がなければ該当分を加算する。

## 1. 利用量とモデルの前提

月は30日。保存量は月平均、ログ保持30日・旧画像60日保持が定常状態になった月を扱う。AWS料金表のGBを本モデルでは1,073,741,824 bytesとして計算する。

| 入力 | 1万API/月 | 10万API/月 | 比較用の100万API/月 |
| --- | ---: | ---: | ---: |
| productionの認証対象API回数 N | 10,000 | 100,000 | 1,000,000 |
| 有効画像 I | 128 MiB = 0.125 GB | 同左 | 同左 |
| DynamoDBベース3表の平均GB B | 0.1 | 同左 | 同左 |
| 日次清掃の通常実行回数 C | 30 | 同左 | 同左 |
| 清掃Lambda平均課金時間の予算 | 60秒/実行・512 MiB | 同左 | 同左 |

- Nには一覧、項目取得・変更、画像URL発行、If-Match取得のための項目GETを含める。画像S3 GETは別に数え、同期1回をAPI1回とは扱わない。認証エラー、health/preflight、初回移行・復旧は通常量に含めない。
- APIは512 MiB・平均課金時間300 msの予算で、`0.15 GB-s/API`。標準JWT AuthorizerはLambdaを起動せず、通常API1回にAPI Lambda1回。日次清掃のC回は別に加算する。100万APIなら約1,000,030 Lambda呼び出し/月で、失敗時の再試行・手動清掃は追加となる。
- CognitoはEssentialsの直接認証で、本人1人を想定する。同じ利用者のログイン・更新回数ごとにMAUを増やさない。管理操作によるMAUとアカウント/組織共有の10,000 MAU/月無料枠を確認し、利用可能な枠内で0とする。M2Mのトークン発行料金は適用しない。メール/SMS等は別見積もり。
- Schedulerは日次schedule1つでC回。共有する月1,400万回の無料枠に余裕がある条件で0とする。枠がない場合、米国公開料金例の$1.00/100万回ならC=30で$0.00003/月を追加する。Scheduler料金にLambda・データ操作の費用は含まれない。
- APIの読み取り80%、変更20%。1 KiB以内のリマインダー・所有者カウンターの2項目トランザクションなら、各項目2 WRUで`0.2 × 2 × 2 = 0.8 WRU/API`。全APIのレートカウンター1 WRU、公開状態の強い読み取り1 RRU、項目/一覧・画像job/GSI・条件失敗・内部再試行の予算を含め、API分を平均4 RRU + 4 WRU/APIとする。画像変更ではトランザクション項目が増える。係数は実測や最悪上限ではない。
- 清掃の候補数を画像差し替えの`K = 0.05 N/月`と置く。DynamoDBの清掃分は、日次検索/checkpoint等を24 RRU + 24 WRU/実行、候補の再確認・状態変更・GSI等を2 RRU + 5 WRU/候補としてAPI分とは別に予算化する。実際のページ数・候補・lease・再試行・失敗アップロードは実測して更新する。
- ベース3表0.1 GBはcounter/job/削除記録を含む独立した予算入力で、保存量の上限保証ではない。通常保存はGSI等20%を加えた`1.2 B`、PITR対象は`B`と仮定する。
- 画像平均100 KiB、取得`0.5 N`回、保存/差し替え`0.05 N`回。月間画像保存GBを`U = 0.05 N × 100 KiB / 2^30`とし、旧version60日分`2 U`と清掃待ち24時間分`U/30`を加える。S3保存量は`I + (2 + 1/30) U`。日次起動を待つ追加滞留や再試行で24時間を超える分は基本表に含めず、後述の感度と実測で加算する。有効画像128 MiB上限に旧versionの全保存量が収まるとは扱わない。
- S3操作は画像GET `0.5 N`、PUT `0.05 N`に加え、清掃照合のHEADを候補ごと1回`K`としてGET単価で予算化する。署名URL発行そのものにS3 GETを付けない。通常のDELETEはS3公開料金上無料で、delete marker・旧versionの保存費は残る。[S3料金](https://aws.amazon.com/s3/pricing/)
- 100 KiB画像のBASE64入力が512 KiB以内と仮定し、HTTP API1回を1課金単位で計算する。上限1 MiB画像では512 KiB刻みの課金単位が増えるので再計算する。
- API応答3 KiB、画像はS3直配信。転送量`T = (0.5 N × 100 KiB + N × 3 KiB)/2^30`。ログはAPI1回3 KiBと清掃1実行1 KiBの予算、保存時圧縮比20%、30日保持とする。大量の画像候補を1件ずつログへ出さない。
- CloudWatchはproductionに9個の単一メトリクスの標準アラーム。CleanupIncomplete/CleanupHeartbeatの独自メトリクス2個は日次の1時間/日だけ発行する前提で、`2 × $0.30 × 30/720 = $0.025/月`。観測用操作・ログ検索を$0.015/月の予算として加え、合計$0.940/月。再試行・手動発行・追加dimensionは増額し得る。通知先は含めない。

## 2. 計算に使った単価

公開料金例を用いる参考値。料金改定・リージョン・段階料金は構築前に再確認する。

| 課金対象 | USD単価 | 一次資料 |
| --- | ---: | --- |
| Cognito Essentials・直接認証 | 利用可能な共有無料枠内で$0。無料枠超過の料金例は$0.015 / MAU | [Cognito料金・MAUの計算](https://aws.amazon.com/cognito/pricing/) |
| EventBridge Scheduler | 利用可能な共有無料枠の月1,400万回以内で$0。米国料金例は超過$1.00 / 100万回 | [EventBridge料金](https://aws.amazon.com/eventbridge/pricing/) |
| Lambdaリクエスト | $0.20 / 100万回 | [Lambda料金](https://aws.amazon.com/lambda/pricing/) |
| Lambda x86 duration | $0.0000166667 / GB-s | [Lambda料金例](https://aws.amazon.com/lambda/pricing/) |
| HTTP API・最初の段階 | $1.00 / 100万課金単位 | [API Gateway料金](https://aws.amazon.com/api-gateway/pricing/) |
| DynamoDB Standardオンデマンド読み取り | $0.125 / 100万RRU | [DynamoDB料金例](https://aws.amazon.com/dynamodb/pricing/) |
| 同書き込み | $0.625 / 100万WRU | 同上 |
| DynamoDB保存 | $0.25 / GB-month | 同上 |
| DynamoDB PITR | $0.20 / GB-month | 同上 |
| S3 Standard保存 | $0.023 / GB-month | [AWS公式ソリューションの料金表](https://docs.aws.amazon.com/solutions/latest/automated-security-response-on-aws/cost.html) |
| S3 GET | $0.0004 / 1,000回 | 同上 |
| S3 PUT/LIST | $0.005 / 1,000回 | 同上 |
| インターネット転送・最初の有料段階 | $0.09 / GB | [S3の米国東部料金例](https://aws.amazon.com/blogs/industries/hosting-qr-code-restaurant-menus-on-amazon-s3/)、[AWS転送料金表](https://aws.amazon.com/ec2/pricing/on-demand-backup/) |
| CloudWatch Logs取り込み | $0.50 / GB | [CloudWatch料金](https://aws.amazon.com/cloudwatch/pricing/) |
| 同保存・圧縮後 | $0.03 / GB-month | 同上 |
| 標準アラーム・単一メトリクス | $0.10 / 月 | 同上 |
| 独自メトリクス | $0.30 / 月、発行時間で按分 | 同上 |

S3画像・配布ZIP・stateはSSE-S3、DynamoDBは既定の暗号化とし、customer managed KMS keyを追加する場合の料金はこのモデルへ追加する。ZIPの依存監査・SBOMはCIで行い、ECRスキャンは使用しない。追加の有料検査サービスを使う場合は別見積もりにする。S3 delete marker・旧versionは保存量に含め、清掃による容量の即時ゼロ化は仮定しない。

## 3. 月額の結果

N/C/K/B/I/U/Tは上記、Lは清掃分を含むログ取り込みGB。以下は通常月で再試行・手動実行を含めない計算式。

```text
API Lambda      = N / 1,000,000 × 0.20 + 0.15 N × 0.0000166667
清掃Lambda      = C / 1,000,000 × 0.20 + 0.5 × 60 C × 0.0000166667
HTTP API        = N / 1,000,000 × 1.00
API DynamoDB    = (4 N × 0.125 + 4 N × 0.625) / 1,000,000
清掃DynamoDB    = ((24 C + 2 K) × 0.125 + (24 C + 5 K) × 0.625) / 1,000,000
Cognito MAU     = 0（利用可能な共有無料枠内）
Scheduler       = 0（利用可能な共有無料枠内）
保存・PITR      = 1.2 B × 0.25 + B × 0.20
画像保存        = (I + (2 + 1/30) U) × 0.023
S3 requests     = (0.5 N + K) / 1,000 × 0.0004 + 0.05 N / 1,000 × 0.005
転送            = T × 0.09
ログ            = L × 0.50 + 0.2 L × 0.03
観測            = 9 × 0.10 + 2 × 0.30 / 24 + 0.015 = 0.940/月
```

共通費用はstate保存0.1 GB・配布ZIP保存0.1 GB（旧版・SBOM等込み）、state等のPUT/LIST 1,000回・GET 1,000回、ZIP登録・確認/配布のPUT/LIST 100回・GET/HEAD 100回の予算とする。API/清掃は同じZIPを使い、成果物S3保存を二重計上しない。S3とLambdaは同一リージョンで、通常の配布にインターネットへのZIPダウンロードを含めない。`0.2 × 0.023 + 1,100/1,000 × 0.005 + 1,100/1,000 × 0.0004 = $0.01054/月`。ZIP保存量・操作数は実測前の予算であり、実際のZIPサイズやリリース回数、旧版保持数を保証しない。Lambda内の関数versionのコード保存quotaも別に確認する。

| production API/月 | production USD | 共通ZIP・state等 USD | 合計USD | 合計円・税別 | 転送無償枠も使える場合 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1万回 | $1.1440 | $0.0105 | $1.1546 | 約173円 | 約166円 |
| 10万回 | $2.3643 | $0.0105 | $2.3748 | 約356円 | 約288円 |
| 100万回 | $14.5669 | $0.0105 | $14.5774 | 約2,187円 | 約1,504円 |

100万API/月のproduction内訳: API Lambda $2.7000、清掃Lambda $0.0150、HTTP API $1.0000、DynamoDB読み書き $3.0000、清掃DynamoDB $0.1693、DB保存/PITR $0.0500、画像保存 $0.2259、S3 requests $0.4700、転送 $4.5490、ログ $1.4477、観測 $0.9400、Cognito MAU $0.0000、Scheduler $0.0000。合計は丸め前の値から計算する。

転送の共有100 GB/月無料枠をこのシステムに全て割り当てられる場合、画像/APIの月間転送は順に約0.51/5.05/50.54 GBで、右端列では転送分だけを0とする。Lambda・CloudWatch・保存の無料枠や新規クレジットはさらに別途評価する。[AWSの転送無償枠と集計範囲](https://aws.amazon.com/blogs/aws/aws-free-tier-data-transfer-expansion-100-gb-from-regions-and-1-tb-from-amazon-cloudfront-per-month/)

### ZIP配布による差額

前版と同じAPI・清掃・画像・ログの係数を維持し、共通費用だけを置き換える。前版はECR2 GB保存$0.20とECRから外部runnerへの転送1 GB$0.09を含む$0.2977/月。今回追加するZIPのS3保存0.1 GBとPUT/GET各100回は$0.00284/月で、state分は同じである。差額は`$0.2977 - $0.01054 = $0.28716/月`、1 USD = 150円なら約43円/月削減となる。外部ECR転送が元から転送無料枠で0だった比較では、差額は`$0.20 - $0.00284 = $0.19716/月`で約30円/月となる。これは旧試算の入力に対する比較で、ECRの実使用量や請求の予測ではない。

ZIP化でLambdaのAPI回数・GB-sの単価が下がるとは扱わず、平均durationの係数は維持する。パッケージサイズ・起動時間が変わる効果は公開後に測定する。S3成果物保存・リリース操作や必要時の外部ダウンロードは別費用で、ECR料金を0にすることと配布の全費用を0にすることは別である。

### 失効確認方式の追加費用

採用方式は5分JWTによる期限待ち。比較する追加照会は既存512 MiB API Lambda内で行い、別Lambda呼び出しを増やさない。日次清掃はどの方式でも共通なので差額に含めない。

| productionの追加月額 | 1万API/月 | 10万API/月 | 100万API/月 |
| --- | ---: | ---: | ---: |
| 採用した5分JWT・失効照会なし | $0.0000 / 約0円 | $0.0000 / 約0円 | $0.0000 / 約0円 |
| AdminGetUser・追加100 ms/API | $0.0083 / 約1円 | $0.0833 / 約13円 | $0.8333 / 約125円 |
| DynamoDBの強いGet・追加10 ms/API | $0.0021 / 約0円 | $0.0208 / 約3円 | $0.2083 / 約31円 |

AdminGetUserは`N × 0.5 GB × 0.1秒 × $0.0000166667`の仮定。Enabledの確認はユーザー無効化の検出であり、有効なユーザーの個別セッション失効は検出しない。照会回数ごとに別MAUとは数えず、quotaと実行時間へ影響する。DynamoDBは4 KiB以内の強いGet1 RRU/APIと追加10 ms/APIの仮定で、Cognitoコンソールからの状態同期・書き込み・保存費は含めない。Lambda無料時間が残っていれば実行時間の追加課金は0になり得る。時間は実測性能ではない。[AdminGetUser](https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_AdminGetUser.html)

## 4. 含めないもの・実測後の見直し

以前のdev込み試算や、有効画像1/5/20 GBの複数所有者向け比較表は今回の1人・productionのみの見積もりへ流用しない。今回の固定入力は有効画像128 MiB・ベース3表0.1 GBである。API回数は比較であり、1人がその回数使うという予測ではない。

清掃の平均60秒は料金用の予算入力で、空なら早く終わり、候補が多ければ増える。毎回600秒まで処理する月は清掃の実行時間部分が$0.1500/月となり、60秒モデルより約20円増える。Lambda timeout660秒の設定自体は660秒分の課金を意味しない。SchedulerとLambdaの再試行・手動実行・失敗アップロード・GSI遅延による再照合は別に増える。日次実行の待ち時間による追加24時間の画像滞留を仮定すると、保存費を`U/30 × $0.023`追加する（100万APIで約0.55円/月）。長期滞留ではさらに増える。

GHAの有料実行時間・artifact、AWSサポート、独自ドメイン、SNS/SQS/DLQ等の追加サービス、WAF、VPC/NAT、Provisioned Concurrency、追加KMS key、有料の成果物検査、Cognitoのメール/SMS・有料quota増加は含めない。初回JSON移行、PITR復元、一時復旧先、バックアップexport、運用調査は通常月と別見積もり。移行・復旧スクリプトの存在を常駐サービス料金として計上しない。

未認証の大量リクエスト、条件付き書き込みの拒否、transaction conflict、内部再試行、期限切れURLの連続取得も課金を増やし得る。スロットリング・所有者上限は費用の硬い上限ではない。平均画像100 KiBから1 MiBなら画像の転送・保存は約10.24倍で、BASE64入力のHTTP API単位も増える。

production公開後にAPI/清掃のBilled Duration、Schedulerの試行回数、DynamoDB ConsumedCapacity（GSI込み）・3表/GSI保存量、画像version・滞留、転送、ログ圧縮率、メトリクス発行時間、配布ZIP保存量・S3登録/取得回数・GHA使用量を取得する。構築リージョンの単価で再計算し、以前の「月約20／60／380円」を流用しない。
