# MiniStackのローカルE2E検証結果 — 2026-10-07

## 結果

MiniStack 1.5.22で既存アプリのZIPを実行し、DynamoDB、versioning有効のS3、cleanup、
Hosted UI/PKCE、API GatewayのJWT検証をローカルで確認できた。
ただし、リポジトリの本番用制約を変更せずに、アプリ全体のデプロイと認証付きCRUDの
完全なE2Eを実行するところまでは対応できていない。
残る失敗にはリポジトリ側の入力検証の不具合とエミュレーター側の制約があり、
どちらも回避して成功扱いにはしていない。

これは探索的な検証であり、永続的な自動E2Eテストではない。
作成したエミュレーター上のリソースはすべて削除した。
AWSへのデプロイ、GitHub Actionsの実行、実データ移行は行っていない。

## 環境と隔離

- MiniStackは`ministackorg/ministack:1.5.22`。
  `LAMBDA_EXECUTOR=local`、`LAMBDA_STRICT=0`で、Dockerソケット共有はなし。
- 実際のLambda workerはNode.js `24.18.1`、Alpine `3.24.2`、ARM64。
  `Architectures=["x86_64"]`を指定してもローカルworkerのアーキテクチャは変わらなかった。
- Terraformは`1.16.5`、AWS providerは`6.67.0`。
  Terraform公式ZIPのチェックサムを確認し、TerraformがproviderのHashiCorp署名を検証した。
- 既存アプリZIPのSHA-256は
  `e4f5a215942fe8aa4c58f755698564a491cd5a88b13b4810f8c20fdb0d52594c`。
- 合成アカウント`000000000000`と、検証用に生成したユーザー・画像・リマインダーだけを使用。
  リソースには専用の`localtf-*`接頭辞を付けた。
  パスワードと発行トークンはメモリ内で扱い、ログ、Terraform state、本報告に記録していない。
- Terraformの一時コピー、検証用ログとstateは`/tmp/ministack-terraform-check`に保存した。
  コンテナのリビルドで消える。本番のリソース・変数定義20ファイルとコピーは
  バイト単位で一致していた。
- bootstrapの検証では最初にlocal stateを使用。
  platform/applicationでは既存S3 backendを、`use_lockfile=true`を維持して
  検証専用のエミュレーターbucketに向けた。custom ID検証は別のstateキーを使用した。
- providerの各endpointとLambda内SDKのendpointをMiniStackに明示的に向けた。
  実際の認証情報・設定ファイルとインスタンスメタデータを参照対象から外した。
  Schedulerは有効化していない。

## Terraformの結果

| 検証 | 結果 |
| --- | --- |
| bootstrap | 26件すべてのapplyに成功。 |
| platform | 19件のplanに成功。Cognito clientのrefresh rotation設定の読み戻しでapplyが失敗し、部分的なapplyとなった。 |
| applicationのAPI先行作成 | 既存のAPI先行作成手順に成功。MiniStackが生成したAPI IDは8文字。 |
| applicationの通常plan | 8文字のAPI IDと、大文字を含むCognito client IDの入力検証で失敗。 |
| `ms-custom-id`を使う別のapplication検証 | 本番のID入力検証を変更せず、10文字のAPI IDを先行作成できた。通常planは引き続きclient IDの入力検証で失敗。 |

AWS provider 6.67.0はS3 Control経由でbucket tagを読み取る。
その接続先ホスト名が`000000000000.ministack`となり、Docker ComposeのDNSで解決できなかった。
直接リクエストでMiniStackがAPIに対応していることを確認したうえで、一時HTTP転送
プロセスによりリクエストを変更せずMiniStackに転送し、他の転送先を拒否した。
AWSサービスの応答を生成する処理は追加していない。
最初の読み取り失敗で作成済みbucketが2件taintされたため、その同一性とtagを確認してから
一時stateのtaintを解除した。本番の`prevent_destroy`と事前・事後条件は維持した。

API IDの調整にはMiniStackの公式
[`ms-custom-id`実装](https://github.com/ministackorg/ministack/blob/v1.5.22/ministack/services/apigateway.py)を使用。
tagは独立した一時検証にだけ追加した。
ローカルGatewayの実行URLは`/_aws/execute-api/{apiId}/$default/{path}`だった。

## 実行と認証の結果

先に行ったLambda API直接呼び出しでは、既存ZIPに対する22項目が成功した。
対象はCRUD、所有者分離、公開状態の確認、ETag、重複・tombstone処理、
条件付き並行更新、S3のバージョンを固定した画像取得、
元のobject versionを残したcleanupによるdelete marker作成。
この検証では生成したGateway JWT claimsを使用し、署名は検証していない。

続く認証・Gatewayの構成要素の検証では、次の13項目が成功した。

1. Hosted UIの認可ページ表示。
2. ログインと、同じstateを伴う認可コードのリダイレクト。
3. 誤ったPKCE verifierの拒否。
4. 正しいS256によるコード交換。
5. 認可コード再利用の拒否。
6. ローカルJWKSとRS256による、Cognitoが発行したaccess JWTの署名検証。
7. S3の固定バージョンからの既存ZIP読み込みと`CodeSha256`一致。
8. Gatewayから既存ZIPの`/healthz`呼び出し。
9. Gatewayからの`/readyz`呼び出し。未公開・公開状態による判定と、
   実際のDynamoDB/S3 SDKリクエストを含む。
10. GatewayによるJWTなしのリクエスト拒否。
11. custom scopeを要求しないJWT検証用ルートで、Cognitoが発行したJWTの受け入れ。
12. JWT payloadの改ざんに対する署名不一致の拒否。
13. Gatewayによる必須custom scope欠落の拒否。

Gateway検証では、作成済みAPIにSDK・制御APIで一時integration、route、検証用functionを
追加した。Terraform管理下のアプリ全体のデプロイではない。
JWT検証専用ルートは、本番CRUDルートのscope要件を置き換えたり緩和したりしていない。

## リポジトリの入力検証とエミュレーターの制約

Cognito client IDの拒否はリポジトリ側の入力検証の不具合であり、
MiniStackがAWS仕様に反するIDを返した証拠ではない。
`infra/application/production/variables.tf`は小文字と数字だけを許可しているが、
公式の[Cognito ClientId仕様](https://docs.aws.amazon.com/cognito-user-identity-pools/latest/APIReference/API_UserPoolClientType.html)は
1～128文字、パターン`[\w+]+`で、大文字も許可している。
観測した大文字を含むIDはこの仕様を満たす。本番の入力検証はまだ修正していない。
API IDの固定10文字制約もリポジトリ側の前提として見直しが必要。
観測した長さの不一致だけでは、MiniStackのAWS API仕様違反とは判断できない。

| 不一致 | この構成で期待する動作 | MiniStack 1.5.22での結果 |
| --- | --- | --- |
| refresh rotation設定 | `ENABLED`、grace period 10秒 | 読み戻しから`RefreshTokenRotation`が欠落。Terraformが`.refresh_token_rotation: block count changed from 1 to 0`を報告。 |
| Cognito client ID — リポジトリの不具合 | AWS ClientId仕様で許可するIDを受け入れる | 大文字を含む有効なIDを、過度に厳しいリポジトリの検証が拒否。 |
| 既定のHTTP API ID — リポジトリの前提 | 既存の固定10文字の入力検証を通過 | 8文字。別の検証で公式custom ID tagにより対応したが、リポジトリの長さ制約は見直しが必要。 |
| OAuth custom scope | access JWTに`reminder-api/read reminder-api/write`を含む | client設定と要求にscopeを指定しても、`aws.cognito.signin.user.admin`だけを含む。 |
| access token有効期限 | 300秒 | JWTの`exp - iat`とOAuthの`expires_in`はともに3600秒。 |
| refresh rotationの動作 | refresh時に新しいrefresh tokenを返す | refreshは成功するが、新しいrefresh tokenは返さない。 |
| Gateway経由の認証付きCRUD | 有効なローカルログイントークンで`GET /v2/reminders`を受け入れる | 必須custom scopeがないため403。 |

scopeと5分の有効期限はclientのメタデータには保存されていたが、token発行に反映されなかった。
この結果は固定版の
[Cognito実装](https://github.com/ministackorg/ministack/blob/v1.5.22/ministack/services/cognito.py)とも一致した。
OAuth検証は認可コードとPKCEを使用し、設定済みcustom scopeを要求した。
ログインに`InitiateAuth`を使ったわけではない。
access tokenのscopeは実装内で`aws.cognito.signin.user.admin`に固定されている。
したがって今回の保護対象CRUDリクエストはアプリhandlerに到達する前にGatewayで拒否された。
この403の原因は特定できたが、アプリに他の不具合がないことや、実AWSでの動作を示すものではない。

custom scopeは、承認済み設計のaccess tokenだけを受け入れるAPI境界と、
read/writeのルート認可を実現する。
所有者分離は別の仕組みであり、検証済みの`iss`と`sub`から導出する。
AWSはID tokenとaccess tokenを区別するために
[ルートのauthorization scopeを推奨](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-jwt-authorizer.html)している。
read/writeを分けること自体は承認済み設計の選択であり、単一ユーザーのCRUDから
必然的に生じる要件ではない。

ローカルでapplyや実行が成功しても、IAM・バケットポリシーの適用がAWSと同等とはいえない。
今回の接続はHTTPだったが、保存したbucket policyでは暗号化されていない接続を拒否している。
AWSの実行アーキテクチャ、リソース制限、処理の連携、マネージドサービスの動作も
このローカル実行検証の対象外。

## 後片付けと今後の作業

検証用user、検証用Lambda function、公開marker、API、Cognito pool/domain、
DynamoDB table、log、IAM role/policy/OIDC provider、一時S3 bucket 3件を削除した。
HTTP転送プロセスも停止した。
削除後の一覧・読み戻し確認では、S3、DynamoDB、Lambda、API Gateway、IAM、Cognito、Logsに
この検証の接頭辞を持つリソースが残っていなかった。
検証用データの削除に必要な保護設定だけをエミュレーターAPIで変更し、
本番Terraformの保護設定は変えていない。

完全なローカル認証付きE2Eには、リポジトリのCognito client ID検証の修正、
API IDの前提の見直し、互換性が不足するCognito実装の修正または置き換えが必要。
MiniStackを修正して使う場合、client設定の保存・読み戻し、OAuth custom scope発行、
有効期限の単位、refresh rotationへの対応と保守が必要になる。
それまでは、ZIPとストレージの直接検証、および成功した認証の構成要素の確認は
有用な部分検証にとどまり、完全なE2E成功とは扱わない。
今回の検証では永続的なE2Eテストを追加していない。
