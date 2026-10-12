# release custody の S3 移行 設計

## 目的

`deploy.yml` が GitHub の artifact に置いている、plan、入力、証拠、結果、診断を、bootstrap が作る private な S3 bucket に移す。リポジトリの公開設定（public・private）に関係なく、同じ安全性で deploy できるようにする。

Terraform の plan と state は、秘密の情報を含みうるものとして扱う。`sensitive` を指定した値も、plan と state には平文で入る。public のリポジトリでは、GitHub の artifact とログを誰でも取得できるため、plan などを artifact に置けない。

## 前提と決定事項

- public・private のどちらのリポジトリでも動く。リポジトリの公開設定には頼らず、秘密の情報は常に S3 に置く。
- bootstrap は operator が手動で実行する。GitHub Actions から bootstrap を実行しない。
- 今の安全確認はすべて残す。レビューした saved plan をそのまま apply すること、`review_sha256` の照合、custody の hash の照合、`reviewed_run` の来歴の確認である。
- GitHub の plan に依存する機能（environment の secret、deployment branch の制限、required reviewers）は、使える場合に使う。使えない場合の扱いは今の文書のとおりとする。
- 長期間有効な AWS のアクセスキーは使わない。GitHub の job は OIDC で role を assume する。

## 保存先

### bucket

bootstrap に bucket を1つ追加する。

- 名前: `<name_prefix>-<account_id>-<region>-release-custody`
- versioning、SSE-S3 の暗号化、公開アクセスのブロックを有効にする。
- bucket policy:
  - HTTPS 以外の通信を拒否する。
  - `If-None-Match: *` の無い `PutObject` を拒否する。既存の object の上書きをさせない。
  - `DeleteObject` と `DeleteObjectVersion` を拒否する。object を消すのは lifecycle だけとする。
- lifecycle:
  - `release-result/` は、作成から30日で削除する。
  - それ以外の prefix は、作成から1日で削除する。
  - 古い version も同じ期間で削除する。

### object の置き方

prefix は `<種類>/<run_id>/<run_attempt>/` とする。GitHub の「Re-run jobs」では run ID が変わらず、`run_attempt` だけが増えるためである。

| prefix | 中身 | 書く role | 読む role | 保持 |
| --- | --- | --- | --- | --- |
| `registered-release/<run_id>/<run_attempt>/` | 登録した ZIP の manifest（RegisteredArtifact）と証拠 | artifact | plan | 1日 |
| `release-review/<run_id>/<run_attempt>/` | saved plan、`plan.json`、`plan.txt`、`inputs.json`、baseline、`request.json`、証拠のファイル、custody の hash の一覧 | plan | plan（別の run から）、apply | 1日 |
| `release-result/<run_id>/<run_attempt>/` | 成功の記録（ledger） | apply | なし | 30日 |
| `failure-diagnostics/<run_id>/<run_attempt>/<job>/` | 失敗時の診断 | 失敗した job の role | なし | 1日 |

`plan.txt` は、saved plan から `terraform show -no-color` で作る、人が読める形の plan である。

各 prefix には、最後に `manifest.json` を書く。manifest には、作成時刻、run ID、`run_attempt`、ファイル名と SHA-256 の一覧を入れる。

### GitHub の側

- `registered-release`、`release-review`、`release-result`、`failure-diagnostics-*` の GitHub の artifact は、すべて廃止する。
- GitHub に出すのは、job summary の要約だけとする（root、commit、action の件数、`review_sha256`）。
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

## 受け渡しと照合

### 書き込み

1. job はファイルを1つずつ書く。各書き込みに `If-None-Match: *` と SHA-256 の checksum を付ける。
2. 最後に `manifest.json` を書く。

### 読み取り

1. `manifest.json` を読む。無ければ止まる。
2. manifest の run ID と `run_attempt` が、読もうとした prefix と一致することを確かめる。
3. manifest の作成時刻から24時間を過ぎていれば止まる。lifecycle による実際の削除は遅れることがあるため、object が残っていても使わない。同じ run の apply の job でも同じとし、`production` の承認を24時間以上待った場合は新しい preview が必要になる。
4. manifest にある各ファイルを読み、SHA-256 を照合する。1つでも合わなければ止まる。

### job の間と run の間

- 同じ run の中では、書いた job が custody の hash を job の output で渡す。hash は秘密ではない。読む job は、S3 から取り出した内容をその hash と照合する。
- 別の run の内容を読むときは、GitHub の API で、`reviewed_run` が「`main` の `deploy.yml` を手動で実行し、成功した preview」であることと、その成功した試行の `run_attempt` を確かめる。その後に `release-review/<reviewed_run>/<run_attempt>/` を読む。`review_sha256` の照合は今のとおりとする。

### レビューの手順

人は、AWS コンソールの S3 画面で `release-review/<run_id>/<run_attempt>/` の `plan.txt` と `request.json` を開いて読む。digest の照合は、apply の run が自動で行う。

## エラーと例外

| 状況 | 動作 |
| --- | --- |
| `manifest.json` が無い | 止まる。書き込みが終わっていないか、保持期間が過ぎたとみなす。新しい preview が必要になる |
| ファイルの SHA-256 が合わない | 止まる |
| 作成から24時間を過ぎたレビュー | 止まる |
| 既存の key への書き込み | S3 が拒否し、止まる |
| S3 に接続できない、権限が無い | 止まる |

- どの場合も、GitHub の artifact に切り替えることはしない。
- AWS の role を assume した後に失敗した job は、`failure-diagnostics/` に診断を書く。診断の中身の制限は今のとおりとする（上限付き、認証情報の代入は伏せる、成功時の出力は残さない）。
- role を assume する前に失敗した場合（authorize job、依存関係の install など）は、S3 に書けない。通常のログに phase と exit status だけを出し、診断は残さない。authorize の検査の内容は秘密ではないので、失敗の理由を表す短いコードをログに出す。
- 診断を書くことに失敗しても、job の結果は失敗のままにする。

## bootstrap 済みの環境からの移行

- bootstrap の変更は追加だけとする。新しい bucket とその設定、3つの GitHub 用 role の policy への権限の追加、output `release_custody_bucket` の追加である。既存のリソースの address は変えず、作り直しや削除を起こさない。
- operator の手順:
  1. 更新後の `infra/bootstrap` で、既存の backend の設定を使って `terraform init -backend-config=backend.hcl` を実行する。
  2. `terraform plan -out=...` を実行し、追加と role の policy の変更だけであることをレビューしてから apply する。
  3. output `release_custody_bucket` を、repository variable `CUSTODY_BUCKET` に設定する。
- 移行の前に GitHub の artifact に置いたレビューは使えない。移行の後は、新しい preview を作ってから apply する。

## 実装の構成

- `scripts/release/` に、S3 の custody を扱うモジュールを追加する。役目は、manifest の作成、書き込み、読み取り、照合である。`@aws-sdk/client-s3` を使い、試験では S3 の client を差し替えられるようにする。
- `scripts/release/workflow.ts` の、artifact の download の後に権限を戻す処理と custody の照合を、このモジュールの呼び出しに置き換える。`authorizeDispatch` から、private のリポジトリの条件を外す。別の run の確認に `run_attempt` を加える。
- `deploy.yml` の `upload-artifact` と `download-artifact` の step を、このモジュールを呼ぶ step に置き換える。`repository.private` の条件を外す。
- `infra/bootstrap` に、bucket、bucket policy、lifecycle、role の権限、output を追加する。

## 試験

### offline

- custody のモジュール（fake の S3 を使う）:
  - manifest を最後に書くこと。
  - 書き込みに `If-None-Match` と SHA-256 の checksum を付けること。
  - manifest が無いと止まること。
  - run ID と `run_attempt` が合わないと止まること。
  - SHA-256 が合わないと止まること。
  - 作成から24時間を過ぎたレビューを拒否すること。
  - 既存の key への書き込みが拒否されると止まること。
- `scripts/release/workflow.ts`:
  - authorize が、リポジトリの公開設定に関係なく通ること。
  - 別の run を読むときに、`run_attempt` まで確かめること。
- `tests/delivery/workflows.test.ts`:
  - `deploy.yml` に `upload-artifact`、`download-artifact`、`repository.private` が無いこと。
  - AWS を使う各 job が、S3 の custody の step を通ること。
  - `ci.yml` の診断が、private のリポジトリのときだけであること。
  - 既存の「private で custody する」試験を、新しい仕組みに合わせて書き直す。
- `infra/bootstrap/tests/bootstrap.tftest.hcl`:
  - 新しい bucket の設定（versioning、暗号化、公開アクセスのブロック、bucket policy、lifecycle の1日と30日、古い version の削除）。
  - 各 role の権限が、決めた prefix に限られていること。削除と一覧の権限が無いこと。
  - 既存のリソースの address が変わらないこと。

### 正式 E2E（Floci）

- 既存の E2E を新しい bucket に対応させる。bucket の一覧を持つ箇所（`scripts/e2e/terraform.ts`、`tests/e2e/floci/support/evidence.ts`、`tests/e2e/floci/support/fixture.ts`、`tests/e2e/floci/support/expected-iam.ts`）と、bootstrap のファイルの一覧（`scripts/e2e/terraform-source.ts` の `publicFiles`）を更新する。清掃で、custody の case が書いた object を含めて、新しい bucket の削除と不在を確かめる。
- 新しい bucket の設定を読み戻す case を追加する。bucket policy は、設定されていること（policy-present）の確認とし、強制されることは確かめない。
- custody のモジュールを Floci の S3 で動かす case を追加する。ファイルと manifest の書き込み、読み出しと SHA-256 の照合、同じ key への2回目の書き込みの拒否を確かめる。Floci が `If-None-Match` に対応していない場合は、unsupported として記録する。
- 要件の対応表（`docs/operations/formal-e2e-coverage.md`）と結果の文書を更新する。case の件数は増える。

### 確かめないこと

- `deploy.yml` を GHA で実際に動かすこと。
- lifecycle による実際の削除。
- IAM と bucket policy の強制。
- 実 AWS での bootstrap の更新と deploy。

## 文書

- `docs/operations/deployment.md`:
  - 新しい bucket、repository variable `CUSTODY_BUCKET`、保持期間を書く。
  - S3 のコンソールでのレビューの手順（`plan.txt`、`request.json`）を書く。
  - 「bootstrap の更新」の手順を書く。
  - GitHub の artifact と、「private のリポジトリだけ」という前提の記述を書き換える。
- `README.md` の CI/CD の表の `deploy.yml` の説明を直す。
- 文書は汎用の内容とし、特定の環境の作業状況を書かない。

## 範囲に入れないもの

- `allowed_source_ips` の削除。
- 過去に commit された私有ファイルの対応（ローテーションなど）。
- GitHub の environment の設定そのもの。operator が行い、手順は文書に書く。
- 実 AWS での bootstrap の更新と deploy。
