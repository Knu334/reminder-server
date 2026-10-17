# 正式E2E 判断の記録

正式E2E（[設計](../superpowers/specs/2026-10-08-reminder-server-formal-e2e-design.md)、[実装計画](../superpowers/plans/2026-10-08-reminder-server-formal-e2e.md)）の作業中に、ユーザーが行った判断と承認、および作業の進行役（controller）が実装の範囲を決めた判断（ruling）を、この文書に残す。作業中の台帳はgit管理外のため、必要な内容はここに移した。結果は[結果](formal-e2e-results.md)、限界は[限界](formal-e2e-limitations.md)、手順は[手順](formal-e2e-README.md)にある。

秘密、生のログ、私的なpathは含めない。日付は2026年である。

## ユーザーの判断と承認（日付順）

| 日付 | 判断 | 内容と結果 |
| --- | --- | --- |
| 10-09 | 永続的なtoolの置き場 | `/tmp` はtool消失を繰り返したため、固定版のtoolとcacheを、リポジトリ直下のgit管理外の `.superpowers/tools/aws-sdd` に置く。以後のコマンドはこの場所のPATHを付ける（現行の手順） |
| 10-09 | Floci patch 1（refresh.2）の承認 | `AddPermission` が `SourceArn` と `SourceAccount` の両方を保持するよう修正し、回帰試験を加える。hostのFloci再build、imageのtagとhealth版のpin更新も承認した。設定gateが常に失敗する問題を解く |
| 10-09 | Floci patch 2（refresh.3）の承認 | `ListVersionsByFunction` を、`$LATEST` を先頭、続いて版番号の昇順に並べる。provider 6.67.0が末尾の要素を最新と見なすため、順序が不定だと `$LATEST` を選ぶ。pinをrefresh.3へ |
| 10-09 | Floci patch 3（refresh.4）の承認 | CloudWatchの `PutMetricAlarm`、`DescribeAlarms` が `ExtendedStatistic` と `EvaluateLowSampleCountPercentile` を落とす問題の修正と、AlarmEvaluatorのnull対策。pinをrefresh.4へ |
| 10-10 | Floci patch 4（refresh.5）の承認 | HTTP API v2の実応答にCORSヘッダを付ける。Lambdaへ渡すrawPathをpercent-encodedのままにする。hosted `/oauth2/revoke` の400の意味は、調査だけを承認した（routeの追加は別の承認が要る）。pinをrefresh.5へ |
| 10-10 | Floci patch 5（refresh.6）の承認 | host filterがraw pathを記録し、routeの一致とrawPathに使う。proxyの二重decodeをやめる。pinをrefresh.6へ |
| 10-11 | 開発コンテナへのJDK導入と、Floci patch 6（refresh.7）の承認 | Temurin JDK 25（`eclipse-temurin:25.0.1_8-jdk`）を `.devcontainer/Dockerfile` に追加し、Floci patchの回帰をJava試験で確認できるようにした。patch 6は、host filterが `%` を `%25` にしてから組み立てる修正で、API-09/id-percentの失敗（二重decodeによる500）を直した。リポジトリ外のroot repositoryに、devcontainerとFlociの変更を、ローカルcommit（7件）として残した（`init-firewall.sh` はcommitしていない）。refresh.7のJava回帰は対象11クラスで300/300合格した |
| 10-12 | layer Iを完了に数える判断 | offline試験で検証したlayer Iの24件は、内容が有効なら完了に数える。`npm test` は、E・L・Iを通しで実行する（選択肢A: `npm test` = `test:offline` + `test:e2e:floci`、Flociが無ければexit 2。`test:offline` = runtime + operations + delivery + integration + harness）。範囲を限った設計を承認した。layer Iは、子processの `node --test` の実測から判定し、CIのworkflowは変えない |
| 10-12 | 監査で見つかった6件の修正 | 監査で不十分とされたlayer Iの6件を、試験と対応づけの修正だけ（製品の変更なし）で、offline-evidenceの指摘と合わせて一度に直し、再監査してからliveで再実行する |
| 10-12 | null-body修正のcommit | ユーザーの未commitだった `src/api/event.ts` の変更（Gatewayのnull bodyを本文なしとして扱う）を、ユーザーがcommit（6daf48b）した。以後のrunは未commitの変更を含まない |
| 10-12 | 記録の置き場 | 追跡されたdocumentが、git管理外の台帳を指すのは文書として誤りである。判断は追跡されたdocumentに置く（この文書） |
| 10-12 | pushとPRの承認 | `feature/aws-modernization` のpushとGHAの結果確認を承認した。push自体はworkflowを起動しない（`ci.yml` は `pull_request` と `main` へのpushで動く）。PRを `main` へ作ってci.ymlを動かし、PRはmergeしない。mergeは、この文書の問題を解いた後に、`feature/aws-modernization` へ行う |

## controllerの判断（ruling）

各項目は、決定、理由、誤っていた場合の費用、現在の状況の順に書く。番号は、主題ごとに並べた通し番号である。

### 実装の範囲と接続の隔離

1. **本番公開rootの変換**: `prepareProductionRoots` が公開rootを複写して検証し、application側の2つのURL検証と、platformのoutput上書きは、所有するpoolとdiscoveryが決まった後の段階的な構築で確定する。理由は、設計が、discoveryから得た所有URLを要求し、それがplatformの構築前には存在しないため。誤っていた場合は、driverの段階やinterfaceの作り直しが要る。本番の変更や制限の緩和は許可しない。状況: 有効。実装済み。
2. **Task 1のlogs型**: Task 1のlogs欄は、構造的な送信portを仮に使い、Task 4が公開版を確認した時点で、固定版のCloudWatchLogsClient型へ置き換える。理由は、依存とlockの変更がTask 4の担当であり、Task 1の時点では型の元のpackageが無いため。誤っていた場合は仮の型の作り直し。runtimeの依存は増やさない。状況: 解消。Task 4で実際のclientに置き換えた。
3. **Task 3の最小の拡張**: Task 3は、`support/evidence.ts`、`support/types.ts`、`scripts/e2e/run.ts` と、それを覆うharness試験を、耐久的な所有リソース登録とTerraformの診断・予算・取消のinterfaceのために最小限だけ広げてよい。通常のsuiteの組み立てはTask 4の担当である。理由は、manifestが空のresourcesを書き直し、単独の実行がprovisioningを呼べなかったため。誤っていた場合は戻せる範囲のharness作り直し。製品とinfraは変えない。状況: 有効。実装済み。
4. **toolの置き場**: ユーザーの指示（`/tmp` に永続的なtoolを置かない）に従い、固定版のtoolと必要なcacheは、git管理外の `.superpowers/tools/aws-sdd` に置く。`runChild` もこのPATHに合わせる。履歴のコマンド記録は、実際に使った `/tmp` のpathのまま残す。理由は、tool消失が繰り返され、最新のユーザー指示が先の前提を上書きするため。誤っていた場合は、戻せるlocalのpath設定の作り直し。状況: 有効。現行の手順。
5. **run専用のloopback proxy**: Terraformの子processだけが、run専用のloopback HTTP proxyを使う。検証済みのFloci originだけを、固定のprivate IPv4へ転送し、URL・Host・path・query・body・署名を保ち、CONNECT・公開host・default・未知のhost・portは、DNSやdialより前に拒否する。redirectは追わない。理由は、固定版のprovider 6.67のS3 region解決が、明示したendpointを抜けるおそれがあり、既存の10項目のschemaでは、fallbackが無いことを示せないため。誤っていた場合は、戻せるlocal transportの作り直し。状況: 有効。実装済み。
6. **回収時の `-refresh=false`**: 同じrunの回収では、結果の確定と保護の解除、stateとmanifestの同一性の再確認の後に限り、`terraform destroy -refresh=false` を使ってよい。構築と動作確認では使わない。理由は、providerのbucket refreshが、これまで除外していたS3 Controlのtag取得を呼び、回収を妨げたため。誤っていた場合は、古いstateでの回収が不完全になるか、誤分類される。cacheしたempty stateだけではleak 0を示せず、独立した不在確認が要る。状況: 有効。実装済み。
7. **S3 Controlの限定relay**: STSで確認した合成accountに `.floci` を付けた論理authority（http、port 4566）だけを、認証付きのrun専用proxyが、DNS確認済みのFloci private IPv4へ転送する。固定SDKのS3 Control操作とpathだけを認識し、所有resourceのIDに限る。他のaccount・alias・service・protocol・port・auth・公開・default・CONNECT・redirectは、上流への送信前に拒否する。理由は、固定SDKがcustom endpointでもaccountを前置するため。誤っていた場合は、分類・routingの作り直しと、合成のlocal S3 Control要求の誤送。実際のネットワーク宛先は増やさない。状況: 有効。実装済み。
8. **回収前の静止の確認**: 単独のTask 3の静止確認は、run固有の「handler呼び出しなし」の履歴と、無効のSchedulerの読み戻しを使ってよい。全体のE/Lは、実際の呼び出しと清掃のlog・storageの完了を、回収の前に追う消費側のhookを登録する。空の `ConcurrentExecutions` は、ゼロの証明にならない。理由は、Task 3の診断にはfixtureの入力が無く、Task 4/9/11が実際の呼び出しを追うため。誤っていた場合は、lifecycle追跡のinterfaceの作り直しで、回収が止まるか未確認になる。状況: 有効。実装済み。
9. **作成前の耐久的な意図の記録**: 公開本番rootと静的resource addressを、最初のinit/applyより前に作成の意図として耐久的に記録し、作成後に実際の所有IDを結びつける。理由は、rootだけの所有意図では、作成前のresource一覧があいまいになり、生成IDは事前に存在しないため。誤っていた場合は、manifest対応づけの作り直し。未知のIDから不在を推定せず、未確認の部分的なresourceは失敗として残す。状況: 有効。実装済み。

### 依存と所有リソース

10. **test専用のSDK依存**: Task 4は、`@aws-sdk/client-cognito-identity-provider`、`client-apigatewayv2`、`client-iam`、`client-scheduler` を、`client-cloudwatch-logs` とともに、3.1146.0のtest専用devDependencyとして追加してよい（lockも更新）。runtimeのZIPには含めない。理由は、所有するCognito controlと、独立した設定の読み戻しに、これらのclientが要るため。誤っていた場合は、devDependency・lock・型の統合の作り直し。状況: 有効。buildとpackageの検証で、ZIPへの影響が無いことを確認した。
11. **SDK controlの寿命**: Task 4は、`sdk-control` と `sdk-user` の意図に限り、suiteごとの寿命と、所有IDの結びつけを、`evidence.ts` と `types.ts` に最小限加えてよい。suiteのlogを確定し、動作中のcaseが無いときだけ、独立した不在の確認後に、早めの削除済み印を付ける。runのresourceとTerraformのroot・archiveの削除は、run確定後の制限のまま。理由は、`resetSuite` が逐次suiteの間に、所有SDK controlを消す必要があるため。誤っていた場合は、manifestや寿命の作り直しか、suiteの回収時期の誤り。状況: 有効。実装済み。
12. **IAM全体の比較**: Task 4は、IAMのpolicy・trust・boundaryの全体比較を必須のままとし、許可済みの公開HCL式と既知の合成bindingから、独立した期待のpolicyを作る最小のhelper（必要ならresourceなしの固定Terraform console評価）と、`runChild` のstdin対応を加えてよい。理由は、現行のproducerはbindingを出すが、独立した完全なpolicyを持たないため。誤っていた場合は、evaluator・helper・process interfaceの作り直し。新しいresource・provider・backend・moduleや、本番・構築stateへの依存、生の出力の保存は禁止する。部分的なIAMの読み戻しを、TF-03の成功と呼ばない。状況: 有効。実装済み。
13. **artifactのbinding**: Task 4は、`terraform.ts` のproducerの文字列bindingに、`artifact_bucket`、`artifact_key`、`artifact_version_id`、`artifact_sha256_base64` を、元のregisterArtifactの受領から加えてよい。理由は、Task 3のallowlistがobject型のartifactを除くため。同じbytesの新しい版との区別に、元のVersionIdとchecksumが要る。誤っていた場合は、producerとconsumerの対応の作り直し。所有する合成の秘密でない欄だけで、生のstateは読まない。状況: 有効。実装済み。

### ログと観測

14. **未公開の清掃ログ**: `expectCleanupLogs` の `skippedUnpublished=true` は、追跡した一回の同期invoke・stream・windowにおける実際の `cleanup_start` と、`skippedUnpublished=true` で評価0・削除0の応答、所有storageの不変で判定する。清掃のservice-endログを要求も創作もしない。公開済みの期待は、同じstream・単一invokeの対になった開始と終了を要求する。理由は、未公開の分岐は、結果logの手前で戻るため。誤っていた場合は、observerやTask 9の契約の作り直し。製品のログは変えない。状況: 有効。実装済み。
15. **SDKのabort信号の伝播**: Task 4は、`support/transport.ts` のSDK handlerとlocalS3を、SDKのabort信号と残り時間の上限を、検査済みの `localRequest` へ渡すよう最小限広げてよい。理由は、handlerが信号を無視して常に30秒待つため、suiteの期限に近いpollが必須の60秒の窓を超える。誤っていた場合は、transportやcancellationの作り直しか、期限の退行。endpoint・Host・default・redirectの検査は保つ。状況: 有効。実装済み。
16. **permission policyの正規化**: Task 4のpermission policy比較は、IAMのConditionの文脈keyの大文字小文字と、wildcardを含まないStringLikeだけを、StringEqualsと同じ意味に正規化してよい。重複したkey、account欠落や誤り、wildcard・IgnoreCase、resource・source範囲の変更は拒否し、alias付きの完全な比較は保つ。理由は、厳密なJSON表現だと、意味の同じ公開policyを誤って拒否しうるため。誤っていた場合は、比較の作り直しと、別の権限を誤って許す危険。`SourceAccount` の強制は外さない。状況: 有効。実装済み。
17. **dispose時のSDKの最終不在確認**: Task 4のdisposeは、SDK cleanupのerrorと結果を保持し、`stack.destroy` の後に、所有を厳密に確認した範囲でGet/Describeだけの独立した最終不在確認を行い、確認できたSDKのmanifest項目だけを削除済みにする。既知の親のResourceNotFoundは、厳密に結びつけた子の不在だけを示す。未知・あいまいなIDは未確認のerrorとして残す。理由は、静止のhookが例外を出すと、SDKのleakがTerraformの集計だけに隠れるため。誤っていた場合は、集計の二重計上や物理leakの誤分類。状況: 有効。実装済み。
18. **観測の例外と窓の解釈**（ログ観測の修正）: 観測の予算切れで走査が途中で止まった場合は、不在をpassにせず、`ObserverFailure` を出してfailにする。「60秒以内」は、最後の入力から60.5秒までの観測窓と、その後の有界な完了pollを指し、最悪で約120.5秒である。理由は、静かな途中打ち切りで、不在が通ることを避けるため。誤っていた場合は、60秒で打ち切るfail-closedの実装が要る。状況: 有効。[手順](formal-e2e-README.md)と[結果](formal-e2e-results.md)に記録した。
19. **複数の清掃log期待**: 共有の `logs.ts` を最小限広げ、一つのcaseが複数の清掃log期待を登録できるようにする（それぞれ単一invokeの同一streamの対）。CLEAN-09の二回目のinvokeは `deletes:0` に固定する。理由は、公開された全invokeの対を要求する方針に対し、これが最小の変更のため。誤っていた場合は、invokeごとにcaseを分ける（case IDが増える）。状況: 有効。実装済み。

### 検証の進め方とFlociの扱い

20. **モデルの割り当て**: 実装者はclaude sonnet、task reviewerはclaude opus、最終の全体reviewerはclaude opus（利用できる最も強いもの）とする。計画のcodex gpt-* 許可一覧は、この環境では使えない。理由は、計画の役割の意図を、段階で保つため。誤っていた場合は、別の段階でreviewをやり直す。コードへの影響は無い。状況: 作業の進め方の記録。完了。
21. **Task 4の完了**: 再開できない前のagentに代わり、新しい実装者が、briefと文脈を引き継いで完了する。残りは、最終のoffline検査、Floci SourceAccountの差分提案の保存、ユーザーのnull-body 3 fileを除く明示pathのcommitである。これ以上の診断のための実機の再構築ループは行わない。誤っていた場合は、後で実機のrunが一回余計に要る。状況: 解消。Task 4はcommit済み。
22. **SourceAccountの欠落による停止**: Floci `AddPermission` の `SourceAccount` 欠落が、必須の設定gateを止めるため、Task 4〜11のE/Lの実機は、前提失敗のnot-runのままにする。offlineのU/I・code・docsは進める。Flociのpatchとhostの再buildは、承認範囲の外であり、ユーザーへ報告する。誤っていた場合は、Floci修正の後に、Task 4〜11の実機のrunが必要。状況: 解消。ユーザーが10-09にpatch 1（refresh.2）を承認し、gateが通るようになった。
23. **Task 5〜11の実機run停止**: 設定gateの失敗が既知の間は、Task 5〜11で実機のFloci・Terraformのrunを行わない。各回が、完全なapplyとdestroyを要し、入力の前にnot-runが確定するため。実装者は、E caseのcodeとoffline I/Uを書き、E/Lは前提失敗のnot-runとして記録する。誤っていた場合は、後で各suiteの実機のrunを実行することになり、盲目のcodeを実機で直す作業が生じうる。状況: 解消。次の項目で条件付きに解除し、実機のrunを完了した。
24. **新しいpin（refresh.2）とrootの編集**: 新しいpinは `floci-local:2.2.0-refresh.2-native`、healthは `2.2.0-local-refresh.2-native`。root repositoryの編集は、Flociのpatch、DockerfileのFLOCI_VERSION、composeのimage行、READMEの版の記述に限り、当時は、ユーザーの未commitの編集と混ぜないよう、commitしなかった。worktreeのpreflightのpinと、計画・設計・調査の定数は、別のreview済みtaskで更新する。理由は、`docker-compose.yml` とREADMEが、ユーザーの未commitの編集を持っていたため。誤っていた場合は、tag名の変更は元に戻せる（preflightは、版の不一致を、fallbackせず拒否する）。状況: 更新済み。pinは、その後refresh.7まで進み、rootの変更は、ローカルcommit（7件）にまとめられた（`init-firewall.sh` を除く）。
25. **実機のrun停止の条件付き解除**: Task 5〜11の実機run停止を、条件付きで解除する。次は、Floci refresh.2での実機のfixtureの run一回である。設定gateとsmokeが通れば、計画どおり各taskの実機suiteを実行する。実機で見つかったharnessの欠陥は、dispatchしたagentが直し、実機後の追補commitとしてreviewする。誤っていた場合は、実機の失敗を、さらなる再構築の前に診断する。状況: 解消。実機のsuiteを完了した。
26. **Flociの穴を一つずつ見つけない**: Flociの穴を、再構築のたびに一つずつ見つけるのをやめる。patch済みFloci（refresh.3）に対し、設定gateの読み戻し欄の全てを、source水準で一度監査し、残る不一致を全て列挙して、まとめたpatchをユーザーに提案する。誤っていた場合は、監査が一回余計に要るだけで、複数回の再構築を節約できる。状況: 解消。監査の結果、patch 3（refresh.4）につながった。
27. **unsupportedにできる範囲**: unsupportedにできるのは、計画が許す互換性調査の項目（Gateway v2の配信、Schedulerの起動、S3のTLS強制）だけである。alarmの欄は必須の設定であり、ユーザーの承認なしにunsupportedにできない。誤っていた場合は、記録した限界つきで、gateをもっと早く通せた。状況: 有効。最終のunsupported 3件も、互換性調査の項目（OBS-04、AUTH-11のhosted revoke、IMG-09）である。
28. **layer Iの結びつけ（storage・auth）**: layer Iのcase（storage・auth）が、liveの一覧でnot-runになることと、対応表の「見込→結果」の更新は、Task 12の担当である（計画: 対応表・既存記録への追補はTask 12）。誤っていた場合は、Task 12の指示書に結びつけのcodeを加える。最終reviewが確認する。状況: 置き換え済み。2026-10-12のユーザー判断で、layer Iはoffline試験の実測で判定するようになった。
29. **layer Iの結びつけ（action無しのcase）**: actionの無いlayer Iのcase（AUTH-05/07のI、STORE、IMG-08）は、Task 12でoffline証拠に結びつける。個々のtaskの阻害要因ではない。誤っていた場合はTask 12の範囲が広がる。状況: 置き換え済み。上と同じく、2026-10-12の判断で、実測の判定になった。
30. **hosted revokeの400を広げない**: 証拠なしに、400をunsupportedの根拠に広げない。routeが無いのか、存在して拒否しているのかは、Floci sourceの調査で決める。routeが無ければ、Flociのpatchがrouteを加えるか404を返す。それまでcaseは、httpStatus 400のfailとして正直に残す。誤っていた場合は、互換性調査の一件が、unsupportedではなくfailに見えるだけで、偽のpassは出ない。状況: 置き換え済み。次の項目に従った。
31. **hosted revokeの分類**: hosted revokeのprobeが400を返した場合は、S3のInvalidArgumentのerror署名を持つときだけunsupportedにする（固定のerror codeの照合をメモリ上で行い、保存しない）。他の400は全てfailのまま。理由は、sourceが、routeの不在と、無関係なcatch-allによる400を示したため。状況のみのルールでは、routeの不在が、拒否と誤分類される。誤っていた場合は、probeが一件を誤分類する。偽のpassは出ない。状況: 有効。実装済み。AUTH-11/hosted-revoke-endpointは、unsupportedとして測定された。
32. **Temurinのtag**: `eclipse-temurin:25.0.1_8-jdk` を、registryで確認せずに選んだ（Docker HubとAdoptiumが、firewallで遮られ、docker CLIも無い）。既知のTemurin 25のbuildである。誤っていた場合は、最初のrebuildがすぐ失敗し、tagを直す。状況: 解消。tagは有効で、JDK 25での回帰試験（300/300）が実行できた。
33. **完了の意味を変えない**: 当時は、layer Iがliveでnot-runのため、`complete` は偽のままとし、harnessの完了の意味を変えない。計画のStep 6は、E/L/Iのいずれかが未完了なら、未完了と報告するよう定める。完了の定義を変えることは、仕様の変更であり、controllerの判断ではない。誤っていた場合は、ユーザーが「Eのlive + Iのoffline」を基準として受け入れ、最終報告の書き方だけが変わる。状況: 置き換え済み。2026-10-12に、ユーザーがまさにその基準を決めた。
34. **`/tmp` のPATHの扱い**: 修正の途中では、計画とCLAUDE.mdにある `/tmp` のtool PATHを変えない。CLAUDE.mdはユーザーの指示であり、計画は承認済みの文書である。費用は、それらのfileに古いpathが残ること（ユーザーへ報告）。状況: 一部解消。[README](../../README.md)の現行の記述は、`.superpowers/tools/aws-sdd` に更新した。CLAUDE.mdと承認済みの計画の記述は、そのまま残る。
35. **所要時間の表示の食い違い**: 結果文書の「821秒」の表示と、時刻から測った818秒の食い違いは、そのまま残し、第二の修正の波を作らない。結果文書の本文が、両方の基準を書いている。費用は、読み手が、どちらが窓の長さかを取り違えうること（文書の問題のみ）。状況: 解消。現在の主たるrunでは、全体の時間（`npm test`）と、artifactの更新時刻の窓を、別々に書いている。
