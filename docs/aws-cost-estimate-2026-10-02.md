# reminder-server AWS構成の費用試算

確認日: 2026-10-02。対象: [AWS設計書](superpowers/specs/2026-10-02-reminder-server-aws-design.md)のHTTP API、API Lambda、キャッシュなしAuthorizer、DynamoDBの3表と清掃GSI、S3、CloudWatch、ECR、Terraform state、dev環境。

これは入力条件を置いた比較モデルで、実請求・費用上限の保証ではない。リージョンは未指定のため、**公式資料の料金例を確認できたUS East (N. Virginia)、us-east-1を参考にする**。東京リージョンの試算ではない。地域別Price Listの直接取得は通信制限で実行できなかったため、単価は下記の公式公開料金・料金例を参照した。構築先リージョンの決定後、AWS Pricing CalculatorまたはPrice Listと実測値で更新する。

円換算は説明用に1 USD = 150円と仮定する。現在の為替レートを示すものではない。税、割引、無料枠、期間限定クレジットは基本表から差し引かない。無料枠が使える場合は低くなるが、他のシステム・devと共有する枠を環境ごとに二重計上しない。

## 1. 利用量とモデルの前提

月は30日。保存量は月平均、ログ保存は30日保持が定常状態になった月を扱う。AWS料金表のGBを本モデルでは1,073,741,824 bytesとして計算する。以下の保存量は利用量から自動的に保証される値ではなく、独立した予算入力である。

| 入力 | 小規模 | 中規模 | 比較用の高利用 |
| --- | ---: | ---: | ---: |
| productionの認証対象APIリクエスト/月 N | 10,000 | 100,000 | 1,000,000 |
| devの同リクエスト/月 | 1,000 | 10,000 | 100,000 |
| productionの有効画像・平均保存GB I | 1 | 5 | 20 |
| productionのDynamoDBベース3表・平均GB B | 0.1 | 0.5 | 2 |
| devの画像・DynamoDB保存量 | productionの10% | 同左 | 同左 |

- Nには一覧、項目取得、変更、**画像URL発行、ETag取得のための項目GET**を含める。画像S3 GETは別に数える。「同期1回」をAPI1回と同一視しない。認証エラー、health/preflight、移行・復旧はこの通常利用量に含めない。
- AuthorizerのTTLは0。正常な認証対象API1回につきAuthorizerとAPI Lambdaが各1回動き、productionが月100万回なら**Lambda約200万回**、devを加えると約220万回となる。
- APIは512 MiB・平均課金時間300 ms、Authorizerは256 MiB・同100 msと仮定する。API1回の合計は`0.5 × 0.3 + 0.25 × 0.1 = 0.175 GB-s`。cold start等も含むBilled Durationの実測へ置き換える。
- 読み取り80%、変更20%。変更をすべて、1 KiB以内のリマインダーと所有者カウンターの2項目トランザクションとして予算化する。トランザクションは**各項目2 WRU**なので、この部分は`0.2 × 2項目 × 2 = 0.8 WRU/API`。画像変更では画像jobも加わる。
- 全APIでレートカウンター1 WRU、Authorizerの2件の強い読み取り2 RRU、初回公開状態の強い読み取り1 RRUを含める。項目・一覧の読み取り、画像job、GSI、清掃checkpoint、条件失敗・内部再試行の予算を加え、**平均6 RRU + 4 WRU/API**を計算係数にする。これは実装上必ずこの容量になるという値でも、最悪時の上限でもない。画像job/GSIの増幅を無視して単純な「API1回=DB1回」で計算しない。
- 通常保存はベース表BにGSI等20%を加えた`1.2 B GB`、PITR課金対象はベース3表の`B GB`と仮定する。カウンター、job、削除記録も保存量に含めて実測する。
- 画像取得は`0.5 N`回、画像保存・差し替えは`0.05 N`回、元画像の平均は100 KiB。リクエスト本文はBASE64化後も512 KiB以内と仮定し、HTTP APIは1リクエストを1課金単位で数える。上限1 MiBの画像を送る場合は512 KiB刻みの課金単位が増えるため再計算する。
- 月間画像保存量を`U = 0.05 N × 100 KiB / 2^30` GBとする。各差し替えで旧画像1つが不要になる定常状態を置き、旧バージョン60日分`2 U`と清掃待ち24時間分`U/30`を予算に加える。S3の画像保存量は`I + (2 + 1/30) U`。清掃の滞留や失敗アップロードが多ければ増える。
- API応答は平均3 KiB、画像はS3から直接配信。転送量は`(0.5 N × 100 KiB + N × 3 KiB) / 2^30` GB。画像URL発行そのものにはS3 GET料金を付けず、そのAPI実行と実際の画像GETをそれぞれ計上する。
- Gateway、Authorizer、APIの合計ログはAPI1回につき3 KiB、保存時の圧縮比20%。各環境に8個の標準アラーム、清掃用の独自メトリクス2個を置く。メトリクスは日次発行の1時間/日だけ課金される前提で按分し、各環境`2 × $0.30 × 30/720 = $0.025/月`。毎時発行すればこの部分は$0.60/月になる。
- 観測用API操作・ログ検索の追加予算を各環境$0.015/月とする。これはサービスの固定料金ではなく、操作量未測定のための少額の予算入力である。route別詳細メトリクス、追加dimension、通知サービスは含めない。
- devにも独立したアラームとPITRを維持する。リクエストが10%だから環境全体の料金が10%になるとは扱わない。

## 2. 計算に使った単価

公開料金例を用いる参考値。料金改定・リージョン・段階料金は構築前に再確認する。

| 課金対象 | USD単価 | 一次資料 |
| --- | ---: | --- |
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
| ECR private保存 | $0.10 / GB-month | [ECR料金](https://aws.amazon.com/ecr/pricing/) |

S3画像・stateはSSE-S3、DynamoDBは既定の暗号化とし、customer managed KMS keyを追加する場合の料金はこのモデルへ追加する。ECRはbasic scanningを前提とし、Inspectorによるenhanced scanningは別見積もりにする。S3 delete marker・旧versionは保存量に含め、清掃による容量の即時ゼロ化は仮定しない。

## 3. 月額の結果

環境の計算式は以下。Pは各環境のAPI回数、B/Iはその環境の保存量、Lは月間ログ取り込みGB、Tは転送GB、Uは月間画像保存GB。

```text
Lambda       = 2 P / 1,000,000 × 0.20 + 0.175 P × 0.0000166667
HTTP API     = P / 1,000,000 × 1.00
DynamoDB I/O = (6 P × 0.125 + 4 P × 0.625) / 1,000,000
保存・PITR   = 1.2 B × 0.25 + B × 0.20
画像保存     = (I + (2 + 1/30) U) × 0.023
S3 requests  = 0.5 P / 1,000 × 0.0004 + 0.05 P / 1,000 × 0.005
転送         = T × 0.09
ログ         = L × 0.50 + 0.2 L × 0.03
観測         = 8 × 0.10 + 2 × 0.30 / 24 + 0.015 = 0.840/月
```

共通費用はECR保存2 GB、state保存0.1 GB、state等のPUT/LIST 1,000回・GET 1,000回、GHA等へのECR転送1 GBを予算化し、`2 × 0.10 + 0.1 × 0.023 + 0.005 + 0.0004 + 1 × 0.09 = $0.2977/月`。devとproductionで同じECRリポジトリを使う同一アカウントの例である。digestを保持する数やrunnerの取得量が増えれば変わる。

| 月額USD・無料枠を差し引かない | 1万API/月 | 10万API/月 | 100万API/月 |
| --- | ---: | ---: | ---: |
| production | $1.0554 | $2.6286 | $16.5364 |
| dev | $0.8615 | $1.0189 | $2.4096 |
| 共通ECR・state等 | $0.2977 | $0.2977 | $0.2977 |
| **合計USD** | **$2.2146** | **$3.9452** | **$19.2437** |
| **合計円・1 USD = 150円、税別** | **約332円** | **約592円** | **約2,887円** |

100万API/月のproduction内訳は、Lambda $3.3167、HTTP API $1.0000、DynamoDB読み書き $3.2500、DB保存/PITR $1.0000、画像保存 $0.6830、S3 requests $0.4500、転送 $4.5490、ログ $1.4477、観測 $0.8400。表は丸め前の値から合計している。

インターネット転送の月100 GBの無償枠がこのシステムに全て使える場合、共通ECR分を含む転送量は順に約1.56 / 6.56 / 56.60 GBなので、この部分の有料額は0になる。**転送無償枠だけ**を反映した総額は約311 / 503 / 2,122円。Lambda、CloudWatch、保存の無料枠や新規アカウントのクレジットはさらに別途評価する。[AWSの転送無償枠と集計範囲](https://aws.amazon.com/blogs/aws/aws-free-tier-data-transfer-expansion-100-gb-from-regions-and-1-tb-from-amazon-cloudfront-per-month/)

## 4. 含めないもの・実測後の見直し

GHAの有料実行時間・artifact、AWSサポート契約、独自ドメイン、SNS通知、WAF、VPC/NAT、Provisioned Concurrency、追加KMS key、enhanced scanningは含まない。無料とは判断せず、採用条件と使用量が決まれば加算する。初回移行、PITRからの復元、バックアップexport、長時間の運用調査も通常月とは別見積もりにする。保守CLIはGHAで動き、清掃専用Lambdaの呼び出しは追加しない。

未認証の大量リクエスト、拒否された条件付き書き込み、transaction conflict、再試行、期限切れURLの連続取得も課金を増やし得る。スロットリングと所有者上限は予算の硬い上限ではない。画像サイズが100 KiBから1 MiBになれば転送・保存は約10.24倍となり、BASE64入力のHTTP API課金単位も増える。

devのsmoke後、Lambda Billed Duration、DynamoDBのConsumedCapacity（GSI込み）、全3表・GSIの保存量、非現行S3 versionと清掃滞留、転送量、ログ量・圧縮率、メトリクスの発行時間、ECRとGHA使用量を取得する。地域別単価とこれらを使って再計算し、以前の「月約20／60／380円」をこの構成の見積もりとして流用しない。
