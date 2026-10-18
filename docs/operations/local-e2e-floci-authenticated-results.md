# Floci認証付きローカルE2Eの検証結果

2026-10-08更新。2026-10-07の診断結果は履歴として区別する。
実Hosted UI PKCEで発行したaccess tokenを使い、JWT authorizerを経由して
承認済みアプリZIPのCRUDとowner分離を検証する。実AWSやprivatefilesは使わない。

## 現行nativeコンテナの結果（2026-10-08）

`/_floci/health`はHTTP200、versionは`2.2.0-local-refresh.1-native`。
Node.js 24.21.0で次の3スクリプトを同時に指定したfresh実行はexit0、12件すべて成功、failure/error/skipなし。
transport 2件、refresh 9件とauthenticated CRUD 1件を含む。

```bash
PATH=/tmp/aws-sdd-tools/node_modules/.bin:/tmp/aws-sdd-tools/bin:$PATH \
  node --test tools/local-e2e/floci/local-transport.test.mjs \
  tools/local-e2e/floci/refresh.test.mjs tools/local-e2e/floci/authenticated-crud.test.mjs
```

CRUD内の18チェックはすべて成功。readiness 503→200、JWT未認証/改ざん/別clientの401、
ID tokenとread-onlyのscope拒否403、owner create/list/get、owner分離404、
missing If-Match 428、update/ETag、stale If-Match 412、refresh後read、delete/tombstoneを確認した。
11 cleanup actionはすべて成功、errorは0件。合成pool/API/Lambda/log group/IAM policy/role、
DynamoDB tables、S3 versions/delete markers/bucketを回収した。
証拠は`.superpowers/sdd/2026-10-07-floci-authenticated-e2e/logs/2026-10-08-current-native-e2e.log`。
現行イメージの認証付きCRUDはGREENであり、追加のホストリビルド待ちはない。

## readinessとroute選択の診断履歴（2026-10-07）

issuer設定反映後、Lambda fixtureの`AWS_ENDPOINT_URL=http://floci:4566` overrideにより
S3 HeadBucketがbucket hostnameのENOTFOUNDで停止した。overrideを除きFlociのprivate IP自動注入を使い、
owned bucketだけのListBucket権限を追加するとreadiness/auth/create/listを通過した。
アプリ、認証要件、production Terraformは変更していない。

scratch試行はowner GETで404/ROUTE_NOT_FOUND。修正済みdurable harnessは12チェック通過後の
missing If-Match期待で停止した。route走査順により停止箇所が変わった。
独立echoではGET/PATCHの同一templateがANYに一致しJWT contextなし、DELETEとliteral GET/POSTは
具体的methodのJWT routeに一致した。ANYを削除・並べ替えずFloci側のmethod優先修正で対応した。
診断echo 6回のcleanup 7 action、修正harnessのcleanup 11 actionはいずれもerror 0件。
証拠は同planの`logs/task-3-route-echo.log`、`logs/task-3-corrected-harness.log`。

## routing修正と検証（2026-10-08）

現行native imageのcombined `floci-refresh.patch`は、同じpath-template文字列に対して
要求methodの具体的routeをANYより優先する。異なるtemplate間の順序やJWT/scopes/application要件は保持。
root/appのpatchはbyte同一、SHA256は
`2d01320d2d559f610992e807e05989c2b17a3a37690e03ebbc816cb3b40e954a`。
固定base `17c99047b92b5729b356f3584513cd6ed598b8a9`のclean treeへcheck/applyが成功し、
全既存patched source/test/docsおよびrouting sourceがworktreeと一致した。

保存済み`ApiGatewayV2RoutingServiceTest`は修正前14件/4失敗→修正後14件/0失敗。
今回fresh実行も14件/0失敗/0error/0skip、Java 25のcheckstyleも成功した。
GET/PATCH/DELETEを両走査順で検証し、unknown-method ANY、literal exact、default/null、
case-insensitive method、別template維持を確認する。このunit testは追加local回帰であり、
現行patch内の`ApiGatewayV2RouteSelectionTest` 2件とは別で、combined patchには追加していない。
ログは同planの`logs/task-4-routing-{red,green}.log`、`logs/task-4-native-routing-green.log`、
`logs/task-4-native-checkstyle.log`、`logs/task-4-native-patch-proof.log`。
今回JVM/native package、全Floci Java suite、Docker依存Java試験は再実行していない。
アプリE2Eの成功から他のJava試験の成功を推定しない。

## 初期issuer診断の履歴（2026-10-07）

controllerが確認した変更前コンテナでは6チェックが成功し、有効access tokenによる
Gateway listが401となった。11 cleanup actionはすべて成功した。
この診断時点では設定を変更したコンテナの再作成とauthenticated CRUDの再実行は未実施だった。
これは当時のissuer設定での停止箇所であり、その時点ではアプリCRUDの成功・失敗を判定できなかった。
現在のfresh結果は先頭の2026-10-08節を参照する。

再実行用スクリプトと起動設定の独立レビューは、指摘修正後の再レビューも成功した。
通信先IPの固定とS3削除失敗時の継続を確認する回帰試験は2件すべて成功し、対象JavaScriptの
lintも成功。既存アプリのテスト337件も成功した。これらは、変更後コンテナのCRUD成功を示すものではない。

## issuer/JWKS設定

開発コンテナからの接続先は引き続き`http://floci:4566`。JWTのissuerとdiscovery内JWKS URLには、
Floci起動時に自hostnameから解決した一意なRFC1918 IPv4を使う。rootのread-only mount
`.devcontainer/floci/local-jwt-command.sh`が`FLOCI_HOSTNAME`と`FLOCI_BASE_URL`を揃えてから
現在のnative commandをexecする。public/loopback/不正/複数IPを拒否し、IPやsubnetは固定しない。
upstream entrypoint、権限処理、socket、healthcheck、既存refresh patchを維持する。

`FLOCI_SECURITY_ALLOW_PRIVATE_JWT_TARGETS=true`はFlociサービスにだけ設定する。
上流JWT verifierのHTTP例外はprivate literal IPを要求するので、DNS hostnameの`floci`だけでは
HTTP discovery/JWKSが許可されない。本番HTTPS、署名検証、アプリ認証要件を緩める変更ではない。
IPは再作成で変わる可能性があり、メモリ保存のpool/JWKS/token関連stateもリセットされる。
再作成後は旧tokenを使わず新しい合成poolとPKCE tokenを発行する。

## 独立したJWT診断

既存patched JVM artifactをJava25、heap上限1536MB、bind `127.0.0.1:4567`で順次起動した。
backendは`127.0.0.1:4568`の定数JSONサーバーで、実GatewayのHTTP_PROXY integrationを使用。
各ケースで実PKCE署名を実JWKS鍵で検証し、discovery issuer/JWKS URLとの一致も確認した。

| issuer設定（private-target flagは両ケースtrue） | 有効JWT | 未認証 | 署名改ざん | 別client |
| --- | --- | --- | --- | --- |
| `http://floci:4567/{pool}` | 401 | 401 | 401 | 401 |
| `http://127.0.0.1:4567/{pool}` | 200 | 401 | 401 | 401 |

両ケースhealthは200。owned API/poolはfinallyで削除し、JVMとbackendを停止、port4567/4568の
listenなしを確認した。probe exit0。loopbackはこの隔離診断だけのfixtureであり、実startup scriptは拒否する。
これはJWT authorizerのHTTP例外の確認で、実コンテナのLambda/DynamoDBアプリE2E成功を示さない。
証拠は`.superpowers/sdd/2026-10-07-floci-authenticated-e2e/logs/task-2-jwt-config-probe.log`。

起動scriptは実IPv4解決でenv一致・元Java引数を確認。11 fixtureでRFC1918と重複同IPの受理、
loopback/public/曖昧複数/空/不正/link-local/CGNATの拒否を確認した。
Compose YAML parse、mount/build source path、local-only flag、image/health/entrypoint保持も確認。
commandはbashとscript pathだけで`$`を含まず、shellの展開はmountしたscript内で行うためComposeの
`$$`escapingを要しない。native Docker Compose config/build/recreateはこの環境から実行していない。

## 今後の設定変更後の再試験

現行nativeイメージは反映・確認済み。今後Composeやimageを変更した場合は、
ホストのVS CodeでDev Containersをリビルドして設定を反映する。
Flociだけ再作成する場合はroot READMEの既存project名確認手順に従う。
scriptだけの変更はmountで反映し、Compose設定変更時はFlociを再作成する。
image内のpatch変更時はimage rebuildが必要。
その後、Node.js 24.21.0、アプリ依存と承認済み`artifacts/reminder-server.zip`がある実装worktreeで実行する。

```bash
cd /workspace  # 旧worktree /workspace/.worktrees/aws-sdd は2026-10-18に削除
export PATH=/tmp/aws-sdd-tools/node_modules/.bin:/tmp/aws-sdd-tools/bin:$PATH
node --version
node --test tools/local-e2e/floci/local-transport.test.mjs
node --test tools/local-e2e/floci/refresh.test.mjs
node --test tools/local-e2e/floci/authenticated-crud.test.mjs
```

一時Node配置が消えていればNode.js 24.21.0を復元する。既定の接続先は`http://floci:4566`で、
グローバルAWS endpoint/profile/実credentialを設定しない。
transportの2 fault test、refreshの9件とauthenticated CRUDの全チェック成功が期待結果。
途中失敗時は後続チェックを未実施として記録し、cleanup errorも確認する。

cleanupは作成済みの合成pool、API、Lambda/log group、IAM policy/role、DynamoDB table、S3 versionsと
delete markersを対象とし、S3の途中失敗時もbucket deletionを試行する。
JWT、本文、パスワードをログへ出さない。正常終了または試験失敗後のfinallyを使い、
cleanup errorがある場合はログの合成prefixで残存を調べる。

full Terraform apply、実AWS、Floci全Java suite、本番IAM/security policyとの同等性は確認していない。
Lambdaからdynamic issuer IPへの到達を含む現行実コンテナの認証付きCRUDは、2026-10-08のfresh実行で成功した。
