# 復元データの検証と復旧

これらのコマンドは、別途復元した環境を検証する。PITRの実行、Cognito poolやuserの再作成、gateの暗黙のpublish、デプロイ済みのtable参照の変更、scheduleの有効化、Terraformのapplyは行わない。実装と試験には合成データとSDK transportを用いた。実際のPITRリハーサルやAWSの復旧操作は実施していない。

1. 別途承認されたデプロイ操作で、APIの書き込みと清掃のscheduleを停止する。復旧と最終検証の間は、停止したままにする。一貫した復旧時点を1つ選び、DynamoDBの**3つ全て**のtable（reminders、owner_state、image_jobs）を復元する。新しいtable名を3つ使う。名前は互いに異なり、どの稼働中table名とも異なるものとする。runtimeのkeyと、image_jobsの `cleanup_by_due` GSI（KEYS_ONLY）を、既存のsparseな清掃属性を含めて復元する。稼働中のtableと元のS3 versionは、変更せずに保持する。DynamoDB PITRの保持期間は35日である。画像のlifecycleは、noncurrent versionを60日保持する。参照されている古い画像versionは、そのlifecycleが削除できるようになる前に保全する。
2. [移行の設定](migration.md)と同じ形式で、非公開の設定JSONファイルを2つ作成する。`--source-config` には、現在実際にデプロイされているaccount、region、resource参照を入れなければならない。`--restored-config` には、隔離された未公開の復元tableと、元の本番画像bucketを指定しなければならない。両ファイルとも `accountId`、`region`、`remindersTable`、`ownerStateTable`、`imageJobsTable`、`imagesBucket`、`issuer`、`clientId`、`expectedApiId`、`expectedStage` と、任意の `sourceIps`/`limits` を含む。account、region、画像bucketは一致しなければならない。サポートする有効化では、既存のAPI ID/stageと現在のCognito issuer/client/domainを維持する。poolやbucketの復元・移行は、この切替の対象外である。scriptはSTS GetCallerIdentityを明示したaccountと比較し、resourceを名前で探索することはない。通常のSDK providerを通じて、短期の認証情報を使う。何かを実行する前に、復元table名が有効なデプロイ済み設定に含まれていないことを確認する。
3. Cognito consoleで、復旧対象とする全てのownerについて、**現在の**issuerと実際の `sub` を確認する。itemが0件のownerも含む。`--owner-identities` に非公開のJSON配列を保存する: `[{ "ownerId": "<SHA-256 owner ID>", "issuer": "<current issuer>", "sub": "<console-confirmed subject>" }]`。最終的に復元するownerを、過不足なく含める。`ownerId` は、UTF-8のJSON `[issuer, sub]` のruntime SHA-256である。usernameやemailによる検索、accountの作成、推測は行わない。復旧した古いownerに、再作成したuserの新しいsubjectを与えた場合、検証は不一致を報告する。再作成したusernameが、古いデータを自動的に取得することはできない。**DynamoDB PITRはCognitoのpasswordやsessionを復元しない**。全てのreportに `cognitoCredentialsRestored: false` が含まれる。
4. 小文字のUUIDを選び、非公開の入力とrun IDを正確に保持する。既定の検証は、復旧metadataとpublication gateを含めて読み取り専用である:

   ```sh
   npm run recovery:verify -- --source-config /private/live.json --restored-config /private/restored.json --owner-identities /private/current-owners.json --run-id <uuid>
   ```

   復元したowner_state tableには、古い `published: true` のgateが残っていることがある。既定の検証はこれを拒否する。対象が隔離されていることを確認した後、その復元gateだけを明示的にprepareする:

   ```sh
   npm run recovery:verify -- --source-config /private/live.json --restored-config /private/restored.json --owner-identities /private/current-owners.json --run-id <uuid> --prepare-restored
   ```

   prepareは、`GLOBAL/PUBLICATION` を条件付きで `{ published: false, runId }` に設定する。rowが存在しない場合に限り作成する。gateは、復旧の全ての書き込みと失敗を通じてfalseのままである。prepareのみの呼び出しでも、データの保全や明示的なownerの対応付けが必要な場合はexit 2になり得る。これは環境がpublishされたことを意味しない。
5. 検証は、復元した全item、ownerごとの正確な `STORAGE.itemCount`/`imageBytes` counter、全画像job、参照されている全てのpin留めされた画像を読む。削除済みrecordは、有効なitemとして数えない。空のownerには、0のcounterと、確認済みの現在のidentityが必要である。runtimeのrecord検証、jobのownership/key/version/MIME/bytes/SHA-256、清掃属性を持たないcommitted job、他のjob状態のsparseな清掃key、孤立したcommitted jobを検査する。元のbytesと、復元側の現在のS3 versionを検査する。sourceのobjectが正常でも、復元側の破損した現在のobjectを隠すことはできない。versionの欠落、checksumの失敗、counter、ownerの不一致、未完了のremap、不正なjob、読めないpage、予算の不足は、readinessを妨げる。異なるrun IDを要求しても、復元tableに既にある未完了のowner remapを隠すことはできない。診断には位置、固定のfield名、理由が含まれる。ID、URL、title、画像bytes、issuer/sub、認証情報は含まない。exit 0は `readyToSwitch: true` を意味する。exit 2は不一致または失敗を意味する。強整合性の読み取り（strong read）はページごとに行い、複数tableのsnapshotではない。管理用とアプリケーションの書き込みは無効のままにする。
6. 参照されているnoncurrentの画像を、明示的に保全する:

   ```sh
   npm run recovery:verify -- --source-config /private/live.json --restored-config /private/restored.json --owner-identities /private/current-owners.json --run-id <uuid> --preserve-images
   ```

   pin留めしたGETで、元のversion、MIME、長さ、checksum、bytesを検証する。復元側だけの永続的なpending jobと画像intentが、**Putの前に新しいUUIDと新しい `images/<ownerId>/<UUID>` keyを予約する**。元のbytesを、`IfNoneMatch: "*"` で、MIME/長さ/SHA-256を変えずにuploadする。pin留めしたGETと現在のHEADで結果を検証してから、条件付きの復元table transactionで、reminderの参照を変更し、新しいjobをcommitし、古い復元jobを完了させる。ID、timestamp、revision、field、owner counterはそのまま保たれる。元のS3 key/versionと稼働中のjobは、決して書き換えも削除もしない。移行の決定的な安定keyを、upload先として再利用することは決してない。保存されている過去の画像bytesは、現在の画像ごとの受け入れ上限がより小さくても、それとは関係なく保全する。

   Putの前後で中断した場合は、同じ入力とUUIDで再実行する。保存済みのintentが同じ新しいkeyを選ぶ。別の条件付きPutを検討する前に、HEADとpin留めしたGETで既存versionを元のbytesと比較する。不一致やdelete markerがあれば中止する。新しく選んだUUIDは、checksumが一致しても、既存のobjectを採用できない。完了済みの参照は、検証した上でskipする。失敗したrunは未公開のままである。別のupload keyを強制するために進捗を削除してはならない。
7. ownershipを変更する必要がある場合は、別の非公開の明示的な配列を与える: `[{ "oldIssuer": "<historical issuer>", "oldSub": "<historical subject>", "newIssuer": "<current issuer>", "newSub": "<current subject>" }]`:

   ```sh
   npm run recovery:verify -- --source-config /private/live.json --restored-config /private/restored.json --owner-identities /private/current-owners.json --run-id <uuid> --owner-map /private/explicit-map.json
   ```

   過去のissuer/subが正となるのは、そのhashが復元された古いownerを特定する場合に限る。poolを再作成した後は、今日のsource-configのissuerと異なることがある。新しいissuerは復元側の設定と一致しなければならず、consoleで確認したidentityファイルには、その新しいowner hashが含まれていなければならない。1つの古いownerを、1つの別個の未使用の新しいownerに対応付ける。targetの重複、統合、対応付けの循環、target側に既存のrecord/storage/job、quota違反は、対応付けた**どの**ownerの画像をcopyするよりも前に拒否する。targetの上限は、既定でownerごとに有効item 1000件、画像bytes 128 MiBである。明示した実効上限が、集計のpreflightを決める。

   ownerごとに、上限のあるitem単位のmanifestとcount/hashを永続化してから、reminder（tombstoneを含む）を新しいownerのpartitionへcopyする。参照されている画像は、同じ永続的なpipelineで、新しいtarget ownerのkeyを使う。新しいreminder、committedの画像job、targetの正確なcounterは、それぞれatomicにcommitする。古い復元recordを削除する前に、targetの全field、画像/job、record数、counterを再検証する。失敗後に清掃を再開するときも、その完全な検査を繰り返す。古い復元counterは削除のたびにatomicに減り、古い復元画像jobはdoneになる。0になった古いstorage rowは、完了後にのみ削除する。稼働中のrecordとsourceの画像versionは変わらない。remapは、publishもURLの変更もせず、Cognitoの認証情報にも触れない。`--preserve-images` は `--owner-map` と併用してよい。remapが先に実行され、最後の保全/検証のpassで結果のownerを検査する。
8. 下記の上限付きの切替を実施する。既定の検証とprepare/preserve/remapは、決してpublishしない。新たな検証の後に、prepare済みの復元gateをpublishするのは、明示的で独立した `--publish-restored` modeだけである。これはprepare、保全、ownerの対応付けと併用できない。
9. 非公開のrunメモ、receipt、元の復旧入力は、受け入れまで保持する。放棄した一時的な復元tableと、使われていない復旧用の画像copyの清掃は、参照されていないことを証明した後に、別途計画した操作でのみ行う。このCLIはresourceの清掃を一切行わない。復旧検証の一環として、保持しているsource versionや稼働中のtableを削除してはならない。

Terraform stateの復旧で戻るのは、インフラ管理のmetadataであり、アプリケーションデータではない。アプリケーションZIPのrollbackで変わるのはコードであり、DynamoDBのitemやS3 versionではない。PITR/データ復旧では、新しいtableと保全した画像versionを使う。新しい書き込みの後で以前のデータsnapshotへ戻すには、専用のreconciliation計画が必要である。これらの操作は別個のものであり、互いに代用してはならない。

## レビュー済みの同一account内の切替とrollback

これはoperator向けの手順である。これらのAWS操作は、実装中にはどれも実行していない。非公開のevidence packetを1つ保持する。内容は、復旧時点、元と復元の正確なidentity、consoleで確認したowner、新たな読み取り専用report、復旧UUID、tableのschema/保護の証明、既知のAPI/Cognito baseline、選択した不変のcommit、登録済みZIPのkey/version/checksum、saved planのreview/custody digestである。これをGitや公開ログに入れてはならない。

1. **全ての**アプリケーションの書き込みとtraffic、全ての管理/import/復旧のwriter、清掃を停止する。まず通常のレビュー済みアプリケーションreleaseで、`scheduler_enabled=false` と `allowed_source_ips=["<dedicated operator egress IP>"]` を設定する。その正確なallowlistを、切替のpreviewとapplyの間、維持する。通常のclientの全egressからのrequestが拒否されること、通常のclientがoperatorのegressを共有していないことを確認する。APIへのアクセスはoperatorだけに許可し、書き込みは一切行わない。実行中のAPI呼び出しをdrainし（timeout 10秒）、管理用/直接の清掃呼び出しを止め、grantを切り替える前に、queueにあるScheduler/Lambdaのretryがdrainするか期限切れになるのを待つ（どちらもevent ageの上限は3600秒。清掃のtimeoutは660秒）。Schedulerの無効化が実行中の処理を取り消すと仮定せず、queue/呼び出しが実際に止まったことを確認する。他のwriterは、全体を通じて停止したままにする。元のpublished gateだけでは、maintenanceの柵にならない。operator専用のegressと、確認済みのdrainを確立できない場合は、移行の前に中止する。maintenance/管理用のCLIやworkflowは、ここでは提供しない。
2. 手順1〜7でrestore/prepare/preserve/remapを行う。同じaccount/regionで、復元table名が3〜64文字のASCII英字/数字/underscore/dot/hyphenであり、全て互いに異なり、元の**全ての**table名と重ならないことを確認する。正確なstring key、KEYS_ONLYの `cleanup_by_due` index、PAY_PER_REQUEST、deletion protection、PITR35、owner-stateの `expiresAt` TTLを確認する。これらの保護は、選択の前に、別途承認された復元operatorが設定する。PITRは、全ての設定を引き継ぐとは限らない。元の管理対象tableと、元のbucket/versionは保持する。copyが最新になった後、新たな読み取り専用の検証がreadyToSwitch=trueを返さなければならない。
3. 正確な選択を非公開でレビューする（JSONは全rootで同じkeyを使う）:

   ```json
   {"restored_tables":{"reminders":"<reviewed-restored-reminders>","owner_state":"<reviewed-restored-owner-state>","image_jobs":"<reviewed-restored-image-jobs>"}}
   ```

   空の `{}` は元のtableを選ぶ。部分的なmap、元の名前のalias、重複、wildcard、任意のARNは拒否する。名前の制約により、IAM policyのサイズを有限に保つ。account/region/prefixと画像bucketは変わらない。通常のGitHub roleが、bootstrapのtrust、boundary、ceilingを変更してはならない。
4. サービスを停止した状態で、bootstrap operatorが最初に、この正確な `restored_tables` mapと変更のないrepository/OIDC/API入力で、**saved bootstrap plan**をレビューしてapplyする。runtimeのceilingが、選択した3つのtableとその正確な清掃indexだけを許可するようになったことを確認する。metadataのみのdelivery readは元と選択したARNの両方を対象とし、元のcontrol-plane管理grantは元のtableに限定されたままである。これにより、切替の間、runtimeから元のtableへのアクセスを意図的に外す。wildcard/data-planeのdelivery grant、role trustの変更、予期しないresourceは拒否する。rollbackに備えて、以前のbootstrap入力を保持する。
5. 同一のmapを `PLATFORM_INPUTS_JSON` に設定し、既知のCognito baselineを維持し、既存のplatformのpreview→review→applyの手順を使う。platformは復元tableを採用せずに読み取って検証し、元の管理対象でdeletion protectionのある3つのtableを全て保持し、runtimeのgrantを更新し、既存の名前/ARNのoutputを選択する。名前/ARNと `restored_tables` output、変更のない元のbucket/Cognitoのoutputをレビューする。復元の検証やapply後のidentity検査のどれかが失敗したら中止する。tableの選択を戻しても、元のresourceや復元resourceが破棄されることは決してない。
6. 同じmapを `APPLICATION_INPUTS_JSON` に明示的に設定する（driverは検証済みのplatform outputからもこれを導出し、不一致を拒否する）。正確な既知のAPI/Cognito baseline、`operator_api_seed=false`、`scheduler_enabled=false`、`published=false`、選択した登録済みZIP/versionで、新たにアプリケーションのpreviewを実行する。`inputs.json`、`platform-outputs.json`、**両方の**Lambda環境、`runtime_data` で3つのtable名を全てレビューする。元のbucket、region、`$default` stage、API/Cognito、artifactが変わっていないことを確認する。root/commit/input/artifact/binaryのcustodyと、独立に期待するreview digestを保持する。applyは、既存のreviewed-runの流れでのみ行う。driverは選択したoutputのidentityを検証し、不変versionのGetFunctionで実際の両Lambda環境とZIPのhashを検証する。publicationの前に、`/healthz=200`、`/readyz=503`、未認証のCRUDの拒否を必須とする。applyや検証の失敗は中止であり、決してrelease receiptではない。
7. 全てのwriter/trafficを遮断し清掃を無効にしたまま、既定の読み取り専用の復旧検証を再実行し、**同じ**prepare済みのrunと正確な入力で明示的にpublishする:

   ```sh
   npm run recovery:verify -- --source-config /private/live.json --restored-config /private/restored.json --owner-identities /private/current-owners.json --run-id <uuid> --publish-restored
   ```

   これは以前のreceiptを信用せずに検証を再度実行し、`GLOBAL/PUBLICATION={published:false,runId:<uuid>}` を要求し、上限付きの検証済みreceiptを保存し、gateをtrueに変更する際に、そのreceiptに紐づいた正確な復旧rootをatomicに検査する。成功とする前にgateを読み戻す。触れるのは、復元側のowner_stateのgate/receiptだけである。runの変更、中断したremap、古い/破損したinventory、gateの競合は、fail closedとなる。書き込み後の結果が不確かな場合は、再試行の前に、正確なgate/runを非公開で調べる。既にpublish済みのgateを、黙って採用することはない。operatorは同時書き込みを防がなければならない。強整合性の読み取りをページごとに行う検証は、table横断のsnapshotではない。
8. 復元側のgate/run、安定したURL、`/readyz=200` を確認してから、別途承認された合成のownership/CRUD/画像の検査を行う。通常のtrafficを再開するのは、これらの検査と検証済みのアプリケーションledgerが一致した後に限る。その際、以前にレビューした `allowed_source_ips` を、新たなアプリケーションのpreview/applyで戻す。このreleaseでは `published=true` を維持し、Schedulerは無効のままにする。Schedulerは最後に、同じ選択、正確なartifact、`published=true` で、別の通常のレビュー済みアプリケーションpreview/applyにより有効にする。一時的な呼び出し制御は、安全な場合に限り戻す。実際の稼働結果は別に記録する。ローカルのmockは受け入れではない。
9. 新しい書き込みの前であれば、rollbackはtrafficを遮断しSchedulerを無効にしたまま、必要に応じて選択した復元gateを条件付きでfalseにprepareし、まずbootstrapを `restored_tables={}` に戻し、次にplatformを `{}` に戻して元のoutput/grantを検証し、その後、保持した正確なbaseline/artifactでアプリケーションを `{}` にpreview/applyする。再開の前に、両環境と元のpublication状態を検証する。どちらのdatasetも、元の画像versionも削除してはならない。新しい書き込みが1件でもあった後は、明示的なreconciliation/データ損失の判断と、別の検証済みの復旧計画なしに、古いsnapshotへ切り替えてはならない。コードのみのrollbackでは、選択したデータは変わらない。

## ローカルのinterfaceと非公開の進捗

`publishRecovery(input, deps)`（明示的で、新たに検証したpublication）、`verifyRecovery(input, deps)`、`preserveRecoveryImages(input, deps)`、`remapRecoveryOwners(input, mapping, deps)` は、`matched`、位置のみの `missingImages`、`mismatchedOwners`、`countDiscrepancies`、`unresolvedJobs`、`readyToSwitch`、`cognitoCredentialsRestored: false` を持つ `RecoveryReport` を返す。`RecoveryInput` が与えるのは、source/復元側の `EnvironmentIdentity`、run UUID、確認済みのowner identityだけである。従来のJSONやmappingの再読み込みは必要ない。

`createRecoveryStore(client, config, input, imageServices, budget)` は、復元側のruntime設定、実効上限、明示した入力、読み取り専用のsource画像/復元画像/clock/UUIDのserviceを束ねる。`RecoveryStore` は、gate、prepareUnpublished、publishVerified(runId, report, budget)、listItems、listOwners、getJob、replaceImage、remapOwner、saveReportを維持する。対象を絞って追加したportは、`listJobs()`、`bindRun(input, mapping, budget)`、`stageImageReplacement(previous, targetOwnerId, runId, budget)`、読み取り専用の `hasIncompleteRemap(runId, budget)` である。`remapOwner(from, to, runId, budget)` は4引数のsignatureを維持する。runの状態をbindまたは書き込むのは、明示的な操作だけである。検証はrunを作成せず、saveReportも呼ばない。

全ての進捗は、runtimeのrecordとは別に、復元側のowner_state tableに置く。`GLOBAL/RECOVERY#<runId>` のrootには、`inputSha256 = SHA256(JSON.stringify({ contractVersion: 1, input, limits }))`、nullableな `mappingSha256 = SHA256(JSON.stringify(mapping))`、nullableで上限付きのreport receipt（reportのhashと、数値のcount/readinessのみ）を保存する。最初の明示的なmapは、先行するprepare/preserveの後にbindしてよい。その後に異なるmap、環境、identityファイル、上限、run identityを与えても、そのrunは再開できない。非公開のmapや位置の配列全体を、rootに保存することはない。

`GLOBAL/RECOVERY#<runId>#OWNER#<oldOwnerId>` には、入力hash、from/toのhash、`phase`（`preparing`、`copying`、`copied`、`done`）、有効な `itemCount`、`imageBytes`、総 `recordCount`、IDで並べた元のruntime recordのSHA-256を保存する。`GLOBAL/RECOVERY#<runId>#ITEM#<oldOwnerId>#<SHA256(JSON.stringify(id))>` には、検証済みの元のrecord 1件と入力hashを保存する。`GLOBAL/RECOVERY#<runId>#IMAGE#<hash>` には、元のrecord 1件、target ownerのhash、入力hash、不変のpending jobを保存する。そのkeyのhashは、JSON `[previous.ownerId, previous.id, previous.thumbnail, targetOwnerId]` を対象とする。完全な元のrecordが、以前の参照とitemのfieldを束縛する。pending jobが、新しいUUID/key/時刻と、正確な共有の清掃keyを束縛する。image_jobsのrowはruntimeが受け付けるfieldだけを使い、復旧専用の属性は持たない。counterには、runtimeの正確な `itemCount` と `imageBytes` の名前だけを使う。

rootとownerのmarkerはcount/hashを持ち、増え続ける配列を持つことは決してない。item/画像のintentは、それぞれruntime検証済みのrecordを1件ずつ持つ（URL/title/IDの上限が適用される）。そのため、単一の増え続けるDynamoDB rowも、集計のitem上限もなしに、集計の進捗は400 KiBを超え得る。合成試験では、既定の上限のitem 1000件で、集計の進捗が400 KiBを超える場合を実行し、個々のtransportの書き込みすべてに400 KiBの上限を強制する。移行のchain-v2のroot/chunkとRATEのrowはowner counterではなく、復旧の状態としてparseしない。復旧は、元の移行ファイルを必要とせず、移行の生のpointerを再解釈しない。
