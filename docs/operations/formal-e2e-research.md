# 正式E2E 調査記録

2026-10-08。設計/計画レビュー用。Floci resource作成・E2E実行・Terraform applyは未実施。

## 実際に確認した状態

| 対象 | 今回の確認 | 解釈 |
| --- | --- | --- |
| root / app | feature/aws-modernization / linked feature/aws-sdd-implementation、app HEAD c13272424a3bcb65b6a4613682889be02335c978 | reset/checkout不要 |
| user changes | root FW/Floci README、app event/API/boundaries修正、過去untracked docs | 全て保持、今回のコミット対象にしない |
| Floci health | GET http://floci:4566/_floci/health、HTTP200、2.2.0-local-refresh.1-native | service表示runningは必要APIの動作保証ではない |
| tools | PATH prefixでNode24.21.0 / Python3.13.16 | product testは今回未実行 |
| npm | 準備PATHの11.19.0→/tmp/aws-sdd-toolsへnpm11.11.1復元→11.11.1確認 | 不足tool準備のみ。app依存/lockを変更しない |
| Floci設定位置 | root docker-compose.ymlには旧reminder-server記述、Flociはroot .devcontainer/docker-compose.yml | 手順で後者を参照。どちらも編集しない |
| Docker | Flociだけにsocket共有、開発containerへの追加なし | host rebuildは勝手に実行しない |

今回の実行command（read-onlyまたは指定tool準備）:

```sh
git status --short --branch
git worktree list
git rev-parse HEAD
git rev-parse --git-dir --git-common-dir --show-superproject-working-tree
curl --max-time 10 --fail --silent --show-error http://floci:4566/_floci/health
PATH=/tmp/aws-sdd-tools/node_modules/.bin:/tmp/aws-sdd-tools/bin:$PATH node --version
PATH=/tmp/aws-sdd-tools/node_modules/.bin:/tmp/aws-sdd-tools/bin:$PATH npm --version
PATH=/tmp/aws-sdd-tools/node_modules/.bin:/tmp/aws-sdd-tools/bin:$PATH python3 --version
PATH=/tmp/aws-sdd-tools/node_modules/.bin:/tmp/aws-sdd-tools/bin:$PATH npm install --prefix /tmp/aws-sdd-tools --no-audit --no-fund --ignore-scripts npm@11.11.1
```

標準sandboxの最初のcatはbwrapがprocをmountできず失敗した。その後は許可されたread-only/文書/tool準備を
sandbox外で実行した。秘密/実データ/state/plan/credentialsは開いていない。

## 現行資料と既存testからの判断

AGENTS→CLAUDE、README、製品spec、完成済み全体/runtime/operations/delivery計画、resume handoff、
implementation results/final review/acceptance、認証付きFloci/refresh/null-body報告、API v2/Chrome、
cleanup/migration/recovery/deployment、Floci4つのtest/transportファイル、runtime/operations/deliveryの
関連ケースとsource interfaces、root Floci README/Dockerfile/startup/Composeを調査した。

- old authenticated-crudは一つのtop-level testに依存順チェックを集め、旧ZIP digestを固定。
  JWT欠落/改ざん/別client、ID/read-only、CRUD/owner/ETag/refreshの保存記録はある。
  正式画像/cleanup/競合/境界の全体は未網羅。
- old refreshは9件だがclient ExplicitAuthFlowsにALLOW_USER_SRP_AUTHを使用。
  正式fixtureは製品のALLOW_ADMIN_USER_PASSWORD_AUTH、公開code/S256、5分/30日/10秒を使う。
  既存スクリプトは履歴として保存する。
- null-body報告の画像/cleanupは主にclaimsを合成したAPI Lambda直接invoke。
  実認証Eとして再利用しない。ソース未コミット変更は現行buildへ含め、生成元を明記する。
- sourceのcreateAwsClientsはregion/maxAttempts=1でSDKを構成する。
  FlociのContainerLauncher/LaunchedContainerAwsEnvはlocal endpointとローカルrole credentialを注入する。
  fixtureへdummy envを書いたことだけでruntime credential優先を推定しない。
- serviceのcurrentはdeleted/nullを404としてからETagを照合する。
  DELETEを含む同時HTTPで一律に敗者412を要求すると、先行削除後の合法な404まで製品バグと誤認する。
  Eは一成功/一拒否と保存一回、双方旧activeを読んだIは一成功/一412、と設計を分けた。
- root/app patchの現行digestとupstreamはhand-off記録を採用し、今回再hash/patch適用はしていない。
  現行patchに含むQuarkus2件と作業コピーの補足14件を混ぜない。
- /tmpだけにあった過去ログや、他計画のSDD workspaceは一次証拠として読んでいない。
  今回のfresh product結果はまだない。

## Floci/Terraformのサービス別採否

作業コピー `/workspace/.worktrees/floci-oauth/src/main/java/io/github/hectorvent/floci/` は非秘密sourceを
read-onlyで確認した。コピーのsourceの存在は稼働native binaryの全API互換性を証明しない。

| サービス/必要API | 根拠 | 現時点の採否・不足確認 |
| --- | --- | --- |
| Cognito pool/client/resource server/admin合成user/Hosted UI/token/JWKS | old実PKCE成功、refresh patch/報告 | Terraform管理の認証基盤を採用。SDKは合成user準備。negative PKCE/disable/discoveryは新実行必要 |
| API Gateway v2 API/authorizer/integration/16route/stage | old CRUD成功、method優先patch | Terraform管理で必須。CORS・aliases・TFのGet/List/Tag/waiterに不足がないか未確認 |
| Lambda ZIP/create/publish/alias/GetFunction/invoke/permission/concurrency/event-invoke-config | old API ZIP/Docker実行、null-body両handler報告 | Terraform管理で必須。TF providerの付随APIとimmutable qualifier結合は未確認 |
| DDB 3table/GSI/Get/Query/TransactWrite/Describe/TTL/PITR設定 | old CRUD・rt real-adapter/fake | 基本Terraform管理で必須。実競合・GSI・TFの設定read-backは未確認。PITR復元は対象外 |
| S3 buckets/version/checksum/CORS/Put/Get/HEAD/marker/ListVersions | old readiness、旧L画像/cleanup | Terraform管理で必須。署名URLDNS/CORS/TF付随read APIは未確認 |
| S3署名強制 | PreSignedUrlFilter.java:期限を検査し、signature検証はenforceAuth/validateSignatures/登録credentialに依存。EmulatorConfig両flag既定false | 有効URL200だけで証明不可。改ざん/期限の実controlを必須調査にする。host設定変更は提案だけ |
| IAM role/policy/PassRole/trust | old role/policy作成成功 | Terraform管理でlocal作成。production IAM等価を主張しない。TF Tag/List/Get API不足は未確認 |
| Logs/CloudWatch | 既存cleanup mockと過去L metric、health running | 3log group設定とowned結果ログ実配信を必須採用。互換性未確認。9alarm運用/通知はA |
| Scheduler schedule/group/Get/Update/Delete/at/cron/target | ScheduleDispatcherはenabled/invocationEnabledを確認、at/rate/cron処理。ScheduleInvokerはLambdaをInvocationType.Eventでinvoke | 設定read-backとowned one-time probeを採用。実起動未確認。SourceArn/IAM/async retry同等性は証明しない |
| STS | 移行/復旧はexplicit account照合に使用 | 明示endpointのlocal GetCallerIdentityを確認してから運用adapter結合。実credential chainは使用しない |
| Terraform1.16.5 / provider6.67.0 | 既存infra mockとlock。Context7でcustom endpoints設定を確認 | 独立E2E rootの構築・設定read-backを必須基盤として計画へ採用。未対応APIは現在確定していない。全apply成功/不可能を断定しない |
| OIDC/S3 remote backend/GHA/Cognito domain本番/TLS/PITR/実Chrome | 本番受け入れ資料に未実施 | 今回は対象外。production rootをローカル用へ改変しない |

承認後は必要APIを「成功実測 / sourceのみ / 未対応action / 未実施」の四区分で更新し、
TFの最小applyで付随read/waiterの不足も調べる。healthのrunningだけで採用可否を閉じない。

## Context7調査（sandbox外、各質問2command、quotaエラーなし）

実行前にlibraryをresolveしてからdocsを取得した。queryには秘密を含めない。

1. `npx ctx7@latest library "Terraform AWS Provider" "Local emulator endpoint overrides for AWS provider 6.67.0 credential validation skip metadata and local state"`
2. `npx ctx7@latest docs /hashicorp/terraform-provider-aws "Provider configuration for custom local endpoints: endpoints lambda apigateway cognitoidp scheduler dynamodb s3 iam sts cloudwatchlogs cloudwatch; skip_credentials_validation skip_metadata_api_check skip_requesting_account_id s3_use_path_style"`

選択は公式HashiCorp / High / 20705 snippets / benchmark78.32。
取得docsはmainで、索引versionに6.67.0はなかった。6.67.0固有schemaの証拠とはしない。
[custom endpoints公式ガイド](https://github.com/hashicorp/terraform-provider-aws/blob/main/website/docs/guides/custom-service-endpoints.html.markdown)
でprovider endpoints優先、dummy key、skip metadata/credential/account照合設定、S3 path styleを確認。
これを参考に、承認後のisolated rootで固定6.67.0 schemaを確認する。
取得例がLocalStackでも、採用するエミュレーターはFlociのまま。

3. `npx ctx7@latest library "Amazon API Gateway" "HTTP API JWT authorizer audience client_id issuer expiration scopes and route selection exact methods versus ANY"`
4. `npx ctx7@latest docs /websites/aws_amazon_apigateway "HTTP API JWT authorizer validation sequence signature issuer audience client_id exp nbf iat and authorizationScopes; how audience takes precedence over client_id"`

選択はAmazon API Gateway / High / 4657 snippets / benchmark77.34。
[公式JWT authorizer資料](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-jwt-authorizer.html)
と[診断資料](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-troubleshooting-jwt.html)
から、iss/署名/時間/scope、audがあるとaud、ないとclient_idを照合することを確認した。
issuer・期限等の負例でsignatureを壊さない設計の根拠とした。
WWW-Authenticateのraw値は秘密を含まない保証がないためpublic証拠へ丸ごと保存しない。

## 調査段階の制限

変更したのは新文書と/tmpの指定npmのみ。正式E2E、Floci合成resource、TF apply/destroy、
製品修正、FW/devcontainer編集、AWS/GHA/push/PR/mergeは未実施。
新SDD台帳は設計/計画承認後に新計画専用workspaceへ作り、過去計画の台帳を流用しない。

## 入力から最終結果を見る方針への改訂

ユーザーの指摘を受け、SDK構築と補足Terraform probeという初稿から、Terraform構築→設定確認→実HTTP→
DDB/S3/CloudWatch確認→destroyへ改訂した。必要APIが不足する場合、TF/Logsをunsupported、
依存ケースをnot-runとして記録し、正式E2E未完了とする。独立U/Iは継続できる。
独立したローカルrootの成功は、本番3root全体のapply成功の証拠にはならない。

公開ソースを確認すると、APIは安全なHTTPエラー応答を作るが結果ログを出していない。
shared loggingと清掃Lambdaには構造化ログがある。Gateway access logはrequestId/routeKey/status/responseLengthで、
アプリケーションerror codeは含まない。API結果ログ追加を改訂設計の承認対象に含めた。
画像清掃はDeleteObjectにVersionIdを渡さずmarkerを作る。storage.tfはS3旧version60日、DDB PITR35日、
logs.tfは3log group30日。これらを維持する案とし、構築設定の読み戻しへ追加した。

## 費用・ログの公式資料確認

ユーザー回答は東京リージョン、月100リクエスト未満。計算と採否は[費用・ログ方針](formal-e2e-cost-and-logging.md)。
Context7は各質問library→docsの2commandをsandbox外で実行し、quotaエラーはなかった。

- `Amazon S3` をresolveし `/websites/aws_amazon_s3` で非現行versionの課金・期限を照会。取得結果は概説のみで、AWS公式ユーザーガイドで補った。
- `Amazon CloudWatch` をresolveし `/websites/aws_amazon_amazoncloudwatch` でログ取り込み・保存・retention・最小限の出力を照会。[公式billing説明](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/cloudwatch_billing.md)を確認した。
- [S3 versioning](https://docs.aws.amazon.com/AmazonS3/latest/userguide/Versioning.html)、[lifecycle期限](https://docs.aws.amazon.com/AmazonS3/latest/userguide/lifecycle-expire-general-considerations.html)、[CloudWatch料金表](https://aws.amazon.com/cloudwatch/pricing/)を確認した。
- [2026-02-04 AWS公式記事](https://aws.amazon.com/jp/blogs/news/cloudwatch-get-telemetry-data-logs/)の東京S3 USD0.025/GB・月、CloudWatch保存USD0.033/GB・月を参考単価として使用した。

AWS公開Price Listの東京S3/CloudWatch JSON取得はnetworkのNo route to hostで失敗し、地域別の現在単価は取得できなかった。
東京の取り込み価格を確定値として掲載せず、USD1/GBという比較仮定で追加費用の規模を示した。FW変更は行っていない。
月100回、追加1KiB/回なら約100KiB。本文・画像を除いた結果ログの追加を勧める。
S3の60日保持は小額の保存費と35日復旧を比較したうえで維持する案。短縮・永久削除は計画に含めない。
