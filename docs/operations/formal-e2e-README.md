# 正式E2E ローカル実行手順

パッチ済みFloci上で、本番の3 Terraform rootと現行ZIPを構築し、実PKCEログインから認証済みAPI、DynamoDB、S3、CloudWatch Logsまでを照合するローカル試験の手順である。実AWS、GHA、本番Cognito、本番データには触れない。
設計は[設計](../superpowers/specs/2026-10-08-reminder-server-formal-e2e-design.md)、要件ごとの対応は[対応表](formal-e2e-coverage.md)、実施結果は[結果](formal-e2e-results.md)、できなかったことは[限界](formal-e2e-limitations.md)に分けて書く。
ここに書いた値は、2026-10-10のrefresh.6による実測と、同日のoffline試験に基づく。

## 前提

- Node 24.21.0、npm 11.11.1、Python 3.13.16、Terraform 1.16.5、AWS provider 6.67.0。`scripts/e2e/preflight.ts` がNodeとnpmとPythonの版、`package.json` の固定版と `node_modules` の一致、`floci` のDNSが単一のprivate IPv4であること、health の版を確認する。一つでも違えば試験前に終了する（exit 2）。
- Floci imageは `floci-local:2.2.0-refresh.6-native`（healthの版は `2.2.0-local-refresh.6-native`）。host側のbuildと再作成はホストの `.devcontainer/floci/README.md`に従う。この手順では `.devcontainer` を編集しない。
- Flociのパッチ（refresh.2〜6）は、SourceAccountの保持、ListVersionsByFunctionの順序、CloudWatch alarmのpercentile項目、HTTP APIのCORSとraw path、host経由のraw pathである。これらのJava回帰試験は、JDKが無くDockerfileが `-DskipTests` のため一度も実行していない。実際のimageでの動作はlive試験で確認したが、Java試験の合格は確認していない。
- 依存の準備は `npm ci`。ZIPはE2E自身が現行の `npm run build` / `npm run package` から作り直す。古いZIPや固定hashは使わない。
- 本番のprivate入力、`.env`、Terraform state、認証情報は読まない。必要な値は全て合成値である。

## 実行の入口

| 目的 | コマンド | 要する時間 |
| --- | --- | --- |
| offlineの結合試験（layer I、E2E harness、本書の対応表照合） | `npm run test:integration:e2e` | 約5秒（161件） |
| 全suite（Floci必須group全て、TF caseを含む） | `npm run test:e2e:floci` | 約12〜14分（実測751〜833秒） |
| Terraform構築だけの診断 | `npm run test:e2e:terraform` | 構築は約2分（実測128秒） |
| 一つのsuiteだけ | `npx tsx scripts/e2e/run.ts --layer floci --suite api` | suiteによる |
| 一つのcaseだけ | `npx tsx scripts/e2e/run.ts --layer floci --case API-09/id-percent` | 構築と回収を含む |

実測前の見積りは22〜65分だった。期限は実行75分と回収15分で、全suiteの実測はその約6分の1である。
suite名は `harness`、`terraform`、`fixture`、`auth`、`api`、`storage`、`images`、`cleanup`、`operations`、`logging`、`scheduler` で、この順に逐次実行する。一部だけを選んだ実行は `partial: true` になり、成功しても全体の完了とは扱わない。
`npm run test:e2e:terraform` は構築とTF-01/03の診断だけで、全suite成功後に同じ構築を再実行する目的では使わない。

## 実行の流れ

1. preflightの後、本番3 rootの公開sourceを一時copyに置き、source digestを記録する。
2. 変換は、2つのvariable validation（owned issuerとauth base URL）と、platformの2つのoutput.value、接続・隔離の生成設定だけである。それ以外の変更は拒否する。変換後digestと差分の区分を記録する。
3. 現行buildからZIPを作り、digestを固定してS3へ登録する。ZIPの内容は、実行時点のworking treeである。
4. 一組の基盤を構築し、設定を読み戻す（TF-03）。ここで一つでも不一致なら、以降のE/Lは全てnot-run（prerequisite-failed）になる。
5. fixtureのsmoke（gate、health、認証拒否、清掃ログ）を行う。
6. suiteを順に実行する。各caseは、HTTP応答、DynamoDB、S3、ログの4種類の期待を持つ。ログは各caseが期待を登録し、suite末尾でまとめて照合する。
7. 結果を確定した後で、保護を解除して回収する。回収後に再試験はしない。

認証期限のcase（AUTH-06）は、実トークンの300秒を待つため、authの最後に置く。

## 結果の読み方

出力の最後のJSONに `selected`、`passed`、`failed`、`notRun`、`unsupported`、`cleanup`、`exitCode`、`complete` が出る。

- `complete` が真になるのは、registry全件を選び、failとnot-runが0で、回収に失敗も漏れも無いときだけである。部分選択やlayer Iのnot-runが残る場合は偽になる。
- layer Iのcaseはliveでは実行されず、not-run（implementation-pending）として残る。offlineの試験は `npm run test:integration:e2e` が行う。各Iのcaseと試験fileの対応は[結果](formal-e2e-results.md)にあり、`tests/integration/formal-e2e/coverage.test.ts` が存在を確認する。
- `unsupported` は、互換性調査の項目で、測定した結果として未対応と判明した場合だけである。behaviorのcaseがunsupportedになることはなく、failとして数える。
- `fail` は、入力を送った後の不一致である。not-runへ戻さない。
- 結果は `artifacts/formal-e2e/<run ID>/` の `results.json`（case別）、`inventory.json`、`manifest.json`（所有リソースとprocess）、`independent-absence.json` に保存する。token、code、URL、本文、生ログは保存しない。このdirectoryはgit管理外である。

## 失敗の診断

1. `fixture-settings.json` の `failedCheck` で、設定の読み戻しのどこが違うかを見る。
2. `results.json` で、failしたcaseの `phase` と `reason` を見る。`logs` 段階の `logs-missing` はログ配信の欠落、`observer-failed` は観測の失敗である。`observer-failure.json` に、固定語彙のservice・原因・errorNameだけが残る。
3. 失敗がFloci側かproduct側かは、ソースと独立した読み取りで切り分ける。製品の修正を求める前に、独立した失敗の証拠を示す。
4. 同じ入力の再実行は、診断目的の1回だけにする。結果の差し替えには使わない。

## 回収と手動の再開

通常は実行の最後に、`manifest.json` に記録した所有リソースだけを回収し、独立した読み取りで不在を確認する（最新のrunでは83件が不在、leak 0）。
processが強制終了（SIGKILL）された場合は、finallyが走らない。次の順で手動回収する。

1. 他にE2Eのprocessが動いていないことを確認し、`.superpowers/locks/` に残ったlockを確認する。動作中のrunがあるときはlockを消さない。
2. 該当runの `manifest.json` と `cleanup-identities.json` で、所有リソースの名前とIDを確認する。名前の先頭は `e2e-<8桁hex>-` である。
3. その一覧にあるリソースだけを、Floci（`http://floci:4566`）上で削除する。同じ名前でも、一覧に無いものには触れない。
4. 削除後に不在を読み戻し、lockを消す。

## CI runnerの準備

GHAのworkflowは変更していない。CIで走らせる場合も、同じ固定版のツール、固定版のパッチ済みFloci、`floci` という名前で解決できるprivate IPv4が必要である。これらを満たすrunnerの用意と、workflowの追加は、別途の承認を必要とする。

## 今回この手順で実施していないこと

実AWS、IAMの強制、TLSの強制、PITR、Chromeの実利用は実施していない。詳細は[限界](formal-e2e-limitations.md)にある。
