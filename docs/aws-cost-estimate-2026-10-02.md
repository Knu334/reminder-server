# reminder-server AWS構成の費用試算

確認日: 2026-10-03。対象: [AWS設計書](superpowers/specs/2026-10-02-reminder-server-aws-design.md)のCognito、HTTP APIの標準JWT Authorizer、API Lambda、DynamoDBの3表と清掃GSI、S3、CloudWatch、ECR、Terraform state、dev環境。Cognitoと5分アクセストークンの採用を反映し、独自Lambda Authorizerを使う旧試算は方式比較として残す。

これは入力条件を置いた比較モデルで、実請求・費用上限の保証ではない。リージョンは未指定のため、**公式資料の料金例を確認できたUS East (N. Virginia)、us-east-1を参考にする**。東京リージョンの試算ではない。地域別Price Listの直接取得は通信制限で実行できなかったため、単価は下記の公式公開料金・料金例を参照した。構築先リージョンの決定後、AWS Pricing CalculatorまたはPrice Listと実測値で更新する。

円換算は説明用に1 USD = 150円と仮定する。現在の為替レートを示すものではない。Cognito MAU料金だけは利用可能な無料枠内で0とする。税、割引、その他の無料枠、期間限定クレジットは基本表から差し引かない。無料枠が使える場合は低くなるが、他のシステム・devと共有する枠を環境ごとに二重計上しない。

## 1. 利用量とモデルの前提

月は30日。保存量は月平均、ログ保存は30日保持が定常状態になった月を扱う。AWS料金表のGBを本モデルでは1,073,741,824 bytesとして計算する。以下の保存量は利用量から自動的に保証される値ではなく、独立した予算入力である。

ユーザー本人1人の想定は§3の「1人利用の保存量での試算」に示す。以下の有効画像1/5/20 GBは、1所有者の128 MiB上限を超えるため、所有者数を増やした仮想利用量で旧案と条件を揃えるための比較値である。1人利用の通常保存量や利用者数の予測ではない。

| 入力 | 小規模 | 中規模 | 比較用の高利用 |
| --- | ---: | ---: | ---: |
| productionの認証対象APIリクエスト/月 N | 10,000 | 100,000 | 1,000,000 |
| devの同リクエスト/月 | 1,000 | 10,000 | 100,000 |
| productionの有効画像・平均保存GB I | 1 | 5 | 20 |
| productionのDynamoDBベース3表・平均GB B | 0.1 | 0.5 | 2 |
| devの画像・DynamoDB保存量 | productionの10% | 同左 | 同左 |

- Nには一覧、項目取得、変更、**画像URL発行、ETag取得のための項目GET**を含める。画像S3 GETは別に数える。「同期1回」をAPI1回と同一視しない。認証エラー、health/preflight、移行・復旧はこの通常利用量に含めない。
- 標準JWT Authorizerは認証専用Lambdaを起動しない。正常な認証対象API1回につきAPI Lambdaが1回動き、productionが月100万回なら**Lambda約100万回**、devを加えると約110万回となる。ユーザーの失効確認用のCognito/DynamoDB照会は追加しない。
- APIは512 MiB・平均課金時間300 msと仮定する。API1回は`0.5 × 0.3 = 0.15 GB-s`。cold start等も含むBilled Durationの実測へ置き換える。
- CognitoはEssentialsの直接認証を使用する。本人1人でもdev/productionの別poolのユーザーは別に数え、管理操作もMAUへ寄与する。アカウントまたは組織で共有する10,000 MAU/月の無料枠に余裕がある条件で、Cognito MAU料金を0とする。余裕がない場合は対象リージョンの有料MAU分を全方式へ加算する。人間のユーザーのログイン・トークン更新はMAU方式で、同じユーザーの更新回数ごとにMAUを増やさない。M2Mのトークン発行料金をこの用途へ適用しない。
- 読み取り80%、変更20%。変更をすべて、1 KiB以内のリマインダーと所有者カウンターの2項目トランザクションとして予算化する。トランザクションは**各項目2 WRU**なので、この部分は`0.2 × 2項目 × 2 = 0.8 WRU/API`。画像変更では画像jobも加わる。
- 全APIでレートカウンター1 WRU、初回公開状態の強い読み取り1 RRUを含める。項目・一覧の読み取り、画像job、GSI、清掃checkpoint、条件失敗・内部再試行の予算を加え、**平均4 RRU + 4 WRU/API**を計算係数にする。旧案の認証用の強い読み取り2 RRU/APIだけを外した予算モデルである。これは実装上必ずこの容量になるという値でも、最悪時の上限でもない。画像job/GSIの増幅を無視して単純な「API1回=DB1回」で計算しない。
- 通常保存はベース表BにGSI等20%を加えた`1.2 B GB`、PITR課金対象はベース3表の`B GB`と仮定する。カウンター、job、削除記録も保存量に含めて実測する。
- 画像取得は`0.5 N`回、画像保存・差し替えは`0.05 N`回、元画像の平均は100 KiB。リクエスト本文はBASE64化後も512 KiB以内と仮定し、HTTP APIは1リクエストを1課金単位で数える。上限1 MiBの画像を送る場合は512 KiB刻みの課金単位が増えるため再計算する。
- 月間画像保存量を`U = 0.05 N × 100 KiB / 2^30` GBとする。各差し替えで旧画像1つが不要になる定常状態を置き、旧バージョン60日分`2 U`と清掃待ち24時間分`U/30`を予算に加える。S3の画像保存量は`I + (2 + 1/30) U`。清掃の滞留や失敗アップロードが多ければ増える。
- API応答は平均3 KiB、画像はS3から直接配信。転送量は`(0.5 N × 100 KiB + N × 3 KiB) / 2^30` GB。画像URL発行そのものにはS3 GET料金を付けず、そのAPI実行と実際の画像GETをそれぞれ計上する。
- GatewayとAPIの合計ログは旧案と同じ予算のAPI1回につき3 KiB、保存時の圧縮比20%を維持する。認証用表の削減による保存量の減少も実測前には差し引かない。各環境に6個の標準アラーム、清掃用の独自メトリクス2個を置く。メトリクスは日次発行の1時間/日だけ課金される前提で按分し、各環境`2 × $0.30 × 30/720 = $0.025/月`。毎時発行すればこの部分は$0.60/月になる。
- 観測用API操作・ログ検索の追加予算を各環境$0.015/月とする。これはサービスの固定料金ではなく、操作量未測定のための少額の予算入力である。route別詳細メトリクス、追加dimension、通知サービスは含めない。
- devにも独立したアラームとPITRを維持する。リクエストが10%だから環境全体の料金が10%になるとは扱わない。

## 2. 計算に使った単価

公開料金例を用いる参考値。料金改定・リージョン・段階料金は構築前に再確認する。

| 課金対象 | USD単価 | 一次資料 |
| --- | ---: | --- |
| Cognito Essentials・直接認証 | 利用可能な共有無料枠内で$0。無料枠超過の料金例は$0.015 / MAU | [Cognito料金・MAUの計算](https://aws.amazon.com/cognito/pricing/) |
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
Lambda       = P / 1,000,000 × 0.20 + 0.15 P × 0.0000166667
HTTP API     = P / 1,000,000 × 1.00
DynamoDB I/O = (4 P × 0.125 + 4 P × 0.625) / 1,000,000
Cognito MAU  = 0（利用可能な共有無料枠内という条件）
保存・PITR   = 1.2 B × 0.25 + B × 0.20
画像保存     = (I + (2 + 1/30) U) × 0.023
S3 requests  = 0.5 P / 1,000 × 0.0004 + 0.05 P / 1,000 × 0.005
転送         = T × 0.09
ログ         = L × 0.50 + 0.2 L × 0.03
観測         = 6 × 0.10 + 2 × 0.30 / 24 + 0.015 = 0.640/月
```

共通費用はECR保存2 GB、state保存0.1 GB、state等のPUT/LIST 1,000回・GET 1,000回、GHA等へのECR転送1 GBを予算化し、`2 × 0.10 + 0.1 × 0.023 + 0.005 + 0.0004 + 1 × 0.09 = $0.2977/月`。devとproductionで同じECRリポジトリを使う同一アカウントの例である。digestを保持する数やrunnerの取得量が増えれば変わる。

### 旧案と保存条件を揃えた方式比較用の月額

| 月額USD・Cognito MAU以外の無料枠を差し引かない | 1万API/月 | 10万API/月 | 100万API/月 |
| --- | ---: | ---: | ---: |
| production | $0.8467 | $2.3420 | $15.4697 |
| dev | $0.6607 | $0.8102 | $2.1230 |
| 共通ECR・state等 | $0.2977 | $0.2977 | $0.2977 |
| **合計USD** | **$1.8051** | **$3.4499** | **$17.8904** |
| **合計円・1 USD = 150円、税別** | **約271円** | **約517円** | **約2,684円** |

100万API/月のproduction内訳は、Lambda $2.7000、HTTP API $1.0000、DynamoDB読み書き $3.0000、DB保存/PITR $1.0000、画像保存 $0.6830、S3 requests $0.4500、転送 $4.5490、ログ $1.4477、観測 $0.6400、Cognito MAU $0。表は丸め前の値から合計している。

インターネット転送の月100 GBの無償枠がこのシステムに全て使える場合、共通ECR分を含む転送量は順に約1.56 / 6.56 / 56.60 GBなので、この部分の有料額は0になる。Cognito MAUに加え、**転送無償枠だけ**を反映した総額は約250 / 429 / 1,919円。Lambda、CloudWatch、保存の無料枠や新規アカウントのクレジットはさらに別途評価する。[AWSの転送無償枠と集計範囲](https://aws.amazon.com/blogs/aws/aws-free-tier-data-transfer-expansion-100-gb-from-regions-and-1-tb-from-amazon-cloudfront-per-month/)

### 1人利用の保存量での試算

productionの有効画像を上限の128 MiB（0.125 GB）、DynamoDBベース3表を予算入力の0.1 GBに固定する。devはリクエスト・保存量ともproductionの10%とする。他の条件は上記と同じで、旧画像versionの60日保持はアップロード回数から別に加算する。大量の差し替えでは、有効画像の上限より旧versionの保存量が大きくなる。DynamoDBの保存量はレートcounter、job、削除記録等を含む独立した予算入力であり、0.1 GB以内に収まる保証ではない。

| 1人利用・本番API/月 | production USD | dev USD | 共通USD | 合計USD | 合計円・税別 | 転送無償枠も使える場合 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1万回 | $0.8266 | $0.6587 | $0.2977 | $1.7829 | 約267円 | 約246円 |
| 10万回 | $2.0298 | $0.7790 | $0.2977 | $3.1065 | 約466円 | 約377円 |
| 100万回 | $14.0626 | $1.9823 | $0.2977 | $16.3425 | 約2,451円 | 約1,687円 |

これは1人がこれだけ呼び出すという予測ではなく、呼び出し数による比較である。ログイン画面を開いている回数をAPI回数として数えず、画像URL更新やETag取得もAPI回数に含める。5分JWTを常駐timerで更新するのではなく、Chrome拡張が利用直前に更新する。

### 失効確認方式の料金差

今回の採用は標準JWT Authorizerと5分トークンによる期限待ちである。以下の2つの追加照会方式は採用しないが、判断に使用した料金比較を記録する。照会は既存の512 MiB API Lambda内で行い、別Lambdaの呼び出し料金を追加しない。

| 5分JWT方式に対する追加月額・productionのみ | 1万API/月 | 10万API/月 | 100万API/月 |
| --- | ---: | ---: | ---: |
| 5分JWT、失効照会なし | $0 / 0円 | $0 / 0円 | $0 / 0円 |
| AdminGetUser、追加100 ms/API | $0.0083 / 約1.25円 | $0.0833 / 約12.50円 | $0.8333 / 約125円 |
| DynamoDBの強いGet 1件、追加10 ms/API | $0.0021 / 約0.31円 | $0.0208 / 約3.13円 | $0.2083 / 約31円 |

AdminGetUserの追加額は`P × 0.5 GB × 0.1秒 × $0.0000166667`である。同じ利用者の照会回数ごとに別MAUとして課金しないが、APIのquotaとLambda実行時間へ影響する。追加時間が50/200 msなら100万回で約63/250円となる。Enabledの確認はアカウントの無効化を検出するものであり、ユーザーが有効なまま行った個別トークンの失効までは検出しない。[AdminGetUser](https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_AdminGetUser.html)

DynamoDBの追加額は、4 KiB以内の強い読み取り1 RRU/APIと`P × 0.5 GB × 0.01秒`の追加Lambda時間である。100万回で読み取り$0.125と実行時間約$0.0833となる。Cognitoのコンソール操作だけではDynamoDBへ無効化状態は同期されないため、別の状態登録・同期運用が必要になる。その書き込み、保存、同期処理の費用はこの追加額に含めない。

Lambdaの無料実行時間が十分に残っていれば、照会で増える実行時間の料金が0になる場合がある。上表の時間は実測ではなく仮定であり、CognitoとDynamoDBの実測性能を示す値ではない。

| 旧案と同じ仮想保存量・本番＋dev＋共通の合計円 | 1万API/月 | 10万API/月 | 100万API/月 |
| --- | ---: | ---: | ---: |
| 旧案の独自Lambda Authorizer | 約332円 | 約592円 | 約2,887円 |
| 採用したCognito＋5分JWT | 約271円 | 約517円 | 約2,684円 |
| Cognito＋AdminGetUserの追加照会 | 約272円 | 約531円 | 約2,821円 |
| Cognito＋DynamoDBの追加照会（同期処理除外） | 約271円 | 約521円 | 約2,718円 |

旧案からは認証専用Lambdaのリクエストと256 MiB/100 msの実行、認証用の強い読み取り2件/API、アラーム2個/環境を外している。差額は本番とdevのAPI総数をP_totalとして、`P_total × ($0.20/100万 + 0.025 × $0.0000166667 + 2 × $0.125/100万) + $0.40/月`。Cognitoの無料枠が使えない場合はCognito各方式へMAU料金を加える。

## 4. 含めないもの・実測後の見直し

GHAの有料実行時間・artifact、AWSサポート契約、独自ドメイン、SNS通知、WAF、VPC/NAT、Provisioned Concurrency、追加KMS key、enhanced scanning、Cognitoに関連するメール/SMS送信・有料quota増加等は含まない。無料とは判断せず、採用条件と使用量が決まれば加算する。初回移行、PITRからの復元、バックアップexport、長時間の運用調査も通常月とは別見積もりにする。保守CLIはGHAで動き、清掃専用Lambdaの呼び出しは追加しない。

未認証の大量リクエスト、拒否された条件付き書き込み、transaction conflict、再試行、期限切れURLの連続取得も課金を増やし得る。スロットリングと所有者上限は予算の硬い上限ではない。画像サイズが100 KiBから1 MiBになれば転送・保存は約10.24倍となり、BASE64入力のHTTP API課金単位も増える。

devのsmoke後、Lambda Billed Duration、DynamoDBのConsumedCapacity（GSI込み）、全3表・GSIの保存量、非現行S3 versionと清掃滞留、転送量、ログ量・圧縮率、メトリクスの発行時間、ECRとGHA使用量を取得する。地域別単価とこれらを使って再計算し、以前の「月約20／60／380円」をこの構成の見積もりとして流用しない。
