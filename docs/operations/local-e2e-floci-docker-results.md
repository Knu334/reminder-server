# FlociのDockerソケット共有後の検証結果 — 2026-10-07

## body:null修正後の追記

後続の承認済み修正で`body: null`を本文なしとして扱うように変更し、
Flociの通常GET `/healthz`は200、`/readyz`は未公開時503・公開後200になった。
修正後ZIPの結合検証31項目と全Nodeテスト337件が成功した。
認証済み本文なしPOSTのレート消費などの挙動差も確認した。
詳細は[修正と再検証の報告書](local-e2e-floci-null-body-fix-results.md)を参照。
以下は修正前の初回検証結果として残す。

## 修正前の結果

Dockerソケットを共有してリビルドしたFloci 2.2.0で、Lambdaの実際の実行に成功した。
前回の`Lambda.InitError`による起動失敗は、今回の構成では発生しなかった。
既存アプリのZIPをDocker Lambda内で実行する検証は28項目が成功した。
CRUD、所有者分離、ETag競合、S3画像、cleanup、CloudWatchメトリクス送信を含む。

ただし、通常のGET `/healthz`と`/readyz`はGateway経由で400になった。
Flociが本文なしのGETを`body: null`としてLambdaに渡す一方、アプリの入力検証は
`body`の省略または文字列だけを受け入れるため。
Dockerソケット共有によってLambda起動は改善したが、完全な認証付きE2Eは成立していない。

前回のTerraform・Cognito検証は[共有前の報告書](local-e2e-floci-results.md)を参照。
今回、Terraformの3ルートapply、ログイン、OAuth refresh、rotation、alias、alarmの
検証は再実施していない。その成功・失敗は前回の結果として区別する。

## 環境と検証範囲

- Flociは`floci/floci:2.2.0`、endpointは`http://floci:4566`。
  ヘルスチェックで版と正常起動を確認した。
- Flociサービスだけに`/var/run/docker.sock:/var/run/docker.sock`を共有。
  `FLOCI_HOSTNAME=floci`と`FLOCI_BASE_URL=http://floci:4566`を維持し、
  LambdaコンテナはComposeネットワークの自動検出を使用した。
- 診断用Lambdaで観測した実行環境はNode.js `24.21.0`、Amazon Linux 2023
  `2023.12.20260914`、Linux、ARM64、タスクディレクトリ`/var/task`。
  注入された`AWS_REGION`は`ap-northeast-1`、`AWS_ENDPOINT_URL`は`http://floci:4566`。
- Lambdaの定義では本番と同じ`nodejs24.x`・`x86_64`を指定したが、
  実際の診断用workerはARM64だった。現在の設定では本番CPUとの同等性を示さない。
- 既存ZIPのSHA-256は
  `e4f5a215942fe8aa4c58f755698564a491cd5a88b13b4810f8c20fdb0d52594c`。
  本番コード・ZIPを変更していない。
- 実行検証用のS3 bucketをversioning有効で作り、ZIPを固定versionにアップロード。
  HeadObjectのSHA-256とサイズ、API/cleanup Lambdaの`CodeSha256`一致を確認した。
- APIは512 MiB・10秒、cleanupは512 MiB・660秒とした。
  3つのDynamoDB tableは既存のキー構成に合わせ、画像jobには
  `cleanup_by_due` GSI、`KEYS_ONLY` projectionを作成した。
- リソース作成はSDK・制御APIで実施した。Terraform管理下のアプリ全体のデプロイではない。
  既存のproduction aliasを通じた実行、Schedulerによる起動、IAM・bucket policyの
  本番同等の適用も今回の検証対象外。
- 合成アカウント`000000000000`、ダミー認証情報、専用の`localsocket-*`接頭辞を使用。
  SDKのregion・endpoint・認証情報は呼び出し側で明示した。
  LambdaにはFlociに登録した検証用実行roleを使用した。
  実際の認証情報・設定ファイルを読んだり、環境変数全体を表示したりしていない。
- CRUDは、検証用に生成したGateway claimsを付けてLambdaを直接呼び出した。
  本物のCognito JWTをGatewayに通したCRUDの成功を示すものではない。
- 画像は公開PNG signatureと任意の4バイトを組み合わせた12バイトの合成データ。
  cleanupでは生成されたretired jobの期限だけを検証用に過去へ変更して、期限到来を再現した。
- 一時スクリプトと結果JSONは`/tmp/floci-socket-check`に保存。
  リビルドで消える。永続的な自動E2Eテストは追加していない。
- 実AWSの構築・デプロイ・実データ移行、GitHub Actionsの実行は行っていない。

## 診断用Lambdaの確認

次の4項目が成功した。

1. endpointで合成アカウントID`000000000000`を取得。
2. Dockerソケット経由でのLambda実行。
3. Node.js 24での実行。
4. SDK endpointが`http://floci:4566`として注入されること。

OSとCPUの観測結果は上記の環境欄に記載した。
公式AWS Lambdaイメージを用いる実行方式の根拠は、固定版の
[Lambda資料](https://github.com/floci-io/floci/blob/2.2.0/docs/services/lambda.md)を参照。
Flociは既定でDockerホストのアーキテクチャを使う。
宣言したCPUを選択するには`FLOCI_SERVICES_LAMBDA_HONOUR_ARCHITECTURES=true`が必要で、
異なるCPUを使う場合はホスト側にその実行環境が必要。本検証では設定を変更していない。

## 既存ZIPのDocker Lambda内検証

次の28項目が成功した。Gateway経由の正常GETはこの成功件数に含めない。

1. 既存ZIPのSHA-256一致。
2. S3の固定versionに保存したZIPのチェックサム・サイズ一致。
3. API・cleanup Lambdaが固定versionの既存ZIPを読み込むこと。
4. Lambda直接呼び出しの`/healthz`。
5. Gatewayの保護対象ルートでJWT欠落を401で拒否。
6. handlerでclaims欠落を401で拒否。
7. 公開markerなしの`/readyz`を503で拒否。
8. 公開markerありの`/readyz`が200となり、実DynamoDB/S3に接続すること。
9. DynamoDBトランザクションによるリマインダー作成。
10. 重複作成の拒否。
11. 一覧取得。
12. 個別取得とETag一致。
13. 別所有者からの取得の拒否。
14. If-Match欠落の428拒否。
15. 古いETagの412拒否。
16. 条件付き更新。
17. 同一ETagの並行更新が200・412となり、1件だけ成功すること。
18. 条件付き削除。
19. 削除済みリマインダーが取得できないこと。
20. tombstoneにより同じIDの再作成を拒否すること。
21. S3画像の固定version・SHA-256・バイト数とjobのコミット。
22. 固定versionを指定した有効期限900秒の署名付きURL。
23. 署名付きURLから元の画像バイト列を取得すること。ローカルDNS指定を使用。
24. 画像削除をretired jobとして予約すること。
25. cleanup LambdaによるGSIの期限検索とdelete marker作成。
26. 元の画像versionを残して削除すること。
27. cleanupの`CleanupHeartbeat`・`CleanupIncomplete`メトリクス送信。
28. cleanup jobが`done`になること。

cleanupの戻り値は`evaluated=1`、`deletes=1`、`incomplete=false`、
`skippedUnpublished=false`だった。

## Gatewayの400とアプリ入力検証

通常のGET `/healthz`と`/readyz`は、ともに
`400 INVALID_GATEWAY_EVENT`になった。起動失敗による502とは異なり、
今回はLambdaに到達し、アプリの入力検証によって拒否されている。

別の診断用Lambdaで公開GETルートのイベント構造だけを取得したところ、
`version=2.0`、`routeKey=GET /healthz`、API ID、stage、request ID、http情報が入り、
`body`は`null`だった。
固定版の[Gateway実装](https://github.com/floci-io/floci/blob/2.2.0/src/main/java/io/github/hectorvent/floci/services/apigateway/ApiGatewayExecuteController.java)でも、
`buildV2ProxyEvent`が本文なしの場合に`event.putNull("body")`を実行している。

修正前のアプリの[入力検証](../../src/api/event.ts)は、`body`が省略されておらず文字列でもない場合に
拒否していた。同じHTTP API v2イベントの`body`だけを変更して既存ZIPを直接呼ぶと、
次の結果となった。

| 入力 | 結果 |
| --- | --- |
| `body`省略 | 200 |
| `body: null` | 400 |
| `body: ""` | 200 |
| 通常のGateway GET | 400 |
| 原因調査用に本文を付けたGateway GET | 400。FlociのGET処理は本文を渡さず、やはり`body: null`になる。 |

この5条件の確認が成功した。本文付きGETが200になるという最初の診断の期待値は誤りで、
Flociの`handleGet`が本文を無視する実装を確認して訂正した。
通常GETの成功を作るための回避策として使っていない。

現時点で確定したのは、Flociのイベント形式とアプリの受け入れ条件の不一致。
AWSの[HTTP API payload資料](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-develop-integrations-lambda.html)の
例では`body`は文字列だが、本文なしで`null`になるかをこの例だけでは判断できない。
実AWSで同じ400が起こるかは今回未検証であり、Flociだけの不具合とは断定しない。
アプリで`body: null`を本文なしとして受け入れる修正は検討候補。
本番コードやZIP、認証・API ID・stageの検証は変更していない。

## 開発コンテナのS3名前解決

Lambda内のS3画像保存と署名付きURL生成は成功したが、開発コンテナからそのURLを
通常のfetchで取得すると、ローカルS3ホスト名の解決で失敗した。
個別のDNS確認では`floci`が`172.18.0.2`に解決される一方、
検証用bucketの`<bucket>.floci`は`ENOTFOUND`となった。

そのため、検証クライアントのHTTP接続時だけ、検証用bucketのホスト名を
`floci`と同じIPに名前解決した。署名付きURL、Hostヘッダー、queryの署名、
version ID、有効期限は変更していない。この接続でHTTP 200と元の12バイトを確認した。
本番のS3クライアントや開発コンテナのDNS・FW設定は変更していない。
通常のクライアントが名前解決の指定なしでダウンロードできることは未検証。

## 後片付け

失敗した探索的試行も含め、各試行の終了時に専用リソースを削除した。
最終のZIP実行検証では記録された後片付け12手順のエラーは0件。
最終確認で診断用Lambdaの自動作成log group 4件も削除した。

7つの専用接頭辞を照合した結果、検証用のLambda function、DynamoDB table、S3 bucket、
Gateway API、IAM role、log groupはいずれも残存0件だった。
後片付けのエラーは0件、Flociの最終ヘルスチェックは200。
CloudWatchの検証用メトリクスは削除APIがないため、エミュレーターのメモリ内に残り得る。

## 次の判断事項

- `body: null`の受け入れ条件は後続修正で見直し、Gatewayの通常GETが成功した。
  他の不正な型を引き続き拒否する回帰テストと、レート消費の挙動差も確認した。
- 本番と同じCPUを検証するなら、宣言した`x86_64`を実際に使う設定と
  Dockerホスト側の対応を確認する必要がある。
- Cognito issuer/JWKS接続、OAuth refresh、実際のrotation、cleanup alias、
  CloudWatch alarm差分は、ソケット共有で自動的には解消しない。
- 完全な認証付きE2Eは、同じ環境でTerraform、認証、Gateway、アプリ、refreshの
  一連の経路が通ってから成功と判断する。
