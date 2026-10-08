# reminder-server

[WebPageReminder](https://github.com/Knu334/WebPageReminder)向けの項目単位APIです。
productionはAPI Gateway HTTP API、Node 24 Lambda ZIP、DynamoDB 3表、private
S3画像バケットで構成します。常設環境はproductionのみ。旧一覧置換APIは410、
通常起動で旧JSONを読みません。実AWS構築・GHA・ZIP登録・移行・Chrome認証・PITR
はまだ実施していません。[実装結果と個別F/B対応](docs/implementation-results.md)、
[受け入れ記録](docs/operations/acceptance.md)を参照してください。

全19 task gateと単一の最終修正waveを完了し、code `63c1512f`に対するcontrollerの
最終ローカル検証はNode331/331、Python3/3、3root infra、type/lint/build/package、
両audit全severity0で成功しました。修正waveのTerraform covering証拠は78mockです。
記録timestampは`2026-10-05T19:42:04.110074+00:00`（文書更新2026-10-06）。
scoped独立re-reviewも完了し、5件すべての修正を確認しました。新たなCritical/Importantはありません。
診断artifact取得後の権限に関する文書のMinor1件を後続保守へ残しています。
[最終レビューと制限](docs/implementation-final-review.md)、[全52件の判断](docs/implementation-rulings.md)
を参照してください。ZIP/SBOMの実測値は上記受け入れ記録にあります。

正式ローカルE2Eは別の設計・計画としてレビュー中です。
[設計案](docs/superpowers/specs/2026-10-08-reminder-server-formal-e2e-design.md)、
[実装計画](docs/superpowers/plans/2026-10-08-reminder-server-formal-e2e.md)、
[要件対応表](docs/operations/formal-e2e-coverage.md)、
[関連文書の確認結果](docs/operations/formal-e2e-document-impact.md)を参照してください。
本番Terraformの3rootを再利用したFloci構築・設定確認後に、入力に対するHTTP・DDB・S3・ログを照合する案です。
正式E2E用のnpm入口とAPI操作の結果ログは未実装です。上記の過去の成功件数には含めません。

## ローカル検証

Node **24.21.0**、npm **11.11.1**、Python **3.13.16**、Terraform **1.16.5**、
固定AWS provider **6.67.0**を使います。Pythonはuvで導入できます。
`.devcontainer`は変更対象外です。Bash/jqは補助guardに必要です。
このrepositoryはLambda handlerを提供し、ローカルHTTP listen用start scriptはありません。

```sh
uv python install 3.13.16
# python3 が3.13.16を指すPATHを設定する（uv python find 3.13.16で確認）
node --version
npm --version
python3 --version
terraform version
npm ci
npm run typecheck
npm run lint
npm run build
npm run package
npm run verify:zip
npm test
npm run test:packaging
npm run infra:check
npm run audit:runtime
npm run audit:all
npm sbom --sbom-format cyclonedx > artifacts/sbom.json
# .devcontainerの承認済み起点からの差分がないこと
git diff --exit-code 253e5e2 -- .devcontainer
```

`infra:check`は3rootのbackendなしinit/validate/provider schema/mock/fmtです。
AWS認証やbackend接続は不要です。Provider初回取得にはregistry/release配布元への
通信が必要です。任意のdownload cacheはGitへ入れません。
実装用に準備済みのworktreeでは、全npm/npx/Python/preparation commandに
`PATH=/tmp/aws-sdd-tools/node_modules/.bin:/tmp/aws-sdd-tools/bin:$PATH`を付けます。
固定Python実行可能ファイルを使う場合もpackage scriptが`python3`で呼ぶためPATHを揃えます。

| command | 用途・入力 |
| --- | --- |
| `npm test` | runtime/operations/delivery。先にbuild/package |
| `npm run test:runtime` / `test:operations` / `test:delivery` | 合成fixtureによる個別suite |
| `npm run typecheck` / `lint` | strict TypeScript、typed ESLint |
| `npm run build` / `package` / `verify:zip` / `test:packaging` | bundle、再現可能ZIP、単独load/hash、Python packaging試験 |
| `npm run infra:check -- --root=bootstrap` | 任意1root。platform/applicationも可、省略は3root |
| `npm run audit:runtime` / `audit:all` / `sbom` | 依存auditとCycloneDX SBOM。High/Criticalで失敗 |
| `npm run migrate:json -- --mode dry-run --source /private/source-copy.json --mapping /private/owner-map.json --config /private/target.json` | AWS clientを作らないdry-run。実データを本作業で読まない |
| `npm run recovery:verify -- --source-config /private/live.json --restored-config /private/restored.json --owner-identities /private/current-owners.json --run-id <uuid>` | 将来の実AWS読み取り。明示prepare/preserve/mapだけ復旧先を変更 |
| `npm run release:register -- <explicit flags>` | 将来の実S3登録。全flagを下記に記載 |
| `npm run release:inspect-plan -- <explicit flags>` | root・保存plan・exact inputs・baseline・commitの私有照合 |
| `npm run release:verify -- --artifact /private/artifact.json --outputs /private/outputs.json --region <region>` | 将来の実Lambda2alias/CodeSHA照合 |
| `npm run release:smoke -- --baseline /private/baseline.json --base-url <known-api-url> --published false` | 将来のstatus-only HTTP read。baseline一致必須 |
| `npm run release:workflow -- plan` | GHA専用有限helper。authorize/secure/plan/applyの1phaseのみ、必須env/custodyはdeployment手順 |

登録flagは`--zip --manifest --bucket --region --commit --npm-version --esbuild-version
--audit-id --sbom-id --tests-id`の全10個で、それぞれ値が必要です。toolsは
24.21.0/11.11.1/0.28.2、evidence値は保管した実ファイルの`sha256:<digest>`。
登録はimmutable key/version/checksumを証明し、異なる既存bytesを再利用しません。
`--manifest`の出力はReleaseManifest、他release CLIの`--artifact`はその`.artifact`
だけを私有ファイルへ抽出したRegisteredArtifactです。

```sh
npm run release:inspect-plan -- --mode review --root application \
  --plan-json /private/plan.json --plan /private/saved.tfplan \
  --inputs /private/inputs.json --baseline /private/baseline.json \
  --commit <full-commit-sha> --manifest /private/review.json --artifact /private/artifact.json
# apply直前は同じsaved binary由来JSONで --mode check。platformはartifact省略/null
```

これらのAWS/HTTP/私有入力例は将来の別途承認された運用用です。
本作業の検証commandは上のローカル検証blockと合成テストだけです。

## API v2とChrome認証

Cognito Essentialsのユーザー作成・無効化・パスワード管理はAWSコンソールだけで
行います。公開clientはclient secretなし、Authorization Code + PKCE/S256、
read/write scope分離、access/ID tokenは5分、refreshは30日、rotation猶予10秒。
拡張は使用直前に期限を確認しsingle-flightで自動更新します。
[classic Hosted UI/Chrome認証契約](docs/chrome-extension-cognito-auth.md)を参照。
公開SRP/password/user/custom InitiateAuth経路を閉じるためexplicit auth flowは
IAMが必要な`ALLOW_ADMIN_USER_PASSWORD_AUTH`のみ。runtime/GHA/運用toolは
AdminInitiateAuth権限や呼出しを持ちません。この設定とclassic Hosted UIの実login
互換性は未検証です。

合成入力の完全な例です。BearerはCognito **access token**、ID tokenではありません。
以下の実通信は本作業では実行しません。

```sh
curl -i -X POST '<api-base-url>/v2/reminders' \
  -H 'Authorization: Bearer <access-token>' -H 'Content-Type: application/json' \
  --data '{"id":"acceptance-d08-001","url":"https://example.test/reminder","title":"Synthetic reminder","reminderTime":"2026-10-05T09:00:00+09:00","autoOpen":false,"webPush":true,"hidden":false,"thumbnail":null}'
curl -i '<api-base-url>/v2/reminders?limit=20' -H 'Authorization: Bearer <access-token>'
curl -i '<api-base-url>/v2/reminders/acceptance-d08-001' -H 'Authorization: Bearer <access-token>'
curl -i -X PATCH '<api-base-url>/v2/reminders/acceptance-d08-001' \
  -H 'Authorization: Bearer <access-token>' -H 'Content-Type: application/json' \
  -H 'If-Match: "<exact-opaque-etag-from-item-get>"' --data '{"title":"Synthetic updated title"}'
curl -i '<api-base-url>/v2/reminders/acceptance-d08-001/thumbnail-url' -H 'Authorization: Bearer <access-token>'
curl -i -X DELETE '<api-base-url>/v2/reminders/acceptance-d08-001' \
  -H 'Authorization: Bearer <access-token>' -H 'If-Match: "<latest-exact-opaque-etag>"'
```

`thumbnail:null`の例では画像URLは404。画像付き試験はPNG/JPEG/GIF/WebPの元bytesを
canonical BASE64/data URLでPOST/PATCHし、item DTOはメタデータだけを返します。
PATCH/DELETEはGETの引用符込みopaque ETagを使い、428/412を競合として扱います。
一覧の空itemsでもnextCursorがあれば続けます。削除ID再利用は409。
時刻はoffset必須でUTCへ正規化します。全DTO、画像例・header・エラー・cursorは
[API v2仕様](docs/api-v2.md)。既定本文2MiB、画像1MiB、1000件/owner、画像128MiB/owner、
120回/UTC分。正のsafe integer設定で上下に変更可能です。[.env.example](.env.example)
はloadConfigのpublic sampleで、dotenvを自動loadしません。

画像署名URLは15分。API tokenの残り最大約5分に発行すれば、Cognito無効化後も
画像を最大約20分取得できる場合があります。URLはログ/同期データに保存せず、
S3へBearerを送りません。オフライン表示には取得済み画像bytesを拡張側で保存します。
S3 credential期限による早期失効や独立した画像削除もあり、常に20分保証ではありません。

## AWS deliveryと運用

[deployment手順](docs/operations/deployment.md)の必須入力・Environment・OIDC subject・
private-reader範囲を設定します。private repositoryのみ、manual main dispatch、完全40桁
commit、preview→review digest→apply。platform/applicationのplan/apply/artifact roleを分離し、
private artifactsは1日。Environment reviewer availabilityを実アカウントで確認します。
通常applicationは既知API baseline/ID、seed=false、実登録artifactが必須。
初回はbootstrap→platform→operator API-only seed→bootstrapへID handoff→application。
[seed手順](infra/application/production/README.md)の64zero keyを持つUNUSED descriptorは
API targetだけの必須schema用で、RegisteredArtifactではなく登録・HEAD・Lambdaへ使いません。

LambdaはZip/nodejs24.x/x86_64。API512MiB/10秒/concurrency10、cleanup512MiB/660秒/
concurrency1、integration15秒/stage20rps/burst40。同じZIPの`dist/api.handler`と
`dist/cleanup.handler`を使い、source map/THIRD_PARTY_NOTICESを同梱、minifyなし。
ZIPは50MB未満/展開250MB未満、S3 bytes SHA/key/versionとLambda CodeSha256を照合。
API URL/Cognito identity変更・unknown・replacement・alias不一致を通常releaseで拒否します。

[JSON移行](docs/operations/migration.md)は私有コピー・owner mapping・dry-run・run UUID・
再開可能import→全件verify→明示publish。[PITR復旧](docs/operations/recovery.md)は
35日windowの新table、元S3 version保持、必要な画像を新key/current versionへ保全して全件検証。
非現行画像の60日lifecycleはPITR復旧後に参照versionをcurrentへ保全する手順を代替しません。
DynamoDB PITRはCognito資格情報を復元しません。新subはconsole確認・明示owner remapが必要です。
[日次/手動画像清掃](docs/operations/cleanup.md)は03:00 UTC、初期DISABLED。
[料金表](docs/aws-cost-estimate-2026-10-02.md)は予算係数であり実測値ではありません。

RollbackはまずSchedulerを停止するreviewed deployment、in-flight確認、既存immutable ZIPの
証拠再検証、2production aliasとsmoke確認。alias更新は非原子的で、code rollbackはデータを
戻しません。旧JSONへの復帰は新規書き込み開始前だけ可能です。

## 秘密と開発指示

[CLAUDE.md](CLAUDE.md)が共通指示、AGENTS.mdはそのsymlinkです。私有.env/state/plan/
mapping/画像/backup/artifacts/cacheはGitに入れずpublic `.example`を使います。
`.env.actions`と`reminders.json`はローカルを保持してindexだけ外し、過去履歴は変更していません。
補助hookは文字列検査でsandboxの代わりにはなりません。Codex/Claudeの対応・trust・
有効feature・harness読み込み条件と未実施integrationはCLAUDEに記載しています。
