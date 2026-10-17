# 開発の指示

AGENTS.md はこのファイルへの symlink である。link を保ち、このファイルを編集する。runtime や release tooling を変える前に、README.md と関係する運用文書を読む。本番は AWS HTTP API、Node 24 の Lambda ZIP、DynamoDB と S3 で構成する。人間が保守する可能性のある文書は日本語で書く。コマンド、パス、識別子は原文のままにする。

## 秘密情報

- 試験には合成の fixture だけを使う。
- 次のものは、開く、hash を取る、表示する、複製する、のいずれもしない。実際の reminders.json、.env、.env.actions、その他の私有 .env、AWS の認証情報、私有の mapping、Terraform の state・plan・私有入力、画像の backup、環境変数の一括出力。
- 公開の .env.example と、commit 済みの *.example は placeholder であり、秘密ではない。
- 設定は、秘密でないものを名前で1つずつ確認する。

## 承認が必要な操作

- `.devcontainer` は変更しない。
- 次の操作は、明示の承認なしに行わない。AWS の操作、実 ZIP の登録、GHA の手動実行と deploy、seed、移行、Cognito の user 操作、PITR、push、PR の作成、merge。
- CI は PR と `main` への push で自動的に走る（`ci.yml`、`floci-e2e.yml`）。`deploy.yml` は手動実行だけで、実 AWS を使う。
- AWS SDD の作業として承認済みの、ローカルの実装、文書、試験、機能の commit は、改めて承認を得なくてよい。

## Git

- stage は path を明示する。生成した cache、artifact、私有ファイルは stage しない。
- 履歴は書き換えない。index から外しても、過去の履歴に残った内容は消えない。
- 私有ファイルを index から外すときは `git rm --cached -- .env.actions reminders.json` だけを使う。ローカルのファイルは残し、存在だけを確認する。
- 差分は、私有の path を除外して生成する。全体の diff・stat・show を生成してから絞り込むことはしない。

```sh
git diff -- . ':!reminders.json' ':!.env.actions'
git diff --cached --check -- . ':!reminders.json' ':!.env.actions'
git diff --cached --stat -- . ':!reminders.json' ':!.env.actions'
git diff --cached --name-status --no-renames -- .env.actions reminders.json
```

## 検証

- ツールは Node 24.21.0、npm 11.11.1、Python 3.13.16（uv で導入できる）、Terraform 1.16.5、AWS provider 6.67.0 に固定する。
- 固定版のツールは、git 管理外の `.superpowers/tools/aws-sdd` に置く。npm、npx、Python と準備のコマンドには、`PATH=<リポジトリ直下>/.superpowers/tools/aws-sdd/node_modules/.bin:<リポジトリ直下>/.superpowers/tools/aws-sdd/bin:$PATH` を付ける。E2E の子プロセスは PATH を継承せず、このディレクトリから直接ツールを探す。
- 試験を読み、意味のある失敗する合成ケースを書き、最小限の実装をして GREEN を確かめる。
- ZIP の検査は artifact を使うので、`npm test` の前に `npm run build` と `npm run package` を実行する。
- `npm test` は offline 試験の後に Floci の正式 E2E を実行する。Floci が無い環境では `npm run test:offline` を使う。
- README のコマンド一覧を実行し、正確な件数と警告を報告する。mock やローカルの証拠と、実環境での受け入れを区別する。

## 補助の command guard

- `.claude/settings.json` には Read の deny と、Bash の PreToolUse hook がある。Codex も同じ hook（`.codex/hooks/check-bash-command.sh` は Claude の hook への symlink）を、`hookSpecificOutput.permissionDecision=deny` と exit 0 で使う。Codex では hooks の feature を有効にし、user が hook の定義を trust する必要がある。trust や設定の変更、bypass flag は、この repository の設定に含めない。
- hook はコマンドの文字列を検査するだけで、入力を実行しない。明らかな私有 path と環境変数の一括出力を拒否するが、shell の全構文、alias、symlink は解釈しない。access control の境界ではなく、実際の権限、sandbox、セッションの指示が優先する。
- hook の読み込み方は harness ごとに違う。合成の script 試験は、Claude、ChatGPT Work、Codex で実際に hook が効いていることの証明にはならない。
- hook には Bash と jq が要る。

## ライブラリの文書

ライブラリ、framework、SDK、API、CLI、cloud service について調べるときは、`ctx7` CLI で現行の文書を取得する。refactoring、一から書く script、業務ロジックの debug、code review、一般的なプログラミングの概念には使わない。web 検索より Context7 を優先する。

1. `npx ctx7@latest library <name> "<1つの概念についての具体的な質問>"` で解決する。名前は公式の表記にする（Next.js、Customer.io、Three.js）。`/org/project` は、名前の一致、関連性、snippet 数、reputation（High・Medium）、score で選ぶ。
2. `npx ctx7@latest docs <libraryId> "<具体的な概念>"` で取得する。概念ごとに分け、版の指定があれば `/org/project/version` を使う。
3. 取得した文書に基づいて答える。1つの質問につきコマンドは3回までにする。

Context7 は既定の sandbox の外で実行する。DNS やネットワークで失敗したら、sandbox の外で再実行する。質問に鍵、認証情報、個人情報、私有データを含めない。quota の error では失敗を伝え、`npx ctx7@latest login` か `CONTEXT7_API_KEY` を案内する。黙って学習データで答えない。OpenAI と Codex の設定は、まず手元の安全な code・help・schema を確認し、次に公式文書を見る。
