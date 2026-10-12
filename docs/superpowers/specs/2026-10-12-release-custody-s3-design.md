# release custody の S3 移行 設計

## 目的

`deploy.yml` が GitHub の artifact に置いている、plan、入力、証拠、結果、診断を、bootstrap が作る private な S3 bucket に移す。リポジトリの公開設定（public・private）に関係なく、同じ安全性で deploy できるようにする。

Terraform の plan と state は、秘密の情報を含みうるものとして扱う。`sensitive` を指定した値も、plan と state には平文で入る。public のリポジトリでは、GitHub の artifact とログを誰でも取得できるため、plan などを artifact やログに出せない。

## 前提と決定事項

- public・private のどちらのリポジトリでも動く。リポジトリの公開設定には頼らず、秘密の情報は常に S3 に置く。
- bootstrap は operator が手動で実行する。GitHub Actions から bootstrap を実行しない。
- 今の安全確認はすべて残す。レビューした saved plan をそのまま apply すること、`verifySavedPlan`、レビューの digest の照合、custody の hash の照合、`reviewed_run` の来歴の確認である。
- GitHub の plan に依存する機能（environment の secret、deployment branch の制限、required reviewers）は、使える場合に使う。使えない場合の扱いは今の文書のとおりとする。
- 長期間有効な AWS のアクセスキーは使わない。GitHub の job は OIDC で role を assume する。

## 保存先

### bucket

bootstrap に bucket を1つ追加する。

- 名前: `<name_prefix>-<account_id>-<region>-custody`
  - 接尾辞 `-custody`（8文字）は、既存の `-artifacts`（10文字）より短い。既存の bucket 名が63文字以内に収まる入力なら、新しい bucket 名も必ず収まる。`name_prefix` の検証（artifacts bucket が63文字以内）は変えない。
- versioning、SSE-S3 の暗号化、公開アクセスのブロックを有効にする。
- bucket policy:
  - HTTPS 以外の通信を拒否する。
  - `If-None-Match: *` の無い `PutObject` を拒否する。既存の object の上書きをさせない。
  - `DeleteObject` と `DeleteObjectVersion` を拒否する。object を消すのは lifecycle だけとする（lifecycle による削除は bucket policy の拒否を受けない）。

### lifecycle

versioning を有効にした bucket では、現行の version の失効は delete marker を置くだけで、bytes は古い version として残る。そのため、次の2つを分けて設定する。

| 対象の prefix | 現行の version の失効（`Expiration`） | 古い version の完全な削除（`NoncurrentVersionExpiration`） |
| --- | --- | --- |
| `registered-release/`、`release-review/`、`failure-diagnostics/` | 作成から1日 | 古い version になってから1日 |
| `release-result/` | 作成から30日 | 古い version になってから1日 |

- 保持期間の違う失効の規則（上の表の2行）は、prefix で分けて対象が重ならないようにする。
- 失効した後に残る delete marker は、別の規則で削除する（`ExpiredObjectDeleteMarker`）。`ExpiredObjectDeleteMarker` は `Expiration.Days` と同じ規則には書けないため、delete marker 用の規則は失効の規則とは別に置き、対象の prefix が重なってよい。
- lifecycle の日数は、object の作成時刻から数えた日数を UTC の翌0時に切り上げて評価される。そのうえ処理の遅れもあるため、bytes が実際に消えるのは上の期間より遅くなりうる。利用の期限は、lifecycle ではなく、下の「利用期限」で守る。

### object の置き方

prefix は `<種類>/<run_id>/<run_attempt>/` とする。`run_attempt` は、その object を**書いた job** の `github.run_attempt` である。GitHub では、一部の job だけを再実行でき、そのとき run ID は変わらず `run_attempt` だけが増える。

| prefix | 中身 | 書く role | 読む role |
| --- | --- | --- | --- |
| `registered-release/<run_id>/<run_attempt>/` | 登録した ZIP の manifest（RegisteredArtifact）と証拠 | artifact | plan |
| `release-review/<run_id>/<run_attempt>/` | custody のファイル一式（下記）と `plan.txt` | plan | plan（別の run から）、apply |
| `release-result/<run_id>/<run_attempt>/` | `ledger.json`、`post-baseline.json`（初回の platform の構築のときだけ） | apply | なし（人が読む） |
| `failure-diagnostics/<run_id>/<run_attempt>/<job>/` | 失敗時の診断 | 失敗した job の role | なし（人が読む） |

`plan.txt` は、saved plan から `terraform show -no-color` で作る、人が読める形の plan である。

### 種類ごとのファイルの集合

各 prefix に置くファイルは、次のとおりに固定する。読む側は、manifest のエントリが下の集合と完全に一致しなければ止まる（必須のファイルの欠落も、余分なエントリも拒否する）。取り出し先のディレクトリに余分なファイルがあっても止まる。読む側は一覧の権限を持たないので、manifest に載っていない S3 の object は、取得も使用もしない。

| 種類 | 必須のファイル |
| --- | --- |
| `registered-release` | `registered.json`、`audit-runtime.json`、`audit.json`、`sbom.json`、`tests.txt`（今の `registered-release` の artifact と同じ） |
| `release-review`（platform） | 今の `custodyNames`（`inputs.json`、`baseline.json`、`artifact.json`、`request.json`、`backend.hcl`、`review.json`、`saved.tfplan`、`preview.json`）、`custody.json`、`plan.txt` |
| `release-review`（application） | platform の集合に加え、`registered.json`、`audit.json`、`sbom.json`、`tests.txt`、`platform-outputs.json` |
| `release-result` | `ledger.json`。初回の platform の構築のときは `post-baseline.json` も必須 |
| `failure-diagnostics` | 今の診断の JSON ファイル（上限付き。最大8個） |

すべての種類で、最後に `manifest.json` を書く。

### manifest

`manifest.json` には次を入れる。

- 種類、root、run ID、`run_attempt`
- 作成時刻（`createdAt`）と利用期限（`expiresAt`）
- ファイル名と SHA-256 の一覧
- `release-review` では、plan の digest（`plan-guard` の `reviewSha256`）と、`custody.json` の SHA-256。ZIP を再利用した preview では、元の preview の manifest の SHA-256 も入れる

今の `custody.json`（root ごとの必須のファイルの集合と hash）は、そのまま残す。manifest は S3 での受け渡しの完全性を、`custody.json` は今と同じ custody の照合を受け持つ。

### レビューの digest

人がレビューして apply の run に入力する digest は、**`release-review` の `manifest.json` の SHA-256** とする。manifest には plan の digest（今の `plan-guard` が計算する `reviewSha256`）、`custody.json` の hash、`createdAt`、`expiresAt`、`run_attempt` が入っているので、この1つの値でレビューした内容と期限をまとめて固定できる。

- workflow の入力の名前は `expected_review_sha256` のままとし、意味を「レビューした `release-review` の manifest の SHA-256」に変える。job summary にもこの値を `review_sha256` として出す。
- plan の digest は manifest の中に残し、今の `verifySavedPlan` と plan の照合に使う。
- S3 の `If-None-Match` は現行の version だけを検査するので、lifecycle で失効した後なら、同じ key に object を作り直せる。作り直した manifest の中身や時刻が違えば SHA-256 が変わって止まり、同じ内容で作り直しても `expiresAt` を過ぎているので止まる。

### GitHub の側

- `registered-release`、`release-review`、`release-result`、`failure-diagnostics-*` の GitHub の artifact は、すべて廃止する。
- GitHub に出すのは、job summary の要約だけとする（root、commit、action の件数、`review_sha256`（manifest の SHA-256）、custody の置き場所の run ID と `run_attempt`）。
- `scripts/release/workflow.ts` は、apply の結果の ledger を標準出力に出さない。ledger は S3 に置き、標準出力と job summary には上の要約だけを出す。
- authorize job の「private のリポジトリだけ」という検査を外す。`main` だけ、手動の dispatch だけ、`main` から到達できる commit だけ、という検査は残す。
- `ci.yml` の失敗時の診断は、今のまま private のリポジトリのときだけ artifact にする。PR の CI は AWS の認証を持たないため、S3 には置けない。

## 権限

3つの GitHub 用 role に、新しい bucket への権限だけを追加する。

| role | 読める（`GetObject`） | 書ける（`PutObject`、新規作成だけ） |
| --- | --- | --- |
| artifact（ZIP の登録用） | なし | `registered-release/*`、`failure-diagnostics/*` |
| plan | `registered-release/*`、`release-review/*` | `release-review/*`、`failure-diagnostics/*` |
| apply | `release-review/*` | `release-result/*`、`failure-diagnostics/*` |

- 削除と一覧（`ListBucket`）の権限は、どの role にも与えない。読む側は manifest からファイル名を知る。
- `release-result/` を読める role は無い。人（operator）が自分の AWS の権限で読む。
- artifact という名前は、build の成果物（リリースする ZIP）の意味である。GitHub の artifact とは別のものである。

## job の順序

AWS を使う各 job は、次の順に進む。S3 への読み書きは、role を assume した後でしか行えない。

1. authorize job が成功していること（`needs`）
2. 依存関係の install など、AWS を使わない準備
3. OIDC で role を assume する
4. S3 から必要なものを取り出して照合する（plan の job と apply の job）
5. 本来の処理（登録、plan、apply）
6. S3 に結果を書く
7. 失敗した場合は、role を assume できていれば `failure-diagnostics/` に診断を書く

今の `deploy.yml` では、artifact の download が role の assume より前にある。これを、assume の後に移す。

## 受け渡しと照合

### 書き込み

1. job は、種類ごとの集合のファイルを1つずつ書く。各書き込みに `If-None-Match: *` と SHA-256 の checksum を付ける。
2. 最後に `manifest.json` を書く。
3. job の output で、置き場所の run ID と `run_attempt`、`manifest.json` の SHA-256 を渡す。

### 読み取り

1. 読む場所（run ID と `run_attempt`）と、期待する `manifest.json` の SHA-256 を決める（下の「読む場所の決め方」）。
2. `manifest.json` を読み、SHA-256 を照合する。無ければ止まる。
3. manifest の種類、root、run ID、`run_attempt` が、読もうとした場所と一致することを確かめる。
4. 利用期限を確かめる（下の「利用期限」）。
5. manifest のファイルの集合が、種類ごとの集合と完全に一致することを確かめる。
6. 各ファイルを読み、SHA-256 を照合する。1つでも合わなければ止まる。
7. 取り出したファイルを、ディレクトリ 0700、ファイル 0600 で書く。ファイル名にパスの区切りや `..` を含むもの、symlink は拒否する。
8. `release-review` では、続けて今の custody の照合（`custody.json` と必須のファイルの集合）と、`verifySavedPlan` を独立して行う。

### 読む場所の決め方

- **同じ run の中**: 読む job は、書いた job の output（`needs.<job>.outputs`）の run ID、`run_attempt`、`manifest.json` の SHA-256 を使う。一部の job だけを再実行した場合も、再実行していない job の output は引き継がれる前提とする。output が欠けている、または形式が不正な場合は止まる。読む job 自身の `run_attempt` で推測して読みに行くことはしない。
- **別の run から**（`reviewed_run` を指定した run）:
  1. GitHub の API で、`reviewed_run` が「この repository の `main` で `deploy.yml` を手動で実行し、成功した preview」であることを確かめる（今の `verifyReviewedRunMetadata`）。リポジトリが private であることは条件にしない。
  2. その run の plan の job の、最後の成功した試行の `run_attempt` を、GitHub の API で取得する。
  3. `release-review/<reviewed_run>/<run_attempt>/manifest.json` を読み、その SHA-256 が入力の `expected_review_sha256` と一致することを確かめる。一致しなければ止まる。以後の照合は、この manifest を起点にする。

### reviewed_run を使う2つの経路

`reviewed_run` を指定する run は、次の2つである。どちらも `expected_review_sha256`（元の preview の manifest の SHA-256）を必須とし、元の `release-review` が利用期限内であることを確かめる。

| 経路 | 入力 | 動作 | 作る `release-review` の期限 |
| --- | --- | --- | --- |
| レビュー済みの変更の apply | `apply=true`、`reviewed_run`、`expected_review_sha256` | 元の入力の bytes と baseline で saved plan を作り直し、plan の digest が元と一致することを確かめてから apply する | 元の `expiresAt` を引き継ぐ |
| ZIP を再利用した新しい preview（application だけ） | `apply=false`、`reviewed_run`、`expected_review_sha256`、変更した設定（`scheduler_enabled` など） | 元の bundle から登録済みの ZIP と証拠を再利用し、build と登録をせずに新しい plan を作る | 新しいレビューなので、新しい作成時刻から24時間 |

- ZIP を再利用した新しい preview の manifest には、元の preview の manifest の SHA-256 を入れる。apply の run は、その新しい preview の manifest の SHA-256 を `expected_review_sha256` として受け取る。
- 今の `deploy.yml` では、ZIP を再利用する preview に digest は不要である。この経路でも digest を必須にするため、`deploy.yml` の入力の説明、authorize の検査、運用の手順、既存の再利用の試験を変更する。

### 利用期限

- 期限の起点は、**元のレビュー（preview の run の `release-review`）の作成時刻**とし、期限はその24時間後とする。
- apply の run が作る `release-review` の manifest には、元のレビューの `expiresAt` を引き継ぐ。新しい作成時刻で期限を延ばさない。ZIP を再利用した新しい preview は新しいレビューなので、新しい作成時刻から24時間とする（上の「reviewed_run を使う2つの経路」）。
- 期限は、次の時点で確かめる。
  - 別の run の `release-review` を読むとき
  - 同じ run の apply の job が `release-review` を読むとき
  - apply を実行する直前
- 現在時刻が `expiresAt` 以上なら止まる（ちょうど24時間で失効）。`createdAt` が現在時刻より5分以上未来のもの、日時の形式が不正なもの、`expiresAt` が `createdAt` の24時間後でないもの（引き継いだ場合は元の値と一致しないもの）は止まる。
- `registered-release` は同じ run の中だけで読むので、同じ規則で24時間とする。
- `production` の承認を待つ間に期限を過ぎた場合は、新しい preview が必要になる。

### レビューの手順

人は、AWS コンソールの S3 画面で、job summary に出た `release-review/<run_id>/<run_attempt>/` を開き、今の手順と同じ対象をレビューする。すべてのファイルを、同じ run ID と `run_attempt` の場所から読む。

- plan（`plan.txt` は読むための補助である。必要なら `saved.tfplan` を対応する Terraform の version で確かめる）
- 正確な入力（`inputs.json`）と baseline（`baseline.json`）
- root、scheduler と公開の期待値を含む `request.json`
- application の場合は、登録した ZIP（`registered.json`）と、audit、SBOM、試験の証拠

hash の照合は「内容が変わっていない」ことを確かめるだけで、内容を人が承認することの代わりにはならない。apply の run は、レビューした manifest の SHA-256（`expected_review_sha256`）で、レビューした内容と同じであることを自動で確かめる。

初回の platform の構築の後は、`release-result/<run_id>/<run_attempt>/post-baseline.json` を取り出し、`PLATFORM_BASELINE_JSON` の secret を更新する。

## エラーと例外

| 状況 | 動作 |
| --- | --- |
| `manifest.json` が無い、または SHA-256 が期待と違う | 止まる |
| manifest の種類、root、run ID、`run_attempt` が読もうとした場所と違う | 止まる |
| ファイルの集合が種類ごとの集合と違う | 止まる |
| ファイルの SHA-256 が合わない | 止まる |
| 利用期限を過ぎた、または日時が不正 | 止まる。新しい preview が必要になる |
| レビューした manifest の SHA-256 が `expected_review_sha256` と違う、または plan の digest が元と違う | 止まる |
| 既存の key への書き込み | S3 が拒否し、止まる |
| S3 に接続できない、権限が無い | 止まる |

- どの場合も、GitHub の artifact に切り替えることはしない。
- 診断の中身の制限は今のとおりとする（上限付き、認証情報の代入は伏せる、成功時の出力は残さない）。
- role を assume する前に失敗した場合（authorize job、依存関係の install など）は、S3 に書けない。通常のログに phase と exit status だけを出し、診断は残さない。authorize の検査の内容は秘密ではないので、失敗の理由を表す短いコードをログに出す。
- 診断を書くことに失敗しても、job の結果は失敗のままにする。

## bootstrap 済みの環境からの移行

- bootstrap の変更は追加だけとする。新しい bucket とその設定、3つの GitHub 用 role の policy への権限の追加、output `custody_bucket` の追加である。既存のリソースの address は変えず、作り直しや削除を起こさない。
- operator の手順:
  1. 更新後の `infra/bootstrap` で、既存の backend の設定を使って `terraform init -backend-config=backend.hcl` を実行する。
  2. `terraform plan -out=...` を実行し、追加と role の policy の変更だけであることをレビューしてから apply する。
  3. output `custody_bucket` を、repository variable `CUSTODY_BUCKET` に設定する。
- 移行の前に GitHub の artifact に置いたレビューは使えない。移行の後は、新しい preview を作ってから apply する。

## リポジトリを public に切り替えるとき

private のリポジトリを public に切り替える場合は、切り替える前に次を確かめる。

1. 機密を含む GitHub の artifact（移行前の `release-review`、`registered-release`、`release-result`、`failure-diagnostics-*`、`ci.yml` の `failure-diagnostics-infra-*`）が残っていないこと。残っていれば削除するか、保持期間が過ぎて取得できなくなったことを確かめる。
2. 移行前の workflow を再実行して、artifact を作り直していないこと。
3. 移行前の workflow の run のログに、非公開にする情報（apply の結果の ledger など）が残っていないこと。残っていれば、その run のログを削除するか、保持期間が過ぎて取得できなくなったことを確かめる。
4. 実行中、または承認待ちの deploy の run が無いこと。

## 実装の構成

- `scripts/release/` に、S3 の custody を扱うモジュールを追加する。役目は、種類ごとのファイルの集合の定義、manifest の作成、書き込み、読み取り、照合、利用期限の確認である。`@aws-sdk/client-s3` を使い、試験では S3 の client を差し替えられるようにする。
- `scripts/release/workflow.ts`:
  - artifact の download の後に権限を戻す処理を、custody のモジュールの読み取りに置き換える。今の custody の照合と `verifySavedPlan` は残す。
  - `authorizeDispatch` と `verifyReviewedRunMetadata` から、private のリポジトリの条件を外す。
  - 別の run を読むときに、plan の job の `run_attempt` の取得と、manifest の SHA-256 と `expected_review_sha256` の照合を加える。ZIP を再利用する preview でも `expected_review_sha256` を必須にする。job summary の `review_sha256` を manifest の SHA-256 にする。
  - `plan.txt` を作る。
  - apply の結果の ledger を標準出力に出さず、`ledger.json` と `post-baseline.json` を S3 に置く。
  - job の output に、custody の置き場所と `manifest.json` の SHA-256 を加える。
- `deploy.yml`:
  - `upload-artifact` と `download-artifact` の step を削除し、custody の読み書きを role の assume の後に置く。
  - `repository.private` の条件を外す。
  - job の output と `needs` で、custody の置き場所を受け渡す。
  - `CUSTODY_BUCKET` の variable を使う。
- `infra/bootstrap`: bucket、bucket policy、lifecycle、role の権限、output を追加する。

## 試験

### offline

- custody のモジュール（fake の S3 を使う）:
  - 書き込みに `If-None-Match` と SHA-256 の checksum を付け、manifest を最後に書くこと。
  - manifest が無い、または SHA-256 が期待と違うと止まること。
  - 種類、root、run ID、`run_attempt` が合わないと止まること。
  - 必須のファイルの欠落と、manifest の余分なエントリと、取り出し先の余分なファイルを拒否すること。manifest に無い object を読まないこと。
  - ファイルの SHA-256 が合わないと止まること。
  - パスの区切り、`..`、symlink を拒否し、0700/0600 で書くこと。
  - 利用期限の境界（ちょうど24時間、未来の `createdAt`、不正な日時、引き継いだ `expiresAt` の改変）。
  - 既存の key への書き込みが拒否されると止まること。
- `scripts/release/workflow.ts`（`tests/delivery/workflow-driver.test.ts` などを更新する）:
  - authorize と `verifyReviewedRunMetadata` が、public の成功した preview を通すこと。別の repository、別の workflow、失敗した run、`main` 以外の run は引き続き拒否すること。
  - 別の run を読むときに、plan の job の `run_attempt` を使い、manifest の SHA-256 が `expected_review_sha256` と違えば止まること。lifecycle の失効の後に同じ key に作り直した manifest（時刻を書き換えたもの、同じ内容のもの）を拒否すること。
  - 一部の job の再実行で、書いた job の `run_attempt` を読むこと。
  - apply の run の `release-review` が元の `expiresAt` を引き継ぎ、ZIP を再利用した preview は新しい期限になり、元の manifest の SHA-256 を記録すること。ZIP を再利用する preview で `expected_review_sha256` が無いと止まること。一部の job の再実行で output が欠けたら止まること。
  - ledger を標準出力に出さないこと。成功と失敗のどちらでも、標準出力と標準エラーに機密の fixture の値が出ないこと。
  - 初回の platform の構築で、`post-baseline.json` を `release-result` に置くこと。
- `tests/delivery/workflows.test.ts`:
  - `deploy.yml` に `upload-artifact`、`download-artifact`、`repository.private` が無いこと。
  - AWS を使う各 job で、custody の読み書きが role の assume より後にあること。
  - `ci.yml` の診断が、private のリポジトリのときだけであること。
  - 既存の「private で custody する」試験を、新しい仕組みに合わせて書き直す。
- `infra/bootstrap/tests/bootstrap.tftest.hcl`:
  - 新しい bucket の設定（versioning、暗号化、公開アクセスのブロック、bucket policy、prefix ごとの lifecycle、古い version と delete marker の削除）。
  - 各 role の権限が、決めた prefix に限られていること。削除と一覧の権限が無いこと。
  - 既存のリソースの address が変わらないこと。
  - `name_prefix` が最大の長さの既存の入力で、新しい bucket 名が63文字以内に収まること。

### 正式 E2E（Floci）

- 既存の E2E を新しい bucket に対応させる。bucket の一覧を持つ箇所（`scripts/e2e/terraform.ts`、`tests/e2e/floci/support/evidence.ts`、`tests/e2e/floci/support/fixture.ts`、`tests/e2e/floci/support/expected-iam.ts`）と、bootstrap のファイルの一覧（`scripts/e2e/terraform-source.ts` の `publicFiles`）を更新する。清掃で、custody の case が書いた object を含めて、新しい bucket の削除と不在を確かめる。
- 新しい bucket の設定を読み戻す case を追加する。bucket policy は、設定されていること（policy-present）の確認とし、強制されることは確かめない。
- custody のモジュールを Floci の S3 で動かす case を、次の2つに分けて追加する。
  - **必須の case**: ファイルと manifest の書き込み、読み出し、SHA-256 の照合。通信や認証のエラーは失敗として扱い、unsupported にしない。
  - **互換性の case**: 同じ key への2回目の書き込みが `If-None-Match` で拒否されること。Floci が対応していない場合は、この case 専用の互換性の理由と測定の条件を harness に登録し、unsupported として記録する。登録の無い unsupported を fail にする今の harness の規則と、既定の理由（`signature-enforcement-unsupported`）は変えない。harness の試験も追加する。
- 要件の対応表（`docs/operations/formal-e2e-coverage.md`）と結果の文書を更新する。case の件数は増える。

### 確かめないこと

- `deploy.yml` を GHA で実際に動かすこと。
- lifecycle による実際の削除。
- IAM と bucket policy の強制。
- 実 AWS での bootstrap の更新と deploy。

## 文書

- `docs/operations/deployment.md`:
  - 新しい bucket、repository variable `CUSTODY_BUCKET`、lifecycle と利用期限を書く。
  - S3 のコンソールでのレビューの手順（`plan.txt`、`request.json`）と、`post-baseline.json` を取り出して secret を更新する手順を書く。
  - 「bootstrap の更新」と「リポジトリを public に切り替えるとき」の手順を書く。
  - GitHub の artifact と、「private のリポジトリだけ」という前提の記述を書き換える。
- `README.md` の CI/CD の表の `deploy.yml` の説明を直す。
- 文書は汎用の内容とし、特定の環境の作業状況を書かない。

## 範囲に入れないもの

- `allowed_source_ips` の削除。
- 過去に commit された私有ファイルの対応（ローテーションなど）。
- GitHub の environment の設定そのもの。operator が行い、手順は文書に書く。
- 実 AWS での bootstrap の更新と deploy。
