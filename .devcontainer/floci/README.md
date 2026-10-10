# ローカルFlociのOAuth refresh修正

Floci 2.2.0の公開ソースに`floci-refresh.patch`を適用し、公式`floci/floci`と同じ構成のnativeイメージ（Mandrel + ubi9-micro）を作る。
上流の基準コミットは`17c99047b92b5729b356f3584513cd6ed598b8a9`で固定している。
Dockerfile内でも取得したコミットを照合する。上流のライセンスは`LICENSE.floci`に保存した。

2026-10-07時点の[Floci本体の最新安定版](https://github.com/floci-io/floci/releases/tag/2.2.0)は2.2.0。
2.15.0はJava用の`io.floci:testcontainers-floci`モジュールのバージョンで、
本体のDockerイメージとは別に管理されている（[公式資料](https://floci.io/floci/testcontainers/)）。

本番アプリの認証要件は変更しない。OAuthの`refresh_token` grant、scopeの維持、
refresh token rotation、新tokenの発行、旧tokenの猶予期間後の拒否をFloci側で実装する。
また、HTTP APIのroute選択で同じpath templateに`ANY`と具体的なmethodがある場合、実AWSと同じく
具体的なmethodを優先する（上流は走査順で先に一致したrouteを返し、選択が実行ごとに変わる）。
Lambda AddPermissionでは、`SourceArn`と`SourceAccount`の両方を指定した場合に両方の条件を保持する（実AWSと同じ。上流は`SourceArn`があると`SourceAccount`を捨てていた）。片方だけの場合の動作は変えない。回帰テストは`LambdaServiceTest`の`addPermissionKeepsSourceArnAndSourceAccountOnQualifiedPolicy`と`addPermissionWithOnlySourceAccountKeepsOnlyStringEquals`。
Lambda ListVersionsByFunctionは、実AWSと同じ順序（`$LATEST`が先頭、続いて数値版を数値の昇順）で返す。上流はhash順のまま返しており、AWS providerが最後の要素を最新版として扱うため、aliasが`$LATEST`を指すことがあった。回帰テストは`LambdaServiceTest`の`listVersionsByFunctionReturnsLatestFirstThenNumericAscending`。
CloudWatchのPutMetricAlarm/DescribeAlarmsは`ExtendedStatistic`と`EvaluateLowSampleCountPercentile`を保存して返す（上流は両方を捨てていた。JSONとQueryの両handler、`MetricAlarm`が対象）。また、alarm evaluatorは`Statistic`がなく`ExtendedStatistic`だけを持つalarmで例外を投げず、評価を飛ばす（percentileの評価は実装していない）。回帰テストは`CloudWatchMetricsJsonHandlerTest`の`describeAlarms_keepsExtendedStatisticAndLowSampleCountPercentileWithoutStatistic`、`CloudWatchMetricsQueryHandlerTest`の`putMetricAlarmKeepsExtendedStatisticAndLowSampleCountPercentile`と`describeAlarmsReturnsExtendedStatisticAndLowSampleCountPercentileWithoutStatistic`、`AlarmEvaluatorTest`の`alarmWithOnlyExtendedStatisticIsSkippedWithoutThrowing`。
HTTP APIのexecute-apiは、`cors_configuration`がある場合、許可されたOriginの通常（preflightでない）レスポンスにも`access-control-allow-origin`、`vary: Origin`、`access-control-expose-headers`（`allowCredentials`がtrueなら`access-control-allow-credentials`も）を付ける。許可されないOriginには何も付けない（実AWSと同じ。上流はpreflightにしか付けていなかった）。また、HTTP APIのLambda event v2の`rawPath`を受信したままのpercent-encodingで渡し、route照合もencodedなpathで行い、`pathParameters`は1回だけdecodeする（上流はdecode済みのpathを渡し、`100%25`や`a%2Fb`で不一致や二重decodeが起きた）。回帰テストは`ApiGatewayPreflightRoutingIntegrationTest`の`httpApiActualResponse*`と`BuildV2ProxyEventPathParametersTest`の`rawPathKeepsPercentEncodingAndPathParametersAreDecodedOnce`、`greedyPathParameterIsDecodedOnceWithoutSplittingEncodedSlash`、`encodedRoutePathIsTakenFromRawRequestUri`。仮想ホスト形式（`{apiId}.execute-api.*`）のrequestはhost filterがURIを書き換えるとRESTEasy Reactiveがpathをdecode済みで保持するため、filterが書き換え前のraw pathを記録し、rawPathとroute照合にそのraw pathを使う。また`{proxy}`は`@Encoded`で受け取り、controllerで1回だけdecodeして二重decodeによる500を防ぐ。回帰テストは`ApiGatewayExecuteApiHostEncodedPathIntegrationTest`（`100%25`、`a%2Fb`、`%252F`をhost経由で送り、rawPathがencodedのままでpathParametersが1回だけdecodeされることを確認する）。
このパッチでissuer/JWKS接続や全AWSサービスの互換性を保証するものではない。

## ビルドと起動

Composeの`floci`は`floci-local:2.2.0-refresh.6-native`と、このディレクトリの`build`を指定している。
native-imageのビルドは数分〜十数分かかる。heap上限はbuild引数`NATIVE_IMAGE_XMX`（既定`6g`）で固定している。
未指定だとDocker VMのメモリを使い切り、開発コンテナのimage buildと並行した際に
`cannot allocate memory`で失敗した（Docker VM約12GB）。失敗する場合は下の手順でFlociだけを先にbuildする。
イメージにはJava、python3、AWS CLIは入らない（公式nativeイメージと同じ）。

### Dev Containersでリビルド（推奨）

VS Codeから開発コンテナをリビルドする。
現在の`devcontainer.json`は`runServices`を指定していないため、Dev Containers CLIは
サービスを絞らずComposeのbuildを実行し、Flociもビルドする。その後、同じprojectで起動する。
手動のproject指定や事前の`build floci`は不要。
この動作は[公式CLIの実装](https://github.com/devcontainers/cli/blob/main/src/spec-node/dockerCompose.ts)で確認した。

### Flociだけを手動で置き換える場合

ホストのリポジトリルートからDocker Composeで実行する。
開発コンテナへのDockerソケット共有は追加しない。
`docker compose ls`でこの開発環境の既存project名を確認し、下の変数へ設定する。

```bash
docker compose ls
FLOCI_COMPOSE_PROJECT="既存のプロジェクト名"
docker compose -p "$FLOCI_COMPOSE_PROJECT" -f .devcontainer/docker-compose.yml build floci
docker compose -p "$FLOCI_COMPOSE_PROJECT" -f .devcontainer/docker-compose.yml up -d --no-deps --no-build floci
```

Flociだけを置き換える上の方法では開発コンテナのリビルドは不要。
Flociはメモリ保存のため、置き換えるとローカル検証用リソースは消える。

ビルド時の取得先はGitHub、Maven Central、archive.apache.org（Maven本体）、Docker Hub、quay.io、
registry.access.redhat.com、Ubuntuパッケージ配布元で、ホストのDocker builderが接続する。開発コンテナ内でJavaテストを実行する場合は
`repo.maven.apache.org:443`へのFW許可が必要。

## 再現試験

実装worktreeに保存したNode.js試験を開発コンテナから実行する。
本文やJWT、パスワードはログに出力しない。検証用pool/user/clientを合成データで作り、
終了時に検証用poolを削除する。

```bash
cd /workspace/.worktrees/aws-sdd
PATH=/tmp/aws-sdd-tools/node_modules/.bin:/tmp/aws-sdd-tools/bin:$PATH \
  node --test tools/local-e2e/floci/refresh.test.mjs
```

既定の接続先は`http://floci:4566`。
Javaのローカル実行を検証する場合だけ`FLOCI_TEST_ENDPOINT=http://127.0.0.1:4567`も使える。
それ以外の接続先は試験が拒否する。実AWSには接続しない。

Java回帰テストはパッチ内の`CognitoRefreshTokenServiceTest`と`ApiGatewayV2RouteSelectionTest`に含める。
Lambda AddPermissionの回帰テストは上流既存の`LambdaServiceTest`へ追加している（`addPermission*`）。
FlociのソースでJava 25を使い、次のコマンドで実行する。

```bash
./mvnw -B -Dtest=CognitoRefreshTokenServiceTest test
./mvnw -B -Dtest=ApiGatewayV2RouteSelectionTest test
./mvnw -B -Dtest='LambdaServiceTest#addPermission*' test
./mvnw -B -Dtest='LambdaServiceTest#listVersionsByFunction*' test
./mvnw -B -Dtest='ApiGatewayPreflightRoutingIntegrationTest' test
./mvnw -B -Dtest=BuildV2ProxyEventPathParametersTest test
./mvnw -B -Dtest=ApiGatewayExecuteApiHostEncodedPathIntegrationTest test
./mvnw -B -Dtest='CloudWatchMetricsJsonHandlerTest#describeAlarms*' test
./mvnw -B -Dtest='CloudWatchMetricsQueryHandlerTest#putMetricAlarmKeepsExtendedStatistic*+describeAlarmsReturnsExtendedStatistic*' test
./mvnw -B -Dtest='AlarmEvaluatorTest#alarmWithOnlyExtendedStatistic*' test
./mvnw -B test
./mvnw -B checkstyle:check
```

## 切り戻し

Composeの`floci`を以前の公式イメージ設定へ戻す場合は、`build`を削除し、
`image`を`floci/floci:2.2.0`へ変更する。同時に追加した`command`と
`./floci/local-jwt-command.sh:/usr/local/bin/local-jwt-command.sh:ro`のmountを削除する。
`FLOCI_SECURITY_ALLOW_PRIVATE_JWT_TARGETS`を削除し、環境変数を
`FLOCI_HOSTNAME: floci`、`FLOCI_BASE_URL: http://floci:4566`へ戻してからFlociを再作成する。
公式nativeイメージは`/app/application`を起動するため、local issuer用の追加commandを残さない。
この切り戻しではrefresh修正とprivate literal issuer設定も失われ、以前の認証検証上の制限に戻る。
上流へのpushやPR、本番AWSへのデプロイは行わない。

## 過去の記録（今回の再開では2,280件/84件の原ログ未確認）

以下は以前の作業で記録された結果。今回のfresh検証は末尾の2026-10-08再確認節を参照する。
2,280件/84件のJava試験の原ログは今回未確認であり、現行combined patchのfresh回帰結果として扱わない。

2026-10-07にnativeビルドへ切り替え、ユーザーがDev Containersでリビルドした。
`http://floci:4566`のhealthは`2.2.0-local-refresh.1-native`でHTTP200。
公式SHASUMSで検証したNode.js 24.21.0で`local-transport` 2件、`refresh` 9件は成功した。
`authenticated-crud`は1回目のみ18チェック成功し、その後の4回は`GET`/`PATCH /v2/reminders/{id}`が
アプリの`ROUTE_NOT_FOUND`となり失敗した（cleanup errorは毎回0件）。
原因はnative化ではなく上流のAPI Gateway v2のroute選択で、`ConcurrentHashMap`の走査順で最初に
一致したrouteを返すため、試験が登録する`ANY /v2/reminders/{id}`（JWTなし）が
`GET /v2/reminders/{id}`（JWT）より先に選ばれることがある。実AWSでは具体的なmethodが優先される。
2026-10-08にこの修正を`floci-refresh.patch`へ追加した（同じtemplateでは具体的なmethodを`ANY`より優先）。
追加した`ApiGatewayV2RouteSelectionTest`は修正前に失敗し、修正後に2件成功した。
API Gateway関連2,280件のうち84件は失敗したが、修正前のコードでも同じ84件が失敗した。
いずれもDocker Lambda/WebSocketを使う試験で、この開発コンテナにDocker socketがないことによる。
修正入りnativeイメージ（`NATIVE_IMAGE_XMX=6g`）を再buildし、`local-transport` 2件、`refresh` 9件が成功した。
`authenticated-crud`は10回連続で18チェックすべて成功し、cleanup errorは毎回0件だった（修正前は5回中1回のみ成功）。
Docker Lambda/WebSocketを使う上流Java試験84件は、Docker socketのある環境では未実施。
アプリの認証付きCRUD E2Eは別の検証範囲であり、これら84件の成功を証明しない。
保存済みのCognito/JWT回帰1,123件とcheckstyleの原ログは2026-10-07付で、現行routing修正前の結果。
現行combined patchでの1,123件のfresh成功は今回確認していない。
以下はJVMイメージ時点の結果。

ホストでの初回buildはMaven Wrapper用の`unzip`不足で停止した。
builderのapt依存に`unzip`を追加し、ユーザーが再リビルド成功を確認した。

修正前の公式イメージは公開PKCE/refresh試験9件で想定どおり失敗した。
修正後はCognito/JWTのJava回帰1,123件（新規refresh回帰32件を含む）、checkstyle、
partition検査、JVM packageが成功。修正版JVMをloopbackで起動した公開endpointの9件も成功した。
全体Javaの一括実行は準備中に環境のメモリ使用量が約10GB/12GBへ増えたため停止した。
上流CIの全体試験は4分割であり、全サービスの全件成功は未確認。
起動したカスタムFlociのhealth HTTP200と、`http://floci:4566`に対する上の9件成功も確認済み。
コンテナ版の検証poolは終了時に削除した。ログはFlociコピーの`.task/blackbox-container-green.log`。
日本語報告書は実装worktreeの`docs/operations/local-e2e-floci-refresh-result.md`に保存した。

## ローカルJWT issuer/JWKSの設定

`http://floci:4566`は開発コンテナから使う固定のサービス接続先であり、JWTのissuerは
起動時に得たFloci自身のRFC1918 IPv4を使う。`local-jwt-command.sh`は自hostnameの
IPv4解決結果が1種類だけであることを確認し、`FLOCI_HOSTNAME`と`FLOCI_BASE_URL`を
同じIPへ設定して、公式nativeイメージと同じ引数で`/app/application`を起動する。
ubi9-microにはpython3やgetentがないため、IPは`/etc/hosts`の自hostname行からBashだけで取得する。public、loopback、不正な値、複数IPは拒否する。
IPやネットワークsubnetは固定しない。Lambdaコンテナも同じComposeネットワークから
このIPに接続する。2026-10-08の現行nativeコンテナで実Lambdaの認証付きCRUD成功を確認した。

Flociだけに`FLOCI_SECURITY_ALLOW_PRIVATE_JWT_TARGETS=true`を設定する。
上流のJWT verifierはHTTPのdiscovery/JWKSにprivate literal IPを要求するため、
このflagだけを追加しても`http://floci:4566`というDNS hostnameは許可されない。
これはローカル検証限定の設定で、本番のHTTPS/JWT検証要件や署名検証を変更しない。
upstream entrypointの権限・Docker socket処理とhealthcheckは維持し、scriptはread-only mountで
明示的にbashから実行する。scriptの実行権限に依存せず、imageの再buildも不要。

### 設定反映後の試験

ホストのVS CodeからDev Containersをリビルドし、Flociの新しいCompose commandを反映する。
手動なら上記と同じ既存projectで`up -d --no-deps --no-build --force-recreate floci`を実行する。
IPはコンテナ再作成で変わる可能性がある。メモリ保存のpool、JWKS、APIなども消えるので、
旧JWTやrefresh tokenを使い回さず、下の試験で合成リソースとtokenを新規発行する。

Node.js 24.21.0とアプリ依存、承認済みの`artifacts/reminder-server.zip`を用意した実装worktreeで実行する。
現在の一時Node/Python配置が残っている場合のコマンドは次のとおり。

```bash
cd /workspace/.worktrees/aws-sdd
export PATH=/tmp/aws-sdd-tools/node_modules/.bin:/tmp/aws-sdd-tools/bin:$PATH
node --version
node --test tools/local-e2e/floci/local-transport.test.mjs
node --test tools/local-e2e/floci/refresh.test.mjs
node --test tools/local-e2e/floci/authenticated-crud.test.mjs
```

一時配置が消えた場合はNode.js 24.21.0を復元してから実行する。
`local-transport`の2件はIPv4接続固定とS3削除途中失敗の回収を検証する。
`authenticated-crud`は実Hosted UI PKCE、実JWKS、Gateway JWT authorizer、Docker Lambdaと
DynamoDB/S3を使い、access tokenによるCRUDとowner分離を検証する。
試験終了時は合成pool、API、Lambda、log group、IAM policy/role、table、S3のversions/delete markersを
回収する。cleanup errorが出た場合は成功と扱わず、試験の合成prefixの残存リソースだけを確認する。
JWT、パスワードや個人データをログに出さない。

### JWT設定の診断履歴（2026-10-07）

設定変更前のコンテナはauthenticated CRUDの6チェックを通過し、有効access tokenでの
Gateway listが401となった。11 cleanup actionは成功した。この段階では変更後のCRUDは未実行だった。

別の127.0.0.1:4567 JVM診断では、署名済みPKCE tokenと実discovery/JWKSを確認したうえで、
DNS issuerは401、private literal issuer＋flagはHTTP_PROXY backendへ200で到達した。
未認証、署名改ざん、別clientのtokenはすべて401だった。診断用API/poolは削除しJVMを停止した。
この診断はDocker LambdaのアプリCRUD成功を示すものではない。
起動scriptのIPv4/env/Java引数と拒否ケース、Compose YAML/mountを確認済み。
この開発コンテナにDocker CLI/socketはないためnative `docker compose config`とホストの再作成は未実行。

### 現行nativeコンテナの再確認（2026-10-08）

`/_floci/health`はHTTP200、versionは`2.2.0-local-refresh.1-native`。
Node.js 24.21.0でtransport 2件、refresh 9件、authenticated CRUD 1件の合計12件が成功した。
CRUD内の18チェックはすべて成功し、cleanup 11 actionはすべて成功、errorは0件。
missing/forged/wrong-client JWT、scope制限、owner分離、If-Match、refresh後read、delete/tombstoneを確認した。
証拠は実装worktreeの`.superpowers/sdd/2026-10-07-floci-authenticated-e2e/logs/2026-10-08-current-native-e2e.log`。
現在の設定について追加のホストリビルド待ちはない。

現行`floci-refresh.patch`はOAuthと同一templateのmethod優先修正を含み、root/appのコピーは同一。
SHA256は`2d01320d2d559f610992e807e05989c2b17a3a37690e03ebbc816cb3b40e954a`。
固定2.2.0コミットのclean treeへ適用し、routing sourceが検証用worktreeと同一であることを確認した。
既存patch内の`ApiGatewayV2RouteSelectionTest` 2件とは別に、worktreeの
`ApiGatewayV2RoutingServiceTest`でGET/PATCH/DELETEの両走査順、未知method、literal/default/null、
別template維持など14件が成功した。この追加unit testは現行combined patchに含めていない。
Java 25のfresh checkstyleも成功した。今回、全Java suiteやJVM/native packageは再実行していない。

詳細は実装worktreeの`docs/operations/local-e2e-floci-authenticated-results.md`を参照。
full Terraform apply、実AWS、本番security policyとの同等性、Floci全Java suiteは検証対象外。
