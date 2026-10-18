# body:nullの互換性修正とFloci再検証 — 2026-10-07

## 結果

HTTP API v2イベントの`body: null`を本文なしとして扱う修正を実施した。
Flociの通常GET `/healthz`は200、`/readyz`は未公開時503・公開後200になった。
修正後ZIPを使ったローカル結合検証は31項目が成功した。

全Nodeテスト337件、Python packagingテスト3件、型検査、lint、build、package、
ZIP検証、3ルートのbackendなしTerraform検証、runtime/all auditが成功した。
ただし、Cognitoのissuer・refresh・rotationなどの既知の課題は今回の対象外であり、
完全な認証付きE2Eの成功を示すものではない。

修正前の実測は[Dockerソケット共有後の初回報告](local-e2e-floci-docker-results.md)を参照。

## 修正内容

[src/api/event.ts](../../src/api/event.ts)のイベント入力境界だけを変更した。

- `body`の省略と文字列に加えて`null`を受け入れる。
- `null`は内部の`GatewayRequest.body`で`undefined`に正規化する。
- 空文字列と既存の文字列本文は変更しない。
- 数値、boolean、配列、objectなどの本文型は引き続き400で拒否する。
- API ID、stage、HTTP API v2形式、JWT・scope・所有者境界の検証を維持する。
- JSON本文を必要とする書き込み処理では、本文なしをJSONとして受け入れない。

修正はソース2か所に限定した。本番コードからFlociを判別する処理や、
認証を回避する処理、Terraform・devcontainerの追加変更はない。

## 本番への影響とクライアントの条件

今回の変更で、修正前と異なる動作が起こり得る。
有効なJWTを持つ`body: null`のPOSTは、以前はイベント構造の検証で
`400 INVALID_GATEWAY_EVENT`になった。
修正後は認証・レート制限・公開状態の確認を経て、公開済みなら
`400 INVALID_JSON`になる。その途中でレートカウンターを1回消費する。
公開状態や認証の条件によって、返すステータスも従来と異なり得る。

回帰テストでは、認証済みの本文省略・`null`・空文字列のPOSTがいずれも
`400 INVALID_JSON`となり、レートカウンターを1回消費し、
リマインダーを作成しないことを確認した。
認証なしの保護対象GETは401で拒否し、レートカウンターも消費しない。

仕様どおりJSON本文を送るPOST/PATCHなど、正常なクライアントの通常利用では
この本文なし書き込みの挙動差は影響しない。
「どのような入力でも修正前と同じ動作」という意味で無視できるわけではない。
`body: null`はGatewayが作るリクエストイベントの値であり、Flociでは
正常な本文なしGETでも生成される。今回の修正はそのGETを正常に扱う。

### 実AWSがbody:nullを生成するか

本番のHTTP API v2で本文なしの場合に`body: null`が必ず、または実際に生成されるとは
今回確認できていない。実AWSへの構築・呼び出しは行っていない。

公式AWS Powertoolsの
[TypeScriptスキーマ](https://github.com/aws-powertools/powertools-lambda-typescript/blob/main/packages/parser/src/schemas/api-gatewayv2.ts)は
`body: z.string().optional()`で、文字列または省略を想定している。
一方、公式の
[Pythonモデル](https://github.com/aws-powertools/powertools-lambda-python/blob/develop/aws_lambda_powertools/utilities/parser/models/apigwv2.py)は
`body`をOptional型として`None`も受け入れる。
モデルが受け入れることは、AWSが実際にその値を送る証明ではない。
したがって、今回の修正を「実AWSで再現した本番不具合の修正」とは位置づけない。
Flociで観測した形式差を吸収し、本文なしの表現を正規化する互換性修正とする。

## 回帰テスト

[boundaries.test.ts](../../tests/runtime/boundaries.test.ts)と
[api.test.ts](../../tests/runtime/api.test.ts)に6件を追加した。

1. `null`と本文省略の正規化、文字列本文の維持。
2. 他の本文型、異なるAPI ID・stageの拒否。
3. 認証済み書き込みの`null`本文をJSON不正として拒否。
4. 認証なしの公開health/readiness GETが`null`本文でも成功。
5. 保護対象GETは`null`本文でも認証が必要で、未認証ではレート消費なし。
6. 本文なしPOSTではデータを作成せず、既存の本文省略・空文字と同じレート消費になること。

本番コードの変更前に6件を実行し、5件が今回の不具合により失敗、
不正な型・ID・stageの拒否は1件成功した。
修正後は境界・APIの対象ファイル44件すべてが成功。
レート消費の比較確認を加えた後も、追加6件はすべて成功した。

## 検証結果

| 確認 | 結果 |
| --- | --- |
| Node.js / npm | 指定版24.21.0 / 11.11.1。 |
| Python / Terraform | 指定版3.13.16 / 1.16.5。 |
| npm ci | 固定依存を導入。脆弱性0件。 |
| typecheck / lint | 成功。 |
| build / package / verify:zip | 成功。単独ロード、サイズ、ハッシュの整合を確認。 |
| npm test | runtime 166、operations 74、delivery 97、計337件成功、失敗0件。 |
| Python packaging | 3件成功。 |
| infra:check | 3ルートのbackendなしinit・validate・provider schema・mock testとfmtが成功。AWS providerは固定6.67.0。 |
| audit:runtime / audit:all | ともに脆弱性0件。 |
| SBOM | CycloneDXで再生成。 |
| 実装worktreeのdevcontainer差分 | 既存の承認済み起点からの差分なし。ルート側の共有設定は変更していない。 |
| Flociローカル結合検証 | 31項目成功、失敗0件、後片付けエラー0件。 |

`npm ci`では固定版`eslint@9.39.0`のサポート終了警告が出た。
依存更新は本修正では行っていない。
Terraform確認ではリビルド前の`/tmp`を指すproviderキャッシュのリンクが切れていた。
存在しない生成キャッシュへのリンクだけを解除し、Terraformが確認したproviderを
共通の一時キャッシュに置いて再検証した。Terraform定義・stateは編集していない。

修正後ZIPのSHA-256:
`6d3780c466a142039876a02f4ec99e389da874a8e9b22508ff90d1a194913915`。

- SHA-256 Base64: `bTeAxGahQgOYdqAvTsmeOJ2odKjpsiUI/5DRoZSRORU=`。
- 圧縮サイズ: 1,387,098バイト。
- 展開サイズ: 8,900,835バイト。

## Floci再検証

修正後ZIPを検証専用S3 bucketの固定versionに保存し、
HeadObjectのチェックサム・サイズとAPI/cleanup Lambdaの`CodeSha256`一致を確認した。
Docker Lambdaで既存handlerを実行し、[前回の28項目](local-e2e-floci-docker-results.md)に加えて、
次の3項目を成功条件として確認した。

| 通常の本文なしGET | 修正前 | 修正後 |
| --- | --- | --- |
| Gateway `/healthz` | 400 | 200、`healthy=true`。 |
| Gateway `/readyz`・未公開 | 400 | 503。 |
| Gateway `/readyz`・公開済み | 400 | 200、`ready=true`。実DynamoDB/S3への接続を含む。 |

検証用に本文を付けたり、Flociのイベントを変換するLambdaを挟んだりしていない。
Gatewayの保護対象ルートでJWTなしのリクエストは引き続き401となった。
CRUD・所有者分離・ETag・S3画像・cleanup・メトリクス送信も再確認した。
cleanupの戻り値は`evaluated=1`、`deletes=1`、`incomplete=false`、
`skippedUnpublished=false`。

CRUD部分は合成Gateway claimsによるLambda直接呼び出し。
実Cognitoトークンを通す認証付きCRUDの検証ではない。
S3署名付きURLの取得には前回と同じ検証クライアント限定のDNS指定を使い、
URL・Hostヘッダー・署名は変更していない。
Terraform全体のapply、Scheduler、aliasの不変性、IAM・bucket policyの適用、
`x86_64`の実行、Cognito refresh/rotationの同等性は未検証。

## 後片付けと作業範囲

修正後の検証用リソースは12手順で削除し、エラーは0件。
前回分を含む8つの専用接頭辞を照合し、Lambda、DynamoDB、S3、Gateway、IAM role、
log groupの残存は0件。Flociの最終ヘルスチェックは200。
CloudWatchの合成メトリクスはエミュレーターのメモリに残り得る。

スクリプトと実測JSONは`/tmp/floci-socket-check`にあり、リビルドすると消える。
ソースの回帰テストと本報告書は実装worktreeに保存した。
実AWSへの構築・デプロイ・実データ移行、GitHub Actionsの実行は行っていない。
