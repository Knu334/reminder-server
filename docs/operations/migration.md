# 旧JSONの移行

移行は、分離された未公開のAWS環境に対して、運用者が明示的に行う操作である。通常のサーバー起動では、JSONを読むことも変換することもない。これらのコマンドは、アカウント操作を別途承認した後にだけ実行する。実装と試験は合成のSDK transportを使い、AWSの呼び出しは行わない。

1. Cognitoのコンソールで、対象とする各userを作成または確認する。設定したissuerと、userの実際の `sub` を記録する。UUIDでないsubjectも含む。削除して再作成したusernameは、別のsubjectを持つ。古いmappingを自動的に再利用してはならない。scriptはuserの作成も無効化もしない。
2. 移行元JSONと元のowner mappingの私有コピーを作る。原本は変更せずに保持する。コピー、mapping、対象の設定は、source controlと公開artifactの外に置く。mappingは `{ legacyKey, issuer, sub, ownerId? }` の配列である。移行元のown propertyのkeyは、すべて完全に一致しなければならない。特殊なkeyと空のownerにも対応する。複数の旧keyを1つのownerへmappingできるのは、合算したIDとquotaが有効な場合だけである。
3. 私有の対象JSONを用意し、`accountId`、`region`、`remindersTable`、`ownerStateTable`、`imageJobsTable`、`imagesBucket`、`issuer`、`clientId`、`expectedApiId`、`expectedStage` を明示する。任意の `sourceIps` と `limits` は、runtimeの設定と同じ名前を使う。limitsの既定値は、元のitemのJSON 1件あたり2 MiB（`createdAt` を含む）、元の画像1件あたり1 MiB、ownerあたり1000 item、ownerの画像の合計128 MiBである。これより大きい元の画像には、limitsの明示的な設定が必要である。移行は画像を変換も破棄もしない。最初の対象は、3つのtableすべてで空でなければならない。例外は、任意で置ける、完全に一致する未公開のPUBLICATION行だけである。取込から検証が終わるまで、APIの書込trafficと清掃のscheduleを無効にしておく。通常のSDK credential providerで、短期のAWS credentialを使う。credentialは決してcommitしない。
4. コピーに対してdry-runを実行する。このmodeはAWS clientを読み込まず、AWSの呼び出しも行わない。

   ```sh
   npm run migrate:json -- --mode dry-run --source /private/source-copy.json --mapping /private/owner-map.json --config /private/target.json
   ```

5. 小文字のUUIDを一度だけ選び、私有のrunメモに残す。妥当性を確認したコピーを、未公開の対象へ取り込む。

   ```sh
   npm run migrate:json -- --mode import --run-id <uuid> --source /private/source-copy.json --mapping /private/owner-map.json --config /private/target.json
   ```

   明示的なimport、verify、publishの各modeは、最初にSTS GetCallerIdentityのaccountを対象のaccountと比較する。resourceを名前で探索することはない。sourceとmappingのhashは、ファイルのbyte列そのもののSHA-256である。contract hashは、正規化した有効な対象設定の全体、admission設定、正規化した日付と元画像の規約、移行の画像ID・upload・publication・checkpointのalgorithmを対象とする。どちらかの入力の空白、mapping、対象のresource、account、issuer、limits、contractのいずれかを変えると、古いrunは再開できない。元のrunの入力を正確に復元するか、別の新しい空の環境を用意する。変更したデータを既存のrunに決して混ぜない。

6. 処理が失敗した場合は、対象を未公開のままにし、同じUUIDとコピーで同一のimportコマンドを再実行する。importは、identityとinventoryを確認した後、永続化された完了済みのprefixを復元し、その完了済みのowner・itemを飛ばす。item・画像の照合が必要なのは、永続的なcheckpointがない作業だけである。checkpointの保存に失敗したcommitは、続行する前に読み戻す。各itemは個別のtransactionを持つ。checkpointは、itemとownerが1つ完了するたびに保存する。ownerの `STORAGE` 行は正確な `itemCount` と `imageBytes` を持つ。空のownerにも、値が0の行がある。取り込んだreminderは、元のIDと正規化した `createdAt` を保持し、`updatedAt = createdAt`、`revision = 1` を設定し、固定した画像参照とともに `migrationRunId` を保存する。

   checkpointは `GLOBAL/MIGRATION#<uuid>` に保存する。rootの進捗manifestは `{ format: "chain-v2", sha256, completedOwners: { head, count }, completedItems: { head, count } }` である。検証が失敗した場合は、rootにidentityとexactMatchを残し、`mismatches: { format: "chain-v2", sha256, head, count }` を持つ。空の配列は `head: null, count: 0` である。SHA-256は、正規化した論理的な進捗objectまたはmismatch配列の全体を対象とする。配列の要素は、最大64要素の不変なchunkに入り、`GLOBAL/MIGRATION#<uuid>#CHUNK#<kind>#<chunkSha256>` をkeyとする。各chunkは、`migrationRunId`、`kind`、0始まりの `index`、`previousSha256`（nullになるのはindex 0のときだけ）、`chunkSha256`、`values` を持つ。chunkのchecksumは、UTF-8のJSON object `{ migrationRunId, kind, index, previousSha256, values }` をこの順序で並べたもののSHA-256である。valuesは、正規のschemaの順序にparseしたものを使う。kindは `completedOwners`、`completedItems`、`mismatches` である。

   増分のcheckpointは、封印済みの64要素のprefix chunkを再利用し、部分的な末尾だけを置き換える。追記によって、それ以前の封印済みchunkが重複することはない。新たに必要になったchunkは、すべて強い整合性で読み戻してから、条件付きのroot更新を行う。この更新は、直前のpointer、identity、importing phase、未公開のgateを確認する。部分的な書込でcheckpointが進むことはない。結果が不確定な場合は、同じchunk keyとpointerで照合する。`loadRun` は、現在のchain全体を強い読み取りで再構築し、run、kind、index、長さ、前のchunkへのlink、chunkごとのhash、論理全体のhashを確認する。欠落したchain、別のrunのchain、破損したchain、途切れたchainは、fail closedで失敗する。inventoryは、retryで残った、正規形で参照されていない同じrunのchunkも検証する。移行元のitem数の総上限や切り詰めはない。保持する移行metadataは、その環境とともに私有のままにする。物理的なalgorithmはcontract fingerprintに含まれる。以前の物理contractで作ったrunを、このrunと混ぜることはできない。

   画像IDは、JSONのtuple `["reminder-migration-image-v1", runId, ownerPosition, itemPosition]` のSHA-256から導く。先頭の128 bitに、UUID v5のbitとvariantのbitを設定する。そのため、どのretryでも同じUUIDと `images/<ownerId>/<imageId>` のkeyを使う。uploadの前に、runのtagを付けたpendingのjobを保存する。結果が不確定なuploadは、既存versionのHEAD/GETと、元のbyte列・checksumの完全な比較で解決する。`IfNoneMatch: "*"` は、余分なversionができないよう書込を保護する。既存のobjectが一致しない場合は中止する。無条件の上書きはしない。reminder、commitしたjob、ownerの合計はatomicに更新する。そのため、commit後のtimeoutは、強い読み戻しによって、二重に数えることなく照合する。
7. すべてのデータを検証する。

   ```sh
   npm run migrate:json -- --mode verify --run-id <uuid> --source /private/source-copy.json --mapping /private/owner-map.json --config /private/target.json
   ```

   検証は、強い読み取りでtableの全ページを走査し、runtimeのrecordの形を確かめ、owner・itemのすべてのfieldと合計を確認し、固定した元画像をそれぞれ読む。完了済みのimport作業も対象である。この全件の走査を実行できるだけの呼び出し予算がなければならない。importが再開可能であっても、検証が部分的な確認になるわけではない。データの欠落・余分、別のrun、不正なjob、画像のmetadata・byte列・checksumの相違、読めないページがあると、合格できない。identityに結び付いた既存の未公開runに対しては、importは、失敗しうるinventoryの読み取りの前に、以前の検証成功を取り消す。別のidentityのrunと公開済みのrunは、この変更の前に拒否する。検証も同様に、失敗しうる読み取りの前に成功を取り消す。診断には、数値の位置、field名、固定の理由を含める。移行元のkey、title、URL、画像のbyte列、credentialは決して含めない。不一致や基盤の障害があると、0以外で終了し、publicationはfalseのままである。
8. 意図した対象と検証の結果を確認した後にだけ、公開する。

   ```sh
   npm run migrate:json -- --mode publish --run-id <uuid> --source /private/source-copy.json --mapping /private/owner-map.json --config /private/target.json
   ```

   publishは、同じ入力で全件の検証を繰り返し、その結果を記録する。その後、条件付きtransactionで唯一の `GLOBAL/PUBLICATION` 行をtrueにし、runを公開済みにする。transactionは、同じrunのidentityと、永続化された成功の検証結果と完全に一致することを要求する。scheduleの有効化もデプロイも行わない。公開の応答が不確定な場合は、gateとrunの正確な状態を確認する。公開済みと確認されたrunは、importとverifyの再実行を拒否する。そのgateを戻して再取込してはならない。
9. 清掃のscheduleやAPIの書込trafficを有効にする前に、次を確認する。想定したrunでpublicationがtrueであること、空のownerと空でないownerのquotaが一致すること、画像のversionが読めること、対象が意図した環境であること。別に管理する基盤で、PITRの保持期間が35日であり、非現行の画像versionが60日保持されることを確認する。scheduleは、別途承認されたデプロイ操作を通じてだけ有効にする。

## 空で始める場合

移行するデータが無い場合も、公開は同じ `migrate:json` の import → verify → publish で行う。DynamoDBの `GLOBAL/PUBLICATION` を手で書き換えてはならない。空の入力では、ownerの行もitemも画像も作らず、runのcheckpointとPUBLICATION行だけを書く。進捗の配列は `head: null, count: 0` になり、chunkは作らない。この流れは、合成のtransportと本番のadapterで `empty_source_and_mapping_import_verify_and_publish_through_cli_and_adapters`（`tests/operations/migration.test.ts`）が確かめている。実AWSでの受け入れは、別途この手順の実行で確かめる。

1. 手順1のとおり、Cognitoのコンソールで、loginに使うuserを作る。mappingには入れないので、`sub` の記録は移行には要らない。
2. 私有の場所に、内容が正確に `{}` の移行元と、内容が正確に `[]` のmappingを作る。hashはbyte列そのものを対象とするので、改行の有無も含めて、run が終わるまで変えない。例: `printf '{}' > /private/source-empty.json`、`printf '[]' > /private/owner-map-empty.json`。
3. 手順3のとおり、私有の対象JSONを用意する。3つのtableが空であることと、APIの書込trafficと清掃のscheduleが無効であることも、同じく必要である。
4. dry-runを実行し、`"valid":true,"owners":0,"items":0` と `"errors":[]` を確かめる。

   ```sh
   npm run migrate:json -- --mode dry-run --source /private/source-empty.json --mapping /private/owner-map-empty.json --config /private/target.json
   ```

5. 小文字のUUIDを一度だけ選び、手順5〜8と同じ引数で import、verify、publish を順に実行する。期待する出力は、import が `{"mode":"import","owners":0,"items":0,"imageBytes":0,"completed":true}`、verify と publish が `"exactMatch":true,"mismatches":[]` である。

   ```sh
   npm run migrate:json -- --mode import --run-id <uuid> --source /private/source-empty.json --mapping /private/owner-map-empty.json --config /private/target.json
   npm run migrate:json -- --mode verify --run-id <uuid> --source /private/source-empty.json --mapping /private/owner-map-empty.json --config /private/target.json
   npm run migrate:json -- --mode publish --run-id <uuid> --source /private/source-empty.json --mapping /private/owner-map-empty.json --config /private/target.json
   ```

6. 手順9のうち、想定したrunでpublicationがtrueであることと、対象が意図した環境であることを確かめる。ownerと画像は無いので、quotaと画像versionの確認は対象外である。PITRと非現行versionの保持期間の確認は省かない。
7. 公開済みのrunは、importとverifyの再実行を拒否する（終了コード2）。後から旧JSONを取り込むことはできない。取り込む場合は、別の新しい空の環境を用意する。

旧JSONのサービスへ切り戻せるのは、新サービスで書込が始まる前だけである。新しい書込が始まると、旧JSONは古くなる。旧JSONへ戻るには、別途計画した照合・復旧の操作が必要である。復旧のため、元の移行元とmappingは私有のまま保持する。検証の間は、移行adapter以外からの管理用の書込を無効にしておかなければならない。強い読み取りのtable走査はページ分割した読み取りであり、複数tableのsnapshotではないためである。
