import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { DeleteCommand, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { keys } from '../../../../src/shared/ports.ts';
import { caseActions } from './cases.ts';
import { Score } from './auth-cases.ts';
import { actor, apiIo, commonHeaders, createItem, defer, dtoOf, errorIs, isRecord, itemHeaders, listOf, logOf, rateTotal, s3Versions, secondToken, send } from './api-cases.ts';
import type { Actor, Probe } from './api-cases.ts';
import { makeInput } from './input-fixtures.ts';
import { readOwnerState, readReminder, snapshotOwnedStorage } from './storage.ts';
import type { CaseRecorder, SuiteFixture } from './types.ts';

/**
 * Strong ETag, concurrent writers, tombstones and the rate boundary through the real Gateway and Lambda.
 * Every case starts from a fresh synthetic owner (the runner gives it its own users); counts are never inherited.
 * Expected hashes are computed from the raw HTTP response bytes, never from the product serializer.
 */
const PNG_BASE64 = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]).toString('base64');
const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const itemPath = (id: string): string => `/v2/reminders/${encodeURIComponent(id)}`;
type Row = Record<string, unknown> | null;

/** Releases every request in the same tick once all have been prepared; the E layer's client-side barrier. */
export async function concurrently<T>(thunks: (() => Promise<T>)[]): Promise<T[]> {
  let open!: () => void; const gate = new Promise<void>(resolve => { open = resolve; });
  const running = thunks.map(async thunk => { await gate; return thunk(); });
  await new Promise<void>(resolve => setTimeout(resolve, 5)); open();
  return Promise.all(running);
}
const overlapped = (a: Probe, b: Probe): boolean => a.since <= b.until && b.since <= a.until;

/** Writes the synthetic count 119 for `minute` with the product's expiry and confirms it with a strongly consistent read. */
export async function seedRateBeforeLimit(fixture: SuiteFixture, ownerId: string, minute: number): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(ownerId) || !Number.isSafeInteger(minute) || minute < 0) throw new Error('OWNER_REJECTED');
  const key = keys.rate(ownerId, minute);
  await fixture.clients.dynamodb.send(new PutCommand({ TableName: fixture.config.ownerStateTable, Item: { ...key, count: 119, expiresAt: keys.rateExpiresAt(minute) } }));
  const row = await fixture.clients.dynamodb.send(new GetCommand({ TableName: fixture.config.ownerStateTable, Key: key, ConsistentRead: true }));
  if (row.Item?.count !== 119 || row.Item.expiresAt !== keys.rateExpiresAt(minute)) throw new Error('RATE_SEED_REJECTED');
}

async function fresh(fixture: SuiteFixture): Promise<Actor> {
  const who = await actor(fixture, 'a'); const state = await readOwnerState(fixture, who.ownerId);
  if (state.itemCount !== 0 || state.imageBytes !== 0 || await rateTotal(fixture, who.ownerId) !== 0) throw new Error('STORE_OWNER_NOT_FRESH');
  return who;
}
async function stored(fixture: SuiteFixture, who: Actor, id: string): Promise<{ row: Row; state: { itemCount: number; imageBytes: number } }> {
  return { row: await readReminder(fixture, who.ownerId, id) as unknown as Row, state: await readOwnerState(fixture, who.ownerId) };
}
async function readJob(fixture: SuiteFixture, jobId: string): Promise<{ state?: string; versionId?: string; ownerId?: string } | undefined> {
  const result = await fixture.clients.dynamodb.send(new GetCommand({ TableName: fixture.config.imageJobsTable, Key: { jobId }, ConsistentRead: true }));
  return result.Item as { state?: string; versionId?: string; ownerId?: string } | undefined;
}
const etagOf = (probe: Probe): string => probe.headers.get('etag') ?? '';
const exactEtag = (probe: Probe, revision: number): boolean => etagOf(probe) === `"r${revision}-${sha256(probe.bytes)}"`;
const bodyOf = (id: string, revision: number): string => JSON.stringify({ id, deleted: true, revision });
const isTombstone = (row: Row, id: string, ownerId: string, revision: number): boolean => !!row && Object.keys(row).sort().join(',') === 'deleted,deletedAt,id,ownerId,revision' && row.deleted === true && row.id === id && row.ownerId === ownerId && row.revision === revision && ISO.test(String(row.deletedAt));
const matchesDto = (row: Row, probe: Probe): boolean => { const dto = dtoOf(probe); return !!row && !!dto && row.deleted === false && ['id', 'url', 'title', 'reminderTime', 'autoOpen', 'webPush', 'hidden', 'revision', 'createdAt', 'updatedAt'].every(field => row[field] === dto[field]); };

const getReq = (fixture: SuiteFixture, who: Actor, id: string): Promise<Probe> => send(fixture, itemPath(id), { token: who.token });
const patchReq = (fixture: SuiteFixture, who: Actor, id: string, ifMatch: string | undefined, fields: Record<string, unknown>): Promise<Probe> =>
  send(fixture, itemPath(id), { token: who.token, method: 'PATCH', headers: { 'content-type': 'application/json', ...(ifMatch === undefined ? {} : { 'if-match': ifMatch }) }, body: JSON.stringify(fields) });
const deleteReq = (fixture: SuiteFixture, who: Actor, id: string, ifMatch: string | undefined): Promise<Probe> =>
  send(fixture, itemPath(id), { token: who.token, method: 'DELETE', headers: ifMatch === undefined ? {} : { 'if-match': ifMatch } });

type Created = { probe: Probe; etag: string; id: string };
/** A setup create that must succeed; its result log is still checked. */
async function setup(fixture: SuiteFixture, recorder: CaseRecorder, caseId: string, who: Actor, id: string, assertion: string, overrides: Record<string, unknown> = {}): Promise<Created> {
  const probe = await createItem(fixture, who, JSON.stringify(makeInput({ id, title: `title ${id}`, ...overrides })));
  if (probe.status !== 201 || !dtoOf(probe) || !itemHeaders(probe)) throw new Error('STORE_SETUP_FAILED');
  defer(recorder, caseId, assertion, logOf(probe, 201, { operation: 'create' }));
  return { probe, etag: etagOf(probe), id };
}
const track = (recorder: CaseRecorder, caseId: string, assertion: string, probe: Probe, status: number, operation: string, code?: string): void => defer(recorder, caseId, assertion, logOf(probe, status, { operation, ...(code ? { code } : {}) }));

const register = (id: string, body: (fixture: SuiteFixture, recorder: CaseRecorder, score: Score) => Promise<void>): void => {
  caseActions.set(id, async (fixture, recorder) => { const score = new Score(); await body(fixture, recorder, score); score.emit(id, recorder); });
};

// STORE-01 exact strong ETag and headers.
register('STORE-01/exact-etag-and-headers', async (fixture, recorder, score) => {
  const id = 'store-1'; const caseId = 'STORE-01/exact-etag-and-headers'; const who = await fresh(fixture); const versions = await s3Versions(fixture);
  const created = await setup(fixture, recorder, caseId, who, id, 'create-result-delivered'); const afterCreate = await stored(fixture, who, id);
  score.ok('http', 'create-etag-is-rn-sha256-of-raw-bytes', exactEtag(created.probe, 1) && dtoOf(created.probe)?.revision === 1);
  const got = await getReq(fixture, who, id); track(recorder, caseId, 'get-result-delivered', got, 200, 'get');
  score.ok('http', 'get-same-bytes-and-etag', got.status === 200 && got.bytes.equals(created.probe.bytes) && etagOf(got) === created.etag);
  score.ok('http', 'item-headers-no-transform-no-store', itemHeaders(created.probe) && itemHeaders(got));
  const patched = await patchReq(fixture, who, id, created.etag, { title: 'changed title' }); recorder.recordInput({ httpStatus: patched.status }); track(recorder, caseId, 'patch-result-delivered', patched, 200, 'patch');
  const afterPatch = await stored(fixture, who, id);
  score.ok('http', 'patch-etag-is-r2-sha256-of-raw-bytes', patched.status === 200 && exactEtag(patched, 2) && etagOf(patched) !== created.etag && dtoOf(patched)?.revision === 2 && dtoOf(patched)?.title === 'changed title');
  const readonly = await patchReq(fixture, who, id, etagOf(patched), { revision: 9 }); track(recorder, caseId, 'readonly-result-delivered', readonly, 422, 'patch', 'INVALID_INPUT');
  const confirm = await getReq(fixture, who, id); const afterReadonly = await stored(fixture, who, id);
  score.ok('http', 'readonly-dto-fields-refused-etag-unchanged', errorIs(readonly, 422, 'INVALID_INPUT') && confirm.status === 200 && etagOf(confirm) === etagOf(patched) && confirm.bytes.equals(patched.bytes) && Object.keys(dtoOf(confirm) ?? {}).join(',') === 'id,url,title,reminderTime,autoOpen,webPush,hidden,revision,createdAt,updatedAt,thumbnail' && !confirm.text.includes('ownerId'));
  score.ok('dynamodb', 'stored-row-matches-dto-and-etag-revision', matchesDto(afterCreate.row, created.probe) && afterCreate.row?.revision === 1 && matchesDto(afterPatch.row, patched) && afterPatch.row?.revision === 2 && isDeepStrictEqual(afterPatch, afterReadonly) && afterReadonly.state.itemCount === 1);
  score.ok('s3', 'no-image-versions-added', versions === await s3Versions(fixture));
});

// STORE-02 If-Match refusals, separate per operation. A refusal changes neither the current content nor the counters.
const ifMatchLabels = ['missing-if-match', 'weak-if-match', 'star-if-match', 'list-if-match', 'same-revision-other-hash', 'sequential-stale'] as const;
const expectedRefusal: Record<(typeof ifMatchLabels)[number], { status: number; code: string; http: string }> = {
  'missing-if-match': { status: 428, code: 'PRECONDITION_REQUIRED', http: '428-precondition-required' },
  'weak-if-match': { status: 422, code: 'INVALID_IF_MATCH', http: '422-invalid-if-match' },
  'star-if-match': { status: 422, code: 'INVALID_IF_MATCH', http: '422-invalid-if-match' },
  'list-if-match': { status: 422, code: 'INVALID_IF_MATCH', http: '422-invalid-if-match' },
  'same-revision-other-hash': { status: 412, code: 'PRECONDITION_FAILED', http: '412-precondition-failed' },
  'sequential-stale': { status: 412, code: 'PRECONDITION_FAILED', http: '412-precondition-failed' },
};
for (const op of ['patch', 'delete'] as const) for (const label of ifMatchLabels) {
  const caseId = `STORE-02/${op}-${label}`; const expected = expectedRefusal[label];
  register(caseId, async (fixture, recorder, score) => {
    const id = 'if-1'; const who = await fresh(fixture); const versions = await s3Versions(fixture); const created = await setup(fixture, recorder, caseId, who, id, 'create-result-delivered');
    let current = created.probe; let header: string | undefined;
    if (label === 'sequential-stale') {
      const newer = await patchReq(fixture, who, id, created.etag, { title: 'newer title' }); if (newer.status !== 200) throw new Error('STORE_SETUP_FAILED');
      track(recorder, caseId, 'stale-setup-result-delivered', newer, 200, 'patch'); current = newer; header = created.etag;
    } else if (label === 'weak-if-match') header = `W/${created.etag}`;
    else if (label === 'star-if-match') header = '*';
    else if (label === 'list-if-match') header = `${created.etag}, ${created.etag}`;
    else if (label === 'same-revision-other-hash') header = `${created.etag.slice(0, -2)}${created.etag.at(-2) === '0' ? '1' : '0'}"`;
    const before = await stored(fixture, who, id); const refusal = await (op === 'patch' ? patchReq(fixture, who, id, header, { title: 'refused title' }) : deleteReq(fixture, who, id, header));
    recorder.recordInput({ httpStatus: refusal.status }); const after = await stored(fixture, who, id);
    score.ok('http', expected.http, errorIs(refusal, expected.status, expected.code));
    track(recorder, caseId, 'rejection-result-delivered', refusal, expected.status, op === 'patch' ? 'patch' : 'remove', expected.code);
    const get = await getReq(fixture, who, id); track(recorder, caseId, 'current-get-result-delivered', get, 200, 'get');
    score.ok('http', 'current-get-same-bytes-and-etag', get.status === 200 && get.bytes.equals(current.bytes) && etagOf(get) === etagOf(current));
    const revision = Number(dtoOf(current)?.revision);
    const control = op === 'patch' ? await patchReq(fixture, who, id, etagOf(current), { title: 'control title' }) : await deleteReq(fixture, who, id, etagOf(current));
    const done = await stored(fixture, who, id); track(recorder, caseId, 'control-result-delivered', control, 200, op === 'patch' ? 'patch' : 'remove');
    score.ok('http', 'exact-if-match-control-200', control.status === 200 && (op === 'patch' ? exactEtag(control, revision + 1) && dtoOf(control)?.title === 'control title' : control.text === bodyOf(id, revision + 1) && control.headers.get('etag') === null));
    score.ok('dynamodb', 'rejection-leaves-row-and-counters', isDeepStrictEqual(before, after) && before.state.itemCount === 1 && !!before.row && before.row.revision === revision);
    score.ok('dynamodb', 'control-changes-state-exactly-once', op === 'patch' ? matchesDto(done.row, control) && done.row?.revision === revision + 1 && done.state.itemCount === 1 : isTombstone(done.row, id, who.ownerId, revision + 1) && done.state.itemCount === 0);
    score.ok('s3', 'no-image-versions-added', versions === await s3Versions(fixture));
  });
}

// STORE-03 two simultaneous writers on the same ETag, released together by a client barrier.
type RaceKind = 'patch-patch' | 'delete-delete' | 'patch-delete';
async function race(fixture: SuiteFixture, recorder: CaseRecorder, score: Score, caseId: string, kind: RaceKind): Promise<void> {
  const id = 'race-1'; const who = await fresh(fixture); const withImage = kind !== 'patch-patch';
  const created = await setup(fixture, recorder, caseId, who, id, 'create-result-delivered', withImage ? { thumbnail: PNG_BASE64 } : {});
  const base = await stored(fixture, who, id); const versions = await s3Versions(fixture); const image = base.row?.thumbnail as { imageId: string; versionId: string; bytes: number } | null | undefined; const jobBefore = image ? await readJob(fixture, image.imageId) : undefined;
  if (withImage && (!image || jobBefore?.state !== 'committed')) throw new Error('STORE_SETUP_FAILED');
  const ops = kind === 'patch-patch' ? ['patch', 'patch'] : kind === 'delete-delete' ? ['delete', 'delete'] : ['patch', 'delete'];
  const titles = ['first title', 'second title'];
  const probes = await concurrently(ops.map((op, index) => () => op === 'patch' ? patchReq(fixture, who, id, created.etag, { title: titles[index]! }) : deleteReq(fixture, who, id, created.etag)));
  recorder.recordInput({ httpStatus: probes.find(probe => probe.status === 200)?.status ?? probes[0]!.status });
  const winnerIndex = probes.findIndex(probe => probe.status === 200); const wins = probes.filter(probe => probe.status === 200).length;
  const loserIndex = winnerIndex === 0 ? 1 : 0; const winner = probes[winnerIndex]; const loser = probes[loserIndex];
  const winnerOp = winnerIndex >= 0 ? ops[winnerIndex]! : 'none'; const loserOp = ops[loserIndex]!;
  const loserOk = !!loser && wins === 1 && (errorIs(loser, 412, 'PRECONDITION_FAILED') || (winnerOp === 'delete' && errorIs(loser, 404, 'REMINDER_NOT_FOUND')));
  score.ok('http', kind === 'patch-patch' ? 'requests-overlapped-one-200-one-412' : 'requests-overlapped-one-200-one-412-or-404', overlapped(probes[0]!, probes[1]!) && wins === 1 && loserOk && (kind !== 'patch-patch' || loser?.status === 412));
  if (wins === 1 && winner && loser) {
    track(recorder, caseId, 'winner-result-delivered', winner, 200, winnerOp === 'patch' ? 'patch' : 'remove');
    track(recorder, caseId, 'loser-result-delivered', loser, loser.status, loserOp === 'patch' ? 'patch' : 'remove', loser.status === 404 ? 'REMINDER_NOT_FOUND' : 'PRECONDITION_FAILED');
  }
  const after = await stored(fixture, who, id); const get = await getReq(fixture, who, id);
  const patchWon = winnerOp === 'patch'; const deleteWon = winnerOp === 'delete';
  if (get.status === 200) track(recorder, caseId, 'final-get-result-delivered', get, 200, 'get'); else track(recorder, caseId, 'final-get-result-delivered', get, get.status, 'get', 'REMINDER_NOT_FOUND');
  const jobAfter = image ? await readJob(fixture, image.imageId) : undefined;
  if (kind === 'delete-delete') score.ok('http', 'final-get-404', deleteWon && errorIs(get, 404, 'REMINDER_NOT_FOUND'));
  else score.ok('http', 'final-get-matches-winner', patchWon ? get.status === 200 && !!winner && get.bytes.equals(winner.bytes) && etagOf(get) === etagOf(winner) : deleteWon && errorIs(get, 404, 'REMINDER_NOT_FOUND'));
  const imageUnchanged = !image || (jobAfter?.state === (deleteWon ? 'retired' : 'committed') && jobAfter.versionId === image.versionId);
  const bytesOk = after.state.imageBytes === (deleteWon ? 0 : image?.bytes ?? 0);
  const winnerTitle = titles[winnerIndex];
  if (kind === 'patch-patch') score.ok('dynamodb', 'revision-2-once-counter-unchanged-winner-fields', patchWon && !!winner && matchesDto(after.row, winner) && after.row?.revision === 2 && after.row.title === winnerTitle && after.state.itemCount === 1 && bytesOk);
  else if (kind === 'delete-delete') score.ok('dynamodb', 'one-tombstone-counters-decremented-once-job-retired-once', deleteWon && isTombstone(after.row, id, who.ownerId, 2) && after.state.itemCount === 0 && bytesOk && imageUnchanged && !!winner && winner.text === bodyOf(id, 2));
  else score.ok('dynamodb', 'one-winner-state-counters-and-job-consistent', wins === 1 && (patchWon ? !!winner && matchesDto(after.row, winner) && after.row?.revision === 2 && after.row.title === titles[0] && after.state.itemCount === 1 : isTombstone(after.row, id, who.ownerId, 2) && after.state.itemCount === 0) && bytesOk && imageUnchanged);
  score.ok('s3', 'image-versions-unchanged-by-race', versions === await s3Versions(fixture));
}
for (const kind of ['patch-patch', 'delete-delete', 'patch-delete'] as const) register(`STORE-03/${kind}`, (fixture, recorder, score) => race(fixture, recorder, score, `STORE-03/${kind}`, kind));

// STORE-04 create races, independent updates and resends.
register('STORE-04/same-id-create', async (fixture, recorder, score) => {
  const caseId = 'STORE-04/same-id-create'; const id = 'dup-1'; const who = await fresh(fixture); const versions = await s3Versions(fixture); const titles = ['first title', 'second title'];
  const probes = await concurrently(titles.map(title => () => createItem(fixture, who, JSON.stringify(makeInput({ id, title })))));
  const winnerIndex = probes.findIndex(probe => probe.status === 201); const wins = probes.filter(probe => probe.status === 201).length; const winner = probes[winnerIndex]; const loser = probes[winnerIndex === 0 ? 1 : 0];
  recorder.recordInput({ httpStatus: winner?.status ?? probes[0]!.status });
  score.ok('http', 'requests-overlapped-one-201-one-409', overlapped(probes[0]!, probes[1]!) && wins === 1 && !!winner && !!loser && itemHeaders(winner) && errorIs(loser, 409, 'ALREADY_EXISTS'));
  if (wins === 1 && winner && loser) { track(recorder, caseId, 'winner-result-delivered', winner, 201, 'create'); track(recorder, caseId, 'loser-result-delivered', loser, 409, 'create', 'ALREADY_EXISTS'); }
  const read = await getReq(fixture, who, id); track(recorder, caseId, 'readback-result-delivered', read, 200, 'get'); const after = await stored(fixture, who, id);
  score.ok('http', 'winner-readback-matches', !!winner && read.status === 200 && read.bytes.equals(winner.bytes) && etagOf(read) === etagOf(winner));
  score.ok('dynamodb', 'one-row-winner-fields-counter-1', !!winner && matchesDto(after.row, winner) && after.row?.revision === 1 && after.row.title === titles[winnerIndex] && after.state.itemCount === 1);
  score.ok('s3', 'no-image-versions-added', versions === await s3Versions(fixture));
});
register('STORE-04/different-item-patch', async (fixture, recorder, score) => {
  const caseId = 'STORE-04/different-item-patch'; const who = await fresh(fixture); const versions = await s3Versions(fixture);
  const x = await setup(fixture, recorder, caseId, who, 'item-x', 'create-x-result-delivered'); const y = await setup(fixture, recorder, caseId, who, 'item-y', 'create-y-result-delivered');
  const [px, py] = await concurrently([() => patchReq(fixture, who, 'item-x', x.etag, { title: 'x patched' }), () => patchReq(fixture, who, 'item-y', y.etag, { title: 'y patched' })]) as [Probe, Probe];
  recorder.recordInput({ httpStatus: px.status });
  score.ok('http', 'requests-overlapped-both-200', overlapped(px, py) && px.status === 200 && py.status === 200);
  track(recorder, caseId, 'patch-x-result-delivered', px, px.status, 'patch', px.status === 200 ? undefined : 'PRECONDITION_FAILED'); track(recorder, caseId, 'patch-y-result-delivered', py, py.status, 'patch', py.status === 200 ? undefined : 'PRECONDITION_FAILED');
  const gx = await getReq(fixture, who, 'item-x'); const gy = await getReq(fixture, who, 'item-y'); track(recorder, caseId, 'readback-x-result-delivered', gx, 200, 'get'); track(recorder, caseId, 'readback-y-result-delivered', gy, 200, 'get');
  score.ok('http', 'both-readbacks-match', gx.status === 200 && gy.status === 200 && gx.bytes.equals(px.bytes) && gy.bytes.equals(py.bytes) && exactEtag(gx, 2) && exactEtag(gy, 2));
  const rx = await stored(fixture, who, 'item-x'); const ry = await stored(fixture, who, 'item-y');
  score.ok('dynamodb', 'both-rows-revision-2-counter-unchanged', matchesDto(rx.row, px) && matchesDto(ry.row, py) && rx.row?.revision === 2 && ry.row?.revision === 2 && rx.row?.title === 'x patched' && ry.row?.title === 'y patched' && rx.state.itemCount === 2);
  score.ok('s3', 'no-image-versions-added', versions === await s3Versions(fixture));
});
register('STORE-04/resend-create', async (fixture, recorder, score) => {
  const caseId = 'STORE-04/resend-create'; const id = 'resend-1'; const who = await fresh(fixture); const versions = await s3Versions(fixture); const body = JSON.stringify(makeInput({ id, title: 'same body' }));
  const first = await createItem(fixture, who, body); track(recorder, caseId, 'create-result-delivered', first, 201, 'create'); const before = await stored(fixture, who, id);
  const resend = await createItem(fixture, who, body); recorder.recordInput({ httpStatus: resend.status }); track(recorder, caseId, 'resend-result-delivered', resend, 409, 'create', 'ALREADY_EXISTS'); const after = await stored(fixture, who, id);
  score.ok('http', 'first-create-201', first.status === 201 && itemHeaders(first) && exactEtag(first, 1));
  score.ok('http', 'resend-409-already-exists', errorIs(resend, 409, 'ALREADY_EXISTS'));
  score.ok('dynamodb', 'resend-leaves-row-and-counter-unchanged', matchesDto(before.row, first) && isDeepStrictEqual(before, after) && after.state.itemCount === 1);
  score.ok('s3', 'no-image-versions-added', versions === await s3Versions(fixture));
});
register('STORE-04/resend-delete', async (fixture, recorder, score) => {
  const caseId = 'STORE-04/resend-delete'; const id = 'resend-2'; const who = await fresh(fixture); const versions = await s3Versions(fixture);
  const created = await setup(fixture, recorder, caseId, who, id, 'create-result-delivered');
  const first = await deleteReq(fixture, who, id, created.etag); track(recorder, caseId, 'delete-result-delivered', first, 200, 'remove'); const before = await stored(fixture, who, id);
  const resend = await deleteReq(fixture, who, id, created.etag); recorder.recordInput({ httpStatus: resend.status }); track(recorder, caseId, 'resend-result-delivered', resend, 404, 'remove', 'REMINDER_NOT_FOUND'); const after = await stored(fixture, who, id);
  score.ok('http', 'first-delete-200', first.status === 200 && first.text === bodyOf(id, 2));
  score.ok('http', 'resend-404-not-found', errorIs(resend, 404, 'REMINDER_NOT_FOUND'));
  score.ok('dynamodb', 'resend-leaves-tombstone-and-counter-unchanged', isTombstone(before.row, id, who.ownerId, 2) && isDeepStrictEqual(before, after) && after.state.itemCount === 0);
  score.ok('s3', 'no-image-versions-added', versions === await s3Versions(fixture));
});

// STORE-05 tombstones.
register('STORE-05/lifecycle-tombstone', async (fixture, recorder, score) => {
  const caseId = 'STORE-05/lifecycle-tombstone'; const who = await fresh(fixture); const versions = await s3Versions(fixture);
  const x = await setup(fixture, recorder, caseId, who, 'life-x', 'create-x-result-delivered'); const y = await setup(fixture, recorder, caseId, who, 'life-y', 'create-y-result-delivered');
  const yBefore = await stored(fixture, who, 'life-y');
  const read = await getReq(fixture, who, 'life-x'); track(recorder, caseId, 'get-result-delivered', read, 200, 'get');
  const del = await deleteReq(fixture, who, 'life-x', x.etag); recorder.recordInput({ httpStatus: del.status }); track(recorder, caseId, 'delete-result-delivered', del, 200, 'remove');
  const gone = await getReq(fixture, who, 'life-x'); track(recorder, caseId, 'get-404-result-delivered', gone, 404, 'get', 'REMINDER_NOT_FOUND');
  const list = await send(fixture, '/v2/reminders', { token: who.token }); track(recorder, caseId, 'list-result-delivered', list, 200, 'list'); const page = listOf(list);
  const recreate = await createItem(fixture, who, JSON.stringify(makeInput({ id: 'life-x', title: 'again' }))); track(recorder, caseId, 'recreate-result-delivered', recreate, 409, 'create', 'ALREADY_EXISTS');
  const after = await stored(fixture, who, 'life-x'); const yAfter = await stored(fixture, who, 'life-y');
  score.ok('http', 'get-200-then-delete-200-exact-body', read.status === 200 && read.bytes.equals(x.probe.bytes) && del.status === 200 && del.text === bodyOf('life-x', 2) && del.headers.get('etag') === null && commonHeaders(del) && del.headers.get('cache-control') === 'no-store');
  score.ok('http', 'get-after-delete-404', errorIs(gone, 404, 'REMINDER_NOT_FOUND'));
  score.ok('http', 'list-excludes-tombstone', !!page && page.items.length === 1 && page.items[0]!.id === 'life-y' && page.nextCursor === null);
  score.ok('http', 'recreate-409', errorIs(recreate, 409, 'ALREADY_EXISTS'));
  score.ok('dynamodb', 'exact-tombstone-fields-counter-decremented-other-item-unchanged', isTombstone(after.row, 'life-x', who.ownerId, 2) && after.state.itemCount === 1 && matchesDto(yAfter.row, y.probe) && isDeepStrictEqual(yBefore.row, yAfter.row));
  score.ok('s3', 'no-image-versions-added', versions === await s3Versions(fixture));
});
register('STORE-05/delete-with-image', async (fixture, recorder, score) => {
  const caseId = 'STORE-05/delete-with-image'; const id = 'img-1'; const who = await fresh(fixture); const versions = await s3Versions(fixture);
  const created = await setup(fixture, recorder, caseId, who, id, 'create-result-delivered', { thumbnail: PNG_BASE64 });
  const withImage = await stored(fixture, who, id); const image = withImage.row?.thumbnail as { imageId: string; versionId: string; bytes: number } | null | undefined; const afterCreateVersions = await s3Versions(fixture);
  const jobBefore = image ? await readJob(fixture, image.imageId) : undefined;
  const del = await deleteReq(fixture, who, id, created.etag); recorder.recordInput({ httpStatus: del.status }); track(recorder, caseId, 'delete-result-delivered', del, 200, 'remove');
  const after = await stored(fixture, who, id); const afterDeleteVersions = await s3Versions(fixture); const job = image ? await readJob(fixture, image.imageId) : undefined;
  const gone = await getReq(fixture, who, id); track(recorder, caseId, 'get-404-result-delivered', gone, 404, 'get', 'REMINDER_NOT_FOUND');
  const url = await send(fixture, `${itemPath(id)}/thumbnail-url`, { token: who.token }); track(recorder, caseId, 'thumbnail-404-result-delivered', url, 404, 'thumbnail', 'REMINDER_NOT_FOUND');
  score.ok('http', 'create-with-thumbnail-201', created.probe.status === 201 && !!image && isRecord(dtoOf(created.probe)?.thumbnail) && image.bytes === 12);
  score.ok('http', 'delete-200', del.status === 200 && del.text === bodyOf(id, 2));
  score.ok('http', 'get-after-delete-404', errorIs(gone, 404, 'REMINDER_NOT_FOUND'));
  score.ok('http', 'thumbnail-url-after-delete-404', errorIs(url, 404, 'REMINDER_NOT_FOUND'));
  score.ok('dynamodb', 'tombstone-without-image-ref-counters-zero-job-retired', !!image && withImage.state.itemCount === 1 && withImage.state.imageBytes === image.bytes && jobBefore?.state === 'committed' && isTombstone(after.row, id, who.ownerId, 2) && after.state.itemCount === 0 && after.state.imageBytes === 0 && job?.state === 'retired' && job.versionId === image.versionId && job.ownerId === who.ownerId);
  score.ok('s3', 'image-version-retained-immediately-after-delete', afterCreateVersions === versions + 1 && afterDeleteVersions === afterCreateVersions);
});

// API-14 the real limit from a synthetic count of 119, inside one minute window, with two tokens of the same owner.
const WINDOW_MARGIN_MS = 20_000;
register('API-14/rate-boundary-seeded', async (fixture, recorder, score) => {
  const caseId = 'API-14/rate-boundary-seeded'; const first = await actor(fixture, 'a'); const second = await secondToken(fixture, 'a');
  if (first.ownerId !== second.ownerId) throw new Error('API_CONTROL_FAILED');
  const state = await readOwnerState(fixture, first.ownerId); if (state.itemCount !== 0 || await rateTotal(fixture, first.ownerId) !== 0) throw new Error('STORE_OWNER_NOT_FRESH');
  // The precondition is fixed: enough of the window must remain for two real requests, otherwise wait for the next minute before seeding.
  const remaining = 60_000 - (apiIo.now() % 60_000); if (remaining < WINDOW_MARGIN_MS) await apiIo.sleep(remaining + 1_000);
  const minute = Math.floor(apiIo.now() / 60_000); const key = keys.rate(first.ownerId, minute); const versions = await s3Versions(fixture); const domain = await snapshotOwnedStorage(fixture, { excludeRate: true });
  let reading: Probe | undefined; let limited: Probe | undefined; let after: { count?: unknown; expiresAt?: unknown } | undefined; let crossed = true;
  try {
    await seedRateBeforeLimit(fixture, first.ownerId, minute);
    reading = await send(fixture, '/v2/reminders', { token: first.token }); limited = await send(fixture, '/v2/reminders', { token: second.token });
    crossed = Math.floor(apiIo.now() / 60_000) !== minute;
    after = (await fixture.clients.dynamodb.send(new GetCommand({ TableName: fixture.config.ownerStateTable, Key: key, ConsistentRead: true }))).Item;
  } finally { await fixture.clients.dynamodb.send(new DeleteCommand({ TableName: fixture.config.ownerStateTable, Key: key })); }
  recorder.recordInput({ httpStatus: limited?.status ?? 0 });
  const retry = limited?.headers.get('retry-after') ?? ''; const body = limited?.json;
  score.ok('http', 'request-at-119-is-200', !!reading && !!listOf(reading));
  score.ok('http', 'second-token-request-121-is-429-retry-after-matches-body', !!limited && errorIs(limited, 429, 'OWNER_RATE_LIMIT_EXCEEDED') && /^[1-9][0-9]?$/.test(retry) && Number(retry) <= 60 && isRecord(body) && body.retryAfterSeconds === Number(retry));
  score.ok('http', 'window-not-crossed', !crossed);
  score.ok('dynamodb', 'seeded-119-exact-expires-at-then-120-held', !!after && after.count === 120 && after.expiresAt === keys.rateExpiresAt(minute));
  score.ok('dynamodb', 'rate-requests-leave-reminders-unchanged', domain === await snapshotOwnedStorage(fixture, { excludeRate: true }));
  score.ok('s3', 'no-image-versions-added', versions === await s3Versions(fixture));
  if (reading) track(recorder, caseId, 'request-120-result-delivered', reading, 200, 'list');
  if (limited) track(recorder, caseId, 'request-121-result-delivered', limited, 429, 'list', 'OWNER_RATE_LIMIT_EXCEEDED');
});
