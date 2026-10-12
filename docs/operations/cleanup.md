# 本番の画像清掃

以下は、将来の運用者向けの手順である。ローカルの試験は合成のtransportを使った。Scheduler、Lambdaの呼び出し、S3の削除、本番データの変更は、いずれも発生していない。scheduleと、その範囲を限定した呼び出しpolicy、alarmは、application rootが管理する。

## 日次のscheduleと手動実行

Schedulerの対象は、清掃の**production alias**だけである。`cron(0 3 * * ? *)` で、毎日03:00 UTCに実行し、flexible windowはOFFである。初期状態はDISABLEDである。公開は移行の検証の後にだけ行い、その後、レビュー済みのapplicationのデプロイで有効にする。scheduleを無効にしても、受け付け済みのeventや実行中の呼び出しは取り消されない。実際に手動で作業する前に、正確なaccount、region、functionのalias、データのpublication gate、承認済みのrelease version、運用者の呼び出し権限を確認する。運用者の短期credentialを、通常の私有のprovider chainで使う。secret、payload、出力、環境変数の一覧は、Gitにも公開artifactにも入れない。

明示的に承認された手動の呼び出しでは、AWS CLI v2で、私有の出力ファイルを使い、production aliasに対して同期のRequestResponseで呼び出せる。

```sh
AWS_MAX_ATTEMPTS=1 aws lambda invoke \
  --region <explicit-region> \
  --function-name <cleanup-function-name> --qualifier production \
  --invocation-type RequestResponse --cli-binary-format raw-in-base64-out \
  --cli-read-timeout 700 \
  --payload '{}' /private/cleanup-result.json
```

この例は文書としてのものであり、実行していない。`AWS_MAX_ATTEMPTS=1` は、CLIのtransportの自動retryを無効にする。RequestResponseには、Lambdaの非同期retryの動作がない。呼び出しのmetadataとFunctionError、私有の結果を確認する。HTTPやCLIが成功しただけでは、清掃が完了したことにはならない。timeoutや切断では、結果が不明な場合がある。運用者が明示的にretryする前に、安全なログ・metricと、永続化されたjobの状態を確認する。やみくもに呼び出しを繰り返してはならない。保守用のworkflowや汎用の管理CLIは用意していない。

[公式のLambda invokeリファレンス](https://docs.aws.amazon.com/cli/latest/reference/lambda/invoke.html)と[CLIのretry設定](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-retries.html)は、2026-10-05にContext7で確認した。本番では、clientのtimeoutを、最大660秒になりうるLambdaの呼び出しに足りる長さにする。ローカルで早く起きたtimeoutを、serverの失敗と断定しない。

## 配信、呼び出し、処理のretry

Schedulerの配信のretryは**2回**、eventの最大経過時間は**3600秒**である。清掃のaliasのLambda非同期呼び出しのretryは、これとは別に**2回**、eventの最大経過時間は**3600秒**である。これらの上限は異なる段階を制御するものであり、exactly-onceの保証ではない。受け付けたeventが2回以上実行されることがある。手動のRequestResponseは、どちらの非同期retryのqueueも使わない。上の例では、transportのretryも明示的に無効にしている。

1回の実行の中では、AWS SDKのclientはtransportを1回だけ試みる。domain serviceは、予算が残っている間、有界な読み取り・claim・complete・deleteの照合を最大3回まで試みる。Queryの評価は、そのScannedCountの結果が不明な場合にはretryしない。配信のretryとこれらの処理の試行を、runのメモや費用の計算で混同してはならない。

## 予算、残りの作業、永続化された状態

清掃は512 MiB、timeout 660秒、reserved concurrency 1である。処理は、600秒の経過または残り60秒、GSIで評価したrecord 10,000件、削除の試行5,000回のいずれかで止まる。止まるときは、実行中のtransportを待ってからcheckpointを保存する。最大4つの候補workerが、これらの上限を共有する。`incomplete:true` が返ったときは、作業が残っていることを意味し、それだけではtransportの失敗ではない。依存先の失敗、checkpointやmetricのerrorでは、呼び出しが失敗する。retryするかどうかは、実際の結果と永続化された状態で決める。heartbeatが欠けた場合は調査が必要である。

疎な `cleanup_by_due` GSIは、pending、retired、deletingのjobだけを含み、それぞれ4 shardである。pendingとretiredは24時間後に対象になる。deletingのleaseは20分である。committedとdoneは、indexの両方のfieldを削除する。base itemの強い読み取りと条件付きのleaseで、古くなった結果整合のGSIの項目を照合する。round-robinのページcursorは永続化される。cursorが進むのは、候補のページを最後まで処理した後だけである。再開時には、放棄されたdeletingのleaseが対象になり、完了済みの作業は飛ばされ、途中のページは安全に再訪される。進捗を強制するために、leaseやcheckpointを削除してはならない。現在のHEAD・version・checksumが一致しない場合は、objectを保持し、削除済みとして完了させない。未処理のjobは非公開で調査する。

清掃は、対象となる現行のkeyにS3のdelete markerを作る。固定されたobject version、commit済みの参照、table全体は削除**しない**。非現行versionの60日のlifecycleは、35日のPITRの復旧期間の間、versionを保持する。PITRの後は、最終的に期限切れになる前に、[復旧の検証](recovery.md)で、まだ参照されているversionを新しい現行objectとして保全する。codeのrollback、Schedulerの無効化、APIのpublicationの変更では、データは復元も解放もされない。

## 監視

CloudWatchのalarm 9個を設定でデプロイする。SNSやDLQ、alarmの通知先はない。運用者のaccountで、consoleとmetricを確認する。通知の配信は、liveでは試験していない。

| Alarm key | Signal |
| --- | --- |
| gateway_5xx | HTTP API 5xx |
| api_errors | API Lambda Errors |
| api_throttles | API Lambda Throttles |
| api_duration | API Lambda p95 Duration > 2000 ms for two periods |
| cleanup_errors | cleanup Lambda Errors |
| cleanup_async_dropped | cleanup AsyncEventsDropped |
| cleanup_incomplete | custom CleanupIncomplete, hourly Maximum >= 1 |
| scheduler_dropped | Scheduler InvocationDroppedCount by schedule group |
| cleanup_heartbeat | custom CleanupHeartbeat, daily Sum < 1 |

2つのcustom metricは、namespace ReminderServerとEnvironment=productionを使う。heartbeatは、処理の失敗がなく、checkpointを保存した後に送る。公開前は、Schedulerが無効で、heartbeatのactionも無効であり、missing dataはnotBreachingである。レビュー済みのschedulerの有効化で、heartbeatのmissing dataをbreachingにする変更と、actionを有効にする変更を同時に行う。他のalarmの評価は続く。未公開の清掃は作業を飛ばす。これを、heartbeatが成功したことと見なさない。ログに含むのはrequest、operation、件数、status、所要時間だけであり、私有のID、title、画像、tokenは含まない。

## 2026-10-10 ローカル実測に基づくログの読み方（追記）

以下はローカルのFloci（refresh.6）で実測した内容であり、実AWSでの清掃の実績ではない。本番操作の手順は上の各節に従い、ここでは混同しない。実行手順と結果は[正式E2E手順](formal-e2e-README.md)、[結果](formal-e2e-results.md)にある。

- 1回の同期invokeは、同じlog streamに2種類のログを出す。開始ログは `operation: cleanup_start` と、Lambdaの `lambdaRequestId` を持つ。終了ログは `operation: cleanup` と、サービスが付けた `requestId`（run ID）、`evaluated`、`deletes`、`incomplete`、`durationMs` を持つ。2つのIDは別の値で、同じとは扱わない。同一stream・同一観測区間の開始と終了を1組とする。
- 未公開（gateがfalse）の場合は、開始ログと `skippedUnpublished: true`、`evaluated 0`、`deletes 0` の応答になり、保存は変わらない。終了ログとheartbeatは期待しない。
- 公開後は、開始と終了の組と件数が、実際のjobのdone、delete marker、checkpointと一致する。例として、1回目が `evaluated 1 / deletes 1`、同じ入力の2回目が `deletes 0` だった。
- 不正なeventはFunctionErrorで終わり、開始ログの前に拒否される。保存は変わらない。
- 観測は、最後の入力から60.5秒までの観測窓と、その後の有界な完了pollで行う。最悪で約120.5秒かかる。不在の確認は、前後に正常な対照ログがあり、走査が最後まで終わったときだけ成立する。途中で打ち切られた走査は失敗として扱う。
- heartbeatの送信はCloudWatchで読んでいない。未公開でheartbeatが出ないことの根拠は、`tests/runtime/cleanup.test.ts` と `tests/integration/formal-e2e/cleanup-resume.test.ts` のoffline試験である。
