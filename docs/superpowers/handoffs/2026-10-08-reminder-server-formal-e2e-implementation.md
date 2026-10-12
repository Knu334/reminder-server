# 正式E2E実装の引き継ぎと新セッション用プロンプト

2026-10-08。状態: **設計・計画承認済み、実装未着手**。

## 承認の記録

同日の設計レビューで6指摘を反映した文書commitは `2d275c0e63c8bfcd65f661edd39cd8d586de0ed9`。
その提示後、ユーザーから「承認します」「別セッションで実装するためプロンプトを準備してください」と指示を受けた。
承認対象は以下の設計・対応表・両計画と、記載された接続・隔離・後片付けの限定差分である。

- [正式E2E設計](../specs/2026-10-08-reminder-server-formal-e2e-design.md)
- [要件別検証対応表](../../operations/formal-e2e-coverage.md)
- [独立API結果ログ計画](../plans/2026-10-08-reminder-server-api-result-logging.md)
- [正式E2E実装計画](../plans/2026-10-08-reminder-server-formal-e2e.md)

API結果ログとE2Eは双方の実装が承認された。API結果ログを独立した変更として実装・検証・レビュー・コミットし、その完了を前提にE2Eを実装する。両計画のSDD台帳も分ける。製品AWS設計とSDD方式は従前から承認済みであり、これらの承認・実行方式を再確認しない。
今回のセッションでは承認状態と引き継ぎ文書だけを更新した。製品コード/E2Eの実装、Floci資源作成、Terraform applyは行っていない。

旧[設計段階のハンドオフ](2026-10-08-reminder-server-formal-e2e-sdd.md)にある「未承認」「設計から開始」は当時の記録である。実装の再開には本書と最新版の承認済み文書を使う。

## 新セッションへ貼り付ける本文

```text
$superpowers:subagent-driven-development
$yomiyasu:yomiyasu

reminder-serverの承認済みAPI結果ログ追加と正式ローカルE2Eを実装し、必要な検証・独立レビュー・ローカルcommit・日本語の結果記録まで完了してください。
引き継ぎ文書は次のファイルです。
/workspace/.worktrees/aws-sdd/docs/superpowers/handoffs/2026-10-08-reminder-server-formal-e2e-implementation.md

承認状態と作業順
- 2026-10-08、6指摘を反映したcommit 2d275c0の設計・対応表・APIログ計画・E2E計画をユーザーが承認済み。SDD方式も選択済み。設計し直したり、同じ範囲の承認・実行方式を再確認したりせず、実装から開始する。
- 先に docs/superpowers/plans/2026-10-08-reminder-server-api-result-logging.md を実装・検証・独立レビュー・commitする。その後 docs/superpowers/plans/2026-10-08-reminder-server-formal-e2e.md をTask1〜12の順で進める。E2E Task2は先行ログ変更の完了確認だけで、製品コードを変更しない。
- 計画ごとに新しいSDD workspace/台帳を作る。台帳第一行は各計画の指定どおり。完了済み19タスク、旧SDD台帳、過去のローカルE2Eを再dispatch・流用しない。今回作る台帳で完了したタスクも重複dispatchしない。
- installed skillと両計画のcontroller/実装者/reviewer手順に従う。共有fixtureを並列実装しない。model/effortは現在のallowlistを確認し、計画の役割別指定に従う。controllerは実装を直さない。

最初に読む文書（以下はアプリworktree相対）
1. CLAUDE.md（AGENTS.mdがあればsymlink先も確認）、README.md、本引き継ぎ。
2. docs/superpowers/specs/2026-10-08-reminder-server-formal-e2e-design.md と上記の両計画。
3. docs/operations/formal-e2e-coverage.md、formal-e2e-research.md、formal-e2e-cost-and-logging.md、formal-e2e-document-impact.md。
4. docs/superpowers/specs/2026-10-02-reminder-server-aws-design.md、docs/api-v2.md、docs/chrome-extension-cognito-auth.md。
5. docs/operations/cleanup.md、migration.md、recovery.md、deployment.md、acceptance.md、docs/implementation-results.md、implementation-final-review.md。
6. 変更する機能の現行sourceと関連tests、公開infra README。過去local-e2e報告は補助資料として読み、今回の成功証拠へ転記しない。

開始時の状態とツール
- アプリworktreeは /workspace/.worktrees/aws-sdd、branch feature/aws-sdd-implementation。rootは /workspace、branch feature/aws-modernization。git status/worktree/HEADを確認する。記録のcommitへreset/checkoutしない。
- src/api/event.ts、tests/runtime/api.test.ts、tests/runtime/boundaries.test.tsの未コミットnull-body修正、未追跡の過去報告/計画/旧ハンドオフ、root FW/Floci READMEのユーザー変更を保持する。既存worktreeを使用し、別worktreeへの未コミット変更のコピーをしない。
- 現行sourceからZIPを作る。既存ユーザー修正はビルドへ含まれるが、実装commitへ混ぜない。非秘密の入力digest/dirty path/ZIP実測digestを記録する。古い固定ZIPだけが通る構成を引き継がない。
- 全npm/npx/Python/準備commandに PATH=/tmp/aws-sdd-tools/node_modules/.bin:/tmp/aws-sdd-tools/bin:$PATH を付ける。Node24.21.0/npm11.11.1/Python3.13.16/Terraform1.16.5/provider6.67.0を使用。不足toolだけを復元する。前回はTerraformがPATHになくoffline validateも未実施だったため、固定版での確認をTask3で行う。
- /tmpのtoolsやログは消える前提で確認する。過去/tmpログを新しい成功の一次証拠にしない。build/package後にZIPを消費する既存回帰を実行する。
- Flociは http://floci:4566、image floci-local:2.2.0-refresh.1-native、health 2.2.0-local-refresh.1-native。現在のhealthを再確認する。MiniStack/LocalStackへ切り替えない。

実装で維持する方針
- Terraform構築→設定読み戻し/必須Lambdaログsmoke→合成入力→HTTP/DDB/S3/API・清掃ログ照合→結果確定→保護解除/回収を実装する。基盤とZIPはrunにつき一組、suiteは逐次。初期seed/API ID引き渡しには複数applyがあるがsuiteごとに再構築しない。
- 本番3rootの公開定義を一時コピーで再利用する。本番.tf/lock/resource addressを変更せず、専用resource定義や共通moduleを新設しない。applicationのcognito_issuer/cognito_auth_base_urlの2validation条件・安全なerror_messageだけを一時コピーで置換し、platformの同名2output.valueをlocal URLへoverrideする。設計§8の許可リストと変換前/後digest・構造差分を検査する。
- validation/postconditionをoverride fileで上書きしない。回収時のprevent_destroy scalar overrideは既存postconditionを保持し、再定義しない。固定Terraform版のprovider不要offline試験で確認する。
- issuerのURL/host文字列はdiscoveryの値を維持し、DNSで確認した同一Floci private IPv4へsocketだけを固定する。接続先をJWT値から自動許可しない。元Host、署名URL/queryを維持し、未知host/public IP/redirect/profile/metadata/default AWS endpoint fallbackを拒否する。
- OIDC providerはaccount+URLの単独所有。同一accountの並行runや未知既存providerの採用を拒否する。別issuerは最小のowned SDK Cognito control資源だけ、復旧は同schema/protection/TTL/PITR設定のowned SDK合成3tableと既存restored_tables/data sourceを使う。追加bootstrap/3root stackを作らない。切替はAPI入力/Scheduler停止中に同じ3root/stateで行い、全rootを{}へ戻して読み戻すまでAPIを再開しない。
- caseごとに合成user/データを分離し、suite間は回収と公開状態/checkpoint等の復元・読み戻しを行う。清掃が他caseの候補jobを処理しないよう、ケース間のowned合成データ回収も計画どおり行う。未終了処理や復元不良があれば依存する未開始caseをnot-runにする。
- API結果ログは1 invocation 1件、安全なJSON本体512bytes以内。HTTP応答を変えず、既存helper/console/保持30日を使う。本文/画像/token/例外等を出さず、新SDK呼び出し・alarm・metric・subscriptionを増やさない。費用前提は東京/月100リクエスト未満、S3旧version60日を維持する。
- API/清掃の実CloudWatch配信とGateway設定保持は必須。Gateway v2配信/Scheduler起動/S3署名強制は必須互換性調査とし、実測・理由・制限付きunsupportedは調査完了にできる。未実施not-runや必須動作のunsupportedを成功にしない。v1直接proxy、console capture、手動PutLogEventsで実配信を代用しない。
- 各caseのログ期待を共通observerへ登録し、suite末尾に最終対象入力から最大60秒で一括照合する。確認前にpassにしない。認証拒否はHTTP・拒否直前/直後の保存不変・前後正常対照の実配信とAPIログ不在を合わせ、不在だけで未到達を断定しない。
- 本番の認証/16route/scope/schema/実行設定/規定上限/保持/削除保護/IAM/TLS policyを維持する。実PKCE→JWKS→JWT Gateway→現行ZIP Docker LambdaのAPI経路を使う。API直接invoke/偽claims/認証緩和をEへ混ぜない。削除はtombstone、画像は24h保護後のmarker/doneと元version保持を検証する。
- 見積もり22〜65分は未実測。run本体75分+回収15分、全体90分と各process/poll期限を実装し、実時間を記録する。S3 policy保持はpolicy-present、TLS強制未検証はenforcement-unverifiedとして別記し、HTTP成功から強制を推定しない。

作業境界と完了条件
- 許可対象は両計画のローカルコード/テスト/文書/必要tool準備/明示pathのfeature commit、およびFloci上のowned合成Cognito/role/table/bucket/API/Lambda/Logs/Scheduler資源、local ZIP登録、手動清掃、local Terraform apply/destroy。実AWS/GHA/push/PR/merge/実データ/本番ユーザー操作/PITRは対象外。
- 本番backend/private inputs/state/plan/.env/credentials/private mapping/実画像backupを読まない、hash/表示/copyしない。今回のrunが生成・所有するlocal state/合成inputsはdriver内でのみ扱い、公開証拠へdumpしない。秘密と全env、生ログ、raw例外/子process出力を保存・表示しない。
- FW/.devcontainer/host設定を変更しない。別の製品動作変更、Flociパッチ、接続先追加/host rebuildが必要なら、原因・独立失敗ケース・具体的差分・再開手順を保存し、承認済み範囲と分けて報告する。通常の可逆な実装判断や既に承認された手順の許可を取り直さない。
- inventoryを先に確保し、未開始caseのnot-runと入力後のfailを分ける。HTTP/DDB/S3/ログの全期待assertと対象外理由を照合する。finallyでowned回収・不在確認を行い、cleanup errors/leaksを本体結果と別集計する。
- 各計画の必要回帰・type/lint/build/package/verify:zip・audit・必要infra確認、正式E/L/Iと互換性probe、独立reviewを完了する。実施済み証拠がなければ完了を主張しない。API結果ログの結果は先行計画完了時、E2E結果/日本語README/limitations/対応表/既存記録への追補はTask12で更新し、yomiyasuで確認する。
- 実AWS/IAM/TLS/PITR/Chromeの未実施を明記する。必要Floci APIが不足して必須ケースを実施できなければ正式E2E未完了と報告し、設定を削って成功にしない。独立U/Iや文書・回収など実行可能な範囲は進める。
- 本セッションをcontrollerとして両計画の実装・検証・レビュー・結果保存まで進め、要承認の範囲外変更または外部環境の阻害が残った場合はその根拠を報告する。
```
