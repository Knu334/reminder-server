# Floci OAuth refresh対応の中断・再開記録

更新日: 2026-10-07。ユーザーの指示により、FW許可のための開発コンテナリビルド前に一時停止。

## リビルド後の追記

再開後の結果は[日本語の検証報告](local-e2e-floci-refresh-result.md)にまとめた。
最終Cognito/JWT回帰1,123件、公開endpointの9件、style・partition・JVM packageが成功。
レビュー指摘と互換性差分は修正・再レビュー済み。
最終配布パッチのSHA-256は`5a17cb9322339bce9c46c02833967b533c37f3c93a403cf220adc4033a79c3dd`。
Composeはカスタムbuild設定を反映済み。builderのunzip不足を修正し、ユーザーがリビルド成功を確認。
その後health HTTP200と、コンテナ版の公開endpoint9件成功を確認した。
ログはFlociコピーの`.task/blackbox-container-green.log`、検証poolの削除も成功。
OAuth refresh修正の対象検証は完了。次はアプリのissuer/JWKS接続と認証付きCRUD E2E。
全体Javaの一括実行は準備中にメモリが約10GB/12GBへ増加したため停止し、全件成功は未確認。

ユーザーからリビルド完了の連絡を受け、Maven CentralへのHTTP 200を確認して検証を再開した。
本体のバージョンを再確認したところ、公式GitHub release APIとGitタグの最新安定版は2.2.0。
2.15.0は`io.floci:testcontainers-floci`というJava Testcontainersモジュールのバージョンで、
Floci本体のDockerイメージとは別のバージョン体系である。
[公式release](https://github.com/floci-io/floci/releases/tag/2.2.0)と
[公式Testcontainers資料](https://floci.io/floci/testcontainers/)を確認した。
2.2.0を基準に保存済み候補の検証を続ける。

最初のJava実行では本体・テストのコンパイルが成功した。
24ケースは共通fixtureのCallbackURLs不足で初期化に失敗したため、機能のGREENはまだ確認していない。
ログはFlociコピーの`.task/refresh-green-attempt.log`。
完了した静的レビューは`.task/refresh-review-complete.md`に保存した。
active client secretの照合、上記fixture、refreshとpool/client削除の競合を修正対象としている。
Nodeの再現試験はread/write両scopeとID tokenの検証を追加して9件にした。
公式イメージへの9件はすべて想定した未対応箇所で失敗した（`.task/blackbox-red-nine.log`）。

以下は一時停止時の状態の記録。再開後の結果とは区別する。

## 承認された作業

Floci側のOAuth refreshとrefresh token rotationを修正し、ローカル用カスタムイメージで検証する。
本番アプリの認証要件は維持する。access/ID tokenは5分、refreshは30日、rotationの猶予は10秒。
実AWSの構築・デプロイ・実データ移行、push、PR、GitHub Actionsは行わない。
FlociへのDockerソケット共有は承認済み。開発コンテナやMiniStackには追加しない。
実際のprivateファイル・AWS credentials・reminders.jsonは読まない。合成データのみを使う。

## 保存済みの成果物

- Floci専用コピー: `/workspace/.worktrees/floci-oauth`。
- 専用ブランチ: `fix/oauth-refresh-rotation`。基準はFloci 2.2.0の`17c99047b92b5729b356f3584513cd6ed598b8a9`。
- 修正パッチ: [floci-refresh.patch](../../tools/local-e2e/floci/floci-refresh.patch)。
- 再現試験: [refresh.test.mjs](../../tools/local-e2e/floci/refresh.test.mjs)。
- ルート側のDockerビルド定義: `/workspace/.devcontainer/floci/Dockerfile`、日本語手順、ライセンス、パッチ。
- 実装担当の詳細: `/workspace/.worktrees/floci-oauth/.task/refresh-report.md`。
- レビューの保存先: `/workspace/.worktrees/floci-oauth/.task/refresh-review.md`。途中までの所見を保存済み、未完了。
- Java 25アーカイブ: `/workspace/.worktrees/floci-oauth/.task/tools/jdk25.tar.gz`。

パッチはルートのビルドcontextと実装worktreeに同じ内容を保存した。
両方のSHA-256は`5459a337125a15fde2ca7e8aaa01a66deaccc2a695158f28d4cc5e749c67f525`。
固定版の未変更コピーに`git apply --check`と実際の適用が成功し、適用後の差分形式も確認した。
適用確認用の一時worktreeは`.task/patch-check`にある。

## 現在の検証状態

Floci 2.2.0のOAuth endpointは`refresh_token` grantに未対応。
Cognito APIのrefreshはrotationによる新tokenを返さず、OAuth custom scopeも維持しない。
取得した最新mainのOAuth controllerにもrefreshの分岐はなかった。

公開PKCEログインで取得したトークンを使い、修正前のFlociへ8件の再現試験を実行した。
8件すべてが想定した未対応箇所で失敗。ログは`.task/blackbox-red.log`。
検証用poolは終了時に削除した。

修正案にはOAuthの分岐、共通refresh処理、scope・期限・系列・猶予期限の保存、
client/pool/secret/user境界の検証、rotation、失効、discoveryの更新を含む。
Java回帰テストは22メソッド・24ケース分を準備済み。
猶予期間の再延長防止、元の絶対期限、猶予0秒での並行使用、保存後の再起動、
reset・user/client/pool削除も対象にしている。

Javaテストは未実行。Maven wrapperが依存取得前に停止した。
`repo.maven.apache.org:443`への接続が拒否され、Maven 3.9.16のZIPを取得できない。
ユーザーがFW許可と、それに必要なリビルドを行う。
コンパイル、JavaのGREEN、全テスト、package、Docker build/起動はまだ成功確認していない。
コードレビューも未完了。修正案を検証済みとして扱わない。

追加したNode再現試験の構文確認とリポジトリの`npm run lint`は成功。
Floci差分の`git diff --check`も成功。
partition検査はmake未導入、直接実行はPyYAML未導入で止まったため、再開後に実施する。

## コンテナ設定の状態

ルートのComposeは公式の`floci/floci:2.2.0`のまま。
カスタムビルド定義を保存しただけで、未検証イメージへの切り替えは行っていない。
今回のFWリビルドで新しいカスタムFlociをビルドすることはない。
既存のCompose変更、ユーザーのFWスクリプト変更、本番アプリの認証設定は保持した。

## 再開手順

1. FW許可後、`repo.maven.apache.org:443`への疎通を確認する。
2. `/tmp`の検証ツールはリビルドで消える可能性がある。指定Node 24.21.0/npm 11.11.1を復元する。
   worktreeの準備・npm/npx/Pythonコマンドには既存ルールどおり
   `PATH=/tmp/aws-sdd-tools/node_modules/.bin:/tmp/aws-sdd-tools/bin:$PATH`を付ける。
3. 保存したJDKアーカイブを`/tmp/floci-build-tools`に展開する。
   SHA-256は`69df11a02cfa3ef7d7ca645e03edce6778ec090e100f6ae2b42097865730ac52`。
   展開後の`JAVA_HOME`は`/tmp/floci-build-tools/jdk-25.0.4.1+1`。
4. 中断したレビュー結果を読み、完了していなければ続行する。
   重要な指摘は実装担当に修正を依頼し、レビューを完了させる。
5. FlociコピーでJava回帰テスト、既存Cognitoテスト、全体テスト、checkstyle、partition検査を実行する。
   Maven依存cacheは`.task/m2`を使う。失敗があれば修正して再検証する。
6. JVM packageをビルドし、ローカルの`127.0.0.1:4567`で修正版を起動する。
   `FLOCI_TEST_ENDPOINT=http://127.0.0.1:4567`で8件の再現試験を実行する。
   起動した一時プロセスと検証用リソースは終了後に削除する。
7. 修正後のパッチを再生成し、ルートのcontextと実装worktreeを同期する。
   固定版への適用確認もやり直す。
8. 検証が通ってからComposeをカスタムビルドへ切り替える。
   ホストDockerのbuildとFloci再作成後、コンテナ版に対して同じ再現試験を実施する。
9. 日本語の最終報告を更新する。Cognito issuer/JWKS接続と完全な認証付きCRUD E2Eは
   別途残る課題として区別する。

FlociのClock変更は既存のMutableClockを使うテストにも影響するため、
対象テストだけでなく全体の結果を確認する必要がある。
旧形式のrefresh tokenはOAuthのscope情報を復元できないため、OAuth/rotationでは拒否する設計。
非rotationのCognito API refreshでは旧形式を維持する。詳細は実装担当の報告を参照。

## エージェントの状態

実装担当`/root/floci_refresh_implement`は候補を保存して終了。
レビュー担当`/root/floci_refresh_review`も途中までの所見を保存して終了。
現時点でCritical/Importantの確定指摘はないが、統合を承認するレビュー結果ではない。
再開後はREADMEのCompose反映前の手順と、read/write両方を含むscope維持の試験を確認する。
リビルド後はファイルを正とし、旧エージェントが使えなければ必要な担当だけ再開する。
