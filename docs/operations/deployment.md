# 本番配布

これらの手順は、将来、別途承認を得て行うAWS操作を記述する。ローカルの実装では、Actionsの実行、リソースの作成、実ZIPの登録、APIのseed、データの移行、デプロイのいずれも行っていない。bootstrap/operatorの認証情報はoperatorが私的に保管する。repository secretやworkflow入力には決して置かない。本番は唯一の恒久的な環境である。

## 初回のdispatchの前に

配布は**private repositoryのみ**に対応する。authorize jobは、public
repository、main以外からのdispatch、main外のcommitを、build、OIDC、private artifactの転送より前に拒否する。この制限はrepositoryの公開設定を変更しない。現在のrepositoryの公開設定について何かを主張するものでもない。private Actions artifactには、承認されたrepositoryの閲覧者がアクセスできる。environmentのreviewerだけに限定されるわけではない。repositoryの閲覧・collaborator権限をそれに応じて制限し、artifactの保持は1日とし、ローカルにダウンロードしたレビュー用のファイルは使用後に削除する。private planやartifactにアクセスできる間は、決してrepositoryをpublicにしない。期限切れのレビューartifactには新しいpreviewが必要である。workflowは任意のローカルJSONやアップロードからapplyできない。

3つのenvironment `production-artifact`、`production-plan`、`production` を設定し、いずれもdeployment branchをmainに限定する。account planがこれらの保護に対応している場合は、`production` でrequired reviewersとprevent self-reviewを使用する。AWS OIDCのsubjectは、これらのenvironment名と正確に一致しなければならない。bootstrapの明示的な `oidc_subjects.artifact`、`.plan`、`.apply` には、それぞれ正確に `repo:<repository>:environment:production-artifact`、`repo:<repository>:environment:production-plan`、`repo:<repository>:environment:production` を設定する。bootstrapは、branch/tagのsubject、余分なrole、environmentを1つにまとめた構成を拒否する。bootstrapのexampleのplaceholderはデプロイ用の値ではない。GitHubのenvironmentと保護機能の利用可否はrepositoryのplanによって異なる。配布を有効にする前に、利用できる制御を確認する。operatorに代わってこれらの制御を設定・保証できるworkflowはない。

repository variableの `AWS_REGION`、`AWS_ACCOUNT_ID`、`STATE_BUCKET`、`ARTIFACT_BUCKET`、`ARTIFACT_ROLE_ARN`、`PLAN_ROLE_ARN`、`APPLY_ROLE_ARN` を、レビュー済みのbootstrap outputから設定する。state bucketの識別名は`<name_prefix>-<account_id>-<region>-state` に固定である。backendのkey、暗号化、S3ネイティブの`use_lockfile` は各rootで固定されている。各AWS jobはOIDCで指定されたroleだけをassumeし、想定するaccountであることを確認する。長期間有効なkeyはない。workflowはbootstrapのapply用認証情報を扱わず、自身のAPI権限を拡大することもない。

`production-plan` には、JSON objectを格納したprivate secretを設定する。

- `PLATFORM_INPUTS_JSON`: `infra/platform/production/terraform.tfvars.example` にある必須のplatform変数すべて。実際のレビュー済みのorigin、完全なcallback/logout URL、region/account/prefix、bootstrapのroleを含む。
- `APPLICATION_INPUTS_JSON`: account、region、prefix、正確なorigin、bootstrapの`scheduler_role_arn`、nullでないbootstrapの `production_api_id`。任意で`allowed_source_ips` と `runtime_limits` を含めてよい。platformの項目は実行時に実際の値を読み取り、allowlistで選別してprivate input fileに入れる。重複して与えた値は一致しなければならない。artifactとseed/schedulerのflagはrelease driverが固定する。
- `PLATFORM_BASELINE_JSON`: 保護されたCognitoを本当に初めて作成するときに限り、リテラルのJSON `null`。それ以降は、下記の既知のplatform baselineを入れる。
- `APPLICATION_BASELINE_JSON`: API-onlyのseed後の既知のapplication baseline。通常の配布では決してnullにしてはならない。

baselineのschemaは `{root, apiBaseUrl, apiId, cognitoIssuer, cognitoClientId,
cognitoAuthBaseUrl}` である。`root` は `platform` または `application` である。platformではAPIの項目がnullでもよいが、作成後はCognitoのidentity/domainが既知でなければならない。applicationでは、すべてのidentity/URLが既知であり、API IDがbootstrapのhandoffおよび既存のapplication stateと一致しなければならない。account、region、origin、redirectの値は明示する。secretやoutputを別のaccountから推測することはない。

## 初回の手順

1. 別途承認を得たoperatorが、`production_api_id=null` でbootstrap rootを作成し、bootstrapとしてレビューする。このrootは、暗号化とversioningを有効にした3つの別々のbucket、boundary、runtime role、範囲を限定した3つのOIDC roleを所有する。API IDがnullの間、GitHubにはHTTP APIの作成・管理の権限が一切与えられない。そのprivate outputから、上記のenvironmentとvariableを設定する。
2. `target=platform`、`apply=false`、main上の完全なimmutable commit、明示的なnullのplatform baselineでpreviewする。この段階ではZIPのbuildも登録も**行わない**。下記の2回のrunによるgateでレビューしてapplyする。既存のpool/client/domainがある場合、null baselineは拒否される。null baselineはリセットやadoptionの抜け道ではない。初回のapply後、driverは実際のstate上のリソースidentityを、保存したregion/domainの入力と照合し、既知のoutputを検証して `post-baseline.json` を書き出す。以後のplanの前に、その既知のplatform baselineを設定する。platformは、Lambdaのデプロイより前にAPI/cleanupのpolicyとlog groupを用意する。
3. 別途承認を得たoperatorが、application所有の`aws_apigatewayv2_api.production` **だけ**を、正確な[API-only seed手順](../../infra/application/production/README.md)でseedする。rootの変数はすべて引き続き必須である。実ZIPが存在する前の段階では、明示的にUNUSEDとしたseed専用のdescriptorに、既知のbootstrap artifact bucket、64個のゼロからなるhexのrelease key、`operator-api-seed-unused` というversion、zero32のBase64を入れる。これはRegisteredArtifactでも検証済みZIPでもない。対象を限定したsaved planをレビューする。API作成だけを含み、stage・Lambda・S3 artifactの操作を含まないこと。root全体のseedは拒否され、schedulerは無効であり、GHAによるseedの経路は存在しない。
4. 実際のAPI ID/URLを私的に控え、別途レビューされたoperatorの変更で既知のIDをbootstrapへ戻し、platformのCognito identity/domainとともに既知のapplication
   baselineを設定する。APIは元のapplication state/addressのまま保持する。seed flagとダミーのdescriptorは破棄する。通常の配布には`operator_api_seed=false` と実際のimmutable ZIPが必要である。
5. `target=application`、`apply=false`、`reviewed_run` を空、`scheduler_enabled=false` でpreviewする。これはbuild/packageを一度だけ行い、生成したZIPを検証し、ローカル試験と静的なTerraform検査を実行し、監査を行い、CycloneDXのSBOMを生成する。検証が済んだ後でのみ、登録roleがZIPを登録し、その完全なmanifest/evidenceのhashを永続化する。planはその選択したS3のkey/version/checksumを使い、seed済みのAPIを必須とし、最初の`$default` stageを作成できる。通常のplanはAPIを作成・置換・削除できない。
6. 下記の手順でレビューしてapplyする。既定の `published=false` では `/readyz=503` を期待する。workflowは公開データを一切変更しない。移行・公開とCognito
   consoleでのuser操作は、それぞれ別途承認されたoperator手順に従う。管理者専用でIAMにより制御されたpassword認証を使うClassic Hosted UIは、実AWSでのlogin、PKCE、公開経路からの直接認証の拒否について、受け入れ確認がまだ必要である。mockの検査では実環境での互換性は確立されない。

## レビューとapply

GitHubの手動Run workflow UIを `main` で使い、mainから到達可能な40桁hexの完全なimmutable
commitを指定し、previewでは `apply=false` のままにする。checkoutはその正確なcommitを使う。PRでのOIDC、`pull_request_target`、pushによる自動デプロイ、maintenance workflow、user管理workflowはいずれも存在しない。

成功したpreviewの**private**な `release-review` artifactを、期限切れになる前にレビューする。保存されたbinaryを対応するTerraform versionで確認し、そのbinaryから導出した `plan.json`、正確な `inputs.json`、baseline、root、登録済みartifact/evidence（applicationのみ）、schedulerと公開の期待値を含む `request.json` を確認する。公開summaryに出るのはroot、commit、actionの件数、`review_sha256` だけであり、plan・state・inputの生の内容は出ない。

applyは毎回2回目のdispatchを使う。environment reviewerを利用できる場合も同じである。同じtarget/commit/inputとflag、`apply=true`、`reviewed_run=<successful original preview run ID>`、`expected_review_sha256=<reviewed digest>` を設定する。参照元は、このprivate
repositoryの、完了して成功したmainでの手動deployment workflowでなければならず、apply runではなくpreviewとして記録されていなければならない。application applyはbuild/登録をskipし、元のRegisteredArtifactと、hashを検査した監査・SBOM・試験のfileを再利用する。HEADで、固定したS3のversion/size/checksumを再確認する。

そのrunは、レビュー済みの入力bytesとbaselineを正確に使って新しいsaved planを1つ作成し、保護する。review digestから除外するのは、Terraformのroot timestampだけである。driftその他のレビューとの差異があれば配布を停止する。初回作成の場合も同じである。実際の初回作成のpreviewどうしでは、unknownのIDが異なることがある。review
digestが変わった場合は、比較を緩めるのではなく新しいpreviewをレビューする。`production` environmentは、**現在のrun**のplanをレビューした後でのみ承認する。required reviewerの制御を利用できない場合は、必須のdigestと成功した元のpreviewが、operatorの手動gateとして残る。workflowのdispatchと、repository/environmentの設定権限をそれに応じて制限する。

apply jobは、`needs` 依存関係により**このrun**のsaved binaryを使う。artifactのダウンロード権限をprivate directory 0700/file 0600に戻し、plan jobのcustody SHAと、private fileの正確なhash、現在のcheckout、root、入力bytes、baseline、artifactを検査する。まったく同じbinaryからJSONを再生成してD06の `verifySavedPlan` にかけ、その後、そのbinaryをネイティブのstate
lockと5分のlock timeoutでapplyする。再plan、再build、登録は決して行わない。privateなbackendのデータは束縛されたaccount/region/prefixから導出され、両rootの固定keyは別々である。productionのconcurrencyは、rootとjobをまたいで `cancel-in-progress=false` である。新しいrunが、実行中または承認待ちのapplyをcancelすることはできない。保留中のrunはGitHubのconcurrency queueによって置き換えられることがある。run statusを確認し、必要なら新しいレビューをdispatchする。applyを手動でcancelしてはならない。

apply後、rootが所有するidentityのoutputを検証する。初回のplatform作成で既知になったbaselineも含む。applicationではさらに、2つのproduction
aliasが選択したpublished versionを指し、AWS CodeSha256が登録済みZIPのdigestと等しいことを検証し、その後statusだけを見るGETを確認する。`/healthz=200`、`/readyz=200`
（公開時。未公開時は503）、認証なしの `/v2/reminders=401/403` である。smokeでの書き込みや、tokenやbodyのログ出力は行わない。成功ledgerはすべての検査が済んだ後でのみ書き込まれ、commit/root/review/artifact digest、2つのversion、API URL、結果を含む。userデータは含まない。`release-result` は1日間privateのまま保持する。部分的なapply、または証明・smokeの失敗は成功ではない。次のreleaseの前に、operatorの承認済み復旧手順に従ってprivateなoutput/stateを確認する。

## scheduleの変更とrollback

公開後にcleanupを有効にするには、既存のRegisteredArtifactの元のpreview runを `reviewed_run` で選び、`scheduler_enabled=true` と正しい `published` の期待値を指定してapplicationをpreviewする。既存のartifactを使うpreviewはbuild/登録をskipするが、変更した設定について新たにレビューするplanを生成する。その新しいpreviewを、正確なdigest/flagでapplyする。cronは毎日03:00 UTC、window OFFである。有効にすると、heartbeat欠落のalarm actionも有効になる。公開状態の切り替えやuserデータの編集を行うmaintenance workflowはない。

codeをrollbackする前に、まず現在の検証済みartifactを使って `scheduler_enabled=false` をpreview・レビュー・applyする。operatorの復旧手順に従い、実行中のcleanupや呼び出しが落ち着くまで待つ。古いimmutable ZIPと、その元の検証evidence/commit
（mainから到達可能なままでなければならない）を、期限切れでない元のpreviewから選ぶ。custodyが期限切れなら、任意のmanifestをアップロードするのではなく、新しいpreviewを用意する。API/Cognitoのidentity、origin/設定、未公開/公開の期待値は変えず、planをレビューする。レビュー済みの選択したversionをapplyし、両方のalias、hash、smokeを検証する。TerraformはAPIとcleanupのproduction aliasを**非原子的に**更新する。失敗するとversionが混在したままになることがある。両方のaliasの証明とsmokeが合格するまで、rollback完了を告げてはならない。Schedulerを無効にしても、既存の呼び出しはcancelされない。codeのrollbackは、table、画像、公開状態を復元しない。データ/PITRの復旧は別途承認が必要な操作であり、決して配布workflowではない。

## 依存関係のevidence

CIはNode 24.21.0/npm 11.11.1、Python 3.13.16、Terraform 1.16.5と、checked-inのprovider 6.67.0のlockを使う。runtimeと開発依存全体の監査はすべてのseverityを報告し、未解決のHigh/Criticalで失敗する。`continue-on-error` でそれを隠すことはない。現在のD07監査では、開発用の推移的依存関係の指摘6件を修正した。検証したローカルのruntimeと全依存関係のreportは、いずれも脆弱性0件である。Dependabotは毎週、npm、Actions、3つのTerraform rootを検査する。Dockerと`.devcontainer` は対象外である。SHAの更新には、公式のrelease/tagの来歴のレビューが必要である。監査結果はその時点のevidenceであり、恒久的な保証ではない。

実装時に参照した現行ドキュメントは、[GitHubのdeployment制御](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/control-deployments)、[artifactのアクセスとダウンロード](https://docs.github.com/en/actions/how-tos/monitor-workflows/download-workflow-artifacts)、[download action](https://github.com/actions/download-artifact)、[Terraformのsaved plan](https://developer.hashicorp.com/terraform/tutorials/cli/plan)、[npm audit](https://docs.npmjs.com/cli/v11/commands/npm-audit)、[npm SBOM](https://docs.npmjs.com/cli/v11/commands/npm-sbom)である。

## 復元tableの選択とprivateな失敗診断

`restored_tables` はすべてのrootで既定値が `{}` である。例外的な同一account/regionでの復旧では、レビュー済みの完全な3つの名前のmapを1つと、元の画像bucketを使い、[復旧の切り替え](recovery.md)に従う。runtimeの上限を変更するのはbootstrapだけである。platformは、復元したidentityと保護を読み取り専用で検証し、元のtableを保持する。applicationのhandoff、saved plan、両方のLambdaの環境設定、apply後の検証は、選択したsetに束縛される。既存のAPI/Cognito baselineと、正確なZIPのcustodyは引き続き必須である。

コマンドが失敗した場合、通常のログに出るのはphase、exit status、privateな診断directoryだけである。失敗したprivate runの `failure-diagnostics-<job>-<run_id>` artifactを、そのrunのActions artifacts panelから1日以内にダウンロードする。CIでのprivate repositoryのinfrastructure失敗では `failure-diagnostics-infra-<run_id>` を使う。アクセスはprivate repositoryの閲覧権限によって制限される。environment reviewerだけに限定されるわけではない。それらの閲覧者は制限したままにする。fileはローカルで0700のdirectory権限と0600のfile権限で復元・作成される。レビュー用にダウンロードしたものは使用後に削除する。public repositoryではartifactをアップロードしない。

ローカルの `infra:check` の失敗は `<RUNNER_TEMP or OS temp>/infra-diagnostics` を、releaseコマンドは `release-diagnostics` を使う。JSON fileには、phase、exitStatus、signal/errorCode、上限付きの診断を記録する。各streamが保持するのは最大128KiBで、残る失敗fileは最大8個である。1日より古いfileは、次の失敗時に削除される。その後コマンドを実行しない場合でも、ローカルの診断は1日以内に削除する。成功時の出力、コマンド引数、環境変数は決して永続化しない。plan/show/outputのstdoutは省略する。一般的な認証情報の代入はredactされるが、診断は引き続きprivateであり、通常のログに貼り付けてはならない。失敗したworkflow runは成功previewの来歴検査を通過できない。診断はrelease custodyとは別のpath/名前を使う。

## release CLIの入力

本番の操作に使うコマンドの入力である。いずれも、別途承認された運用でだけ使う。`/private/...` は私有ファイルの例である。

| コマンド | 用途と入力 |
| --- | --- |
| `npm run release:register -- <下記の全flag>` | 実S3への登録 |
| `npm run release:inspect-plan -- <明示のflag>` | root、保存したplan、正確な入力、baseline、commitの私有照合 |
| `npm run release:verify -- --artifact /private/artifact.json --outputs /private/outputs.json --region <region>` | 実Lambdaの2つのaliasとCodeSha256の照合 |
| `npm run release:smoke -- --baseline /private/baseline.json --base-url <known-api-url> --published false` | statusだけを見るHTTPの読み取り。baselineとの一致が必須 |
| `npm run release:workflow -- plan` | GHA専用の有限のhelper。authorize、secure、plan、applyのうち1つのphaseだけを実行する。必須の環境変数とcustodyはこの文書の上の節にある |
| `npm run migrate:json -- --mode dry-run --source /private/source-copy.json --mapping /private/owner-map.json --config /private/target.json` | AWS clientを作らないdry-run（[移行手順](migration.md)） |
| `npm run recovery:verify -- --source-config /private/live.json --restored-config /private/restored.json --owner-identities /private/current-owners.json --run-id <uuid>` | 実AWSの読み取り。明示したprepare、preserve、mapだけが復旧先を変更する（[復旧手順](recovery.md)） |

登録のflagは `--zip --manifest --bucket --region --commit --npm-version --esbuild-version --audit-id --sbom-id --tests-id` の10個で、全て値が必要である。toolsの値は 24.21.0、11.11.1、0.28.2 で、evidenceの値は保管した実ファイルの `sha256:<digest>` である。登録は、immutableなkey、version、checksumを証明し、bytesの異なる既存のobjectを再利用しない。`--manifest` の出力はReleaseManifestである。他のrelease CLIの `--artifact` には、その `.artifact` だけを私有ファイルへ抽出したRegisteredArtifactを渡す。

```sh
npm run release:inspect-plan -- --mode review --root application \
  --plan-json /private/plan.json --plan /private/saved.tfplan \
  --inputs /private/inputs.json --baseline /private/baseline.json \
  --commit <full-commit-sha> --manifest /private/review.json --artifact /private/artifact.json
# apply直前は同じsaved binary由来JSONで --mode check。platformはartifact省略/null
```

## Lambdaの設定

LambdaはZIP、`nodejs24.x`、`x86_64` である。

| 対象 | 設定 |
| --- | --- |
| API | 512 MiB、10秒、concurrency 10 |
| cleanup | 512 MiB、660秒、concurrency 1 |
| API Gatewayのintegration | 15秒、stageは20 rps、burst 40 |

同じZIPの `dist/api.handler` と `dist/cleanup.handler` を使う。source mapとTHIRD_PARTY_NOTICESを同梱し、minifyしない。ZIPは50 MB未満、展開後250 MB未満である。S3のbytesのSHA、key、versionと、LambdaのCodeSha256を照合する。通常のreleaseは、API URLやCognito identityの変更、unknown、replacement、aliasの不一致を拒否する。
