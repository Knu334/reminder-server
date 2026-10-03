# Reminder Server AWS Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 所有者単位のv2 API、DynamoDB/S3永続化、再開可能な画像清掃をAWS認証なしで検証できるhandlerとして実装する。

**Architecture:** HTTP API v2イベントから検証済みclaimsを取得し、純粋なDTO/画像検証と所有者サービスへ渡す。保存は条件付きDynamoDB transaction、画像はS3とjobを使い、清掃はGSI候補をベース項目の条件で再確認する。SDKクライアントの構築とhandlerの構成を分け、importでlisten・ファイル読み出しを行わない。

**Tech Stack:** Node24、TypeScript/CommonJS、AWS SDK v3、Zod、node:test/node:assert、tsx。

**Spec:** [承認済みAWS設計](../specs/2026-10-02-reminder-server-aws-design.md) §3〜§8・§12〜§15。[全体計画](2026-10-03-reminder-server-aws.md)も読む。

## Global Constraints

- `.devcontainer`は一切変更しない。実AWSへ接続せず合成データを用いる。
- `nodejs24.x`/CommonJS。strict、noUncheckedIndexedAccess、exactOptionalPropertyTypes、noImplicitReturns、isolatedModulesを有効にする。
- 本文2 MiB、画像1 MiB、有効項目1000件/画像128 MiB、120回/UTC分、画像URL900秒。
- API512 MiB/10秒、清掃512 MiB/660秒。候補10000件、削除5000件、600秒または残り60秒、並行4。
- revisionは1開始、If-Match必須、削除IDを再利用しない。元画像バイト列を維持し、読み取りへBASE64を含めない。
- 画像pending/retiredは24時間猶予、deletingは20分lease。GSIは4shard×3state、KEYS_ONLY、1ページ50候補。
- 保存とcheckpointをawaitしてから応答する。メモリをカウンターや永続データの唯一の保存先にしない。
- Bearer・本文・署名URL・画像・旧key・AWS内部エラーの実値をログ/HTTPエラーへ含めない。

## Review Focus

1. offset付きでも存在しない日付・Unicode長・不正BASE64を、黙って型変換や日付繰り上げせず拒否する（R01）。
2. 偽cursor/別pool/エンコードされたIDで、所有者境界やID同一性を変えない（R02/R03/R08）。
3. 同revisionの並行更新と結果不明のtransactionで、二重加算や誤った画像retireをしない（R04/R05）。
4. lease取得後の停止とGSI遅延で、未処理ページを飛ばさずcommitted画像を守る（R06/R07）。
5. Lambda残り時間不足・公開gate=false・AWS障害で、バックグラウンド書き込みや秘密漏洩を起こさない（R02/R07/R08）。

---

## ファイル境界・共通インターフェース

以下の型はR01で`src/reminders/types.ts`、`src/images/types.ts`、`src/shared/ports.ts`へ定義する。表記`?`の属性は欠落可、`null`は明示的な値。DB型と公開DTOは分離する。

| 名前 | 型・意味 |
| --- | --- |
| `OwnerId` | `string`（共通関数で生成する小文字SHA-256 hex） |
| `ImageRef` | `{ imageId: string; key: string; versionId: string; mime: string; bytes: number; sha256: string }` |
| `ReminderFields` | `{ id: string; url: string; title: string; reminderTime: string; autoOpen: boolean; webPush: boolean; hidden: boolean }` |
| `ActiveReminder` | `ReminderFields & { ownerId: OwnerId; revision: number; createdAt: string; updatedAt: string; thumbnail: ImageRef \| null; deleted: false; migrationRunId?: string }` |
| `Tombstone` | `{ ownerId: OwnerId; id: string; revision: number; deletedAt: string; deleted: true; migrationRunId?: string }` |
| `StoredReminder` | `ActiveReminder \| Tombstone`。通常削除では本文と画像参照を保持しない |
| `ReminderDto` | `ReminderFields & { revision: number; createdAt: string; updatedAt: string; thumbnail: Pick<ImageRef, 'imageId' \| 'mime' \| 'bytes' \| 'sha256'> \| null }` |
| `CreateInput` | `ReminderFields & { thumbnail: string \| null }`。thumbnailの省略はnullとする |
| `PatchInput` | `Partial<Omit<CreateInput, 'id'>>`。最低1field必要、thumbnail省略は維持/null・空文字は除去 |
| `Representation` | `{ dto: ReminderDto; body: string; etag: string }`。bodyは固定serializerのJSON |
| `ImageJob` | `{ jobId: string; ownerId: OwnerId; key: string; versionId?: string; mime?: string; bytes?: number; sha256?: string; state: 'pending' \| 'committed' \| 'retired' \| 'deleting' \| 'done'; createdAtMs: number; updatedAtMs: number; dueAtMs?: number; leaseOwner?: string; cleanupPartition?: string; cleanupSortKey?: string; migrationRunId?: string }` |
| `JobTransition` | `{ jobId: string; from: ImageJob['state']; to: ImageJob['state']; atMs: number; expectedVersionId?: string }` |
| `ChangeSet` | `{ ownerId: OwnerId; previous: ActiveReminder \| null; next: StoredReminder; itemDelta: number; byteDelta: number; jobs: JobTransition[]; clientRequestToken: string }` |
| `Budget` | `{ signal: AbortSignal; remainingMs(): number }`。AWS操作と再試行に渡す |
| `PublicationGate` | `{ published: boolean; runId: string \| null }` |
| `QueryPage` | `{ records: StoredReminder[]; lastId: string \| null }`。最後に評価した削除記録も含む |
| `CleanupPartition` | pending/retired/deletingと00〜03を組み合わせた12個の文字列 |
| `CleanupPage` | `{ jobs: ImageJob[]; evaluated: number; lastKey: Record<string, string> \| null }`。projectionからjobIdを取得し強いGetで本体を読む。evaluatedは本体欠落も含むGSIのScannedCount |
| `CleanupCheckpoint` | `{ roundRobinIndex: number; cursors: Partial<Record<CleanupPartition, Record<string, string> \| null>> }` |
| `CleanupResult` | `{ evaluated: number; deletes: number; incomplete: boolean; skippedUnpublished: boolean }` |

キー形式もR01で固定する。remindersは`ownerId`/`id`、owner_stateは`pk`/`sk`（`OWNER#<ownerId>`/`STORAGE`と`RATE#<UTC epoch minute>`、`GLOBAL`/`PUBLICATION`、`GLOBAL`/`MIGRATION#<runId>`）、image_jobsは`jobId`。checkpointは`CHECKPOINT#cleanup`でGSI属性なし。画像キーは`images/<ownerId>/<ASCII UUID>`とし、ユーザーのURL/IDをパスに混ぜない。rate項目のTTLはepoch secondsで分開始から172800秒後とし、古い項目が残っていても現在の分へ影響しない。

`src/shared/ports.ts`に以下を定義する。戻り値のDBレコードを各adapterで実行時検証する。

```ts
interface RemindersStore {
  get(ownerId: OwnerId, id: string, budget: Budget): Promise<StoredReminder | null>;
  query(ownerId: OwnerId, limit: number, afterId: string | null, budget: Budget): Promise<QueryPage>;
  commit(change: ChangeSet, budget: Budget): Promise<void>;
}
interface OwnerStore {
  gate(budget: Budget): Promise<PublicationGate>;
  consumeRate(ownerId: OwnerId, minute: number, budget: Budget): Promise<boolean>;
  probe(budget: Budget): Promise<void>;
}
interface ImagesStore {
  put(job: ImageJob, image: DecodedImage, budget: Budget): Promise<ImageRef>;
  head(key: string, versionId: string | null, budget: Budget): Promise<ImageHead | null>;
  get(ref: ImageRef, budget: Budget): Promise<Uint8Array>;
  signGet(ref: ImageRef, requestedSeconds: number, budget: Budget): Promise<string>;
  markDeleted(key: string, budget: Budget): Promise<void>;
  probe(budget: Budget): Promise<void>;
}
interface JobsStore {
  createPending(job: ImageJob, budget: Budget): Promise<void>;
  recordUpload(ref: ImageRef, budget: Budget): Promise<void>;
  get(jobId: string, budget: Budget): Promise<ImageJob | null>;
  queryDue(partition: CleanupPartition, cutoffMs: number, after: Record<string, string> | null, budget: Budget): Promise<CleanupPage>;
  claim(jobId: string, runId: string, nowMs: number, budget: Budget): Promise<ImageJob | null>;
  complete(jobId: string, runId: string, budget: Budget): Promise<void>;
  checkpoint(budget: Budget): Promise<CleanupCheckpoint>;
  saveCheckpoint(value: CleanupCheckpoint, budget: Budget): Promise<void>;
}
```

`DecodedImage = { data: Uint8Array; mime: string; bytes: number; sha256: string }`、`ImageHead = { versionId: string; sha256: string | null; deleteMarker: boolean }`は`src/images/types.ts`。HEADは署名・移行・清掃で目的を区別し、delete markerの404/405を通常の障害と混同しない。

Configのfieldは`region`, `remindersTable`, `ownerStateTable`, `imageJobsTable`, `imagesBucket`, `expectedApiId`, `expectedStage`, `issuer`, `clientId`, `sourceIps: string[]`, `limits: {jsonBytes: number; thumbnailBytes: number; itemCount: number; imageBytes: number; ownerRequestsPerMinute: number}`。対応する環境変数は`AWS_REGION`（マネージド値を読むだけ）, `REMINDERS_TABLE`, `OWNER_STATE_TABLE`, `IMAGE_JOBS_TABLE`, `IMAGES_BUCKET`, `EXPECTED_API_ID`, `EXPECTED_API_STAGE`, `COGNITO_ISSUER`, `COGNITO_CLIENT_ID`, `ALLOWED_SOURCE_IPS`（JSON配列、既定[]）。上限overrideは`MAX_JSON_BYTES`, `MAX_THUMBNAIL_BYTES`, `MAX_OWNER_ITEMS`, `MAX_OWNER_IMAGE_BYTES`, `OWNER_REQUESTS_PER_MINUTE`で整数文字列だけ許可する。未指定は2097152/1048576/1000/134217728/120。AWS_REGION等の予約環境変数をTerraformからLambdaへ設定しない。

### Task R01: 入力・DTO・ETagの契約と実行可能な試験基盤

**Files:** Create `src/config.ts`, `src/shared/errors.ts`, `src/shared/ports.ts`, `src/reminders/types.ts`, `src/reminders/validation.ts`, `src/reminders/representation.ts`, `src/images/types.ts`, `src/images/validation.ts`, `tests/support/fixtures.ts`, `tests/runtime/contracts.test.ts`; Modify `package.json`, `package-lock.json`, `tsconfig.json`, `eslint.config.mjs`, `src/util/reminderUtils.ts`（R08までの戻り値型修正のみ）。

**Interfaces:** Produces 上記型、`loadConfig(env: NodeJS.ProcessEnv): Config`、`parseCreate(value: unknown): CreateInput`、`parsePatch(value: unknown): PatchInput`、`normalizeInstant(value: string): string`、`decodeThumbnail(value: string | null): DecodedImage | null`、`represent(item: ActiveReminder): Representation`、`parseIfMatch(value: string | undefined): string`、`ApiError(status: number, code: string, message: string, retryAfterSeconds?: number)`。`Config`はtable名3個、image bucket、region、expected API ID/stage/issuer/clientId、上限、optional literal IP allowlistを持つ。fixtureは`validCreate(overrides?: Partial<CreateInput>)`、`activeReminder(overrides?: Partial<ActiveReminder>)`、`testBudget()`を提供する。

- [ ] **Step 1: `contracts.test.ts`へRED試験を書く。** `normalizes_real_offset_dates`、`rejects_readonly_unknown_and_coercion`、`validates_original_image_bytes`、`etag_depends_on_exact_representation`、`requires_single_strong_if_match`を作る。

  ```ts
  assert.equal(normalizeInstant('2026-10-03T09:00:00+09:00'), '2026-10-03T00:00:00.000Z');
  assert.throws(() => normalizeInstant('2026-02-30T09:00:00Z'));
  assert.throws(() => parseCreate({ ...validCreate(), hidden: 'false' }));
  assert.throws(() => parsePatch({ revision: 2 }));
  assert.throws(() => parseIfMatch('W/"r1-hash"'));
  assert.equal(represent(activeReminder()).body, represent(activeReminder()).body);
  assert.notEqual(represent(activeReminder()).etag, represent(activeReminder({ title: 'changed' })).etag);
  ```

  境界試験も同ファイルに置く。ID1/128/129 Unicode code pointsと制御文字、URL http/https・4096/4097文字、title1024/1025文字、過去日時・offsetなし・閏日・小数秒、空PATCH、readonly/未知field、正規BASE64/不正padding/不正文字/1MiBちょうど・超過、data URLのMIME不一致を検証する。PNG/JPEG/GIF/WebPを署名とMIMEで識別し、SVG/HTML/未対応形式は422にする。裸BASE64はバイト列からMIMEを判定、空文字/nullは画像なし。既存の未対応画像はO01で全件検査して中止し、変換しない。
- [ ] **Step 2: 試験を実行可能にする依存とscriptsを追加する。** `node:test`/`assert`にtsx、Zod、AWS SDK v3のclient-dynamodb/lib-dynamodb/client-s3/s3-request-presigner/client-cloudwatchを`--save-exact`で追加しlockを更新する。esbuild/Node24の型/typed lintも固定する。`test:runtime`等の全体計画のscriptsを追加し、
- [ ] **Step 3: 検証する。** Run `npx tsx --test tests/runtime/contracts.test.ts` → 未作成関数のimportでFAILを確認する。`npm run test:packaging`等、後続の未作成コマンドは担当タスクで追加する。
- [ ] **Step 4: Interfacesの純粋関数と型を実装する。** スキーマはstrict、日時は暦日とoffsetを検証してUTCミリ秒表記へ正規化する。serializerはDTOの固定field順、thumbnail=nullを維持し、`"r<revision>-<UTF-8 body SHA-256 hex>"`を返す。If-Match欠落428、weak/`*`/list/不正構文422。createdAt等は書き込み入力へ許可しない。BASE64はデコード前長さとデコード後サイズ・再エンコードの一致を検査する。
- [ ] **Step 5: strict設定とtyped lintを整備する。** `target=ES2023`, `module=CommonJS`, `moduleResolution=node`, `noEmit=true`, `allowImportingTsExtensions=true`、Global Constraintsのflags。Node globals、src/tests/scriptsのTS対象、dist/coverage/.terraform/.devcontainer除外、no-floating-promises/no-misused-promisesを設定する。旧`getReminders`の戻り値だけ`?? []`で型を満たし、R08で撤去する。
- [ ] **Step 6: 検証する。** Run `npx tsx --test tests/runtime/contracts.test.ts`、`npm run typecheck`、`npm run lint` → 全てPASS。
- [ ] **Step 7: コミットする。** `git add src/config.ts src/shared src/reminders src/images tests/support/fixtures.ts tests/runtime/contracts.test.ts src/util/reminderUtils.ts package.json package-lock.json tsconfig.json eslint.config.mjs` → `git commit -m "feat: define validated reminder and image contracts"`。

### Task R02: Gateway境界・所有者識別・期限・秘密を含まない応答

**Files:** Create `src/api/event.ts`, `src/api/identity.ts`, `src/api/responses.ts`, `src/shared/budget.ts`, `src/shared/logging.ts`, `tests/runtime/boundaries.test.ts`; Modify `tests/support/fixtures.ts`。

**Interfaces:** Consumes R01 Config/ApiError。Produces `ownerIdFor(issuer: string, sub: string): OwnerId`、`parseGatewayEvent(value: unknown, config: Config): GatewayRequest`、`requireOwner(request: GatewayRequest, config: Config, scope: 'read' | 'write'): OwnerId`、`createBudget(remainingMs: () => number, reserveMs: number): Budget`、`jsonResponse(status: number, body: string, requestId: string, headers?: Record<string, string>): APIGatewayProxyStructuredResultV2`、`errorResponse(error: unknown, requestId: string): APIGatewayProxyStructuredResultV2`、`logEvent(event: SafeLogEvent): void`。GatewayRequestはmethod/routeKey/pathParameters/query/headers/body/isBase64Encoded/requestId/sourceIpとjwt claimsを保持する。SafeLogEventの許可fieldはrequestId/lambdaRequestId/operation/status/code/durationMsと数値evaluated/deletes・真偽incompleteのみ。fixture `gatewayEvent(overrides?: Record<string, unknown>): unknown`を追加する。

- [ ] **Step 1: RED試験を書く。** `owner_is_issuer_sub_not_client_or_email`、`rejects_non_gateway_or_missing_access_claims`、`checks_bytes_before_json_parse`、`never_logs_secrets`、`deadline_aborts_awaited_operations`。

  ```ts
  assert.equal(ownerIdFor('issuer-a', 'sub'), createHash('sha256').update(JSON.stringify(['issuer-a', 'sub']), 'utf8').digest('hex'));
  assert.notEqual(ownerIdFor('issuer-a', 'sub'), ownerIdFor('issuer-b', 'sub'));
  assert.equal(errorResponse(new Error('secret-url'), 'req').statusCode, 503);
  assert.ok(!errorResponse(new Error('secret-url'), 'req').body?.includes('secret-url'));
  ```

  exp/iatのGatewayのstring/number、issuer/client_id不一致、token_use=id、scope欠落、API ID/stage/version不一致を拒否する。UTF-8多バイトとGateway-base64本文を2MiB前後で検査し、壊れたbase64/JSON400・media type415・本文超過413を区別する。Authorization・本文・署名URLをcanaryにしてログへ含まれないことを検査する。入力から二重decodeせずpathParametersの文字列をR01で検証する。
- [ ] **Step 2: Run `npx tsx --test tests/runtime/boundaries.test.ts` → FAIL。** 未定義の境界関数による失敗を確認する。
- [ ] **Step 3: Interfacesの境界関数を実装する。** ownerIdは指定のhash式。JWTの署名検証を独自実装せず、所定HTTP APIイベントとclaimsを検証しroute scope/token_useも確認する。headersは小文字へ正規化し、複数If-Matchを結合して単一値検証を迂回させない。本文は認証後に長さ・media type・JSONの順で検証する。未設定IP制限は無効、設定時はリテラルIPとGateway sourceIpだけを照合しDNS/X-Forwarded-Forを使わない。安全なエラーとJSON応答は`Content-Type: application/json; charset=utf-8`、`X-Request-Id`、`X-Content-Type-Options: nosniff`を付ける。項目応答は`private, no-store, no-transform`、その他のJSONはno-store。CORSヘッダーはGatewayへ委譲する。
- [ ] **Step 4: Run `npx tsx --test tests/runtime/boundaries.test.ts`、`npm run typecheck`、`npm run lint` → PASS。** SDK操作のabort、期限不足で新規操作を開始しないこと、Promiseをawaitすることを確認する。
- [ ] **Step 5: `git add src/api src/shared/budget.ts src/shared/logging.ts tests/runtime/boundaries.test.ts tests/support/fixtures.ts` → `git commit -m "feat: enforce gateway identity and safe response boundaries"`。**

### Task R03: 所有者Query・cursor・公開gate・分単位レート

**Files:** Create `src/reminders/cursor.ts`, `src/reminders/dynamo-store.ts`, `src/reminders/owner-store.ts`, `src/shared/aws.ts`, `tests/support/commands.ts`, `tests/runtime/reads-rate.test.ts`。

**Interfaces:** Consumes R01 ports、R02 owner/budget。Produces `encodeCursor(ownerId: OwnerId, lastId: string): string`、`decodeCursor(value: string, ownerId: OwnerId): string`、`createRemindersStore(client: DynamoDBDocumentClient, config: Config): RemindersStore`、`createOwnerStore(client: DynamoDBDocumentClient, config: Config): OwnerStore`、`checkRate(store: OwnerStore, ownerId: OwnerId, nowMs: number, budget: Budget): Promise<void>`。aws.tsはSDKclientを環境ごとに再利用する`createAwsClients(config: Config): AwsClients`を提供する。test helper `captureCommands(replies: unknown[]): { client: DynamoDBDocumentClient; sent: unknown[] }`を追加する。

`AwsClients = { dynamo: DynamoDBDocumentClient; s3: S3Client; cloudWatch: CloudWatchClient }`。runtimeのSDK clientsはmaxAttempts=1に固定し、再試行は各adapter/serviceでbudget内・最大3送信に制限する。条件付きrate加算は結果不明時に再加算せず503にする。transactionは同じClientRequestToken、S3 Put/markerは結果不明時のHEAD照合を先に行う。これによりSDKとサービス再試行の掛け算を避ける。

- [ ] **Step 1: RED試験を書く。** `reads_only_consistent_owner_keys`、`empty_filtered_page_keeps_evaluated_cursor`、`forged_cursor_cannot_select_another_owner`、`rate_has_fixed_utc_window_and_fail_closed`。

  ```ts
  assert.equal(decodeCursor(encodeCursor('owner-a', 'id-last'), 'owner-a'), 'id-last');
  assert.throws(() => decodeCursor(encodeCursor('owner-b', 'id-last'), 'owner-a'));
  assert.equal(Math.ceil((60_000 - 59_001) / 1000), 1); // rate試験では実際のエラー/headerも照合
  ```

  Get/QueryのConsistentRead=true、ownerId条件、Scan未使用、上限20既定/50最大・limit不正422、削除記録のみのページのlastIdを検査する。cursorはversion/ownerId/lastIdだけのstrictなbase64url JSON、最大2048 bytes、他owner/余分field/不正エンコード422。global gate未作成は未公開扱い、壊れたDBrecordは503。rateは120件成功/121件429 code・retryAfterSeconds・次分境界、異なるtokenでも同じowner、古いTTLレコードが残った次分、AWS障害503を検査する。
- [ ] **Step 2: Run `npx tsx --test tests/runtime/reads-rate.test.ts` → FAIL。** command検査と関数未定義の失敗を確認する。
- [ ] **Step 3: read/owner adapterとcursorを実装する。** Queryは1回の評価上限で終了し、削除を埋めるための無制限Queryをしない。cursorは認証済みownerとの一致を確認してExclusiveStartKeyを再構築する。rateのUpdateはcount未存在またはcount<120条件、分キーとTTLを使用、条件失敗だけ429、その他503。Retry-Afterは次分までceil・最低1秒。probeは必要テーブルと公開状態を読み、個人データを応答へ含めない。write部分はR04で完成するまで呼ぶと明示的な未実装エラーにする。
- [ ] **Step 4: Run `npx tsx --test tests/runtime/reads-rate.test.ts`、`npm run typecheck` → PASS。** 120件並行のrate試験にはR04で作るstateful fakeを追加して再確認する。
- [ ] **Step 5: `git add src/reminders/cursor.ts src/reminders/dynamo-store.ts src/reminders/owner-store.ts src/shared/aws.ts tests/support/commands.ts tests/runtime/reads-rate.test.ts` → `git commit -m "feat: add owner-scoped reads and distributed rate limits"`。**

### Task R04: revision・墓標・容量の原子的なメタデータ更新

**Files:** Create `src/reminders/service.ts`, `tests/support/stateful-store.ts`, `tests/runtime/writes.test.ts`; Modify `src/reminders/dynamo-store.ts`, `tests/runtime/reads-rate.test.ts`。

**Interfaces:** Consumes R01 ChangeSet/ports、R03 read/rate。Produces `createRemindersService(deps: ReminderDeps): RemindersService`。ReminderDepsはreminders/owners/jobs/images ports、clock `() => number`、uuid `() => string`、Config。RemindersServiceは`list(ownerId, limit, cursor, budget): Promise<{items: ReminderDto[]; nextCursor: string|null}>`、`get(ownerId, id, budget): Promise<Representation>`、`create(ownerId, input, budget): Promise<Representation>`、`patch(ownerId, id, etag, input, budget): Promise<Representation>`、`remove(ownerId, id, etag, budget): Promise<{id: string; deleted: true; revision: number}>`。引数型はOwnerId/string/CreateInput/PatchInput/Budget。R05で画像機能を接続するまでthumbnail=nullの試験を使用する。stateful helper `createHarness(): { service: RemindersService; reminders: RemindersStore; owners: OwnerStore; jobs: JobsStore; images: ImagesStore; snapshot(): TestState; injectFault(point: string, mode: 'before' | 'after-commit'): void; advanceMs(ms: number): void }`を提供する。

- [ ] **Step 1: RED試験を書く。** `concurrent_same_revision_only_one_wins`、`different_items_are_preserved`、`duplicate_create_and_deleted_id_cannot_revive`、`quota_is_atomic_and_unknown_result_does_not_double_count`、`rate_120_parallel_requests_only`。

  ```ts
  const h = createHarness(); const r = await h.service.create('owner-a', validCreate(), testBudget());
  const results = await Promise.allSettled(['a', 'b'].map(title => h.service.patch('owner-a', r.dto.id, r.etag, { title }, testBudget())));
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal((await h.service.get('owner-a', r.dto.id, testBudget())).dto.revision, 2);
  ```

  名前を挙げた残りの試験では別項目の不変、create二重409、DELETE後GET404/再create409、If-Match欠落428・全体不一致412、1000件ちょうど成功/1001件413、同時createで上限超過なし、削除で件数と画像容量を減算、条件失敗とthrottle/transaction conflictの分類をassertする。SDK transaction内に同じitemの複数actionがないことも確認する。fakeは条件評価とtransaction commitを同じcritical sectionで行い、after-commit障害を注入できるようにする。
- [ ] **Step 2: Run `npx tsx --test tests/runtime/writes.test.ts tests/runtime/reads-rate.test.ts` → FAIL。** 競合試験が未実装サービスで失敗することを確認する。
- [ ] **Step 3: serviceと`RemindersStore.commit`を実装する。** createは非存在条件、patch/removeは存在・deleted=false・期待revision条件、容量変化とjob transitionを同じTransactWriteで処理する。owner STORAGEは件数/bytesの差分を条件付き更新し、必要時に空状態を作る。revision差分だけでなく現在のrepresentation ETag全体を比較する。削除は墓標だけ保存、ID再利用不可。SDK再試行は最大3attempt、同じClientRequestToken/ChangeSet、budget内。応答不明時は強いgetでnextのrevisionと内容を照合し、確定不能は503、無条件の新操作にしない。ClientRequestTokenは内部再試行用であり、クライアントの無期限な冪等キーとは説明しない。
- [ ] **Step 4: Run `npx tsx --test tests/runtime/writes.test.ts tests/runtime/reads-rate.test.ts`、`npm run typecheck`、`npm run lint` → PASS。** fake競合とAWS command shapeの両方を検証する。
- [ ] **Step 5: `git add src/reminders/service.ts src/reminders/dynamo-store.ts tests/support/stateful-store.ts tests/runtime/writes.test.ts tests/runtime/reads-rate.test.ts` → `git commit -m "feat: enforce revision and storage quotas transactionally"`。**

### Task R05: S3の元画像保存・画像commit・別の署名URL

**Files:** Create `src/images/s3-store.ts`, `src/images/upload.ts`, `tests/runtime/images.test.ts`; Modify `src/reminders/service.ts`, `src/shared/aws.ts`, `tests/support/stateful-store.ts`。

**Interfaces:** Consumes R01画像型・ports、R04 ChangeSet/service。Produces `createImagesStore(client: S3Client, config: Config): ImagesStore`、`stageThumbnail(ownerId: OwnerId, image: DecodedImage, deps: ReminderDeps, budget: Budget): Promise<ImageRef>`、serviceの`thumbnailUrl(ownerId: OwnerId, id: string, budget: Budget): Promise<{url: string; expiresAt: string; imageId: string; revision: number}>`。JobsStoreの具体adapterはR06、試験はstateful fakeを使用する。

- [ ] **Step 1: RED試験を書く。** `preserves_image_bytes_and_checksum`、`s3_success_db_reject_leaves_pending`、`unknown_commit_never_retires_current_image`、`url_refresh_does_not_change_body_or_etag`、`signs_current_owner_version_only`。

  ```ts
  const h = createHarness(); const created = await h.service.create('owner-a', validCreate({ thumbnail: syntheticPngBase64 }), testBudget());
  const before = await h.service.get('owner-a', created.dto.id, testBudget());
  const url = await h.service.thumbnailUrl('owner-a', created.dto.id, testBudget());
  const after = await h.service.get('owner-a', created.dto.id, testBudget());
  assert.deepEqual(after, before); assert.equal(url.imageId, before.dto.thumbnail?.imageId);
  ```

  fixture `syntheticPngBase64`はtests/support/fixtures.tsに公開可能な元bytesとともに定義する。SDK PutObjectのBody・ChecksumSHA256・ContentType、versionId欠落503、GetObject署名VersionId/900秒、異owner404、画像なし404 THUMBNAIL_NOT_FOUND、削除項目404を検査する。put前pending作成失敗・put結果不明・upload記録前停止・transaction前/反映後timeout・画像差し替え/除去でquotaが正しいことをstateful fakeでassertする。
- [ ] **Step 2: Run `npx tsx --test tests/runtime/images.test.ts` → FAIL。** 元画像と不明結果の試験が赤になることを確認する。
- [ ] **Step 3: S3 adapterとstage/commitを接続する。** 全入力検証→UUIDのpending記録→固有key Put→version/checksum記録→reminder/容量/job committed・旧画像retiredのtransaction。pendingのstate条件をcommitに含める。失敗した画像は保護猶予のあるpendingへ残し、transaction不明時は強いjob/reminder getで照合する。committedをretiredへ降格させない。URLは現在の強いgetからのみ発行し、DB/logへ保存しない。expiresAtは要求900秒の終了目安とし、署名credentialsによる早期失敗を許容する。
- [ ] **Step 4: Run `npx tsx --test tests/runtime/images.test.ts tests/runtime/writes.test.ts`、`npm run typecheck` → PASS。** 128MiB境界と画像差分の同時更新、元bytes hash一致、DBにBASE64が存在しないことも確認する。
- [ ] **Step 5: `git add src/images/s3-store.ts src/images/upload.ts src/reminders/service.ts src/shared/aws.ts tests/support/fixtures.ts tests/support/stateful-store.ts tests/runtime/images.test.ts` → `git commit -m "feat: track original S3 images and issue separate download URLs"`。**

### Task R06: 清掃GSI・条件付きlease・checkpointのDB adapter

**Files:** Create `src/images/job-keys.ts`, `src/images/jobs-store.ts`, `tests/runtime/jobs.test.ts`。

**Interfaces:** Consumes R01 JobsStore/ImageJob、R03 clients。Produces `cleanupKeys(state: 'pending' | 'retired' | 'deleting', jobId: string, dueAtMs: number): {cleanupPartition: CleanupPartition; cleanupSortKey: string}`、`createJobsStore(client: DynamoDBDocumentClient, config: Config): JobsStore`。claimはeligible stateとdue<=now、lease切れのdeletingを条件確認してrunId/now+1200000へ更新、条件不一致だけnullを返す。

- [ ] **Step 1: RED試験を書く。** `sparse_due_keys_match_spec`、`retired_grace_starts_at_transition`、`gsi_stale_committed_job_cannot_be_claimed`、`lease_owner_required_to_complete`、`checkpoint_never_contains_gsi_keys`。

  ```ts
  const keys = cleanupKeys('retired', '00000000-0000-4000-8000-000000000001', 86_400_000);
  assert.match(keys.cleanupPartition, /^retired#0[0-3]$/);
  assert.equal(keys.cleanupSortKey, '0000086400000#00000000-0000-4000-8000-000000000001');
  ```

  shardはSHA-256の先頭byte mod4と固定する。pending created+86400000、retired transition+86400000、deleting lease満了、committed/done索引除去をassertする。Query IndexName/KEYS_ONLY/Limit50/partition equality/13桁cutoff`#~`/ConsistentReadなし、ページLastEvaluatedKey、強いjobGet、期限境界、lease有効中の再claim拒否、runId違い完了拒否、uploaded version条件を検査する。
- [ ] **Step 2: Run `npx tsx --test tests/runtime/jobs.test.ts` → FAIL。** 未定義keys/adapterで失敗を確認する。
- [ ] **Step 3: key関数とJobsStoreを実装する。** R04/R05 transactionと同じbase-item更新でstate/索引属性を変更する。GSI候補は強いGetで現在状態を読み、claimの条件で再確認する。done/committedはREMOVEでGSIを外す。checkpointは専用jobIdに保存し、画像jobスキーマと取り違えない。Scan・bucket全列挙は実装しない。
- [ ] **Step 4: Run `npx tsx --test tests/runtime/jobs.test.ts tests/runtime/images.test.ts`、`npm run typecheck` → PASS。** jobs adapterのconditionsとstateful fakeのstate遷移を照合する。
- [ ] **Step 5: `git add src/images/job-keys.ts src/images/jobs-store.ts tests/runtime/jobs.test.ts` → `git commit -m "feat: add indexed image jobs with reclaimable cleanup leases"`。**

### Task R07: 公平・上限付き・再開可能な画像清掃handler

**Files:** Create `src/cleanup/service.ts`, `src/cleanup/metrics.ts`, `src/cleanup.ts`, `tests/runtime/cleanup.test.ts`; Modify `src/images/s3-store.ts`, `tests/support/stateful-store.ts`。

**Interfaces:** Consumes R06 jobs、R05 images、R02 budget/logging。Produces `runCleanup(deps: CleanupDeps, budget: Budget): Promise<CleanupResult>`、`emitCleanupMetrics(result: CleanupResult, heartbeat: boolean, client: CloudWatchClient): Promise<void>`、`createCleanupHandler(deps: CleanupDeps): (event: unknown, context: Context) => Promise<CleanupResult>`、export `handler`。CleanupDepsはjobs/images/owners ports、clock/uuid、metrics client、Config。eventは空objectまたはSchedulerの起動情報だけを受け、ownerId/keyや上限overrideを受け付けない。

- [ ] **Step 1: RED試験を書く。** `rotates_all_12_partitions_fairly`、`partial_page_replays_without_skipping`、`stale_index_and_commit_race_cannot_delete`、`limits_candidates_deletes_time_and_parallelism`、`delete_marker_retry_converges`、`unpublished_has_no_mutation_or_heartbeat`、`external_failure_checkpoints_then_throws`。

  ```ts
  // fakeへ51候補を設定し、最初のpage途中で残り時間60秒にする
  assert.equal(first.incomplete, true);
  assert.equal(checkpoint.cursors['pending#00'] ?? null, pageStartCursor);
  assert.equal(fake.doneJobCount, 51); // 再評価は評価件数へ重複計上し得るが処理漏れはない
  assert.equal(fake.deletedCommittedImages.length, 0);
  ```

  first/second/checkpoint等は同試験内でcreateHarnessのportsをrunCleanupへ渡して得る値。候補10000/削除5000/600秒/残り60秒で新規開始停止、最大並行4、ページ全処理後のみcursor確定、partition末尾はその実行で再Queryせず次回リセット、GSIの後日反映、pending version記録前停止、20分lease後再開をassertする。途中失敗後は未処理flag=1、正常checkpoint時だけheartbeat=1。非公開ではmutation/metricsなし。S3に既存delete markerがあれば永久version削除せずdoneへ収束させる。
- [ ] **Step 2: Run `npx tsx --test tests/runtime/cleanup.test.ts` → FAIL。** 停止後の再開とcommitted保護の試験が失敗することを確認する。
- [ ] **Step 3: 清掃サービスとhandlerを実装する。** 開始時刻をcutoffとして12partitionを1pageずつ巡回、必要操作をawaitする。処理枠不足時はpage開始cursorを保持する。claim後はkeyの現行状態をHeadで照合し、DeleteObjectにVersionIdを渡さずmarkerを作る。key未存在/marker済みをdoneへ収束させる。外部失敗はcheckpointと未完了metric保存を試みてthrowし、上限到達は正常return+incomplete。SDKattemptは最大3/budget内。初回unpublishedは清掃をせず返す。metricsはNamespace `ReminderServer`、dimension `Environment=production`のみ、CleanupIncomplete=0/1、CleanupHeartbeat=1。Lambda requestId/runIdはログに使うがmetric dimensionにしない。
- [ ] **Step 4: Run `npx tsx --test tests/runtime/cleanup.test.ts tests/runtime/jobs.test.ts tests/runtime/images.test.ts`、`npm run typecheck`、`npm run lint` → PASS。** handler return後の未await処理がないことと、署名URL/画像を含むログがないことを確認する。
- [ ] **Step 5: `git add src/cleanup src/cleanup.ts src/images/s3-store.ts tests/runtime/cleanup.test.ts tests/support/stateful-store.ts` → `git commit -m "feat: implement bounded resumable scheduled image cleanup"`。**

### Task R08: v2ルート・health/readyを統合し旧常駐サーバーを撤去

**Files:** Create `src/api/routes.ts`, `src/api.ts`, `tests/runtime/api.test.ts`, `docs/api-v2.md`; Modify `src/shared/aws.ts`, `package.json`, `package-lock.json`; Delete `src/app.ts`, `src/router/index.ts`, `src/middleware/reminderMiddleware.ts`, `src/util/reminderUtils.ts`, `src/types/types.ts`。

**Interfaces:** Consumes R01〜R07全interfaces。Produces `createApiHandler(deps: ApiDeps): (event: unknown, context: Context) => Promise<APIGatewayProxyStructuredResultV2>`、export `handler`。ApiDepsはConfig、RemindersService、OwnerStore、ImagesStore、clock。handlerはlazy構成し、importで設定エラーをthrowせずhealthとready503を返せる。運用スクリプトはhandlerではなくdomain/adapterを使用する。

- [ ] **Step 1: RED試験を書く。** `v2_crud_returns_contract_and_etags`、`owner_rate_precedes_storage`、`image_url_is_separate_and_no_store`、`health_ready_and_unpublished_behavior`、`legacy_api_is_gone`、`encoded_id_is_not_double_decoded`、`untrusted_origin_is_not_authentication`。

  ```ts
  assert.equal(created.statusCode, 201); assert.ok(created.headers?.Location);
  assert.equal(missingIfMatch.statusCode, 428); assert.equal(staleUpdate.statusCode, 412);
  assert.equal(rateExceeded.statusCode, 429); assert.equal(rateExceeded.headers?.['Retry-After'], '1');
  assert.equal(unpublishedV2.statusCode, 503); assert.equal(unpublishedReady.statusCode, 503);
  assert.equal(legacyPut.statusCode, 410); assert.equal(health.statusCode, 200);
  assert.equal(urlResponse.headers?.['Cache-Control'], 'no-store');
  ```

  各値はgatewayEventとstateful harnessでhandlerを呼んだ結果。全8routeと旧POST/PUT、存在しないroute404、不許可method405、GET空一覧200、query cursor/limit、作成Location URI encode、GET/POST/PATCHの同じserializer、DELETE最小応答を確認する。ID `%2F`・`%25`・UnicodeはpathParametersの契約通り一度だけ扱う。scope/ownerを通過したrequestをrateで数え、rate障害503時にstore mutationなし、容量413との別codeを確認する。未認証拒否はローカルhandler境界試験とGateway設定試験を分ける。
- [ ] **Step 2: Run `npx tsx --test tests/runtime/api.test.ts` → FAIL。** route未実装の失敗を確認する。
- [ ] **Step 3: handlerとrouteを接続する。** Gateway境界→v2認証→rate→公開gate→入力→service→共通応答の順。healthは依存アクセスなし、readyは設定/必要table/bucket読み取りと公開状態、失敗503。API budgetは残り時間から1秒reserve、外部失敗503。OPTIONの認証なし/CORSはD03のGateway設定で処理し、handlerが任意originを認証として許可しない。旧API410は新APIパスを案内するだけで旧JSONを読み書きしない。
- [ ] **Step 4: 旧サーバーと不要依存を撤去する。** Express/cookie-parser/morgan/helmet/chokidar/http-errors/debugと対応types、ts-node/tsconfig-pathsを削除し、lockを更新する。`docs/api-v2.md`へ完全なwrite/read/thumbnail URL DTO、ETag不透明性、空items+cursor、Gateway形式エラー、各code/Retry-After、オフラインと短期URLの期限を記載する。
- [ ] **Step 5: 検証する。** Run `npm run test:runtime`、`npm run typecheck`、`npm run lint` → PASS。`rg 'listen\(|node:dns|CERT_PATH|ALLOW_DOMAIN|readFileSync|writeFileSync' src` → 稼働コードに残らない。
- [ ] **Step 6: `git add src tests/runtime/api.test.ts docs/api-v2.md package.json package-lock.json` → `git commit -m "feat: replace legacy server with item-based Lambda API"`。**

## この計画の完了条件

R01〜R08のテスト・型・lintが通り、API/清掃handlerをimportしてもサーバー起動やデータファイルアクセスが起きない。元画像を含む合成データでowner/revision/容量/清掃の整合が検証できる。Gatewayの実JWT検証、S3署名・CORS、IAM、実Lambda freeze/timeoutはdeployment後の受け入れ条件へ残す。
