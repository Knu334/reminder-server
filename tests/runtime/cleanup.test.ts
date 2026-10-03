import assert from "node:assert/strict";
import { test } from "node:test";
import { PutMetricDataCommand, type CloudWatchClient } from "@aws-sdk/client-cloudwatch";
import type { Context } from "aws-lambda";
import { runCleanup, type CleanupDeps } from "../../src/cleanup/service";
import { emitCleanupMetrics } from "../../src/cleanup/metrics";
import { createCleanupHandler } from "../../src/cleanup";
import { cleanupKeys } from "../../src/images/job-keys";
import type { ImageJob } from "../../src/images/types";
import { createImagesStore } from "../../src/images/s3-store";
import { createHarness, harnessConfig } from "../support/stateful-store";
import { testBudget, syntheticPngBytes } from "../support/fixtures";

const unavailable = { status: 503, code: "SERVICE_UNAVAILABLE" };
const id = (i: number): string => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
const intent = (i: number): ImageJob => ({ jobId: id(i), ownerId: "owner-a", key: `images/owner-a/${id(i)}`, state: "pending", createdAtMs: 0, updatedAtMs: 0, dueAtMs: 86_400_000, ...cleanupKeys("pending", id(i), 86_400_000) });
function setup() {
  const h = createHarness(); h.setPublication(true); let now = 100_000_000; let remaining = 660_000; let run = 0;
  const metrics: PutMetricDataCommand[] = []; const signals: AbortSignal[] = [];
  const client = { async send(command: PutMetricDataCommand, options: { abortSignal: AbortSignal }) { metrics.push(command); signals.push(options.abortSignal); return {}; } } as unknown as CloudWatchClient;
  const deps: CleanupDeps = { ...h, config: harnessConfig, clock: () => now, uuid: () => `run-${++run}`, metrics: client };
  const budget = { ...testBudget(), remainingMs: () => remaining };
  return { h, deps, budget, metrics, signals, setRemaining(ms: number) { remaining = ms; }, advance(ms: number) { now += ms; h.advanceMs(ms); } };
}
async function upload(f: ReturnType<typeof setup>, i: number, record = true): Promise<void> {
  const job = intent(i); f.h.seedJob(job);
  const image = { data: syntheticPngBytes, mime: "image/png", bytes: syntheticPngBytes.length, sha256: "a".repeat(64) };
  const ref = await f.h.images.put(job, image, testBudget()); if (record) await f.h.jobs.recordUpload(ref, testBudget());
}
function partitionJobs(count: number, partition = "pending#00"): ImageJob[] {
  const jobs: ImageJob[] = []; for (let i = 1; jobs.length < count; i++) { const job = intent(i); if (job.cleanupPartition === partition) jobs.push(job); } return jobs;
}

// Wrong rotation or requerying exhausted partitions starves later shards and repeats work.
void test("rotates_all_12_partitions_fairly", async () => {
  const f = setup(); const jobs = partitionJobs(51); jobs.forEach(job => f.h.seedJob(job));
  const result = await runCleanup(f.deps, f.budget);
  assert.equal(result.incomplete, false); assert.equal(result.evaluated, 51); assert.equal(f.h.snapshot().jobs.filter(job => job.state === "done").length, 51);
  assert.deepEqual(f.h.cleanupQueries.slice(0, 12).map(query => query.partition), ["pending#00", "pending#01", "pending#02", "pending#03", "retired#00", "retired#01", "retired#02", "retired#03", "deleting#00", "deleting#01", "deleting#02", "deleting#03"]);
  assert.equal(f.h.cleanupQueries.filter(query => query.partition === "pending#00").length, 2);
  assert.equal(f.h.cleanupQueries.filter(query => query.partition === "retired#00").length, 1);
  assert.ok(f.h.cleanupQueries.every(query => query.cutoffMs === 100_000_000));
  const checkpoint = await f.h.jobs.checkpoint(testBudget()); assert.equal(checkpoint.roundRobinIndex, 1); assert.equal(checkpoint.cursors["pending#00"], null);
  await runCleanup(f.deps, f.budget); assert.equal(f.h.cleanupQueries[13]?.partition, "pending#01");
});

// Advancing a partially processed page skips its unclaimed candidates forever.
void test("partial_page_replays_without_skipping", async () => {
  const f = setup(); partitionJobs(51).forEach(job => f.h.seedJob(job)); f.h.freezeCleanupIndex(); let claims = 0;
  const deps = { ...f.deps, jobs: { ...f.h.jobs, async claim(...args: Parameters<typeof f.h.jobs.claim>) { const job = await f.h.jobs.claim(...args); if (++claims === 4) f.setRemaining(60_000); return job; } } };
  const first = await runCleanup(deps, f.budget); assert.equal(first.incomplete, true);
  assert.equal((await f.h.jobs.checkpoint(testBudget())).cursors["pending#00"] ?? null, null);
  f.setRemaining(660_000); f.advance(1_200_000); const second = await runCleanup(f.deps, f.budget);
  assert.equal(second.incomplete, false); assert.equal(f.h.snapshot().jobs.filter(job => job.state === "done").length, 51);
  assert.equal(f.h.deletedKeys.length, 0); assert.ok(first.evaluated + second.evaluated >= 51);
});

// A stale GSI row and commit between strong read and claim must protect committed bytes.
void test("stale_index_and_commit_race_cannot_delete", async () => {
  const f = setup(); await upload(f, 1); await upload(f, 2); f.h.freezeCleanupIndex();
  f.h.seedJob({ ...intent(1), state: "committed", versionId: "v1", cleanupPartition: undefined, cleanupSortKey: undefined, dueAtMs: undefined } as unknown as ImageJob);
  f.h.beforeClaim(() => { f.h.seedJob({ jobId: id(2), ownerId: "owner-a", key: intent(2).key, state: "committed", createdAtMs: 0, updatedAtMs: 0, versionId: "v2" }); });
  await runCleanup(f.deps, f.budget); assert.equal(f.h.deletedKeys.length, 0); assert.equal(f.h.snapshot().jobs.filter(job => job.state === "committed").length, 2);
  assert.equal((await f.h.images.head(intent(1).key, null, testBudget()))?.versionId, "v1");
});

// Removing any cap allows excess evaluations, deletes, elapsed work or in-flight requests.
void test("limits_candidates_deletes_time_and_parallelism", async () => {
  const evaluated = setup();
  const candidates = partitionJobs(10_050); candidates.forEach(job => evaluated.h.seedJob(job)); evaluated.h.freezeCleanupIndex();
  candidates.forEach(job => evaluated.h.seedJob({ jobId: job.jobId, ownerId: "owner-a", key: job.key, state: "committed", createdAtMs: 0, updatedAtMs: 0 }));
  const first = await runCleanup(evaluated.deps, evaluated.budget); assert.equal(first.evaluated, 10_000); assert.equal(first.incomplete, true);
  const deleted = setup(); for (let i = 1; i <= 5_050; i++) await upload(deleted, i);
  let active = 0; let max = 0;
  const images = { ...deleted.h.images, async head(...args: Parameters<typeof deleted.h.images.head>) { active++; max = Math.max(max, active); await new Promise(resolve => setImmediate(resolve)); try { return await deleted.h.images.head(...args); } finally { active--; } } };
  const second = await runCleanup({ ...deleted.deps, images }, deleted.budget); assert.equal(second.deletes, 5_000); assert.equal(deleted.h.deletedKeys.length, 5_000); assert.equal(second.incomplete, true); assert.equal(active, 0); assert.equal(max, 4);
  for (const reason of ["remaining", "elapsed"] as const) {
    const f = setup(); await upload(f, 1);
    const jobs = { ...f.h.jobs, async queryDue(...args: Parameters<typeof f.h.jobs.queryDue>) { const page = await f.h.jobs.queryDue(...args); if (page.evaluated) { if (reason === "remaining") f.setRemaining(60_000); else f.advance(600_000); } return page; } };
    const result = await runCleanup({ ...f.deps, jobs }, f.budget); assert.equal(result.incomplete, true); assert.equal(f.h.snapshot().jobs[0]?.state, "pending"); assert.equal(f.h.deletedKeys.length, 0); assert.equal(f.metrics[0]?.input.MetricData?.[0]?.Value, 1);
  }
});

// Unknown marker creation must reconcile HEAD before another mutation and retain versions.
void test("delete_marker_retry_converges", async () => {
  const f = setup(); await upload(f, 1); f.h.injectFault("markDeleted", "after-commit");
  const result = await runCleanup(f.deps, f.budget); assert.equal(result.deletes, 1); assert.equal(f.h.deletedKeys.length, 1); assert.equal(f.h.snapshot().jobs[0]?.state, "done");
  assert.equal((await f.h.images.head(intent(1).key, null, testBudget()))?.deleteMarker, true);
  assert.equal((await f.h.images.get({ imageId: id(1), key: intent(1).key, versionId: "v1", mime: "image/png", bytes: syntheticPngBytes.length, sha256: "a".repeat(64) }, testBudget())).length, syntheticPngBytes.length);
});

void test("existing_marker_and_absent_key_finish_without_new_delete", async () => {
  const f = setup(); await upload(f, 1); f.h.seedJob(intent(2)); await f.h.images.markDeleted(intent(1).key, testBudget());
  const result = await runCleanup(f.deps, f.budget); assert.equal(result.deletes, 0); assert.equal(f.h.deletedKeys.length, 1); assert.equal(f.h.snapshot().jobs.filter(job => job.state === "done").length, 2);
});

void test("unpublished_has_no_mutation_or_heartbeat", async () => {
  const f = setup(); f.h.setPublication(false); f.h.seedJob(intent(1));
  assert.deepEqual(await runCleanup(f.deps, f.budget), { evaluated: 0, deletes: 0, incomplete: false, skippedUnpublished: true });
  assert.equal(f.h.snapshot().jobs[0]?.state, "pending"); assert.equal(f.h.cleanupQueries.length, 0); assert.equal(f.metrics.length, 0); assert.equal(f.h.checkpointWrites, 0);
});

// Swallowing an external failure or advancing a failed page hides unprocessed work.
void test("external_failure_checkpoints_then_throws", async () => {
  const f = setup(); await upload(f, 1); let calls = 0;
  const images = { ...f.h.images, async head() { calls++; throw new Error("private AWS error and signed URL"); } };
  await assert.rejects(runCleanup({ ...f.deps, images }, f.budget), unavailable); assert.equal(calls, 3); assert.equal(f.h.checkpointWrites, 1);
  assert.equal(f.metrics[0]?.input.MetricData?.[0]?.Value, 1); assert.equal(f.metrics[0]?.input.MetricData?.some(metric => metric.MetricName === "CleanupHeartbeat"), false);
  assert.equal(f.h.snapshot().jobs[0]?.state, "deleting"); assert.equal(f.h.deletedKeys.length, 0);
  await runCleanup(f.deps, f.budget); assert.equal(f.h.snapshot().jobs[0]?.state, "deleting"); f.advance(1_200_000); await runCleanup(f.deps, f.budget); assert.equal(f.h.snapshot().jobs[0]?.state, "done");
});

void test("unrecorded_pending_upload_is_reclaimed_and_changed_version_is_protected", async () => {
  const f = setup(); await upload(f, 1, false); await upload(f, 2);
  const job = f.h.snapshot().jobs.find(value => value.jobId === id(2))!; f.h.seedJob({ ...job, versionId: "another-version" });
  await runCleanup(f.deps, f.budget); assert.equal(f.h.snapshot().jobs.find(value => value.jobId === id(1))?.state, "done"); assert.deepEqual(f.h.deletedKeys, [intent(1).key]); assert.equal(f.h.snapshot().jobs.find(value => value.jobId === id(2))?.state, "deleting");
});

void test("late_gsi_candidate_is_seen_next_invocation_after_partition_end", async () => {
  const f = setup(); await runCleanup(f.deps, f.budget); f.h.seedJob(intent(1)); await runCleanup(f.deps, f.budget); assert.equal(f.h.snapshot().jobs[0]?.state, "done");
});

void test("raw_sixty_second_stop_keeps_final_budget_live_and_waits_for_checkpoint", async () => {
  const f = setup(); f.setRemaining(60_000); let release: (() => void) | undefined; let finished = false;
  const jobs = { ...f.h.jobs, async saveCheckpoint(...args: Parameters<typeof f.h.jobs.saveCheckpoint>) { assert.ok(args[1].remainingMs() > 0); assert.equal(args[1].signal.aborted, false); await new Promise<void>(resolve => { release = resolve; }); return f.h.jobs.saveCheckpoint(...args); } };
  const pending = runCleanup({ ...f.deps, jobs }, f.budget).then(result => { finished = true; return result; });
  while (!release) await new Promise(resolve => setImmediate(resolve)); assert.equal(finished, false); assert.equal(f.metrics.length, 0); release();
  assert.equal((await pending).incomplete, true); assert.equal(f.metrics[0]?.input.MetricData?.[1]?.Value, 1); assert.equal(f.signals[0]?.aborted, false);
});

void test("unknown_claim_and_complete_outcomes_are_reconciled", async () => {
  for (const point of ["claim", "complete"] as const) {
    const f = setup(); await upload(f, 1); f.h.injectFault(point, "after-commit");
    await runCleanup(f.deps, f.budget); assert.equal(f.h.snapshot().jobs[0]?.state, "done"); assert.equal(f.h.deletedKeys.length, 1);
  }
});

void test("metrics_have_only_production_dimension_and_await_abort_settlement", async () => {
  let release: (() => void) | undefined; let finished = false; let command: PutMetricDataCommand | undefined; let signal: AbortSignal | undefined;
  const client = { send(value: PutMetricDataCommand, options: { abortSignal: AbortSignal }) { command = value; signal = options.abortSignal; return new Promise<void>(resolve => { release = resolve; }); } } as unknown as CloudWatchClient;
  const pending = emitCleanupMetrics({ evaluated: 1, deletes: 1, incomplete: false, skippedUnpublished: false }, true, client, { ...testBudget(), remainingMs: () => 60_000 }).then(() => { finished = true; });
  await Promise.resolve(); assert.equal(finished, false); assert.ok(signal); assert.ok(command instanceof PutMetricDataCommand); assert.equal(command.input.Namespace, "ReminderServer");
  assert.deepEqual(command.input.MetricData, [{ MetricName: "CleanupIncomplete", Value: 0, Unit: "Count", Dimensions: [{ Name: "Environment", Value: "production" }] }, { MetricName: "CleanupHeartbeat", Value: 1, Unit: "Count", Dimensions: [{ Name: "Environment", Value: "production" }] }]);
  release!(); await pending; assert.equal(finished, true);
});

void test("handler_rejects_client_targets_and_overrides_and_logs_only_safe_fields", async (t) => {
  const f = setup(); const handler = createCleanupHandler(f.deps); const context = { awsRequestId: "synthetic-request", getRemainingTimeInMillis: () => 660_000 } as Context;
  for (const event of [null, [], { ownerId: "owner-a" }, { key: "private" }, { maxDeletes: 1 }, { detail: { ownerId: "owner-a" } }]) await assert.rejects(handler(event, context), { status: 400 });
  assert.equal(f.h.cleanupQueries.length, 0); const logs: string[] = []; t.mock.method(console, "log", (line: string) => { logs.push(line); });
  const result = await handler({}, context); assert.equal(result.incomplete, false); assert.ok(logs.some(line => line.includes("synthetic-request"))); assert.ok(logs.some(line => line.includes("run-1")));
  assert.ok(logs.every(line => !line.includes("images/") && !line.includes("https://"))); await handler({ source: "aws.events", "detail-type": "Scheduled Event", detail: {}, resources: ["synthetic-schedule"] }, context);
});

void test("cleanup_s3_marker_error_is_detected_from_current_head_without_version_delete", async () => {
  const commands: unknown[] = [];
  const client = { async send(command: unknown) { commands.push(command); throw Object.assign(new Error("private S3"), { $metadata: { httpStatusCode: 404 }, $response: { headers: { "x-amz-delete-marker": "true", "x-amz-version-id": "marker-v1" } } }); } } as unknown as Parameters<typeof createImagesStore>[0];
  assert.deepEqual(await createImagesStore(client, harnessConfig).head(intent(1).key, null, testBudget()), { versionId: "marker-v1", sha256: null, deleteMarker: true }); assert.equal(commands.length, 1);
});

void test("complete_failure_after_successful_marker_is_not_retried_as_delete", async (t) => {
  const f = setup(); await upload(f, 1); let attempts = 0; const logs: string[] = []; t.mock.method(console, "log", (line: string) => { logs.push(line); });
  const jobs = { ...f.h.jobs, async complete() { attempts++; throw new Error("private complete failure"); } };
  await assert.rejects(runCleanup({ ...f.deps, jobs }, f.budget), unavailable);
  assert.equal(attempts, 3); assert.equal(f.h.deletedKeys.length, 1); assert.ok(logs.some(line => JSON.parse(line).deletes === 1)); assert.equal(f.metrics[0]?.input.MetricData?.[0]?.Value, 1);
});

void test("working_abort_waits_for_all_transports_before_final_checkpoint", async () => {
  const f = setup(); const jobs = partitionJobs(4); jobs.forEach(job => f.h.seedJob(job));
  let active = 0; let settled = 0;
  const images = { ...f.h.images, async head(_key: string, _version: string | null, budget: Parameters<typeof f.h.images.head>[2]) {
    assert.ok(budget.remainingMs() <= 5_000); active++;
    if (active === 4) f.setRemaining(60_000);
    await new Promise<void>((resolve, reject) => { setImmediate(() => { try { assert.equal(budget.remainingMs(), 0); assert.equal(budget.signal.aborted, true); resolve(); } catch (error) { reject(error); } }); });
    settled++; active--; throw new Error("synthetic settled abort");
  } };
  const stores = { ...f.h.jobs, async saveCheckpoint(...args: Parameters<typeof f.h.jobs.saveCheckpoint>) { assert.equal(active, 0); assert.equal(settled, 4); return f.h.jobs.saveCheckpoint(...args); } };
  const result = await runCleanup({ ...f.deps, jobs: stores, images }, f.budget); assert.equal(result.incomplete, true); assert.equal(settled, 4); assert.equal(f.h.checkpointWrites, 1); assert.equal(f.metrics[0]?.input.MetricData?.[1]?.Value, 1);
});

void test("checkpoint_failure_omits_heartbeat_and_metrics_retry_at_most_three", async () => {
  const f = setup(); f.h.injectFault("saveCheckpoint", "after-commit"); await assert.rejects(runCleanup(f.deps, f.budget), unavailable);
  assert.equal(f.metrics[0]?.input.MetricData?.[0]?.Value, 1); assert.equal(f.metrics[0]?.input.MetricData?.length, 1);
  let attempts = 0;
  const client = { async send(_command: PutMetricDataCommand, settings: { abortSignal: AbortSignal }) { assert.equal(settings.abortSignal.aborted, false); attempts++; throw new Error("private metric failure"); } } as unknown as CloudWatchClient;
  await assert.rejects(emitCleanupMetrics({ evaluated: 0, deletes: 0, incomplete: true, skippedUnpublished: false }, false, client), unavailable); assert.equal(attempts, 3);
});

void test("third_unknown_delete_attempt_reconciles_marker_without_fourth_mutation", async () => {
  const f = setup(); await upload(f, 1); let attempts = 0;
  const images = { ...f.h.images, async markDeleted(...args: Parameters<typeof f.h.images.markDeleted>) { attempts++; if (attempts < 3) throw new Error("synthetic before delete"); await f.h.images.markDeleted(...args); throw new Error("synthetic unknown third delete"); } };
  const result = await runCleanup({ ...f.deps, images }, f.budget); assert.equal(attempts, 3); assert.equal(result.deletes, 1); assert.equal(f.h.deletedKeys.length, 1); assert.equal(f.h.snapshot().jobs[0]?.state, "done");
});
