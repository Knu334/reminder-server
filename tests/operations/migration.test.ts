import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { importMigration, prepareMigration, verifyMigration, publishMigration } from "../../scripts/operations/migration";
import type { MigrationIdentity, LegacyValidation } from "../../scripts/operations/legacy";
import { migrationHarness } from "../support/migration-store";
import { activeReminder, syntheticPngBytes, testBudget } from "../support/fixtures";

const identity: MigrationIdentity = { runId: "00000000-0000-4000-8000-000000000001", sourceSha256: "a".repeat(64), mappingSha256: "b".repeat(64), contractSha256: "c".repeat(64), contractVersion: 1,
  environment: { accountId: "123456789012", region: "us-east-1", remindersTable: "reminders", ownerStateTable: "owners", imageJobsTable: "jobs", imagesBucket: "images", issuer: "https://synthetic.invalid/pool" } };
function input(): LegacyValidation {
  const image = { data: syntheticPngBytes, bytes: 12, mime: "image/png", sha256: createHash("sha256").update(syntheticPngBytes).digest("hex") };
  return { errors: [], owners: [{ ownerId: "a".repeat(64), items: [activeReminder({ id: "id/%/🌱" }), activeReminder({ id: "second", hidden: true })], images: new Map([["id/%/🌱", image]]) }, { ownerId: "b".repeat(64), items: [], images: new Map() }] };
}
void test("partial_import_never_publishes", async () => {
  const value = input(); const fake = migrationHarness(value); fake.fail("commit", "before");
  await assert.rejects(() => importMigration(identity, value, fake.deps()));
  assert.equal((await fake.owners.gate(testBudget())).published, false);
  const result = await verifyMigration(identity, value, fake.deps()); assert.equal(result.exactMatch, false);
  await assert.rejects(() => publishMigration(identity, result, fake.deps()));
});
void test("after_commit_timeout_resumes_without_double_count", async () => {
  const value = input(); const fake = migrationHarness(value); fake.fail("commit", "after"); fake.fail("progress", "before");
  await assert.rejects(() => importMigration(identity, value, fake.deps()));
  const summary = await importMigration(identity, value, fake.deps());
  assert.deepEqual(summary, { owners: 2, items: 2, imageBytes: 12, completed: true });
  assert.equal(fake.ownerCount("a".repeat(64)), 2); assert.equal(fake.commits, 2); assert.equal(fake.puts, 1);
});
void test("changed_source_mapping_or_target_aborts", async () => {
  const value = input(); const fake = migrationHarness(value); await prepareMigration(identity, fake.deps());
  for (const changed of [{ ...identity, sourceSha256: "d".repeat(64) }, { ...identity, mappingSha256: "d".repeat(64) }, { ...identity, contractSha256: "d".repeat(64) }, { ...identity, environment: { ...identity.environment, accountId: "234567890123" } }, { ...identity, environment: { ...identity.environment, region: "us-west-2" } }, { ...identity, runId: "00000000-0000-4000-8000-000000000002" }]) {
    await assert.rejects(() => importMigration(changed, value, fake.deps()));
  }
  assert.equal(fake.items.size, 0);
});
void test("all_item_fields_and_original_images_required_to_publish", async () => {
  const value = input(); const fake = migrationHarness(value); await importMigration(identity, value, fake.deps());
  const item = [...fake.items.values()][0]!; assert.equal(item.deleted, false); if (item.deleted) return;
  assert.ok(item.thumbnail); assert.equal(item.thumbnail.bytes, 12); assert.ok(item.thumbnail.versionId);
  for (const field of ["id", "ownerId", "url", "title", "reminderTime", "createdAt", "updatedAt", "revision", "autoOpen", "webPush", "hidden", "deleted", "migrationRunId"] as const) {
    const prior = structuredClone(item); (item as unknown as Record<string, unknown>)[field] = typeof item[field] === "boolean" ? !item[field] : typeof item[field] === "number" ? 2 : "changed";
    const result = await verifyMigration(identity, value, fake.deps()); assert.equal(result.exactMatch, false, field);
    await assert.rejects(() => publishMigration(identity, result, fake.deps())); Object.assign(item, prior);
  }
  const object = [...fake.objects.values()][0]!; object.data[11] = 9;
  const result = await verifyMigration(identity, value, fake.deps()); assert.equal(result.exactMatch, false);
  await assert.rejects(() => publishMigration(identity, result, fake.deps())); assert.equal((await fake.owners.gate(testBudget())).published, false);
  assert.doesNotMatch(JSON.stringify(result.mismatches), /https|Test reminder|id\//);
});
void test("empty_owner_is_imported_and_only_full_verification_publishes", async () => {
  const value = input(); const fake = migrationHarness(value); await importMigration(identity, value, fake.deps());
  assert.deepEqual(fake.storage.get("b".repeat(64)), { itemCount: 0, imageBytes: 0, migrationRunId: identity.runId });
  const verified = await verifyMigration(identity, value, fake.deps()); assert.equal(verified.exactMatch, true);
  await publishMigration(identity, verified, fake.deps()); assert.equal((await fake.owners.gate(testBudget())).published, true);
  await assert.rejects(() => importMigration(identity, value, fake.deps()));
});
for (const point of ["stage", "put", "owner", "progress", "prepare"]) for (const phase of ["before", "after"] as const) {
  void test(`restart_${point}_${phase}_does_not_add_versions_or_items`, async () => {
    const value = input(); const fake = migrationHarness(value); fake.fail(point, phase);
    try { await importMigration(identity, value, fake.deps()); } catch { /* Restart with persisted external state. */ }
    const summary = await importMigration(identity, value, fake.deps()); assert.equal(summary.items, 2); assert.equal(fake.puts, 1);
    assert.equal(fake.ownerCount("a".repeat(64)), 2); assert.equal((await verifyMigration(identity, value, fake.deps())).exactMatch, true);
  });
}
void test("storage_quota_job_metadata_and_extra_items_block_publication", async () => {
  for (const corrupt of ["itemCount", "imageBytes", "job", "extra"]) {
    const value = input(); const fake = migrationHarness(value); await importMigration(identity, value, fake.deps());
    if (corrupt === "job") [...fake.jobs.values()][0]!.sha256 = "d".repeat(64);
    else if (corrupt === "extra") fake.items.set("extra", activeReminder({ id: "extra", migrationRunId: identity.runId }));
    else fake.storage.get("a".repeat(64))![corrupt as "itemCount" | "imageBytes"]++;
    const result = await verifyMigration(identity, value, fake.deps()); assert.equal(result.exactMatch, false, corrupt);
    await assert.rejects(() => publishMigration(identity, result, fake.deps()));
  }
});
void test("publish_reverifies_and_revokes_stale_success", async () => {
  const value = input(); const fake = migrationHarness(value); await importMigration(identity, value, fake.deps());
  const verified = await verifyMigration(identity, value, fake.deps()); fake.mutateItem(item => { item.title = "tampered"; });
  await assert.rejects(() => publishMigration(identity, verified, fake.deps()));
  assert.equal((await fake.owners.gate(testBudget())).published, false); assert.equal((await fake.store.loadRun(identity.runId))?.verification?.exactMatch, false);
});
void test("invalid_validation_never_prepares_and_page_failure_never_publishes", async () => {
  const value = input(); value.errors.push({ location: "owners[0]", field: "items", code: "INVALID_INPUT" });
  const fake = migrationHarness(value); await assert.rejects(() => prepareMigration(identity, fake.deps())); assert.equal(await fake.store.loadRun(identity.runId), null);
  value.errors.length = 0; await importMigration(identity, value, fake.deps()); fake.fail("page", "before");
  await assert.rejects(() => verifyMigration(identity, value, fake.deps())); assert.equal((await fake.owners.gate(testBudget())).published, false);
  assert.equal((await verifyMigration(identity, value, fake.deps())).exactMatch, true);
});

// Real AWS adapters below use synthetic SDK transport only; removing transaction guards fails these tests.
void test("aws_store_scans_every_page_and_refuses_foreign_unpublished_data", async () => {
  const { createMigrationStore } = await import("../../scripts/operations/migration-store");
  const { captureCommands } = await import("../support/commands");
  const { harnessConfig } = await import("../support/stateful-store");
  const { ScanCommand } = await import("@aws-sdk/lib-dynamodb");
  const capture = captureCommands([{ Items: [], LastEvaluatedKey: { ownerId: "foreign", id: "one" } }, { Items: [activeReminder()] }]);
  const store = createMigrationStore(capture.client, harnessConfig, identity, input(), testBudget());
  await assert.rejects(() => store.assertEmptyOrSameRun(identity));
  assert.equal(capture.sent.length, 2);
  assert.ok(capture.sent.every(command => command instanceof ScanCommand && command.input.ConsistentRead === true));
  assert.deepEqual((capture.sent[1] as InstanceType<typeof ScanCommand>).input.ExclusiveStartKey, { ownerId: "foreign", id: "one" });
});
void test("aws_store_item_transaction_preserves_createdAt_and_exact_counters", async () => {
  const { createMigrationStore } = await import("../../scripts/operations/migration-store");
  const { captureCommands } = await import("../support/commands");
  const { harnessConfig } = await import("../support/stateful-store");
  const { TransactWriteCommand } = await import("@aws-sdk/lib-dynamodb");
  const capture = captureCommands([{}]); const value = input();
  const store = createMigrationStore(capture.client, harnessConfig, identity, value, testBudget());
  const item = { ...value.owners[0]!.items[1]!, migrationRunId: identity.runId };
  await store.putImported(item.ownerId, item, null, identity);
  const tx = capture.sent[0] as InstanceType<typeof TransactWriteCommand>; assert.ok(tx instanceof TransactWriteCommand);
  const actions = tx.input.TransactItems!;
  assert.ok(actions.some(action => action.ConditionCheck?.ConditionExpression?.includes("#published = :false") && action.ConditionCheck.ExpressionAttributeValues?.[":run"] === identity.runId));
  const put = actions.find(action => action.Put?.TableName === harnessConfig.remindersTable)!.Put!; assert.deepEqual(put.Item, item);
  const counter = actions.find(action => action.Update?.Key?.sk === "STORAGE")!.Update!;
  assert.equal(counter.ExpressionAttributeNames?.["#items"], "itemCount"); assert.equal(counter.ExpressionAttributeNames?.["#bytes"], "imageBytes");
  assert.equal(counter.ExpressionAttributeValues?.[":itemDelta"], 1); assert.equal(counter.ExpressionAttributeValues?.[":byteDelta"], 0);
  assert.ok(actions.some(action => action.ConditionCheck?.ExpressionAttributeValues?.[":identity"] === identity));
});
void test("aws_publication_transaction_requires_persisted_exact_verification", async () => {
  const { createMigrationStore } = await import("../../scripts/operations/migration-store");
  const { captureCommands } = await import("../support/commands");
  const { harnessConfig } = await import("../support/stateful-store");
  const { TransactWriteCommand } = await import("@aws-sdk/lib-dynamodb");
  const verified = { identity, exactMatch: true, mismatches: [] };
  const capture = captureCommands([{ Item: { pk: "GLOBAL", sk: `MIGRATION#${identity.runId}`, identity, phase: "verified", progress: { format: "chain-v2", sha256: createHash("sha256").update(JSON.stringify({ completedOwners: [], completedItems: [] })).digest("hex"), completedOwners: { head: null, count: 0 }, completedItems: { head: null, count: 0 } },
    verification: { ...verified, mismatches: { format: "chain-v2", sha256: createHash("sha256").update("[]").digest("hex"), head: null, count: 0 } } } }, {}]);
  await createMigrationStore(capture.client, harnessConfig, identity, input(), testBudget()).publishIfVerified(identity);
  const tx = capture.sent[1] as InstanceType<typeof TransactWriteCommand>; assert.ok(tx instanceof TransactWriteCommand);
  const gate = tx.input.TransactItems!.filter(action => action.Update?.Key?.sk === "PUBLICATION"); assert.equal(gate.length, 1);
  assert.equal(gate[0]!.Update!.ExpressionAttributeValues?.[":true"], true);
  assert.ok(tx.input.TransactItems!.some(action => action.Update?.ConditionExpression?.includes("#verification = :verification") && action.Update.ExpressionAttributeValues?.[":verified"] === "verified"));
});
void test("aws_image_put_is_conditional_and_caller_account_is_verified", async () => {
  const { createMigrationImagesStore, verifyMigrationCaller } = await import("../../scripts/operations/migration-store");
  const { harnessConfig } = await import("../support/stateful-store");
  const { PutObjectCommand } = await import("@aws-sdk/client-s3");
  const sent: unknown[] = []; const client = { async send(command: unknown) { sent.push(command); return { VersionId: "v1" }; } };
  const value = input(); const image = value.owners[0]!.images.values().next().value!;
  const job = { jobId: identity.runId, ownerId: "a".repeat(64), key: `images/${"a".repeat(64)}/${identity.runId}`, state: "pending" as const, createdAtMs: 0, updatedAtMs: 0 };
  await createMigrationImagesStore(client as unknown as import("@aws-sdk/client-s3").S3Client, harnessConfig).put(job, image, testBudget());
  const put = sent[0] as InstanceType<typeof PutObjectCommand>; assert.ok(put instanceof PutObjectCommand); assert.equal(put.input.IfNoneMatch, "*");
  const sts = { async send() { return { Account: "234567890123" }; } } as unknown as import("@aws-sdk/client-sts").STSClient;
  await assert.rejects(() => verifyMigrationCaller(sts, identity.environment.accountId, testBudget()));
  const { GetCallerIdentityCommand } = await import("@aws-sdk/client-sts");
  const matched = { async send(command: unknown, options: { abortSignal: AbortSignal }) {
    assert.ok(command instanceof GetCallerIdentityCommand); assert.ok(options.abortSignal); return { Account: "123456789012" };
  } } as unknown as import("@aws-sdk/client-sts").STSClient;
  await verifyMigrationCaller(matched, identity.environment.accountId, testBudget());
});

void test("explicit_cli_modes_require_same_inputs_run_id_and_use_only_injected_runtime", async () => {
  const { mkdtemp, rm, writeFile } = await import("node:fs/promises"); const { tmpdir } = await import("node:os"); const { join } = await import("node:path");
  const { migrationMain, parseMigrationTarget } = await import("../../scripts/operations/migrate-json");
  const { validateLegacy, contractSha256For } = await import("../../scripts/operations/legacy");
  const directory = await mkdtemp(join(tmpdir(), "o02-cli-synthetic-"));
  try {
    const targetValue = { accountId: "123456789012", region: "us-east-1", remindersTable: "reminders", ownerStateTable: "owners", imageJobsTable: "jobs", imagesBucket: "images", expectedApiId: "api123", expectedStage: "$default", issuer: "https://synthetic.invalid/pool", clientId: "client123" };
    const target = parseMigrationTarget(targetValue); const base = activeReminder();
    const source = JSON.stringify({ first: [{ id: base.id, url: base.url, title: base.title, reminderTime: base.reminderTime, autoOpen: false, webPush: true, hidden: false, createdAt: base.createdAt }] });
    const mapping = JSON.stringify([{ legacyKey: "first", issuer: target.issuer, sub: "subject" }]);
    const value = validateLegacy(source, JSON.parse(mapping), target); const fake = migrationHarness(value); let creations = 0;
    await writeFile(join(directory, "source.json"), source); await writeFile(join(directory, "map.json"), mapping); await writeFile(join(directory, "target.json"), JSON.stringify(targetValue));
    const argv = ["--source", join(directory, "source.json"), "--mapping", join(directory, "map.json"), "--config", join(directory, "target.json"), "--run-id", identity.runId];
    const output: string[] = []; const io = { stdout: (line: string) => { output.push(line); }, stderr: (line: string) => { output.push(line); } };
    const runtime = { async createDeps(_target: unknown, actual: MigrationIdentity) {
      creations++; assert.equal(actual.sourceSha256, createHash("sha256").update(source).digest("hex")); assert.equal(actual.mappingSha256, createHash("sha256").update(mapping).digest("hex")); assert.equal(actual.contractSha256, contractSha256For(target)); return fake.deps();
    } };
    assert.equal(await migrationMain(["--mode", "import", ...argv.filter((_part, index) => index < 6)], io, runtime), 2); assert.equal(creations, 0);
    assert.equal(await migrationMain(["--mode", "import", ...argv], io, runtime), 0);
    assert.equal(await migrationMain(["--mode", "verify", ...argv], io, runtime), 0);
    assert.equal((await fake.owners.gate(testBudget())).published, false);
    assert.equal(await migrationMain(["--mode", "publish", ...argv], io, runtime), 0); assert.equal((await fake.owners.gate(testBudget())).published, true);
    assert.equal(creations, 3); assert.doesNotMatch(output.join(""), /subject|example.test|Test reminder|first/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

void test("production_adapters_restart_after_each_unknown_write_with_exact_inventory", async () => {
  const { migrationAdapterHarness } = await import("../support/migration-store");
  for (const point of ["initialize", "stage", "put", "owner", "commit", "progress", "verify", "publish"]) {
    const value = input(); const harness = await migrationAdapterHarness(identity, value); harness.fail(point, "after");
    try { await importMigration(identity, value, harness.deps()); } catch { /* Reconstruct all production adapters from durable transport state. */ }
    const summary = await importMigration(identity, value, harness.deps()); assert.equal(summary.items, 2, point);
    const verification = await verifyMigration(identity, value, harness.deps()); assert.equal(verification.exactMatch, true, point);
    await publishMigration(identity, verification, harness.deps());
    assert.equal((await harness.deps().owners.gate(testBudget())).published, true, point); assert.equal(harness.versions, 1, point);
    const counters = harness.snapshot(identity.environment.ownerStateTable).filter(row => row.sk === "STORAGE");
    assert.equal(counters.reduce((total, row) => total + Number(row.itemCount), 0), 2, point); assert.equal(counters.reduce((total, row) => total + Number(row.imageBytes), 0), 12, point);
  }
});
void test("same_run_foreign_inventory_is_not_swallowed_as_initialization_timeout", async () => {
  const { migrationAdapterHarness } = await import("../support/migration-store"); const value = input(); const harness = await migrationAdapterHarness(identity, value);
  await importMigration(identity, value, harness.deps());
  harness.seed(identity.environment.ownerStateTable, { pk: `OWNER#${"d".repeat(64)}`, sk: "STORAGE", itemCount: 0, imageBytes: 0, migrationRunId: identity.runId });
  await assert.rejects(() => importMigration(identity, value, harness.deps()));
  await assert.rejects(() => verifyMigration(identity, value, harness.deps()));
  assert.equal((await harness.deps().owners.gate(testBudget())).published, false);
});
void test("production_image_corruption_records_safe_failure_and_revokes_publication", async () => {
  const { migrationAdapterHarness } = await import("../support/migration-store"); const value = input(); const harness = await migrationAdapterHarness(identity, value);
  await importMigration(identity, value, harness.deps()); assert.equal((await verifyMigration(identity, value, harness.deps())).exactMatch, true);
  harness.corruptImage(); const result = await verifyMigration(identity, value, harness.deps()); assert.equal(result.exactMatch, false);
  assert.equal((await harness.deps().migration.loadRun(identity.runId))?.verification?.exactMatch, false);
  await assert.rejects(() => publishMigration(identity, result, harness.deps()));
});
void test("production_head_checksum_mismatch_is_recorded_as_exact_match_false", async () => {
  const { migrationAdapterHarness } = await import("../support/migration-store"); const value = input(); const harness = await migrationAdapterHarness(identity, value);
  await importMigration(identity, value, harness.deps()); harness.corruptImageChecksum();
  const result = await verifyMigration(identity, value, harness.deps()); assert.equal(result.exactMatch, false);
  assert.deepEqual(result.mismatches, [{ location: "owners[0].items[0]", field: "thumbnail", reason: "IMAGE_BYTES_OR_SHA256" }]);
});
void test("production_midway_API503_and_verification_page_restart_keep_gate_false", async () => {
  const { migrationAdapterHarness } = await import("../support/migration-store"); const value = input(); const harness = await migrationAdapterHarness(identity, value);
  harness.failSecondCommit(); await assert.rejects(() => importMigration(identity, value, harness.deps()));
  assert.equal(harness.snapshot(identity.environment.remindersTable).length, 1);
  assert.equal((await harness.deps().owners.gate(testBudget())).published, false);
  assert.equal((await importMigration(identity, value, harness.deps())).items, 2); assert.equal(harness.versions, 1);
  const earlier = await verifyMigration(identity, value, harness.deps()); assert.equal(earlier.exactMatch, true);
  harness.fail("scan", "before"); await assert.rejects(() => publishMigration(identity, earlier, harness.deps()));
  assert.equal((await harness.deps().migration.loadRun(identity.runId))?.verification?.exactMatch, false);
  assert.equal((await harness.deps().owners.gate(testBudget())).published, false);
  assert.equal((await verifyMigration(identity, value, harness.deps())).exactMatch, true);
});
void test("production_original_image_mime_metadata_is_required_for_publication", async () => {
  const { migrationAdapterHarness } = await import("../support/migration-store"); const value = input(); const harness = await migrationAdapterHarness(identity, value);
  await importMigration(identity, value, harness.deps()); harness.corruptImageMime();
  const result = await verifyMigration(identity, value, harness.deps()); assert.equal(result.exactMatch, false);
  await assert.rejects(() => publishMigration(identity, result, harness.deps()));
});

function largeInput(): LegacyValidation {
  return { errors: [], owners: Array.from({ length: 8 }, (_owner, ownerPosition) => {
    const ownerId = String(ownerPosition + 1).repeat(64);
    return { ownerId, images: new Map(), items: Array.from({ length: 1000 }, (_item, itemPosition) => activeReminder({ ownerId, id: `item-${itemPosition}` })) };
  }) };
}
void test("large_progress_exceeding400KiB_hydrates_exactly_with_bounded_records", async () => {
  const { migrationAdapterHarness } = await import("../support/migration-store"); const value = largeInput(); const harness = await migrationAdapterHarness(identity, value);
  await prepareMigration(identity, harness.deps());
  const progress = { completedOwners: [0, 1, 2, 3, 4, 5, 6, 7], completedItems: value.owners.flatMap((owner, ownerPosition) => owner.items.map((_item, itemPosition) => ({ ownerPosition, itemPosition, imageId: null }))) };
  assert.ok(Buffer.byteLength(JSON.stringify(progress)) > 400 * 1024);
  await harness.deps().migration.saveProgress(identity.runId, progress);
  assert.deepEqual((await harness.deps().migration.loadRun(identity.runId))?.progress, progress);
  const rows = harness.snapshot(identity.environment.ownerStateTable); assert.ok(rows.length > 64);
  for (const row of rows) assert.ok(Buffer.byteLength(JSON.stringify(row)) <= 400 * 1024);
  assert.equal((await harness.deps().owners.gate(testBudget())).published, false);
});
void test("partial_chunk_failure_preserves_old_pointer_and_restart_uses_exact_chunks", async () => {
  const { migrationAdapterHarness } = await import("../support/migration-store"); const value = input(); const harness = await migrationAdapterHarness(identity, value);
  await prepareMigration(identity, harness.deps()); harness.failSecondChunk();
  const progress = { completedOwners: [0], completedItems: Array.from({ length: 150 }, (_item, itemPosition) => ({ ownerPosition: 0, itemPosition, imageId: null })) };
  await assert.rejects(() => harness.deps().migration.saveProgress(identity.runId, progress));
  assert.deepEqual((await harness.deps().migration.loadRun(identity.runId))?.progress, { completedOwners: [], completedItems: [] });
  await harness.deps().migration.saveProgress(identity.runId, progress);
  assert.deepEqual((await harness.deps().migration.loadRun(identity.runId))?.progress, progress);
  harness.fail("chunk", "after"); await harness.deps().migration.saveProgress(identity.runId, { ...progress, completedOwners: [0, 1] });
  assert.deepEqual((await harness.deps().migration.loadRun(identity.runId))?.progress, { ...progress, completedOwners: [0, 1] });
});
void test("missing_corrupt_and_wrong_run_chunks_fail_closed", async () => {
  const { migrationAdapterHarness } = await import("../support/migration-store");
  for (const mode of ["missing", "corrupt", "wrong-run", "wrong-content-valid-chunk-hash"]) {
    const value = input(); const harness = await migrationAdapterHarness(identity, value); await importMigration(identity, value, harness.deps());
    const rows = harness.snapshot(identity.environment.ownerStateTable);
    const root = rows.find(row => row.sk === `MIGRATION#${identity.runId}`)!;
    const head = (root.progress as { completedItems: { head: string } }).completedItems.head;
    const chunk = rows.find(row => row.chunkSha256 === head && row.kind === "completedItems"); assert.ok(chunk);
    if (mode === "missing") harness.remove(identity.environment.ownerStateTable, chunk);
    else if (mode === "wrong-content-valid-chunk-hash") {
      const values = structuredClone(chunk.values as Array<{ ownerPosition: number; itemPosition: number; imageId: string | null }>);
      values[0]!.itemPosition = 9999;
      const chunkSha256 = createHash("sha256").update(JSON.stringify({ migrationRunId: chunk.migrationRunId, kind: chunk.kind, index: chunk.index, previousSha256: chunk.previousSha256, values })).digest("hex");
      harness.remove(identity.environment.ownerStateTable, chunk);
      harness.seed(identity.environment.ownerStateTable, { ...chunk, sk: `MIGRATION#${identity.runId}#CHUNK#completedItems#${chunkSha256}`, values, chunkSha256 });
      const progress = root.progress as { completedItems: { head: string } }; progress.completedItems.head = chunkSha256;
      harness.seed(identity.environment.ownerStateTable, root);
    } else harness.seed(identity.environment.ownerStateTable, { ...chunk, ...(mode === "corrupt" ? { values: [] } : { migrationRunId: "00000000-0000-4000-8000-000000000002" }) });
    await assert.rejects(() => harness.deps().migration.loadRun(identity.runId), mode);
    await assert.rejects(() => verifyMigration(identity, value, harness.deps()), mode);
    assert.equal((await harness.deps().owners.gate(testBudget())).published, false);
  }
});
void test("large_failed_verification_retains_all_safe_mismatches_without_publication", async () => {
  const { migrationAdapterHarness } = await import("../support/migration-store"); const value = largeInput(); const harness = await migrationAdapterHarness(identity, value);
  await prepareMigration(identity, harness.deps());
  const result = await verifyMigration(identity, value, harness.deps()); assert.equal(result.exactMatch, false);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) > 400 * 1024); assert.ok(result.mismatches.length >= 8000);
  assert.deepEqual((await harness.deps().migration.loadRun(identity.runId))?.verification, result);
  for (const row of harness.snapshot(identity.environment.ownerStateTable)) assert.ok(Buffer.byteLength(JSON.stringify(row)) <= 400 * 1024);
  await assert.rejects(() => publishMigration(identity, result, harness.deps())); assert.equal((await harness.deps().owners.gate(testBudget())).published, false);
});
void test("canonical_chunk_hashes_accept_equivalent_mismatch_property_order", async () => {
  const { migrationAdapterHarness } = await import("../support/migration-store"); const value = input(); const harness = await migrationAdapterHarness(identity, value);
  await prepareMigration(identity, harness.deps());
  const verification = { identity, exactMatch: false, mismatches: [{ reason: "MISMATCH", field: "title", location: "owners[0].items[0]" }] };
  await harness.deps().migration.recordVerification(identity.runId, verification);
  assert.deepEqual((await harness.deps().migration.loadRun(identity.runId))?.verification, verification);
});

void test("bounded_budget_resume_advances_past_the_durable_completed_prefix", async () => {
  const { migrationAdapterHarness } = await import("../support/migration-store");
  const value: LegacyValidation = { errors: [], owners: [{ ownerId: "a".repeat(64), items: ["first", "second", "third"].map(id => activeReminder({ id })), images: new Map() }] };
  const harness = await migrationAdapterHarness(identity, value);
  function freshInvocation() {
    let remaining = 3;
    const budget = { signal: new AbortController().signal, remainingMs: () => remaining };
    const deps = harness.deps(budget); const get = deps.reminders.get.bind(deps.reminders);
    deps.reminders = { ...deps.reminders, async get(...args) { const result = await get(...args); remaining--; return result; } };
    return deps;
  }
  await assert.rejects(() => importMigration(identity, value, freshInvocation()));
  assert.equal(harness.snapshot(identity.environment.remindersTable).length, 2);
  assert.equal((await harness.deps().migration.loadRun(identity.runId))?.progress.completedItems.length, 2);
  const summary = await importMigration(identity, value, freshInvocation());
  assert.deepEqual(summary, { owners: 1, items: 3, imageBytes: 0, completed: true });
  assert.equal(harness.snapshot(identity.environment.remindersTable).length, 3);
  const verification = await verifyMigration(identity, value, harness.deps()); assert.equal(verification.exactMatch, true);
  const changed = harness.snapshot(identity.environment.remindersTable)[0]!;
  harness.seed(identity.environment.remindersTable, { ...changed, title: "synthetic changed after checkpoint" });
  assert.equal((await verifyMigration(identity, value, harness.deps())).exactMatch, false); // Skipping import work never skips final verification.
});
void test("failed_import_inventory_revokes_prior_success_before_adapter_publication", async () => {
  const { migrationAdapterHarness } = await import("../support/migration-store");
  for (const fault of ["foreignStorage", "scanFailure"]) {
    const value = input(); const harness = await migrationAdapterHarness(identity, value);
    await importMigration(identity, value, harness.deps()); assert.equal((await verifyMigration(identity, value, harness.deps())).exactMatch, true);
    const deps = harness.deps();
    if (fault === "foreignStorage") harness.seed(identity.environment.ownerStateTable, { pk: `OWNER#${"d".repeat(64)}`, sk: "STORAGE", itemCount: 0, imageBytes: 0, migrationRunId: identity.runId });
    else {
      const inventory = deps.migration.assertEmptyOrSameRun.bind(deps.migration);
      deps.migration = { ...deps.migration, async assertEmptyOrSameRun(...args) { harness.fail("scan", "before"); await inventory(...args); } };
    }
    await assert.rejects(() => importMigration(identity, value, deps));
    const run = await harness.deps().migration.loadRun(identity.runId); assert.notEqual(run?.phase, "verified"); assert.notEqual(run?.verification?.exactMatch, true);
    await assert.rejects(() => harness.deps().migration.publishIfVerified(identity));
    assert.equal((await harness.deps().owners.gate(testBudget())).published, false);
  }
});
void test("foreign_identity_and_published_imports_cannot_revoke_bound_run_state", async () => {
  const { migrationAdapterHarness } = await import("../support/migration-store"); const value = input(); const harness = await migrationAdapterHarness(identity, value);
  await importMigration(identity, value, harness.deps()); await verifyMigration(identity, value, harness.deps());
  await assert.rejects(() => importMigration({ ...identity, sourceSha256: "d".repeat(64) }, value, harness.deps()));
  assert.equal((await harness.deps().migration.loadRun(identity.runId))?.phase, "verified");
  await harness.deps().migration.publishIfVerified(identity);
  await assert.rejects(() => importMigration(identity, value, harness.deps()));
  assert.equal((await harness.deps().migration.loadRun(identity.runId))?.phase, "published");
  assert.equal((await harness.deps().owners.gate(testBudget())).published, true);
});
void test("incremental_checkpoints_reuse_sealed_prefix_with_linear_record_growth", async () => {
  const { migrationAdapterHarness } = await import("../support/migration-store");
  const value: LegacyValidation = { errors: [], owners: [{ ownerId: "a".repeat(64), items: Array.from({ length: 193 }, (_item, index) => activeReminder({ id: `item-${index}` })), images: new Map() }] };
  const harness = await migrationAdapterHarness(identity, value); const deps = harness.deps(); await prepareMigration(identity, deps);
  const progress = { completedOwners: [] as number[], completedItems: [] as Array<{ ownerPosition: number; itemPosition: number; imageId: string | null }> };
  for (let itemPosition = 0; itemPosition < 193; itemPosition++) { progress.completedItems.push({ ownerPosition: 0, itemPosition, imageId: null }); await deps.migration.saveProgress(identity.runId, progress); }
  const rows = harness.snapshot(identity.environment.ownerStateTable); const chunks = rows.filter(row => String(row.sk).includes("#CHUNK#completedItems#"));
  assert.equal(chunks.length, 193); // One new partial/sealed tail per append, rather than copies of every earlier block.
  const fullBlocks = chunks.filter(row => (row.values as unknown[]).length === 64); assert.equal(fullBlocks.length, 3);
  const { GetCommand } = await import("@aws-sdk/lib-dynamodb");
  const chunkReads = harness.sent.filter(command => command instanceof GetCommand && String(command.input.Key?.sk).includes("#CHUNK#"));
  assert.equal(chunkReads.length, 193 * 2); // Check each new immutable tail before/after writing, without rereading sealed prefixes.
  assert.deepEqual((await harness.deps().migration.loadRun(identity.runId))?.progress, progress);
  await deps.migration.saveProgress(identity.runId, progress); assert.equal(harness.snapshot(identity.environment.ownerStateTable).length, rows.length);
});
void test("chain_partial_tail_and_unknown_pointer_resume_without_prefix_duplicates", async () => {
  const { migrationAdapterHarness } = await import("../support/migration-store"); const value = input(); const harness = await migrationAdapterHarness(identity, value);
  await prepareMigration(identity, harness.deps());
  const entries = Array.from({ length: 65 }, (_item, itemPosition) => ({ ownerPosition: 0, itemPosition, imageId: null }));
  await harness.deps().migration.saveProgress(identity.runId, { completedOwners: [], completedItems: entries.slice(0, 63) });
  harness.fail("progress", "before"); await assert.rejects(() => harness.deps().migration.saveProgress(identity.runId, { completedOwners: [], completedItems: entries.slice(0, 64) }));
  assert.equal((await harness.deps().migration.loadRun(identity.runId))?.progress.completedItems.length, 63);
  await harness.deps().migration.saveProgress(identity.runId, { completedOwners: [], completedItems: entries.slice(0, 64) });
  harness.fail("progress", "after"); await harness.deps().migration.saveProgress(identity.runId, { completedOwners: [], completedItems: entries });
  assert.deepEqual((await harness.deps().migration.loadRun(identity.runId))?.progress.completedItems, entries);
  const blocks = harness.snapshot(identity.environment.ownerStateTable).filter(row => String(row.sk).includes("#CHUNK#completedItems#")); assert.equal(blocks.length, 3);
});
void test("broken_chunk_chain_fails_closed_even_with_a_valid_local_content_hash", async () => {
  const { migrationAdapterHarness } = await import("../support/migration-store"); const value = input(); const harness = await migrationAdapterHarness(identity, value);
  await prepareMigration(identity, harness.deps());
  await harness.deps().migration.saveProgress(identity.runId, { completedOwners: [], completedItems: Array.from({ length: 130 }, (_item, itemPosition) => ({ ownerPosition: 0, itemPosition, imageId: null })) });
  const rows = harness.snapshot(identity.environment.ownerStateTable); const root = rows.find(row => row.sk === `MIGRATION#${identity.runId}`)!;
  const manifest = root.progress as { completedItems: { head: string; count: number } }; assert.ok(manifest.completedItems?.head);
  const head = rows.find(row => row.chunkSha256 === manifest.completedItems.head)!; assert.ok(head.previousSha256);
  const previous = rows.find(row => row.chunkSha256 === head.previousSha256)!;
  harness.remove(identity.environment.ownerStateTable, previous);
  await assert.rejects(() => harness.deps().migration.loadRun(identity.runId));
  await assert.rejects(() => verifyMigration(identity, value, harness.deps()));
  assert.equal((await harness.deps().owners.gate(testBudget())).published, false);
});
