import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { CloudWatchClient } from '@aws-sdk/client-cloudwatch';
import { runCleanup, type CleanupDeps } from '../../../src/cleanup/service';
import { createJobsStore } from '../../../src/images/jobs-store';
import { createImagesStore } from '../../../src/images/s3-store';
import { createOwnerStore } from '../../../src/reminders/owner-store';
import { cleanupKeys } from '../../../src/images/job-keys';
import type { ImageJob } from '../../../src/images/types';
import { createHarness, harnessConfig } from '../../support/stateful-store';
import { testBudget, syntheticPngBytes } from '../../support/fixtures';
import { createFaultTransport, type FaultRule, type RequestHandler } from './fault-transport.ts';
import { wireFakes } from './wire-fakes.ts';

/**
 * Cleanup resume/fault cases (CLEAN-02..09, layer I). The product adapters (jobs store, images store, metrics) run over real SDK clients;
 * only the transport underneath is replaced: a stateful wire fake behind an explicit-command fault transport. Nothing here is a Floci or
 * Lambda delivery observation, and no product code receives a test clock or cap override: the injected `clock` is the service's own dependency.
 */
const DAY = 86_400_000; const LEASE = 1_200_000; const NOW = 100_000_000;
const id = (i: number): string => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const intent = (i: number, createdAtMs = NOW - DAY - 1000): ImageJob => ({ jobId: id(i), ownerId: 'owner-a', key: `images/owner-a/${id(i)}`, state: 'pending', createdAtMs, updatedAtMs: createdAtMs, dueAtMs: createdAtMs + DAY, ...cleanupKeys('pending', id(i), createdAtMs + DAY) });
function sameShard(count: number, partition = 'pending#00'): ImageJob[] { const jobs: ImageJob[] = []; for (let i = 1; jobs.length < count; i++) { const job = intent(i); if (job.cleanupPartition === partition) jobs.push(job); } return jobs; }
const credentials = { accessKeyId: 'synthetic', secretAccessKey: 'synthetic' };
const occurrences = (command: string, from: number, to: number, phase: FaultRule['phase'] = 'before', effect: FaultRule['effect'] = 'abort'): FaultRule[] => Array.from({ length: to - from + 1 }, (_, index) => ({ command, occurrence: from + index, phase, effect }));
type Harness = ReturnType<typeof createHarness>;
function rig(options: { h?: Harness; rules?: FaultRule[]; now?: () => number; s3Wrap?: (inner: RequestHandler) => RequestHandler } = {}) {
  const h = options.h ?? createHarness(); h.setPublication(true); const fakes = wireFakes(h); const rules = options.rules ?? [];
  const ddb = createFaultTransport(fakes.dynamodb, rules); const s3 = createFaultTransport(options.s3Wrap ? options.s3Wrap(fakes.s3) : fakes.s3, rules); const cw = createFaultTransport(fakes.cloudwatch, rules);
  const settings = { region: 'ap-northeast-1', maxAttempts: 1, credentials }; const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ ...settings, requestHandler: ddb.handler }));
  let run = 0; const now = options.now ?? ((): number => NOW);
  const deps: CleanupDeps = { jobs: createJobsStore(doc, harnessConfig), images: createImagesStore(new S3Client({ ...settings, requestHandler: s3.handler }), harnessConfig), owners: createOwnerStore(doc, harnessConfig), config: harnessConfig, clock: now, uuid: () => `run-${++run}`, metrics: new CloudWatchClient({ ...settings, requestHandler: cw.handler }) };
  return { h, fakes, deps, budget: { signal: new AbortController().signal, remainingMs: () => 660_000 }, trace: () => [...ddb.trace, ...s3.trace, ...cw.trace] };
}
async function upload(h: Harness, job: ImageJob, record = true): Promise<void> {
  h.seedJob(job); const ref = await h.images.put(job, { data: syntheticPngBytes, mime: 'image/png', bytes: syntheticPngBytes.length, sha256: 'a'.repeat(64) }, testBudget()); if (record) await h.jobs.recordUpload(ref, testBudget());
}
const states = (h: Harness): Record<string, number> => h.snapshot().jobs.reduce<Record<string, number>>((all, job) => ({ ...all, [job.state]: (all[job.state] ?? 0) + 1 }), {});
const unavailable = { status: 503, code: 'SERVICE_UNAVAILABLE' };

void test('the fault transport maps SDK commands explicitly, counts per command and separates a fault before the send from a lost response after it', async () => {
  let sent = 0; const delegate: RequestHandler = { async handle() { sent++; return { response: { statusCode: 200, headers: {}, body: undefined } } as never; } } as RequestHandler;
  const request = (target: string, host = 'dynamodb.ap-northeast-1.amazonaws.com'): never => ({ method: 'POST', protocol: 'https:', hostname: host, path: '/', query: {}, headers: { 'x-amz-target': `DynamoDB_20120810.${target}`, authorization: 'canary-header' }, body: 'canary-body' }) as never;
  const faulted = createFaultTransport(delegate, [{ command: 'GetItem', occurrence: 2, phase: 'before', effect: 'throw' }, { command: 'UpdateItem', occurrence: 1, phase: 'after', effect: 'abort' }]);
  await faulted.handler.handle(request('GetItem')); assert.equal(sent, 1);
  await assert.rejects(faulted.handler.handle(request('GetItem')), (error: Error) => error.name === 'TimeoutError'); assert.equal(sent, 1, 'a before-fault never reaches the service');
  await faulted.handler.handle(request('GetItem')); assert.equal(sent, 2); await faulted.handler.handle(request('Query')); assert.equal(sent, 3, 'occurrences count per command');
  await assert.rejects(faulted.handler.handle(request('UpdateItem')), (error: Error) => error.name === 'AbortError'); assert.equal(sent, 4, 'an after-fault is a real send whose response is lost');
  assert.deepEqual(faulted.trace.map(entry => [entry.command, entry.occurrence, entry.phase]), [['GetItem', 1, 'pass'], ['GetItem', 2, 'before'], ['GetItem', 3, 'pass'], ['Query', 1, 'pass'], ['UpdateItem', 1, 'after']]);
  for (const entry of faulted.trace) assert.deepEqual(Object.keys(entry).sort(), ['command', 'occurrence', 'phase']);
  assert.ok(!JSON.stringify(faulted.trace).includes('canary'));
});

void test('the fault transport fails closed on unmapped requests and invalid rules, maps version deletes apart and delays until the SDK aborts', async () => {
  let sent = 0; const delegate: RequestHandler = { async handle() { sent++; return { response: { statusCode: 200, headers: {}, body: undefined } } as never; } } as RequestHandler;
  const faulted = createFaultTransport(delegate, []);
  await assert.rejects(faulted.handler.handle({ method: 'GET', protocol: 'https:', hostname: 'example.test', path: '/', query: {}, headers: {} } as never), /FAULT_COMMAND_UNMAPPED/); assert.equal(sent, 0);
  const s3 = (method: string, query: Record<string, string>): never => ({ method, protocol: 'https:', hostname: 's3.ap-northeast-1.amazonaws.com', path: '/bucket/key', query, headers: {} }) as never;
  await faulted.handler.handle(s3('DELETE', { 'x-id': 'DeleteObject' })); await faulted.handler.handle(s3('DELETE', { 'x-id': 'DeleteObject', versionId: 'v' })); await faulted.handler.handle(s3('HEAD', {}));
  assert.deepEqual(faulted.trace.map(entry => entry.command), ['DeleteObject', 'DeleteObjectVersion', 'HeadObject']);
  for (const rules of [[{ command: 'GetItem', occurrence: 0, phase: 'before', effect: 'throw' }], [{ command: 'NotAnSdkCommand', occurrence: 1, phase: 'before', effect: 'throw' }], [{ command: 'GetItem', occurrence: 1, phase: 'before', effect: 'throw' }, { command: 'GetItem', occurrence: 1, phase: 'after', effect: 'abort' }], [{ command: 'GetItem', occurrence: 1, phase: 'sideways', effect: 'throw' }]]) assert.throws(() => createFaultTransport(delegate, rules as FaultRule[]), /FAULT_RULE_REJECTED/);
  const delayed = createFaultTransport(delegate, [{ command: 'GetItem', occurrence: 1, phase: 'delay', effect: 'abort' }]); const controller = new AbortController(); let settled = false;
  const pending = delayed.handler.handle({ method: 'POST', protocol: 'https:', hostname: 'dynamodb.ap-northeast-1.amazonaws.com', path: '/', query: {}, headers: { 'x-amz-target': 'DynamoDB_20120810.GetItem' } } as never, { abortSignal: controller.signal }).then(() => 'resolved', (error: Error) => { settled = true; return error.name; });
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(settled, false, 'held until the SDK gives up'); controller.abort(); assert.equal(await pending, 'AbortError'); assert.equal(sent, 3, 'a delayed request is never sent');
});

// CLEAN-07: an abort in the middle of a page never moves the page cursor; the resumed run neither skips nor repeats a delete marker.
void test('clean_07_abort_mid_page_keeps_page_start_cursor_and_resume_has_one_marker_each', async () => {
  const jobs = sameShard(6); const first = rig({ rules: occurrences('HeadObject', 5, 60, 'before', 'abort') });
  for (const job of jobs) await upload(first.h, job);
  await assert.rejects(runCleanup(first.deps, first.budget), unavailable);
  const checkpoint = await first.h.jobs.checkpoint(testBudget()); assert.equal(checkpoint.cursors['pending#00'] ?? null, null, 'the unfinished page is revisited from its start'); assert.equal(checkpoint.roundRobinIndex, 1);
  assert.equal(first.h.deletedKeys.length, 4); assert.ok(states(first.h).done === 4 && (states(first.h).deleting ?? 0) === 2);
  const second = rig({ h: first.h, now: () => NOW + LEASE + 1 }); const result = await runCleanup(second.deps, second.budget);
  assert.equal(result.incomplete, false); assert.equal(states(second.h).done, 6);
  assert.equal(second.h.deletedKeys.length, 6); assert.equal(new Set(second.h.deletedKeys).size, 6, 'no duplicate or skipped marker');
  assert.ok(![...first.trace(), ...second.trace()].some(entry => entry.command === 'DeleteObjectVersion'), 'the actor never sends a permanent version delete'); assert.equal(second.fakes.permanentDeletes.length, 0);
});

// CLEAN-04: a stale index entry for a job that is now committed is re-read strongly and conditionally; the committed bytes are never touched.
void test('clean_04_stale_gsi_rows_skipped_without_claim_or_delete', async () => {
  const committed = sameShard(2); const r = rig(); await upload(r.h, committed[0]!); await upload(r.h, committed[1]!); r.h.freezeCleanupIndex();
  r.h.seedJob({ jobId: committed[0]!.jobId, ownerId: 'owner-a', key: committed[0]!.key, state: 'committed', createdAtMs: NOW - DAY, updatedAtMs: NOW, versionId: 'v1', mime: 'image/png', bytes: syntheticPngBytes.length, sha256: 'a'.repeat(64) });
  r.h.seedJob({ jobId: committed[1]!.jobId, ownerId: 'owner-a', key: committed[1]!.key, state: 'done', createdAtMs: NOW - DAY, updatedAtMs: NOW });
  const result = await runCleanup(r.deps, r.budget); assert.equal(result.incomplete, false); assert.equal(result.evaluated, 2); assert.equal(result.deletes, 0);
  assert.equal(r.h.deletedKeys.length, 0); assert.ok(!r.trace().some(entry => ['DeleteObject', 'UpdateItem'].includes(entry.command)), 'no claim and no delete was sent');
  assert.equal((await r.h.images.head(committed[0]!.key, null, testBudget()))?.deleteMarker, false);
});

// CLEAN-04 / CLEAN-03: an upload recorded between the strong read and the claim is protected: the claim re-reads and pins the new version.
void test('clean_04_upload_during_claim_race_is_protected', async () => {
  const job = sameShard(1)[0]!; const r = rig(); await upload(r.h, job, false);
  r.h.beforeClaim(() => { r.h.seedJob({ ...job, versionId: 'recorded-after-read', mime: 'image/png', bytes: syntheticPngBytes.length, sha256: 'a'.repeat(64) }); });
  const raced = await runCleanup(r.deps, r.budget); assert.equal(raced.deletes, 0); assert.equal(r.h.deletedKeys.length, 0);
  assert.ok(!r.trace().some(entry => entry.command === 'DeleteObject')); assert.deepEqual(states(r.h), { pending: 1 }, 'the lost claim race leaves the job untouched');
  const next = rig({ h: r.h }); const pinned = await runCleanup(next.deps, next.budget); assert.equal(pinned.deletes, 0);
  assert.ok(!next.trace().some(entry => entry.command === 'DeleteObject'), 'the pinned version differs from the stored one'); assert.deepEqual(states(r.h), { deleting: 1 }, 'a mismatching version is neither deleted nor completed');
  assert.equal((await r.h.images.head(job.key, null, testBudget()))?.deleteMarker, false);
});

// CLEAN-09: delete result unknown. The marker is reconciled from the current HEAD; never a second marker and never a version delete.
void test('clean_09_marker_with_lost_response_found_by_head_not_repeated', async () => {
  const job = sameShard(1)[0]!; const r = rig({ rules: [{ command: 'DeleteObject', occurrence: 1, phase: 'after', effect: 'throw' }] }); await upload(r.h, job);
  const result = await runCleanup(r.deps, r.budget); assert.equal(result.incomplete, false); assert.equal(result.deletes, 1); assert.deepEqual(states(r.h), { done: 1 });
  assert.equal(r.h.imageDeleteMarkers().length, 1, 'the real send created exactly one marker'); assert.equal(r.trace().filter(entry => entry.command === 'DeleteObject').length, 1);
  assert.ok(r.trace().some(entry => entry.command === 'DeleteObject' && entry.phase === 'after')); assert.ok(!r.trace().some(entry => entry.command === 'DeleteObjectVersion')); assert.equal(r.fakes.permanentDeletes.length, 0);
});
void test('clean_09_delete_never_sent_retried_once_with_one_marker', async () => {
  const job = sameShard(1)[0]!; const r = rig({ rules: [{ command: 'DeleteObject', occurrence: 1, phase: 'before', effect: 'throw' }] }); await upload(r.h, job);
  const result = await runCleanup(r.deps, r.budget); assert.equal(result.deletes, 1); assert.deepEqual(states(r.h), { done: 1 }); assert.equal(r.h.imageDeleteMarkers().length, 1);
  assert.deepEqual(r.trace().filter(entry => entry.command === 'DeleteObject').map(entry => entry.phase), ['before', 'pass']); assert.ok(r.trace().filter(entry => entry.command === 'HeadObject').length >= 2, 'HEAD is re-read before the new mutation');
});

// CLEAN-09: checkpoint and metric failures are isolated; the heartbeat exists only after both succeeded.
void test('clean_09_checkpoint_failure_fails_invocation_without_heartbeat', async () => {
  const r = rig({ rules: [{ command: 'PutItem', occurrence: 1, phase: 'before', effect: 'throw' }] }); await upload(r.h, sameShard(1)[0]!);
  await assert.rejects(runCleanup(r.deps, r.budget), unavailable); assert.deepEqual(await r.h.jobs.checkpoint(testBudget()), { roundRobinIndex: 0, cursors: {} });
  assert.deepEqual(r.fakes.metrics.flat(), ['CleanupIncomplete'], 'no heartbeat after a failed checkpoint'); assert.deepEqual(states(r.h), { done: 1 }, 'the completed work is durable');
});
void test('clean_09_metric_failure_fails_invocation_after_checkpoint_saved', async () => {
  const r = rig({ rules: occurrences('PutMetricData', 1, 3, 'before', 'throw') }); await upload(r.h, sameShard(1)[0]!);
  await assert.rejects(runCleanup(r.deps, r.budget), unavailable); assert.notDeepEqual(await r.h.jobs.checkpoint(testBudget()), { roundRobinIndex: 0, cursors: {} }); assert.deepEqual(r.fakes.metrics.flat(), []);
  assert.equal(r.trace().filter(entry => entry.command === 'PutMetricData').length, 3, 'bounded at three attempts');
});
void test('clean_09_heartbeat_only_after_saved_checkpoint_and_completed_run', async () => {
  const r = rig(); await upload(r.h, sameShard(1)[0]!); await runCleanup(r.deps, r.budget); assert.deepEqual(r.fakes.metrics.flat().sort(), ['CleanupHeartbeat', 'CleanupIncomplete']);
});

// CLEAN-08: the existing limit tests stay; a small real-adapter inventory is interrupted by the 600 s cap and resumed.
void test('clean_08_runtime_limit_tests_retained_by_name', async () => {
  const source = await readFile(join(process.cwd(), 'tests/runtime/cleanup.test.ts'), 'utf8');
  for (const name of ['limits_candidates_deletes_time_and_parallelism', 'raw_sixty_second_stop_keeps_final_budget_live_and_waits_for_checkpoint', 'working_abort_waits_for_all_transports_before_final_checkpoint']) assert.ok(source.includes(`"${name}"`), name);
});
void test('clean_08_600_second_cap_stops_new_work_then_later_invoke_finishes', async () => {
  let clock = NOW; const jobs = sameShard(12); const advancing = (inner: RequestHandler): RequestHandler => ({ async handle(request: never, options?: never) { const out = await inner.handle(request, options); if ((request as { method: string }).method === 'DELETE') clock += 200_000; return out; } }) as unknown as RequestHandler;
  const first = rig({ now: () => clock, s3Wrap: advancing }); for (const job of jobs) await upload(first.h, job);
  const stopped = await runCleanup(first.deps, first.budget); assert.equal(stopped.incomplete, true); assert.ok(stopped.deletes >= 1 && stopped.deletes < 12, 'new work stopped at the cap');
  assert.ok(first.trace().filter(entry => entry.command === 'DeleteObject').length <= 4, 'at most the four in-flight workers started a delete');
  assert.ok((states(first.h).done ?? 0) < 12);
  clock += LEASE + 1; const second = rig({ h: first.h, now: () => clock }); const finished = await runCleanup(second.deps, second.budget);
  assert.equal(finished.incomplete, false); assert.deepEqual(states(second.h), { done: 12 }); assert.equal(second.h.deletedKeys.length, 12); assert.equal(new Set(second.h.deletedKeys).size, 12);
});

// CLEAN-02 / CLEAN-03: exact equality on a controlled clock (the E cases keep 10 minutes of margin on both sides).
void test('clean_02_pending_due_exactly_at_created_plus_24h', async () => {
  const r = rig(); const due = intent(1, NOW - DAY); const early = intent(2, NOW - DAY + 1);
  await upload(r.h, due); await upload(r.h, early);
  const result = await runCleanup(r.deps, r.budget); assert.equal(result.evaluated, 1); assert.equal(result.deletes, 1);
  assert.equal(r.h.snapshot().jobs.find(job => job.jobId === due.jobId)?.state, 'done'); assert.equal(r.h.snapshot().jobs.find(job => job.jobId === early.jobId)?.state, 'pending');
  assert.deepEqual(r.h.deletedKeys, [due.key]);
});
void test('clean_03_deleting_lease_reclaimed_at_expiry_and_new_lease_20_minutes', async () => {
  const r = rig(); const expired = { ...intent(1), state: 'deleting', leaseOwner: 'previous-run', dueAtMs: NOW, ...cleanupKeys('deleting', id(1), NOW) } as ImageJob; const active = { ...intent(2), state: 'deleting', leaseOwner: 'previous-run', dueAtMs: NOW + 1, ...cleanupKeys('deleting', id(2), NOW + 1) } as ImageJob;
  await upload(r.h, expired, false); await upload(r.h, active, false); const mismatch = intent(3); await upload(r.h, mismatch, false);
  r.h.seedJob({ ...mismatch, versionId: 'other-version' } as ImageJob);
  const result = await runCleanup(r.deps, r.budget); assert.equal(result.deletes, 1);
  const rows = new Map(r.h.snapshot().jobs.map(job => [job.jobId, job])); assert.equal(rows.get(expired.jobId)?.state, 'done'); assert.equal(rows.get(active.jobId)?.leaseOwner, 'previous-run', 'an active lease is untouched');
  const claimed = rows.get(mismatch.jobId); assert.equal(claimed?.state, 'deleting'); assert.equal(claimed?.dueAtMs, NOW + LEASE); assert.equal(claimed?.leaseOwner, 'run-1');
});

void test('no_permanent_version_delete_and_trace_can_see_one', async () => {
  const r = rig(); const watched = createFaultTransport(r.fakes.s3, []); const probe = new S3Client({ region: 'ap-northeast-1', maxAttempts: 1, credentials, requestHandler: watched.handler });
  await probe.send(new DeleteObjectCommand({ Bucket: 'images', Key: 'images/owner-a/x', VersionId: 'v1' }));
  assert.deepEqual(watched.trace.map(entry => entry.command), ['DeleteObjectVersion']); assert.equal(r.fakes.permanentDeletes.length, 1, 'the fake records what the cleanup tests assert is empty');
});
