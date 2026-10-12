# 正式E2E ローカル実行手順

パッチ済みFloci上で、本番の3 Terraform rootと現行ZIPを構築し、実PKCEログインから認証済みAPI、DynamoDB、S3、CloudWatch Logsまでを照合するローカル試験の手順である。実AWS、GHA、本番Cognito、本番データには触れない。
設計は[設計](../superpowers/specs/2026-10-08-reminder-server-formal-e2e-design.md)、要件ごとの対応は[対応表](formal-e2e-coverage.md)、実施結果は[結果](formal-e2e-results.md)、できなかったことは[限界](formal-e2e-limitations.md)に分けて書く。
ここに書いた値は、2026-10-12の `npm test` の実測（未commitの変更を含まない作業ツリー、HEAD 6daf48bでの run `e2e-da96a6b1-9b45-4a5c-beba-12ce628eabbc`、refresh.7）と、offline試験に基づく。

## 前提

- Node 24.21.0、npm 11.11.1、Python 3.13.16、Terraform 1.16.5、AWS provider 6.67.0。npm、Python、Terraform、provider pluginは、リポジトリ直下の `.superpowers/tools/aws-sdd` に置く。子processのPATHは、この場所の `node_modules/.bin` と `bin` をリポジトリ直下から組み立てる。`scripts/e2e/preflight.ts` がNodeとnpmとPythonとTerraformの版、`package.json` の固定版と `node_modules` の一致、`floci` のDNSが単一のprivate IPv4であること、health の版を確認する。一つでも違えば試験前に終了する（exit 2）。
- Floci imageは `floci-local:2.2.0-refresh.7-native`（healthの版は `2.2.0-local-refresh.7-native`）。preflightはこの版でないと試験前に終了する。host側のbuildと再作成は、ホストの `.devcontainer/floci/README.md` に従う。この手順では `.devcontainer` を編集しない。
- Flociのパッチ（refresh.2〜7）は、SourceAccountの保持、ListVersionsByFunctionの順序、CloudWatch alarmのpercentile項目、HTTP APIのCORSとraw path、host経由のraw path、`%25` の再encodeである。Java回帰試験はTemurin JDK 25と `./mvnw` で実行し、refresh.7では対象11クラスが300/300合格した。上流のDocker依存の試験は動かせず、全件実行はしていない。詳細は[限界](formal-e2e-limitations.md)にある。
- 依存の準備は `npm ci`。ZIPはE2E自身が現行の `npm run build` / `npm run package` から作り直す。古いZIPや固定hashは使わない。
- 本番のprivate入力、`.env`、Terraform state、認証情報は読まない。必要な値は全て合成値である。

## 実行の入口

| 目的 | コマンド | 要する時間 |
| --- | --- | --- |
| 全体（E、L、Iのすべて。offlineの試験の後にFlociの全suiteを実行する） | `npm test` | Flociが必要。約14〜16分（実測869〜974秒。後述の枠に記す）。Flociが無いとpreflightで終了する（exit 2） |
| Flociを使わないoffline試験（runtime、operations、delivery、結合、`test:e2e:harness`） | `npm run test:offline` | 数十秒〜1分。Flociは不要 |
| offlineの結合試験（layer I、E2E harness、本書の対応表照合）だけ | `npm run test:integration:e2e` | 約5秒 |
| Flociの全suite（E、L、I。Floci必須group全て、TF caseを含む） | `npm run test:e2e:floci` | 約12〜15分（refresh.7までの実測751〜833秒。layer Iの実行時間は含まない） |
| Terraform構築だけの診断 | `npm run test:e2e:terraform` | 構築は約2分（実測128秒） |
| 一つのsuiteだけ | `npx tsx scripts/e2e/run.ts --layer floci --suite api` | suiteによる |
| 一つのcaseだけ | `npx tsx scripts/e2e/run.ts --layer floci --case API-09/id-percent` | 構築と回収を含む。layer IのcaseだけをFlociなしで選んだ場合は、構築も回収も行わない（下記） |

実測前の見積りは22〜65分だった。期限は実行75分と回収15分で、全suiteの実測はその約6分の1である。
suite名は `harness`、`terraform`、`fixture`、`auth`、`api`、`storage`、`images`、`cleanup`、`operations`、`logging`、`scheduler` で、この順に逐次実行する。一部だけを選んだ実行は `partial: true` になり、成功しても全体の完了とは扱わない。
`npm run test:e2e:terraform` はTF-01/applyだけを実行する構築の診断で、全suite成功後に同じ構築を再実行する目的では使わない。

## layer Iの判定（2026-10-12のユーザー判断）

layer Iの24件は、同じrunの中で、`offlineEvidence`（`tests/e2e/floci/support/cases.ts`）に書いた試験fileを子processの `node --test` で実行し、その実際の結果から判定する。Flociの設定gateやsmokeの結果には依存しない。ただし、全体または混在の選択では、runの最初のpreflight（Flociのhealthなど）が失敗するとI caseも実行されず、not-run（preflight-failed）で終了コードは2になる。

- 各caseに対応づけた試験名ごとに、同名、または語の区切りで続く名前の試験（`STORE-06/…-i:` のような接頭辞の書き方を含む）が一つ以上実行され、対応するすべての試験が合格したときだけpassになる。
- 対応する試験が実行されなければfail（`offline-test-missing`）。対応する試験が失敗、skip、todo、cancelledならfail（`offline-test-failed`）。
- 子processが試験の失敗以外の理由で異常終了、timeout、中断、または報告を読めなかった場合は、そのfileに対応するcaseがすべてfail（`offline-run-failed`）になる。ここには、試験が合格した後のprocess終了（`process.exit`）や、試験の終了後に起きた未捕捉の例外も含まれる（子processにはfileの絶対pathを渡し、fileそのものの失敗を示す報告を検出する）。対応づけた試験名が一つも無いcaseと、試験名の一覧が空のcaseは、passにならずfail（`offline-test-missing`）になる。
- caseごとの各assertionの状態は、そのcaseに対応づけた全試験名の判定（全て合格か）から導いた同じ状態である。assertionごとに別々に測ったものではない。試験名ごとの件数は保存しない（evidenceの固定項目を弱めないため）。per-I-caseの合格は、対応づけた試験の集まりが全て合格したことを意味する。
- 報告は子processの標準出力をメモリ上で読むだけで、生の出力、ログ、環境は保存も表示もしない。evidenceには固定語彙の結果だけが残る。
- runの取消または予算切れで始められなかった場合は、not-run（budget-exhausted、phaseはoffline）であり、passにはならない。caseの所要時間（durationMs）は、対応づけた各fileの実行時間の合計である。同じfileを共有するcaseは、同じfileの時間をそれぞれ数える。
- layer Iだけを選んだ実行（`--case` または `--suite`）は、Floci、Terraform、fixtureに触れず、構築も回収も行わない。

実測値（2026-10-12、HEAD 6daf48b。未commitの変更を含まない）:

- `npm test` 全体: exit 0、869秒（約14.5分）。offline部分はruntime 188、operations 74、delivery 97、integration 182、harness 107がすべて合格（skip 0）。
- Flociの全suite: run `e2e-da96a6b1-9b45-4a5c-beba-12ce628eabbc`、268件を選び、265件が合格、失敗0、未実行0、未対応3（OBS-04、AUTH-11のhosted revoke、IMG-09の互換性調査）。`partial` は偽、`complete` は真、終了コード0。回収は18件を試行して18件成功、errors 0、leaks 0。ZIPの `dirtyPaths` は空。layer別はE 228 pass、L 13 pass と 3 unsupported、I 24 pass（phase offline）。
- 以前のrun: e2e-d5c47097（HEAD 07744fc、974秒）とe2e-ba02c537（HEAD bfe7294、939秒）も同じ件数で、当時は未commitの `src/api/event.ts` を含んでいた。`npm test` 全体の所要時間は、869〜974秒（約14.5〜16分）である。
- layer Iの24件は、別の監査で全件が有効（VALID）と判定された。この完了は、Floci上のE・Lの実測と、同じrunのoffline試験の実測（layer I）を合わせた、2026-10-12のユーザー判断の基準による。実AWSなどの限界は[限界](formal-e2e-limitations.md)に、判断の経緯は[判断の記録](formal-e2e-decisions.md)にある。

## 実行の流れ

1. preflightの後、offlineの試験でlayer Iを判定する。続いて、本番3 rootの公開sourceを一時copyに置き、source digestを記録する。
2. 変換は、2つのvariable validation（owned issuerとauth base URL）と、platformの2つのoutput.value、接続・隔離の生成設定だけである。それ以外の変更は拒否する。変換後digestと差分の区分を記録する。
3. 現行buildからZIPを作り、digestを固定してS3へ登録する。ZIPの内容は、実行時点のworking treeである。
4. 一組の基盤を構築し、設定を読み戻す（TF-03）。ここで一つでも不一致なら、以降のE/Lは全てnot-run（prerequisite-failed）になる。
5. fixtureのsmoke（gate、health、認証拒否、清掃ログ）を行う。
6. suiteを順に実行する。各caseは、HTTP応答、DynamoDB、S3、ログの4種類の期待を持つ。ログは各caseが期待を登録し、suite末尾でまとめて照合する。
7. 結果を確定した後で、保護を解除して回収する。回収後に再試験はしない。

認証期限のcase（AUTH-06）は、実トークンの300秒を待つため、authの最後に置く。

## 結果の読み方

出力の最後のJSONに `selected`、`passed`、`failed`、`notRun`、`unsupported`、`cleanup`、`exitCode`、`complete` が出る。

- `complete` が真になるのは、registry全件を選び、failとnot-runが0で、回収に失敗も漏れも無いときだけである。部分選択は偽になる。測定済みの互換性調査のunsupportedは、`complete` を妨げない。layer Iの24件は、offlineの実測で合格すれば他のcaseと同じに数える（2026-10-12のユーザー判断）。
- layer Iのcaseは、`npm test` または `npm run test:e2e:floci` の中で、offlineの試験の実測から判定する（上の節）。各Iのcaseと試験fileの対応は[結果](formal-e2e-results.md)にあり、`tests/integration/formal-e2e/coverage.test.ts` が、試験名の一致まで確認する。
- `unsupported` は、互換性調査の項目で、測定した結果として未対応と判明した場合に付く。この場合は終了コードに影響しない。behaviorのcaseは、TF-01/applyで必須APIの未対応を測定した場合（required-api-unsupported）だけがunsupportedになり、終了コードは1になる。それ以外のbehaviorのcaseは、failとして数える。
- `fail` は、入力を送った後の不一致である。not-runへ戻さない。
- 結果は `artifacts/formal-e2e/<run ID>/` の `results.json`（case別）、`inventory.json`、`manifest.json`（所有リソースとprocess）、`independent-absence.json` に保存する。token、code、URL、本文、生ログは保存しない。このdirectoryはgit管理外である。

## 失敗の診断

1. `fixture-settings.json` の `failedCheck` で、設定の読み戻しのどこが違うかを見る。
2. `results.json` で、failしたcaseの `phase` と `reason` を見る。`logs` 段階の `logs-missing` はログ配信の欠落、`observer-failed` は観測の失敗である。`observer-failure.json` に、固定語彙のservice・原因・errorNameだけが残る。
3. 失敗がFloci側かproduct側かは、ソースと独立した読み取りで切り分ける。製品の修正を求める前に、独立した失敗の証拠を示す。
4. 同じ入力の再実行は、診断目的の1回だけにする。結果の差し替えには使わない。

## 回収と手動の再開

通常は実行の最後に、`manifest.json` に記録した所有リソースだけを回収し、独立した読み取りで不在を確認する（最新のrunでは83件が不在、leak 0）。
processが強制終了（SIGKILL）された場合は、finallyが走らない。SIGINTとSIGTERMのhandlerは最初の1回だけ有効なので、2回目のSIGINTも、SIGKILLと同じく回収を飛ばす。次の順で手動回収する。

1. 他にE2Eのprocessが動いていないことを確認し、`.superpowers/locks/` と `artifacts/.formal-e2e-build.lock` に残ったlockを確認する。後者はZIPの作成中に強制終了されると残り、次のrunが開始時に失敗する。動作中のrunがあるときはlockを消さない。
2. 該当runの `manifest.json` と `cleanup-identities.json` で、所有リソースの名前とIDを確認する。名前の先頭は `e2e-<8桁hex>-` である。
3. その一覧にあるリソースだけを、Floci（`http://floci:4566`）上で削除する。同じ名前でも、一覧に無いものには触れない。
4. 削除後に不在を読み戻し、残ったlockを消す。

## CI runnerの準備

GHAのworkflowは変更していない。CIで走らせる場合も、同じ固定版のツール、固定版のパッチ済みFloci、`floci` という名前で解決できるprivate IPv4が必要である。これらを満たすrunnerの用意と、workflowの追加は、別途の承認を必要とする。

## 今回この手順で実施していないこと

実AWS、IAMの強制、TLSの強制、PITR、Chromeの実利用は実施していない。詳細は[限界](formal-e2e-limitations.md)にある。
