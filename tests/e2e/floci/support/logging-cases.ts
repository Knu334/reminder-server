import { randomUUID } from 'node:crypto';
import { caseActions, definitions } from './cases.ts';
import { Score } from './auth-cases.ts';
import { actor, commonHeaders, createItem, defer, dtoOf, edgeId, errorIs, itemHeaders, jsonHeaders, listOf, logOf, rateTotal, s3Versions, send } from './api-cases.ts';
import type { Actor, Probe } from './api-cases.ts';
import { fresh, jobsOf, versionsOf } from './image-cases.ts';
import { imageBytes } from './image-fixtures.ts';
import { DAY, MARGIN, assertNoForeignJobs, collectOwned, invokeCleanup, makeCleanupJob, putOwnedObject, readCheckpoint, resetCheckpoint, seedCleanupJobs } from './cleanup-fixtures.ts';
import { expectCleanupLogs } from './logs.ts';
import { makeInput, rejectParams } from './input-fixtures.ts';
import { readOwnerState, readReminder, snapshotOwnedStorage } from './storage.ts';
import type { RejectParam } from './input-fixtures.ts';
import type { CaseRecorder, LogExpectation, SuiteFixture } from './types.ts';

/**
 * OBS-02 and OBS-03 service result logs. Every case owns its synthetic users and judges the final HTTP, storage and delivered-log outputs
 * together. API result logs are bound to the request id the product returned; a log must be delivered exactly once (the observer counts
 * events by event id, so a re-fetch is not a second log). A Gateway refusal never reaches the Lambda: its absence is judged only with
 * delivered normal controls on both sides, once at the end of the suite. Cleanup logs are paired by each invoke's own bounded window.
 */
const LIST = '/v2/reminders'; const WRITE = 'reminder-api/write';
const tick = (): Promise<void> => new Promise<void>(resolve => setTimeout(resolve, 2));
const register = (id: string, body: (fixture: SuiteFixture, recorder: CaseRecorder, score: Score) => Promise<void>): void => {
  if (!definitions.some(def => def.id === id)) throw new Error('LOGGING_CASE_UNDEFINED');
  caseActions.set(id, async (fixture, recorder) => { const score = new Score(); await body(fixture, recorder, score); score.emit(id, recorder); });
};
const itemPath = (id: string): string => `${LIST}/${encodeURIComponent(id)}`;
const operationFor = (method: string, path: string): string => method === 'POST' ? 'create' : method === 'PATCH' ? 'patch' : /^\/v2\/reminders(\?|$)/.test(path) ? 'list' : 'get';

register('OBS-02/crud-success-result-logs', async (fixture, recorder, score) => {
  const id = 'OBS-02/crud-success-result-logs'; const itemId = 'obs-crud-1'; const who = await actor(fixture, 'a');
  const state0 = await readOwnerState(fixture, who.ownerId); const versions = await s3Versions(fixture);
  const created = await createItem(fixture, who, JSON.stringify(makeInput({ id: itemId, title: 'Log probe' }))); recorder.recordInput({ httpStatus: created.status });
  const dto = dtoOf(created); const row1 = await readReminder(fixture, who.ownerId, itemId) as unknown as Record<string, unknown> | null; const state1 = await readOwnerState(fixture, who.ownerId);
  const read = await send(fixture, itemPath(itemId), { token: who.token }); recorder.recordInput({ httpStatus: read.status });
  const patched = await send(fixture, itemPath(itemId), { token: who.token, method: 'PATCH', headers: { ...jsonHeaders(), 'if-match': created.headers.get('etag') ?? '' }, body: JSON.stringify({ title: 'Log probe 2' }) }); recorder.recordInput({ httpStatus: patched.status });
  const row2 = await readReminder(fixture, who.ownerId, itemId) as unknown as Record<string, unknown> | null;
  const removed = await send(fixture, itemPath(itemId), { token: who.token, method: 'DELETE', headers: { 'if-match': patched.headers.get('etag') ?? '' } }); recorder.recordInput({ httpStatus: removed.status });
  const gone = await send(fixture, itemPath(itemId), { token: who.token }); recorder.recordInput({ httpStatus: gone.status });
  const row3 = await readReminder(fixture, who.ownerId, itemId) as unknown as Record<string, unknown> | null; const state3 = await readOwnerState(fixture, who.ownerId);
  score.ok('http', 'create-201', created.status === 201 && !!dto && itemHeaders(created) && dto.id === itemId && dto.revision === 1);
  score.ok('http', 'get-200-same-body', read.status === 200 && read.text === created.text && itemHeaders(read));
  score.ok('http', 'patch-200-revision-2', patched.status === 200 && itemHeaders(patched) && dtoOf(patched)?.revision === 2 && dtoOf(patched)?.title === 'Log probe 2');
  score.ok('http', 'delete-200-then-get-404', removed.status === 200 && removed.text === JSON.stringify({ id: itemId, deleted: true, revision: 3 }) && commonHeaders(removed) && errorIs(gone, 404, 'REMINDER_NOT_FOUND'));
  score.ok('dynamodb', 'row-and-counter-follow-each-step', !!row1 && row1.revision === 1 && row1.deleted === false && row1.ownerId === who.ownerId && state1.itemCount === state0.itemCount + 1 && !!row2 && row2.revision === 2 && row2.title === 'Log probe 2' && !!row3 && row3.deleted === true && row3.revision === 3 && state3.itemCount === state0.itemCount && state3.imageBytes === state0.imageBytes);
  score.ok('s3', 'no-image-versions-added', versions === await s3Versions(fixture));
  defer(recorder, id, 'create-result-delivered', logOf(created, 201, { operation: 'create' })); defer(recorder, id, 'get-result-delivered', logOf(read, 200, { operation: 'get' }));
  defer(recorder, id, 'patch-result-delivered', logOf(patched, 200, { operation: 'patch' })); defer(recorder, id, 'delete-result-delivered', logOf(removed, 200, { operation: 'remove' }));
  defer(recorder, id, 'get-404-result-delivered', logOf(gone, 404, { operation: 'get', code: 'REMINDER_NOT_FOUND' }));
});

const pick = (id: string): RejectParam => { const found = rejectParams.find(param => param.id === id); if (!found) throw new Error('LOGGING_PARAM_UNDEFINED'); return found; };
register('OBS-02/input-rejection-result-logs', async (fixture, recorder, score) => {
  const id = 'OBS-02/input-rejection-result-logs'; const who = await actor(fixture, 'a');
  const domain = await snapshotOwnedStorage(fixture, { excludeRate: true }); const rate = await rateTotal(fixture, who.ownerId); const versions = await s3Versions(fixture);
  const rejections: [RejectParam, string, string][] = [[pick('API-07/invalid-json'), 'invalid-json-400', 'invalid-json-400-result-delivered'], [pick('API-07/media-text-plain'), 'media-415', 'media-415-result-delivered'], [pick('API-08/owner-field'), 'owner-field-422', 'owner-field-422-result-delivered']];
  for (const [param, http, log] of rejections) {
    const headers = param.method === 'GET' ? {} : { ...jsonHeaders(param.contentType), ...(param.ifMatch ? { 'if-match': param.ifMatch } : {}) };
    const probe = await send(fixture, param.path, { token: who.token, method: param.method, headers, ...(param.body !== undefined ? { body: param.body } : {}) }); recorder.recordInput({ httpStatus: probe.status });
    score.ok('http', http, errorIs(probe, param.status, param.code)); defer(recorder, id, log, logOf(probe, param.status, { code: param.code, operation: operationFor(param.method, param.path) }));
  }
  const missing = await send(fixture, itemPath('obs-never-created'), { token: who.token }); recorder.recordInput({ httpStatus: missing.status });
  score.ok('http', 'missing-item-404', errorIs(missing, 404, 'REMINDER_NOT_FOUND')); defer(recorder, id, 'missing-404-result-delivered', logOf(missing, 404, { code: 'REMINDER_NOT_FOUND', operation: 'get' }));
  const control = await send(fixture, LIST, { token: who.token }); recorder.recordInput({ httpStatus: control.status });
  score.ok('http', 'valid-control-200', !!listOf(control)); defer(recorder, id, 'control-result-delivered', logOf(control, 200, { operation: 'list' }));
  score.ok('dynamodb', 'rejections-leave-rows-unchanged-rate-plus-five', domain === await snapshotOwnedStorage(fixture, { excludeRate: true }) && await rateTotal(fixture, who.ownerId) === rate + 5);
  score.ok('s3', 'no-image-versions-added', versions === await s3Versions(fixture));
});

/** A normal GET 200 whose delivery is later required; it must carry a request id. */
async function control(fixture: SuiteFixture, who: Actor): Promise<LogExpectation> {
  const probe = await send(fixture, LIST, { token: who.token });
  if (probe.status !== 200 || !probe.requestId) throw new Error('LOGGING_CONTROL_FAILED');
  return logOf(probe, 200, { operation: 'list' });
}
register('OBS-02/gateway-refusal-result-absence', async (fixture, recorder, score) => {
  const id = 'OBS-02/gateway-refusal-result-absence'; const who = await actor(fixture, 'a'); const writeOnly = await fixture.auth.login('a', [WRITE], 'primary');
  let before = await control(fixture, who);
  for (const item of [{ token: undefined, status: 401, http: 'no-jwt-401', log: 'no-jwt-api-result-absent' }, { token: writeOnly.accessToken, status: 403, http: 'write-only-get-403', log: 'write-only-api-result-absent' }] as const) {
    await tick(); const stored = await snapshotOwnedStorage(fixture); const since = Date.now();
    const refused: Probe = await send(fixture, LIST, item.token ? { token: item.token } : {}); const until = Date.now(); const unchanged = stored === await snapshotOwnedStorage(fixture); await tick();
    recorder.recordInput({ httpStatus: refused.status });
    score.ok('http', item.http, refused.status === item.status); score.ok('dynamodb', 'refusal-owner-rate-storage-unchanged', unchanged); score.ok('s3', 'refusal-image-versions-unchanged', unchanged);
    const after = await control(fixture, who);
    defer(recorder, id, item.log, { service: 'api', requestId: edgeId(refused), since, until, status: item.status, mode: 'absent' }, { before, after });
    before = after;
  }
  score.ok('http', 'valid-controls-200', true);
});

register('OBS-03/cleanup-start-end-pairing', async (fixture, recorder, score) => {
  const id = 'OBS-03/cleanup-start-end-pairing'; let ownerId: string | undefined; let failure: unknown; let failed = false;
  try {
    await fixture.setPublication(true); const who = await fresh(fixture); ownerId = who.ownerId; await assertNoForeignJobs(fixture, [ownerId]); await resetCheckpoint(fixture);
    const jobId = randomUUID(); const object = await putOwnedObject(fixture, ownerId, jobId, imageBytes('png', 90, 6));
    const job = makeCleanupJob({ ownerId, jobId, state: 'pending', createdAtMs: Date.now() - DAY - MARGIN, versionId: object.versionId, mime: 'image/png', bytes: object.bytes, sha256: object.sha256 });
    await seedCleanupJobs(fixture, [job]);
    const first = await invokeCleanup(fixture); recorder.recordInput({ httpStatus: first.status }); recorder.deferLogs(expectCleanupLogs(fixture, id, { since: first.startedAt, until: first.finishedAt, status: 200, evaluated: 1, deletes: 1 }));
    const mid = { jobs: await jobsOf(fixture, ownerId), ...(await versionsOf(fixture, ownerId)) };
    await tick(); const second = await invokeCleanup(fixture); recorder.recordInput({ httpStatus: second.status }); recorder.deferLogs(expectCleanupLogs(fixture, id, { since: second.startedAt, until: second.finishedAt, status: 200, deletes: 0 }));
    const after = { jobs: await jobsOf(fixture, ownerId), ...(await versionsOf(fixture, ownerId)) }; const checkpoint = await readCheckpoint(fixture);
    const done = (rows: Record<string, unknown>[]): boolean => rows.length === 1 && rows[0]!.jobId === jobId && rows[0]!.state === 'done' && ['cleanupPartition', 'cleanupSortKey', 'dueAtMs', 'leaseOwner'].every(name => rows[0]![name] === undefined);
    score.ok('http', 'invoke-200-no-function-error-counts-1-1', first.status === 200 && !first.functionError && first.result?.evaluated === 1 && first.result.deletes === 1 && !first.result.incomplete && !first.result.skippedUnpublished);
    score.ok('http', 'second-invoke-200-no-delete', second.status === 200 && !second.functionError && second.result?.deletes === 0 && !second.result.incomplete && !second.result.skippedUnpublished);
    score.ok('dynamodb', 'due-orphan-done-and-checkpoint-saved', done(mid.jobs) && done(after.jobs) && !!checkpoint && first.storageUnchanged === false);
    score.ok('s3', 'marker-added-original-version-retained', mid.markers.length === 1 && mid.markers[0]!.key === job.key && after.markers.length === 1 && after.versions.length === 1 && after.versions[0]!.versionId === object.versionId && after.versions[0]!.key === job.key);
  } catch (error) { failure = error; failed = true; }
  if (ownerId) { try { await collectOwned(fixture, [ownerId]); } catch (error) { if (!failed) { failure = error; failed = true; } } }
  if (failed) throw failure;
});
