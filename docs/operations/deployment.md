# 本番配布

GitHub Actionsの `deploy.yml` を使って、本番のAWS環境を構築し、ZIPをデプロイする手順である。これらの手順は、将来、別途承認を得て行うAWS操作を記述する。ローカルの実装では、Actionsの実行、リソースの作成、実ZIPの登録、APIのseed、データの移行、デプロイのいずれも行っていない。本番は唯一の恒久的な環境である。

## 全体の流れ

作業には、operatorが手作業で行うものと、`deploy.yml` の実行で行うものがある。bootstrapとoperatorの認証情報はoperatorが私的に保管する。repository secretやworkflowの入力には決して置かない。

初回の構築は、次の順に行う。各作業の詳細は「[初回の構築](#初回の構築)」にある。

| 順 | 作業 | 実施者 |
| --- | --- | --- |
| 1 | bootstrap rootを作成し、そのoutputからGitHubのenvironment、variable、secretを設定する | operator |
| 2 | platformをpreviewし、レビューしてapplyする | `deploy.yml` |
| 3 | HTTP APIだけをseedする | operator |
| 4 | API IDをbootstrapへ戻し、applicationのbaselineを設定する | operator |
| 5 | applicationをpreviewし、ZIPを登録する | `deploy.yml` |
| 6 | applicationをレビューしてapplyする | `deploy.yml` |

`deploy.yml` の実行は、毎回previewとapplyの2回のrunで行う。手順は「[workflowの実行](#workflowの実行previewとapply)」にある。cleanupの有効化とrollbackは「[cleanupの有効化](#cleanupの有効化)」と「[rollback](#rollback)」にある。既存のbootstrapの更新は「[bootstrapの更新](#bootstrapの更新)」にある。

## 前提と制約

- 配布はpublicとprivateのどちらのrepositoryでも同じ手順で動く。repositoryの公開設定には頼らない。Terraformのplanとstateは、`sensitive` の値も平文で含みうるため、秘密の情報として扱う。plan、入力、証拠、apply結果、失敗時の診断は、GitHubのartifactやログには出さず、bootstrapが作るprivateなS3 bucket（custody bucket）にだけ置く。詳細は「[release custody](#release-custody)」にある。
- authorize jobは、手動のdispatch以外のevent、main以外からのdispatch、mainから到達できないcommitを、build、OIDC、custodyの読み書きより前に拒否する。
- GitHubに出すのは、job summaryの要約と、job間の受け渡しのoutputだけである。`plan` jobのsummaryにはroot、commit、actionの件数、`review_sha256`、custodyの置き場所のrun IDと `run_attempt` が、`apply` jobのsummaryにはroot、commit、結果、`release-result` の置き場所が出る。outputはcustodyの置き場所とmanifestのSHA-256である。plan、入力、ledgerの中身は出さない。
- custody bucketを読めるのは、自分のAWSの権限を持つoperatorと、prefixごとに限定した3つのGitHub用roleだけである。operatorのAWSの読み取り権限は、レビューする人に限る。
- レビューに使えるのは、作成から24時間以内の `release-review` だけである。期限を過ぎたら新しいpreviewが必要である。ローカルにダウンロードしたレビュー用のファイルは使用後に削除する。
- workflowは任意のローカルJSONやアップロードからapplyできない。
- PRでのOIDC、`pull_request_target`、pushによる自動デプロイ、maintenance workflow、user管理workflowはいずれも存在しない。

## GitHubの設定

bootstrap rootを作成した後（[初回の構築](#初回の構築)の手順1）、そのレビュー済みのprivate outputから設定する。

設定する場所の一覧:

| 設定する場所 | 名前 | 読むjob |
| --- | --- | --- |
| environment `production-artifact` | secretは無い（保護の設定だけ） | register |
| environment `production-plan` | secret `PLATFORM_INPUTS_JSON`、`APPLICATION_INPUTS_JSON`、`PLATFORM_BASELINE_JSON`、`APPLICATION_BASELINE_JSON` | plan |
| environment `production` | secretは無い（保護の設定だけ） | apply |
| repository secret | `AWS_ACCOUNT_ID`、`ARTIFACT_ROLE_ARN`、`PLAN_ROLE_ARN`、`APPLY_ROLE_ARN`、`ARTIFACT_BUCKET`、`STATE_BUCKET`、`CUSTODY_BUCKET` | register、plan、apply（必要なstepだけ） |
| repository variable | `AWS_REGION` | すべて |

- environment secretが必要なのは `production-plan` だけである。ほかの2つのenvironmentには、deployment branchの制限やrequired reviewersなどの保護だけを設定する。
- environment secretと同じ名前のrepository secretがあると、jobの中ではenvironment secretが優先される。repository secretの7つは、environmentに同じ名前で置かない。

### environment

- 3つのenvironment `production-artifact`、`production-plan`、`production` を設定し、いずれもdeployment branchをmainに限定する。
- accountのplanがこれらの保護に対応している場合は、`production` でrequired reviewersとprevent self-reviewを使用する。
- AWS OIDCのsubjectは、これらのenvironment名と正確に一致しなければならない。bootstrapの明示的な `oidc_subjects.artifact`、`.plan`、`.apply` には、それぞれ正確に `repo:<repository>:environment:production-artifact`、`repo:<repository>:environment:production-plan`、`repo:<repository>:environment:production` を設定する。
- bootstrapは、branch/tagのsubject、余分なrole、environmentを1つにまとめた構成を拒否する。bootstrapのexampleのplaceholderはデプロイ用の値ではない。
- GitHubのenvironmentと保護機能の利用可否はrepositoryのplanによって異なる。配布を有効にする前に、利用できる制御を確認する。operatorに代わってこれらの制御を設定・保証できるworkflowはない。

### repository variableとaccountを識別する値のsecret

repository variableは `AWS_REGION` だけである。bootstrapの入力の `region` を設定する。

accountを識別する値は、repository secretに設定する。public repositoryでは、stepの `with` と `env` の値がrunnerのログに出る。repository variableはmaskされないので、role ARN、account ID、account IDを含むbucket名がログに残る。secretの値はログでmaskされる。次のsecretを、レビュー済みのbootstrapの入力とoutputから設定する。

| secret | 値 | 渡すstep |
| --- | --- | --- |
| `AWS_ACCOUNT_ID` | bootstrapの入力の `account_id` | 3つのroleのassume |
| `ARTIFACT_ROLE_ARN` | output `artifact_role_arn` | register jobのassume |
| `PLAN_ROLE_ARN` | output `plan_role_arn` | plan jobのassume |
| `APPLY_ROLE_ARN` | output `apply_role_arn` | apply jobのassume |
| `ARTIFACT_BUCKET` | output `artifact_bucket` | ZIPの登録 |
| `STATE_BUCKET` | output `state_bucket` | plan |
| `CUSTODY_BUCKET` | output `custody_bucket` | custodyを読み書きするstepと診断のstep |

- `deploy.yml` は、これらのsecretをworkflow全体やjob全体の `env` には置かず、必要なstepにだけ渡す。job間のoutputはrun ID、`run_attempt`、SHA-256だけで、secretの値を含まない。
- 以前の手順でこれらの値をrepository variableに設定していた場合は、「[repository variableからsecretへの移行](#repository-variableからsecretへの移行)」に従う。
- state bucketの識別名は `<name_prefix>-<account_id>-<region>-state` に固定である。backendのkey、暗号化、S3ネイティブの `use_lockfile` は各rootで固定されている。
- 各AWS jobはOIDCで指定されたroleだけをassumeし、想定するaccountであることを確認する。長期間有効なkeyはない。
- workflowはbootstrapのapply用認証情報を扱わず、自身のAPI権限を拡大することもない。

### secret

`production-plan` には、JSON objectを格納したprivate secretを設定する。

- `PLATFORM_INPUTS_JSON`: `infra/platform/production/terraform.tfvars.example` にある必須のplatform変数すべて。実際のレビュー済みのorigin、完全なcallback/logout URL、region/account/prefix、bootstrapのroleを含む。
- `APPLICATION_INPUTS_JSON`: account、region、prefix、正確なorigin、bootstrapの `scheduler_role_arn`、nullでないbootstrapの `production_api_id`。任意で `allowed_source_ips` と `runtime_limits` を含めてよい。platformの項目は実行時に実際の値を読み取り、allowlistで選別してprivate input fileに入れる。重複して与えた値は一致しなければならない。artifactとseed/schedulerのflagはrelease driverが固定する。
- `PLATFORM_BASELINE_JSON`: 保護されたCognitoを本当に初めて作成するときに限り、リテラルのJSON `null`。それ以降は、下記の既知のplatform baselineを入れる。
- `APPLICATION_BASELINE_JSON`: API-onlyのseed後の既知のapplication baseline。通常の配布では決してnullにしてはならない。

baselineのschemaは `{root, apiBaseUrl, apiId, cognitoIssuer, cognitoClientId, cognitoAuthBaseUrl}` である。`root` は `platform` または `application` である。

- platformではAPIの項目がnullでもよいが、作成後はCognitoのidentity/domainが既知でなければならない。
- applicationでは、すべてのidentity/URLが既知であり、API IDがbootstrapのhandoffおよび既存のapplication stateと一致しなければならない。
- account、region、origin、redirectの値は明示する。secretやoutputを別のaccountから推測することはない。

## release custody

`deploy.yml` のjob間、run間の受け渡しには、bootstrapが作るcustody bucket（`<name_prefix>-<account_id>-<region>-custody`、repository secret `CUSTODY_BUCKET`）を使う。GitHubのartifactは使わない。

### bucketと権限

- versioning、SSE-S3の暗号化、公開アクセスのブロックを有効にする。bucketは `prevent_destroy` で保護する。
- bucket policyは、HTTPS以外の通信、`If-None-Match: *` の無い `PutObject`（既存のobjectの上書き）、`DeleteObject` と `DeleteObjectVersion` を拒否する。objectを消すのはlifecycleだけである。
- 3つのGitHub用roleの権限は、prefixごとの `GetObject` と新規作成の `PutObject` だけである。削除と一覧（`ListBucket`）の権限はどのroleにも無く、読む側は `manifest.json` からファイル名を知る。

| role | 読める | 書ける |
| --- | --- | --- |
| artifact（ZIPの登録用） | なし | `registered-release/`、`failure-diagnostics/` |
| plan | `registered-release/`、`release-review/` | `release-review/`、`failure-diagnostics/` |
| apply | `release-review/` | `release-result/`、`failure-diagnostics/` |

`release-result/` と `failure-diagnostics/` を読めるroleは無い。operatorが自分のAWSの権限で読む。roleの名前のartifactはリリースするZIPの意味で、GitHubのartifactとは別のものである。

### objectの置き方

prefixは `<種類>/<run_id>/<run_attempt>/` である。`run_attempt` は、そのobjectを**書いたjob** の `github.run_attempt` である。一部のjobだけを再実行すると、run IDは変わらず `run_attempt` だけが増える。

| prefix | 中身 | 書くjob |
| --- | --- | --- |
| `registered-release/<run_id>/<run_attempt>/` | `registered.json`、`audit-runtime.json`、`audit.json`、`sbom.json`、`tests.txt` | `register` |
| `release-review/<run_id>/<run_attempt>/` | `inputs.json`、`baseline.json`、`artifact.json`、`request.json`、`backend.hcl`、`review.json`、`saved.tfplan`、`preview.json`、`custody.json`、`plan.txt`。applicationでは、さらに `registered.json`、`audit.json`、`sbom.json`、`tests.txt`、`platform-outputs.json` | `plan` |
| `release-result/<run_id>/<run_attempt>/` | `ledger.json`。初回のplatformの構築では `post-baseline.json` も置く | `apply` |
| `failure-diagnostics/<run_id>/<run_attempt>/<job>/` | 失敗したjobの診断のJSON（最大8個） | 失敗したjob |

- 各ファイルは `If-None-Match: *` とSHA-256のchecksumを付けて書き、最後に `manifest.json` を書く。manifestには、種類、root、run ID、`run_attempt`、`createdAt`、ファイル名とSHA-256の一覧を入れる。`registered-release` と `release-review` には利用期限 `expiresAt` も入れる。`release-review` には、さらにplanのdigest（`review.json` の `reviewSha256`）と `custody.json` のSHA-256を入れ、ZIPを再利用したpreviewでは元のpreviewのmanifestのSHA-256も入れる。
- 読む側は、期待する `manifest.json` のSHA-256を先に決めてから読む。manifestが無い、SHA-256が違う、種類・root・run ID・`run_attempt` が読もうとした場所と違う、ファイルの集合が種類ごとの集合と完全に一致しない、各ファイルのSHA-256が違う、のいずれでも止まる。manifestに載っていないobjectは読まない。取り出したファイルはdirectory 0700、file 0600で書き、パスの区切り、`..`、symlinkを拒否する。`release-review` では続けて `custody.json` の照合と `verifySavedPlan` を独立に行う。
- 同じrunの中では、読むjobは書いたjobのoutput（run ID、`run_attempt`、manifestのSHA-256）を使う。outputが欠けている、または形式が不正なら止まる。読むjob自身の `run_attempt` で推測しない。
- 別のrun（`reviewed_run`）を読むときは、authorize jobがGitHubのAPIで、そのrunがこのrepositoryのmainで `deploy.yml` を手動で実行して成功したpreviewであることを確かめ、そのrunの `plan` jobの最後の成功した試行の `run_attempt` を取得する。`release-review/<reviewed_run>/<run_attempt>/manifest.json` のSHA-256が入力の `expected_review_sha256` と一致しなければ止まる。
- S3、権限、照合のどこで失敗しても、GitHubのartifactに切り替えることはしない。

### lifecycleと利用期限

| prefix | 現行のversionの失効 | 古いversionの完全な削除 |
| --- | --- | --- |
| `registered-release/`、`release-review/`、`failure-diagnostics/` | 作成から1日 | 古いversionになってから1日 |
| `release-result/` | 作成から30日 | 古いversionになってから1日 |

失効した後に残るdelete markerは、別の規則で削除する。lifecycleの日数はUTCの翌0時に切り上げて評価され、処理の遅れもあるため、bytesが実際に消えるのは上の期間より遅くなりうる。

利用の期限はlifecycleではなく、manifestの `expiresAt` で守る。

- 期限は、元のレビュー（previewのrunの `release-review`）の作成時刻から24時間である。現在時刻が `expiresAt` 以上なら止まる。`createdAt` が5分以上未来のもの、日時の形式が不正なもの、`expiresAt` が `createdAt` の24時間後でないものも止まる。
- applyのrunが作る `release-review` は、元のレビューの `expiresAt` を引き継ぐ。新しい作成時刻で期限を延ばさない。
- ZIPを再利用した新しいpreviewは新しいレビューなので、新しい作成時刻から24時間である。
- 期限は、別のrunの `release-review` を読むとき、同じrunのapply jobが `release-review` を読むとき、applyを実行する直前に確かめる。`production` の承認を待つ間に期限を過ぎた場合は、新しいpreviewが必要である。
- `registered-release` は同じrunの中だけで読み、同じ規則で24時間である。`release-result` と `failure-diagnostics` は人が読む保管用で、`expiresAt` を持たず、保持はlifecycleだけで決まる。
- `If-None-Match` は現行のversionだけを検査するので、lifecycleで失効した後なら同じkeyにobjectを作り直せる。作り直したmanifestは、中身や時刻が違えばSHA-256が変わって止まり、同じ内容なら `expiresAt` を過ぎているので止まる。

## 初回の構築

1. **bootstrap rootの作成（operator）**
   別途承認を得たoperatorが、手元の短期の認証情報で `infra/bootstrap` のTerraformを実行し、`production_api_id=null` で作成する。GitHub Actionsは使わない。IAM、S3、OIDC providerを作成できる認証情報と、Terraform 1.16.5を用意する。以下のコマンドは `infra/bootstrap` で実行する。

   1. 入力ファイルを作る。`terraform.tfvars` と `backend.hcl` は `.gitignore` 済みであり、commitしない。

      ```sh
      cp terraform.tfvars.example terraform.tfvars
      ```

      `terraform.tfvars` に、レビュー済みの値を明示する。

      | 変数 | 値 |
      | --- | --- |
      | `account_id` | AWSのaccount ID（12桁） |
      | `region` | 使用するregion |
      | `repository` | GitHubの `owner/repository` |
      | `github_environment` | `production`（これ以外は受け付けない） |
      | `name_prefix` | リソース名の接頭辞（3〜26文字の英小文字・数字・hyphen） |
      | `oidc_subjects` | `artifact`、`plan`、`apply` の3つ。「[environment](#environment)」の正確なsubject |
      | `production_api_id` | `null` |
      | `restored_tables` | `{}` |

   2. ローカルのstateで作成する。stateを置くS3 bucketもこのrootが作るため、最初はS3 backendを使えない。`backend.tf` を一時的にrootの外へ移してから実行する。

      ```sh
      mv backend.tf /tmp/bootstrap-backend.tf
      terraform init
      terraform plan -out=bootstrap.tfplan
      terraform apply bootstrap.tfplan
      ```

      applyの前に、planをbootstrapとしてレビューする。planに含まれるのは次のものである。
      - 3つのS3 bucket（`<name_prefix>-<account_id>-<region>-state`、`<name_prefix>-<account_id>-<region>-artifacts`、`<name_prefix>-<account_id>-<region>-custody`）。versioning、暗号化、公開アクセスのブロック、HTTPS必須のpolicyを付ける。custody bucketには、上書きと削除を拒否するpolicyとprefixごとのlifecycleも付ける（「[release custody](#release-custody)」）。画像のbucketはplatformが作る。
      - GitHubのOIDC providerと、範囲を限定した3つのOIDC role（artifact、plan、apply）。
      - 3つのruntime role（api、cleanup、scheduler）と、各roleの権限の上限（boundary）。
      - API IDがnullの間、GitHubにはHTTP APIの作成・管理の権限が一切与えられない。

   3. stateをS3へ移す。
      1. ローカルのstateを私的にbackupする。
      2. `backend.tf` を元の場所に戻す。
      3. `backend.hcl.example` を `backend.hcl` にコピーし、`bucket` にoutputの `state_bucket`、`region` に使用するregionを書く。
      4. `terraform init -migrate-state -backend-config=backend.hcl` を実行する。決して盲目的に強制コピーしない。
      5. 移行を確認してから、ローカルのbackupを安全に保管するか、削除する。

   4. `terraform output` の値から、「[GitHubの設定](#githubの設定)」のenvironment、variable、secretを設定する。この時点で決まらない値があるため、secretは段階に分けて設定する。

      | 時点 | 設定するもの |
      | --- | --- |
      | この手順（1-4） | 3つのenvironmentと保護の設定、repository variable `AWS_REGION`、7つのrepository secret、`production-plan` のsecret `PLATFORM_INPUTS_JSON` と、リテラルのJSON `null` を入れた `PLATFORM_BASELINE_JSON` |
      | 手順2のapplyの後 | `PLATFORM_BASELINE_JSON` を、custodyの `post-baseline.json` の内容で上書きする |
      | 手順4 | `APPLICATION_INPUTS_JSON`（nullでない `production_api_id` を含む）と `APPLICATION_BASELINE_JSON` を作る |

      `APPLICATION_INPUTS_JSON` と `APPLICATION_BASELINE_JSON` は、手順2のplatformのpreviewとapplyでは使わないので、手順4まで設定しなくてよい。
2. **platformのpreviewとapply（`deploy.yml`）**
   - `target=platform`、`apply=false`、main上の完全なimmutable commit、明示的なnullのplatform baselineでpreviewする。この段階ではZIPのbuildも登録も**行わない**。
   - 「[workflowの実行](#workflowの実行previewとapply)」の2回のrunによるgateでレビューしてapplyする。
   - 既存のpool/client/domainがある場合、null baselineは拒否される。null baselineはリセットやadoptionの抜け道ではない。
   - 初回のapply後、driverは実際のstate上のリソースidentityを、保存したregion/domainの入力と照合し、既知のoutputを検証して、`post-baseline.json` をcustody bucketの `release-result/<run_id>/<run_attempt>/` に置く。置き場所はapplyのrunのjob summaryに出る。
   - operatorは、自分のAWSの権限で `post-baseline.json` を私的な場所に取り出し、その内容で `production-plan` のsecret `PLATFORM_BASELINE_JSON` を更新する。以後のplanの前に必ず更新する。取り出したファイルは更新後に削除する。

     ```sh
     aws s3 cp s3://<custody bucket>/release-result/<run_id>/<run_attempt>/post-baseline.json /private/post-baseline.json
     ```
   - platformは、Lambdaのデプロイより前にAPI/cleanupのpolicyとlog groupを用意する。
3. **HTTP APIのseed（operator）**
   - 別途承認を得たoperatorが、application所有の `aws_apigatewayv2_api.production` **だけ**を、正確な[API-only seed手順](../../infra/application/production/README.md)でseedする。rootの変数はすべて引き続き必須である。
   - 実ZIPが存在する前の段階では、明示的にUNUSEDとしたseed専用のdescriptorに、既知のbootstrap artifact bucket、64個のゼロからなるhexのrelease key、`operator-api-seed-unused` というversion、zero32のBase64を入れる。これはRegisteredArtifactでも検証済みZIPでもない。
   - 対象を限定したsaved planをレビューする。API作成だけを含み、stage・Lambda・S3 artifactの操作を含まないこと。
   - root全体のseedは拒否され、schedulerは無効であり、GHAによるseedの経路は存在しない。
4. **API IDの反映とapplication baselineの設定（operator）**
   - 実際のAPI ID/URLを私的に控え、別途レビューされたoperatorの変更で既知のIDをbootstrapへ戻し、platformのCognito identity/domainとともに既知のapplication baselineを設定する。
   - APIは元のapplication state/addressのまま保持する。seed flagとダミーのdescriptorは破棄する。
   - 通常の配布には `operator_api_seed=false` と実際のimmutable ZIPが必要である。
5. **applicationのpreview（`deploy.yml`）**
   - `target=application`、`apply=false`、`reviewed_run` を空、`scheduler_enabled=false` でpreviewする。
   - このrunはbuild/packageを一度だけ行い、生成したZIPを検証し、ローカル試験と静的なTerraform検査を実行し、監査を行い、CycloneDXのSBOMを生成する。検証が済んだ後でのみ、登録roleがZIPを登録し、RegisteredArtifactと証拠を `registered-release/` に置く。`plan` jobはそれを `register` jobのoutputのmanifestのSHA-256で照合して読む。
   - planはその選択したS3のkey/version/checksumを使い、seed済みのAPIを必須とし、最初の `$default` stageを作成できる。通常のplanはAPIを作成・置換・削除できない。
6. **applicationのapply（`deploy.yml`）**
   - 「[workflowの実行](#workflowの実行previewとapply)」の手順でレビューしてapplyする。既定の `published=false` では `/readyz=503` を期待する。
   - workflowは公開データを一切変更しない。移行・公開とCognito consoleでのuser操作は、それぞれ別途承認されたoperator手順に従う。
   - 管理者専用でIAMにより制御されたpassword認証を使うClassic Hosted UIは、実AWSでのlogin、PKCE、公開経路からの直接認証の拒否について、受け入れ確認がまだ必要である。mockの検査では実環境での互換性は確立されない。

## workflowの実行（previewとapply）

`deploy.yml` は、GitHubの手動Run workflow UIを `main` で使って実行する。入力は次のとおりである。

| 入力 | 内容 |
| --- | --- |
| `target` | Terraformの本番root。`platform` または `application` |
| `commit` | mainから到達可能な、40桁hexの完全なimmutable commit。checkoutはこの正確なcommitを使う |
| `apply` | previewでは `false` のままにする。applyのrunだけ `true` |
| `reviewed_run` | 成功した元のpreviewのrun ID。applyと、既存ZIPの再利用に必要。既存ZIPを再利用するpreviewはapplicationだけで、platformではauthorize jobが拒否する |
| `expected_review_sha256` | レビューした元のpreviewの `release-review` の `manifest.json` のSHA-256（16進数）。初回作成を含むすべてのapplyと、既存ZIPを再利用するpreviewに必要 |
| `published` | applicationのsmokeで期待する公開状態。データは変更しない |
| `scheduler_enabled` | レビュー済みのapplicationのSchedulerの設定 |

1. **previewを実行する**
   - `apply=false` でdispatchする。
2. **previewの結果をレビューする**
   - previewの `plan` jobのjob summaryに、root、commit、actionの件数、`review_sha256`（16進数とBase64）、custodyの置き場所（run IDと `run_attempt`）が出る。plan・state・inputの生の内容はGitHubには出ない。
   - AWSコンソールのS3の画面で、custody bucketの `release-review/<run_id>/<run_attempt>/` を開き、期限（作成から24時間）が切れる前にレビューする。すべてのファイルを、同じrun IDと `run_attempt` の場所から読む。
     - plan（`plan.txt`）。`plan.txt` は `saved.tfplan` から `terraform show -no-color` で作った、読むための補助である。必要なら `saved.tfplan` を対応するTerraformのversionで確かめる。
     - 正確な入力（`inputs.json`）とbaseline（`baseline.json`）。
     - root、schedulerと公開の期待値を含む `request.json`。
     - applicationでは、登録したZIP（`registered.json`）と、audit（`audit.json`）、SBOM（`sbom.json`）、試験（`tests.txt`）の証拠。
   - `manifest.json` のSHA-256がjob summaryの `review_sha256` と一致することを、自分で確かめる。たとえば `aws s3 cp s3://<custody bucket>/release-review/<run_id>/<run_attempt>/manifest.json - | sha256sum` で16進数を、S3コンソールのobjectのchecksum（SHA-256）でBase64を確かめられる。一致した16進数の値を、applyのrunの `expected_review_sha256` に入れる。
   - hashの照合は内容が変わっていないことを確かめるだけで、人による内容の承認の代わりにはならない。
3. **applyを実行する**
   - applyは毎回2回目のdispatchを使う。environment reviewerを利用できる場合も同じである。
   - 同じtarget/commit/inputとflag、`apply=true`、`reviewed_run=<成功した元のpreviewのrun ID>`、`expected_review_sha256=<レビューしたmanifestのSHA-256>` を設定する。
   - 参照元は、このrepositoryの、完了して成功したmainでの手動の `deploy.yml` のrunでなければならず、applyのrunではなくpreviewとして記録されていなければならない。repositoryの公開設定は条件にしない。
   - applicationのapplyはbuild/登録をskipし、元のpreviewの `release-review` から、RegisteredArtifactと、hashを検査した監査・SBOM・試験のfileを再利用する。HEADで、固定したS3のversion/size/checksumを再確認する。
4. **planを確認して `production` を承認する**
   - そのrunは、元のpreviewの `manifest.json` を `expected_review_sha256` で照合し、期限内であることを確かめてから、レビュー済みの入力bytesとbaselineを正確に使って新しいsaved planを1つ作成する。新しいplanのdigestは、照合したmanifestの中のplanのdigestと一致しなければならない。planのdigestから除外するのは、Terraformのroot timestampだけである。rootの `relevant_attributes` はTerraformが実行ごとに違う順番で出すので、順番は無視して中身だけを照合する。
   - 新しいsaved planは、このrunの `release-review/<run_id>/<run_attempt>/` に、元のレビューの `expiresAt` を引き継いで置かれる。job summaryに、その置き場所と新しい `review_sha256` が出る。
   - driftその他のレビューとの差異があれば配布を停止する。初回作成の場合も同じである。実際の初回作成のpreviewどうしでは、unknownのIDが異なることがある。planのdigestが変わった場合は、比較を緩めるのではなく新しいpreviewをレビューする。
   - `production` environmentは、**現在のrun** の `release-review` のplanをレビューした後でのみ承認する。承認を待つ間に元のレビューの期限を過ぎると、apply jobは止まる。
   - required reviewerの制御を利用できない場合は、必須のdigestと成功した元のpreviewが、operatorの手動gateとして残る。workflowのdispatchと、repository/environmentの設定権限をそれに応じて制限する。
5. **apply jobの動作を確認する**
   - apply jobは、apply roleをassumeした後で、`plan` jobのoutput（run ID、`run_attempt`、manifestのSHA-256）が指す**このrun** の `release-review` を読み、private directory 0700/file 0600に取り出す。元のpreviewのmanifestも `expected_review_sha256` で照合し、引き継いだ期限、planのdigest、`custody.json` と各fileの正確なhash、現在のcheckout、root、入力bytes、baseline、artifactを検査する。
   - まったく同じbinaryからJSONを再生成してD06の `verifySavedPlan` にかけ、apply直前にもう一度期限を確かめてから、そのbinaryをネイティブのstate lockと5分のlock timeoutでapplyする。再plan、再build、登録は決して行わない。
   - privateなbackendのデータは束縛されたaccount/region/prefixから導出され、両rootの固定keyは別々である。
   - productionのconcurrencyは、rootとjobをまたいで `cancel-in-progress=false` である。新しいrunが、実行中または承認待ちのapplyをcancelすることはできない。保留中のrunはGitHubのconcurrency queueによって置き換えられることがある。run statusを確認し、必要なら新しいレビューをdispatchする。applyを手動でcancelしてはならない。
6. **apply後の検証を確認する**
   - apply後、rootが所有するidentityのoutputを検証する。初回のplatform作成で既知になったbaselineも含む。
   - applicationではさらに、2つのproduction aliasが選択したpublished versionを指し、AWS CodeSha256が登録済みZIPのdigestと等しいことを検証し、その後statusだけを見るGETを確認する。`/healthz=200`、`/readyz=200`（公開時。未公開時は503）、認証なしの `/v2/reminders=401/403` である。smokeでの書き込みや、tokenやbodyのログ出力は行わない。
   - 成功ledger（`ledger.json`）はすべての検査が済んだ後でのみ、custody bucketの `release-result/<run_id>/<run_attempt>/` に書き込まれ、commit/root/planのdigest/artifact digest、2つのversion、API URL、結果を含む。userデータは含まない。ledgerは標準出力とjob summaryには出さない。job summaryに出るのは、root、commit、結果、`release-result` の置き場所だけである。`release-result` は30日間保持する。
   - 部分的なapply、または証明・smokeの失敗は成功ではない。次のreleaseの前に、operatorの承認済み復旧手順に従ってprivateなoutput/stateを確認する。

## cleanupの有効化

公開後にcleanupを有効にする手順である。

1. 既存のRegisteredArtifactの元のpreview runを `reviewed_run` で選び、その元のpreviewの `manifest.json` のSHA-256を `expected_review_sha256` に入れ、`apply=false`、`scheduler_enabled=true` と正しい `published` の期待値を指定してapplicationをpreviewする。ZIPを再利用するpreviewにも `expected_review_sha256` が必要で、無ければauthorize jobが止める。元のpreviewは期限内でなければならない。
2. 既存のartifactを使うpreviewはbuild/登録をskipするが、変更した設定について新たにレビューするplanを生成する。新しい `release-review` のmanifestには元のpreviewのmanifestのSHA-256が入り、期限は新しい作成時刻から24時間である。
3. その新しいpreviewを「[workflowの実行](#workflowの実行previewとapply)」の手順でレビューし、新しいpreviewのrun IDとmanifestのSHA-256、同じflagでapplyする。

cronは毎日03:00 UTC、window OFFである。有効にすると、heartbeat欠落のalarm actionも有効になる。公開状態の切り替えやuserデータの編集を行うmaintenance workflowはない。

## rollback

codeをrollbackする手順である。

1. まず現在の検証済みartifactを使って `scheduler_enabled=false` をpreview・レビュー・applyする。
2. operatorの復旧手順に従い、実行中のcleanupや呼び出しが落ち着くまで待つ。
3. 古いimmutable ZIPと、その元の検証evidence/commit（mainから到達可能なままでなければならない）を、期限切れでない元のpreviewから選ぶ。ZIPを再利用するpreviewには、その元のpreviewのmanifestのSHA-256が必要である。custodyが期限切れなら、任意のmanifestをアップロードするのではなく、新しいpreviewを用意する。
4. API/Cognitoのidentity、origin/設定、未公開/公開の期待値は変えず、planをレビューする。
5. レビュー済みの選択したversionをapplyし、両方のalias、hash、smokeを検証する。

TerraformはAPIとcleanupのproduction aliasを**非原子的に**更新する。失敗するとversionが混在したままになることがある。両方のaliasの証明とsmokeが合格するまで、rollback完了を告げてはならない。

Schedulerを無効にしても、既存の呼び出しはcancelされない。codeのrollbackは、table、画像、公開状態を復元しない。データ/PITRの復旧は別途承認が必要な操作であり、決して配布workflowではない。

## bootstrapの更新

custody bucketを持たない、bootstrap済みの環境を更新する手順である。別途承認を得たoperatorが、手元の短期の認証情報で `infra/bootstrap` において実行する。GitHub Actionsは使わない。

この更新は追加だけである。custody bucketとその設定（versioning、暗号化、公開アクセスのブロック、bucket policy、lifecycle）、3つのGitHub用roleのpolicyへのcustodyの権限、output `custody_bucket` を加える。既存のリソースのaddressは変えず、作り直しや削除は起こさない。

1. 更新後の `infra/bootstrap` で、既存のbackendの設定を使ってinitする。

   ```sh
   terraform init -backend-config=backend.hcl
   ```

2. saved planを作り、追加とroleのpolicyの変更だけであることをレビューしてからapplyする。既存のbucket、role、OIDC providerの作り直し（replace）や削除が含まれていれば、applyしない。

   ```sh
   terraform plan -out=bootstrap.tfplan
   terraform apply bootstrap.tfplan
   ```

3. output `custody_bucket` の値を、repository secret `CUSTODY_BUCKET` に設定する。saved planのファイルは、使用後に削除する。

更新の前にGitHubのartifactに置いたレビューは使えない。更新の後は、新しいpreviewを作ってからapplyする。

### repository variableからsecretへの移行

以前の手順では、`AWS_ACCOUNT_ID`、`STATE_BUCKET`、`ARTIFACT_BUCKET`、`ARTIFACT_ROLE_ARN`、`PLAN_ROLE_ARN`、`APPLY_ROLE_ARN` をrepository variableに設定していた。custody bucketを先に作った環境では、`CUSTODY_BUCKET` もrepository variableに設定している場合がある。今の `deploy.yml` はこれらをsecretから読むので、次の順に移す。`AWS_REGION` はvariableのままにする。

1. 実行中、または承認待ちのdeployのrunが無いことを確かめる。
2. 各値を、同じ名前のrepository secretに設定する。値はレビュー済みのbootstrapの入力とoutputから取る。
3. secretを設定した後で、同じ名前のrepository variableを削除する。variableが残っていても `deploy.yml` は読まないが、設定の二重管理になる。
4. 次のpreviewが成功することを確かめる。各jobがroleをassumeでき、plan jobが `release-review` を書けていれば、設定はそろっている。secretが無いと値は空になり、assumeかcustodyの読み書きで失敗する。

publicのrepositoryで以前の `deploy.yml` を実行していた場合、そのrunのログにrole ARNとaccount IDが残っている。必要なら、そのrunのログを削除する。

## リポジトリをpublicに切り替えるとき

privateのrepositoryをpublicに切り替える場合は、切り替える前に次を確かめる。custody bucketを使う `deploy.yml` は、artifactとログに秘密の情報を出さないが、以前の仕組みで作ったartifactとログは残りうる。

1. 機密を含むGitHubのartifact（custody bucketへの移行前の `release-review`、`registered-release`、`release-result`、`failure-diagnostics-*`、`ci.yml` の `failure-diagnostics-infra-*`）が残っていないこと。残っていれば削除するか、保持期間が過ぎて取得できなくなったことを確かめる。
2. 移行前のworkflowを再実行して、artifactを作り直していないこと。
3. 移行前のworkflowのrunのログに、非公開にする情報（applyの結果のledgerなど）が残っていないこと。残っていれば、そのrunのログを削除するか、保持期間が過ぎて取得できなくなったことを確かめる。
4. 実行中、または承認待ちのdeployのrunが無いこと。

`ci.yml` の失敗時の診断は、privateのrepositoryのときだけartifactにする。publicのrepositoryではartifactをアップロードしない。

## 依存関係のevidence

CIはNode 24.21.0/npm 11.11.1、Python 3.13.16、Terraform 1.16.5と、checked-inのprovider 6.67.0のlockを使う。runtimeと開発依存全体の監査はすべてのseverityを報告し、未解決のHigh/Criticalで失敗する。`continue-on-error` でそれを隠すことはない。現在のD07監査では、開発用の推移的依存関係の指摘6件を修正した。検証したローカルのruntimeと全依存関係のreportは、いずれも脆弱性0件である。Dependabotは毎週、npm、Actions、3つのTerraform rootを検査する。Dockerと `.devcontainer` は対象外である。SHAの更新には、公式のrelease/tagの来歴のレビューが必要である。監査結果はその時点のevidenceであり、恒久的な保証ではない。

関係する現行ドキュメントは、[GitHubのdeployment制御](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/control-deployments)、[S3の条件付き書き込み](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html)、[S3のlifecycle](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lifecycle-mgmt.html)、[Terraformのsaved plan](https://developer.hashicorp.com/terraform/tutorials/cli/plan)、[npm audit](https://docs.npmjs.com/cli/v11/commands/npm-audit)、[npm SBOM](https://docs.npmjs.com/cli/v11/commands/npm-sbom)である。

## 復元tableの選択

`restored_tables` はすべてのrootで既定値が `{}` である。例外的な同一account/regionでの復旧では、レビュー済みの完全な3つの名前のmapを1つと、元の画像bucketを使い、[復旧の切り替え](recovery.md)に従う。runtimeの上限を変更するのはbootstrapだけである。platformは、復元したidentityと保護を読み取り専用で検証し、元のtableを保持する。applicationのhandoff、saved plan、両方のLambdaの環境設定、apply後の検証は、選択したsetに束縛される。既存のAPI/Cognito baselineと、正確なZIPのcustodyは引き続き必須である。

## 失敗時の診断

コマンドが失敗した場合、通常のログに出るのはphase、exit status、privateな診断directoryだけである。

- `deploy.yml` のjobが失敗し、roleをassumeできていれば（assumeのstepが成功していれば）、最後のstepが診断のJSONをcustody bucketの `failure-diagnostics/<run_id>/<run_attempt>/<job>/` に置く（`<job>` は `register`、`plan`、`apply`）。operatorが自分のAWSの権限で、1日以内に読む。GitHubのartifactにはしない。
- roleをassumeする前に失敗した場合（authorize job、依存関係のinstall、register jobのbuildと試験、assumeそのものの失敗など）は、S3に書けないので診断のstepを実行しない。通常のログにphaseとexit statusだけが出て、診断は残らない。authorizeの検査の内容は秘密ではないので、失敗の理由はログの短いエラーで分かる。
- 診断を書くことに失敗しても、jobの結果は失敗のままである。
- CIでのprivate repositoryのinfrastructure失敗では、そのrunのActions artifacts panelから `failure-diagnostics-infra-<run_id>` を1日以内にダウンロードする。アクセスはprivate repositoryの閲覧権限で制限され、environment reviewerだけに限定されるわけではない。public repositoryではartifactをアップロードしない。PRのCIはAWSの認証を持たないため、S3には置けない。
- ダウンロードしたfileは、ローカルで0700のdirectory権限と0600のfile権限で扱い、使用後に削除する。

ローカルの `infra:check` の失敗は `<RUNNER_TEMP or OS temp>/infra-diagnostics` を、releaseコマンドは `release-diagnostics` を使う。

- releaseの照合（manifest、期限、planのdigest、入力の一致など）でworkflow自身が止まった場合、通常のログには固定の文言 `Protected release denied` だけが出る。エラーの文面は、phase `workflow` の診断として `release-diagnostics` に書かれ、上の手順で `failure-diagnostics/` に置かれる。原因は、この診断の `stderr` で確かめる。
- JSON fileには、phase、exitStatus、signal/errorCode、上限付きの診断を記録する。各streamが保持するのは最大128KiBで、残る失敗fileは最大8個である。
- 1日より古いfileは、次の失敗時に削除される。その後コマンドを実行しない場合でも、ローカルの診断は1日以内に削除する。
- 成功時の出力、コマンド引数、環境変数は決して永続化しない。plan/show/outputのstdoutは省略する。
- 一般的な認証情報の代入はredactされるが、診断は引き続きprivateであり、通常のログに貼り付けてはならない。
- 失敗したworkflow runは成功previewの来歴検査を通過できない。診断はrelease custodyのレビューとは別のprefix（`failure-diagnostics/`）を使い、workflowが読むことは無い。

## release CLIの入力

本番の操作に使うコマンドの入力である。いずれも、別途承認された運用でだけ使う。`/private/...` は私有ファイルの例である。

| コマンド | 用途と入力 |
| --- | --- |
| `npm run release:register -- <下記の全flag>` | 実S3への登録 |
| `npm run release:inspect-plan -- <明示のflag>` | root、保存したplan、正確な入力、baseline、commitの私有照合 |
| `npm run release:verify -- --artifact /private/artifact.json --outputs /private/outputs.json --region <region>` | 実Lambdaの2つのaliasとCodeSha256の照合 |
| `npm run release:smoke -- --baseline /private/baseline.json --base-url <known-api-url> --published false` | statusだけを見るHTTPの読み取り。baselineとの一致が必須 |
| `npm run release:workflow -- plan` | GHA専用の有限のhelper。authorize、register-custody、plan、apply、diagnosticsのうち1つのphaseだけを実行する。custodyを読み書きするphaseは `CUSTODY_BUCKET` を要する。必須の環境変数とcustodyはこの文書の上の節と `deploy.yml` にある |
| `npm run migrate:json -- --mode dry-run --source /private/source-copy.json --mapping /private/owner-map.json --config /private/target.json` | AWS clientを作らないdry-run（[移行手順](migration.md)） |
| `npm run recovery:verify -- --source-config /private/live.json --restored-config /private/restored.json --owner-identities /private/current-owners.json --run-id <uuid>` | 実AWSの読み取り。明示したprepare、preserve、mapだけが復旧先を変更する（[復旧手順](recovery.md)） |

登録のflagは `--zip --manifest --bucket --region --commit --npm-version --esbuild-version --audit-id --sbom-id --tests-id` の10個で、全て値が必要である。toolsの値は24.21.0、11.11.1、0.28.2で、evidenceの値は保管した実ファイルの `sha256:<digest>` である。登録は、immutableなkey、version、checksumを証明し、bytesの異なる既存のobjectを再利用しない。`--manifest` の出力はReleaseManifestである。他のrelease CLIの `--artifact` には、その `.artifact` だけを私有ファイルへ抽出したRegisteredArtifactを渡す。

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
