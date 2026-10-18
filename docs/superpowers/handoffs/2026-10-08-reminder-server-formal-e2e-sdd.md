# 正式E2E実装の新セッション用プロンプト

2026-10-08作成。以下の本文を新セッションの最初のメッセージとして使用する。
元のAWS実装19タスクは完了済み。今回は既存のローカル検証を基に、要件との対応が明確な正式E2Eを設計・実装する。
製品のAWS設計は承認済みだが、正式E2Eの設計・実装計画はまだ承認されていない。

同日追補: [設計案](../specs/2026-10-08-reminder-server-formal-e2e-design.md)、
[計画案](../plans/2026-10-08-reminder-server-formal-e2e.md)、
[要件対応表](../../operations/formal-e2e-coverage.md)、
[関連文書の確認結果](../../operations/formal-e2e-document-impact.md)を作成・改訂済み。いずれもレビュー中。
以下のプロンプトには初稿からの条件変更も追記した。過去の記録や承認状態は維持する。

```text
$superpowers:brainstorming
$superpowers:subagent-driven-development

reminder-serverの正式なローカルE2Eを設計・実装してください。
まず承認済み製品要件と既存テストを読み、要件別の検証対応表、E2E設計、実装計画を提示してください。
正式E2Eの設計・計画の承認後はSDDで実装・実行・レビューまで完了してください。
実行方式はSDDを選択済みなので再確認は不要です。承認済み製品設計自体の再承認も不要です。
設計承認前は調査・検証対応表・文書作成まで進め、E2E実装や製品動作の変更は開始しないでください。

2026-10-08の設計レビューによる追補（この設計案の実装承認はまだない）:
- 既に設計案と実装計画がある。最新版のspec/plan、formal-e2e-coverage/research/cost-and-logging/document-impactを読み、未完了のレビュー段階から再開する。初稿の方針で設計し直さない。
- Terraform構築と設定読み戻しは補足probeではなく必須基盤とする。既存の本番3rootの公開.tf/lockを一時rootで再利用し、E2E専用resource定義、module抽出、本番.tf/lock/address変更は行わない。
- 接続・隔離差分だけで検証する。削除防止/IAM/TLS/保持期間/規定上限を維持し、後片付けの保護解除は結果確定後にowned資源だけへ適用する。本番backend/private inputs/state/planは読まない。
- suiteごとにapply→設定読み戻し/ログsmoke→合成入力→HTTP/DDB/S3/CloudWatch照合→結果確定→回収を行う。ZIPはrun内共通、ケースごとのapplyはしない。
- 正常系・異常系とも各case内で出力を照合する。API削除はtombstoneと画像保持、24h保護後の清掃は現行GET404と元version保持。対象外の出力には理由を残す。
- API結果ログを1 Lambda呼び出し1件・安全なJSON512bytes以内で追加する範囲は、設計/計画の承認対象に含める。他の製品動作変更は別承認。既存ユーザー変更を含めず、この追加の明示pathだけを実装commitへ含める。
- 利用見込みは東京リージョン/月100リクエスト未満。旧version60日、ログ30日を維持する案であり、旧米国東部の費用表を東京総額と扱わない。
- E/Lは規定上限を維持する。容量境界は規定値I、rateはcount119合成seed後の実GET200→429で確認する。refreshの実10秒graceと30日絶対期限のAを区別する。
- 初期化で阻害された未開始caseはnot-run、入力後の保存/ログ不一致はfail。必須ケースの不足と回収error/leakを全体成功にしない。
- 清掃の未公開skip・不正eventは通常の終了ログを要求しない。開始と終了のIDが異なるため、現行のログ形式に沿って対応づける。
- 下記の「Terraformを使う場合」「E2E専用Terraform」は、run専用の合成inputs/local state/接続overrideを意味するものとして、この追補と最新版設計に従う。

目的:
- 現在の「主要経路が動く」確認から、必要な正常系・異常系・境界・状態遷移を要件に対応づけた正式E2Eへ進める。
- ケース数や成功回数だけで網羅性を主張しない。必要ケースの定義、実施証拠、検証できない部分を明確にする。
- リポジトリから再現でき、依存準備・fixture生成・実行・失敗時診断・後片付けが揃う構成にする。

開始時に確認する状態:
- Gitルート /workspace、rootブランチ feature/aws-modernization。
- アプリ実装worktree /workspace/.worktrees/aws-sdd（2026-10-18に削除。現在はリポジトリ直下 /workspace を使う）、ブランチ feature/aws-sdd-implementation。
- 記録時のアプリHEAD c13272424a3bcb65b6a4613682889be02335c978。新セッションでは実際の状態を確認し、resetやcheckoutでこの値へ戻さない。
- 元のR01〜R08 / O01〜O03 / D01〜D08、全19タスクは完了済み。再実装・再dispatchしない。
- 既存の未コミット変更、untrackedのローカル検証・報告書、rootのFW変更を上書き・削除しない。
- まず既存worktreeの隔離状態を確認する。別worktreeが必要なら作成してよいが、必要な未コミット成果物は非秘密の明示したパスだけを安全に引き継ぐ。
- /tmpのツールや過去ログはリビルドで消える。/tmpにしかない成功ログを新セッションの一次証拠と扱わない。

最初に読む文書（アプリworktree相対）:
1. AGENTS.md（symlink先のCLAUDE.mdを含む）、README.md
2. docs/superpowers/specs/2026-10-02-reminder-server-aws-design.md
3. docs/superpowers/plans/2026-10-03-reminder-server-aws.md と runtime / operations / delivery の3サブ計画（完成済みの製品契約として読む）
4. docs/superpowers/handoffs/2026-10-03-reminder-server-aws-sdd-resume.md
5. docs/implementation-results.md、docs/implementation-final-review.md、docs/operations/acceptance.md
6. docs/operations/local-e2e-floci-authenticated-results.md
7. docs/operations/local-e2e-floci-refresh-result.md、local-e2e-floci-null-body-fix-results.md
8. docs/chrome-extension-cognito-auth.md、docs/operations/cleanup.md、migration.md、recovery.md、deployment.md
9. tools/local-e2e/floci/ の既存スクリプトと、tests/runtime / tests/operations / tests/delivery の関連テスト
10. root /workspace/.devcontainer/floci/README.md、Dockerfile、local-jwt-command.sh と root docker-compose.yml のFloci部分

現行ローカル環境と既存検証:
- AWS互換ローカル環境はFlociを使用する。MiniStack/LocalStackへの切り替えや独自AWSエミュレーターの新規実装はしない。
- 現行イメージ floci-local:2.2.0-refresh.1-native、health version 2.2.0-local-refresh.1-native。
- 接続先 http://floci:4566。issuer/JWKSは起動時に決まるFloci自身のprivate literal IPv4。IPを固定せずdiscoveryから確認する。
- FLOCI_SECURITY_ALLOW_PRIVATE_JWT_TARGETS=trueはFlociだけに設定。Docker socketもFlociだけに共有済み。開発コンテナにDocker socket/CLIを追加しない。
- root/appのfloci-refresh.patchは同一で、OAuth refreshと同一path templateで具体的HTTP methodをANYより優先する修正を含む。
- 基準Floci upstream 17c99047b92b5729b356f3584513cd6ed598b8a9、現行patch SHA256 2d01320d2d559f610992e807e05989c2b17a3a37690e03ebbc816cb3b40e954a。
- 記録時はtransport2件、refresh9件、認証付きCRUD1件の合計12テストが成功。CRUD内18チェック、cleanup11 action、cleanup error0。
- 実PKCE→公開JWKS署名検証→Gateway JWT authorizer→Docker Lambda→DynamoDB/S3を使用している。既存成功は必要ケース全体の網羅を意味しない。
- S3の既存E2Eはbucket/versioning/readiness/cleanupまで。画像保存・署名URL・清掃機能全体は未網羅。
- Floci作業コピーの補足回帰14件は配布patch未収録。配布patch内のQuarkus回帰2件と区別する。
- 保存済みZIPはnull-body対応済み。旧検証ではSHA256 6d3780c466a142039876a02f4ec99e389da874a8e9b22508ff90d1a194913915を固定している。正式E2Eは現行ソースからbuild/packageしたZIPを検証し、固定した古いZIPだけが通る構成にしない。

設計と検証対応表で必ず検討する項目:
1. 認証: PKCE/S256、JWT署名・issuer・client/audience・期限・token_use・scope、refresh/rotation/猶予/失効。拒否理由を独立して確認できる負例にする。
2. API契約: health/readiness、旧APIの廃止応答、v2 CRUD、所有者分離、存在しない項目、未対応method/route、CORS/preflight、メディア型、JSON/項目/日時/サイズ/容量などの入力境界、一覧/cursor。
3. 競合と保存: 強いETag/If-Match、同時更新・同時削除、transactionの整合、重複・再試行、tombstone、失敗後のDynamoDB/S3状態。順番に古いETagを使うテストと本当の並行要求を区別する。
4. 画像: 承認済みBASE64/data URL入力、元bytesのS3保存、metadata/version/checksum、15分署名URLによる取得、所有者境界、差し替え/削除/失敗時の孤児job。DynamoDBへ画像bytesを保存しない。画像変換やS3直接upload APIは承認済み仕様の対象外で、新たに追加しない。
5. 清掃: 実清掃Lambda、pending/retired/deletingの状態遷移、24時間保護、20分lease、GSI、checkpoint、処理上限、中断/再開/再実行、参照中画像・version不一致の保護。長時間sleepに依存せず、合成日時/状態を利用する方法と検証限界を設計する。
6. 運用: 合成JSON移行・復旧照合・再実行安全性、ZIP整合、API/清掃の同一artifact、Scheduler設定・起動経路。Floci対応範囲でどこまで実結合できるかを確認する。
7. 障害: 依存サービス失敗、timeout、結果不明、部分成功、後片付け失敗。決定的な失敗注入と実AWS互換経路のどちらを検証しているか区別する。
8. Terraform apply検証: Floci限定のapply→実ZIP/Lambda/Gateway/保存先→動作確認→destroyを構成できるか調査し、対応サービス/不足API/採否を示す。本番Terraformを無理に書き換えてエミュレーターへ合わせない。

検証対応表には「要件ID/出典、ケース、期待するHTTP・保存状態・副作用、正常/異常/境界、既存テスト、追加E2E、検証層、Floci対応可否、未検証理由」を含める。
上記すべてを無条件に1本の巨大E2Eへ詰め込まない。単体・結合・ローカルE2E・実AWS受け入れの適切な層へ割り当て、E2Eに必要なケースと対象外の根拠を示す。
性能保証、本番IAM同等性、実AWS固有の挙動をFloci成功から推定しない。
Chrome拡張本体がリポジトリにない場合はブラウザ/実拡張E2Eを実施済みにせず、HTTP/PKCE検証との境界を明記する。

正式E2Eの実装要件:
- 承認後、通常のリポジトリ内テストとして配置し、npm scripts等で再現可能な実行入口を用意する。
- 現行build/packageから得たZIPのSHA-256と登録後CodeSha256等を検証する。
- 接続先は明示したローカルFlociに限定。SDK/providerはdummy credentials、明示region/endpointを使用し、共有AWS profile/metadata/default endpointへfallbackさせない。
- 実Hosted UI PKCE・署名・Gateway・Docker Lambdaを維持する。偽造authorizer context、routeの削除/並べ替え、JWT/scopes/入力制約の緩和で成功させない。
- 独立したfixtureとテストケースに分割し、特定ケースの失敗による未実施を明示する。安易なretryで不安定さを隠さない。
- random owned prefix、合成ユーザー/データ、実行単位で隔離したリソースを使用。途中失敗でもfinallyで回収し、cleanup errorを本体結果と別に扱う。
- Terraformを使う場合もE2E専用の合成入力とローカルstateを使い、本番state/backend/plan/inputsは参照しない。destroyは当該テストの所有リソースだけに限定する。
- 安全な失敗診断を残し、JWT/code/cookie/password/署名URL/credential/個人データ/全envを出力しない。
- 日本語README、ケース対応表、実行結果、既知制限を保存する。CI実行方法も設計で検討するがGHAは起動しない。

承認・作業境界:
- 許可対象はローカルのコード・テスト・文書・必要な検証ツール準備と、Floci上の合成リソースだけ。
- Floci限定の検証用Cognitoユーザー/role/table/bucket/API/Lambda作成・削除、ZIP登録、手動清掃呼出し、E2E専用Terraform apply/destroyは設計承認後の検証に含めてよい。
- 実AWSの構築・操作・デプロイ・実データ移行・本番ユーザー操作・PITR・GHA起動・push/PR/mergeは対象外。
- rootのFW scriptはユーザー変更なので編集しない。.devcontainerは現在のFloci設定を保持し、変更が必要なら理由と具体的差分を提示する。接続先追加やhost rebuildが必要なら、必要作業を保存して区切りで一時停止する。
- 実reminders.json、private .env/.env.actions、AWS credentials、private mapping、Terraform state/plan/private inputs、実画像backupは、読む/hash/表示/copyしない。全envをdumpしない。
- 製品要件を変更しない。実装中に製品バグやFloci非互換が見つかったら、最初に根本原因と独立した失敗ケースを示し、E2E修正・Floci修正・製品修正を区別する。製品動作を変える修正は内容を提示し、承認なしに混ぜない。
- コミットが必要なら新E2Eの明示したファイルだけを対象にし、既存ユーザー変更を混ぜない。既存の履歴を改変しない。

実行方式:
- Node24.21.0/npm11.11.1、Python3.13.16、Terraformを使う場合1.16.5/provider6.67.0。既存AGENTS/READMEの固定値を守る。
- npm/npx/Python/準備コマンドには PATH=/tmp/aws-sdd-tools/node_modules/.bin:/tmp/aws-sdd-tools/bin:$PATH を付け、不足ツールを復元する。Node25で代用しない。
- 新しい正式E2E用spec/plan/SDD台帳を作り、完了済みの過去計画を新しい実行台帳として流用しない。過去成果・証拠は削除しない。
- 承認後の実装者はタスクごとに新規サブエージェント。実装者の追加subagentは禁止。共有fixture/状態を変更する実装者は並列に走らせない。
- RED→最小実装→GREEN→自己レビュー→独立した仕様/品質レビュー。SDDの修正ラウンド上限を守る。最後に最も能力の高い利用可能モデルで正式E2E全体をレビューする。
- タスク間の「続けますか」は不要。完了・失敗・未実施・Floci制限を区別し、判断と影響を台帳へ残す。
- library/API/CLIの設定・互換性調査ではAGENTS.mdのContext7手順を使い、sandbox外で実行する。quota時は明示し、学習済み知識へ黙ってfallbackしない。

最終完了条件:
- 承認済みの必要E2Eケースが実行入口から再現でき、実行結果・保存状態・副作用をassertする。
- 要件別対応表が実装ケースと一致し、未実施・対象外・エミュレーター非対応が明示される。
- 既存テストとbuild/package/typecheck/lintの必要な回帰確認が成功する。
- fixtureの漏れとcleanup errorがなく、秘密や実データを使用・記録しない。
- 日本語の結果報告にコマンド、実行条件、成功/失敗/skip/cleanupの件数、レビュー、残る制限を記録する。

まず既存状態と仕様を調査し、要件別の検証対応表と正式E2E設計・計画を提示してください。
```

## 6指摘への改訂追補（2026-10-08、先の追補より優先）

設計・計画は引き続き未承認。以下が本文内の旧suite別構築・Gateway配信必須・APIログ同時実装を更新する。再開時は最新版の設計・E2E計画・対応表・調査・費用・文書確認と[独立APIログ計画](../plans/2026-10-08-reminder-server-api-result-logging.md)を読む。

- 3root基盤/ZIPはrunにつき一組、suiteは逐次。初期seed/API ID引き渡しには複数applyがあるが、suiteごとに再構築しない。suite間は合成データ回収と公開状態/checkpoint等の復元・読み戻し。OIDC providerはaccount+URLの単独所有とし、同accountの並行run・未知既存providerを拒否する。
- 別issuerには最小のSDK Cognito control pool/client/resource server。復旧先は本番同schemaのSDK合成3tableと既存restored_tables/data sourceで検証し、同じ3root/stateの入力切替・読み戻し・{}への復元を行う。追加bootstrap/OIDC/3root stackを作らない。切替中はAPI入力/Schedulerを止める。実PITR/AWS切替は未検証。
- Gateway v2 accessLogSettings/log group設定保持は必須、実配信は互換性調査へ変更。配信unsupportedでも理由・制限を記録すれば調査は完了できる。API/清掃実配信は必須。認証拒否はHTTP/保存不変・前後正常対照のAPIログと観測窓内の不在を合わせ、不在だけで未到達を断定しない。
- ログ期待を各caseで登録し、suite末尾に最終対象入力から最大60秒で一括照合する。確定前のpassは禁止。対照ログ欠落やobserver障害は実施済みcaseのfailとして残す。
- override fileはvalidation/postconditionの上書きを禁止する。applicationのcognito_issuer/cognito_auth_base_urlの2validation条件・安全なerror_messageだけを一時コピー内で接続先との完全一致へ変換する。platform同名2output.valueもlocal URLへoverrideする。元本番.tfは不変、変換前/後digest・構造差分を検査する。回収時のprevent_destroy scalar overrideは既存postconditionを保持し、再定義しない。固定TF1.16.5でoffline確認を行う。
- API結果ログは独立計画の承認・実装・検証・commitを先行させる。E2E Task2はその前提確認だけで、製品変更を混ぜない。両計画の台帳は別々に作り、旧台帳を流用しない。実行方式の再確認は不要。
- 工程別見積もりは22〜65分（実測前）、run本体75分/回収15分/全体90分。実測後に更新する。TLS policy保持はpolicy-present、S3でのTLS強制未検証はenforcement-unverifiedとして別記し、HTTP成功を強制の証拠にしない。

この追補では文書のみ更新した。実装、Floci資源作成、apply、AWS/GHA/push/PR/mergeは行っていない。元の本文と未追跡状態は保持する。

## 承認と実装用プロンプトへの引き継ぎ（2026-10-08、最新）

6指摘への改訂（commit 2d275c0）提示後、ユーザーから「承認します」「別セッションで実装するためプロンプトを準備してください」と指示を受けた。正式E2E設計・対応表・E2E計画と独立API結果ログ計画は承認済み。実装は未着手である。
次のセッションでは[承認済み実装引き継ぎとプロンプト](2026-10-08-reminder-server-formal-e2e-implementation.md)を使い、API結果ログの独立実装・検証・レビュー・commitから開始する。本書に残る「未承認」「設計から開始」は当時の記録であり、新しい引き継ぎが優先する。既存の本文・未追跡状態を保持する。
