# Floci OAuth refresh修正の検証結果

更新日: 2026-10-07。

Floci側にOAuth refreshとrefresh token rotationの修正を実装した。
本番アプリの認証設定や要求scopeは変更していない。
実AWSの構築・デプロイ・実データ移行、push、PR、GitHub Actionsは実施していない。

## 基準バージョン

[Floci本体の公式リリース](https://github.com/floci-io/floci/releases/tag/2.2.0)は2.2.0。
固定コミットは`17c99047b92b5729b356f3584513cd6ed598b8a9`。
2.15.0はJava用の`io.floci:testcontainers-floci`モジュールで、
本体のDockerイメージとは別のバージョン体系である
（[公式Testcontainers資料](https://floci.io/floci/testcontainers/)）。
再現性のため、Dockerfileは本体のタグとコミットを照合してから修正パッチを適用する。

## 修正内容

- 既存OAuth token endpointの`refresh_token` grantに対応。
- OAuthと`GetTokensFromRefreshToken`で共通のrefresh処理を使用。
- 初回に許可されたcustom scope、subject、issuer、client、token系列、元の絶対期限を維持。
  client設定に後から追加されたscopeをrefreshで付与しない。
- access/ID token 5分、refresh 30日、rotationの猶予10秒という検証設定に対応。
  新refresh tokenを発行し、旧tokenの猶予期限をretryで延ばさない。
- rotation無効時は新refresh tokenを返さず、元のtokenを再利用できる。
- `openid`がないOAuth grantではID tokenを返さない。
- client/pool/secret/user、期限、失効を検証。secret切り替え時はどちらのactive secretも認証し、
  primary削除後も残るsecretを必須とする。
- grantを既存StorageFactoryに保存し、refreshとclient/pool削除の競合で保存レコードが復活しないよう調整。
- 旧`REFRESH_TOKEN_AUTH`のmissing parameter応答は従来の文言を維持。

## 検証

| 検査 | 結果 |
| --- | --- |
| 公式イメージへの公開PKCE/refresh再現 | 9件すべてが未対応箇所で失敗。修正前のREDを確認。 |
| Java refresh回帰 | 32件、失敗0・エラー0・skip0。secret切り替え、猶予期限、絶対期限、並行利用、保存再起動、削除競合を含む。 |
| 既存Cognito/JWT回帰 | 1,123件、失敗0・エラー0・skip0。Maven exit0 / BUILD SUCCESS。上記32件も含む。 |
| checkstyle | 違反0、BUILD SUCCESS。 |
| partition tooling / 基準検査 | 80件成功 / baseline一致、対象literal 0。 |
| JVM package | BUILD SUCCESS。 |
| 修正版JVMの公開OAuth endpoint | 9件成功、失敗・skipなし。合成データのみ使用し、終了時に検証poolを削除。 |
| 修正版Flociコンテナの公開OAuth endpoint | `http://floci:4566`で9件成功、失敗・cancel・skipなし。Node 24.21.0、exit0、約11.6秒。検証poolの削除も成功。 |
| 固定ソースへのパッチ適用 | check、実際の適用、diff形式検査が成功。 |
| アプリ側のlint / Node試験構文 | 成功。 |
| Floci全体Java | 一括実行の準備中にメモリ使用が約10GB/12GBへ増加したため停止。テスト結果を出す前の中断で、全件成功は未確認。 |
| カスタムDocker imageのbuild・起動 | unzip追加後、ユーザーがリビルド成功を確認。起動後のhealth HTTP200と、コンテナ版のOAuth9件成功をこちらで確認。 |

Node試験は公開PKCEログインからtokenを取得し、ローカルJWKSでRS256署名を検証した。
readだけのgrantとread/write両方のgrant、ID tokenのsubject/issuer/audience/5分の期限、
10秒の猶予後のreplay拒否、rotation無効、`openid`なし、別client、入力エラー、系列全体の失効を確認した。
接続先は`http://floci:4566`または`http://127.0.0.1:4567`に限定している。

初回のJava fixtureにcallback URL不足があり、補正後にテストを実行した。
静的レビューのsecret照合・削除競合も実際に失敗する回帰テストを確認してから修正した。
既存のunsupported grant試験は、今回対応したrefreshを使っていたため未知のgrantへ補正した。
これらの修正は再レビューでspec/qualityの承認を受けた。
最終のCompose・Dockerfile接続・ホスト手順・報告内容も追加レビューで承認された。

## 成果物

- [配布パッチ](../../tools/local-e2e/floci/floci-refresh.patch)
- [公開endpointの再現試験](../../tools/local-e2e/floci/refresh.test.mjs)
- ルートの`.devcontainer/floci/`: Dockerfile、日本語手順、上流ライセンス、同じ配布パッチ。
- Flociソース: `/workspace/.worktrees/floci-oauth`、ブランチ`fix/oauth-refresh-rotation`。

配布パッチのSHA-256は両保存先で
`5a17cb9322339bce9c46c02833967b533c37f3c93a403cf220adc4033a79c3dd`。
Java・package・NodeのログはFlociコピーの`.task/`に保存した。
`refresh-cognito-tests.log`、`refresh-findings-green.log`、`checkstyle-final.log`、
`partition-tests.log`、`partition-check.log`、`package.log`、`blackbox-green.log`を参照する。
コンテナ版の実行ログは`blackbox-container-green.log`。

## 残る確認

2026-10-07のホストbuildは、Maven Wrapperが`distributionSha256Sum`を使ったZIP検証を行うため
`unzip`を要求し、コンパイル開始前に停止した。builderのapt依存に`unzip`を追加した。
この原因は固定ソースの`mvnw`にある依存チェックと一致する。
その後ユーザーがリビルド成功を確認し、こちらでもhealth HTTP200と公開endpoint9件の成功を確認した。

開発コンテナにはDocker CLIとDockerソケットがないため、カスタムimageはホストでビルドして起動する。
Composeには`floci-local:2.2.0-refresh.1`と`.devcontainer/floci`のbuild設定を反映した。
現在の`devcontainer.json`は`runServices`未指定であり、Dev ContainersのリビルドはFlociも含めてbuildする。
リビルドで進める場合、project名の手動指定と事前の`build floci`は不要。
Dev Containersリビルドと、Flociだけを手動で置き換える場合の手順は
ルートの`.devcontainer/floci/README.md`を参照。
Flociへの承認済みソケット共有は維持する。開発コンテナとMiniStackには追加しない。
起動後に同じNode 9件を`http://floci:4566`へ実行し、コンテナ版も成功した。
FlociのOAuth refresh修正とコンテナでの対象検証は完了。

全体Javaの診断コマンドは`./mvnw -B -Dmaven.repo.local=.task/m2
-Dsurefire.skipAfterFailureCount=1 -Dsurefire.runOrder=alphabetical test`。
最初のfailureで停止する設定だが、Quarkusの全test profileの準備がテスト実行より先に走った。
実行時のメモリ使用は約10.4GB、空きは約0.8GBで、JVM heapは約5.6GB/6GBだった。
開発環境の安定性を保つため親Mavenを停止し、残るJavaプロセスがないことを確認した（exit143）。
ログは`.task/full-suite-diagnostic.log`と`.task/full-suite-memory.log`。
上流CIは`.github/ci/partition.sh`で4shardに分けて実行しており、全体確認はこの分割と
Dockerを実行できる環境での検証が残る。

この検証で本番AWS互換性や全サービスの互換性を保証するものではない。
保存バックエンドの既存仕様に従うため、graceful restartの成功はクラッシュ時の原子的なrotationを意味しない。
期限切れgrantは次のtoken処理で清掃するため、アクセスがない間は保存レコードが残る。
旧形式のrefresh tokenはscopeの履歴を持たないためOAuth/rotationでは拒否し、
非rotationのCognito API refreshのみ互換動作を維持する。

Cognito issuer/JWKSをアプリへ接続する構成と、完全な認証付きCRUD E2Eは引き続き別の確認事項。
