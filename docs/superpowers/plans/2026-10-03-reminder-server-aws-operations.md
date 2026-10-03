# Reminder Server AWS Operations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** JSON原本を保全し、全件検査・照合後にだけ公開できる初回移行と、画像を保全する復旧照合を実装する。

**Architecture:** runtimeの入力検証・owner hash・画像portsを共有し、スクリプト入力と公開状態の制御だけを別モジュールに置く。初回移行は新規の未公開環境にrun IDで取り込み、強い読み取りとS3元bytes照合で公開を許可する。復旧は新しいテーブルを対象に、所有者と画像versionの対応を検査してから切替用の報告を生成する。

**Tech Stack:** TypeScript/CommonJS、Node24、tsx、AWS SDK v3、node:test/node:assert。

**Spec:** [承認済みAWS設計](../specs/2026-10-02-reminder-server-aws-design.md) §8・§9・§13〜§15、[全体計画](2026-10-03-reminder-server-aws.md)、[runtime計画](2026-10-03-reminder-server-aws-runtime.md) R01〜R06。

## Global Constraints

- `.devcontainer`を変更しない。追跡された実`reminders.json`/`.env.actions`は読まない。試験は公開可能な合成fixtureのみ。
- 原本を変更・移動・削除しない。通常起動でJSONを変換しない。元画像bytesを変換せず、ID/createdAtを維持、updatedAt=createdAt、revision=1。
- 公開状態falseの新規空環境だけを初回移行先にする。途中失敗は未公開のまま保持し、全件照合後だけ公開する。
- 本文/画像/所有者の既定上限は2 MiB/1 MiB/1000件/128 MiB。既存画像超過は変換・黙った切捨てをせず中止する。
- 所有者はissuer/subのSHA-256で決定する。Cognitoユーザーはコンソール管理、スクリプトからユーザーを作成・無効化しない。
- PITR35日、画像非現行version60日。復旧で参照する旧versionを新しい固有キーの現行versionへ元bytesのまま保全する。
- 汎用管理CLI・トークンCLI・清掃CLIを作らない。AWS実行と公開gate切替はこの計画の実装時に行わない。
- 位置/field名/理由で報告し、旧key/URL/title/画像/認証値をログ・公開artifactに出さない。

## Review Focus

1. 空の所有者、`__proto__`/`constructor`をown propertyとして安全に検査し、別の所有者へまとめない（O01/O02）。
2. 原本・mapping・対象環境のhashが再開時に変われば、旧runへ混ぜず中止する（O01/O02）。
3. 移行バッチの反映後timeoutでも二重登録せず、画像checksumが違う状態を公開しない（O02）。
4. 削除後に同名で再作成されたCognitoユーザーへ、旧データを自動的に紐付けない（O03）。
5. 復旧先が非現行S3 versionを参照しているとき、Lifecycle前に元bytesを保全し、稼働テーブルを変えない（O03）。

---

## ファイル境界と入力契約

`scripts/operations/legacy.ts`は検査だけ、`migration-store.ts`はrun/gateとrun付きレコードのAWS操作、`migration.ts`は取込・照合・公開手順、`recovery.ts`は復旧照合。`migrate-json.ts`/`verify-recovery.ts`は引数解析と入出力だけを担当する。

mappingは公開しないJSON配列`[{ legacyKey, issuer, sub, ownerId? }]`。legacyKeyは元JSONのown propertyと厳密一致し、対応漏れ/余分/重複はエラー。同じownerへ複数legacyKeyをまとめる場合も、ID重複と合計quotaを検証する。issuerは対象設定と一致、subは空でないCognitoの値でありUUID限定にしない。ownerIdを指定した場合はruntime R02のhashと一致させる。

`EnvironmentIdentity = { accountId: string; region: string; remindersTable: string; ownerStateTable: string; imageJobsTable: string; imagesBucket: string; issuer: string }`、`MigrationIdentity = { runId: string; sourceSha256: string; mappingSha256: string; contractSha256: string; environment: EnvironmentIdentity; contractVersion: 1 }`を`legacy.ts`で定義する。source/mappingのhashは読み取ったbytesから、contractSha256は実際の上限設定・日時/画像契約のcanonical JSONから計算し、再開時に同一を要求する。短期AWS認証のアカウントはSTSのGetCallerIdentityで明示入力と照合する。アカウントのリソースを探索して名前だけで選ばない。

### Task O01: 旧JSONと所有者mappingの全件事前検査・dry-run

**Files:** Create `scripts/operations/legacy.ts`, `scripts/operations/migrate-json.ts`, `tests/operations/legacy.test.ts`, `tests/fixtures/synthetic/legacy-valid.json`, `tests/fixtures/synthetic/owner-map.json`, `tests/fixtures/synthetic/target.json`; Modify `package.json`。

**Interfaces:** Consumes runtime R01 validation、R02 ownerIdFor。Produces `validateLegacy(source: string, mapping: unknown, config: Config): LegacyValidation`、`readMigrationInputs(sourcePath: string, mappingPath: string): Promise<MigrationInputs>`、`migrationMain(argv: string[], io: OperationIO): Promise<number>`。`LegacyValidation = { owners: Array<{ownerId: OwnerId; items: ActiveReminder[]; images: Map<string, DecodedImage>}>; errors: Array<{location: string; field: string; code: string}> }`。MigrationInputsはsource/mapping bytesとそのSHA-256、OperationIOはstdout/stderrの安全な報告sink。内部のLegacyValidationは画像・項目を保持するがJSONログへserializeしない。

- [ ] **Step 1: RED試験を書く。** `legacy_validates_all_errors_before_writes`、`own_properties_and_empty_owners_are_preserved`、`owner_mapping_must_match_issuer_sub`、`normalizes_instants_without_changing_original_file`。

  ```ts
  const source = '{"__proto__":[],"constructor":[]}';
  const report = validateLegacy(source, syntheticSpecialKeyMap, config);
  assert.equal(report.errors.length, 0); assert.equal(report.owners.length, 2);
  assert.equal(report.owners[0]?.items.length, 0);
  assert.equal(normalized.reminderTime, '2026-10-03T00:00:00.000Z');
  assert.equal(normalized.updatedAt, normalized.createdAt); assert.equal(normalized.revision, 1);
  ```

  syntheticSpecialKeyMap/config/normalizedは各test内でfixtureとvalidation結果から作る。壊れたJSON、配列ではない所有者値、missing/unknown field、owner内とmapping後のID重複、日時offset欠落・不正暦日、BASE64/MIME/画像quota違反の全位置を集計する。影響する所有者を黙って捨てない。原本hashを前後でassertし、error outputにold key/URL/title/base64がないことをcanaryで検査する。検査順のlocationは`owners[0].items[2]`のような数値位置にし、旧keyをpathへ含めない。
- [ ] **Step 2: Run `npx tsx --test tests/operations/legacy.test.ts` → FAIL。** 検査関数の欠落による失敗を確認する。
- [ ] **Step 3: 検査関数とdry-run entryを実装する。** Object.entries/own propertyとMapを使用し、prototype参照をしない。createdAtは移行専用schemaで許可し同一瞬間へUTC正規化する。旧keyを認証値に変換しない。`npm run migrate:json -- --mode dry-run --source <copy> --mapping <private-map> --config <private-target>`を追加し、dry-runではAWSclientを作らず全件検査の件数/bytes/位置別エラーだけを出力する。private-targetはConfig+accountId、公開テンプレートに実値を置かない。上限overrideは明示したprivate-targetだけから取り、runのcontract設定へ固定する。
- [ ] **Step 4: Run `npx tsx --test tests/operations/legacy.test.ts`、`npm run migrate:json -- --mode dry-run --source tests/fixtures/synthetic/legacy-valid.json --mapping tests/fixtures/synthetic/owner-map.json --config tests/fixtures/synthetic/target.json` → PASS/exit0。** `target.json`は同タスクで作る合成設定。不正fixtureはexit2かつAWS call0、全エラー報告となることを確認する。
- [ ] **Step 5: `git add scripts/operations/legacy.ts scripts/operations/migrate-json.ts tests/operations/legacy.test.ts tests/fixtures/synthetic package.json` → `git commit -m "feat: validate legacy JSON and explicit owner mappings"`。**

### Task O02: run IDでの移行再開・強い照合・公開gate

**Files:** Create `scripts/operations/migration-store.ts`, `scripts/operations/migration.ts`, `tests/operations/migration.test.ts`, `tests/support/migration-store.ts`, `docs/operations/migration.md`; Modify `scripts/operations/migrate-json.ts`, `scripts/operations/legacy.ts`。

**Interfaces:** Consumes O01 MigrationIdentity/LegacyValidation、runtime RemindersStore/JobsStore/ImagesStore。Produces `prepareMigration(identity: MigrationIdentity, deps: MigrationDeps): Promise<void>`、`importMigration(identity: MigrationIdentity, input: LegacyValidation, deps: MigrationDeps): Promise<MigrationSummary>`、`verifyMigration(identity: MigrationIdentity, input: LegacyValidation, deps: MigrationDeps): Promise<MigrationVerification>`、`publishMigration(identity: MigrationIdentity, verification: MigrationVerification, deps: MigrationDeps): Promise<void>`。MigrationDepsはruntime ports、運用用MigrationStore、budget/clock/uuid。MigrationStoreは`assertEmptyOrSameRun(identity): Promise<void>`、`loadRun(runId): Promise<MigrationRun|null>`、`saveProgress(runId, progress): Promise<void>`、`putImported(owner, item, imageJob, identity): Promise<void>`、`recordVerification(runId, result): Promise<void>`、`publishIfVerified(identity): Promise<void>`、`listRunItems(runId): AsyncIterable<StoredReminder>`。MigrationSummaryはowners/items/imageBytes/completedの数値・真偽、MigrationVerificationはidentityとexactMatch:boolean、mismatches位置配列。migrationRunIdで全取込を追跡し、progress/verificationはGLOBAL/MIGRATION#runIdへ保存する。

`MigrationProgress = { completedOwners: number[]; completedItems: Array<{ownerPosition: number; itemPosition: number; imageId: string | null}> }`、`MigrationRun = { identity: MigrationIdentity; phase: 'importing' | 'verified' | 'published'; progress: MigrationProgress; verification: MigrationVerification | null }`をmigration.tsに定義する。MigrationStoreのidentityはMigrationIdentity、runIdはstring、progressはMigrationProgress、resultはMigrationVerification、ownerはOwnerId、itemはActiveReminder、imageJobはImageJob|null。画像jobを先にrun付きで記録し、Put結果不明でも同じimageId/keyから再開する。移行専用transactionは一般serviceのpublished gateとserver-createdAtを流用せず、未公開のrun条件と検証済みcreatedAtを使用する。

- [ ] **Step 1: RED試験を書く。** `partial_import_never_publishes`、`after_commit_timeout_resumes_without_double_count`、`changed_source_mapping_or_target_aborts`、`all_item_fields_and_original_images_required_to_publish`、`empty_owner_is_imported`。

  ```ts
  assert.equal((await fake.owners.gate(testBudget())).published, false);
  assert.equal(restartedSummary.items, expectedItemCount);
  assert.equal(fake.ownerCount('owner-a'), expectedItemCount);
  assert.equal(verification.exactMatch, false); // checksumを1byte変えた合成S3
  await assert.rejects(() => publishMigration(identity, verification, deps));
  ```

  stateful migration fakeは失敗前/後の書き込み結果、空環境/別run/公開済み環境、page途中再開、各hash/target変更を制御する。1batch途中で止めたAPI503、画像bytes/sha/所有者quota不一致で公開不可、全所有者のID/属性/日時/createdAt/revision/画像完全一致後だけgate=trueをassertする。再開時、S3 Put結果不明は同じjob/keyをHEAD/GET照合してから続行し、無条件に同じkeyへ新versionを追加しない。
- [ ] **Step 2: Run `npx tsx --test tests/operations/migration.test.ts` → FAIL。** 不明結果・公開拒否の試験を赤で確認する。
- [ ] **Step 3: 移行store・batch処理・全件照合を実装する。** 完全なO01検査が成功した後だけprepareする。空判定は移行専用の全表ページングを用い、公開状態/別runデータを拒否する（通常API/清掃のScan禁止とは別）。checkpointはbatch完了後、run付き条件で保存。全ファイルを1transactionへ詰めず1項目の画像job・reminder・owner状態を条件付きtransactionへまとめる。空ownerのSTORAGE=0も作る。画像をS3へ入れ、元bytes/checksumを読み戻して全件照合する。反映後timeoutは強いread/run IDで照合する。verify完了記録とidentity一致条件を持つ単一PUBLICATION更新だけで公開する。
- [ ] **Step 4: 個別実行モードと再開手順を追加する。** `migrate:json -- --mode import|verify|publish --run-id <uuid> ...`は明示した同じ入力を要求し、publishは最新の全件verify成功をDBへ記録してから条件付き公開する。`docs/operations/migration.md`にコンソールでのCognito追加、コピー作成、dry-run、未公開取込、再開、照合、公開、schedule有効化前の確認、書込開始前だけ旧JSONへ切戻可能を記載する。
- [ ] **Step 5: 検証する。** Run `npx tsx --test tests/operations/migration.test.ts tests/operations/legacy.test.ts`、`npm run typecheck` → PASS。実AWSや実原本でコマンドを実行しない。
- [ ] **Step 6: `git add scripts/operations tests/operations/migration.test.ts tests/support/migration-store.ts docs/operations/migration.md` → `git commit -m "feat: add resumable verified migration with publication gate"`。**

### Task O03: PITR後の照合・非現行画像の保全と所有者再対応

**Files:** Create `scripts/operations/recovery.ts`, `scripts/operations/verify-recovery.ts`, `tests/operations/recovery.test.ts`, `docs/operations/recovery.md`; Modify `package.json`。

**Interfaces:** Consumes runtime types/owner hash/S3 ports、O01 EnvironmentIdentity。Produces `verifyRecovery(input: RecoveryInput, deps: RecoveryDeps): Promise<RecoveryReport>`、`preserveRecoveryImages(input: RecoveryInput, deps: RecoveryDeps): Promise<RecoveryReport>`、`remapRecoveryOwners(input: RecoveryInput, mapping: RecoveryOwnerMap[], deps: RecoveryDeps): Promise<RecoveryReport>`。RecoveryInputは`{source: EnvironmentIdentity; restored: EnvironmentIdentity; runId: string; ownerIdentities: Array<{ownerId: OwnerId; issuer: string; sub: string}>}`、両環境はtable名が異なり復旧先未公開。ownerIdentitiesはCognitoコンソールで確認した現在のissuer/subと復旧対象ownerIdの非公開ファイルで、省略・名前からの推測をしない。RecoveryOwnerMapは`{oldIssuer: string; oldSub: string; newIssuer: string; newSub: string}`。RecoveryDepsは復旧先の項目/job/owner照合・条件付きwriteとsource版S3 read/new-key put。RecoveryReportはmatched/missingImages/mismatchedOwners/countDiscrepancies/unresolvedJobs/readyToSwitchを持ち、位置以外の個人データを出さない。

RecoveryDepsは`{restored: RecoveryStore; sourceImages: ImagesStore; restoredImages: ImagesStore; budget: Budget; clock: () => number; uuid: () => string}`。RecoveryStoreは`gate(budget): Promise<PublicationGate>`、`prepareUnpublished(runId: string, budget): Promise<void>`、`listItems(): AsyncIterable<StoredReminder>`、`listOwners(): AsyncIterable<{ownerId: OwnerId; itemCount: number; imageBytes: number}>`、`getJob(jobId: string, budget): Promise<ImageJob|null>`、`replaceImage(previous: ActiveReminder, next: ActiveReminder, job: ImageJob, runId: string, budget): Promise<void>`、`remapOwner(from: OwnerId, to: OwnerId, runId: string, budget): Promise<void>`、`saveReport(runId: string, report: RecoveryReport, budget): Promise<void>`。引数budgetはBudget。prepareUnpublishedは明示した復旧先だけの公開gateをfalseにする個別操作で、default verifyでは呼ばない。復旧したowner_stateが旧published=trueを持つ場合は`--prepare-restored`を明示して未公開化する。source/restoredが同じ、または稼働設定で参照中のtargetなら拒否する。

- [ ] **Step 1: RED試験を書く。** `same_username_new_sub_never_auto_maps`、`copies_noncurrent_bytes_to_unique_current_key`、`recovery_never_updates_live_tables`、`missing_version_or_bad_checksum_blocks_switch`、`explicit_remap_checks_target_collisions_and_counters`。

  ```ts
  assert.notEqual(ownerIdFor(issuer, 'old-sub'), ownerIdFor(issuer, 'new-sub'));
  assert.equal(report.readyToSwitch, false); // 対応不一致またはmissing version
  assert.deepEqual(copiedBytes, originalVersionBytes);
  assert.notEqual(restoredRef.key, originalRef.key);
  assert.deepEqual(liveSnapshotAfter, liveSnapshotBefore);
  ```

  自動pool再作成なし、key/version/checksum/件数/bytes/job/GSI整合、保全前停止と再開、remap先ID衝突と部分失敗で未公開を維持、source/restored同一拒否をassertする。PITRにはCognitoのpassword/sessionが含まれないことを結果へ明記する。
- [ ] **Step 2: Run `npx tsx --test tests/operations/recovery.test.ts` → FAIL。** version保全とowner不一致の失敗を確認する。
- [ ] **Step 3: 照合・画像保全・明示的remapを実装する。** sourceを読み取り専用、復旧先を未公開に固定する。非現行versionをGETで検証して新UUIDのkeyへ元bytesをPut、job/参照を復旧先だけで条件付き更新する。再実行はrun ID/進捗で照合する。remapは明示mappingがある場合だけ行い、全件衝突/quota検査→復旧先コピー→照合→旧復旧先レコード整理、gateはfalseのまま。ユーザー/ログイン名検索で自動remapしない。PITRの実行、稼働テーブルへの切替、Terraform applyはこのスクリプトから行わない。
- [ ] **Step 4: 運用契約とscriptsを追加する。** `npm run recovery:verify -- --source-config <private-source> --restored-config <private-target> --owner-identities <private-identities> --run-id <uuid>`、`--prepare-restored`、`--preserve-images`、`--owner-map <private-map>`を明示操作とする。source-configは稼働参照先、restored-configは稼働参照先と全table名が異なる復旧先とする。`docs/operations/recovery.md`へ新3テーブル復旧、schedule停止、未公開化、照合/現行version保全、別planで参照切替、URL維持、state復旧/アプリZIP切戻/データ復旧の違い、一時復旧先の後片付けを記載する。
- [ ] **Step 5: 検証する。** Run `npm run test:operations`、`npm run typecheck`、`npm run lint` → PASS。実PITRリハーサルは未実施と記録する。
- [ ] **Step 6: `git add scripts/operations/recovery.ts scripts/operations/verify-recovery.ts tests/operations/recovery.test.ts docs/operations/recovery.md package.json` → `git commit -m "feat: verify restored owners and preserve image versions"`。**

## この計画の完了条件

dry-run・import/verify/publish・recovery verifyが合成fakeで実行でき、原本不変、未公開途中状態、全件照合、再開、owner再作成の非互換、元画像保全を証明する。実アカウントのCognito追加、JSON取込、公開、PITR復旧は別操作として未実行を明記する。汎用管理CLIは存在しない。
