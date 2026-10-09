import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { caseActions, definitions } from './cases.ts';
import { Score } from './auth-cases.ts';
import { apiIo, createItem, errorIs } from './api-cases.ts';
import type { Actor, Probe } from './api-cases.ts';
import { body, deleteReq, etagOf, fresh, getReq, inspect, jobOf, jobsOf, patchReq, setup, track, urlReq, versionsOf } from './image-cases.ts';
import { base64Of, imageBytes, sha256Base64, sha256Of } from './image-fixtures.ts';
import { DAY, LEASE, MARGIN, assertNoForeignJobs, collectOwned, invokeCleanup, makeCleanupJob, putOwnedObject, readCheckpoint, resetCheckpoint, retimeJob, seedCleanupJobs } from './cleanup-fixtures.ts';
import type { CleanupInvocation, JobSpec } from './cleanup-fixtures.ts';
import { expectCleanupLogs } from './logs.ts';
import { readOwnerState, readReminder } from './storage.ts';
import { cleanupKeys } from '../../../../src/images/job-keys.ts';
import type { CaseRecorder, SuiteFixture } from './types.ts';

/**
 * Real cleanup state transitions (CLEAN-01..06, 09). Each case owns its synthetic owner and its data, starts from an empty owned
 * state, rewrites only that owner's job times (the 24 h/20 min boundaries keep ten minutes of margin on both sides; exact equality is
 * the controlled-clock I case), invokes the cleanup alias synchronously, and compares the invoke result, the job rows, the owned S3
 * keys and the delivered cleanup logs. Between cases only the case's own jobs and object versions are collected, so one case's
 * candidates are never processed by another case's invoke.
 */
type Row = Record<string, unknown>;
const now = (): number => apiIo.now();
type Ctx = { fixture: SuiteFixture; recorder: CaseRecorder; caseId: string; who: Actor; score: Score };
const register = (id: string, run: (c: Ctx) => Promise<void>): void => {
  if (!definitions.some(def => def.id === id)) throw new Error('CLEANUP_CASE_UNDEFINED');
  caseActions.set(id, async (fixture, recorder) => {
    const score = new Score(); let who: Actor | undefined; let failure: unknown; let failed = false;
    try {
      await fixture.setPublication(true); who = await fresh(fixture); await assertNoForeignJobs(fixture, [who.ownerId]); await resetCheckpoint(fixture);
      await run({ fixture, recorder, caseId: id, who, score });
    } catch (error) { failure = error; failed = true; }
    if (who) { try { await collectOwned(fixture, [who.ownerId]); } catch (error) { if (!failed) { failure = error; failed = true; } } }
    if (failed) throw failure; score.emit(id, recorder);
  });
};

type Obs = { jobs: Row[]; versions: { key: string; versionId: string; size: number }[]; markers: { key: string; versionId: string }[]; state: { itemCount: number; imageBytes: number } };
async function observe(c: Ctx): Promise<Obs> { return { jobs: await jobsOf(c.fixture, c.who.ownerId), ...(await versionsOf(c.fixture, c.who.ownerId)), state: await readOwnerState(c.fixture, c.who.ownerId) }; }
/** The current object under the key (no VersionId): 200 with bytes, or 404 behind a delete marker. */
async function current(c: Ctx, key: string): Promise<{ status: number; bytes?: Buffer }> {
  try { const out = await c.fixture.clients.s3.send(new GetObjectCommand({ Bucket: c.fixture.config.imagesBucket, Key: key })); return { status: 200, bytes: Buffer.from(await out.Body!.transformToByteArray()) }; }
  catch (error) { const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode; if (status === 404) return { status }; throw error; }
}
const isCurrent = async (c: Ctx, key: string, data: Buffer): Promise<boolean> => { const found = await current(c, key); return found.status === 200 && !!found.bytes?.equals(data); };
const isMarked = async (c: Ctx, key: string): Promise<boolean> => (await current(c, key)).status === 404;
/** The original version is still readable by its exact version id after the marker. */
async function retained(c: Ctx, key: string, versionId: unknown, data: Buffer): Promise<boolean> { if (typeof versionId !== 'string') return false; const found = await inspect(c.fixture, { key, versionId }); return !!found && found.versionId === versionId && found.bytes.equals(data) && found.checksum === sha256Base64(data) && found.length === data.length; }
const isDone = (job: Row | undefined, ownerId: string): boolean => !!job && job.state === 'done' && job.ownerId === ownerId && ['cleanupPartition', 'cleanupSortKey', 'dueAtMs', 'leaseOwner'].every(name => job[name] === undefined);
const markerKeys = (obs: Obs): string[] => obs.markers.map(marker => marker.key).sort();
/** Retired by the real API transition: due exactly 24 h after the transition time, which lies inside the request window. */
const retiredByApi = (job: Row | undefined, ref: { key: string; versionId: string; imageId: string }, ownerId: string, probe: Probe): boolean => { const due = Number(job?.dueAtMs); return !!job && job.state === 'retired' && job.ownerId === ownerId && job.key === ref.key && job.versionId === ref.versionId && Number.isSafeInteger(due) && due - DAY >= probe.since - 5000 && due - DAY <= probe.until + 5000 && job.cleanupSortKey === `${String(due).padStart(13, '0')}#${ref.imageId}` && /^retired#0[0-3]$/.test(String(job.cleanupPartition)); };
const okInvoke = (inv: CleanupInvocation, evaluated: number, deletes: number): boolean => inv.status === 200 && !inv.functionError && !!inv.result && !inv.result.skippedUnpublished && !inv.result.incomplete && inv.result.evaluated === evaluated && inv.result.deletes === deletes;
const checkpointOk = (cp: Row | undefined, rotation: number): boolean => !!cp && Object.keys(cp).sort().join(',') === 'cursors,jobId,roundRobinIndex' && cp.roundRobinIndex === rotation && typeof cp.cursors === 'object' && cp.cursors !== null && Object.keys(cp.cursors).length === 12 && Object.entries(cp.cursors).every(([name, value]) => /^(pending|retired|deleting)#0[0-3]$/.test(name) && value === null);
async function run(c: Ctx, evaluated: number | undefined, deletes: number, event: unknown = {}): Promise<CleanupInvocation> {
  const inv = await invokeCleanup(c.fixture, event); c.recorder.recordInput({ httpStatus: inv.status });
  // Every published invoke is checked: its own start+service-end pair, status and counts, bound to its own window.
  c.recorder.deferLogs(expectCleanupLogs(c.fixture, c.caseId, { since: inv.startedAt, until: inv.finishedAt, status: 200, ...(evaluated === undefined ? {} : { evaluated }), deletes })); return inv;
}
/** A duplicate create with a new image: S3 succeeded and the commit was refused, so exactly one orphan pending job with a recorded version remains. */
async function orphan(c: Ctx, id: string, data: Buffer, assertion: string): Promise<Row> {
  const before = await jobsOf(c.fixture, c.who.ownerId); const duplicate = await createItem(c.fixture, c.who, body(id, base64Of(data)));
  if (duplicate.status !== 409) throw new Error('CLEANUP_SETUP_FAILED'); track(c.recorder, c.caseId, assertion, duplicate, 409, 'create', 'ALREADY_EXISTS');
  const added = (await jobsOf(c.fixture, c.who.ownerId)).filter(job => !before.some(old => old.jobId === job.jobId)); if (added.length !== 1 || added[0]!.state !== 'pending' || typeof added[0]!.versionId !== 'string') throw new Error('CLEANUP_SETUP_FAILED'); return added[0]!;
}
const due = (c: Ctx, job: Row, offset = -MARGIN): Promise<Row> => retimeJob(c.fixture, c.who.ownerId, String(job.jobId), 'pending', { state: 'pending', createdAtMs: now() - DAY + offset }) as Promise<Row>;
async function syntheticJob(c: Ctx, data: Buffer, overrides: Partial<JobSpec> = {}): Promise<{ job: Row; versionId: string; data: Buffer }> {
  const jobId = overrides.jobId ?? randomUUID(); const object = await putOwnedObject(c.fixture, c.who.ownerId, jobId, data);
  return { job: makeCleanupJob({ ownerId: c.who.ownerId, jobId, state: 'pending', createdAtMs: now() - DAY - MARGIN, versionId: object.versionId, mime: 'image/png', bytes: object.bytes, sha256: object.sha256, ...overrides }) as Row, versionId: object.versionId, data };
}
const sameVersions = (a: Obs, b: Obs): boolean => isDeepStrictEqual(a.versions, b.versions);

register('CLEAN-01/unpublished', async c => {
  const base = imageBytes('png', 100, 1); const extra = imageBytes('gif', 150, 9); await setup(c.fixture, c.recorder, c.caseId, c.who, 'cl-1', base64Of(base));
  const job = await due(c, await orphan(c, 'cl-1', extra, 'duplicate-result-delivered')); const before = await observe(c);
  await c.fixture.setPublication(false); let inv: CleanupInvocation; try { inv = await invokeCleanup(c.fixture); c.recorder.recordInput({ httpStatus: inv.status }); } finally { await c.fixture.setPublication(true); }
  c.recorder.deferLogs(expectCleanupLogs(c.fixture, c.caseId, { since: inv.startedAt, until: inv.finishedAt, skippedUnpublished: true, evaluated: 0, deletes: 0 }));
  const after = await observe(c); const checkpoint = await readCheckpoint(c.fixture);
  c.score.ok('http', 'invoke-200-no-function-error-skipped-unpublished', inv.status === 200 && !inv.functionError && !!inv.result);
  c.score.ok('http', 'skipped-unpublished-evaluated0-deletes0', inv.result?.skippedUnpublished === true && inv.result.evaluated === 0 && inv.result.deletes === 0 && inv.result.incomplete === false);
  c.score.ok('dynamodb', 'jobs-and-counters-unchanged', isDeepStrictEqual(before.jobs, after.jobs) && isDeepStrictEqual(before.state, after.state) && jobOf(after.jobs, String(job.jobId))?.state === 'pending' && inv.storageUnchanged);
  c.score.ok('dynamodb', 'checkpoint-not-written', checkpoint === undefined);
  c.score.ok('s3', 'owned-versions-unchanged-no-marker', sameVersions(before, after) && after.markers.length === 0 && await isCurrent(c, String(job.key), extra));
});

register('CLEAN-01/published-counts', async c => {
  const base = imageBytes('png', 100, 1); const extra = imageBytes('gif', 150, 9); const created = await setup(c.fixture, c.recorder, c.caseId, c.who, 'cl-1', base64Of(base));
  const job = await due(c, await orphan(c, 'cl-1', extra, 'duplicate-result-delivered')); const before = await observe(c);
  const inv = await run(c, 1, 1); const after = await observe(c); const checkpoint = await readCheckpoint(c.fixture);
  const read = await getReq(c.fixture, c.who, 'cl-1'); track(c.recorder, c.caseId, 'get-result-delivered', read, 200, 'get');
  c.score.ok('http', 'invoke-200-no-function-error-counts-1-1', okInvoke(inv, 1, 1));
  c.score.ok('http', 'item-get-unchanged-after-cleanup', read.status === 200 && read.bytes.equals(created.probe.bytes) && etagOf(read) === created.etag);
  c.score.ok('dynamodb', 'due-orphan-done-committed-unchanged', isDone(jobOf(after.jobs, String(job.jobId)), c.who.ownerId) && isDeepStrictEqual(jobOf(after.jobs, created.ref!.imageId), jobOf(before.jobs, created.ref!.imageId)) && isDeepStrictEqual(before.state, after.state) && after.jobs.length === 2);
  c.score.ok('dynamodb', 'checkpoint-saved-without-gsi-attributes', checkpointOk(checkpoint, 0));
  c.score.ok('s3', 'marker-added-original-version-retained', isDeepStrictEqual(markerKeys(after), [String(job.key)]) && sameVersions(before, after) && await isMarked(c, String(job.key)) && await retained(c, String(job.key), job.versionId, extra) && await isCurrent(c, created.ref!.key, base));
});

register('CLEAN-01/event-injection', async c => {
  const data = imageBytes('png', 90, 3); const { job, versionId } = await syntheticJob(c, data); await seedCleanupJobs(c.fixture, [job as never]); const before = await observe(c);
  const events = [{ key: String(job.key) }, { ownerId: c.who.ownerId }, { detail: { image: String(job.key) } }, { source: 'attacker.example' }]; const rejected: CleanupInvocation[] = [];
  for (const event of events) { const inv = await invokeCleanup(c.fixture, event); c.recorder.recordInput({ httpStatus: inv.status }); rejected.push(inv); }
  const middle = await observe(c); const stillCurrent = await isCurrent(c, String(job.key), data);
  const control = await run(c, 1, 1); const after = await observe(c);
  c.score.ok('http', 'every-injected-event-function-error-behind-200', rejected.length === events.length && rejected.every(inv => inv.status === 200 && inv.functionError === 'Unhandled' && inv.result === undefined));
  c.score.ok('http', 'control-event-processed-200-one-delete', okInvoke(control, 1, 1));
  c.score.ok('dynamodb', 'rejected-events-leave-all-rows-unchanged', rejected.every(inv => inv.storageUnchanged) && isDeepStrictEqual(before.jobs, middle.jobs) && isDeepStrictEqual(before.state, middle.state) && jobOf(middle.jobs, String(job.jobId))?.state === 'pending');
  c.score.ok('dynamodb', 'control-completes-only-owned-orphan', after.jobs.length === 1 && isDone(jobOf(after.jobs, String(job.jobId)), c.who.ownerId));
  c.score.ok('s3', 'rejected-events-add-no-marker', middle.markers.length === 0 && sameVersions(before, middle) && stillCurrent);
  c.score.ok('s3', 'control-marker-added-original-version-retained', isDeepStrictEqual(markerKeys(after), [String(job.key)]) && sameVersions(before, after) && await isMarked(c, String(job.key)) && await retained(c, String(job.key), versionId, data));
});

register('CLEAN-02/pending-24h-both-sides', async c => {
  const base = imageBytes('png', 100, 1); const early = imageBytes('gif', 150, 9); const late = imageBytes('jpeg', 160, 7); const created = await setup(c.fixture, c.recorder, c.caseId, c.who, 'cl-1', base64Of(base));
  const notDue = await due(c, await orphan(c, 'cl-1', early, 'duplicate-result-delivered'), MARGIN); const dueJob = await due(c, await orphan(c, 'cl-1', late, 'duplicate-late-result-delivered'), -MARGIN); const before = await observe(c);
  const inv = await run(c, 1, 1); const after = await observe(c); const read = await getReq(c.fixture, c.who, 'cl-1'); track(c.recorder, c.caseId, 'get-result-delivered', read, 200, 'get');
  c.score.ok('http', 'invoke-200-no-function-error-counts-1-1', okInvoke(inv, 1, 1));
  c.score.ok('http', 'committed-item-get-unchanged', read.status === 200 && read.bytes.equals(created.probe.bytes) && etagOf(read) === created.etag);
  c.score.ok('dynamodb', 'due-orphan-done-not-due-orphan-and-committed-unchanged', isDone(jobOf(after.jobs, String(dueJob.jobId)), c.who.ownerId) && isDeepStrictEqual(jobOf(after.jobs, String(notDue.jobId)), notDue) && isDeepStrictEqual(jobOf(after.jobs, created.ref!.imageId), jobOf(before.jobs, created.ref!.imageId)) && isDeepStrictEqual(before.state, after.state));
  c.score.ok('s3', 'only-due-orphan-marked-all-versions-retained', isDeepStrictEqual(markerKeys(after), [String(dueJob.key)]) && sameVersions(before, after) && await isMarked(c, String(dueJob.key)) && await isCurrent(c, String(notDue.key), early) && await retained(c, String(dueJob.key), dueJob.versionId, late) && await isCurrent(c, created.ref!.key, base));
});

register('CLEAN-02/retired-origin-replace', async c => {
  const data = [imageBytes('png', 100, 1), imageBytes('jpeg', 120, 2), imageBytes('png', 90, 3), imageBytes('gif', 110, 4)] as [Buffer, Buffer, Buffer, Buffer];
  const a = await setup(c.fixture, c.recorder, c.caseId, c.who, 'cl-a', base64Of(data[0]), 'create-a-result-delivered'); const patchA = await patchReq(c.fixture, c.who, 'cl-a', a.etag, { thumbnail: base64Of(data[1]) }); track(c.recorder, c.caseId, 'patch-a-result-delivered', patchA, 200, 'patch');
  const b = await setup(c.fixture, c.recorder, c.caseId, c.who, 'cl-b', base64Of(data[2]), 'create-b-result-delivered'); const patchB = await patchReq(c.fixture, c.who, 'cl-b', b.etag, { thumbnail: base64Of(data[3]) }); track(c.recorder, c.caseId, 'patch-b-result-delivered', patchB, 200, 'patch');
  const transitioned = await observe(c); const newA = ((await readReminder(c.fixture, c.who.ownerId, 'cl-a')) as unknown as Row | null)?.thumbnail; const newB = ((await readReminder(c.fixture, c.who.ownerId, 'cl-b')) as unknown as Row | null)?.thumbnail;
  const retiredApi = patchA.status === 200 && patchB.status === 200 && retiredByApi(jobOf(transitioned.jobs, a.ref!.imageId), a.ref!, c.who.ownerId, patchA) && retiredByApi(jobOf(transitioned.jobs, b.ref!.imageId), b.ref!, c.who.ownerId, patchB);
  const kept = await retimeJob(c.fixture, c.who.ownerId, a.ref!.imageId, 'retired', { state: 'retired', createdAtMs: now() - 3 * DAY, dueAtMs: now() + MARGIN }) as Row;
  const reaped = await retimeJob(c.fixture, c.who.ownerId, b.ref!.imageId, 'retired', { state: 'retired', createdAtMs: now() - 3 * DAY, dueAtMs: now() - MARGIN }) as Row; const before = await observe(c);
  const inv = await run(c, 1, 1); const after = await observe(c);
  c.score.ok('http', 'both-replaces-200-and-retire-24h-after-transition', retiredApi);
  c.score.ok('http', 'invoke-200-no-function-error-counts-1-1', okInvoke(inv, 1, 1));
  c.score.ok('dynamodb', 'future-retired-kept-despite-old-creation-due-retired-done-new-images-unchanged', isDeepStrictEqual(jobOf(after.jobs, a.ref!.imageId), kept) && isDone(jobOf(after.jobs, b.ref!.imageId), c.who.ownerId) && !!newA && !!newB && ([newA, newB] as { imageId: string }[]).every(ref => isDeepStrictEqual(jobOf(after.jobs, ref.imageId), jobOf(before.jobs, ref.imageId))) && isDeepStrictEqual(before.state, after.state) && after.state.itemCount === 2 && after.state.imageBytes === data[1].length + data[3].length);
  c.score.ok('s3', 'only-due-retired-marked-all-versions-retained', isDeepStrictEqual(markerKeys(after), [b.ref!.key]) && sameVersions(before, after) && await isCurrent(c, a.ref!.key, data[0]) && await isMarked(c, b.ref!.key) && await retained(c, b.ref!.key, reaped.versionId, data[2]) && await retained(c, a.ref!.key, kept.versionId, data[0]) && await isCurrent(c, (newA as { key: string }).key, data[1]) && await isCurrent(c, (newB as { key: string }).key, data[3]));
});

register('CLEAN-02/delete-tombstone', async c => {
  const data = imageBytes('png', 80, 8); const created = await setup(c.fixture, c.recorder, c.caseId, c.who, 'cl-1', base64Of(data)); const removed = await deleteReq(c.fixture, c.who, 'cl-1', created.etag); track(c.recorder, c.caseId, 'delete-result-delivered', removed, 200, 'remove');
  const transitioned = await observe(c); const apiRetired = removed.status === 200 && retiredByApi(jobOf(transitioned.jobs, created.ref!.imageId), created.ref!, c.who.ownerId, removed);
  await retimeJob(c.fixture, c.who.ownerId, created.ref!.imageId, 'retired', { state: 'retired', createdAtMs: now() - 3 * DAY, dueAtMs: now() - MARGIN }); const before = await observe(c);
  const inv = await run(c, 1, 1); const after = await observe(c); const read = await getReq(c.fixture, c.who, 'cl-1'); track(c.recorder, c.caseId, 'get-404-result-delivered', read, 404, 'get', 'REMINDER_NOT_FOUND'); const row = await readReminder(c.fixture, c.who.ownerId, 'cl-1');
  c.score.ok('http', 'delete-200-then-get-404-after-cleanup', apiRetired && errorIs(read, 404, 'REMINDER_NOT_FOUND'));
  c.score.ok('http', 'invoke-200-no-function-error-counts-1-1', okInvoke(inv, 1, 1));
  c.score.ok('dynamodb', 'tombstone-job-done-counters-zero-row-deleted', isDone(jobOf(after.jobs, created.ref!.imageId), c.who.ownerId) && after.jobs.length === 1 && after.state.itemCount === 0 && after.state.imageBytes === 0 && isDeepStrictEqual(before.state, after.state) && (row as unknown as Row | null)?.deleted === true);
  c.score.ok('s3', 'current-get-404-original-version-get-200-one-marker', isDeepStrictEqual(markerKeys(after), [created.ref!.key]) && sameVersions(before, after) && await isMarked(c, created.ref!.key) && await retained(c, created.ref!.key, created.ref!.versionId, data));
});

async function leaseCase(c: Ctx, dueOffset: number, expectDeletes: 0 | 1): Promise<void> {
  const base = imageBytes('png', 100, 1); const extra = imageBytes('gif', 150, 9); await setup(c.fixture, c.recorder, c.caseId, c.who, 'cl-1', base64Of(base));
  const original = await orphan(c, 'cl-1', extra, 'duplicate-result-delivered'); const leased = await retimeJob(c.fixture, c.who.ownerId, String(original.jobId), 'pending', { state: 'deleting', dueAtMs: now() + dueOffset, leaseOwner: 'synthetic-previous-run' }) as Row; const before = await observe(c);
  const inv = await run(c, expectDeletes, expectDeletes); const after = await observe(c); const row = jobOf(after.jobs, String(leased.jobId));
  c.score.ok('http', `invoke-200-no-function-error-counts-${expectDeletes}-${expectDeletes}`, okInvoke(inv, expectDeletes, expectDeletes));
  if (expectDeletes === 0) {
    c.score.ok('dynamodb', 'active-lease-job-unchanged', isDeepStrictEqual(row, leased) && isDeepStrictEqual(before.jobs, after.jobs) && isDeepStrictEqual(before.state, after.state));
    c.score.ok('s3', 'no-marker-current-object-intact', after.markers.length === 0 && sameVersions(before, after) && await isCurrent(c, String(leased.key), extra));
  } else {
    c.score.ok('dynamodb', 'expired-lease-reclaimed-to-done-lease-removed', isDone(row, c.who.ownerId) && row?.versionId === leased.versionId && isDeepStrictEqual(before.state, after.state));
    c.score.ok('s3', 'marker-added-original-version-retained', isDeepStrictEqual(markerKeys(after), [String(leased.key)]) && sameVersions(before, after) && await isMarked(c, String(leased.key)) && await retained(c, String(leased.key), leased.versionId, extra));
  }
}
register('CLEAN-03/active-lease', c => leaseCase(c, MARGIN, 0));
register('CLEAN-03/expired-lease', c => leaseCase(c, -MARGIN, 1));
register('CLEAN-03/unrecorded-version', async c => {
  const base = imageBytes('png', 100, 1); const extra = imageBytes('gif', 150, 9); await setup(c.fixture, c.recorder, c.caseId, c.who, 'cl-1', base64Of(base));
  const original = await orphan(c, 'cl-1', extra, 'duplicate-result-delivered'); const uploaded = String(original.versionId);
  const job = await retimeJob(c.fixture, c.who.ownerId, String(original.jobId), 'pending', { state: 'pending', createdAtMs: now() - DAY - MARGIN, dropVersion: true }) as Row; const before = await observe(c);
  const inv = await run(c, 1, 1); const after = await observe(c); const row = jobOf(after.jobs, String(job.jobId));
  c.score.ok('http', 'invoke-200-no-function-error-counts-1-1', okInvoke(inv, 1, 1) && job.versionId === undefined);
  c.score.ok('dynamodb', 'unrecorded-pending-done-without-version-pin', isDone(row, c.who.ownerId) && row?.versionId === undefined && isDeepStrictEqual(before.state, after.state));
  c.score.ok('s3', 'key-reconciled-marker-added-original-version-retained', isDeepStrictEqual(markerKeys(after), [String(job.key)]) && sameVersions(before, after) && await isMarked(c, String(job.key)) && await retained(c, String(job.key), uploaded, extra));
});

register('CLEAN-04/committed-protected', async c => {
  const base = imageBytes('png', 100, 1); const extra = imageBytes('gif', 150, 9); const created = await setup(c.fixture, c.recorder, c.caseId, c.who, 'cl-1', base64Of(base));
  const job = await due(c, await orphan(c, 'cl-1', extra, 'duplicate-result-delivered')); const before = await observe(c);
  const inv = await run(c, 1, 1); const after = await observe(c);
  const read = await getReq(c.fixture, c.who, 'cl-1'); track(c.recorder, c.caseId, 'get-result-delivered', read, 200, 'get'); const issued = await urlReq(c.fixture, c.who, 'cl-1'); track(c.recorder, c.caseId, 'url-result-delivered', issued, 200, 'thumbnail');
  c.score.ok('http', 'invoke-200-no-function-error-counts-1-1', okInvoke(inv, 1, 1));
  c.score.ok('http', 'item-get-and-thumbnail-url-still-served', read.status === 200 && read.bytes.equals(created.probe.bytes) && etagOf(read) === created.etag && issued.status === 200);
  c.score.ok('dynamodb', 'committed-job-and-counters-unchanged-orphan-done', isDeepStrictEqual(jobOf(after.jobs, created.ref!.imageId), jobOf(before.jobs, created.ref!.imageId)) && jobOf(after.jobs, created.ref!.imageId)?.state === 'committed' && isDone(jobOf(after.jobs, String(job.jobId)), c.who.ownerId) && isDeepStrictEqual(before.state, after.state));
  c.score.ok('s3', 'committed-current-bytes-exact-orphan-marked-only', isDeepStrictEqual(markerKeys(after), [String(job.key)]) && sameVersions(before, after) && await isCurrent(c, created.ref!.key, base) && await isMarked(c, String(job.key)) && await retained(c, String(job.key), job.versionId, extra));
});

async function mismatchCase(c: Ctx, overrides: (data: Buffer) => Partial<JobSpec>, name: string): Promise<void> {
  const data = imageBytes('png', 90, 5); const { job } = await syntheticJob(c, data, overrides(data)); await seedCleanupJobs(c.fixture, [job as never]); const before = await observe(c);
  const inv = await run(c, 1, 0); const after = await observe(c); const row = jobOf(after.jobs, String(job.jobId));
  c.score.ok('http', 'invoke-200-no-function-error-counts-1-0', okInvoke(inv, 1, 0));
  c.score.ok('dynamodb', name, !!row && row.state === 'deleting' && typeof row.leaseOwner === 'string' && Number(row.dueAtMs) - LEASE >= inv.startedAt - 5000 && Number(row.dueAtMs) - LEASE <= inv.finishedAt + 5000 && row.versionId === job.versionId && row.sha256 === job.sha256 && isDeepStrictEqual(before.state, after.state));
  c.score.ok('s3', 'no-marker-current-object-intact', after.markers.length === 0 && sameVersions(before, after) && await isCurrent(c, String(job.key), data));
}
register('CLEAN-05/version-mismatch', c => mismatchCase(c, () => ({ versionId: 'mismatch-version' }), 'mismatched-version-job-left-leased-not-done'));
register('CLEAN-05/checksum-mismatch', c => mismatchCase(c, () => ({ sha256: sha256Of(imageBytes('png', 91, 6)) }), 'mismatched-checksum-job-left-leased-not-done'));
register('CLEAN-05/existing-marker-and-absent', async c => {
  const data = imageBytes('png', 90, 5); const { job: markedJob, versionId } = await syntheticJob(c, data); await c.fixture.clients.s3.send(new DeleteObjectCommand({ Bucket: c.fixture.config.imagesBucket, Key: String(markedJob.key) }));
  const absent = makeCleanupJob({ ownerId: c.who.ownerId, jobId: randomUUID(), state: 'pending', createdAtMs: now() - DAY - MARGIN }) as Row; await seedCleanupJobs(c.fixture, [markedJob as never, absent as never]); const before = await observe(c);
  const inv = await run(c, 2, 0); const after = await observe(c);
  c.score.ok('http', 'invoke-200-no-function-error-counts-2-0', before.markers.length === 1 && okInvoke(inv, 2, 0));
  c.score.ok('dynamodb', 'marker-and-absent-jobs-converge-to-done', isDone(jobOf(after.jobs, String(markedJob.jobId)), c.who.ownerId) && isDone(jobOf(after.jobs, String(absent.jobId)), c.who.ownerId) && after.jobs.length === 2);
  c.score.ok('s3', 'no-new-marker-no-version-deleted-original-readable', isDeepStrictEqual(after.markers, before.markers) && sameVersions(before, after) && after.markers.every(marker => marker.key === markedJob.key) && await isMarked(c, String(markedJob.key)) && await retained(c, String(markedJob.key), versionId, data));
});

register('CLEAN-06/same-shard-51-two-invokes', async c => {
  const ids: string[] = []; while (ids.length < 51) { const id = randomUUID(); if (cleanupKeys('pending', id, 0).cleanupPartition === 'pending#00') ids.push(id); }
  const jobs: Row[] = []; for (const [index, jobId] of ids.entries()) jobs.push((await syntheticJob(c, imageBytes('png', 64 + index, index), { jobId })).job);
  await seedCleanupJobs(c.fixture, jobs as never[]); const before = await observe(c);
  const first = await run(c, 51, 51); const afterFirst = await observe(c); const checkpoint = await readCheckpoint(c.fixture);
  const second = await run(c, undefined, 0); const afterSecond = await observe(c);
  c.score.ok('http', 'invoke-200-no-function-error-counts-51-51', before.jobs.length === 51 && okInvoke(first, 51, 51));
  c.score.ok('http', 'second-invoke-no-delete-200', second.status === 200 && !second.functionError && !!second.result && second.result.deletes === 0 && !second.result.incomplete && !second.result.skippedUnpublished);
  c.score.ok('dynamodb', 'all-51-done-checkpoint-without-gsi-attributes-rotation-reset', afterFirst.jobs.length === 51 && afterFirst.jobs.every(job => isDone(job, c.who.ownerId)) && checkpointOk(checkpoint, 1) && isDeepStrictEqual(afterFirst.jobs, afterSecond.jobs));
  c.score.ok('s3', '51-markers-one-each-51-versions-retained-second-invoke-adds-none', afterFirst.markers.length === 51 && new Set(markerKeys(afterFirst)).size === 51 && markerKeys(afterFirst).join() === jobs.map(job => String(job.key)).sort().join() && sameVersions(before, afterFirst) && afterFirst.versions.length === 51 && isDeepStrictEqual(afterSecond.markers, afterFirst.markers) && sameVersions(afterFirst, afterSecond));
});

register('CLEAN-09/second-invoke-converges', async c => {
  const base = imageBytes('png', 100, 1); const extra = imageBytes('gif', 150, 9); await setup(c.fixture, c.recorder, c.caseId, c.who, 'cl-1', base64Of(base));
  const job = await due(c, await orphan(c, 'cl-1', extra, 'duplicate-result-delivered'));
  const first = await run(c, 1, 1); const afterFirst = await observe(c); const second = await run(c, undefined, 0); const afterSecond = await observe(c);
  c.score.ok('http', 'both-invokes-synchronous-200-no-function-error', okInvoke(first, 1, 1) && second.status === 200 && !second.functionError && !!second.result);
  c.score.ok('http', 'second-invoke-no-delete', second.result?.deletes === 0 && !second.result.incomplete && !second.result.skippedUnpublished);
  c.score.ok('dynamodb', 'job-done-and-unchanged-by-second-invoke', isDone(jobOf(afterFirst.jobs, String(job.jobId)), c.who.ownerId) && isDeepStrictEqual(afterFirst.jobs, afterSecond.jobs) && isDeepStrictEqual(afterFirst.state, afterSecond.state));
  c.score.ok('s3', 'one-marker-total-original-version-retained', isDeepStrictEqual(markerKeys(afterSecond), [String(job.key)]) && isDeepStrictEqual(afterFirst.markers, afterSecond.markers) && sameVersions(afterFirst, afterSecond) && await retained(c, String(job.key), job.versionId, extra));
});
