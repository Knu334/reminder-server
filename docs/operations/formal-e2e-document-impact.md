# 正式E2Eの設計変更と関連文書の確認結果

2026-10-08。設計・計画レビュー時の文書確認。正式E2EとAPI結果ログは未実装・未実施である。

## 確認した範囲

公開Markdownの参照と関連語を検索し、正式E2Eの設計・計画・69要件の対応表を突き合わせた。
ハンドオフ、README、調査・費用資料、既存のAPI/認証/清掃/移行/復旧/配布手順、実装結果・受け入れ記録、公開infra READMEも確認した。
私有inputs/state/plan/credentials、実データ、実画像は確認対象にしていない。
この確認は文書間と現行公開コードとの整合確認であり、Floci互換性やE2E成功を実証したものではない。

確認の基準は、本番3root再利用のapply→設定読み戻し→入力→HTTP/DDB/S3/CloudWatch照合→結果確定→回収という順序である。
各ケースの期待assertと実際の照合結果、対象外理由、未実施と実行後の失敗、承認状態も確認した。今回の6指摘への再調査・改訂は下記追補に記載する。先の確認ではGateway v2配信とoverride条件ブロックの例外、共有OIDC所有、時間見積もりを十分に確認できていなかった。

## 今回更新した文書

| 文書 | 反映した内容 |
| --- | --- |
| [設計案](../superpowers/specs/2026-10-08-reminder-server-formal-e2e-design.md) | 出力ごとのassert記録、入力拒否と画像Put後の409/故障の区別、清掃ログの例外とID対応、refreshの検証範囲 |
| [実装計画](../superpowers/plans/2026-10-08-reminder-server-formal-e2e.md) | runner組み込みと出力照合の担当、全assertを確認する共通契約、清掃ログobserver、既存文書の更新担当 |
| [要件対応表](formal-e2e-coverage.md) | 全caseの出力期待と照合結果、CLEAN-01/OBS-03/SAFE-02の具体的な判定、AUTH-10の層と未検証範囲 |
| [調査記録](formal-e2e-research.md) | OIDC/9alarmのローカル構築を必須とする区分、初期化阻害と実行後fail、コード確認による修正根拠 |
| [現行ハンドオフ](../superpowers/handoffs/2026-10-08-reminder-server-formal-e2e-sdd.md) | 初稿からの変更をプロンプト内へ追記。必須Terraform、本番定義再利用、承認待ち、費用・ログ・判定規則から再開できるようにした |
| [README](../../README.md) | レビュー中の設計・計画への入口、未実装のnpm入口/API結果ログと過去の成功件数の区別 |
| [画像保持・ログの費用判断](formal-e2e-cost-and-logging.md) | API Lambda呼び出しだけに追加ログを出す範囲、既存保持期間の維持、設計・計画との参照 |
| [既存の費用試算](../aws-cost-estimate-2026-10-02.md) | 東京/月100回未満という新しい利用見込みへの参照。米国東部の全体モデルと東京の部分概算の区別、ログ費の二重加算防止 |
| [既存の実装結果](../implementation-results.md) | F10の既存証拠にAPI操作結果ログが含まれていないことを日付付きで追記。過去の結果を新E2Eの成功として使わない |

この一覧自体を新設し、README・計画・調査記録・ハンドオフから参照できるようにした。
元から未追跡のハンドオフには追補だけを加え、既存本文と未追跡状態を保つ。

## 追加で見つかった不整合と修正

| 不整合 | 修正と根拠 |
| --- | --- |
| OIDCを対象外とする調査表と、全resourceのapply/read-backを要求する設計が矛盾 | OIDC provider/role/subjectと9alarmのローカル設定は必須。本番OIDC認証・GHA・監視の実受け入れは対象外に分けた |
| 設計のunsupported/partialと共通CaseStatusが不一致 | statusはunsupportedまたはfail、partial applyはphase/manifestへ記録する形に揃えた |
| TF全caseをLとする文章と、対応表のdriver/source負例Iが不一致 | TFは要件IDの区分。実apply/設定確認はL、決定的なdriver/source負例はIと明記した |
| 出力の種類だけが揃えば、その中のassert不足を見落とせる共通型 | 期待assert名と実施結果を出力ごとに記録し、一部の欠落でもpassにしない契約と負例を追加 |
| 拒否された要求は常に保存不変という記述が、画像付きduplicate409の孤児と矛盾 | 認証・入力検証による拒否と、S3 Put後のDB拒否/故障を区別した |
| 清掃の開始・終了ログを同じrequest IDで一致させる想定 | 現行src/cleanup.tsはlambdaRequestId、src/cleanup/service.tsは別runIdを出す。stream/観測区間で対応づけ、曖昧な別invokeログを採用しない案に変更 |
| 未公開清掃や不正eventにもcleanup終了ログを要求し得る | 未公開はcleanup_startとskippedUnpublished、event拒否はFunctionErrorと保存不変を確認し、ログの対象外理由を記録 |
| AUTH-10の「元deadline独立I」に本計画の担当と実行経路がない | 実10秒graceの起点不延長をEで確認し、30日絶対期限と更新時の不延長はAに統一。過去Floci回帰は補助資料 |
| 旧F10記録がAPI操作の結果ログも実装済みと読める | 既存の安全なエラー/helper/清掃/Gateway設定と、未実装のAPI結果ログを追補で区別 |
| 地域未指定の費用資料と東京の利用見込みが併存 | 旧モデルの作成時前提を明記し、東京の部分概算へリンク。東京の総額を更新したという表現は使わない |

## 実装後に更新する文書

未実装のコマンドや実測していない結果を、現在の手順・成功結果として記載しない。
以下は計画Task12へ反映した。

| 文書 | 更新する条件と内容 |
| --- | --- |
| docs/operations/formal-e2e-README.md（新規予定） | 実際に使えるnpm入口、依存準備、設定確認、case選択、出力確認、診断、owned回収、手動再開を記載 |
| docs/operations/formal-e2e-results.md（新規予定） | freshコマンド/exit、case別assert結果、生成元/ZIP、必須未実施、cleanup/leak、review/rulingsを記載 |
| docs/operations/formal-e2e-limitations.md（新規予定） | 実測したFloci不足API、署名/Scheduler probe、I/A/Chromeの境界と未検証を記載 |
| README、要件対応表、調査記録、本書 | 入口・case registry・実測・制限との参照を一致させ、未確認を実施済みと混同しない |
| docs/implementation-results.md、docs/operations/acceptance.md | API結果ログと正式E2Eの新しい実測を日付付きで追記。旧19タスクの証拠・件数は保存 |
| docs/operations/cleanup.md | 実測した開始/終了/skipログの読み方と新E2E手順への参照を追記。将来の本番操作とローカル実測を区別 |

費用資料は、ログ量や保持方針の前提が変わった場合に更新する。東京の総額は現在単価の取得と全サービスの再計算が必要で、今回の部分概算では確定しない。

## 現行契約または履歴として保持する文書

| 文書群 | 確認した関係・扱い |
| --- | --- |
| docs/superpowers/specs/2026-10-02-reminder-server-aws-design.md | 承認済み製品契約。tombstone、24h保護、旧version60日、PITR35日、ログ30日、認証/規定上限を正式E2Eへ適用。今回のテスト構成で書き換えない |
| docs/api-v2.md、docs/chrome-extension-cognito-auth.md | HTTP/DTO/認証契約を維持。API結果ログ追加でAPI応答やChrome実装を変更しない |
| docs/operations/migration.md、recovery.md、deployment.md、infra/application/production/README.md | 初期構築・移行・復旧の契約を再利用。実AWSの私有inputs/provider chainやPITRをローカルへ持ち込まない |
| docs/operations/acceptance.md、docs/implementation-final-review.md、implementation-rulings.md | 旧19タスクと過去のローカル検証証拠。正式E2E成功へ流用しない。新結果は既存記録を保って追記する |
| 2026-10-03の全体/runtime/operations/delivery計画とハンドオフ | 完了済み計画・判断。新SDD台帳へ流用・再dispatchしない |
| 2026-10-07のFloci計画、docs/operations/local-e2e-* | 旧設定・固定ZIP・直接invoke等の過去記録。現行source/ZIP、正式E/I/Lケースの証拠とは区別 |
| 2026-10-02の旧modernization設計・repository audit | 経緯と問題の出典。最新版の製品/E2E設計と区別し、過去の主張を遡って変更しない |
| root .devcontainer/floci/README.mdとFW/Compose | 現行Flociの準備手順とユーザー変更。編集せず参照する。host側変更が必要なら具体的差分と再開手順を残す |

## 文書の検証

設計・計画・対応表の順序/層/必須度/保存状態/ログ例外と担当を確認した。
前回は12タスク・61手順、対応表の69要件ID、9列表、当時の更新対象10文書の114参照、差分の空白を機械的に確認した。今回の追加・改訂は下記追補の検証で区別する。
変更した日本語はyomiyasuで見直した。チェックリストと要件表は役割があるため残した。
この検証結果は文書の検証として記録し、製品テストやFloci実行の結果には数えない。

## 6指摘に伴う追加の波及確認（2026-10-08）

| 指摘と判断 | 更新した文書・担当 |
| --- | --- |
| ① Gateway v2配信はソースで未実装。設定保持と配信を分け、配信は互換性調査。不在だけで未到達を断定しない | 設計の冒頭/§3/6/8/9、計画Task4/5/11/12、OBS-02、調査、README、ハンドオフ、費用・実装結果追補 |
| ② override fileではvalidation/postconditionを上書きできない。2validationだけ一時コピー変換、2output.value接続override。prevent_destroy scalar overrideはpostconditionを保持 | 設計§2/8の具体的許可リスト、計画Task3/共通型、TF-04、調査の公式ソース/TF未導入記録、ハンドオフ |
| ③ OIDCはrun単独所有。基盤一組、foreign最小control、復旧3table/restored_tablesと既存state | 設計§3/5/7/8、計画Task3/4/5/10、OPS-03/TF-03、調査、README、ハンドオフ |
| ④ suite別applyと負例別60秒待ちを廃止。共有設定復元、一括observer、工程別22〜65分、75分+回収15分 | 設計§3/5/6/8、計画Task1/3/4/5〜12/共通型、対応表の集計、調査、費用・ログ、ハンドオフ |
| ⑤ 製品結果ログは独立承認・検証・commit後にE2E。E2E Task2は前提確認のみ | 新規[独立APIログ計画](../superpowers/plans/2026-10-08-reminder-server-api-result-logging.md)、設計承認範囲、計画Task2/共通依存、OBS-01、README、実装結果、費用2資料、調査、ハンドオフ |
| ⑥ TLS policy保持と強制未検証を別記。HTTP成功は強制の証拠でない | 設計§8、計画Task11/12、SAFE-04、調査、ハンドオフ、実装後のlimitations更新条件 |

更新対象は先の10文書と新規APIログ計画の計11文書。本番Terraform、製品コード、過去の受け入れ結果・運用契約は変更していない。ハンドオフは末尾追補で旧記述を更新し、元本文・未追跡状態を保持した。APIログの実装結果は独立計画完了後、正式E2Eの結果・入口・制限はE2E Task12完了後に追記する。既存の清掃/復旧/配布手順に未実装のコマンドや実測成功を追加しない。

今回の文書検証ではE2E12タスク61手順、独立APIログ1タスク5手順、69要件IDと9列表、11文書の128件のローカル参照、変更の空白、ハンドオフ元本文の保持を確認した。日本語はyomiyasuでlintと改訂前後diffを確認し、チェックリスト・否定による誤読防止・歴史資料の文体に関する候補は意味を保って残した。計画の長い手順は段落を分けた。Floci/Terraformの実動作検証を行ったという意味ではない。
