import { DeleteCommand, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ListObjectVersionsCommand } from '@aws-sdk/client-s3';
import { ownerIdFor } from '../../../../src/api/identity.ts';
import { keys } from '../../../../src/shared/ports.ts';
import { caseActions, caseGuards } from './cases.ts';
import { Score } from './auth-cases.ts';
import { fixtureState } from './fixture.ts';
import { localRequest } from './transport.ts';
import { readOwnerState, readReminder, snapshotOwnedStorage } from './storage.ts';
import { acceptParams, forgedCursors, makeInput, methodParams, rejectParams, unknownPaths } from './input-fixtures.ts';
import type { AcceptParam, RejectParam } from './input-fixtures.ts';
import type { AuthSession, CaseRecorder, HttpResult, LogExpectation, SuiteFixture } from './types.ts';

const READ = 'reminder-api/read'; const WRITE = 'reminder-api/write';
const ORIGIN = 'https://extension.example.test'; const OTHER_ORIGIN = 'https://other.example.test';
/** Clock/sleep/raw transport seams; production uses the real ones, offline tests substitute simulated time. */
export const apiIo = {
  now: (): number => Date.now(),
  sleep: (ms: number): Promise<void> => new Promise<void>(resolve => setTimeout(resolve, ms)),
  raw: (fixture: SuiteFixture, url: URL, options: { method: string; headers: Record<string, string> }): Promise<HttpResult> => localRequest(fixture.target, url, options),
};
const tick = (): Promise<void> => new Promise<void>(resolve => setTimeout(resolve, 2)); // distinct log milliseconds; always real time
/** Each individual sleep stays at or below 30 seconds. */
async function sleepFor(ms: number): Promise<void> { for (let left = ms; left > 0; left -= 30_000) await apiIo.sleep(Math.min(30_000, left)); }

type Owner = 'a' | 'b';
type Actor = { owner: Owner; token: string; ownerId: string };
type Shared = { passed: Set<string>; data: Map<string, unknown> };
/** Sessions belong to one case's (or one declared dependency group's) auth, so users never leak across independent cases. */
const sessions = new WeakMap<object, Map<Owner, AuthSession>>();
const shared = new WeakMap<object, Shared>();
function stateOf(fixture: SuiteFixture): Shared { const key = fixtureState(fixture); let value = shared.get(key); if (!value) { value = { passed: new Set(), data: new Map() }; shared.set(key, value); } return value; }
/** A signed token for the shared owner A or B; renewed before its real five minute life ends. */
async function actor(fixture: SuiteFixture, owner: Owner): Promise<Actor> {
  let owned = sessions.get(fixture.auth); if (!owned) { owned = new Map(); sessions.set(fixture.auth, owned); } let session = owned.get(owner);
  if (!session || session.claims.exp * 1000 - Date.now() < 60_000) { session = await fixture.auth.login(owner, [READ, WRITE], 'primary'); owned.set(owner, session); }
  return { owner, token: session.accessToken, ownerId: ownerIdFor(fixture.config.issuer, session.claims.sub) };
}
/** A second token for the same owner, used to show that the rate window is shared per owner. */
async function secondToken(fixture: SuiteFixture, owner: Owner): Promise<Actor> { const session = await fixture.auth.login(owner, [READ, WRITE], 'primary'); return { owner, token: session.accessToken, ownerId: ownerIdFor(fixture.config.issuer, session.claims.sub) }; }

type Probe = { status: number; headers: Headers; text: string; json: unknown; requestId: string | null; since: number; until: number };
type Options = { token?: string; method?: string; headers?: Record<string, string>; body?: string };
async function send(fixture: SuiteFixture, path: string, options: Options = {}): Promise<Probe> {
  const since = Date.now(); const response = await fixture.request(path, options); const until = Date.now();
  const text = response.bytes.toString('utf8'); let json: unknown; try { json = JSON.parse(text); } catch { json = undefined; }
  return { status: response.status, headers: response.headers, text, json, requestId: response.headers.get('x-request-id'), since, until };
}
const jsonHeaders = (contentType?: string | null): Record<string, string> => contentType === null ? {} : { 'content-type': contentType ?? 'application/json' };
const edgeId = (probe: Probe): string => probe.requestId ?? probe.headers.get('apigw-requestid') ?? probe.headers.get('x-amzn-requestid') ?? 'uncorrelated-gateway-answer';
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DTO_KEYS = 'id,url,title,reminderTime,autoOpen,webPush,hidden,revision,createdAt,updatedAt,thumbnail';

/** Lambda-reaching responses are delivered as API result logs; the expectation names status/code/operation, never content. */
function logOf(probe: Probe, status: number, extra: { code?: string; operation?: string } = {}): LogExpectation {
  if (!probe.requestId) throw new Error('API_REQUEST_ID_MISSING');
  return { service: 'api', requestId: probe.requestId, since: probe.since, until: probe.until, status, mode: 'present', ...extra };
}
function defer(recorder: CaseRecorder, caseId: string, assertion: string, expectation: LogExpectation, controls?: { before: LogExpectation; after: LogExpectation }): void { recorder.deferLogs({ caseId, assertion, expectation, ...(controls ? { controls } : {}) }); }

function commonHeaders(probe: Probe): boolean { return /^application\/json/i.test(probe.headers.get('content-type') ?? '') && probe.headers.get('x-content-type-options') === 'nosniff' && !!probe.requestId; }
/** A Lambda error: the top-level code, safe message and the same request id as the header. */
function errorIs(probe: Probe, status: number, code: string): boolean {
  const body = probe.json; if (probe.status !== status || !isRecord(body)) return false;
  const shape = Object.keys(body).sort().join(',');
  const allowed = status === 429 ? ['code,message,requestId,retryAfterSeconds'] : code === 'LEGACY_API_REMOVED' ? ['code,message,replacement,requestId'] : ['code,message,requestId'];
  return allowed.includes(shape) && body.code === code && typeof body.message === 'string' && body.requestId === probe.requestId && commonHeaders(probe) && probe.headers.get('etag') === null && probe.headers.get('cache-control') === 'no-store';
}
const strongEtag = (probe: Probe): boolean => /^"[\x21\x23-\x7e]+"$/.test(probe.headers.get('etag') ?? '');
const itemHeaders = (probe: Probe): boolean => commonHeaders(probe) && strongEtag(probe) && probe.headers.get('cache-control') === 'private, no-store, no-transform';
function dtoOf(probe: Probe): Record<string, unknown> | undefined { return isRecord(probe.json) && Object.keys(probe.json).join(',') === DTO_KEYS && JSON.stringify(probe.json) === probe.text && ISO.test(String(probe.json.createdAt)) && ISO.test(String(probe.json.updatedAt)) && ISO.test(String(probe.json.reminderTime)) ? probe.json : undefined; }
function listOf(probe: Probe): { items: Record<string, unknown>[]; nextCursor: string | null } | undefined {
  const body = probe.json;
  if (probe.status !== 200 || !isRecord(body) || Object.keys(body).join(',') !== 'items,nextCursor' || !Array.isArray(body.items) || !(body.nextCursor === null || (typeof body.nextCursor === 'string' && body.nextCursor.length > 0)) || !commonHeaders(probe) || probe.headers.get('etag') !== null) return undefined;
  const items = body.items as unknown[]; if (!items.every(isRecord) || !items.every(item => Object.keys(item).join(',') === DTO_KEYS)) return undefined;
  return { items: items as Record<string, unknown>[], nextCursor: body.nextCursor as string | null };
}
const ids = (items: Record<string, unknown>[]): string[] => items.map(item => String(item.id));
const sequence = (from: number, to: number): string[] => Array.from({ length: to - from + 1 }, (_, index) => `p-${String(from + index).padStart(3, '0')}`);
const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);

/** Every request an owner sends in the current minute; the sum over all minutes is stable across a minute boundary. */
async function rateTotal(fixture: SuiteFixture, ownerId: string): Promise<number> {
  let total = 0; let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await fixture.clients.dynamodb.send(new QueryCommand({ TableName: fixture.config.ownerStateTable, ConsistentRead: true, KeyConditionExpression: 'pk = :pk AND begins_with(sk, :rate)', ExpressionAttributeValues: { ':pk': `OWNER#${ownerId}`, ':rate': 'RATE#' }, ...(ExclusiveStartKey ? { ExclusiveStartKey } : {}) }));
    for (const item of page.Items ?? []) total += Number(item.count ?? 0);
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return total;
}
async function s3Versions(fixture: SuiteFixture): Promise<number> {
  let count = 0; let KeyMarker: string | undefined; let VersionIdMarker: string | undefined;
  do {
    const page = await fixture.clients.s3.send(new ListObjectVersionsCommand({ Bucket: fixture.config.imagesBucket, ...(KeyMarker ? { KeyMarker } : {}), ...(VersionIdMarker ? { VersionIdMarker } : {}) }));
    count += (page.Versions?.length ?? 0) + (page.DeleteMarkers?.length ?? 0); KeyMarker = page.NextKeyMarker; VersionIdMarker = page.NextVersionIdMarker;
    if (page.IsTruncated && !KeyMarker) throw new Error('STORAGE_MISMATCH');
  } while (KeyMarker);
  return count;
}
type Snapshot = { domain: string; full: string; rate: number; s3: number };
const snapshot = async (fixture: SuiteFixture, ...owners: Actor[]): Promise<Snapshot & { rates: number[] }> => { const rates: number[] = []; for (const owner of owners) rates.push(await rateTotal(fixture, owner.ownerId)); return { domain: await snapshotOwnedStorage(fixture, { excludeRate: true }), full: await snapshotOwnedStorage(fixture), rate: rates[0] ?? 0, rates, s3: await s3Versions(fixture) }; };

async function createItem(fixture: SuiteFixture, who: Actor, body: string, contentType?: string): Promise<Probe> {
  return send(fixture, '/v2/reminders', { token: who.token, method: 'POST', headers: jsonHeaders(contentType), body });
}
type Expected = { storedId: string; title?: string; url?: string; reminderTime?: string };
/** HTTP result, stored row and counters for one create that must succeed; used by CRUD and every accepted boundary. */
async function createChecked(fixture: SuiteFixture, who: Actor, body: string, expected: Expected, contentType?: string): Promise<{ probe: Probe; http: boolean; stored: boolean; s3: boolean }> {
  const before = await readOwnerState(fixture, who.ownerId); const versions = await s3Versions(fixture);
  const probe = await createItem(fixture, who, body, contentType); const dto = dtoOf(probe); const location = probe.headers.get('location');
  const http = probe.status === 201 && !!dto && itemHeaders(probe) && dto.id === expected.storedId && dto.revision === 1 && dto.thumbnail === null && (expected.title === undefined || dto.title === expected.title) && (expected.url === undefined || dto.url === expected.url) && (expected.reminderTime === undefined || dto.reminderTime === expected.reminderTime) && location === `/v2/reminders/${encodeURIComponent(expected.storedId)}`;
  const row = await readReminder(fixture, who.ownerId, expected.storedId) as unknown as Record<string, unknown> | null; const after = await readOwnerState(fixture, who.ownerId);
  const stored = !!row && !!dto && row.deleted === false && row.ownerId === who.ownerId && ['id', 'url', 'title', 'reminderTime', 'autoOpen', 'webPush', 'hidden', 'createdAt', 'updatedAt'].every(field => row[field] === dto[field]) && row.revision === 1 && row.thumbnail === null && after.itemCount === before.itemCount + 1 && after.imageBytes === before.imageBytes;
  const s3 = versions === await s3Versions(fixture);
  return { probe, http, stored, s3 };
}

const register = (id: string, deps: string[], body: (fixture: SuiteFixture, recorder: CaseRecorder, score: Score) => Promise<void>): void => {
  caseActions.set(id, async (fixture, recorder) => { const score = new Score(); await body(fixture, recorder, score); score.emit(id, recorder); stateOf(fixture).passed.add(id); });
  if (deps.length) caseGuards.set(id, fixture => deps.some(dep => !stateOf(fixture).passed.has(dep)));
};
const operationFor = (method: string, path: string): string => method === 'POST' ? 'create' : method === 'PATCH' ? 'patch' : /^\/v2\/reminders(\?|$)/.test(path) ? 'list' : 'get';

/** Authenticated rejection from the Lambda: exact status/code, storage unchanged, rate consumed once, valid control afterwards. */
async function rejectCase(fixture: SuiteFixture, recorder: CaseRecorder, score: Score, caseId: string, param: RejectParam): Promise<void> {
  const who = await actor(fixture, 'a');
  const before = await snapshot(fixture, who);
  const headers = param.method === 'GET' ? {} : { ...jsonHeaders(param.contentType), ...(param.ifMatch ? { 'if-match': param.ifMatch } : {}) };
  const probe = await send(fixture, param.path, { token: who.token, method: param.method, headers, ...(param.body !== undefined ? { body: param.body } : {}) });
  recorder.recordInput({ httpStatus: probe.status });
  const after = await snapshot(fixture, who);
  score.ok('http', 'rejected-as-expected', errorIs(probe, param.status, param.code));
  score.ok('dynamodb', 'rejection-storage-unchanged-rate-plus-one', before.domain === after.domain && after.rate === before.rate + 1);
  score.ok('s3', 'no-image-versions-added', before.s3 === after.s3);
  if (probe.requestId) defer(recorder, caseId, 'rejection-result-delivered', logOf(probe, param.status, { code: param.code, operation: operationFor(param.method, param.path) }));
  const control = await send(fixture, '/v2/reminders', { token: who.token });
  score.ok('http', 'valid-control-200', !!listOf(control));
  if (control.requestId) defer(recorder, caseId, 'control-result-delivered', logOf(control, 200, { operation: 'list' }));
  if (!probe.requestId) throw new Error('API_REQUEST_ID_MISSING');
}
for (const param of rejectParams) register(param.id, [], (fixture, recorder, score) => rejectCase(fixture, recorder, score, param.id, param));

async function acceptCase(fixture: SuiteFixture, recorder: CaseRecorder, score: Score, caseId: string, param: AcceptParam): Promise<void> {
  if (param.bodyBytes !== undefined && Buffer.byteLength(param.body, 'utf8') !== param.bodyBytes) throw new Error('INPUT_BODY_REJECTED');
  const who = await actor(fixture, 'a');
  const result = await createChecked(fixture, who, param.body, { storedId: param.storedId, ...(param.title !== undefined ? { title: param.title } : {}), ...(param.url !== undefined ? { url: param.url } : {}), ...(param.reminderTime !== undefined ? { reminderTime: param.reminderTime } : {}) }, param.contentType);
  recorder.recordInput({ httpStatus: result.probe.status });
  score.ok('http', 'created-201-location-etag-dto', result.http); score.ok('dynamodb', 'stored-reminder-and-counter-match', result.stored); score.ok('s3', 'no-image-versions-added', result.s3);
  if (result.probe.requestId) defer(recorder, caseId, 'create-result-delivered', logOf(result.probe, 201, { operation: 'create' }));
  // The path a client would use: the Location exactly as returned, with no re-encoding by the harness.
  const read = await send(fixture, result.probe.headers.get('location') ?? `/v2/reminders/${encodeURIComponent(param.storedId)}`, { token: who.token });
  score.ok('http', 'readback-get-matches', read.status === 200 && read.text === result.probe.text && read.headers.get('etag') === result.probe.headers.get('etag') && itemHeaders(read));
  if (read.requestId) defer(recorder, caseId, 'readback-result-delivered', logOf(read, 200, { operation: 'get' }));
  if (!result.probe.requestId || !read.requestId) throw new Error('API_REQUEST_ID_MISSING');
}
for (const param of acceptParams) register(param.id, [], (fixture, recorder, score) => acceptCase(fixture, recorder, score, param.id, param));

/** A request nobody should have to authenticate: the stored rows and rate must not move. */
async function unchangedAround(fixture: SuiteFixture, who: Actor, action: () => Promise<Probe>): Promise<{ probe: Probe; unchanged: boolean; s3: boolean }> {
  const before = await snapshot(fixture, who); const probe = await action(); const after = await snapshot(fixture, who);
  return { probe, unchanged: before.full === after.full && before.rate === after.rate, s3: before.s3 === after.s3 };
}

register('API-01/gate-transition', [], async (fixture, recorder, score) => {
  const who = await actor(fixture, 'a');
  const before = await snapshot(fixture, who); let health: Probe; let unpublishedReady: Probe; let unpublishedList: Probe;
  await fixture.setPublication(false);
  try { health = await send(fixture, '/healthz'); unpublishedReady = await send(fixture, '/readyz'); unpublishedList = await send(fixture, '/v2/reminders', { token: who.token }); }
  finally { await fixture.setPublication(true); }
  const ready = await send(fixture, '/readyz'); const list = await send(fixture, '/v2/reminders', { token: who.token });
  recorder.recordInput({ httpStatus: unpublishedList.status });
  const after = await snapshot(fixture, who);
  score.ok('http', 'health-200', health.status === 200 && health.text === '{"healthy":true}' && commonHeaders(health));
  score.ok('http', 'ready-unpublished-503', errorIs(unpublishedReady, 503, 'SERVICE_UNAVAILABLE'));
  score.ok('http', 'v2-unpublished-503', errorIs(unpublishedList, 503, 'SERVICE_UNAVAILABLE'));
  score.ok('http', 'ready-published-200', ready.status === 200 && ready.text === '{"ready":true}' && commonHeaders(ready));
  score.ok('http', 'v2-published-200', !!listOf(list));
  score.ok('dynamodb', 'gate-requests-leave-reminders-unchanged', before.domain === after.domain && after.rate === before.rate + 2);
  score.ok('s3', 'no-image-versions-added', before.s3 === after.s3);
  defer(recorder, 'API-01/gate-transition', 'health-result-delivered', logOf(health, 200, { operation: 'health' }));
  defer(recorder, 'API-01/gate-transition', 'ready-503-result-delivered', logOf(unpublishedReady, 503, { operation: 'ready', code: 'SERVICE_UNAVAILABLE' }));
  defer(recorder, 'API-01/gate-transition', 'v2-503-result-delivered', logOf(unpublishedList, 503, { operation: 'list', code: 'SERVICE_UNAVAILABLE' }));
  defer(recorder, 'API-01/gate-transition', 'ready-200-result-delivered', logOf(ready, 200, { operation: 'ready' }));
  defer(recorder, 'API-01/gate-transition', 'v2-200-result-delivered', logOf(list, 200, { operation: 'list' }));
});

for (const [id, method] of [['API-02/legacy-post', 'POST'], ['API-02/legacy-put', 'PUT']] as const) register(id, [], async (fixture, recorder, score) => {
  const who = await actor(fixture, 'a');
  const { probe, unchanged, s3 } = await unchangedAround(fixture, who, () => send(fixture, '/reminders', { method, headers: jsonHeaders(), body: '{"broken":' }));
  recorder.recordInput({ httpStatus: probe.status });
  score.ok('http', 'legacy-410-replacement', errorIs(probe, 410, 'LEGACY_API_REMOVED') && isRecord(probe.json) && probe.json.replacement === '/v2/reminders');
  score.ok('dynamodb', 'no-storage-or-rate-change', unchanged); score.ok('s3', 'no-image-versions-added', s3);
  defer(recorder, id, 'legacy-result-delivered', logOf(probe, 410, { operation: 'legacy', code: 'LEGACY_API_REMOVED' }));
});

for (const param of methodParams) register(param.id, [], async (fixture, recorder, score) => {
  const who = await actor(fixture, 'a');
  const { probe, unchanged, s3 } = await unchangedAround(fixture, who, () => send(fixture, param.path, { method: param.method }));
  recorder.recordInput({ httpStatus: probe.status });
  const allow = (probe.headers.get('allow') ?? '').split(',').map(value => value.trim()).filter(Boolean).sort();
  score.ok('http', 'method-not-allowed-405-allow-code', errorIs(probe, 405, 'METHOD_NOT_ALLOWED') && same(allow, [...param.allow].sort()));
  score.ok('dynamodb', 'no-storage-or-rate-change', unchanged); score.ok('s3', 'no-image-versions-added', s3);
  defer(recorder, param.id, 'method-result-delivered', logOf(probe, 405, { code: 'METHOD_NOT_ALLOWED' }));
});

/** The Gateway edge answers: no Lambda result may exist between a delivered control before and after. */
async function validControl(fixture: SuiteFixture, who: Actor): Promise<LogExpectation> { const probe = await send(fixture, '/v2/reminders', { token: who.token }); if (!listOf(probe)) throw new Error('API_CONTROL_FAILED'); return logOf(probe, 200, { operation: 'list' }); }
for (const param of unknownPaths) register(param.id, [], async (fixture, recorder, score) => {
  const who = await actor(fixture, 'a');
  const before = await validControl(fixture, who); await tick();
  const stored = await snapshot(fixture, who); const since = Date.now();
  const response = await send(fixture, param.path); const until = Date.now();
  const after = await snapshot(fixture, who); await tick();
  recorder.recordInput({ httpStatus: response.status });
  const control = await validControl(fixture, who);
  score.ok('http', 'unknown-path-404', response.status === 404);
  score.ok('dynamodb', 'probe-leaves-storage-and-rate-unchanged', stored.full === after.full && stored.rate === after.rate); score.ok('s3', 'no-image-versions-added', stored.s3 === after.s3);
  defer(recorder, param.id, 'unknown-path-api-result-absent', { service: 'api', requestId: edgeId(response), since, until, status: 404, mode: 'absent' }, { before, after: control });
});

// API-04 one item through its whole life. Later cases refuse to run (not-run) when an earlier one did not pass.
const CRUD_ID = 'crud-1';
type Crud = { etag: string; text: string; dto: Record<string, unknown> };
const crud = (fixture: SuiteFixture): Crud => { const value = stateOf(fixture).data.get('crud') as Crud | undefined; if (!value) throw new Error('CRUD_STATE_MISSING'); return value; };
register('API-04/empty-list', [], async (fixture, recorder, score) => {
  const who = await actor(fixture, 'a');
  const before = await snapshot(fixture, who); const probe = await send(fixture, '/v2/reminders', { token: who.token }); const after = await snapshot(fixture, who);
  recorder.recordInput({ httpStatus: probe.status });
  const state = await readOwnerState(fixture, who.ownerId);
  score.ok('http', 'list-200-empty-null-cursor-headers', probe.status === 200 && probe.text === '{"items":[],"nextCursor":null}' && commonHeaders(probe) && probe.headers.get('cache-control') === 'no-store' && probe.headers.get('etag') === null);
  score.ok('dynamodb', 'no-reminders-rate-plus-one', before.domain === after.domain && after.rate === before.rate + 1 && state.itemCount === 0); score.ok('s3', 'no-image-versions-added', before.s3 === after.s3);
  defer(recorder, 'API-04/empty-list', 'list-result-delivered', logOf(probe, 200, { operation: 'list' }));
});
register('API-04/create', [], async (fixture, recorder, score) => {
  const who = await actor(fixture, 'a');
  const body = JSON.stringify(makeInput({ id: CRUD_ID, title: 'First title' }));
  const result = await createChecked(fixture, who, body, { storedId: CRUD_ID, title: 'First title', reminderTime: '2026-10-03T00:00:00.000Z' });
  recorder.recordInput({ httpStatus: result.probe.status });
  score.ok('http', 'created-201-location-etag-dto', result.http); score.ok('dynamodb', 'stored-reminder-and-counter-match', result.stored); score.ok('s3', 'no-image-versions-added', result.s3);
  defer(recorder, 'API-04/create', 'create-result-delivered', logOf(result.probe, 201, { operation: 'create' }));
  const dto = dtoOf(result.probe); if (!dto) throw new Error('CRUD_STATE_MISSING');
  stateOf(fixture).data.set('crud', { etag: result.probe.headers.get('etag')!, text: result.probe.text, dto } satisfies Crud);
});
register('API-04/get', ['API-04/create'], async (fixture, recorder, score) => {
  const who = await actor(fixture, 'a'); const created = crud(fixture);
  const rowBefore = await readReminder(fixture, who.ownerId, CRUD_ID); const before = await snapshot(fixture, who);
  const probe = await send(fixture, `/v2/reminders/${CRUD_ID}`, { token: who.token }); const after = await snapshot(fixture, who); const rowAfter = await readReminder(fixture, who.ownerId, CRUD_ID);
  recorder.recordInput({ httpStatus: probe.status });
  score.ok('http', 'get-200-same-body-etag', probe.status === 200 && !!dtoOf(probe) && itemHeaders(probe) && probe.text === created.text && probe.headers.get('etag') === created.etag);
  score.ok('dynamodb', 'get-leaves-row-unchanged-rate-plus-one', same(rowBefore, rowAfter) && before.domain === after.domain && after.rate === before.rate + 1); score.ok('s3', 'no-image-versions-added', before.s3 === after.s3);
  defer(recorder, 'API-04/get', 'get-result-delivered', logOf(probe, 200, { operation: 'get' }));
});
register('API-04/patch', ['API-04/create'], async (fixture, recorder, score) => {
  const who = await actor(fixture, 'a'); const created = crud(fixture);
  const stateBefore = await readOwnerState(fixture, who.ownerId); const versions = await s3Versions(fixture);
  const probe = await send(fixture, `/v2/reminders/${CRUD_ID}`, { token: who.token, method: 'PATCH', headers: { ...jsonHeaders(), 'if-match': created.etag }, body: JSON.stringify({ title: 'Updated title', hidden: true }) });
  recorder.recordInput({ httpStatus: probe.status });
  const dto = dtoOf(probe); const row = await readReminder(fixture, who.ownerId, CRUD_ID) as unknown as Record<string, unknown> | null; const stateAfter = await readOwnerState(fixture, who.ownerId);
  score.ok('http', 'patch-200-revision-2-etag-changed', probe.status === 200 && !!dto && itemHeaders(probe) && dto.title === 'Updated title' && dto.hidden === true && dto.revision === 2 && ['id', 'url', 'reminderTime', 'autoOpen', 'webPush', 'createdAt', 'thumbnail'].every(field => dto[field] === created.dto[field]) && String(dto.updatedAt) >= String(created.dto.updatedAt) && probe.headers.get('etag') !== created.etag);
  score.ok('dynamodb', 'row-revision-2-counter-unchanged', !!row && !!dto && row.revision === 2 && row.title === 'Updated title' && row.hidden === true && row.deleted === false && row.updatedAt === dto.updatedAt && stateAfter.itemCount === stateBefore.itemCount && stateAfter.imageBytes === stateBefore.imageBytes);
  score.ok('s3', 'no-image-versions-added', versions === await s3Versions(fixture));
  defer(recorder, 'API-04/patch', 'patch-result-delivered', logOf(probe, 200, { operation: 'patch' }));
  if (!dto) throw new Error('CRUD_STATE_MISSING'); stateOf(fixture).data.set('crud', { etag: probe.headers.get('etag')!, text: probe.text, dto } satisfies Crud);
});
register('API-04/delete', ['API-04/patch'], async (fixture, recorder, score) => {
  const who = await actor(fixture, 'a'); const current = crud(fixture);
  const stateBefore = await readOwnerState(fixture, who.ownerId); const versions = await s3Versions(fixture);
  const removed = await send(fixture, `/v2/reminders/${CRUD_ID}`, { token: who.token, method: 'DELETE', headers: { 'if-match': current.etag } });
  recorder.recordInput({ httpStatus: removed.status });
  const gone = await send(fixture, `/v2/reminders/${CRUD_ID}`, { token: who.token }); const listed = await send(fixture, '/v2/reminders', { token: who.token });
  const row = await readReminder(fixture, who.ownerId, CRUD_ID) as unknown as Record<string, unknown> | null; const stateAfter = await readOwnerState(fixture, who.ownerId);
  score.ok('http', 'delete-200-body-no-etag', removed.status === 200 && removed.text === `{"id":"${CRUD_ID}","deleted":true,"revision":3}` && commonHeaders(removed) && removed.headers.get('etag') === null);
  score.ok('http', 'get-after-delete-404', errorIs(gone, 404, 'REMINDER_NOT_FOUND'));
  const page = listOf(listed); score.ok('http', 'list-excludes-tombstone', !!page && !ids(page.items).includes(CRUD_ID));
  score.ok('dynamodb', 'tombstone-revision-3-counter-decremented', !!row && row.deleted === true && row.revision === 3 && row.id === CRUD_ID && row.ownerId === who.ownerId && ISO.test(String(row.deletedAt)) && !('url' in row) && stateAfter.itemCount === stateBefore.itemCount - 1 && stateAfter.imageBytes === stateBefore.imageBytes);
  score.ok('s3', 'no-image-versions-added', versions === await s3Versions(fixture));
  defer(recorder, 'API-04/delete', 'delete-result-delivered', logOf(removed, 200, { operation: 'remove' })); defer(recorder, 'API-04/delete', 'get-404-result-delivered', logOf(gone, 404, { operation: 'get', code: 'REMINDER_NOT_FOUND' }));
});

// API-12/13 pagination on owner B, which owns nothing else until these cases have finished.
const SEED = 'API-12/seed-51';
register(SEED, [], async (fixture, recorder, score) => {
  const who = await actor(fixture, 'b'); const before = await snapshot(fixture, who); const stateBefore = await readOwnerState(fixture, who.ownerId);
  const probes: Probe[] = [];
  for (let n = 1; n <= 51; n++) { probes.push(await createItem(fixture, who, JSON.stringify(makeInput({ id: sequence(n, n)[0], title: `Item ${n}` })))); await apiIo.sleep(60); }
  recorder.recordInput({ httpStatus: probes.at(-1)!.status });
  const first = await readReminder(fixture, who.ownerId, 'p-001'); const last = await readReminder(fixture, who.ownerId, 'p-051'); const stateAfter = await readOwnerState(fixture, who.ownerId);
  score.ok('http', 'fifty-one-created-201', probes.every((probe, index) => probe.status === 201 && dtoOf(probe)?.id === sequence(index + 1, index + 1)[0] && strongEtag(probe)));
  score.ok('dynamodb', 'fifty-one-rows-counter-51', !!first && !!last && stateAfter.itemCount === stateBefore.itemCount + 51 && stateAfter.itemCount === 51 && (await rateTotal(fixture, who.ownerId)) === before.rate + 51);
  score.ok('s3', 'no-image-versions-added', before.s3 === await s3Versions(fixture));
  defer(recorder, SEED, 'first-create-result-delivered', logOf(probes[0]!, 201, { operation: 'create' })); defer(recorder, SEED, 'last-create-result-delivered', logOf(probes.at(-1)!, 201, { operation: 'create' }));
});
async function pageOf(fixture: SuiteFixture, who: Actor, query: string): Promise<{ probe: Probe; page: ReturnType<typeof listOf> }> { const probe = await send(fixture, `/v2/reminders${query}`, { token: who.token }); return { probe, page: listOf(probe) }; }
for (const [label, query, count] of [['default', '', 20], ['limit-1', '?limit=1', 1], ['limit-20', '?limit=20', 20], ['limit-50', '?limit=50', 50]] as const) {
  const id = `API-12/${label}`;
  register(id, [SEED], async (fixture, recorder, score) => {
    const who = await actor(fixture, 'b'); const before = await snapshot(fixture, who);
    const { probe, page } = await pageOf(fixture, who, query); const after = await snapshot(fixture, who); recorder.recordInput({ httpStatus: probe.status });
    score.ok('http', 'page-size-order-and-cursor', !!page && same(ids(page.items), sequence(1, count)) && page.items.every((item, index) => item.title === `Item ${index + 1}` && item.thumbnail === null) && typeof page.nextCursor === 'string');
    score.ok('dynamodb', 'list-leaves-rows-unchanged-rate-plus-one', before.domain === after.domain && after.rate === before.rate + 1); score.ok('s3', 'no-image-versions-added', before.s3 === after.s3);
    defer(recorder, id, 'list-result-delivered', logOf(probe, 200, { operation: 'list' }));
  });
}
for (const limit of [20, 7]) {
  const id = `API-12/walk-limit-${limit}`;
  register(id, [SEED], async (fixture, recorder, score) => {
    const who = await actor(fixture, 'b'); const before = await snapshot(fixture, who);
    const seen: string[] = []; let cursor: string | null = null; let pages = 0; let first: Probe | undefined; let linked = true;
    do {
      const { probe, page } = await pageOf(fixture, who, `?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`); first ??= probe; pages++;
      if (!page) { linked = false; break; } seen.push(...ids(page.items)); cursor = page.nextCursor;
    } while (cursor !== null && pages < 20);
    recorder.recordInput({ httpStatus: first?.status ?? 0 }); const after = await snapshot(fixture, who);
    score.ok('http', 'walk-all-51-ordered-no-duplicates', linked && cursor === null && same(seen, sequence(1, 51)) && pages === Math.floor(51 / limit) + 1);
    score.ok('dynamodb', 'list-leaves-rows-unchanged-rate-plus-one', before.domain === after.domain && after.rate === before.rate + pages); score.ok('s3', 'no-image-versions-added', before.s3 === after.s3);
    if (first) defer(recorder, id, 'list-result-delivered', logOf(first, 200, { operation: 'list' }));
  });
}

const TOMBSTONES = 'API-13/tombstone-seed';
register(TOMBSTONES, [SEED, 'API-12/walk-limit-20'], async (fixture, recorder, score) => {
  const who = await actor(fixture, 'b'); const versions = await s3Versions(fixture); const stateBefore = await readOwnerState(fixture, who.ownerId);
  const removed: Probe[] = [];
  for (const id of sequence(1, 3)) {
    const current = await send(fixture, `/v2/reminders/${id}`, { token: who.token });
    removed.push(await send(fixture, `/v2/reminders/${id}`, { token: who.token, method: 'DELETE', headers: { 'if-match': current.headers.get('etag') ?? '' } }));
  }
  recorder.recordInput({ httpStatus: removed.at(-1)!.status });
  const rows = await Promise.all(sequence(1, 3).map(id => readReminder(fixture, who.ownerId, id) as unknown as Promise<Record<string, unknown> | null>)); const stateAfter = await readOwnerState(fixture, who.ownerId);
  score.ok('http', 'three-deletes-200', removed.every((probe, index) => probe.status === 200 && probe.text === `{"id":"${sequence(index + 1, index + 1)[0]}","deleted":true,"revision":2}`));
  score.ok('dynamodb', 'three-tombstones-counter-48', rows.every(row => !!row && row.deleted === true && row.revision === 2) && stateAfter.itemCount === stateBefore.itemCount - 3 && stateAfter.itemCount === 48);
  score.ok('s3', 'no-image-versions-added', versions === await s3Versions(fixture));
  defer(recorder, TOMBSTONES, 'first-delete-result-delivered', logOf(removed[0]!, 200, { operation: 'remove' }));
});
register('API-13/tombstone-head-limit-3', [TOMBSTONES], async (fixture, recorder, score) => {
  const who = await actor(fixture, 'b'); const before = await snapshot(fixture, who);
  const head = await pageOf(fixture, who, '?limit=3'); recorder.recordInput({ httpStatus: head.probe.status });
  const seen: string[] = []; let cursor = head.page?.nextCursor ?? null; let pages = 0; let linked = !!head.page;
  while (cursor !== null && pages < 30) { const { page } = await pageOf(fixture, who, `?limit=3&cursor=${encodeURIComponent(cursor)}`); pages++; if (!page) { linked = false; break; } seen.push(...ids(page.items)); cursor = page.nextCursor; }
  const after = await snapshot(fixture, who);
  score.ok('http', 'empty-first-page-with-cursor', !!head.page && head.page.items.length === 0 && typeof head.page.nextCursor === 'string');
  score.ok('http', 'walk-rest-ordered-complete', linked && cursor === null && same(seen, sequence(4, 51)));
  score.ok('dynamodb', 'list-leaves-rows-unchanged-rate-plus-one', before.domain === after.domain && after.rate === before.rate + 1 + pages); score.ok('s3', 'no-image-versions-added', before.s3 === after.s3);
  defer(recorder, 'API-13/tombstone-head-limit-3', 'list-result-delivered', logOf(head.probe, 200, { operation: 'list' }));
});
register('API-13/tombstone-head-limit-1', [TOMBSTONES], async (fixture, recorder, score) => {
  const who = await actor(fixture, 'b'); const before = await snapshot(fixture, who);
  const steps: NonNullable<ReturnType<typeof listOf>>[] = []; let first: Probe | undefined; let cursor: string | null = null; let linked = true;
  for (let step = 0; step < 4; step++) { const { probe, page } = await pageOf(fixture, who, `?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`); first ??= probe; if (!page) { linked = false; break; } steps.push(page); cursor = page.nextCursor; }
  recorder.recordInput({ httpStatus: first?.status ?? 0 }); const after = await snapshot(fixture, who);
  score.ok('http', 'three-empty-pages-then-first-live-item', linked && steps.length === 4 && steps.slice(0, 3).every(page => page.items.length === 0 && typeof page.nextCursor === 'string') && same(ids(steps[3]!.items), ['p-004']));
  score.ok('dynamodb', 'list-leaves-rows-unchanged-rate-plus-one', before.domain === after.domain && after.rate === before.rate + steps.length); score.ok('s3', 'no-image-versions-added', before.s3 === after.s3);
  if (first) defer(recorder, 'API-13/tombstone-head-limit-1', 'list-result-delivered', logOf(first, 200, { operation: 'list' }));
});

/** One bad cursor, refused with INVALID_CURSOR; a real cursor of the same owner still works afterwards. */
async function cursorCase(fixture: SuiteFixture, recorder: CaseRecorder, score: Score, caseId: string, plan: { sender: Actor; cursor: string; controlWho: Actor; controlCursor: string }): Promise<void> {
  const before = await snapshot(fixture, plan.sender);
  const probe = await send(fixture, `/v2/reminders?limit=1&cursor=${encodeURIComponent(plan.cursor)}`, { token: plan.sender.token }); recorder.recordInput({ httpStatus: probe.status });
  const after = await snapshot(fixture, plan.sender);
  const control = await send(fixture, `/v2/reminders?limit=1&cursor=${encodeURIComponent(plan.controlCursor)}`, { token: plan.controlWho.token });
  score.ok('http', 'cursor-422-invalid-cursor', errorIs(probe, 422, 'INVALID_CURSOR'));
  score.ok('http', 'valid-cursor-control-200', !!listOf(control));
  score.ok('dynamodb', 'rejection-storage-unchanged-rate-plus-one', before.domain === after.domain && after.rate === before.rate + 1); score.ok('s3', 'no-image-versions-added', before.s3 === after.s3);
  defer(recorder, caseId, 'rejection-result-delivered', logOf(probe, 422, { operation: 'list', code: 'INVALID_CURSOR' })); defer(recorder, caseId, 'control-result-delivered', logOf(control, 200, { operation: 'list' }));
}
for (const forged of forgedCursors) register(forged.id, [], async (fixture, recorder, score) => {
  const who = await actor(fixture, 'b');
  for (const id of ['cur-1', 'cur-2']) if ((await createItem(fixture, who, JSON.stringify(makeInput({ id })))).status !== 201) throw new Error('CURSOR_SETUP_FAILED');
  const real = await pageOf(fixture, who, '?limit=1'); if (!real.page?.nextCursor) throw new Error('CURSOR_SETUP_FAILED');
  await cursorCase(fixture, recorder, score, forged.id, { sender: who, cursor: forged.forge(real.page.nextCursor), controlWho: who, controlCursor: real.page.nextCursor });
});
register('API-13/other-owner-cursor', [], async (fixture, recorder, score) => {
  const owner = await actor(fixture, 'a'); const other = await actor(fixture, 'b');
  for (const id of ['cur-a-1', 'cur-a-2']) { const probe = await createItem(fixture, owner, JSON.stringify(makeInput({ id }))); if (probe.status !== 201) throw new Error('CURSOR_SETUP_FAILED'); }
  const real = await pageOf(fixture, owner, '?limit=1'); if (!real.page?.nextCursor) throw new Error('CURSOR_SETUP_FAILED');
  await cursorCase(fixture, recorder, score, 'API-13/other-owner-cursor', { sender: other, cursor: real.page.nextCursor, controlWho: owner, controlCursor: real.page.nextCursor });
});

// API-05 ownership. A holds an item B cannot see; both own an item with the same id.
const OWN = 'API-05/seed';
type Own = { aOnly: string; aSame: string; bSame: string };
const own = (fixture: SuiteFixture): Own => { const value = stateOf(fixture).data.get('own') as Own | undefined; if (!value) throw new Error('OWN_STATE_MISSING'); return value; };
register(OWN, [], async (fixture, recorder, score) => {
  const a = await actor(fixture, 'a'); const b = await actor(fixture, 'b');
  const versions = await s3Versions(fixture);
  const aOnly = await createItem(fixture, a, JSON.stringify(makeInput({ id: 'own-a-only', title: 'A only' }))); const aSame = await createItem(fixture, a, JSON.stringify(makeInput({ id: 'own-same', title: 'A same' }))); const bSame = await createItem(fixture, b, JSON.stringify(makeInput({ id: 'own-same', title: 'B same' })));
  recorder.recordInput({ httpStatus: bSame.status });
  const rows = [await readReminder(fixture, a.ownerId, 'own-same'), await readReminder(fixture, b.ownerId, 'own-same')] as unknown as (Record<string, unknown> | null)[];
  score.ok('http', 'both-owners-create-201', [aOnly, aSame, bSame].every(probe => probe.status === 201 && strongEtag(probe) && !!dtoOf(probe)));
  score.ok('dynamodb', 'rows-independent-per-owner', a.ownerId !== b.ownerId && rows[0]?.title === 'A same' && rows[1]?.title === 'B same' && rows[0]?.ownerId === a.ownerId && rows[1]?.ownerId === b.ownerId); score.ok('s3', 'no-image-versions-added', versions === await s3Versions(fixture));
  defer(recorder, OWN, 'a-create-result-delivered', logOf(aSame, 201, { operation: 'create' })); defer(recorder, OWN, 'b-create-result-delivered', logOf(bSame, 201, { operation: 'create' }));
  stateOf(fixture).data.set('own', { aOnly: aOnly.headers.get('etag')!, aSame: aSame.headers.get('etag')!, bSame: bSame.headers.get('etag')! } satisfies Own);
});
const missing = (probe: Probe, other: Probe): boolean => errorIs(probe, 404, 'REMINDER_NOT_FOUND') && other.status === probe.status && isRecord(other.json) && isRecord(probe.json) && other.json.code === probe.json.code && other.json.message === probe.json.message;
async function aRows(fixture: SuiteFixture, a: Actor): Promise<unknown> { return [await readReminder(fixture, a.ownerId, 'own-a-only'), await readReminder(fixture, a.ownerId, 'own-same')]; }
for (const attempt of [
  { name: 'get', http: 'b-get-404-same-as-missing', method: 'GET', path: (id: string) => `/v2/reminders/${id}`, operation: 'get' },
  { name: 'patch', http: 'b-patch-404-same-as-missing', method: 'PATCH', path: (id: string) => `/v2/reminders/${id}`, headers: (etags: Own) => ({ ...jsonHeaders(), 'if-match': etags.aOnly }), body: '{"title":"hijack"}', operation: 'patch' },
  { name: 'delete', http: 'b-delete-404-same-as-missing', method: 'DELETE', path: (id: string) => `/v2/reminders/${id}`, headers: (etags: Own) => ({ 'if-match': etags.aOnly }), operation: 'remove' },
  { name: 'thumbnail', http: 'b-thumbnail-404-owner-not-found', method: 'GET', path: (id: string) => `/v2/reminders/${id}/thumbnail-url`, operation: 'thumbnail' },
]) {
  const id = `API-05/other-owner-${attempt.name}`; const logName = attempt.http.replace(/^(b-[a-z]+-404).*/, '$1-result-delivered');
  register(id, [OWN], async (fixture, recorder, score) => {
    const a = await actor(fixture, 'a'); const b = await actor(fixture, 'b'); const etags = own(fixture);
    const rowsBefore = await aRows(fixture, a); const before = await snapshot(fixture, a);
    const options = (token: string): Options => ({ token, method: attempt.method, ...(attempt.headers ? { headers: attempt.headers(etags) } : {}), ...(attempt.body !== undefined ? { body: attempt.body } : {}) });
    const foreign = await send(fixture, attempt.path('own-a-only'), options(b.token)); recorder.recordInput({ httpStatus: foreign.status });
    const absent = await send(fixture, attempt.path('own-never-created'), options(b.token));
    const after = await snapshot(fixture, a); const rowsAfter = await aRows(fixture, a);
    score.ok('http', attempt.http, missing(foreign, absent));
    if (attempt.name === 'get') { const mine = await send(fixture, '/v2/reminders/own-a-only', { token: a.token }); score.ok('http', 'a-get-200-unchanged', mine.status === 200 && mine.headers.get('etag') === etags.aOnly && !!dtoOf(mine) && isRecord(mine.json) && mine.json.title === 'A only'); }
    score.ok('dynamodb', 'owner-a-rows-unchanged', same(rowsBefore, rowsAfter) && before.domain === after.domain); score.ok('s3', 'no-image-versions-added', before.s3 === after.s3);
    defer(recorder, id, logName, logOf(foreign, 404, { operation: attempt.operation, code: 'REMINDER_NOT_FOUND' }));
  });
}
register('API-05/other-owner-list', [OWN], async (fixture, recorder, score) => {
  const a = await actor(fixture, 'a'); const b = await actor(fixture, 'b'); const rowsBefore = await aRows(fixture, a); const before = await snapshot(fixture, a);
  const seen: Record<string, unknown>[] = []; let cursor: string | null = null; let pages = 0; let first: Probe | undefined;
  do { const { probe, page } = await pageOf(fixture, b, `?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`); first ??= probe; pages++; if (!page) break; seen.push(...page.items); cursor = page.nextCursor; } while (cursor !== null && pages < 10);
  recorder.recordInput({ httpStatus: first?.status ?? 0 }); const after = await snapshot(fixture, a);
  score.ok('http', 'b-list-excludes-a-only-keeps-own', cursor === null && !ids(seen).includes('own-a-only') && seen.some(item => item.id === 'own-same' && item.title === 'B same'));
  score.ok('dynamodb', 'owner-a-rows-unchanged', same(rowsBefore, await aRows(fixture, a)) && before.domain === after.domain); score.ok('s3', 'no-image-versions-added', before.s3 === after.s3);
  if (first) defer(recorder, 'API-05/other-owner-list', 'b-first-list-result-delivered', logOf(first, 200, { operation: 'list' }));
});
register('API-05/same-id-independent', [OWN], async (fixture, recorder, score) => {
  const a = await actor(fixture, 'a'); const b = await actor(fixture, 'b'); const etags = own(fixture); const versions = await s3Versions(fixture);
  const bBefore = await readReminder(fixture, b.ownerId, 'own-same');
  const patched = await send(fixture, '/v2/reminders/own-same', { token: a.token, method: 'PATCH', headers: { ...jsonHeaders(), 'if-match': etags.aSame }, body: '{"title":"A same 2"}' }); recorder.recordInput({ httpStatus: patched.status });
  const bGet = await send(fixture, '/v2/reminders/own-same', { token: b.token });
  const aRow = await readReminder(fixture, a.ownerId, 'own-same') as unknown as Record<string, unknown> | null; const bRow = await readReminder(fixture, b.ownerId, 'own-same');
  score.ok('http', 'a-patch-200', patched.status === 200 && isRecord(patched.json) && patched.json.title === 'A same 2' && patched.json.revision === 2);
  score.ok('http', 'b-same-id-untouched', bGet.status === 200 && bGet.headers.get('etag') === etags.bSame && isRecord(bGet.json) && bGet.json.title === 'B same' && bGet.json.revision === 1);
  score.ok('dynamodb', 'rows-independent-per-owner', aRow?.title === 'A same 2' && aRow.revision === 2 && same(bBefore, bRow)); score.ok('s3', 'no-image-versions-added', versions === await s3Versions(fixture));
  defer(recorder, 'API-05/same-id-independent', 'a-patch-result-delivered', logOf(patched, 200, { operation: 'patch' }));
});

// API-06 CORS is Gateway configuration. Headers are observed over HTTP; a real browser is not exercised (layer A).
const lower = (value: string | null): string[] => (value ?? '').split(',').map(item => item.trim().toLowerCase()).filter(Boolean);
const noCredentials = (probe: { headers: Headers }): boolean => probe.headers.get('access-control-allow-credentials') !== 'true';
const preflight = (origin: string): Options => ({ method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type,if-match' } });
register('API-06/allowed-origin-preflight', [], async (fixture, recorder, score) => {
  const who = await actor(fixture, 'a'); const { probe, unchanged, s3 } = await unchangedAround(fixture, who, () => send(fixture, '/v2/reminders', preflight(ORIGIN))); recorder.recordInput({ httpStatus: probe.status });
  score.ok('http', 'preflight-unauthenticated-2xx-cors-headers', probe.status >= 200 && probe.status < 300 && probe.headers.get('access-control-allow-origin') === ORIGIN && lower(probe.headers.get('access-control-allow-methods')).includes('post') && ['authorization', 'content-type', 'if-match'].every(name => lower(probe.headers.get('access-control-allow-headers')).includes(name)) && noCredentials(probe));
  score.ok('dynamodb', 'no-storage-or-rate-change', unchanged); score.ok('s3', 'no-image-versions-added', s3);
});
register('API-06/disallowed-origin-preflight', [], async (fixture, recorder, score) => {
  const who = await actor(fixture, 'a'); const { probe, unchanged, s3 } = await unchangedAround(fixture, who, () => send(fixture, '/v2/reminders', preflight(OTHER_ORIGIN))); recorder.recordInput({ httpStatus: probe.status });
  score.ok('http', 'no-allow-origin-header', probe.headers.get('access-control-allow-origin') === null && noCredentials(probe));
  score.ok('dynamodb', 'no-storage-or-rate-change', unchanged); score.ok('s3', 'no-image-versions-added', s3);
});
for (const [id, origin, allowed] of [['API-06/allowed-origin-actual', ORIGIN, true], ['API-06/disallowed-origin-actual', OTHER_ORIGIN, false]] as const) register(id, [], async (fixture, recorder, score) => {
  const who = await actor(fixture, 'a'); const before = await snapshot(fixture, who);
  const probe = await send(fixture, '/v2/reminders', { token: who.token, headers: { origin } }); recorder.recordInput({ httpStatus: probe.status }); const after = await snapshot(fixture, who);
  const exposed = lower(probe.headers.get('access-control-expose-headers'));
  score.ok('http', allowed ? 'get-200-allow-origin-expose-headers-no-credentials' : 'get-200-no-allow-origin', !!listOf(probe) && noCredentials(probe) && (allowed ? probe.headers.get('access-control-allow-origin') === ORIGIN && ['allow', 'etag', 'location', 'retry-after', 'x-request-id'].every(name => exposed.includes(name)) : probe.headers.get('access-control-allow-origin') === null));
  score.ok('dynamodb', 'list-leaves-rows-unchanged-rate-plus-one', before.domain === after.domain && after.rate === before.rate + 1); score.ok('s3', 'no-image-versions-added', before.s3 === after.s3);
  defer(recorder, id, 'list-result-delivered', logOf(probe, 200, { operation: 'list' }));
});
for (const [id, origin, allowed] of [['API-06/s3-allowed-origin-preflight', ORIGIN, true], ['API-06/s3-disallowed-origin-preflight', OTHER_ORIGIN, false]] as const) register(id, [], async (fixture, recorder, score) => {
  const who = await actor(fixture, 'a'); const before = await snapshot(fixture, who);
  // Path-style bucket URL on the pinned local endpoint; the object key is a harmless synthetic name.
  const response = await apiIo.raw(fixture, new URL(`/${fixture.config.imagesBucket}/cors-probe`, fixture.target.endpoint), { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'GET' } }); recorder.recordInput({ httpStatus: response.status });
  const after = await snapshot(fixture, who);
  score.ok('http', allowed ? 's3-preflight-allow-origin-get' : 's3-no-allow-origin-header', allowed ? response.status >= 200 && response.status < 300 && response.headers.get('access-control-allow-origin') === ORIGIN && lower(response.headers.get('access-control-allow-methods')).includes('get') && noCredentials(response) : response.headers.get('access-control-allow-origin') === null && noCredentials(response));
  score.ok('dynamodb', 'no-storage-or-rate-change', before.full === after.full); score.ok('s3', 'no-image-versions-added', before.s3 === after.s3);
});

// API-14 gate order and the real per-owner limit.
register('API-14/auth-refusal-rate-unchanged', [], async (fixture, recorder, score) => {
  const who = await actor(fixture, 'a');
  const before = await validControl(fixture, who); await tick();
  const stored = await snapshot(fixture, who); const since = Date.now(); const refused = await send(fixture, '/v2/reminders'); const until = Date.now(); const after = await snapshot(fixture, who); await tick();
  recorder.recordInput({ httpStatus: refused.status }); const control = await validControl(fixture, who);
  score.ok('http', 'unauthenticated-401', refused.status === 401);
  score.ok('dynamodb', 'refusal-rate-and-storage-unchanged', stored.full === after.full && stored.rate === after.rate); score.ok('s3', 'no-image-versions-added', stored.s3 === after.s3);
  defer(recorder, 'API-14/auth-refusal-rate-unchanged', 'refusal-api-result-absent', { service: 'api', requestId: edgeId(refused), since, until, status: 401, mode: 'absent' }, { before, after: control });
});
register('API-14/unpublished-503-rate-plus-one', [], async (fixture, recorder, score) => {
  const who = await actor(fixture, 'a'); const before = await snapshot(fixture, who); let probe: Probe;
  await fixture.setPublication(false);
  try { probe = await send(fixture, '/v2/reminders', { token: who.token }); } finally { await fixture.setPublication(true); }
  recorder.recordInput({ httpStatus: probe.status }); const after = await snapshot(fixture, who);
  score.ok('http', 'unpublished-503', errorIs(probe, 503, 'SERVICE_UNAVAILABLE'));
  score.ok('dynamodb', 'unpublished-rate-plus-one-storage-unchanged', before.domain === after.domain && after.rate === before.rate + 1); score.ok('s3', 'no-image-versions-added', before.s3 === after.s3);
  defer(recorder, 'API-14/unpublished-503-rate-plus-one', 'unpublished-result-delivered', logOf(probe, 503, { operation: 'list', code: 'SERVICE_UNAVAILABLE' }));
});
const WINDOW_MARGIN_MS = 20_000; const LIMIT = 120;
register('API-14/rate-limit-120', [], async (fixture, recorder, score) => {
  const first = await actor(fixture, 'a'); const second = await secondToken(fixture, 'a');
  if (first.ownerId !== second.ownerId) throw new Error('API_CONTROL_FAILED');
  // Synthetic count 119 for the current UTC minute, set only after enough of the window remains for two real requests.
  if (60_000 - (apiIo.now() % 60_000) < WINDOW_MARGIN_MS) await sleepFor(60_000 - (apiIo.now() % 60_000) + 1_000);
  const minute = Math.floor(apiIo.now() / 60_000); const key = keys.rate(first.ownerId, minute); const before = await snapshot(fixture, first);
  let reading: Probe | undefined; let limited: Probe | undefined; let held = false; let afterSnapshot: Snapshot | undefined;
  try {
    await fixture.clients.dynamodb.send(new PutCommand({ TableName: fixture.config.ownerStateTable, Item: { ...key, count: LIMIT - 1, expiresAt: keys.rateExpiresAt(minute) } }));
    reading = await send(fixture, '/v2/reminders', { token: first.token }); limited = await send(fixture, '/v2/reminders', { token: second.token });
    const row = await fixture.clients.dynamodb.send(new GetCommand({ TableName: fixture.config.ownerStateTable, Key: key, ConsistentRead: true })); held = Number(row.Item?.count) === LIMIT;
    afterSnapshot = await snapshot(fixture, first);
  } finally { await fixture.clients.dynamodb.send(new DeleteCommand({ TableName: fixture.config.ownerStateTable, Key: key })); }
  recorder.recordInput({ httpStatus: limited?.status ?? 0 });
  const retry = limited?.headers.get('retry-after') ?? ''; const body = limited?.json;
  score.ok('http', 'request-120-200', !!reading && !!listOf(reading));
  score.ok('http', 'request-121-429-retry-after-matches-body', !!limited && errorIsRate(limited) && /^[1-9][0-9]?$/.test(retry) && Number(retry) >= 1 && Number(retry) <= 60 && isRecord(body) && body.retryAfterSeconds === Number(retry));
  score.ok('dynamodb', 'counter-held-at-120-storage-unchanged', held && !!afterSnapshot && before.domain === afterSnapshot.domain); score.ok('s3', 'no-image-versions-added', !!afterSnapshot && before.s3 === afterSnapshot.s3);
  if (reading) defer(recorder, 'API-14/rate-limit-120', 'request-120-result-delivered', logOf(reading, 200, { operation: 'list' }));
  if (limited) defer(recorder, 'API-14/rate-limit-120', 'request-121-result-delivered', logOf(limited, 429, { operation: 'list', code: 'OWNER_RATE_LIMIT_EXCEEDED' }));
});
function errorIsRate(probe: Probe): boolean { return errorIs(probe, 429, 'OWNER_RATE_LIMIT_EXCEEDED'); }
