# AWS実装・SDD新セッション用プロンプト

以下を新セッションの最初のメッセージとして使用する。設計・計画の基準コミットは`5e3d6a8`、この引き継ぎ文書とSDD用見出しの変更はその後の文書コミットに含まれる。製品実装はまだ開始していない。

```text
$superpowers:subagent-driven-development

reminder-serverの承認済みAWS設計と実装計画を、SDD（Subagent-driven Development）で全件実装してください。設計・計画の再承認や実行方式の再確認は不要です。今回はリポジトリ実装・ローカル検証・レビューまでを実施してください。

作業状況:
- リポジトリ: /workspace（最初に実際のGitルートを確認）
- 起点ブランチ: feature/aws-modernization
- 設計・計画の基準コミット: 5e3d6a8。後続の引き継ぎ文書コミットも保持する。
- mainは作業開始前の6f15624。mainへ直接実装しない。
- 製品実装は未着手。新セッション開始時のHEAD、作業ツリー、既存worktree/台帳を確認し、既存変更を上書きしない。

最初に読む文書（Gitルート相対）:
1. docs/superpowers/specs/2026-10-02-reminder-server-aws-design.md
2. docs/superpowers/plans/2026-10-03-reminder-server-aws.md
3. docs/superpowers/plans/2026-10-03-reminder-server-aws-runtime.md
4. docs/superpowers/plans/2026-10-03-reminder-server-aws-operations.md
5. docs/superpowers/plans/2026-10-03-reminder-server-aws-delivery.md
6. docs/repository-audit-2026-10-02.md
7. docs/chrome-extension-cognito-auth.md
8. docs/aws-cost-estimate-2026-10-02.md

実行順はR01〜R08 → O01〜O03 → D01〜D08、全19タスク。サブ計画の数字のTask番号とR/O/D識別子の対応を維持する。旧SQLite案は採用しない。

承認済みの主要条件:
- .devcontainer配下は一切変更しない。F28/F29と他指摘の同配下部分は対象外として残す。
- productionのみ。Lambda ZIP、API Gateway HTTP API、DynamoDB、S3、Cognito、EventBridge Scheduler、CloudWatch、GHA/Terraformを使用する。ECR/Caddy/常設dev・staging/汎用管理CLIは作らない。
- Cognitoユーザー管理はAWSコンソールのみ。公開Code+PKCE/S256 client、access/ID token5分、refresh30日、rotation猶予10秒。毎リクエストの失効照会は追加しない。
- 所有者は検証済みissuer/subからのSHA-256。項目単位v2 API、revision/強いETag/If-Match、DynamoDB条件付きtransaction、旧API410を実装する。
- 画像は元bytesをS3へ保存し、DynamoDBへBASE64を保存しない。書き込みBASE64入力は維持し、読み取りはmetadataと別エンドポイントの15分署名URL。画像変換なし。
- Node24/CommonJS/esbuild。同じ自己完結ZIPをAPI/清掃2関数へ配布し、ZIP SHA-256・S3 key/versionId・Lambda CodeSha256を照合する。
- 清掃はScheduler日次→専用Lambda。初期DISABLED、24時間保護・20分lease・GSI/checkpoint/処理上限を設計どおり実装する。
- JSON移行/復旧照合の個別スクリプト、README、CLAUDE.md、既存AGENTS.md symlink修復を含める。現状CLAUDE.mdがなくリンク切れなのは既知で、D08の修正対象。
- 細かな値とAPI/保存/運用契約は設計と計画のGlobal Constraints/Interfacesに従う。解釈が衝突した場合は承認済み設計を優先する。

SDDの進め方:
- superpowers:using-git-worktreesで既存の隔離状態を確認する。必要な隔離worktree作成は許可する。必要ならfeature/aws-modernizationを起点に作業用featureブランチを作り、場所とブランチを記録する。
- この19タスクを一連の実装として管理し、サブ計画ごとのSDD台帳で完了コミット・レビュー・修正ラウンド・判断を記録する。新セッション/compaction後は台帳とgit logから再開し、完了タスクを再実装しない。
- pre-flightでタスク内部と共有ファイル/Interfacesの整合を確認し、衝突は設計に沿って判断し、Rulingとして理由・影響を台帳へ残す。
- タスクごとに新しい実装サブエージェントを使い、実装者の追加サブエージェントは禁止。依存と共有ファイルがあるため実装者を並列に走らせない。
- 実装者へ全会話を渡さず、当該タスクbrief、必要な仕様/既存Interfaces、report先を渡す。task-briefで抽出後、そのサブ計画のGlobal Constraints・共通型/キー/設定の節もbriefへ添え、「上記型」等の参照が欠落しないようにする。
- 各タスクでRED→実装→GREEN→自己レビュー→コミット。別のレビュー担当が仕様適合とコード品質を確認し、指摘修正と再レビューを行ってから次へ進む。SDDの修正ラウンド上限とモデル選択に従う。
- 全19タスク後に、最も能力の高い利用可能モデルでブランチ全体をレビューし、必要な修正・再検証を行う。未解消事項を修正済みと報告しない。
- タスク間の「続けますか」は不要。軽微な実装判断は根拠を記録して進める。進捗は短く伝え、詳細な結果は最終報告へまとめる。

作業・検証の境界:
- 依存追加/更新、Node24/Python/Terraform等の必要なローカル検証環境の準備、計画内コード・設定・文書の変更（認証/IAM/秘密保護のコード・IaCも含む）とfeatureへのコミットは許可する。
- 開始時点のpackage.jsonにはtest等の新scriptsがない。既知の初期状態を理由に停止せず記録し、計画の担当タスクで整備する。現在のNode25をNode24検証の代わりにしない。Pythonはuvを利用できる。
- 実reminders.json/.env.actions/.aws等の秘密・個人データの内容を読まない。実データをfixtureに使わず合成データとfake/mockで検証する。追跡済み秘密ファイルのuntrackはローカルを保持し、履歴改変しない。
- AWSリソース作成/変更、ZIPの実S3登録、実データ移行、Cognitoユーザー操作、GHA起動、デプロイ、push、PR作成、mainへのmergeは今回実行しない。これらのコード・設定・手順はレビュー可能な状態まで完成させる。
- AWSアカウント/リージョン/OIDC subject/origin/拡張ID等が未指定でも、ローカル実装とmock/static検証は進める。実値を推測したり、実AWSで検証済みと報告したりしない。
- 新しい外部API/ライブラリ設定を確認する場合はContext7を使用する。npx ctx7@latest library <公式名> "具体的な単一概念のquery" → 適切な/org/projectを選択 → npx ctx7@latest docs <ID> "query"。質問あたり最大3コマンド、外側sandboxで実行し、秘密値をqueryへ含めない。quota時は明示してlogin/CONTEXT7_API_KEYを案内する。

最終確認は全体計画のcommandsを実行する。特にbuild/package後のnpm test、展開ZIPのNode24実行、Terraform fmt/validate/mock、plan保護、依存監査、.devcontainerの差分なしを確認する。

最終報告は実装結果、検証証拠、コミット/ブランチ、全F/Bの対応・対象外・未検証、台帳の全Rulingと影響、AWS構築/移行/Chrome実確認等の未実行項目をまとめる。docs/implementation-results.mdも整備する。

準備とpre-flightが済んだらR01から開始し、途中で承認済み設計の再検討へ戻らず、対象内の実装を完了まで進めてください。
```
