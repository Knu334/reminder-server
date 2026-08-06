# agentic-devcontainer 説明資料 設計書

作成日: 2026-08-07

## 背景

`agentic-devcontainer` は Claude Code / Codex CLI 向けの DevContainer テンプレートである。
firewall によるアウトバウンド制限、`.env` 読み取り拒否、Bash コマンドの事前検査フックによって、
AI エージェントを隔離環境で安全に動かすことを狙った構成になっている。

現状、このリポジトリの説明は `README.md` の導入手順のみで、「なぜこの構成なのか」「何が安全になるのか」を
社内に説明する資料が存在しない。これを整備する。

## 読み手とゴール

| 項目 | 内容 |
| --- | --- |
| 読み手 | 意思決定者（非エンジニア含む）と、開発チームメンバー |
| 場 | 両者が同席する 1 回の説明会。口頭説明あり。想定 25〜30 分 |
| ゴール 1 | 意思決定者から「このテンプレートを標準として採用する」GO を得る |
| ゴール 2 | チームメンバーが説明会後、各自のリポジトリに導入して使い始められる |

前半だけを聞いて途中退席した場合でも意思決定者が判断できるよう、前半で「なぜ」を完結させ、
後半で実務手順に降りる構成とする。

## 成果物

Marp（Markdown ベースのスライド）で 1 本の資料を作成し、HTML / PDF / PPTX に出力できる状態にする。

```
docs/slides/
  agentic-devcontainer.md        # スライド本体（唯一の編集対象）
  theme.css                      # 日本語フォント指定と最小限の配色
  build.sh                       # 図の生成とスライド変換をまとめて実行
  diagrams/
    architecture.mmd             # Mermaid ソース（図の正）
    boot-sequence.mmd
  assets/
    architecture.svg             # mmdc による生成物
    boot-sequence.svg
```

## フォーマット選定

**採用: Marp。**

この資料の内容（firewall の許可ドメイン、`postStartCommand` の起動順、ファイルパス）は
コードが変わると嘘になる情報である。資料をプレーンテキストで同一リポジトリに置くことで、
コード変更時に `git diff` で資料の陳腐化に気付ける。この点が「メンバーが継続的に使い始められる」
というゴールに最も効く。1 ソースから投影用 HTML・配布用 PDF・意思決定者向け PPTX を出力できる点も適合する。

**却下した案:**

- **reveal.js / 素の HTML** — レイアウト自由度は最大だが記述量が多く、後からの編集が難しい。
  PPTX 出力も実質不可。社内 1 回の説明会に対して過剰。
- **Markdown ドキュメントのみ** — 最小コストだが投影に向かない。「口頭説明あり・意思決定者同席」という
  今回の場に対して弱い。

## ビルド方法

`build.sh` は以下を順に実行する薄いラッパーとする。

1. Playwright が導入済みの Chromium バイナリを `find` で解決する
2. `mmdc` 用の puppeteer 設定 JSON を一時ファイルとして生成し、`diagrams/*.mmd` を `assets/*.svg` に変換する
3. `CHROME_PATH` を設定して `marp-cli` を実行し、HTML / PDF / PPTX を出力する

```bash
# 概念コード。実装時に build.sh へ落とす
CHROME_BIN="$(find "$HOME/.cache/ms-playwright" -name chrome -type f -perm -u+x | head -n 1)"

# 1) Mermaid -> SVG
printf '{"executablePath":"%s"}' "$CHROME_BIN" > "$TMP/puppeteer.json"
npx -y @mermaid-js/mermaid-cli@latest \
    --puppeteerConfigFile "$TMP/puppeteer.json" \
    -i diagrams/architecture.mmd -o assets/architecture.svg

# 2) Markdown -> HTML / PDF / PPTX
CHROME_PATH="$CHROME_BIN" npx -y @marp-team/marp-cli@latest \
    agentic-devcontainer.md --html --pdf --pptx
```

### 設計判断

- **`package.json` を作らない。** このリポジトリは DevContainer テンプレートであり Node プロジェクトではない。
  資料ビルドのためだけに `package.json` を置くと、テンプレート利用者が Node プロジェクトだと誤解する。
  `build.sh` に閉じ込め、依存は `npx` で都度解決する。
- **Chromium のパスにバージョン番号を直書きしない。** Playwright 更新でパスが変わるため `find` で解決する。
  同様に puppeteer 設定 JSON も一時ファイルとし、リポジトリに残さない。
- **実行ディレクトリに依存しない。** `build.sh` はスクリプト自身の位置を基準にパスを解決し、
  リポジトリのどこから実行しても同じ結果になるようにする。
- **ネットワーク前提。** `registry.npmjs.org` は firewall 許可済みのため `npx` は動作する。
  変換処理自体はオフラインで完結し、外部 CDN に依存しない。
- **日本語フォント。** コンテナに IPA ゴシックが導入済みであることを確認済み。
  `theme.css` で明示的に指定し、PDF / PNG 出力時の文字化けを防ぐ。

## スライド構成

全 16 枚。

### 前半 — なぜ必要か（意思決定者向け・7 枚）

| # | スライド | 内容 |
| --- | --- | --- |
| 1 | タイトル | agentic-devcontainer とは何かを一文で |
| 2 | 課題 | AI エージェントを実務投入する際の 3 つの不安 —— ローカル環境を直接触らせる怖さ、環境差異による属人化、認証情報の持ち出し |
| 3 | 解決 | 使い捨てコンテナ ＋ 出口を絞ったネットワーク ＋ コマンド事前検査、を一枚絵で |
| 4 | Before / After | 導入前後で開発者の作業がどう変わるか |
| 5 | 3 層の防御 | ネットワーク（`init-firewall.sh` の許可制）／シークレット（`.env` 読み取り拒否）／実行（`check-bash-command.sh` のフック） |
| 6 | 導入コスト | 必要なのは Docker と VS Code 拡張のみ。手順は `README.md` の 9 ステップ |
| 7 | 判断材料まとめ | ここで GO を取る |

スライド 5 は「安全性への安心」がゴールとして明示されなかったにもかかわらず含めている。
GO を引き出す局面では「AI にコードを触らせて大丈夫か」がほぼ必ず論点になるため、
先回りして 1 枚で答えを置き、質疑で時間を消費しないことを狙う。

### 後半 — どう使うか（メンバー向け・9 枚）

| # | スライド | 内容 |
| --- | --- | --- |
| 8 | アーキテクチャ図 | コンテナ・volume・ネットワークの全体像（`architecture.svg`） |
| 9 | 起動シーケンス図 | `postStartCommand` の実行順（`boot-sequence.svg`） |
| 10 | 導入手順 | bare clone → mirror push → clone → コンテナで開く |
| 11 | 最初に直す 3 箇所 | `.devcontainer/.env` ／ `CLAUDE.md` ／ firewall の許可ドメイン |
| 12 | 日常の使い方 | Claude Code / Codex CLI、Context7 でのドキュメント取得、Playwright CLI |
| 13 | Git 運用ルール | `feature-*` ブランチ ＋ `gh` CLI、`git push --force` / `git reset --hard` 禁止 |
| 14 | つまずきポイント | firewall による通信遮断の見分け方と直し方、設定が名前付き volume に永続化される話 |
| 15 | テンプレート更新の取り込み | `git remote add template` からのマージ手順 |
| 16 | 次のアクション | 各自が明日やること |

スライド 14 は後半の要とする。「各自が使い始める」を阻む最大の要因は firewall による通信遮断であり、
`npm install` が原因不明で失敗する形で表面化して原因究明に時間を取られやすいため、厚めに扱う。

## 図の仕様

Mermaid ソース（`.mmd`）を正とし、SVG は生成物とする。

- **architecture.mmd** — ホスト / コンテナ / 名前付き volume（`claude-code-config`・`codex-config`・
  `codex-agents`・`claude-code-bashhistory`）による設定永続化 / `mcp-net` と firewall による出口制御の関係を示す。
- **boot-sequence.mmd** — `postStartCommand` の実行順（`init-git.sh` → `init-playwright-cli.sh` →
  `init-firewall.sh` → `init-context7.sh` → `init-statusline.sh`）と、各ステップが何を用意するかを示す。

## バージョン管理方針

| 対象 | 扱い | 理由 |
| --- | --- | --- |
| `.mmd` | コミットする | 図の編集対象であり、差分レビューが可能 |
| `.svg` | コミットする | 生成物だが、コミットしないと GitHub 上で Markdown を開いた際に図が壊れる。ブラウザで資料を確認する経路を維持する |
| `.html` / `.pdf` / `.pptx` | コミットしない（`.gitignore` に追加） | バイナリ差分がリポジトリを膨らませる。`build.sh` で常に再生成できる |

説明会当日は各自がビルドするか、出力物を別経路で配布する。

## 検証方法

1. `build.sh` が HTML / PDF / PPTX の 3 形式をエラーなく生成すること
2. PNG 出力（`marp-cli --images png`）を目視し、全ページについて日本語が文字化けせず、
   図がスライド枠に収まっていることを確認すること
3. 以下の事実整合チェックを行い、資料の記述が実際のコードと一致することを確認すること

### 事実整合チェックリスト

| 項目 | 参照元 |
| --- | --- |
| firewall の許可ドメイン一覧 | `.devcontainer/init-firewall.sh` の `for domain in` ブロック（現状 13 件: `registry.npmjs.org`, `api.anthropic.com`, `marketplace.visualstudio.com`, `vscode.blob.core.windows.net`, `update.code.visualstudio.com`, `context7.com`, `api.openai.com`, `developers.openai.com`, `auth.openai.com`, `auth0.openai.com`, `chatgpt.com`, `sdmntprnorthcentralus.oaiusercontent.com`, `proxy.bar504.net`） |
| 起動スクリプトの実行順 | `.devcontainer/devcontainer.json` の `postStartCommand` |
| 名前付き volume の一覧 | `.devcontainer/docker-compose.yml` の `volumes` |
| `.env` に設定が必要な環境変数 | `.devcontainer/.env.sample` と `docker-compose.yml` の `environment` |
| `.env` 読み取り拒否の設定 | `.claude/settings.json` の `permissions.deny` |
| Bash フックの登録 | `.claude/settings.json` の `hooks.PreToolUse` と `.claude/hooks/check-bash-command.sh` |
| 導入手順 | `README.md` の「使用方法」 |
| Git 運用ルール | `CLAUDE.md` の「GitHub ワークフロー」 |

事実整合チェックの自動化（コードから値を抽出して突き合わせるスクリプト）は行わない。
対象が数項目に留まり、スクリプト自体の保守コストが上回るため。

## スコープ外

- `README.md` の書き換え。今回はスライド資料の新規追加のみを行う。
- `CLAUDE.md` のプロジェクト概要欄（現在プレースホルダ）の記入。別タスクとする。
- 対外公開向けの資料（ブログ・登壇用）。今回は社内説明会に限定する。
- 説明会の録画・ハンズオン環境の準備。
