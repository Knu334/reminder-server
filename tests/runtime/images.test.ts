import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { decodeThumbnail } from "../../src/images/validation";
import { createHarness, harnessConfig } from "../support/stateful-store";
import { syntheticPngBase64, syntheticPngBytes, testBudget, validCreate } from "../support/fixtures";

const unavailable = { status: 503, code: "SERVICE_UNAVAILABLE" };
function sizedPng(bytes: number): Buffer { const data = Buffer.alloc(bytes, 42); syntheticPngBytes.copy(data); return data; }

void test("preserves_image_bytes_and_checksum", async () => {
  const h = createHarness();
  const created = await h.service.create("owner-a", validCreate({ thumbnail: syntheticPngBase64 }), testBudget());
  assert.deepEqual(created.dto.thumbnail, { imageId: "00000000-0000-4000-8000-000000000001", mime: "image/png", bytes: syntheticPngBytes.length, sha256: createHash("sha256").update(syntheticPngBytes).digest("hex") });
  const state = h.snapshot(); assert.equal(state.jobs[0]?.state, "committed"); assert.equal(state.storage[0]?.imageBytes, syntheticPngBytes.length);
  assert.ok(!JSON.stringify(state).includes(syntheticPngBase64));
  const record = await h.reminders.get("owner-a", created.dto.id, testBudget());
  assert.ok(record && !record.deleted && record.thumbnail);
  assert.deepEqual(await h.images.get(record.thumbnail, testBudget()), syntheticPngBytes);
});

void test("url_refresh_does_not_change_body_or_etag", async () => {
  const h = createHarness(); const created = await h.service.create("owner-a", validCreate({ thumbnail: syntheticPngBase64 }), testBudget());
  const before = await h.service.get("owner-a", created.dto.id, testBudget());
  const first = await h.service.thumbnailUrl("owner-a", created.dto.id, testBudget()); h.advanceMs(1000);
  const second = await h.service.thumbnailUrl("owner-a", created.dto.id, testBudget());
  assert.deepEqual(await h.service.get("owner-a", created.dto.id, testBudget()), before);
  assert.equal(first.imageId, before.dto.thumbnail?.imageId); assert.equal(first.revision, 1);
  assert.equal(first.expiresAt, "2026-10-03T00:15:00.000Z"); assert.equal(second.expiresAt, "2026-10-03T00:15:01.000Z");
  assert.ok(!JSON.stringify(h.snapshot()).includes(first.url));
});

void test("signs_current_owner_version_only", async () => {
  const h = createHarness(); const created = await h.service.create("owner-a", validCreate({ thumbnail: syntheticPngBase64 }), testBudget());
  await assert.rejects(h.service.thumbnailUrl("owner-b", created.dto.id, testBudget()), { status: 404, code: "REMINDER_NOT_FOUND" });
  const next = await h.service.patch("owner-a", created.dto.id, created.etag, { thumbnail: sizedPng(40).toString("base64") }, testBudget());
  const signed = await h.service.thumbnailUrl("owner-a", created.dto.id, testBudget()); assert.equal(signed.imageId, next.dto.thumbnail?.imageId); assert.equal(signed.revision, 2);
  assert.ok(signed.url.includes("versionId=v2"));
  const cleared = await h.service.patch("owner-a", created.dto.id, next.etag, { thumbnail: null }, testBudget());
  await assert.rejects(h.service.thumbnailUrl("owner-a", created.dto.id, testBudget()), { status: 404, code: "THUMBNAIL_NOT_FOUND" });
  await h.service.remove("owner-a", created.dto.id, cleared.etag, testBudget());
  await assert.rejects(h.service.thumbnailUrl("owner-a", created.dto.id, testBudget()), { status: 404, code: "REMINDER_NOT_FOUND" });
});

void test("s3_success_db_reject_leaves_pending", async () => {
  const h = createHarness(); await h.service.create("owner-a", validCreate(), testBudget());
  await assert.rejects(h.service.create("owner-a", validCreate({ thumbnail: syntheticPngBase64 }), testBudget()), { status: 409 });
  const state = h.snapshot(); assert.equal(state.jobs[0]?.state, "pending"); assert.equal(state.jobs[0]?.versionId, "v1"); assert.equal(state.jobs[0]?.dueAtMs, Date.parse("2026-10-04T00:00:00.000Z"));
  assert.equal(state.storage[0]?.imageBytes, 0); assert.equal(state.reminders.length, 1);
});

for (const point of ["createPending", "put", "recordUpload"] as const) {
  void test(`${point}_failure_never_commits_or_discards_pending`, async () => {
    const h = createHarness(); h.injectFault(point, "before");
    await assert.rejects(h.service.create("owner-a", validCreate({ thumbnail: syntheticPngBase64 }), testBudget()), unavailable);
    const state = h.snapshot(); assert.equal(state.transactions.length, 0); assert.equal(state.storage.length, 0);
    assert.equal(state.jobs.length, point === "createPending" ? 0 : 1);
    if (point !== "createPending") { assert.equal(state.jobs[0]?.state, "pending"); assert.equal(state.jobs[0]?.versionId, undefined); }
  });
}

void test("unknown_put_result_leaves_unique_pending_key", async () => {
  const h = createHarness(); h.injectFault("put", "after-commit");
  await assert.rejects(h.service.create("owner-a", validCreate({ thumbnail: syntheticPngBase64 }), testBudget()), unavailable);
  const state = h.snapshot(); assert.equal(state.jobs[0]?.state, "pending"); assert.equal(state.jobs[0]?.versionId, undefined); assert.equal(state.transactions.length, 0);
  assert.equal(state.jobs[0]?.key, "images/owner-a/00000000-0000-4000-8000-000000000001");
  assert.ok(await h.images.head(state.jobs[0]!.key, null, testBudget()));
});

for (const mode of ["before", "after-commit"] as const) {
  void test(`unknown_commit_${mode}_never_retires_current_image`, async () => {
    const h = createHarness(); const created = await h.service.create("owner-a", validCreate({ thumbnail: syntheticPngBase64 }), testBudget());
    h.injectFault("commit", mode);
    const next = await h.service.patch("owner-a", created.dto.id, created.etag, { thumbnail: sizedPng(40).toString("base64") }, testBudget());
    const state = h.snapshot(); assert.equal(state.jobs.find(job => job.jobId === next.dto.thumbnail?.imageId)?.state, "committed");
    assert.equal(state.jobs.find(job => job.jobId === created.dto.thumbnail?.imageId)?.state, "retired"); assert.equal(state.storage[0]?.imageBytes, 40);
    if (mode === "before") assert.deepEqual(state.transactions[1], state.transactions[2]);
  });
}

void test("unknown_commit_failed_reconciliation_keeps_committed_image", async () => {
  const h = createHarness(); h.injectFault("commit", "after-commit"); h.injectFault("get", "before");
  await assert.rejects(h.service.create("owner-a", validCreate({ thumbnail: syntheticPngBase64 }), testBudget()), unavailable);
  assert.equal(h.snapshot().jobs[0]?.state, "committed"); assert.equal(h.snapshot().storage[0]?.imageBytes, syntheticPngBytes.length);
});

void test("exact_1_mib_and_one_byte_over_are_stack_safe_and_classified", () => {
  const data = sizedPng(1_048_576); const decoded = decodeThumbnail(data.toString("base64"));
  assert.ok(decoded); assert.deepEqual(decoded.data, data); assert.equal(decoded.sha256, createHash("sha256").update(data).digest("hex"));
  assert.throws(() => decodeThumbnail(sizedPng(1_048_577).toString("base64")), { status: 413, code: "THUMBNAIL_TOO_LARGE" });
  assert.throws(() => decodeThumbnail(`${data.toString("base64")}!`), { status: 422, code: "INVALID_THUMBNAIL" });
});

void test("configured_image_limit_rejects_before_pending", async () => {
  const h = createHarness({ ...harnessConfig, limits: { ...harnessConfig.limits, thumbnailBytes: 12 } });
  await assert.rejects(h.service.create("owner-a", validCreate({ thumbnail: sizedPng(13).toString("base64") }), testBudget()), { status: 413, code: "THUMBNAIL_TOO_LARGE" });
  assert.deepEqual(h.snapshot().jobs, []);
});

void test("invalid_fields_or_thumbnail_never_creates_pending", async () => {
  const h = createHarness();
  await assert.rejects(h.service.create("owner-a", validCreate({ title: "x".repeat(1025), thumbnail: syntheticPngBase64 }), testBudget()), { status: 422 });
  await assert.rejects(h.service.create("owner-a", validCreate({ thumbnail: "AA==" }), testBudget()), { status: 422 });
  assert.deepEqual(h.snapshot().jobs, []);
});

void test("s3_put_preserves_body_checksum_type_and_requires_real_version", async () => {
  const { createImagesStore } = await import("../../src/images/s3-store");
  const { PutObjectCommand } = await import("@aws-sdk/client-s3");
  const sent: unknown[] = []; const options: unknown[] = []; let version: string | undefined = "original-version";
  const client = { async send(command: unknown, settings: unknown) { sent.push(command); options.push(settings); return { VersionId: version }; } } as unknown as Parameters<typeof createImagesStore>[0];
  const store = createImagesStore(client, harnessConfig); const image = decodeThumbnail(syntheticPngBase64)!; const budget = testBudget();
  const job = { jobId: "00000000-0000-4000-8000-000000000010", ownerId: "owner-a", key: "images/owner-a/00000000-0000-4000-8000-000000000010", state: "pending" as const, createdAtMs: 0, updatedAtMs: 0 };
  const ref = await store.put(job, image, budget); assert.equal(ref.versionId, "original-version");
  assert.ok(sent[0] instanceof PutObjectCommand); assert.deepEqual(sent[0].input.Body, syntheticPngBytes);
  assert.equal(sent[0].input.ContentType, "image/png"); assert.equal(sent[0].input.ChecksumSHA256, createHash("sha256").update(syntheticPngBytes).digest("base64"));
  assert.deepEqual(options, [{ abortSignal: budget.signal }]);
  for (version of [undefined, "", "null"]) await assert.rejects(store.put(job, image, budget), unavailable);
});

void test("s3_signed_get_pins_version_and_900_seconds_without_network", async () => {
  const { createImagesStore } = await import("../../src/images/s3-store");
  const { S3Client } = await import("@aws-sdk/client-s3");
  const client = new S3Client({ region: "ap-northeast-1", credentials: { accessKeyId: "synthetic-access", secretAccessKey: "synthetic-secret" } });
  try {
    const url = new URL(await createImagesStore(client, harnessConfig).signGet({ imageId: "image-1", key: "images/owner-a/image-1", versionId: "original/version+1", mime: "image/png", bytes: 12, sha256: "a".repeat(64) }, 900, testBudget()));
    assert.equal(url.searchParams.get("versionId"), "original/version+1"); assert.equal(url.searchParams.get("X-Amz-Expires"), "900");
    assert.equal(url.pathname, "/images/owner-a/image-1");
  } finally { client.destroy(); }
});

void test("unknown_commit_requires_strong_job_state_and_version", async () => {
  const { createRemindersStore } = await import("../../src/reminders/dynamo-store");
  const { GetCommand, TransactWriteCommand } = await import("@aws-sdk/lib-dynamodb");
  const { activeReminder } = await import("../support/fixtures");
  const jobId = "00000000-0000-4000-8000-000000000010";
  const ref = { imageId: jobId, key: `images/owner-a/${jobId}`, versionId: "v1", mime: "image/png", bytes: 12, sha256: "a".repeat(64) };
  const next = activeReminder({ ownerId: "owner-a", thumbnail: ref });
  for (const job of [null, { jobId, ownerId: "owner-a", state: "pending", versionId: "v1" }, { jobId, ownerId: "owner-a", state: "committed", versionId: "wrong" }, { jobId, ownerId: "owner-b", state: "committed", versionId: "v1" }]) {
    const sent: unknown[] = []; const budget = testBudget();
    const client = { async send(command: unknown, options: unknown) {
      sent.push(command); assert.deepEqual(options, { abortSignal: budget.signal });
      if (command instanceof TransactWriteCommand) throw Object.assign(new Error("synthetic timeout"), { name: "TimeoutError" });
      assert.ok(command instanceof GetCommand); assert.equal(command.input.ConsistentRead, true);
      return command.input.TableName === "jobs" ? { Item: job ?? undefined } : { Item: next };
    } } as unknown as Parameters<typeof createRemindersStore>[0];
    await assert.rejects(createRemindersStore(client, harnessConfig).commit({ ownerId: "owner-a", previous: null, next, itemDelta: 1, byteDelta: 12, jobs: [{ jobId, from: "pending", to: "committed", atMs: 0, expectedVersionId: "v1" }], clientRequestToken: jobId }, budget), unavailable);
    assert.ok(sent.some(command => command instanceof GetCommand && command.input.TableName === "jobs"));
  }
});

void test("concurrent_image_deltas_preserve_quota_and_losing_pending_job", async () => {
  const h = createHarness({ ...harnessConfig, limits: { ...harnessConfig.limits, imageBytes: 31 } });
  const a = await h.service.create("owner-a", validCreate({ id: "a", thumbnail: syntheticPngBase64 }), testBudget());
  const b = await h.service.create("owner-a", validCreate({ id: "b", thumbnail: syntheticPngBase64 }), testBudget());
  const results = await Promise.allSettled([
    h.service.patch("owner-a", "a", a.etag, { thumbnail: sizedPng(20).toString("base64") }, testBudget()),
    h.service.patch("owner-a", "b", b.etag, { thumbnail: sizedPng(19).toString("base64") }, testBudget()),
  ]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  const rejected = results.find(result => result.status === "rejected"); assert.ok(rejected && rejected.status === "rejected");
  assert.equal((rejected.reason as { code: string }).code, "OWNER_STORAGE_LIMIT_EXCEEDED");
  const state = h.snapshot(); assert.equal(state.storage[0]?.imageBytes, 31); assert.equal(state.storage[0]?.itemCount, 2);
  assert.equal(state.jobs.filter(job => job.state === "committed").length, 2); assert.equal(state.jobs.filter(job => job.state === "retired").length, 1); assert.equal(state.jobs.filter(job => job.state === "pending").length, 1);
  const current = await h.service.get("owner-a", "b", testBudget()); await h.service.remove("owner-a", "b", current.etag, testBudget());
  assert.equal(h.snapshot().storage[0]?.imageBytes, 12); assert.equal(h.snapshot().storage[0]?.itemCount, 1);
});

void test("service_original_image_quota_accepts_128_mib_and_rejects_next_byte", async () => {
  const { activeReminder } = await import("../support/fixtures"); const h = createHarness();
  for (let i = 0; i < 127; i++) {
    const imageId = `00000000-0000-4000-9000-${String(i).padStart(12, "0")}`;
    await h.reminders.commit({ ownerId: "owner-a", previous: null, next: activeReminder({ ownerId: "owner-a", id: String(i), thumbnail: { imageId, key: `images/owner-a/${imageId}`, versionId: "seed", mime: "image/png", bytes: 1_048_576, sha256: "a".repeat(64) } }), itemDelta: 1, byteDelta: 1_048_576, jobs: [], clientRequestToken: imageId }, testBudget());
  }
  const full = await h.service.create("owner-a", validCreate({ thumbnail: sizedPng(1_048_576).toString("base64") }), testBudget());
  assert.equal(h.snapshot().storage[0]?.imageBytes, 134_217_728);
  await assert.rejects(h.service.patch("owner-a", full.dto.id, full.etag, { thumbnail: sizedPng(1_048_577).toString("base64") }, testBudget()), { status: 413, code: "THUMBNAIL_TOO_LARGE" });
  await assert.rejects(h.service.create("owner-a", validCreate({ id: "over", thumbnail: syntheticPngBase64 }), testBudget()), { status: 413, code: "OWNER_STORAGE_LIMIT_EXCEEDED" });
  assert.equal(h.snapshot().storage[0]?.imageBytes, 134_217_728); assert.equal(h.snapshot().jobs.at(-1)?.state, "pending");
  const cleared = await h.service.patch("owner-a", full.dto.id, full.etag, { thumbnail: null }, testBudget());
  assert.equal(cleared.dto.thumbnail, null); assert.equal(h.snapshot().storage[0]?.imageBytes, 133_169_152);
});

void test("same_revision_image_race_keeps_winner_committed_and_loser_pending", async () => {
  const h = createHarness(); const old = await h.service.create("owner-a", validCreate({ thumbnail: syntheticPngBase64 }), testBudget());
  const results = await Promise.allSettled([18, 20].map(bytes => h.service.patch("owner-a", old.dto.id, old.etag, { thumbnail: sizedPng(bytes).toString("base64") }, testBudget())));
  const winners = results.filter(result => result.status === "fulfilled"); assert.equal(winners.length, 1);
  const loser = results.find(result => result.status === "rejected"); assert.ok(loser && loser.status === "rejected"); assert.equal((loser.reason as { status: number }).status, 412);
  const current = await h.service.get("owner-a", old.dto.id, testBudget()); const state = h.snapshot();
  assert.equal(state.storage[0]?.imageBytes, current.dto.thumbnail?.bytes); assert.equal(state.jobs.find(job => job.jobId === current.dto.thumbnail?.imageId)?.state, "committed");
  assert.equal(state.jobs.filter(job => job.state === "pending").length, 1); assert.equal(state.jobs.filter(job => job.state === "retired").length, 1);
});

void test("expired_budget_after_put_leaves_unrecorded_pending_without_transaction", async () => {
  const { stageThumbnail } = await import("../../src/images/upload"); const h = createHarness(); let remaining = 10_000;
  const budget = { ...testBudget(), remainingMs: () => remaining };
  await assert.rejects(stageThumbnail("owner-a", decodeThumbnail(syntheticPngBase64)!, { ...h, config: harnessConfig, clock: () => 0, uuid: () => "00000000-0000-4000-8000-000000000030", images: { ...h.images, async put(job, image, activeBudget) { const ref = await h.images.put(job, image, activeBudget); remaining = 0; return ref; } } }, budget), unavailable);
  assert.equal(h.snapshot().jobs[0]?.state, "pending"); assert.equal(h.snapshot().jobs[0]?.versionId, undefined); assert.equal(h.snapshot().transactions.length, 0);
});

void test("s3_head_get_delete_and_probe_use_versions_checksums_and_budget", async () => {
  const { createImagesStore } = await import("../../src/images/s3-store");
  const { HeadObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadBucketCommand } = await import("@aws-sdk/client-s3");
  const image = decodeThumbnail(syntheticPngBase64)!; const ref = { imageId: "image", key: "images/owner/image", versionId: "v1", mime: image.mime, bytes: image.bytes, sha256: image.sha256 };
  const commands: unknown[] = []; const budget = testBudget(); let response: Record<string, unknown> = { VersionId: "v1", ChecksumSHA256: Buffer.from(image.sha256, "hex").toString("base64") }; let failure: Error | undefined;
  const client = { async send(command: unknown, settings: unknown) { commands.push(command); assert.deepEqual(settings, { abortSignal: budget.signal }); if (failure) throw failure; return response; } } as unknown as Parameters<typeof createImagesStore>[0];
  const store = createImagesStore(client, harnessConfig);
  assert.deepEqual(await store.head(ref.key, "v1", budget), { versionId: "v1", sha256: image.sha256, deleteMarker: false });
  assert.ok(commands[0] instanceof HeadObjectCommand); assert.equal(commands[0].input.VersionId, "v1"); assert.equal(commands[0].input.ChecksumMode, "ENABLED");
  response = { VersionId: "v1", Body: { async transformToByteArray() { return syntheticPngBytes; } } };
  assert.deepEqual(await store.get(ref, budget), syntheticPngBytes); assert.ok(commands[1] instanceof GetObjectCommand); assert.equal(commands[1].input.VersionId, "v1");
  await assert.rejects(store.get({ ...ref, sha256: "a".repeat(64) }, budget), unavailable);
  response = { VersionId: "wrong" }; await assert.rejects(store.head(ref.key, "v1", budget), unavailable);
  failure = Object.assign(new Error("private S3 detail"), { $metadata: { httpStatusCode: 404 } }); assert.equal(await store.head(ref.key, null, budget), null);
  for (const status of [404, 405]) {
    failure = Object.assign(new Error("private S3 detail"), { $metadata: { httpStatusCode: status }, $response: { headers: { "x-amz-delete-marker": "true", "x-amz-version-id": "marker-v1" } } });
    assert.deepEqual(await store.head(ref.key, "marker-v1", budget), { versionId: "marker-v1", sha256: null, deleteMarker: true });
  }
  for (const status of [403, 405, 500]) { failure = Object.assign(new Error("private S3 detail"), { $metadata: { httpStatusCode: status } }); await assert.rejects(store.head(ref.key, null, budget), unavailable); }
  failure = undefined; response = {}; await store.markDeleted(ref.key, budget); const deleted = commands.at(-1); assert.ok(deleted instanceof DeleteObjectCommand); assert.equal(deleted.input.VersionId, undefined);
  await store.probe(budget); assert.ok(commands.at(-1) instanceof HeadBucketCommand);
  const before = commands.length; await assert.rejects(store.head(ref.key, null, { ...budget, remainingMs: () => 0 }), unavailable); assert.equal(commands.length, before);
});

void test("uncertain_replacement_job_read_failure_never_demotes_new_committed_job", async () => {
  const h = createHarness(); const old = await h.service.create("owner-a", validCreate({ thumbnail: syntheticPngBase64 }), testBudget());
  h.injectFault("commit", "after-commit"); h.injectFault("jobGet", "before");
  await assert.rejects(h.service.patch("owner-a", old.dto.id, old.etag, { thumbnail: sizedPng(20).toString("base64") }, testBudget()), unavailable);
  const current = await h.service.get("owner-a", old.dto.id, testBudget()); const state = h.snapshot();
  assert.equal(current.dto.revision, 2); assert.equal(state.jobs.find(job => job.jobId === current.dto.thumbnail?.imageId)?.state, "committed");
  assert.equal(state.jobs.find(job => job.jobId === old.dto.thumbnail?.imageId)?.state, "retired"); assert.equal(state.storage[0]?.imageBytes, 20); assert.equal(state.transactions.length, 2);
});

void test("configured_higher_image_limit_survives_create_get_url_and_lowered_limit", async () => {
  const config = { ...harnessConfig, limits: { ...harnessConfig.limits, thumbnailBytes: 2_097_152 } };
  const h = createHarness(config); const data = sizedPng(1_048_577);
  const created = await h.service.create("owner-a", validCreate({ thumbnail: data.toString("base64") }), testBudget());
  assert.equal(created.dto.thumbnail?.bytes, 1_048_577); assert.equal(h.snapshot().storage[0]?.imageBytes, 1_048_577);
  config.limits.thumbnailBytes = 12;
  assert.deepEqual(await h.service.get("owner-a", created.dto.id, testBudget()), created);
  assert.equal((await h.service.list("owner-a", 20, null, testBudget())).items[0]?.thumbnail?.bytes, 1_048_577);
  assert.equal((await h.service.thumbnailUrl("owner-a", created.dto.id, testBudget())).imageId, created.dto.thumbnail?.imageId);
  await assert.rejects(h.service.create("owner-a", validCreate({ id: "too-large-now", thumbnail: sizedPng(13).toString("base64") }), testBudget()), { status: 413, code: "THUMBNAIL_TOO_LARGE" });
});

void test("configured_higher_decode_boundary_preserves_classification_and_size_first", (t) => {
  const exact = sizedPng(2_097_152).toString("base64");
  const decoded = decodeThumbnail(exact, 2_097_152); assert.equal(decoded?.bytes, 2_097_152);
  const oversized = sizedPng(2_097_153).toString("base64");
  const originalFrom = Buffer.from;
  t.mock.method(Buffer, "from", (...args: Parameters<typeof Buffer.from>) => {
    assert.notEqual(args[0], oversized, "oversized input must be rejected before full base64 decode");
    return Reflect.apply(originalFrom, Buffer, args) as Buffer;
  });
  assert.throws(() => decodeThumbnail(oversized, 2_097_152), { status: 413, code: "THUMBNAIL_TOO_LARGE" });
  assert.throws(() => decodeThumbnail(`${oversized.slice(0, -1)}!`, 2_097_152), { status: 422, code: "INVALID_THUMBNAIL" });
});

void test("persisted_reminder_image_bytes_reject_zero_fraction_and_unsafe_integer", async () => {
  const { createRemindersStore } = await import("../../src/reminders/dynamo-store");
  const { activeReminder } = await import("../support/fixtures");
  const imageId = "00000000-0000-4000-8000-000000000001";
  for (const bytes of [0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity]) {
    const row = activeReminder({ ownerId: "owner-a", thumbnail: { imageId, key: `images/owner-a/${imageId}`, versionId: "v1", mime: "image/png", bytes, sha256: "a".repeat(64) } });
    const client = { async send() { return { Item: row }; } } as unknown as Parameters<typeof createRemindersStore>[0];
    await assert.rejects(createRemindersStore(client, harnessConfig).get("owner-a", row.id, testBudget()), unavailable);
  }
});
