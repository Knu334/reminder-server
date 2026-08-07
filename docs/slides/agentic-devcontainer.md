---
marp: true
theme: agentic
size: 16:9
paginate: true
---

<!-- _class: cover -->
<!-- _paginate: false -->
<!-- _footer: "" -->

<div class="kicker">社内説明会</div>

# agentic-devcontainer

<p class="cover-sub">AI コーディングエージェントを安全に実務投入するための、<br>DevContainer テンプレート。</p>

<div class="meta"><span>開発基盤チーム</span><span>·</span><span>2026</span></div>

---

<!-- _class: content -->

## 本日の内容

<div class="toc">
<div class="toc-row"><span class="toc-num">01</span><span>課題</span></div>
<div class="toc-row"><span class="toc-num">02</span><span>仕組み</span></div>
<div class="toc-row"><span class="toc-num">03</span><span>導入</span></div>
<div class="toc-row"><span class="toc-num">04</span><span>運用</span></div>
</div>

---

<!-- _class: divider -->
<!-- _paginate: false -->

<div class="ghost-num">01</div>

## 課題

---

<!-- _class: content -->

<div class="kicker">01 · 課題</div>

## AI エージェント導入時の三つのリスク

<div class="cols cols-3">
<div>
<span class="col-num">01</span>
<h3>ローカルへの直接アクセス</h3>
<p>ファイル操作もコマンド実行も、開発者の PC 上でそのまま走る。取り消しは手作業になる。</p>
</div>
<div>
<span class="col-num">02</span>
<h3>環境差異による属人化</h3>
<p>セットアップ手順が人によって違い、「自分の環境では動く」が発生する。</p>
</div>
<div>
<span class="col-num">03</span>
<h3>認証情報の持ち出し</h3>
<p><code>.env</code> や API キーが、意図しない外部サービスへ送られうる。</p>
</div>
</div>

---

<!-- _class: content -->

<div class="kicker">01 · 課題</div>

## 解決の方針

<p class="lead">エージェントが動く場所を、開発者の PC から使い捨てのコンテナへ移す。<br>そのうえで、コンテナに三つの制約をかける。</p>

<div class="cols cols-3">
<div>
<h3>隔離</h3>
<p>作業は <code>/workspace</code> のみ。コンテナを捨てれば環境は元に戻る。</p>
</div>
<div>
<h3>出口を絞る</h3>
<p>許可した宛先以外への通信を、ネットワーク層で遮断する。</p>
</div>
<div>
<h3>事前検査</h3>
<p>エージェントが実行しようとするコマンドを、実行前に検査する。</p>
</div>
</div>

---

<!-- _class: content -->

<div class="kicker">01 · 課題</div>

## 導入前と導入後

| | 導入前 | 導入後 |
| --- | --- | --- |
| 実行場所 | 開発者の PC | <span class="em">使い捨てコンテナ</span> |
| 環境構築 | 各自が手順を追う | <span class="em">リポジトリを開くだけ</span> |
| 通信先 | 制限なし | <span class="em">許可リストの宛先のみ</span> |
| 認証情報 | ファイルとして読める | <span class="em">ツール側で読み取りを拒否</span> |
| 事故ったとき | PC の状態を戻す作業 | <span class="em">コンテナを作り直すだけ</span> |

---

<!-- _class: divider -->
<!-- _paginate: false -->

<div class="ghost-num">02</div>

## 仕組み

---

<!-- _class: content -->

<div class="kicker">02 · 仕組み</div>

## 三層の防御

<div class="layers">
<div class="layer">
<div class="layer-num">1</div>
<div>
<h3 class="layer-name">ネットワーク層</h3>
<span class="layer-file">.devcontainer/init-firewall.sh</span>
</div>
<p class="layer-desc">起動時に <code>iptables</code> + <code>ipset</code> で、許可ドメイン以外への通信を破棄する。許可対象は列挙されたドメインと、GitHub・Google の公開 IP レンジ。DNS と SSH のみ宛先を問わず通す。</p>
</div>
<div class="layer">
<div class="layer-num">2</div>
<div>
<h3 class="layer-name">シークレット層</h3>
<span class="layer-file">.claude/settings.json</span>
</div>
<p class="layer-desc"><code>Read(**/.env)</code> と <code>Read(**/*.env)</code> を拒否し、Read ツールでの読み取りを塞ぐ。</p>
</div>
<div class="layer">
<div class="layer-num">3</div>
<div>
<h3 class="layer-name">実行層</h3>
<span class="layer-file">.claude/hooks/check-bash-command.sh</span>
</div>
<p class="layer-desc"><code>printenv</code> / 単独の <code>env</code> / <code>GH_TOKEN</code> / <code>.devcontainer/.env</code> を含むコマンドを、実行される前にフックが検知して拒否する。</p>
</div>
</div>

---

<!-- _class: content -->

<div class="kicker">02 · 仕組み</div>

## 全体構成

<div class="arch">
<div>
<div class="box"><h4>VS Code</h4><p>Dev Containers 拡張</p></div>
<div class="box"><h4>ローカルリポジトリ</h4><p>bind mount で共有</p></div>
</div>
<div class="arrow">→</div>
<div class="container-box">
<p class="container-label">DEVCONTAINER（隔離環境）</p>
<div class="container-grid">
<div class="cell"><h4>Claude Code / Codex CLI</h4><p>エージェント本体</p></div>
<div class="cell"><h4>/workspace</h4><p>作業できる唯一の場所</p></div>
<div class="cell"><h4>PreToolUse フック</h4><p><code>check-bash-command.sh</code></p></div>
<div class="cell"><h4>iptables + ipset</h4><p><code>init-firewall.sh</code></p></div>
</div>
</div>
<div class="arrow">→</div>
<div>
<div class="box"><h4>許可される宛先</h4><p>列挙ドメイン ＋ GitHub・Google の IP レンジ ＋ DNS・SSH</p></div>
<div class="box box-ng"><h4>その他すべての宛先</h4><p>遮断</p></div>
</div>
</div>

<div class="vols">
<span class="vols-label">名前付き volume で永続化</span>
<div class="chips">
<span class="chip">claude-code-config</span>
<span class="chip">codex-config</span>
<span class="chip">codex-agents</span>
<span class="chip">claude-code-bashhistory</span>
</div>
</div>

---

<!-- _class: content -->

<div class="kicker">02 · 仕組み</div>

## コンテナ起動時に走る処理

<div class="steps">
<div class="step">
<div class="step-n">1</div><div class="step-file">init-git.sh</div>
<p class="step-desc">Git ユーザー設定と gh 認証</p>
</div>
<div class="step">
<div class="step-n">2</div><div class="step-file">init-playwright-cli.sh</div>
<p class="step-desc">ブラウザ操作環境（Chromium）の準備</p>
</div>
<div class="step step-hi">
<div class="step-n">3</div><div class="step-file">init-firewall.sh（sudo）</div>
<p class="step-desc">許可ドメイン以外の通信を遮断 — ブラウザ環境の準備後に張られる</p>
</div>
<div class="step">
<div class="step-n">4</div><div class="step-file">init-context7.sh</div>
<p class="step-desc">ドキュメント取得の設定</p>
</div>
<div class="step">
<div class="step-n">5</div><div class="step-file">init-statusline.sh</div>
<p class="step-desc">ステータスラインの設定</p>
</div>
</div>

<p class="note"><code>devcontainer.json</code> の <code>postStartCommand</code> がこの順で実行される。</p>

---

<!-- _class: divider -->
<!-- _paginate: false -->

<div class="ghost-num">03</div>

## 導入

---

<!-- _class: hero -->

<div class="kicker">03 · 導入</div>

<p class="hero-num">2</p>

<p class="hero-caption">前提として必要なのは Docker と VS Code の Dev Containers 拡張だけ。<br>新しいツールの学習コストは発生せず、普段どおり VS Code でリポジトリを開く。</p>

---

<!-- _class: content -->

<div class="kicker">03 · 導入</div>

## 導入手順

<div class="split-2">
<pre><span class="c"># 1. GitHub で新規リポジトリを作成しておく</span>
<span></span>
<span class="c"># 2-5. テンプレートを新規リポジトリに反映する</span>
TEMPLATE=https://github.com/Knu334-Inc/agentic-devcontainer.git
git clone --bare $TEMPLATE
cd agentic-devcontainer.git
git push --mirror &lt;新規リポジトリの URL&gt;
cd .. &amp;&amp; rm -rf agentic-devcontainer.git
<span></span>
<span class="c"># 6. 新規リポジトリをクローンする</span>
git clone &lt;新規リポジトリの URL&gt;</pre>
<ol class="numlist">
<li><b>07</b>VS Code でローカルリポジトリを開く</li>
<li><b>08</b>「コンテナーで現在のフォルダを開く」を実行する</li>
<li><b>09</b>ターミナルを開くと Claude Code が使える</li>
</ol>
</div>

---

<!-- _class: content -->

<div class="kicker">03 · 導入</div>

## 最初に設定する三箇所

<div class="cols cols-3">
<div>
<span class="col-num">01</span>
<h3><code>.devcontainer/.env</code></h3>
<p><code>.env.sample</code> をコピーして作る。Git ユーザー情報、GitHub トークン、API キーを入れる。</p>
</div>
<div>
<span class="col-num">02</span>
<h3><code>CLAUDE.md</code></h3>
<p>プロジェクト概要と作業ルールを書く。<code>AGENTS.md</code> はこのファイルへのシンボリックリンク。</p>
</div>
<div>
<span class="col-num">03</span>
<h3><code>init-firewall.sh</code></h3>
<p>通信したい宛先があれば、許可ドメインに追加する。追加は PR でレビューを通す。</p>
</div>
</div>

---

<!-- _class: content dense -->

<div class="kicker">03 · 導入</div>

## .env に設定する値

| 変数 | 内容 |
| --- | --- |
| `GIT_USER_NAME / GIT_USER_EMAIL` | コミットに使う Git ユーザー情報 |
| `GH_TOKEN` | GitHub Personal Access Token |
| `TZ` | タイムゾーン。既定は Asia/Tokyo |
| `IMAGEARCH` | Mac は arm64v8/、Windows は amd64/ |
| `CONTEXT7_API_KEY` | Context7 を使う場合に設定 |
| `ANTHROPIC_BASE_URL / _API_KEY` | 既定でプロキシ経由。直接接続する場合は上書き |

---

<!-- _class: divider -->
<!-- _paginate: false -->

<div class="ghost-num">04</div>

## 運用

---

<!-- _class: content -->

<div class="kicker">04 · 運用</div>

## 日常の使い方

<div class="cols cols-3">
<div>
<h3>Claude Code / Codex CLI</h3>
<p>どちらもターミナルからそのまま使える。認証やセッションは volume に残るため、作り直しても消えない。</p>
</div>
<div>
<h3>Context7</h3>
<p>ライブラリの最新ドキュメントを取得する。API の書き方を聞くときは常に経由させる。</p>
</div>
<div>
<h3>Playwright CLI</h3>
<p>ブラウザ操作の自動化と Web ページの動作確認に使う。Chromium は導入済み。</p>
</div>
</div>

---

<!-- _class: content -->

<div class="kicker">04 · 運用</div>

## Git 運用ルール

- 必ず `feature-<概要>` ブランチを作成し、PR を発行する
- Git / GitHub 操作は `gh` CLI を使う
- <em>`git push --force` と `git reset --hard` は禁止</em>

<p class="note">これらは <code>CLAUDE.md</code> に書かれており、エージェントもこのルールに従って動く。ルールを変えたいときは <code>CLAUDE.md</code> を直す。</p>

---

<!-- _class: content -->

<div class="kicker">04 · 運用</div>

## つまずきポイント

| 症状 | 原因 | 対処 |
| --- | --- | --- |
| <span class="em">通信がタイムアウト・接続拒否</span> | firewall が宛先を遮断している | `init-firewall.sh` にドメインを追加し、コンテナをリビルド |
| 起動に失敗する | `.devcontainer/.env` が無い | `.env.sample` をコピーして作る |
| 設定が消えたように見える | コンテナを作り直した | 設定は volume にある。削除しない限り残る |

<p class="note">許可ドメインの一覧は <code>init-firewall.sh</code> の <code>for domain in</code> 以下で確認できる。</p>

---

<!-- _class: content -->

<div class="kicker">04 · 運用</div>

## テンプレートの更新取り込み

<pre><span class="c"># 初回のみ: テンプレートをリモートに追加する</span>
TEMPLATE=https://github.com/Knu334-Inc/agentic-devcontainer.git
git remote add template $TEMPLATE
<span></span>
<span class="c"># 更新のたびに</span>
git fetch --all
git merge template/main
<span class="c"># 競合が出たら解消する</span>
git push</pre>

<p class="note"><code>init-firewall.sh</code> の許可ドメインを自分で追加していると競合しやすい。<em>両方の変更を残す</em>方向で解消する。</p>

---

<!-- _class: cover -->
<!-- _paginate: false -->

<div class="kicker">04 · 運用</div>

## 次のアクション

<ul>
<li>担当リポジトリに、このテンプレートを導入する</li>
<li><code>.devcontainer/.env</code> を作り、<code>CLAUDE.md</code> に概要を書く</li>
<li>通信が必要な宛先は、許可ドメイン追加を PR で出す</li>
</ul>

<div class="meta"><span>質問・詰まった箇所は共有してください</span></div>
