import assert from "node:assert/strict";
import { test } from "node:test";
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { createRemindersStore } from "../../src/reminders/dynamo-store";
import { ApiError } from "../../src/shared/errors";
import type { ChangeSet } from "../../src/reminders/types";
import { createHarness, harnessConfig } from "../support/stateful-store";
import { activeReminder, testBudget, validCreate } from "../support/fixtures";
import { captureCommands } from "../support/commands";

const change = (overrides: Partial<ChangeSet> = {}): ChangeSet => ({ ownerId: "a".repeat(64), previous: null, next: activeReminder(), itemDelta: 1, byteDelta: 0, jobs: [], clientRequestToken: "00000000-0000-4000-8000-000000000001", ...overrides });
const unavailable = (error: unknown): boolean => error instanceof ApiError && error.status === 503 && error.code === "SERVICE_UNAVAILABLE" && !error.message.includes("private");
const cancellation = (...codes: string[]): Error => Object.assign(new Error("private-aws"), { name: "TransactionCanceledException", CancellationReasons: codes.map(Code => ({ Code })) });

void test("concurrent_same_revision_only_one_wins", async () => {
  const h = createHarness(); const r = await h.service.create("owner-a", validCreate(), testBudget());
  const results = await Promise.allSettled(["a", "b"].map(title => h.service.patch("owner-a", r.dto.id, r.etag, { title }, testBudget())));
  assert.equal(results.filter(x => x.status === "fulfilled").length, 1);
  const rejected = results.find(x => x.status === "rejected"); assert.equal(rejected?.status === "rejected" ? (rejected.reason as ApiError).status : null, 412);
  assert.equal((await h.service.get("owner-a", r.dto.id, testBudget())).dto.revision, 2);
  assert.equal(h.snapshot().storage[0]?.itemCount, 1);
});

void test("different_items_are_preserved", async () => {
  const h = createHarness();
  const [a, b] = await Promise.all([h.service.create("owner-a", validCreate({ id: "a" }), testBudget()), h.service.create("owner-a", validCreate({ id: "b" }), testBudget())]);
  await Promise.all([h.service.patch("owner-a", "a", a.etag, { title: "A" }, testBudget()), h.service.patch("owner-a", "b", b.etag, { title: "B" }, testBudget())]);
  assert.deepEqual((await h.service.list("owner-a", 20, null, testBudget())).items.map(r => [r.id, r.title, r.revision]), [["a", "A", 2], ["b", "B", 2]]);
  await h.service.remove("owner-a", "a", (await h.service.get("owner-a", "a", testBudget())).etag, testBudget());
  assert.equal((await h.service.get("owner-a", "b", testBudget())).dto.title, "B");
});

void test("duplicate_create_and_deleted_id_cannot_revive", async () => {
  const h = createHarness(); const results = await Promise.allSettled([1, 2].map(() => h.service.create("owner-a", validCreate(), testBudget())));
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  const rejected = results.find(r => r.status === "rejected"); assert.equal(rejected?.status === "rejected" ? (rejected.reason as ApiError).status : null, 409);
  const r = await h.service.get("owner-a", "reminder-1", testBudget());
  assert.deepEqual(await h.service.remove("owner-a", "reminder-1", r.etag, testBudget()), { id: "reminder-1", deleted: true, revision: 2 });
  await assert.rejects(h.service.get("owner-a", "reminder-1", testBudget()), { status: 404 });
  await assert.rejects(h.service.create("owner-a", validCreate(), testBudget()), { status: 409 });
  assert.deepEqual(h.snapshot().reminders, [{ ownerId: "owner-a", id: "reminder-1", deleted: true, revision: 2, deletedAt: "2026-10-03T00:00:00.000Z" }]);
  assert.equal(h.snapshot().storage[0]?.itemCount, 0);
  assert.equal(h.snapshot().storage[0]?.imageBytes, 0);
});

void test("full_representation_if_match_and_missing_preconditions", async () => {
  const h = createHarness(); const r = await h.service.create("owner-a", validCreate(), testBudget());
  for (const operation of [() => h.service.patch("owner-a", r.dto.id, undefined, { title: "bad" }, testBudget()), () => h.service.remove("owner-a", r.dto.id, undefined, testBudget())]) await assert.rejects(operation(), { status: 428 });
  const sameRevisionWrongHash = `"r1-${"0".repeat(64)}"`;
  await assert.rejects(h.service.patch("owner-a", r.dto.id, sameRevisionWrongHash, { title: "bad" }, testBudget()), { status: 412 });
  await assert.rejects(h.service.remove("owner-a", r.dto.id, sameRevisionWrongHash, testBudget()), { status: 412 });
  await assert.rejects(h.service.patch("owner-a", r.dto.id, "*", { title: "bad" }, testBudget()), { status: 422 });
  assert.equal((await h.service.get("owner-a", r.dto.id, testBudget())).dto.title, "Test reminder");
  await assert.rejects(h.service.get("owner-b", r.dto.id, testBudget()), { status: 404 });
});

void test("quota_is_atomic_and_unknown_result_does_not_double_count", async () => {
  const h = createHarness(); h.injectFault("commit", "after-commit");
  const first = await h.service.create("owner-a", validCreate({ id: "first" }), testBudget());
  assert.equal(first.dto.revision, 1); assert.equal(h.snapshot().storage[0]?.itemCount, 1);
  for (let i = 1; i < 999; i++) await h.service.create("owner-a", validCreate({ id: String(i) }), testBudget());
  const contenders = await Promise.allSettled(["last-a", "last-b"].map(id => h.service.create("owner-a", validCreate({ id }), testBudget())));
  assert.equal(contenders.filter(r => r.status === "fulfilled").length, 1);
  const loser = contenders.find(r => r.status === "rejected"); assert.equal(loser?.status === "rejected" ? (loser.reason as ApiError).code : null, "OWNER_STORAGE_LIMIT_EXCEEDED");
  await assert.rejects(h.service.create("owner-a", validCreate({ id: "1001" }), testBudget()), { status: 413, code: "OWNER_STORAGE_LIMIT_EXCEEDED" });
  assert.equal(h.snapshot().storage[0]?.itemCount, 1000);
  assert.equal(h.snapshot().reminders.filter(row => row.deleted === false).length, 1000);
  await h.service.remove("owner-a", "first", first.etag, testBudget());
  await h.service.create("owner-a", validCreate({ id: "replacement" }), testBudget());
  assert.equal(h.snapshot().storage[0]?.itemCount, 1000);
});

void test("unknown_patch_and_remove_results_reconcile_without_new_revision", async () => {
  const h = createHarness(); const r = await h.service.create("owner-a", validCreate(), testBudget());
  h.injectFault("commit", "after-commit"); const patched = await h.service.patch("owner-a", r.dto.id, r.etag, { title: "saved" }, testBudget());
  assert.equal(patched.dto.revision, 2); assert.equal(h.snapshot().storage[0]?.itemCount, 1);
  h.injectFault("commit", "after-commit"); const removed = await h.service.remove("owner-a", r.dto.id, patched.etag, testBudget());
  assert.equal(removed.revision, 3); assert.equal(h.snapshot().storage[0]?.itemCount, 0);
});

void test("service_list_uses_one_evaluated_page_and_owner_cursor", async () => {
  const h = createHarness(); const a = await h.service.create("owner-a", validCreate({ id: "a" }), testBudget());
  await h.service.create("owner-a", validCreate({ id: "b" }), testBudget()); await h.service.remove("owner-a", "a", a.etag, testBudget());
  const page = await h.service.list("owner-a", 1, null, testBudget()); assert.deepEqual(page.items, []); assert.ok(page.nextCursor);
  assert.deepEqual((await h.service.list("owner-a", 1, page.nextCursor, testBudget())).items.map(r => r.id), ["b"]);
  await assert.rejects(h.service.list("owner-b", 1, page.nextCursor, testBudget()), { status: 422 });
});

void test("transaction_contains_single_action_per_item_and_atomic_job_transitions", async () => {
  const jobId = "00000000-0000-4000-8000-000000000002";
  const fake = captureCommands([{}]); const store = createRemindersStore(fake.client, harnessConfig);
  await store.commit(change({ jobs: [{ jobId, from: "pending", to: "committed", atMs: 100, expectedVersionId: "v1" }] }), testBudget());
  const transaction = fake.sent[0]; assert.ok(transaction instanceof TransactWriteCommand);
  assert.equal(transaction.input.ClientRequestToken, "00000000-0000-4000-8000-000000000001");
  const actions = transaction.input.TransactItems!; assert.equal(actions.length, 3);
  assert.equal(actions[0]?.Put?.ConditionExpression, "attribute_not_exists(#id)");
  assert.equal(actions[1]?.Update?.TableName, "owners"); assert.deepEqual(actions[1]?.Update?.Key, { pk: `OWNER#${"a".repeat(64)}`, sk: "STORAGE" });
  assert.equal(actions[2]?.Update?.TableName, "jobs"); assert.match(actions[2]?.Update?.ConditionExpression ?? "", /#state = :from/); assert.match(actions[2]?.Update?.ConditionExpression ?? "", /#version = :version/);
  assert.match(actions[2]?.Update?.UpdateExpression ?? "", /REMOVE #partition, #sort, #due, #lease/);
  const identities = actions.map(action => JSON.stringify([action.Put?.TableName ?? action.Update?.TableName, action.Put ? { ownerId: action.Put.Item?.ownerId, id: action.Put.Item?.id } : action.Update?.Key]));
  assert.equal(new Set(identities).size, actions.length);
});

void test("image_capacity_and_retire_are_one_atomic_commit", async () => {
  const h = createHarness(); const ownerId = "owner-a"; const jobId = "00000000-0000-4000-8000-000000000002"; const atMs = Date.parse("2026-10-03T00:00:00.000Z");
  await h.jobs.createPending({ jobId, ownerId, key: `images/${ownerId}/${jobId}`, state: "pending", createdAtMs: atMs, updatedAtMs: atMs, versionId: "v1" }, testBudget());
  const record = activeReminder({ ownerId, thumbnail: { imageId: jobId, key: `images/${ownerId}/${jobId}`, versionId: "v1", mime: "image/png", bytes: 100, sha256: "a".repeat(64) } });
  await h.reminders.commit(change({ ownerId, next: record, byteDelta: 100, clientRequestToken: "00000000-0000-4000-8000-000000000700", jobs: [{ jobId, from: "pending", to: "committed", atMs, expectedVersionId: "v1" }] }), testBudget());
  assert.equal(h.snapshot().storage[0]?.imageBytes, 100); assert.equal(h.snapshot().jobs[0]?.state, "committed");
  await assert.rejects(h.reminders.commit(change({ ownerId, next: activeReminder({ ownerId, id: "oversized" }), byteDelta: 134_217_729, clientRequestToken: "00000000-0000-4000-8000-000000000003" }), testBudget()), { status: 413 });
  const representation = await h.service.get(ownerId, record.id, testBudget()); await h.service.remove(ownerId, record.id, representation.etag, testBudget());
  assert.equal(h.snapshot().storage[0]?.imageBytes, 0); assert.equal(h.snapshot().jobs[0]?.state, "retired");
  assert.equal(h.snapshot().jobs[0]?.dueAtMs, atMs + 86_400_000); assert.match(h.snapshot().jobs[0]?.cleanupPartition ?? "", /^retired#0[0-3]$/);
  assert.equal(h.snapshot().jobs[0]?.cleanupSortKey, `${String(atMs + 86_400_000).padStart(13, "0")}#${jobId}`);
});

void test("job_condition_failure_rolls_back_reminder_and_capacity", async () => {
  const h = createHarness(); const ownerId = "owner-a"; const jobId = "00000000-0000-4000-8000-000000000002";
  await h.jobs.createPending({ jobId, ownerId, key: `images/${ownerId}/${jobId}`, state: "pending", createdAtMs: 0, updatedAtMs: 0, versionId: "actual" }, testBudget());
  await assert.rejects(h.reminders.commit(change({ ownerId, next: activeReminder({ ownerId }), jobs: [{ jobId, from: "pending", to: "committed", atMs: 0, expectedVersionId: "wrong" }] }), testBudget()), unavailable);
  assert.deepEqual(h.snapshot().reminders, []); assert.deepEqual(h.snapshot().storage, []); assert.equal(h.snapshot().jobs[0]?.state, "pending");
});

void test("conditional_failures_are_distinct_from_conflicts_and_throttle", async () => {
  for (const [error, overrides, status] of [[cancellation("ConditionalCheckFailed", "None"), {}, 409], [cancellation("ConditionalCheckFailed", "None"), { previous: activeReminder(), next: activeReminder({ revision: 2 }), itemDelta: 0 }, 412], [cancellation("None", "ConditionalCheckFailed"), {}, 413]] as const) {
    await assert.rejects(createRemindersStore(captureCommands([error]).client, harnessConfig).commit(change(overrides), testBudget()), { status });
  }
  for (const error of [cancellation("TransactionConflict", "None"), cancellation("None", "ThrottlingError"), Object.assign(new Error("private-aws"), { name: "ProvisionedThroughputExceededException" })]) {
    const fake = captureCommands([error, error, error]); await assert.rejects(createRemindersStore(fake.client, harnessConfig).commit(change(), testBudget()), unavailable);
    assert.equal(fake.sent.length, 3); assert.ok(fake.sent.every(command => command instanceof TransactWriteCommand));
    assert.deepEqual(fake.sent.map(command => (command as TransactWriteCommand).input), Array(3).fill((fake.sent[0] as TransactWriteCommand).input));
  }
});

void test("uncertain_result_matches_entire_record_and_is_503_when_unprovable", async () => {
  const error = Object.assign(new Error("private-timeout"), { name: "TimeoutError" });
  const record = activeReminder(); const fake = captureCommands([error, { Item: record }]);
  await createRemindersStore(fake.client, harnessConfig).commit(change(), testBudget()); assert.ok(fake.sent[1] instanceof GetCommand); assert.equal(fake.sent.length, 2);
  const cannotConfirm = captureCommands([error, { Item: activeReminder({ title: "different" }) }, error, {}, error, {}]);
  await assert.rejects(createRemindersStore(cannotConfirm.client, harnessConfig).commit(change(), testBudget()), unavailable);
  const transactions = cannotConfirm.sent.filter(command => command instanceof TransactWriteCommand); assert.equal(transactions.length, 3); assert.deepEqual(transactions.map(command => command.input), Array(3).fill((transactions[0] as TransactWriteCommand).input));
});

void test("transaction_retries_check_budget_and_pass_abort_signal", async () => {
  const budget = testBudget(); let remaining = 10_000; const sent: unknown[] = []; const optionsSeen: unknown[] = [];
  const client = { async send(command: unknown, options: unknown) { sent.push(command); optionsSeen.push(options); remaining = 0; throw cancellation("TransactionConflict", "None"); } } as unknown as Parameters<typeof createRemindersStore>[0];
  await assert.rejects(createRemindersStore(client, harnessConfig).commit(change(), { ...budget, remainingMs: () => remaining }), unavailable);
  assert.equal(sent.length, 1); assert.deepEqual(optionsSeen, [{ abortSignal: budget.signal }]);
  const unused = captureCommands([]); await assert.rejects(createRemindersStore(unused.client, harnessConfig).commit(change(), { ...budget, remainingMs: () => 0 }), unavailable); assert.equal(unused.sent.length, 0);
});

void test("before_commit_fault_reuses_change_and_token_without_duplicate_count", async () => {
  const h = createHarness(); h.injectFault("commit", "before");
  const r = await h.service.create("owner-a", validCreate(), testBudget()); assert.equal(r.dto.revision, 1);
  const state = h.snapshot(); assert.equal(state.storage[0]?.itemCount, 1); assert.equal(state.transactions.length, 2);
  assert.deepEqual(state.transactions[0], state.transactions[1]);
});

void test("unknown_outcome_with_failed_reconciliation_returns_503_and_keeps_commit", async () => {
  const h = createHarness(); h.injectFault("commit", "after-commit"); h.injectFault("get", "before");
  await assert.rejects(h.service.create("owner-a", validCreate(), testBudget()), unavailable);
  assert.equal(h.snapshot().storage[0]?.itemCount, 1); assert.equal(h.snapshot().transactions.length, 1);
});

void test("conditional_update_requires_existing_active_expected_revision", async () => {
  const fake = captureCommands([{}]);
  await createRemindersStore(fake.client, harnessConfig).commit(change({ previous: activeReminder(), next: activeReminder({ revision: 2 }), itemDelta: 0 }), testBudget());
  assert.ok(fake.sent[0] instanceof TransactWriteCommand);
  assert.equal(fake.sent[0].input.TransactItems?.[0]?.Put?.ConditionExpression, "attribute_exists(#id) AND #deleted = :false AND #revision = :revision");
  assert.deepEqual(fake.sent[0].input.TransactItems?.[0]?.Put?.ExpressionAttributeValues, { ":false": false, ":revision": 1 });
  const h = createHarness(); const ownerId = "owner-a";
  await assert.rejects(h.reminders.commit(change({ ownerId, previous: activeReminder({ ownerId }), next: activeReminder({ ownerId, revision: 2 }), itemDelta: 0 }), testBudget()), { status: 412 });
  assert.deepEqual(h.snapshot().reminders, []); assert.deepEqual(h.snapshot().storage, []);
});

void test("patch_preserves_fields_and_image_or_clears_and_retires_it", async () => {
  const h = createHarness(); const ownerId = "owner-a"; const jobId = "00000000-0000-4000-8000-000000000002"; const atMs = Date.parse("2026-10-03T00:00:00.000Z");
  await h.jobs.createPending({ jobId, ownerId, key: `images/${ownerId}/${jobId}`, state: "pending", createdAtMs: atMs, updatedAtMs: atMs, versionId: "v1" }, testBudget());
  const record = activeReminder({ ownerId, thumbnail: { imageId: jobId, key: `images/${ownerId}/${jobId}`, versionId: "v1", mime: "image/png", bytes: 100, sha256: "a".repeat(64) } });
  await h.reminders.commit(change({ ownerId, next: record, byteDelta: 100, clientRequestToken: "00000000-0000-4000-8000-000000000700", jobs: [{ jobId, from: "pending", to: "committed", atMs, expectedVersionId: "v1" }] }), testBudget());
  const before = await h.service.get(ownerId, record.id, testBudget()); h.advanceMs(1000);
  const patched = await h.service.patch(ownerId, record.id, before.etag, { title: "changed", reminderTime: "2026-10-03T09:00:00+09:00" }, testBudget());
  assert.equal(patched.dto.createdAt, "2026-10-01T00:00:00.000Z"); assert.equal(patched.dto.updatedAt, "2026-10-03T00:00:01.000Z"); assert.equal(patched.dto.reminderTime, "2026-10-03T00:00:00.000Z");
  assert.deepEqual(patched.dto.thumbnail, { imageId: jobId, mime: "image/png", bytes: 100, sha256: "a".repeat(64) }); assert.equal(h.snapshot().storage[0]?.imageBytes, 100);
  const cleared = await h.service.patch(ownerId, record.id, patched.etag, { thumbnail: "" }, testBudget());
  assert.equal(cleared.dto.thumbnail, null); assert.equal(h.snapshot().storage[0]?.imageBytes, 0); assert.equal(h.snapshot().jobs[0]?.state, "retired"); assert.equal(h.snapshot().jobs[0]?.dueAtMs, atMs + 1000 + 86_400_000);
});

void test("image_byte_quota_accepts_exact_128_mib_and_rejects_next_byte_atomically", async () => {
  const h = createHarness(); const ownerId = "owner-a";
  for (let i = 0; i < 128; i++) {
    const imageId = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
    const record = activeReminder({ ownerId, id: String(i), thumbnail: { imageId, key: `images/${ownerId}/${imageId}`, versionId: "v1", mime: "image/png", bytes: 1_048_576, sha256: "a".repeat(64) } });
    await h.reminders.commit(change({ ownerId, next: record, byteDelta: 1_048_576, clientRequestToken: `00000000-0000-4000-9000-${String(i).padStart(12, "0")}` }), testBudget());
  }
  assert.equal(h.snapshot().storage[0]?.imageBytes, 134_217_728); assert.equal(h.snapshot().storage[0]?.itemCount, 128);
  await assert.rejects(h.reminders.commit(change({ ownerId, next: activeReminder({ ownerId, id: "over" }), byteDelta: 1, clientRequestToken: "00000000-0000-4000-9000-000000000999" }), testBudget()), { status: 413, code: "OWNER_STORAGE_LIMIT_EXCEEDED" });
  assert.equal(h.snapshot().storage[0]?.itemCount, 128); assert.equal(h.snapshot().reminders.length, 128);
});
