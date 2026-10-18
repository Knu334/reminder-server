# Flociのローカル検証結果とMiniStack比較 — 2026-10-07

## 結果

Floci 2.2.0で既存Terraformの3ルートをローカルにapplyできた。
管理対象のリソースインスタンス数はbootstrapが26、platformが19、applicationが38。
applicationには、個別に許可されたAPIだけを先に作成する手順も含む。
本番用リソース定義や入力検証を変更せずにapplyできたが、続くapplicationのplanでは
CloudWatch alarmの更新が1件残った。差分なしに収束したデプロイではない。

OAuthのcustom scopeと5分のトークン有効期限は動作した。
ただし、検証当時のDockerソケットを共有しない構成では、本番と同じ認証・refreshの
経路とLambda実行を組み合わせた完全なE2Eは成立しなかった。

これは探索的な検証であり、永続的な自動E2Eテストは追加していない。
実AWSへのデプロイ、GitHub Actionsの実行、実データ移行は行っていない。

## 検証後の構成変更

本報告の検証後、ユーザーの明示的な許可に基づき、ルートワークスペースの
`.devcontainer/docker-compose.yml`でFlociサービスに
`/var/run/docker.sock:/var/run/docker.sock`の共有設定を追加した。
`FLOCI_HOSTNAME=floci`を維持し、Lambda実行用コンテナのネットワークは
Floci 2.2.0のComposeネットワーク自動検出を使用する。

リビルド後、ソケット共有によるLambda起動と既存ZIPの実行28項目が成功した。
実行環境はNode.js 24.21.0／Amazon Linux 2023／ARM64。
一方、Gatewayの通常GETでは`body: null`とアプリの入力検証の不一致により400になった。
詳細は[ソケット共有後の検証報告書](local-e2e-floci-docker-results.md)を参照。
その後の`body: null`互換性修正によりGatewayの通常GETは成功した。
修正範囲と挙動差は[修正と再検証の報告書](local-e2e-floci-null-body-fix-results.md)を参照。
以下はすべて共有前の検証結果であり、追加検証の結果とは区別する。
固定版の[Lambda資料](https://github.com/floci-io/floci/blob/2.2.0/docs/services/lambda.md)と
[Compose資料](https://github.com/floci-io/floci/blob/2.2.0/docs/configuration/docker-compose.md)を参照。

## 環境と検証範囲

- Flociは`floci/floci:2.2.0`。`http://floci:4566`で正常稼働。
  保存方式はメモリ。検証時はDockerソケット共有も別のLambda実行基盤の設定もなかった。
- Terraformは`1.16.5`、AWS providerは`6.67.0`。MiniStack検証と同じ版を使用。
  Terraform公式アーカイブのチェックサムとproviderのHashiCorp署名を確認した。
- 合成アカウント`000000000000`、リージョン`ap-northeast-1`を使用。
  リソース名には専用の接頭辞`localfloci-5e916c33`を付け、ユーザー・リマインダー・画像は
  すべて検証用に生成した。
- ダミー認証情報とエミュレーターのendpointを明示した。
  TerraformとZIP直接実行の子プロセスには必要な環境変数だけを渡し、実際の認証情報・
  設定ファイルとインスタンスメタデータを参照対象から外した。
  パスワード、認可コード、発行トークンはメモリ内で扱い、ログやstateに書き込んでいない。
- 一時コピー、検証スクリプト、検証用state、結果JSONは`/tmp/floci-check`に保存した。
  コンテナをリビルドすると消える。
- 元のTerraform定義20ファイルと検証用コピーはバイト単位で一致した。
  差し替えたのはローカルbackendとproviderの接続設定だけ。
  本番の入力検証、ライフサイクル保護、Lambdaのハッシュ確認は緩和していない。
- platform/applicationのstateは既存のS3 backendキーを使い、`use_lockfile=true`と
  `encrypt=true`を維持して検証専用エミュレーターバケットに保存した。
- アカウント接頭辞付きのS3 Controlホスト名に対応するため、一時HTTP転送プロセスを使用。
  転送先はFlociのHTTP APIだけに限定し、CONNECTを拒否した。
  応答を生成せず550リクエストを転送し、後片付け後に停止した。
- Schedulerは`DISABLED`で作成し、有効化していない。

## Terraformとデプロイの確認

| 確認項目 | 結果 |
| --- | --- |
| bootstrapのplan/apply | 26インスタンスのapplyに成功。 |
| platformのplan/apply | Cognito rotation設定の読み戻しを含め19インスタンスのapplyに成功。 |
| applicationのAPI先行作成 | APIを1件作成。生成ID`d3e0f32af5`は既存の入力検証を通過。 |
| bootstrapへのAPI登録 | 先行作成したAPI IDを登録。IAM policyを2件更新し、削除はなし。 |
| applicationの通常plan/apply | 残り37インスタンスのapplyに成功。application全体では38件。 |
| 既存client ID検証 | 生成された小文字のclient IDは、変更していない検証を通過。 |
| 既存アプリのZIP | S3の固定バージョンにアップロード。HeadObjectのチェックサムと両Lambdaの`CodeSha256`が一致。 |
| apply後のapplication plan | API処理時間alarmの更新が1件残った。`extended_statistic=p95`と`evaluate_low_sample_count_percentiles=ignore`が空として読み戻される。 |
| APIのproduction alias | 公開済みの数値バージョン`1`を参照。 |
| cleanupのproduction alias | `publish=true`でも`$LATEST`を参照。承認済み設計の、公開済みバージョンを固定する要件を満たさない。 |
| API Lambdaの実際のinvoke | アプリ実行成功には至らず。待ち時間を延ばした検証では`FunctionError=Unhandled`、`Lambda.InitError`、`Failed to start Lambda container: java.net.SocketException: No such file or directory`が返った。 |
| Gatewayの`/healthz` | 502。 |
| JWTなしのGateway経由CRUD | 401。 |

ZIPのSHA-256:
`e4f5a215942fe8aa4c58f755698564a491cd5a88b13b4810f8c20fdb0d52594c`。

apply成功は、対象リソースのTerraform制御APIとの互換性を示す。
Lambdaの実行、IAM・バケットポリシーの適用、マネージドサービスの制限、
本番と同じ認証動作まで同等であることを示すものではない。

## CognitoとGatewayの結果

独立したCognito検証では、次の16項目が成功した。

1. 明示したendpointでの合成アカウントID確認。
2. refresh rotation設定の保存と読み戻し。
3. custom scopeと有効期限単位の保存と読み戻し。
4. 生成client IDの既存入力検証通過。
5. classic Hosted UIのドメイン作成。
6. ログインと、stateを維持した認可コードのリダイレクト。
7. 誤ったPKCE verifierに対する拒否。
8. 正しいS256でのコード交換と3種類のトークン取得。
9. 認可コード再利用の拒否。
10. ローカルJWKSによるaccess tokenのRS256署名検証。
11. access tokenとID tokenの`token_use`による区別。
12. 要求した`reminder-api/read reminder-api/write`が含まれ、
    `aws.cognito.signin.user.admin`が含まれないこと。
13. access/ID tokenのJWT有効期間とOAuthの`expires_in`が300秒であること。
14. Cognito APIによるrefreshでaccess tokenが発行されること。
15. revoke済みrefresh tokenの拒否。
16. user poolの`ACTIVE`削除保護が機能すること。

一方、次の3点に制約があった。

- tokenのissuerは`http://floci:4566/{poolId}`。
  既存Terraformとhandlerが期待する
  `https://cognito-idp.ap-northeast-1.amazonaws.com/{poolId}`とは異なる。
- 本番で使うOAuthの`refresh_token` grantはHTTP 400、`unsupported_grant_type`になる。
- `GetTokensFromRefreshToken`は成功するが、rotationを有効にしていても
  新しいrefresh tokenを返さない。

この結果は固定版の[Cognito資料](https://github.com/floci-io/floci/blob/2.2.0/docs/services/cognito.md)と
[OAuth controller](https://github.com/floci-io/floci/blob/2.2.0/src/main/java/io/github/hectorvent/floci/services/cognito/CognitoOAuthController.java)の内容と一致した。

追加検証では、Terraformで作成したclientでもcustom scope付きのログイントークンが
発行された。そのトークンを設定変更していない保護対象Gatewayルートに送ると、
tokenとauthorizerのissuer不一致により401になった。
実際のローカルissuerを設定した別の検証用APIも、現在のJWT接続制限では401になった。
Gatewayを通じたscope適用や、不正な署名の拒否まで確認できたわけではない。

固定版の[JWT verifier](https://github.com/floci-io/floci/blob/2.2.0/src/main/java/io/github/hectorvent/floci/services/apigatewayv2/JwtSignatureVerifier.java)は、
private targetへの接続を明示的に許可し、かつHTTP接続先がprivateなIPリテラルである
場合を除いてHTTPSを要求する。
したがって、ホスト名を使う`http://floci:4566`のissuerには追加のissuer/JWKS設定が必要。
`FLOCI_SECURITY_ALLOW_PRIVATE_JWT_TARGETS=true`だけでは、このHTTPホスト名の条件を満たさない。
本番のissuer検証は緩和していない。

## ZIP直接実行とストレージの結合検証

既存ZIPのhandlerと、実際のFloci DynamoDB/S3/CloudWatch APIを使った19項目が成功した。
対象は生存確認、claims欠落、公開状態の確認、作成・取得・更新・削除、重複・tombstone処理、
所有者分離、ETag欠落・不一致、同一revisionへの並行更新、画像のversion/checksum、
900秒の署名付きURLでの画像バイト列取得、画像の削除予約、期限到来したjobのcleanup、
元のobject versionを残したdelete marker作成。

handlerは開発コンテナのNode.js `25.8.2`で実行した。
Gateway claimsは検証用に生成し、SDKの接続設定は明示的に隔離した。
Floci Lambda内での実行やGatewayの署名検証ではなく、
本番のNode.js 24・`x86_64`との実行環境の同等性も示さない。
最初のcleanup検証では、模擬した残り実行時間が不足し、indexのpaddingも誤っていた。
これらの検証入力を既存仕様に合わせて修正した後、19項目が成功した。

## MiniStackとの比較

| 機能 | MiniStack 1.5.22 | 検証時のFloci 2.2.0 |
| --- | --- | --- |
| bootstrapのTerraform apply | 26件成功 | 26件成功 |
| platformのTerraform apply | refresh rotation設定の読み戻しで失敗 | 19件成功 |
| applicationのTerraform apply | リポジトリのID入力検証で停止 | 38件成功 |
| PKCEログインのcustom scope | 含まれない | 含まれる |
| 設定した5分のtoken有効期限 | 1時間のtokenを発行 | 5分のtokenを発行 |
| OAuth refresh grant | 動作するがrotationなし | 未対応 |
| refresh token rotation | 検証した経路では未実装 | 設定は保存するが新しいtokenを返さない |
| 既存の本番JWT issuer | 検証した経路ではAWS形式 | ローカルHTTP issuerで不一致 |
| ローカルGateway/JWKS経路 | 署名検証に成功 | 現在のissuer・接続制限では受け入れを確認できず |
| DockerソケットなしのLambda | 内蔵Node.js 24で既存ZIPを実行 | コンテナ起動に失敗。実行基盤の追加設定が必要 |
| ストレージ接続を含むhandler | MiniStack Lambda内で成功 | 開発コンテナのNode.jsでは成功。Floci Lambdaは未検証 |

MiniStackの根拠とリポジトリ側の入力検証の問題は、
[MiniStack報告書](local-e2e-ministack-results.md)を参照。
Flociが生成するIDで問題が表面化しなくても、リポジトリの検証不具合は解消されない。

検証時点では、FlociはTerraformとcustom scope・token有効期限の確認に向いており、
MiniStackはソケット共有なしでLambda実行が動作した。
どちらも、本番設定を維持したログイン・refresh・アプリ実行の全経路を検証できていない。

## 後片付け

独立した認証検証用pool/domainと、診断用API/userは各検証の終了時に削除した。
記録された36手順で83件のTerraform管理対象インスタンスと検証用table/S3データを削除し、
エラーは0件だった。子リソースは所有するAPI、pool、function、bucketの削除とともに除去した。
検証専用リソースを削除するためにエミュレーターAPIで保護設定を解除しただけで、
本番Terraformの保護設定は変更していない。

後片付け後の確認では、検証用のS3 bucket、DynamoDB table、Lambda function、
Cognito pool、Gateway API、log group、IAM role/policy/OIDC provider、
CloudWatch alarm、Scheduler schedule/groupは残っていなかった。
Flociは引き続き正常稼働し、一時HTTP転送プロセスも停止した。
永続的な自動テストや本番実装の変更は、本報告の検証では追加していない。
