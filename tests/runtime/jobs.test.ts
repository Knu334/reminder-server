import assert from "node:assert/strict";
import { test } from "node:test";
import { GetCommand, PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { cleanupKeys } from "../../src/images/job-keys";
import { createJobsStore } from "../../src/images/jobs-store";
import type { ImageJob } from "../../src/images/types";
import { createHarness, harnessConfig } from "../support/stateful-store";
import { syntheticPngBase64, testBudget, validCreate } from "../support/fixtures";

const jobId = "00000000-0000-4000-8000-000000000001";
const intent = (overrides: Partial<ImageJob> = {}): ImageJob => ({ jobId, ownerId: "owner-a", key: `images/owner-a/${jobId}`, state: "pending", createdAtMs: 0, updatedAtMs: 0, dueAtMs: 86_400_000, ...overrides });
const ref = { imageId: jobId, key: `images/owner-a/${jobId}`, versionId: "v1", mime: "image/png", bytes: 12, sha256: "a".repeat(64) };
const unavailable = { status: 503, code: "SERVICE_UNAVAILABLE" };
function capture(responses: unknown[]) {
  const sent: unknown[] = []; const options: unknown[] = [];
  const client = { async send(command: unknown, settings: unknown) { sent.push(command); options.push(settings); const response = responses.shift(); if (response instanceof Error) throw response; return response ?? {}; } } as unknown as Parameters<typeof createJobsStore>[0];
  return { store: createJobsStore(client, harnessConfig), sent, options };
}

void test("sparse_due_keys_match_spec", async () => {
  // SHA256 fixture first byte is 0x11: independent fixed expected shard.
  assert.deepEqual(cleanupKeys("retired", jobId, 86_400_000), { cleanupPartition: "retired#01", cleanupSortKey: `0000086400000#${jobId}` });
  const h = createHarness(); await h.jobs.createPending(intent(), testBudget());
  const pending = await h.jobs.get(jobId, testBudget()); assert.equal(pending?.dueAtMs, 86_400_000); assert.equal(pending?.cleanupPartition, "pending#01");
  assert.equal(pending?.cleanupSortKey, `0000086400000#${jobId}`);
  await assert.rejects(h.jobs.createPending(intent(), testBudget()), unavailable);
});

void test("retired_grace_starts_at_transition", async () => {
  const h = createHarness(); const created = await h.service.create("owner-a", validCreate({ thumbnail: syntheticPngBase64 }), testBudget());
  let job = await h.jobs.get(jobId, testBudget()); assert.equal(job?.state, "committed"); assert.equal(job?.cleanupPartition, undefined); assert.equal(job?.cleanupSortKey, undefined);
  h.advanceMs(1000); await h.service.patch("owner-a", created.dto.id, created.etag, { thumbnail: null }, testBudget());
  job = await h.jobs.get(jobId, testBudget()); assert.equal(job?.state, "retired"); assert.equal(job?.dueAtMs, Date.parse("2026-10-04T00:00:01.000Z"));
  assert.equal(job?.cleanupPartition, "retired#01"); assert.equal(job?.cleanupSortKey, `1791072001000#${jobId}`);
});

void test("gsi_stale_committed_job_cannot_be_claimed", async () => {
  const f = capture([{ Items: [{ jobId }], ScannedCount: 1 }, { Item: { jobId, ownerId: "owner-a", key: ref.key, state: "committed", createdAtMs: 0, updatedAtMs: 0 } }, { Item: { jobId, ownerId: "owner-a", key: ref.key, state: "committed", createdAtMs: 0, updatedAtMs: 0 } }]);
  const page = await f.store.queryDue("pending#01", 86_400_000, null, testBudget()); assert.equal(page.jobs[0]?.state, "committed");
  assert.equal(await f.store.claim(jobId, "run-a", 86_400_000, testBudget()), null); assert.equal(f.sent.filter(c => c instanceof UpdateCommand).length, 0);
});

void test("query_is_bounded_keys_only_and_strongly_loads_current_jobs", async () => {
  const cursor = { jobId, cleanupPartition: "pending#01", cleanupSortKey: `0000086400000#${jobId}` };
  const f = capture([{ Items: [{ jobId }, { jobId: "00000000-0000-4000-8000-000000000002" }], ScannedCount: 2, LastEvaluatedKey: cursor }, { Item: intent({ ...cleanupKeys("pending", jobId, 86_400_000) }) }, {}]);
  const budget = testBudget(); const page = await f.store.queryDue("pending#01", 86_400_000, cursor, budget);
  assert.equal(page.jobs.length, 1); assert.equal(page.evaluated, 2); assert.deepEqual(page.lastKey, cursor);
  const command = f.sent[0]; assert.ok(command instanceof QueryCommand);
  assert.equal(command.input.IndexName, "cleanup_by_due"); assert.equal(command.input.Limit, 50); assert.equal(command.input.ConsistentRead, undefined);
  assert.equal(command.input.Select, "ALL_PROJECTED_ATTRIBUTES"); assert.equal(command.input.KeyConditionExpression, "#partition = :partition AND #sort <= :cutoff");
  assert.deepEqual(command.input.ExpressionAttributeValues, { ":partition": "pending#01", ":cutoff": "0000086400000#~" }); assert.deepEqual(command.input.ExclusiveStartKey, cursor);
  for (const get of f.sent.slice(1)) { assert.ok(get instanceof GetCommand); assert.equal(get.input.ConsistentRead, true); }
  assert.ok(f.options.every(option => (option as { abortSignal: AbortSignal }).abortSignal === budget.signal));
});

void test("claim_due_boundary_and_reclaim_expired_lease", async () => {
  const h = createHarness(); await h.jobs.createPending(intent(), testBudget());
  assert.equal(await h.jobs.claim(jobId, "run-a", 86_399_999, testBudget()), null);
  const first = await h.jobs.claim(jobId, "run-a", 86_400_000, testBudget()); assert.equal(first?.state, "deleting"); assert.equal(first?.leaseOwner, "run-a"); assert.equal(first?.dueAtMs, 87_600_000);
  assert.equal(first?.cleanupPartition, "deleting#01"); assert.equal(first?.cleanupSortKey, `0000087600000#${jobId}`);
  assert.equal(await h.jobs.claim(jobId, "run-b", 87_599_999, testBudget()), null);
  assert.equal((await h.jobs.claim(jobId, "run-b", 87_600_000, testBudget()))?.leaseOwner, "run-b");
});

void test("lease_owner_required_to_complete", async () => {
  const h = createHarness(); await h.jobs.createPending(intent(), testBudget()); await h.jobs.claim(jobId, "run-a", 86_400_000, testBudget());
  await assert.rejects(h.jobs.complete(jobId, "run-b", testBudget()), unavailable); assert.equal((await h.jobs.get(jobId, testBudget()))?.state, "deleting");
  await h.jobs.complete(jobId, "run-a", testBudget()); const done = await h.jobs.get(jobId, testBudget());
  assert.equal(done?.state, "done"); for (const key of ["cleanupPartition", "cleanupSortKey", "dueAtMs", "leaseOwner"] as const) assert.equal(done?.[key], undefined);
});

void test("claim_condition_rechecks_state_due_and_uploaded_version", async () => {
  const race = Object.assign(new Error("synthetic condition"), { name: "ConditionalCheckFailedException" });
  const pending = intent({ ...cleanupKeys("pending", jobId, 86_400_000), versionId: "v1" });
  const f = capture([{ Item: pending }, race]); assert.equal(await f.store.claim(jobId, "run-a", 86_400_000, testBudget()), null);
  const claim = f.sent[1]; assert.ok(claim instanceof UpdateCommand); assert.equal(claim.input.ReturnValues, "ALL_NEW");
  assert.match(claim.input.ConditionExpression!, /#state = :state/); assert.match(claim.input.ConditionExpression!, /#due <= :now/); assert.match(claim.input.ConditionExpression!, /#version = :version/);
  assert.equal(claim.input.ExpressionAttributeValues?.[":version"], "v1");
  const error = capture([{ Item: pending }, new Error("private AWS failure")]); await assert.rejects(error.store.claim(jobId, "run-a", 86_400_000, testBudget()), unavailable);
});

void test("record_upload_is_conditional_durable_and_cannot_replace_version", async () => {
  const h = createHarness(); await h.jobs.createPending(intent(), testBudget()); await h.jobs.recordUpload(ref, testBudget());
  assert.equal((await h.jobs.get(jobId, testBudget()))?.versionId, "v1"); assert.equal((await h.jobs.get(jobId, testBudget()))?.state, "pending");
  await assert.rejects(h.jobs.recordUpload({ ...ref, versionId: "v2" }, testBudget()), unavailable);
  await assert.rejects(h.jobs.recordUpload({ ...ref, key: `images/owner-b/${jobId}` }, testBudget()), unavailable);
  await h.jobs.claim(jobId, "run-a", 86_400_000, testBudget()); await assert.rejects(h.jobs.recordUpload(ref, testBudget()), unavailable);
});

void test("checkpoint_never_contains_gsi_keys", async () => {
  const value = { roundRobinIndex: 11, cursors: { "pending#01": { jobId, cleanupPartition: "pending#01", cleanupSortKey: `0000086400000#${jobId}` }, "retired#00": null } } as const;
  const h = createHarness(); assert.deepEqual(await h.jobs.checkpoint(testBudget()), { roundRobinIndex: 0, cursors: {} });
  await h.jobs.saveCheckpoint(value, testBudget()); assert.deepEqual(await h.jobs.checkpoint(testBudget()), value);
  const f = capture([{}]); await f.store.saveCheckpoint(value, testBudget()); const put = f.sent[0]; assert.ok(put instanceof PutCommand);
  assert.equal(put.input.Item?.cleanupPartition, undefined); assert.equal(put.input.Item?.cleanupSortKey, undefined); assert.deepEqual(put.input.Item, { jobId: "CHECKPOINT#cleanup", ...value });
  await assert.rejects(h.jobs.get("CHECKPOINT#cleanup", testBudget()), unavailable);
});

void test("rejects_malformed_database_records_and_checkpoint_cursors", async () => {
  for (const bad of [intent({ key: "images/owner-b/wrong" }), { ...intent(), state: "unexpected" }, { ...intent(), bytes: -1 }, { ...intent(), jobId: "wrong" }]) {
    await assert.rejects(capture([{ Item: bad }]).store.get(jobId, testBudget()), unavailable);
  }
  await assert.rejects(capture([{ Item: { jobId: "CHECKPOINT#cleanup", roundRobinIndex: 12, cursors: {} } }]).store.checkpoint(testBudget()), unavailable);
  await assert.rejects(capture([]).store.saveCheckpoint({ roundRobinIndex: 0, cursors: { "pending#01": { jobId, cleanupPartition: "retired#01", cleanupSortKey: `0000086400000#${jobId}` } } }, testBudget()), unavailable);
});

void test("jobs_adapter_checks_budget_before_each_awaited_operation", async () => {
  const f = capture([]); const exhausted = { ...testBudget(), remainingMs: () => 0 };
  await assert.rejects(f.store.createPending(intent(), exhausted), unavailable); await assert.rejects(f.store.get(jobId, exhausted), unavailable);
  await assert.rejects(f.store.saveCheckpoint({ roundRobinIndex: 0, cursors: {} }, exhausted), unavailable); assert.equal(f.sent.length, 0);
});

void test("concurrent_claims_only_one_run_owns_the_lease", async () => {
  const h = createHarness(); await h.jobs.createPending(intent(), testBudget());
  const results = await Promise.all([h.jobs.claim(jobId, "run-a", 86_400_000, testBudget()), h.jobs.claim(jobId, "run-b", 86_400_000, testBudget())]);
  assert.equal(results.filter(result => result !== null).length, 1); assert.equal((await h.jobs.get(jobId, testBudget()))?.leaseOwner, results.find(result => result !== null)?.leaseOwner);
});

void test("gsi_cursor_resumes_after_fifty_candidates_without_skipping", async () => {
  const h = createHarness();
  for (let i = 1; i <= 220; i++) {
    const id = `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
    await h.jobs.createPending(intent({ jobId: id, key: `images/owner-a/${id}` }), testBudget());
  }
  const first = await h.jobs.queryDue("pending#01", 86_400_000, null, testBudget());
  assert.equal(first.evaluated, 50); assert.equal(first.jobs.length, 50); assert.ok(first.lastKey);
  const second = await h.jobs.queryDue("pending#01", 86_400_000, first.lastKey, testBudget()); assert.ok(second.jobs.length > 0);
  assert.equal(new Set([...first.jobs, ...second.jobs].map(job => job.jobId)).size, first.jobs.length + second.jobs.length); assert.equal(second.lastKey, null);
  assert.equal((await h.jobs.queryDue("pending#01", 86_399_999, null, testBudget())).evaluated, 0);
});

void test("unversioned_claim_fences_a_racing_upload", async () => {
  const failure = Object.assign(new Error("synthetic upload race"), { name: "ConditionalCheckFailedException" });
  const f = capture([{ Item: intent({ ...cleanupKeys("pending", jobId, 86_400_000) }) }, failure]);
  assert.equal(await f.store.claim(jobId, "run-a", 86_400_000, testBudget()), null);
  const claim = f.sent[1]; assert.ok(claim instanceof UpdateCommand); assert.match(claim.input.ConditionExpression!, /attribute_not_exists\(#version\)/);
});

void test("checkpoint_write_and_upload_wait_for_transport_settlement", async () => {
  for (const operation of ["upload", "checkpoint"] as const) {
    let settle: (() => void) | undefined; let finished = false;
    const client = { send() { return new Promise(resolve => { settle = () => { resolve({}); }; }); } } as unknown as Parameters<typeof createJobsStore>[0];
    const store = createJobsStore(client, harnessConfig);
    const pending = (operation === "upload" ? store.recordUpload(ref, testBudget()) : store.saveCheckpoint({ roundRobinIndex: 0, cursors: {} }, testBudget())).then(() => { finished = true; });
    await Promise.resolve(); assert.equal(finished, false); assert.ok(settle); settle(); await pending; assert.equal(finished, true);
  }
});

void test("trailing_line_breaks_in_job_identity_and_checksum_fail_before_send", async () => {
  const f = capture([]);
  await assert.rejects(f.store.recordUpload({ ...ref, sha256: `${ref.sha256}\n` }, testBudget()), unavailable);
  const id = `${jobId}\n`;
  await assert.rejects(f.store.createPending(intent({ jobId: id, key: `images/owner-a/${id}` }), testBudget()), unavailable);
  assert.equal(f.sent.length, 0);
});
