# 正式E2E 調査記録

2026-10-08。設計/計画レビュー用。Floci resource作成・E2E実行・Terraform applyは未実施。

2026-10-08承認追補: 6指摘への改訂（commit 2d275c0）提示後、ユーザーが正式E2E設計・対応表・両計画を承認した。実装は未着手。[実装引き継ぎ](../superpowers/handoffs/2026-10-08-reminder-server-formal-e2e-implementation.md)から別セッションで開始する。以下の「承認後」「レビュー中」は調査・レビュー時点の記録として保持する。

## 実際に確認した状態

| 対象 | 今回の確認 | 解釈 |
| --- | --- | --- |
| root / app | feature/aws-modernization / linked feature/aws-sdd-implementation、app HEAD c13272424a3bcb65b6a4613682889be02335c978 | reset/checkout不要 |
| user changes | root FW/Floci README、app event/API/boundaries修正、過去untracked docs | 全て保持、今回のコミット対象にしない |
| Floci health | GET http://floci:4566/_floci/health、HTTP200、2.2.0-local-refresh.1-native | service表示runningは必要APIの動作保証ではない |
| Floci health（2026-10-09追補） | approved rebuild後、GET http://floci:4566/_floci/health、HTTP200、2.2.0-local-refresh.2-native | 上の2026-10-08時点の観測（refresh.1）は履歴として保持。Lambda AddPermissionのSourceAccount保持修正（root commit 7a9b60f）を含む |
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
| Logs/CloudWatch | 既存cleanup mockと過去L metric、health running | 3log group設定とAPI/清掃結果ログ実配信を必須採用。Gateway v2配信は下記source調査により互換性probeへ変更。9alarm運用/通知はA |
| Scheduler schedule/group/Get/Update/Delete/at/cron/target | ScheduleDispatcherはenabled/invocationEnabledを確認、at/rate/cron処理。ScheduleInvokerはLambdaをInvocationType.Eventでinvoke | 設定read-backとowned one-time probeを採用。実起動未確認。SourceArn/IAM/async retry同等性は証明しない |
| STS | 移行/復旧はexplicit account照合に使用 | 明示endpointのlocal GetCallerIdentityを確認してから運用adapter結合。実credential chainは使用しない |
| Terraform1.16.5 / provider6.67.0 | 既存infra mockとlock。Context7でcustom endpoints設定を確認 | 本番3rootの公開ソース再利用・構築・設定read-backを必須基盤として計画へ採用。未対応APIは現在確定していない。全apply成功/不可能を断定しない |
| OIDC provider/role/subject、9alarmのローカル設定 | 本番3rootの公開定義 | run共通の一組で全定義をapply/read-backする。GitHub providerはaccount+URLの単独所有。未知既存providerは拒否。必要API/live互換性は未確認。OIDC実認証やalarm通知の本番同等性は証明しない |
| S3 remote backend/GHA、本番Cognito domain/TLS/PITR/実Chrome受け入れ | 本番受け入れ資料に未実施 | 実AWSの操作・受け入れは対象外。本番定義は再利用し、backendはlocal、接続・隔離差分だけを追加する |

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
DDB/S3/CloudWatch確認→destroyへ改訂した。必要APIが不足する場合、基盤側のTF/Logsをunsupported、
未開始の依存ケースをnot-runとして記録する。入力後の保存/ログ不一致は当該ケースのfailとして残し、正式E2E未完了とする。独立U/Iは継続できる。
この時点の案は独立ローカルrootだったが、下記の最小変更方針への改訂で本番3rootの公開定義を再利用する。Floci成功は実AWSの本番apply成功の証拠にはならない。

公開ソースを確認すると、APIは安全なHTTPエラー応答を作るが結果ログを出していない。
shared loggingと清掃Lambdaには構造化ログがある。Gateway access logはrequestId/routeKey/status/responseLengthで、
アプリケーションerror codeは含まない。この時点ではAPI結果ログ追加をE2E設計の承認対象に含めたが、後述の改訂で独立した先行計画へ分離した。
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

## Terraform変更を最小限にする改訂

ユーザーの条件は「Terraform変更は必要最低限、接続先以外は完全に本番同一が理想」。
module切り出しや別resource定義の新設は採らず、本番3rootの公開.tf/lockを実行ごとの一時ディレクトリで再利用する。
本番ソースは変更しない。backend定義は読まず、local backend/合成inputs/接続overrideを生成する。
認証/route/schema/IAM/TLS必須policy/保持期間/実行設定/削除防止と規定上限を維持する。
Eの小容量/rate3 fixture案を廃止し、容量境界は規定値I、実rate境界はcount119合成seedへ変更した。

公開sourceでprevent_destroy、DDB deletion protection、Cognito ACTIVE、artifact version削除拒否を確認した。
検証中は保護を維持し、後片付けでのみownedサービス側保護/policyと一時rootのprevent_destroyを解除する案。
この回収差分は接続先差分に含めず、設計承認対象として区別した。元の本番定義は書き換えない。
applicationのissuer/Hosted UI検証はAWS HTTPS固定であり、Floci URL向けの最小接続差分が必要になる。
HTTPでS3 TLS policyに拒否される等の不足は、policy緩和ではなくunsupported/未完了として扱う。

本番初期構築手順を読み、bootstrap→platform→application API-only seed→API IDのbootstrap handoff→
ZIP登録→通常application applyを計画へ反映した。9alarm/OIDC等も勝手に対象resourceから外さない。
本番backend/private inputs/state/planは読んでいない。Floci apply/destroyも未実施。

Context7は `Terraform` libraryをresolveして `/websites/developer_hashicorp_terraform` のoverride mergeを確認した。
各質問library→docsの2commandをsandbox外で実行し、quotaエラーはなかった。
[公式override説明](https://developer.hashicorp.com/terraform/language/files/override)では、一般のnested blockは全置換、
lifecycleは引数単位のmergeとされている。追加差分が既存validation/policyを落とさない検査をTF-04へ追加した。
[公式lifecycle説明](https://developer.hashicorp.com/terraform/tutorials/state/resource-lifecycle)を基に、
prevent_destroy維持中の通常destroyを成功前提にしない。mockのoverride_resourceはproviderを呼ばないため実E2Eへ使わない。

## 実行イメージと詳細記述の整合確認

設計§3以降を、冒頭の「構築→設定確認→入力→HTTP/DDB/S3/CloudWatch→回収」と計画に照らして確認した。
§3/6/8には改訂内容が入っていたが、実行順と節・Taskの対応、suiteごとの構築、最終結果の判定が追いにくかった。
§3に実行順と条件の表、§6に出力ごとの正常/異常判定、計画に実装順と実行順の区別を追加した。
この改訂時点ではsuiteごとに独立したstackを想定した。後述の6指摘への改訂でrun共通の一組へ変更した。ケースごとのapplyや本番定義の変更はしない。

§4の「TFを別layer」という記述は共通型U/I/E/L/Aと不一致だったため、実構築・設定確認はLに揃えた。driver/source負例は対応表どおりIとする。
また、基盤初期化前のnot-runと、入力後の保存/ログ不一致のfailを区別し、実施済み証拠をnot-runへ戻さない規則を明記した。
Iの故障注入/captureを実HTTP・CloudWatch配信の証拠にしない境界は維持した。コード変更・applyは未実施。

## 関連文書まで含めた整合確認

設計・計画・対応表のほか、ハンドオフ、README、費用資料、実装結果、受け入れ記録、API/認証/清掃/移行/復旧/配布手順と公開infra READMEを確認した。
波及先と更新時期は[関連文書の確認結果](formal-e2e-document-impact.md)へ記録した。

- 各caseのHTTP/DDB/S3/ログの期待assert・照合結果・対象外理由を共通契約へ反映した。Task4がrunnerの構築→設定確認→case→回収をつなぎ、Task5〜10が各caseの期待を登録する。後述の改訂でログ確定はsuite末尾の一括照合へ変更した。
- サービス表でOIDCを一括して対象外にしていた記述を修正した。ローカル定義のapply/read-backは必須、本番OIDC/GHA/監視の受け入れは対象外である。
- 清掃の開始ログはlambdaRequestId、終了ログはserviceが生成するrequestIdであり、同じIDで一致させることはできない。現行コードの形式を保ち、stream/観測区間で対応づける案へ修正した。
- 未公開清掃は開始ログを出してskipする。不正eventは開始ログより前に拒否する。通常の成功終了ログを全ケースに要求しない。
- refreshの実10秒graceと30日絶対期限を分けた。対応表にあった「元deadline独立I」には本計画内の実装担当と検証経路がなかったため、30日と更新時の不延長はAへ統一し、既存Floci回帰を補助資料とした。
- READMEに未実装・レビュー中の入口を追加した。旧F10結果にはAPI操作結果ログの不足を追記し、過去の成功件数を正式E2Eへ流用しないことを明記した。
- 費用資料に東京/月100回未満の前提への参照を追加した。旧米国東部モデルの総額や未取得単価は変更していない。

今回も変更は文書のみ。実装・Flociリソース作成・apply・実AWS操作は行っていない。

## 6指摘を受けた再調査と改訂（2026-10-08）

この節が、上記のsuite別stack・APIログ変更を含むE2E計画・Gateway配信必須という旧案を更新する。変更は文書のみで、正式E2E・Floci資源作成・applyは未実施である。

### Gateway配信とTLSの証拠

Floci作業コピーのservices/apigatewayv2/ApiGatewayV2Service.javaはstageのaccessLogSettingsを保存・読み戻すが、v2 HTTP APIからLogsへ配信する処理は確認できなかった。services/lambda/ApiGatewayController.javaのPutLogEventsはv1 `/_api/{functionName}` の直接proxyであり、v2 JWT経路の代用にはならない。services/配下のLogs出力はiotにも存在するため、「Lambda以外には一切ない」とは記録しない。
OBS-02はAPI/清掃配信を必須に保ち、Gateway配信だけを互換性調査へ移した。Flociパッチは別件である。APIログ不在だけでは未到達を断定せず、HTTP拒否・RATE/保存不変・前後正常対照の実配信と合わせる。正常対照が欠けた場合は不在観測をpassにしない。

FlociはIAM enforcementが既定無効で、今回確認したS3経路にaws:SecureTransportの評価は見当たらない。Deny policyを保持してHTTP成功した結果はpolicy-presentとenforcement-unverifiedを分けて記録する。TLS強制の証拠は別承認の実AWSへ残す。

### Terraform overrideの例外と許可差分

公開application variables.tfのcognito_issuer/cognito_auth_base_urlはAWS HTTPS形式だけを許可する。platform outputs.tfもAWS URLを組み立てる。Floci CognitoService.getIssuerはbaseUrl + `/` + poolIdであり、Hosted UI経路は `/cognito-idp/oauth2/authorize` と `/cognito-idp/oauth2/token` である。
一時コピー内の2validation条件と安全なerror_messageを、discoveryで確認したFloci origin/4566/owned poolまたはauth baseとの完全一致（host文字列は維持し、DNSで同一private IPv4を確認）へ変換する。platformの同名2output.valueも接続overrideで置き換える。他のvalidation・type/nullability・resource条件を保持する。変換前source digest、変換後digest、構造差分と生成設定の許可リストを設計§8/TF-04へ記載した。元の本番ファイルは変更しない。

Context7はsandbox外でlibrary→docsの2commandを実行した。quotaエラーはなかった。

```sh
npx ctx7@latest library Terraform 'Override file merging rules for lifecycle blocks and postcondition nested blocks when overriding prevent_destroy only'
npx ctx7@latest docs /websites/developer_hashicorp_terraform 'Override files: lifecycle special merging rule for arguments prevent_destroy and nested postcondition blocks when overriding prevent_destroy=false only; variable validation override merging'
```

[公式override資料](https://developer.hashicorp.com/terraform/language/files/override)の一般nested block全置換には例外がある。
[checks.go](https://raw.githubusercontent.com/hashicorp/terraform/main/internal/configs/checks.go)のdecodeCheckRuleBlockはoverrideでのvalidation/precondition/postconditionを拒否する。
[named_values.go](https://raw.githubusercontent.com/hashicorp/terraform/main/internal/configs/named_values.go)と[resource.go](https://raw.githubusercontent.com/hashicorp/terraform/main/internal/configs/resource.go)は各conditionをこの関数で処理する。
[module_merge.go](https://github.com/hashicorp/terraform/blob/main/internal/configs/module_merge.go)のResource.mergeはprevent_destroy引数をmergeし、既存postconditionは保持する。
そのためvalidationはoverride fileで置き換えず、限定した一時コピー変換にする。回収時のprevent_destroy scalar overrideではGatewayのAPI ID保持postconditionを残し、再定義しない。
ここで確認した公式ソースはmainであり、固定版1.16.5の実測証拠ではない。provider不要のoffline確認を試みたが、最初のterraform version実行でFileNotFoundErrorになった。現在のPATHにTerraformがなく、validateも実行されていない。指定版の準備とoffline確認は承認後のTask3で行う。

### run共通の所有関係と復旧経路

bootstrap/oidc.tfはGitHub provider URLを固定する。ARNはaccount+URLで決まるため、suite別・追加stack別の所有をやめた。Floci作業コピーIamServiceのCreateOpenIDConnectProviderにはsynchronized lockとEntityAlreadyExistsの重複拒否があり、「重複チェックがない」という指摘はこのコピーには当てはまらない。ただし、稼働native imageに収録されているかは未確認である。重複が拒否されるかにかかわらず設計上の衝突は避ける必要がある。
基盤/ZIPはrun一組、suiteは逐次、OIDCは一所有者とする。同一account runをロックし、未知の既存providerは採用しない。suite間はowned合成データを回収し、公開状態/checkpoint等を復元・読み戻す。別issuerの負例には最小のSDK Cognito control資源だけを作る。
合成復旧3tableは本番schema/protection/TTL/PITR設定でSDK作成し、既存restored_tables/data sourceへ渡す。追加3rootは作らず、同じ3root/stateでmapを切り替え・読み戻し・{}へ戻す。API入力とSchedulerを停止した区間だけで行い、source row/version不変と復元後の設定を確認する。実PITR/AWS切替の証拠とはしない。

### 時間と先行製品変更

ログobserverはowned Lambda groupごとに一つとし、全caseの期待を登録後、suite末尾に最終対象入力から最大60秒でまとめて確定する。ログ不在の負例ごとに60秒待たない。未確定caseをpassにせず、observer障害は入力済みcaseのfailへ反映する。
設計§3に工程別見積もり22〜65分、run本体75分と回収15分、全体90分、各poll/processの期限を記載した。実測前の見積もりであり、実装後に工程別時間で更新する。
旧Task2のAPI結果ログ変更は[独立先行計画](../superpowers/plans/2026-10-08-reminder-server-api-result-logging.md)へ切り出した。独立承認・検証・commit後にE2Eを実装する。E2E Task2は前提確認だけで、製品コードを変更しない。費用・保持の前提は維持する。

## 2026-10-08 API結果ログの前提確認（正式E2E Task2）

独立API結果ログ計画は2026-10-08に承認済みで、製品変更は `95dfcdf`、F10の結果記録は `93bfaf1` にコミットされた。独立taskレビューと最終レビュー（gpt-6-astra/high）はいずれもApprovedで、作業を止める指摘はない。承認・レビューの引き継ぎ証跡は本計画の `api-prerequisite.md`、公開の検証記録は[2026-10-08 F10追補](../implementation-results.md#2026-10-08-f10追補-api結果ログのローカル検証)で確認した。既存のESLint警告とnpm ciのESLint9.39.0非推奨・サポート終了警告は残る。

### 製品のJSON契約

`src/api.ts` の `withApiResultLogging` は、`ApiHandler` 型のdelegateを包む。最外側の本番handlerを一度だけ包み、初期化・cold/warm invocation、成功・拒否・503の結果を1呼び出し1件で記録する。HTTP応答とdelegateが投げた例外の同一性を保ち、ログ出力の失敗で応答を変えない。

- JSONは512bytes以内で、`requestId` / `lambdaRequestId` / `operation` / `status` / `code` / `durationMs` に限定する。
- IDは安全なASCII文字（英数字・`_`・`-`）で各128文字以内とし、不正なIDは省く。
- operationは既存routeの固定許可値を使い、未知の操作は `unknown` にする。codeは既存の固定許可値だけを記録し、未知のcodeと正常時のcodeは省く。
- 本文・画像・owner/item ID・生path/query・token・署名URL・例外message/stackを記録しない。
- 既存logging helper/consoleを使う。APIからのPutLogEvents、新SDK依存、alarm、metric、subscriptionは追加しておらず、ログ保持30日は変更していない。

### 検証結果の有効範囲

| 確認した既存証跡 | 結果 |
| --- | --- |
| API結果ログ単独 | 22/22 |
| 関連API/runtime回帰 | 66/66 |
| Node全suite | 359/359（runtime188 / operations74 / delivery97） |
| Python packaging | 3/3 |
| typecheck / lint | 成功 |
| build / package / verify:zip | 成功。Node全suite前にZIPを再生成・検証 |
| runtime / full audit | 両方0 vulnerabilities。証跡取得時点の結果 |

Node24.21.0/npm11.11.1/Python3.13.16で得た結果である。Task1の `1fdd90d` と修正 `1597df4` は独立レビュー済みで、製品コードを変えずにharness39件を追加し、既存359件も再確認した。Task2では `93bfaf1` から開始時の `1597df4` までの製品・既存runtime/operations/delivery試験・lockfileの差分がないことを確認した。package.jsonの追加はTask1のE2E入口であり、既存の試験scriptと依存関係は変わっていない。製品sourceが変わっていないため、成功済みの試験は再実行していない。

未コミットのnull-body修正は `src/api/event.ts`、`tests/runtime/api.test.ts`、`tests/runtime/boundaries.test.ts` に残っている。既存のnull-body回帰6件は359件に含まれ、この3ファイルの差分をTask2の前後で保持した。これらは今回の文書commitに含めない。

### 判定と残る配信確認

独立製品変更の承認・レビュー・commitと、同一sourceのローカル回帰結果を確認したため、API結果ログの前提確認は満たした。今回の追記は製品検証OBS-01/04の前提記録である。console capture/stdoutのJSONはCloudWatchへの配信を証明しない。API/清掃ログの実配信と入力後のHTTP/DDB/S3/ログ照合は後続Eの検証に残り、正式E2Eはまだ完了していない。Gatewayログ配信は別の互換性調査として扱う。

独立API変更のinfra:checkはTerraform不在でinitできず、成功とは数えていない。ツール準備と3rootの確認はTask3に残す。Task2では文書だけを追記し、製品コード、公開Terraform定義とログ保持設定は変更していない。Floci資源作成、Terraform apply/destroy、実AWS、GHA、push/PR/merge、FW/devcontainer変更は行っていない。後続で前提回帰が失敗した場合は製品ログ変更の問題として切り分け、Floci構築へ進まず、製品修正をE2Eタスクへ含めない。

## Terraform構築driverの実測（2026-10-09）

Task3で、本番3rootの公開ソースをrun専用ディレクトリへ配置するdriverを追加した。Terraformは1.16.5、AWS providerは6.67.0を固定した。元の.tfとlockは変更していない。ZIPは現在の非秘密入力からbuild・package・verify:zipを実行し、build前後の入力digest一致を確認した。未コミットのユーザー修正もZIPへ含め、commit対象からは除いた。

初期2runのbootstrap失敗は、新driverの接続処理の不足によるものだった。固定providerのS3 bucketタグ読み取りはS3Control.ListTagsForResourceを呼ぶが、最初のendpoint一覧からS3Controlが抜けていた。追加後も、固定SDKはaccount IDをcustom endpointのauthorityへ付加するため、IPをbaseにすると不正なhostnameになる。この2run目の説明は固定ソースからの推定であり、そのrunのblocked enumは保存されていない。過去の公開成功報告には、同じTerraform/provider版とaccount付きS3Control relayが記載されていた。版の違いやFloci非対応を原因とする説明は採らない。

現在のdriverはS3Controlのbaseをhttp://floci:4566にし、STSで確認したaccountと.flociから成るlogical authorityだけをrun専用proxyへ通す。認証はproxy起動ごとの乱数を使う。HTTP/4566、固定SDKのtag操作、owned bucket ARN、許可したqueryを照合し、Host・path・query・body・署名を保持する。socketは既にDNS確認したFlociのprivate IPv4へ固定する。logical aliasのDNSは引かない。未知account・host・port・path・query・proxy認証、CONNECT、redirectは拒否する。実際の固定providerを使ったdefault STS負例でもupstream転送は0だった。datasourceのread再試行は続いたため、子processを期限で終了した。

3run目はbootstrapとplatformを構築した後、application開始前に失敗した。discoveryの詳細を保存していなかったため、このrunでissuer不一致を観測したとは記録しない。公開Floci sourceと既存の公開結果は、現在のissuerが起動時に確認したprivate IPv4を使うことを示していた。driverのfloci固定値を廃止し、実際のdiscovery値を変更せず、同じFlociのIP、owned pool/JWKS path、OAuthのauthorize/token pathを検証する処理へ改めた。4run目ではdiscoveryの200とverified-private-ipを保存した。

4run目はbootstrap、platform、既存のAPI-only seed、bootstrapへのAPI ID引き渡し、create-only ZIP登録、application全体apply、3rootのprovider refreshに成功した。16route、9alarm、両Lambdaとaliasの同一ZIP、3tableの削除保護とPITR35日、3bucketのversioningとTLS必須policy、3log groupの保持30日を読み戻した。S3はpolicy-presentであり、HTTPでの成功からTLS/IAMのenforcementを証明したとは扱わない。Gateway/API/清掃ログの実配信、Hosted UI経由の製品操作、Scheduler起動はTask4以降の対象で、正式E2Eは未完了である。

cleanupは結果確定後に行う。driver自身がLambdaをinvokeしていない履歴と、SchedulerのDISABLED読み戻しを単独診断の終了確認に使う。後続fixtureはinvokeやScheduler有効化の前にsetQuiescenceGuardを登録し、追跡した処理と実終了証拠で確認する。metricの欠落を実行数0と解釈しない。Scheduler停止、owned userとbucketの全version/marker回収、サービス側の保護解除、一時rootのprevent_destroy scalar解除を経て、application、platform、bootstrapの順にdestroyする。解除失敗でも回収を続け、errorと実残存数を別々に記録する。

4run目のcleanupは19操作中19成功、errors0、leaks0だった。stateの空件数を不在証拠には使わず、破棄前に保存した83個のowned IDをサービスAPIで照合し、absent83、exists0、unverified0を確認した。3run目のDynamoDB不在確認はdriverのJSON protocol指定誤りで3件がunverifiedだったが、同じrunのIDを正しいprotocolで再確認し、45件すべての不在を保存した。初期2runも18件ずつ不在確認を完了し、account lockを解除した。過去の失敗記録は残している。

最後に、first init/apply前のmanifestへ公開resourceの静的addressも登録した。bootstrap13、platform16、application15の計44familyであり、動的instanceの実数83とは区別する。作成後のowned IDをfamilyへ対応づけ、空のstate snapshotでも既知IDを消さない。未知IDや未開始intentを不在と決めつけず、確認できたfamilyとZIPだけremovedへ進める。default接続、foreign state、source/overrideの改変、stale/tampered ZIP、create-only upload、保護解除失敗、結果確定前のcleanup、DNSとprocess中断の負例を検証した。

5run目は静的addressへのID保存で、log groupの先頭/を拒否するdriverの不備によりplatform apply後に失敗した。回収後の45件はすべて不在だった。保存済み83IDの30resource kindを確認し、log group、API stage、alias、permission、ARNなどの形ごとに所有関係を検証する処理へ修正した。6run目は全構築と読み戻しに成功し、cleanup19/19、errors0、leaks0、独立不在83/83を確認した。manifestの44family、3root、ZIPはすべてremovedだった。このrunでは各rootの初回init直前にintentを登録していた。最終修正では全44familyを最初のTerraform spawn前に永続化し、partial failureでも未開始rootのintentを削除済みにしないことをoffline試験で確認した。この保存順だけの修正ではbackendを再構築していない。最終integrationは61/61、固定Terraform試験は2/2、生成3rootのinit・fmt・validateは9/9、packagingは3/3、typecheckとlintはexit0だった。

## Scheduler起動とサービス別結果ログの実測（正式E2E Task 11、2026-10-10）

patched Floci refresh.5（health `2.2.0-local-refresh.5-native`）に対して、`logging`と`scheduler`の2 suiteを実行した。日次Schedulerは読み取りだけで、変更も削除もしていない。製品、infra、Floci、`.devcontainer`は変更していない。

### 実測結果

| 対象 | run | 結果 | 実測内容 |
| --- | --- | --- | --- |
| OBS-02 CRUD成功ログ | e2e-a90fb040（`--suite logging`、272秒） | pass | POST 201 / GET 200 / PATCH 200 / DELETE 200 と、削除後のGET 404 について、HTTP、DynamoDB、S3、API結果ログを照合した。ログは返却されたrequest IDに紐づき、各1件だった |
| OBS-02 入力拒否ログ | 同上 | pass | invalid JSON 400、media type 415、owner field 422、存在しないitem 404について、status、code、operationがAPI log groupのログと一致した。最後の正常対照200も配信された。rateは+5で保存は不変だった |
| OBS-02 Gateway 401/403 | 同上 | pass | JWTなし401と書き込みのみのtokenによるGET 403で、HTTP、保存、S3 versionが不変だった。前後に正常対照のAPI結果ログが配信された上で、拒否側のAPI結果ログ不在を確認した。不在確認はsuite末尾の一括観測で行った |
| OBS-03 清掃ログ対応 | 同上 | pass | 1回目はevaluated 1 / deletes 1、2回目はdeletes 0。各invokeのstartとendを別々の観測区間で対応づけ、実際のjob done、marker、checkpointとも一致した |
| OPS-06 daily Schedule | e2e-94e3b315（`--suite scheduler`、223秒） | pass | `cron(0 3 * * ? *)`、UTC、window OFF、DISABLED、retry 2、event age 3600秒、入力`{}`、cleanup aliasの読み戻しがprobeの前後で同一だった。group内にはdaily 1件だけが残った |
| OPS-06 one-time起動 | 同上 | pass | 同じScheduler groupにrun専用の`at()` Scheduleを作成し、読み戻した。作成の10秒後の時刻を指定し、期限の90秒以内にjobがdone、delete marker追加、checkpoint保存へ変化した。cleanup_startと終了ログ（status 200、evaluated 1、deletes 1）も配信された |
| OBS-04 Gateway配信 | 各runのfixture smoke | unsupported（Floci） | stageのaccessLogSettings（destinationとformat）は設定gateで読み戻せた。実HTTPのAPI結果は配信されたが、gateway log groupのeventは0件だった。v2配信は`gateway-delivery-unsupported`として制限に記録する |

one-time Scheduleは、作成の前にowned manifestへ予約した。削除後に`GetSchedule`で不在を読み戻してから、処理終了ログの待機、合成データの回収へ進んだ。2 runともcleanupは18/18で、errors 0、leaks 0だった。run終了時の掃引でも、owned Scheduleは残っていなかった。

### 判定の根拠

Schedule受付だけでは成功としない。passには、job done、delete marker、checkpoint、配信された清掃ログの4つが揃うことが必要である。`unsupported`と判定するのは次の2つだけである。

- 受付後、期限内に変化が何もなく、清掃ログも1件もない。
- CreateScheduleがHTTP 501と、既知のnot-implemented名で拒否された。

それ以外の組み合わせは失敗とする。例として、状態だけ変化してログがない場合、ログだけ配信されて状態が変化しない場合、日次設定が変化した場合、Scheduleが削除されなかった場合は失敗になる。ログの欠落（`anyLog=false`）とログ内容の不一致（`anyLog=true`）は、`scheduler-probe.json`の固定語彙で区別している。

### 未検証・制限

- S3 TLS policy: 設定gateは、Deny policyがFlociへ保持されていること（policy-present）を読み戻した。Flociは`aws:SecureTransport`を評価しないため、HTTPリクエストの成功は強制の証拠にならない。強制はenforcement-unverifiedとして記録し、実AWSでの確認に残す。
- 日次運転（03:00 UTCの実起動）、実AWS IAM（Scheduler roleのtrustやSourceArn）、非同期invokeの再試行（retry 2、event age 3600秒）の同等性は確認していない。one-time probeはretry 0で、1回だけ起動する構成にした。
- v1直接proxyのログはv2/JWT経路の代用にしていない。Gateway配信の観測は、gateway log groupのeventの有無だけを使う。
