# 本番applicationの引き渡し

このrootは、HTTP APIとdefault stage、ZIPの2つのLambda関数と本番alias、専用のcleanup schedule/group、Schedulerのinline Invoke grant、9つのalarmを所有する。bootstrapは、3つのruntime roleすべてと、そのtrustおよびpermissionsの上限を所有する。platformは、table/images/log groupと、API/cleanupのinline policyを所有する。roleをimportしない。managed policyをattachしない。他のrootのstateを読まない。私的なinput fileで渡すのは、allowlistにあるoutputだけとする。

通常のreleaseには、`operator_api_seed=false`、このrootの既存APIと一致するnullでないbootstrapの`production_api_id`、登録済みでimmutableな `artifact` objectが必要である。D02の `versionId` は`artifact.version_id` に、`sha256Base64` は `artifact.sha256_base64` に対応させる。`bucket` と `key` は正確にそのまま保つ。D02の登録は、keyとhashのencodingを検証する。両方の関数のAWSの `CodeSha256` は、apply の後の検証（`scripts/release/verify-release.ts`）が、公開したversionごとにそのdigestと照合する。AWS providerはコードを更新するplanでも `code_sha256` を前のZIPの値のまま出すので、Terraformのpostconditionでは照合しない。予約済みの `AWS_REGION` は、Lambdaが自ら管理する。公開するoutputは、`api_base_url`、`api_id`、`api_alias_arn`、`cleanup_alias_arn`、`api_version`、`cleanup_version`、`release_sha256_base64`、`scheduler_enabled` の8つである。

`scheduler_enabled` の既定値はfalseである。trueにするのは公開時だけとする。trueにすると、同じplanで、Schedulerと、heartbeatのmissing-data/actionsの両方が有効になる。公開前のheartbeatは、`notBreaching` と無効にしたactionsを使う。metricの閾値は残るため、これでCloudWatchの評価engine全体が止まるわけではない。SNS/DLQやFunction URLは作成しない。runtimeのsource IPは、任意で指定する、literalなIPv4/IPv6 addressのlistである。`runtime_limits` が受け付けるのは、loadConfigの5つの環境変数keyと、正のsafe integerの値だけである。値はruntimeの既定値より大きくても小さくてもよい。Terraformは各値を10進の文字列に変換する。

## 例外的なoperatorの準備（ローカルのdeliveryでは実施しない）

最初のAPIは、このapplicationと同じresource address `aws_apigatewayv2_api.production` から作成しなければならない。これは別途承認されるoperatorの操作であり、operatorのcredentialと、application自身に設定したS3 backend/stateを使う。GHAには `/apis` のroot collectionを作成するgrantがなく、seedはできない。

1. target操作であっても、`variables.tf` の必須変数を**すべて**与える。targetを指定しても、rootの必須inputの契約はなくならない。allowlistにあるplatform/bootstrapの値を使う。最初のZIPを登録する前は、Terraformの必須変数のvalidationを満たすためだけに、次の明示的に**UNUSEDなseed専用**のartifact
   descriptorを与える。そのbucketには、既知のbootstrap artifact bucketを設定する。このdescriptorは、検証済み/upload済みのどのobjectも指さない。

   ```hcl
   artifact = {
     bucket        = "<BOOTSTRAP_ARTIFACT_BUCKET>"
     key           = "releases/0000000000000000000000000000000000000000000000000000000000000000/reminder-server.zip"
     version_id    = "operator-api-seed-unused"
     sha256_base64 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
   }
   ```

   これはRegisteredArtifactではなく、ZIPの証拠でもない。targetとするAPIは、Lambda/S3のartifactに依存しない。このdescriptorを、通常のrelease artifactとして登録、検証、upload、HEAD、再利用してはならない。applicationのstate keyとbackendは、`backend.hcl.example` で設定する。applicationのstateにAPIがなく、bootstrapのAPI IDがnullであることを確認する。APIが既に存在する場合は、中止して所有とstateを整合させる。再度のseed、APIの置き換え、名前/IDの変更、2つ目のrootの作成を決してしてはならない。引き渡しを回避するためにstateを削除することも、決してしてはならない。私的なoperatorのinput fileで、`operator_api_seed=true`、`production_api_id=null`、`scheduler_enabled=false` を設定する。
2. リポジトリのrootから、私的なsaved planを用意する。

   ```sh
   terraform -chdir=infra/application/production init -backend-config=/private/application-backend.hcl
   terraform -chdir=infra/application/production plan -var-file=/private/operator-inputs.tfvars.json -target=aws_apigatewayv2_api.production -out=/private/operator-api-seed.tfplan
   ```

   planは私的にレビューする。resourceの変更は、`aws_apigatewayv2_api.production` の作成**だけ**でなければならない（stage、function、role、policy、schedule、alarmは含まない）。LambdaやS3のartifactの操作も含まない。このresourceが依存するのは、明示的なinputとprovider設定だけである。LambdaのAPI-ID環境変数の参照は、逆の方向を指す。targetの指定は例外であり、通常のreleaseの経路では決して使ってはならない。
3. 別途のoperatorの承認を得た後にだけ、そのsaved planをそのままapplyし、outputを私的に取得する。

   ```sh
   terraform -chdir=infra/application/production apply /private/operator-api-seed.tfplan
   terraform -chdir=infra/application/production output -raw api_id
   ```

   このIDを、bootstrapの明示的な `production_api_id` inputに渡す。bootstrapのoperatorによる変更は、GHAに、そのAPIと子ARNだけの管理を許可する。このapplicationのAPIは、元のstate/addressに置いたままにする。bootstrapへimportやmoveをしない。destroyと置き換えは、APIとdefault stageの両方の`prevent_destroy` で保護されている。
4. 私的なseed flagとplanを削除する。通常のreleaseのinputでは、`operator_api_seed=false` を明示的に設定し、この時点でnullでなくなった、bootstrapの一致するIDを使わなければならない。UNUSEDなseed専用descriptorは破棄する。ここからは、applicationのpreviewが実際のZIPをbuildして登録する。通常のplanには、その検証済みのRegisteredArtifactが必要である。Lambdaのpreconditionは、root全体のseedを拒否する。APIのpostconditionは、通常時の不一致を拒否する。変数のvalidationは、IDの欠落や不正な形式を拒否する。D06/D07は、plan/applyの前に、既知の既存APIのbaselineも確認しなければならない。通常時のAPIの作成/削除/置き換えと、不明なIDのoutputを拒否し、plan時と最終のIDをbootstrapと照合する。計算されるIDのpostconditionだけでは、作成後まで判定が先送りされることがあり、このguardの代わりにはならない。seed flagを黙って有効にしたり、GHAにroot collectionの権限を追加したりすることは、決してしてはならない。

上のコマンドはすべて、別途承認される実際のoperator操作のための文書である。ローカルの実装が実行するのは、backendを使わないinit、validate、mockのTerraform試験だけである。ローカルのtaskから、seed/apply/AWSを実行してはならない。backend/input/state/planの各ファイル、artifact manifest、credentialは私的に保ち、Git、ログ、公開artifactに入れない。リポジトリのignore/guardの契約は、D08が提供する。
