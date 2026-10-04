import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { ownerIdFor } from "../../src/api/identity";
import { keys, type ImagesStore } from "../../src/shared/ports";
import type { ImageJob, ImageRef } from "../../src/images/types";
import type { ActiveReminder, StoredReminder } from "../../src/reminders/types";
import { verifyRecovery, preserveRecoveryImages, remapRecoveryOwners, type RecoveryInput, type RecoveryStore, type RecoveryDeps } from "../../scripts/operations/recovery";
import { activeReminder, syntheticPngBytes, testBudget } from "../support/fixtures";
const issuer = "https://synthetic.invalid/pool";
const old = ownerIdFor(issuer, "old-sub"); const current = ownerIdFor(issuer, "new-sub");
const runId = "00000000-0000-4000-8000-000000000010";
const source = { accountId: "123456789012", region: "us-east-1", remindersTable: "live-reminders", ownerStateTable: "live-owners", imageJobsTable: "live-jobs", imagesBucket: "images", issuer };
const base: RecoveryInput = { source, restored: { ...source, remindersTable: "restored-reminders", ownerStateTable: "restored-owners", imageJobsTable: "restored-jobs" }, runId, ownerIdentities: [{ ownerId: old, issuer, sub: "old-sub" }] };
const ref: ImageRef = { imageId: "00000000-0000-4000-8000-000000000001", key: keys.image(old, "00000000-0000-4000-8000-000000000001"), versionId: "original-version", mime: "image/png", bytes: 12, sha256: createHash("sha256").update(syntheticPngBytes).digest("hex") };
function fixture(image = true) {
  let gate = { published: false, runId: null as string | null }; let sequence = 10; let failReplace = false;
  const items: StoredReminder[] = [activeReminder({ ownerId: old, thumbnail: image ? ref : null })];
  const owners = new Map([[old, { ownerId: old, itemCount: 1, imageBytes: image ? 12 : 0 }]]);
  const jobs = new Map<string, ImageJob>(image ? [[ref.imageId, { jobId: ref.imageId, ownerId: old, key: ref.key, versionId: ref.versionId, mime: ref.mime, bytes: ref.bytes, sha256: ref.sha256, state: "committed", createdAtMs: 0, updatedAtMs: 0 }]] : []);
  const objects = new Map([[ref.key + ":" + ref.versionId, { ref, data: Buffer.from(syntheticPngBytes) }]]);
  const currentVersions = new Map([[ref.key, "newer-version"]]);
  const intents = new Map<string, ImageJob>();
  const store: RecoveryStore = {
    async bindRun(_input, mapping) { for (const pair of mapping) { const from = ownerIdFor(pair.oldIssuer, pair.oldSub); const to = ownerIdFor(pair.newIssuer, pair.newSub); if (owners.has(from) && owners.has(to)) throw new Error("collision"); const count = items.filter(item => item.ownerId === from && !item.deleted).length; if (owners.has(from) && owners.get(from)!.itemCount !== count) throw new Error("counter"); } },
    async hasIncompleteRemap() { return false; },
    async *listJobs() { yield* structuredClone([...jobs.values()]); },
    async stageImageReplacement(previous, target) { const token = previous.thumbnail!.imageId + target; let job = intents.get(token); if (!job) { const jobId = `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}`; job = { jobId, ownerId: target, key: keys.image(target, jobId), state: "pending", createdAtMs: 1000, updatedAtMs: 1000 }; intents.set(token, job); jobs.set(jobId, job); } return job; },
    async gate() { return { ...gate }; }, async prepareUnpublished(id) { gate = { published: false, runId: id }; },
    async *listItems() { yield* structuredClone(items); }, async *listOwners() { yield* structuredClone([...owners.values()]); }, async getJob(id) { return structuredClone(jobs.get(id) ?? null); },
    async replaceImage(previous, next, job) { if (failReplace) { failReplace = false; throw new Error("synthetic interrupted"); } const index = items.findIndex(value => value.ownerId === previous.ownerId && value.id === previous.id); assert.deepEqual(items[index], previous); items[index] = next; jobs.set(job.jobId, job); jobs.get(previous.thumbnail!.imageId)!.state = "done"; },
    async remapOwner(from, to) { assert.equal(owners.has(to), false); for (let index = 0; index < items.length; index++) if (items[index]!.ownerId === from) items[index] = { ...items[index]!, ownerId: to }; const row = owners.get(from)!; owners.set(to, { ...row, ownerId: to }); owners.delete(from); }, async saveReport() {},
  };
  const images: ImagesStore = {
    async head(key, version) { const id = version ?? currentVersions.get(key); const object = objects.get(key + ":" + id); return object ? { versionId: object.ref.versionId, sha256: object.ref.sha256, deleteMarker: false } : null; },
    async get(value) { const object = objects.get(value.key + ":" + value.versionId); if (!object) throw new Error("missing"); return Buffer.from(object.data); },
    async put(job, image) { assert.equal(currentVersions.has(job.key), false); const value = { imageId: job.jobId, key: job.key, versionId: "copied-version", mime: image.mime, bytes: image.bytes, sha256: image.sha256 }; objects.set(job.key + ":" + value.versionId, { ref: value, data: Buffer.from(image.data) }); currentVersions.set(job.key, value.versionId); return value; },
    async signGet() { throw new Error("forbidden"); }, async markDeleted() { throw new Error("forbidden"); }, async probe() {},
  };
  const deps: RecoveryDeps = { restored: store, sourceImages: { ...images, async put() { throw new Error("source write forbidden"); } }, restoredImages: images, budget: testBudget(), clock: () => 1000, uuid: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}` };
  return { deps, store, items, owners, jobs, objects, currentVersions, interrupt() { failReplace = true; }, setGate(published: boolean) { gate.published = published; } };
}
void test("same_username_new_sub_never_auto_maps", async () => {
  assert.notEqual(old, current); const fake = fixture(false);
  const report = await verifyRecovery({ ...base, ownerIdentities: [{ ownerId: old, issuer, sub: "new-sub" }] }, fake.deps);
  assert.equal(report.readyToSwitch, false); assert.equal(report.mismatchedOwners.length, 1);
  assert.equal(fake.items[0]!.ownerId, old); assert.doesNotMatch(JSON.stringify(report), /old-sub|new-sub|https|Test reminder/);
  assert.ok(report.cognitoCredentialsRestored === false);
});
void test("copies_noncurrent_bytes_to_unique_current_key", async () => {
  const fake = fixture(); assert.equal((await verifyRecovery(base, fake.deps)).readyToSwitch, false);
  const result = await preserveRecoveryImages(base, fake.deps); assert.equal(result.readyToSwitch, true);
  const item = fake.items[0] as ActiveReminder; assert.ok(item.thumbnail); assert.notEqual(item.thumbnail.key, ref.key);
  assert.deepEqual(fake.objects.get(item.thumbnail.key + ":" + item.thumbnail.versionId)!.data, syntheticPngBytes);
  assert.equal(item.createdAt, "2026-10-01T00:00:00.000Z"); assert.equal(item.revision, 1);
  assert.equal((await preserveRecoveryImages(base, fake.deps)).readyToSwitch, true); assert.equal(fake.objects.size, 2);
});
void test("recovery_never_updates_live_tables_and_rejects_shared_target", async () => {
  const fake = fixture(); const before = structuredClone(fake.objects.get(ref.key + ":" + ref.versionId));
  await preserveRecoveryImages(base, fake.deps); assert.deepEqual(structuredClone(fake.objects.get(ref.key + ":" + ref.versionId)), before);
  for (const field of ["remindersTable", "ownerStateTable", "imageJobsTable"] as const) await assert.rejects(() => verifyRecovery({ ...base, restored: { ...base.restored, [field]: source[field] } }, fake.deps));
  fake.setGate(true); await assert.rejects(() => verifyRecovery(base, fake.deps));
});
void test("missing_version_or_bad_checksum_blocks_switch", async () => {
  for (const missing of [true, false]) { const fake = fixture(); if (missing) fake.objects.clear(); else fake.objects.get(ref.key + ":" + ref.versionId)!.data[11] = 99;
    const report = await verifyRecovery(base, fake.deps); assert.equal(report.readyToSwitch, false); assert.ok(report.missingImages.length > 0);
    const before = structuredClone(fake.items); await assert.rejects(() => preserveRecoveryImages(base, fake.deps)); assert.deepEqual(fake.items, before); }
});
void test("interrupted_preservation_resumes_without_changing_source_or_publishing", async () => {
  const fake = fixture(); fake.interrupt(); await assert.rejects(() => preserveRecoveryImages(base, fake.deps));
  assert.equal((await fake.store.gate(testBudget())).published, false); assert.equal((fake.items[0] as ActiveReminder).thumbnail!.key, ref.key);
  assert.equal((await preserveRecoveryImages(base, fake.deps)).readyToSwitch, true);
});
void test("explicit_remap_checks_target_collisions_and_counters", async () => {
  const input = { ...base, ownerIdentities: [{ ownerId: current, issuer, sub: "new-sub" }] }; const map = [{ oldIssuer: issuer, oldSub: "old-sub", newIssuer: issuer, newSub: "new-sub" }];
  const fake = fixture(false); const report = await remapRecoveryOwners(input, map, fake.deps); assert.equal(report.readyToSwitch, true); assert.equal(fake.items[0]!.ownerId, current); assert.equal(fake.owners.get(current)!.itemCount, 1); assert.equal((await fake.store.gate(testBudget())).published, false);
  const collision = fixture(false); collision.owners.set(current, { ownerId: current, itemCount: 0, imageBytes: 0 }); await assert.rejects(() => remapRecoveryOwners(input, map, collision.deps)); assert.equal(collision.items[0]!.ownerId, old);
  const bad = fixture(false); bad.owners.get(old)!.itemCount = 2; await assert.rejects(() => remapRecoveryOwners(input, map, bad.deps)); assert.equal(bad.items[0]!.ownerId, old);
});
void test("bad_job_GSI_empty_owner_or_missing_counter_blocks_switch", async () => {
  for (const corruption of ["gsi", "job", "counter", "empty-owner"] as const) { const fake = fixture(); fake.currentVersions.set(ref.key, ref.versionId);
    if (corruption === "gsi") fake.jobs.get(ref.imageId)!.cleanupPartition = "pending#00";
    if (corruption === "job") fake.jobs.get(ref.imageId)!.bytes = 13;
    if (corruption === "counter") fake.owners.clear();
    if (corruption === "empty-owner") fake.owners.set(current, { ownerId: current, itemCount: 0, imageBytes: 0 });
    assert.equal((await verifyRecovery(base, fake.deps)).readyToSwitch, false, corruption); }
});
void test("default_verify_is_read_only_and_orphan_committed_jobs_block_switch", async () => {
  const fake = fixture(false); fake.store.saveReport = async () => { throw new Error("verify must not persist"); };
  assert.equal((await verifyRecovery(base, fake.deps)).readyToSwitch, true);
  fake.jobs.set(ref.imageId, { jobId: ref.imageId, ownerId: old, key: ref.key, versionId: ref.versionId, mime: ref.mime, bytes: ref.bytes, sha256: ref.sha256, state: "committed", createdAtMs: 0, updatedAtMs: 0 });
  const report = await verifyRecovery(base, fake.deps); assert.equal(report.readyToSwitch, false); assert.equal(report.unresolvedJobs.length, 1);
});

// Stateful SDK transport: mutations, conditions and pagination are exercised by the real adapter.
function transport() {
  type Row = Record<string, unknown>;
  const tables = new Map<string, Map<string, Row>>(); const sent: unknown[] = []; let timeoutAt = -1; let writes = 0;
  const rowKey = (row: Row): string => JSON.stringify(row.pk ? [row.pk, row.sk] : row.jobId ? [row.jobId] : [row.ownerId, row.id]);
  const table = (name: string): Map<string, Row> => { if (!tables.has(name)) tables.set(name, new Map()); return tables.get(name)!; };
  function condition(row: Row | undefined, expression: string | undefined, names: Record<string, string> = {}, values: Row = {}): boolean {
    if (!expression) return true;
    return expression.split(" AND ").every(part => {
      const absent = /^attribute_not_exists\((#\w+)\)$/.exec(part); if (absent) return row?.[names[absent[1]!]!] === undefined;
      const equal = /^(#\w+) = (:\w+)$/.exec(part); if (equal) { try { assert.deepEqual(row?.[names[equal[1]!]!], values[equal[2]!]); return true; } catch { return false; } }
      throw new Error("unhandled synthetic condition " + part);
    });
  }
  const client = { async send(command: unknown) {
    const { GetCommand, ScanCommand, TransactWriteCommand } = await import("@aws-sdk/lib-dynamodb"); sent.push(command);
    if (command instanceof GetCommand) { const row = table(command.input.TableName!).get(rowKey(command.input.Key!)); return row ? { Item: structuredClone(row) } : {}; }
    if (command instanceof ScanCommand) {
      const rows = [...table(command.input.TableName!).values()].sort((a, b) => rowKey(a).localeCompare(rowKey(b)));
      const start = command.input.ExclusiveStartKey ? rows.findIndex(row => rowKey(row) === rowKey(command.input.ExclusiveStartKey!)) + 1 : 0;
      const page = rows.slice(start, start + 2); const last = page.at(-1); const key = last?.pk ? { pk: last.pk, sk: last.sk } : last?.jobId ? { jobId: last.jobId } : last ? { ownerId: last.ownerId, id: last.id } : null;
      return { Items: structuredClone(page), ...(start + page.length < rows.length && key ? { LastEvaluatedKey: key } : {}) };
    }
    if (command instanceof TransactWriteCommand) {
      const changes: Array<() => void> = []; const unique = new Set<string>();
      for (const action of command.input.TransactItems!) {
        const op = action.Put ?? action.Update ?? action.Delete ?? action.ConditionCheck!; const name = op.TableName!;
        const key = rowKey(action.Put ? action.Put.Item! : (action.Update ?? action.Delete ?? action.ConditionCheck!).Key!);
        assert.equal(unique.has(name + key), false); unique.add(name + key);
        const row = table(name).get(key);
        if (!condition(row, op.ConditionExpression, op.ExpressionAttributeNames, op.ExpressionAttributeValues)) throw Object.assign(new Error("condition"), { name: "TransactionCanceledException" });
        if (action.Put) { assert.ok(Buffer.byteLength(JSON.stringify(action.Put.Item)) <= 409_600, "synthetic DynamoDB item exceeds 400KiB"); changes.push(() => table(name).set(key, structuredClone(action.Put!.Item!))); }
        if (action.Delete) changes.push(() => table(name).delete(key));
        if (action.Update) {
          const update = action.Update; const next = { ...row, ...update.Key }; const names = update.ExpressionAttributeNames!; const values = update.ExpressionAttributeValues!;
          const [set, remove] = update.UpdateExpression!.replace(/^SET /, "").split(" REMOVE ");
          for (const clause of set!.split(", ")) { const match = /^(#\w+) = (:\w+)$/.exec(clause); if (!match) throw new Error("unsupported synthetic update"); next[names[match[1]!]!] = values[match[2]!]; }
          for (const alias of remove?.split(", ") ?? []) delete next[names[alias]!]; assert.ok(Buffer.byteLength(JSON.stringify(next)) <= 409_600, "synthetic DynamoDB item exceeds 400KiB"); changes.push(() => table(name).set(key, structuredClone(next)));
        }
      }
      changes.forEach(change => change()); if (++writes === timeoutAt) throw new Error("synthetic post-commit timeout"); return {};
    }
    throw new Error("unsupported SDK command");
  } } as unknown as import("@aws-sdk/lib-dynamodb").DynamoDBDocumentClient;
  return { client, sent, seed(name: string, row: Row) { table(name).set(rowKey(row), structuredClone(row)); }, snapshot() { return structuredClone([...tables].map(([name, rows]) => [name, [...rows.values()]])); }, timeoutNext() { timeoutAt = writes + 1; }, timeoutWrite(number: number) { timeoutAt = number; }, table };
}
async function adapterFixture(image = true) {
  const { createRecoveryStore } = await import("../../scripts/operations/recovery"); const { harnessConfig } = await import("../support/stateful-store");
  const fake = fixture(image); const db = transport();
  db.seed(base.restored.remindersTable, fake.items[0]! as unknown as Record<string, unknown>);
  db.seed(base.restored.ownerStateTable, { ...keys.storage(old), itemCount: 1, imageBytes: image ? 12 : 0 });
  db.seed(base.restored.ownerStateTable, { ...keys.publication, published: false, runId: null });
  for (const job of fake.jobs.values()) db.seed(base.restored.imageJobsTable, job as unknown as Record<string, unknown>);
  db.seed(source.remindersTable, { syntheticLiveRecord: "unchanged", ownerId: old, id: "live" });
  const config = { ...harnessConfig, ...base.restored };
  const deps = fake.deps;
  const make = (input = base, limits = config.limits) => createRecoveryStore(db.client, { ...config, limits }, input, { sourceImages: deps.sourceImages, restoredImages: deps.restoredImages, clock: deps.clock, uuid: deps.uuid }, deps.budget);
  return { db, fake, config, make, deps: { ...deps, restored: make() } };
}
void test("aws_preservation_intent_survives_unknown_Put_and_checkpoint_timeout", async () => {
  const f = await adapterFixture(); const originalPut = f.deps.restoredImages.put; let first = true;
  f.deps.restoredImages.put = async (...args) => { const value = await originalPut(...args); if (first) { first = false; throw new Error("post-Put timeout"); } return value; };
  await assert.rejects(() => preserveRecoveryImages(base, f.deps));
  const stages = [...f.db.table(base.restored.ownerStateTable).values()].filter(row => String(row.sk).includes("#IMAGE#")); assert.equal(stages.length, 1);
  const pending = [...f.db.table(base.restored.imageJobsTable).values()].filter(row => row.state === "pending"); assert.equal(pending.length, 1); assert.ok(pending[0]!.cleanupPartition);
  const restarted = { ...f.deps, restored: f.make() }; assert.equal((await preserveRecoveryImages(base, restarted)).readyToSwitch, true); assert.equal(f.fake.objects.size, 2);
  const restored = [...f.db.table(base.restored.remindersTable).values()][0]!; assert.notEqual((restored.thumbnail as ImageRef).key, ref.key);
  assert.equal([...f.db.table(source.remindersTable).values()][0]!.syntheticLiveRecord, "unchanged");
});
void test("aws_remap_copies_target_owner_keys_preserves_counters_and_restarts", async () => {
  const f = await adapterFixture(); const input = { ...base, ownerIdentities: [{ ownerId: current, issuer, sub: "new-sub" }] }; const mapping = [{ oldIssuer: issuer, oldSub: "old-sub", newIssuer: issuer, newSub: "new-sub" }];
  const deps = { ...f.deps, restored: f.make(input) }; f.db.timeoutNext(); await assert.rejects(() => remapRecoveryOwners(input, mapping, deps));
  const report = await remapRecoveryOwners(input, mapping, { ...deps, restored: f.make(input) }); assert.equal(report.readyToSwitch, true);
  const rows = [...f.db.table(base.restored.remindersTable).values()]; assert.equal(rows.length, 1); assert.equal(rows[0]!.ownerId, current); assert.ok((rows[0]!.thumbnail as ImageRef).key.startsWith(`images/${current}/`));
  const counters = [...f.db.table(base.restored.ownerStateTable).values()].filter(row => row.sk === "STORAGE"); assert.deepEqual(counters, [{ ...keys.storage(current), itemCount: 1, imageBytes: 12 }]);
  assert.equal((await verifyRecovery(input, { ...deps, restored: f.make(input) })).readyToSwitch, true); assert.equal((await deps.restored.gate(testBudget())).published, false);
});
void test("aws_all_remap_collision_and_quota_checks_precede_image_copies", async () => {
  for (const bad of ["collision", "quota", "counter"] as const) {
    const f = await adapterFixture(); const input = { ...base, ownerIdentities: [{ ownerId: current, issuer, sub: "new-sub" }] }; const mapping = [{ oldIssuer: issuer, oldSub: "old-sub", newIssuer: issuer, newSub: "new-sub" }];
    if (bad === "collision") f.db.seed(base.restored.ownerStateTable, { ...keys.storage(current), itemCount: 0, imageBytes: 0 });
    if (bad === "counter") f.db.seed(base.restored.ownerStateTable, { ...keys.storage(old), itemCount: 2, imageBytes: 12 });
    const limits = { ...f.config.limits, imageBytes: bad === "quota" ? 11 : f.config.limits.imageBytes };
    await assert.rejects(() => remapRecoveryOwners(input, mapping, { ...f.deps, restored: f.make(input, limits) })); assert.equal(f.fake.objects.size, 1);
    assert.equal([...f.db.table(base.restored.remindersTable).values()][0]!.ownerId, old);
  }
});
void test("aws_changed_identity_or_mapping_aborts_and_verify_emits_no_mutations", async () => {
  const f = await adapterFixture(false); const { GetCommand, ScanCommand } = await import("@aws-sdk/lib-dynamodb");
  assert.equal((await verifyRecovery(base, f.deps)).readyToSwitch, true); assert.ok(f.db.sent.every(command => command instanceof GetCommand || command instanceof ScanCommand));
  await preserveRecoveryImages(base, f.deps);
  const changed = { ...base, ownerIdentities: [{ ownerId: old, issuer, sub: "different" }] };
  await assert.rejects(() => preserveRecoveryImages(changed, { ...f.deps, restored: f.make(changed) }));
});
void test("aws_every_remap_checkpoint_resumes_and_keeps_live_tables_and_original_version", async () => {
  const input = { ...base, ownerIdentities: [{ ownerId: current, issuer, sub: "new-sub" }] }; const mapping = [{ oldIssuer: issuer, oldSub: "old-sub", newIssuer: issuer, newSub: "new-sub" }];
  for (let checkpoint = 1; checkpoint <= 10; checkpoint++) {
    const f = await adapterFixture(); const liveBefore = structuredClone([...f.db.table(source.remindersTable).values()]); const bytesBefore = Buffer.from(f.fake.objects.get(ref.key + ":" + ref.versionId)!.data);
    f.db.timeoutWrite(checkpoint); const deps = { ...f.deps, restored: f.make(input) };
    await assert.rejects(() => remapRecoveryOwners(input, mapping, deps), `checkpoint ${checkpoint}`);
    assert.deepEqual([...f.db.table(source.remindersTable).values()], liveBefore); assert.deepEqual(f.fake.objects.get(ref.key + ":" + ref.versionId)!.data, bytesBefore);
    assert.equal((await deps.restored.gate(testBudget())).published, false);
    assert.equal((await remapRecoveryOwners(input, mapping, { ...deps, restored: f.make(input) })).readyToSwitch, true, `checkpoint ${checkpoint}`);
    assert.equal(f.fake.objects.size, 2);
  }
});
void test("resuming_copied_owner_reverifies_all_fields_before_old_records_are_removed", async () => {
  const f = await adapterFixture(); const input = { ...base, ownerIdentities: [{ ownerId: current, issuer, sub: "new-sub" }] }; const mapping = [{ oldIssuer: issuer, oldSub: "old-sub", newIssuer: issuer, newSub: "new-sub" }];
  f.db.timeoutWrite(7); await assert.rejects(() => remapRecoveryOwners(input, mapping, { ...f.deps, restored: f.make(input) }));
  const target = [...f.db.table(base.restored.remindersTable).values()].find(row => row.ownerId === current)!; target.title = "synthetic corruption";
  await assert.rejects(() => remapRecoveryOwners(input, mapping, { ...f.deps, restored: f.make(input) }));
  assert.ok([...f.db.table(base.restored.remindersTable).values()].some(row => row.ownerId === old));
});
void test("recovery_cli_requires_private_identity_inputs_and_only_explicit_flags_write", async () => {
  const { recoveryMain } = await import("../../scripts/operations/verify-recovery"); const { mkdtemp, writeFile, rm } = await import("node:fs/promises"); const { tmpdir } = await import("node:os"); const { join } = await import("node:path"); const { harnessConfig } = await import("../support/stateful-store");
  const dir = await mkdtemp(join(tmpdir(), "synthetic-recovery-")); const output: string[] = []; const error: string[] = []; let creates = 0;
  const fake = fixture(false); const runtime = { async createDeps() { creates++; return fake.deps; } }; const io = { stdout: (line: string) => output.push(line), stderr: (line: string) => error.push(line) };
  try {
    for (const [name, value] of [["source", { ...harnessConfig, ...source }], ["target", { ...harnessConfig, ...base.restored }], ["identities", base.ownerIdentities]] as const) await writeFile(join(dir, name), JSON.stringify(value));
    const argv = ["--source-config", join(dir, "source"), "--restored-config", join(dir, "target"), "--owner-identities", join(dir, "identities"), "--run-id", runId];
    assert.equal(await recoveryMain(argv.slice(0, 4), io, runtime), 2); assert.equal(creates, 0);
    fake.store.bindRun = async () => { throw new Error("default must not bind"); }; fake.store.saveReport = async () => { throw new Error("default must not persist"); };
    assert.equal(await recoveryMain(argv, io, runtime), 0); assert.equal(JSON.parse(output.at(-1)!).readyToSwitch, true);
    fake.setGate(true); assert.equal(await recoveryMain(argv, io, runtime), 2); assert.equal((await fake.store.gate(testBudget())).published, true);
    fake.store.bindRun = async () => {}; fake.store.saveReport = async () => {};
    assert.equal(await recoveryMain([...argv, "--prepare-restored"], io, runtime), 0); assert.equal((await fake.store.gate(testBudget())).published, false);
    await writeFile(join(dir, "target"), JSON.stringify({ ...harnessConfig, ...source })); const count = creates;
    assert.equal(await recoveryMain([...argv, "--prepare-restored"], io, runtime), 2); assert.equal(creates, count);
    assert.doesNotMatch(output.join("") + error.join(""), /old-sub|Test reminder|synthetic.invalid|original-version/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
void test("valid_source_bytes_cannot_mask_corrupt_current_restored_object", async () => {
  const f = fixture(); f.currentVersions.set(ref.key, ref.versionId);
  f.deps.restoredImages = { ...f.deps.restoredImages, async get() { throw new Error("corrupt restored object"); } };
  assert.equal((await verifyRecovery(base, f.deps)).readyToSwitch, false);
});
void test("new_recovery_UUID_cannot_reuse_an_existing_matching_object", async () => {
  const f = await adapterFixture(); const imageId = "00000000-0000-4000-8000-000000000011"; const key = keys.image(old, imageId);
  const existing = { ...ref, imageId, key, versionId: "foreign-version" }; f.fake.objects.set(key + ":foreign-version", { ref: existing, data: Buffer.from(syntheticPngBytes) }); f.fake.currentVersions.set(key, existing.versionId);
  await assert.rejects(() => preserveRecoveryImages(base, f.deps));
  const item = [...f.db.table(base.restored.remindersTable).values()][0]!; assert.deepEqual(item.thumbnail, ref);
});
void test("read_only_verify_blocks_unfinished_remap_even_with_two_valid_owner_identities", async () => {
  const f = await adapterFixture(); f.fake.currentVersions.set(ref.key, ref.versionId);
  const input = { ...base, ownerIdentities: [...base.ownerIdentities, { ownerId: current, issuer, sub: "new-sub" }] }; const mapping = [{ oldIssuer: issuer, oldSub: "old-sub", newIssuer: issuer, newSub: "new-sub" }];
  f.db.timeoutWrite(7); await assert.rejects(() => remapRecoveryOwners(input, mapping, { ...f.deps, restored: f.make(input) }));
  const before = f.db.snapshot(); const report = await verifyRecovery(input, { ...f.deps, restored: f.make(input) });
  assert.equal(report.readyToSwitch, false); assert.ok(report.unresolvedJobs.some(value => value.reason === "INCOMPLETE_REMAP")); assert.deepEqual(f.db.snapshot(), before);
});
void test("different_run_id_cannot_hide_unfinished_restored_owner_markers", async () => {
  const f = await adapterFixture(); f.fake.currentVersions.set(ref.key, ref.versionId);
  const input = { ...base, ownerIdentities: [...base.ownerIdentities, { ownerId: current, issuer, sub: "new-sub" }] }; const mapping = [{ oldIssuer: issuer, oldSub: "old-sub", newIssuer: issuer, newSub: "new-sub" }];
  f.db.timeoutWrite(7); await assert.rejects(() => remapRecoveryOwners(input, mapping, { ...f.deps, restored: f.make(input) }));
  const changed = { ...input, runId: "00000000-0000-4000-8000-000000000020" }; const before = f.db.snapshot();
  const report = await verifyRecovery(changed, { ...f.deps, restored: f.make(changed) }); assert.equal(report.readyToSwitch, false); assert.deepEqual(f.db.snapshot(), before);
});
void test("default_1000_item_owner_progress_above_400KiB_is_kept_in_bounded_individual_rows", async () => {
  const f = await adapterFixture(false); f.db.table(base.restored.remindersTable).clear();
  for (let index = 0; index < 1000; index++) f.db.seed(base.restored.remindersTable, activeReminder({ ownerId: old, id: `synthetic-${String(index).padStart(4, "0")}`, title: "x".repeat(1024) }) as unknown as Record<string, unknown>);
  f.db.seed(base.restored.ownerStateTable, { ...keys.storage(old), itemCount: 1000, imageBytes: 0 });
  const input = { ...base, ownerIdentities: [{ ownerId: current, issuer, sub: "new-sub" }] }; const mapping = [{ oldIssuer: issuer, oldSub: "old-sub", newIssuer: issuer, newSub: "new-sub" }];
  const deps = { ...f.deps, budget: { signal: new AbortController().signal, remainingMs: () => 900_000 } }; const { createRecoveryStore } = await import("../../scripts/operations/recovery");
  const restored = createRecoveryStore(f.db.client, f.config, input, { sourceImages: deps.sourceImages, restoredImages: deps.restoredImages, clock: deps.clock, uuid: deps.uuid }, deps.budget);
  const result = await remapRecoveryOwners(input, mapping, { ...deps, restored }); assert.equal(result.readyToSwitch, true); assert.equal(result.matched, 1000);
  const records = [...f.db.table(base.restored.ownerStateTable).values()].filter(row => String(row.sk).includes("#ITEM#")); assert.equal(records.length, 1000); assert.ok(Buffer.byteLength(JSON.stringify(records)) > 409_600);
  const counter = [...f.db.table(base.restored.ownerStateTable).values()].find(row => row.pk === `OWNER#${current}`)!; assert.equal(counter.itemCount, 1000); assert.equal(counter.imageBytes, 0);
});
void test("explicit_historical_issuer_mapping_does_not_require_current_source_pool_identity", async () => {
  const f = await adapterFixture(false); const input = { ...base, source: { ...base.source, issuer: "https://synthetic.invalid/recreated-pool" }, ownerIdentities: [{ ownerId: current, issuer, sub: "new-sub" }] };
  const map = [{ oldIssuer: issuer, oldSub: "old-sub", newIssuer: issuer, newSub: "new-sub" }];
  assert.equal((await remapRecoveryOwners(input, map, { ...f.deps, restored: f.make(input) })).readyToSwitch, true);
});
void test("second_mapping_collision_prevents_first_owner_image_copy", async () => {
  const f = await adapterFixture(); const secondOld = ownerIdFor(issuer, "second-old"); const secondNew = ownerIdFor(issuer, "second-new");
  f.db.seed(base.restored.ownerStateTable, { ...keys.storage(secondOld), itemCount: 0, imageBytes: 0 }); f.db.seed(base.restored.ownerStateTable, { ...keys.storage(secondNew), itemCount: 0, imageBytes: 0 });
  const input = { ...base, ownerIdentities: [{ ownerId: current, issuer, sub: "new-sub" }, { ownerId: secondNew, issuer, sub: "second-new" }] };
  const mapping = [{ oldIssuer: issuer, oldSub: "old-sub", newIssuer: issuer, newSub: "new-sub" }, { oldIssuer: issuer, oldSub: "second-old", newIssuer: issuer, newSub: "second-new" }];
  await assert.rejects(() => remapRecoveryOwners(input, mapping, { ...f.deps, restored: f.make(input) })); assert.equal(f.fake.objects.size, 1); assert.equal([...f.db.table(base.restored.remindersTable).values()][0]!.ownerId, old);
});
void test("bound_mapping_or_effective_limits_cannot_change_on_restart", async () => {
  const f = await adapterFixture(false); const secondOld = ownerIdFor(issuer, "second-old"); const secondNew = ownerIdFor(issuer, "second-new");
  f.db.seed(base.restored.ownerStateTable, { ...keys.storage(secondOld), itemCount: 0, imageBytes: 0 });
  const input = { ...base, ownerIdentities: [{ ownerId: current, issuer, sub: "new-sub" }, { ownerId: secondNew, issuer, sub: "second-new" }] };
  const mapping = [{ oldIssuer: issuer, oldSub: "old-sub", newIssuer: issuer, newSub: "new-sub" }, { oldIssuer: issuer, oldSub: "second-old", newIssuer: issuer, newSub: "second-new" }];
  f.db.timeoutNext(); await assert.rejects(() => remapRecoveryOwners(input, mapping, { ...f.deps, restored: f.make(input) }));
  const before = f.db.snapshot(); await assert.rejects(() => remapRecoveryOwners(input, [...mapping].reverse(), { ...f.deps, restored: f.make(input) })); assert.deepEqual(f.db.snapshot(), before);
  await assert.rejects(() => remapRecoveryOwners(input, mapping, { ...f.deps, restored: f.make(input, { ...f.config.limits, itemCount: 999 }) })); assert.deepEqual(f.db.snapshot(), before);
});
void test("explicit_prepare_can_create_missing_restored_gate_and_never_touches_live_gate", async () => {
  const f = await adapterFixture(false); f.db.table(base.restored.ownerStateTable).delete(JSON.stringify(["GLOBAL", "PUBLICATION"]));
  f.db.seed(source.ownerStateTable, { ...keys.publication, published: true, runId: "synthetic-live-run" });
  await f.deps.restored.prepareUnpublished(runId, f.deps.budget);
  assert.deepEqual(await f.deps.restored.gate(f.deps.budget), { published: false, runId });
  assert.equal([...f.db.table(source.ownerStateTable).values()][0]!.published, true);
});
