import { isDeepStrictEqual } from 'node:util';
import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { GetObjectCommand, HeadObjectCommand, ListObjectVersionsCommand } from '@aws-sdk/client-s3';
import { caseActions, definitions } from './cases.ts';
import { Score } from './auth-cases.ts';
import { actor, commonHeaders, createItem, defer, dtoOf, errorIs, isRecord, itemHeaders, listOf, logOf, send } from './api-cases.ts';
import type { Actor, Probe } from './api-cases.ts';
import { FORMATS, IMAGE_MIME, base64Of, dataUrlOf, imageBytes, imageIo, ownedPrefix, sha256Base64, sha256Of } from './image-fixtures.ts';
import type { ImageFormat } from './image-fixtures.ts';
import { makeInput } from './input-fixtures.ts';
import { readOwnerState, readReminder } from './storage.ts';
import type { CaseRecorder, SuiteFixture } from './types.ts';

/**
 * Original image preservation through the real authenticated API (IMG-01..IMG-07). Every case starts from a fresh synthetic owner,
 * and every S3 observation is scoped to that owner's prefix (`images/<ownerId>/`), never the whole bucket. Images are never decoded
 * or transformed: expected bytes, MIME, length and SHA-256 are computed from the fixture bytes, never from the product serializer.
 * Signed URLs live in memory only and are never recorded.
 */
const DAY = 86_400_000; const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/; const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_JSON_BYTES = 2_097_152;
const itemPath = (id: string): string => `/v2/reminders/${encodeURIComponent(id)}`;
type Row = Record<string, unknown> | null; type Job = Record<string, unknown>;
type Ref = { imageId: string; key: string; versionId: string; mime: string; bytes: number; sha256: string };

const getReq = (fixture: SuiteFixture, who: Actor, id: string): Promise<Probe> => send(fixture, itemPath(id), { token: who.token });
const urlReq = (fixture: SuiteFixture, who: Actor, id: string): Promise<Probe> => send(fixture, `${itemPath(id)}/thumbnail-url`, { token: who.token });
const patchReq = (fixture: SuiteFixture, who: Actor, id: string, ifMatch: string, fields: Record<string, unknown>): Promise<Probe> => send(fixture, itemPath(id), { token: who.token, method: 'PATCH', headers: { 'content-type': 'application/json', 'if-match': ifMatch }, body: JSON.stringify(fields) });
const deleteReq = (fixture: SuiteFixture, who: Actor, id: string, ifMatch: string): Promise<Probe> => send(fixture, itemPath(id), { token: who.token, method: 'DELETE', headers: { 'if-match': ifMatch } });
const etagOf = (probe: Probe): string => probe.headers.get('etag') ?? '';
const track = (recorder: CaseRecorder, caseId: string, assertion: string, probe: Probe, status: number, operation: string, code?: string): void => defer(recorder, caseId, assertion, logOf(probe, status, { operation, ...(code ? { code } : {}) }));

async function fresh(fixture: SuiteFixture): Promise<Actor> {
  const who = await actor(fixture, 'a'); const state = await readOwnerState(fixture, who.ownerId);
  if (state.itemCount !== 0 || state.imageBytes !== 0 || (await jobsOf(fixture, who.ownerId)).length !== 0) throw new Error('IMAGE_OWNER_NOT_FRESH');
  const owned = await versionsOf(fixture, who.ownerId); if (owned.versions.length || owned.markers.length) throw new Error('IMAGE_OWNER_NOT_FRESH');
  return who;
}
/** Image jobs belong to an owner by their ownerId attribute; the table is scanned and filtered, never trusted by key shape. */
async function jobsOf(fixture: SuiteFixture, ownerId: string): Promise<Job[]> {
  const found: Job[] = []; let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await fixture.clients.dynamodb.send(new ScanCommand({ TableName: fixture.config.imageJobsTable, ConsistentRead: true, ...(ExclusiveStartKey ? { ExclusiveStartKey } : {}) }));
    for (const item of page.Items ?? []) if (item.ownerId === ownerId) found.push(item); ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return found.sort((a, b) => String(a.jobId).localeCompare(String(b.jobId)));
}
type Version = { key: string; versionId: string; size: number }; type Marker = { key: string; versionId: string };
/** Versions and delete markers under the owner's own prefix only. */
async function versionsOf(fixture: SuiteFixture, ownerId: string): Promise<{ versions: Version[]; markers: Marker[] }> {
  const prefix = ownedPrefix(ownerId); const versions: Version[] = []; const markers: Marker[] = []; let KeyMarker: string | undefined; let VersionIdMarker: string | undefined;
  do {
    const page = await fixture.clients.s3.send(new ListObjectVersionsCommand({ Bucket: fixture.config.imagesBucket, Prefix: prefix, ...(KeyMarker ? { KeyMarker } : {}), ...(VersionIdMarker ? { VersionIdMarker } : {}) }));
    for (const item of page.Versions ?? []) { if (!item.Key?.startsWith(prefix)) throw new Error('STORAGE_MISMATCH'); versions.push({ key: item.Key, versionId: item.VersionId!, size: item.Size ?? 0 }); }
    for (const item of page.DeleteMarkers ?? []) { if (!item.Key?.startsWith(prefix)) throw new Error('STORAGE_MISMATCH'); markers.push({ key: item.Key, versionId: item.VersionId! }); }
    KeyMarker = page.NextKeyMarker; VersionIdMarker = page.NextVersionIdMarker; if (page.IsTruncated && !KeyMarker) throw new Error('STORAGE_MISMATCH');
  } while (KeyMarker);
  const order = (a: { key: string; versionId: string }, b: { key: string; versionId: string }): number => `${a.key}#${a.versionId}`.localeCompare(`${b.key}#${b.versionId}`);
  return { versions: versions.sort(order), markers: markers.sort(order) };
}
type Object = { versionId: string; length: number; contentType: string; checksum: string; bytes: Buffer };
/** The stored original read back by its exact owned key and version. */
async function inspect(fixture: SuiteFixture, ref: { key: string; versionId: string }): Promise<Object | undefined> {
  try {
    const head = await fixture.clients.s3.send(new HeadObjectCommand({ Bucket: fixture.config.imagesBucket, Key: ref.key, VersionId: ref.versionId, ChecksumMode: 'ENABLED' }));
    const got = await fixture.clients.s3.send(new GetObjectCommand({ Bucket: fixture.config.imagesBucket, Key: ref.key, VersionId: ref.versionId }));
    return { versionId: String(head.VersionId), length: Number(head.ContentLength), contentType: String(head.ContentType), checksum: String(head.ChecksumSHA256), bytes: Buffer.from(await got.Body!.transformToByteArray()) };
  } catch { return undefined; }
}
const exactObject = (found: Object | undefined, ref: Ref, data: Buffer): boolean => !!found && found.versionId === ref.versionId && found.length === data.length && found.contentType === ref.mime && found.checksum === sha256Base64(data) && found.bytes.equals(data) && ref.bytes === data.length && ref.sha256 === sha256Of(data);

type Snap = { row: Row; state: { itemCount: number; imageBytes: number }; jobs: Job[]; versions: Version[]; markers: Marker[] };
async function snap(fixture: SuiteFixture, who: Actor, id: string): Promise<Snap> {
  const owned = await versionsOf(fixture, who.ownerId);
  return { row: await readReminder(fixture, who.ownerId, id) as unknown as Row, state: await readOwnerState(fixture, who.ownerId), jobs: await jobsOf(fixture, who.ownerId), ...owned };
}
const refOf = (row: Row): Ref | undefined => isRecord(row?.thumbnail) ? row!.thumbnail as Ref : undefined;
const jobOf = (jobs: Job[], imageId: string): Job | undefined => jobs.find(job => job.jobId === imageId);
const sortKey = (due: number, jobId: string): string => `${String(due).padStart(13, '0')}#${jobId}`;
const isCommitted = (job: Job | undefined, ref: Ref, ownerId: string): boolean => !!job && job.state === 'committed' && job.ownerId === ownerId && job.key === ref.key && job.versionId === ref.versionId && job.mime === ref.mime && job.bytes === ref.bytes && job.sha256 === ref.sha256 && ['dueAtMs', 'cleanupPartition', 'cleanupSortKey', 'leaseOwner'].every(field => job[field] === undefined);
/** Retired by the transition that happened at `atMs`: due exactly 24 h later, in the retired index, version still pinned. */
const isRetired = (job: Job | undefined, ref: Ref, ownerId: string, atMs: number): boolean => !!job && job.state === 'retired' && job.ownerId === ownerId && job.key === ref.key && job.versionId === ref.versionId && job.dueAtMs === atMs + DAY && /^retired#0[0-3]$/.test(String(job.cleanupPartition)) && job.cleanupSortKey === sortKey(atMs + DAY, ref.imageId);
const isPending = (job: Job | undefined, ownerId: string, data: Buffer, mime: string): boolean => !!job && job.state === 'pending' && job.ownerId === ownerId && typeof job.versionId === 'string' && job.mime === mime && job.bytes === data.length && job.sha256 === sha256Of(data) && job.key === `${ownedPrefix(ownerId)}${String(job.jobId)}` && typeof job.createdAtMs === 'number' && job.dueAtMs === job.createdAtMs + DAY && /^pending#0[0-3]$/.test(String(job.cleanupPartition)) && job.cleanupSortKey === sortKey(job.dueAtMs as number, String(job.jobId));
const noBytesIn = (row: Row, data: Buffer): boolean => { if (!row) return false; const text = JSON.stringify(row); return !text.includes(base64Of(data).slice(0, 40)) && !Object.values(row).some(value => Buffer.isBuffer(value) || value instanceof Uint8Array); };
/** The wire form carries metadata only: no payload, key, version, owner or signed-URL parts. */
const metadataOnly = (probe: Probe, ref: Ref, ownerId: string, data: Buffer): boolean => { const thumbnail = dtoOf(probe)?.thumbnail; return isRecord(thumbnail) && Object.keys(thumbnail).join(',') === 'imageId,mime,bytes,sha256' && thumbnail.imageId === ref.imageId && thumbnail.mime === ref.mime && thumbnail.bytes === data.length && thumbnail.sha256 === sha256Of(data) && UUID.test(String(thumbnail.imageId)) && ![base64Of(data).slice(0, 40), ref.key, ref.versionId, ownerId, 'X-Amz'].some(secret => probe.text.includes(secret)); };

const register = (id: string, body: (fixture: SuiteFixture, recorder: CaseRecorder, score: Score) => Promise<void>): void => {
  if (!definitions.some(def => def.id === id)) throw new Error('IMAGE_CASE_UNDEFINED');
  caseActions.set(id, async (fixture, recorder) => { const score = new Score(); await body(fixture, recorder, score); score.emit(id, recorder); });
};
const body = (id: string, thumbnail: unknown, extra: Record<string, unknown> = {}): string => JSON.stringify(makeInput({ id, title: `image ${id}`, ...extra, thumbnail }));
const bodyOmitting = (id: string): string => { const { thumbnail: _omitted, ...rest } = makeInput({ id, title: `image ${id}` }); return JSON.stringify(rest); };

/** A setup create that must succeed; its result log is still checked. */
async function setup(fixture: SuiteFixture, recorder: CaseRecorder, caseId: string, who: Actor, id: string, thumbnail: string | null, assertion = 'create-result-delivered'): Promise<{ probe: Probe; ref: Ref | undefined; etag: string }> {
  const probe = await createItem(fixture, who, body(id, thumbnail)); if (probe.status !== 201 || !dtoOf(probe) || !itemHeaders(probe)) throw new Error('IMAGE_SETUP_FAILED');
  track(recorder, caseId, assertion, probe, 201, 'create'); const row = await readReminder(fixture, who.ownerId, id) as unknown as Row;
  if (thumbnail !== null && !refOf(row)) throw new Error('IMAGE_SETUP_FAILED');
  return { probe, ref: refOf(row), etag: etagOf(probe) };
}

// IMG-01 / IMG-03 accepted: the original bytes survive create exactly.
async function acceptImage(fixture: SuiteFixture, recorder: CaseRecorder, score: Score, caseId: string, format: ImageFormat, data: Buffer, field: string): Promise<void> {
  const id = 'img-1'; const who = await fresh(fixture); const before = await snap(fixture, who, id);
  const text = body(id, field); if (Buffer.byteLength(text, 'utf8') >= MAX_JSON_BYTES) throw new Error('IMAGE_FIXTURE_REJECTED');
  const probe = await createItem(fixture, who, text); recorder.recordInput({ httpStatus: probe.status }); track(recorder, caseId, 'create-result-delivered', probe, 201, 'create');
  const after = await snap(fixture, who, id); const ref = refOf(after.row); const read = await getReq(fixture, who, id); track(recorder, caseId, 'readback-result-delivered', read, 200, 'get');
  const found = ref ? await inspect(fixture, ref) : undefined; const job = ref ? jobOf(after.jobs, ref.imageId) : undefined;
  score.ok('http', 'created-201-metadata-only-dto', probe.status === 201 && itemHeaders(probe) && !!ref && ref.mime === IMAGE_MIME[format] && metadataOnly(probe, ref, who.ownerId, data) && dtoOf(probe)?.revision === 1);
  score.ok('http', 'readback-identical-bytes-etag', read.status === 200 && read.bytes.equals(probe.bytes) && etagOf(read) === etagOf(probe) && itemHeaders(read));
  score.ok('http', 'no-secret-fields-in-dto', !!ref && !read.text.includes(ref.key) && !read.text.includes(ref.versionId) && !read.text.includes(base64Of(data).slice(0, 40)));
  score.ok('dynamodb', 'stored-ref-metadata-and-no-bytes', !!ref && !!after.row && Object.keys(ref).sort().join(',') === 'bytes,imageId,key,mime,sha256,versionId' && ref.key === `${ownedPrefix(who.ownerId)}${ref.imageId}` && ref.mime === IMAGE_MIME[format] && ref.bytes === data.length && ref.sha256 === sha256Of(data) && noBytesIn(after.row, data) && !!(after.jobs.length && noBytesIn(after.jobs[0]!, data)));
  score.ok('dynamodb', 'counters-and-committed-job-exact', !!ref && before.row === null && after.state.itemCount === 1 && after.state.imageBytes === data.length && after.jobs.length === 1 && isCommitted(job, ref, who.ownerId));
  score.ok('s3', 'original-bytes-mime-length-checksum-version-exact', !!ref && exactObject(found, ref, data));
  score.ok('s3', 'owned-key-single-version-no-marker', !!ref && before.versions.length === 0 && after.versions.length === 1 && after.versions[0]!.key === ref.key && after.versions[0]!.versionId === ref.versionId && after.versions[0]!.size === data.length && after.markers.length === 0);
}
for (const format of FORMATS) for (const kind of ['base64', 'dataurl'] as const) register(`IMG-01/${format}-${kind}`, (fixture, recorder, score) => {
  const data = imageBytes(format, 96, FORMATS.indexOf(format)); return acceptImage(fixture, recorder, score, `IMG-01/${format}-${kind}`, format, data, kind === 'base64' ? base64Of(data) : dataUrlOf(format, data));
});
for (const size of [1_048_575, 1_048_576] as const) register(`IMG-03/bytes-${size}`, (fixture, recorder, score) => {
  const data = imageBytes('png', size); return acceptImage(fixture, recorder, score, `IMG-03/bytes-${size}`, 'png', data, base64Of(data));
});

// IMG-01 no image: null, empty string and an omitted field all mean "no image".
async function acceptNone(fixture: SuiteFixture, recorder: CaseRecorder, score: Score, caseId: string, text: string): Promise<void> {
  const id = 'img-1'; const who = await fresh(fixture); const probe = await createItem(fixture, who, text); recorder.recordInput({ httpStatus: probe.status }); track(recorder, caseId, 'create-result-delivered', probe, 201, 'create');
  const after = await snap(fixture, who, id); const read = await getReq(fixture, who, id); track(recorder, caseId, 'readback-result-delivered', read, 200, 'get');
  score.ok('http', 'created-201-thumbnail-null', probe.status === 201 && itemHeaders(probe) && dtoOf(probe)?.thumbnail === null);
  score.ok('http', 'readback-identical-bytes-etag', read.status === 200 && read.bytes.equals(probe.bytes) && etagOf(read) === etagOf(probe));
  score.ok('dynamodb', 'row-thumbnail-null-counters-no-job', after.row?.thumbnail === null && after.state.itemCount === 1 && after.state.imageBytes === 0 && after.jobs.length === 0);
  score.ok('s3', 'no-owned-image-version', after.versions.length === 0 && after.markers.length === 0);
}
register('IMG-01/null', (fixture, recorder, score) => acceptNone(fixture, recorder, score, 'IMG-01/null', body('img-1', null)));
register('IMG-01/empty', (fixture, recorder, score) => acceptNone(fixture, recorder, score, 'IMG-01/empty', body('img-1', '')));
register('IMG-01/omitted', (fixture, recorder, score) => acceptNone(fixture, recorder, score, 'IMG-01/omitted', bodyOmitting('img-1')));

// IMG-02 / IMG-03 rejected: nothing is created anywhere.
async function rejectImage(fixture: SuiteFixture, recorder: CaseRecorder, score: Score, caseId: string, thumbnail: string, status: number, code: string): Promise<void> {
  const id = 'img-1'; const who = await fresh(fixture); const before = await snap(fixture, who, id); const text = body(id, thumbnail);
  const probe = await createItem(fixture, who, text); recorder.recordInput({ httpStatus: probe.status }); const after = await snap(fixture, who, id);
  const control = await send(fixture, '/v2/reminders', { token: who.token }); const items = listOf(control);
  score.ok('http', 'rejected-as-expected', errorIs(probe, status, code));
  score.ok('http', 'body-within-json-limit', Buffer.byteLength(text, 'utf8') < MAX_JSON_BYTES);
  score.ok('http', 'valid-control-200-empty-list', !!items && items.items.length === 0);
  score.ok('dynamodb', 'no-row-no-job-counters-unchanged', before.row === null && after.row === null && after.jobs.length === 0 && isDeepStrictEqual(before.state, after.state) && after.state.itemCount === 0 && after.state.imageBytes === 0);
  score.ok('s3', 'no-owned-image-version', before.versions.length === 0 && after.versions.length === 0 && after.markers.length === 0);
  if (!probe.requestId || !control.requestId) throw new Error('API_REQUEST_ID_MISSING');
  track(recorder, caseId, 'rejection-result-delivered', probe, status, 'create', code); track(recorder, caseId, 'control-result-delivered', control, 200, 'list');
}
const png = imageBytes('png', 10); const pngB64 = base64Of(png); // 10 bytes: base64 ends in "==" with four unused bits
const lastDigit = pngB64.length - 3; const badPadBits = `${pngB64.slice(0, lastDigit)}${pngB64[lastDigit] === 'B' ? 'C' : 'B'}==`;
const rejected: [string, string][] = [
  ['bad-alphabet', `${pngB64.slice(0, 4)}*${pngB64.slice(5)}`], ['bad-pad-bits', badPadBits], ['bad-padding', pngB64.slice(0, -1)], ['bad-length', `${pngB64}A`],
  ['mime-mismatch', `data:image/jpeg;base64,${pngB64}`], ['unsupported-mime', `data:image/svg+xml;base64,${pngB64}`],
  ['not-an-image', Buffer.from('synthetic plain text, not an image').toString('base64')], ['missing-base64-marker', `data:image/png,${pngB64}`],
];
if (pngB64.length % 4 !== 0 || !pngB64.endsWith('==') || badPadBits === pngB64 || rejected.some(([, value]) => value === pngB64)) throw new Error('IMAGE_FIXTURE_REJECTED');
for (const [label, value] of rejected) register(`IMG-02/${label}`, (fixture, recorder, score) => rejectImage(fixture, recorder, score, `IMG-02/${label}`, value, 422, 'INVALID_THUMBNAIL'));
register('IMG-03/bytes-1048577', (fixture, recorder, score) => rejectImage(fixture, recorder, score, 'IMG-03/bytes-1048577', base64Of(imageBytes('png', 1_048_577)), 413, 'THUMBNAIL_TOO_LARGE'));

// IMG-04 the 900 second URL, fetched exactly as issued, without a Bearer token.
const urlParts = (url: string, ref: Ref): boolean => { try { const parsed = new URL(url); return parsed.pathname.endsWith(`/${ref.key}`) && parsed.searchParams.get('versionId') === ref.versionId && !url.includes('Bearer'); } catch { return false; } };
const urlBody = (probe: Probe, ref: Ref, revision = 1): { url: string } | undefined => { const value = probe.json; return probe.status === 200 && isRecord(value) && Object.keys(value).join(',') === 'url,expiresAt,imageId,revision' && typeof value.url === 'string' && value.imageId === ref.imageId && value.revision === revision && commonHeaders(probe) && probe.headers.get('cache-control') === 'no-store' && probe.headers.get('etag') === null ? { url: value.url } : undefined; };
async function fetched(fixture: SuiteFixture, url: string, ref: Ref, token: string): Promise<{ status: number; bytes: Buffer; type: string } | undefined> {
  if (url.includes(token)) return undefined; // the access token must never be part of the URL; the fetch itself carries no headers
  try { const result = await imageIo.fetch(fixture, url, ref); return { status: result.status, bytes: result.bytes, type: result.headers.get('content-type') ?? '' }; } catch { return undefined; }
}
register('IMG-04/issue-and-fetch', async (fixture, recorder, score) => {
  const caseId = 'IMG-04/issue-and-fetch'; const id = 'img-1'; const who = await fresh(fixture); const data = imageBytes('png', 2048, 3); const created = await setup(fixture, recorder, caseId, who, id, dataUrlOf('png', data)); const ref = created.ref!;
  const itemBefore = await getReq(fixture, who, id); track(recorder, caseId, 'item-get-before-result-delivered', itemBefore, 200, 'get'); const before = await snap(fixture, who, id);
  const issued = await urlReq(fixture, who, id); recorder.recordInput({ httpStatus: issued.status }); track(recorder, caseId, 'url-result-delivered', issued, 200, 'thumbnail'); const issuedUrl = urlBody(issued, ref);
  const expiresAt = isRecord(issued.json) ? String(issued.json.expiresAt) : ''; const expiry = Date.parse(expiresAt);
  const first = issuedUrl ? await fetched(fixture, issuedUrl.url, ref, who.token) : undefined;
  const reissued = await urlReq(fixture, who, id); track(recorder, caseId, 'reissue-result-delivered', reissued, 200, 'thumbnail'); const again = urlBody(reissued, ref);
  const second = again ? await fetched(fixture, again.url, ref, who.token) : undefined;
  const itemAfter = await getReq(fixture, who, id); track(recorder, caseId, 'item-get-after-result-delivered', itemAfter, 200, 'get'); const after = await snap(fixture, who, id); const found = await inspect(fixture, ref);
  score.ok('http', 'issue-200-no-store-no-etag-dto', !!issuedUrl && ISO.test(expiresAt));
  // 900 s is the requested lifetime in the URL and the DTO's end estimate (harness and Lambda share a clock source within seconds).
  score.ok('http', 'expires-900-and-expires-at', !!issuedUrl && imageIo.expirySeconds(issuedUrl.url) === 900 && expiry >= issued.since + 900_000 - 10_000 && expiry <= issued.until + 900_000 + 10_000);
  score.ok('http', 'get-original-bytes-no-bearer', !!first && first.status === 200 && first.bytes.equals(data) && first.type.split(';')[0] === ref.mime);
  score.ok('http', 'item-body-and-etag-unchanged', itemAfter.bytes.equals(itemBefore.bytes) && itemBefore.bytes.equals(created.probe.bytes) && etagOf(itemAfter) === created.etag && etagOf(itemBefore) === created.etag);
  score.ok('http', 'reissue-same-image', !!again && !!second && second.status === 200 && second.bytes.equals(data) && isRecord(reissued.json) && isRecord(issued.json) && reissued.json.imageId === issued.json.imageId && reissued.json.revision === issued.json.revision);
  score.ok('dynamodb', 'row-job-counters-unchanged-by-issue', isDeepStrictEqual(before.row, after.row) && isDeepStrictEqual(before.jobs, after.jobs) && isDeepStrictEqual(before.state, after.state) && after.row?.revision === 1);
  score.ok('s3', 'url-pins-owned-key-and-version', !!issuedUrl && !!again && urlParts(issuedUrl.url, ref) && urlParts(again.url, ref));
  score.ok('s3', 'original-version-unchanged', isDeepStrictEqual(before.versions, after.versions) && after.versions.length === 1 && after.markers.length === 0 && exactObject(found, ref, data));
});

// IMG-05 refused URL requests: no URL, no change.
async function refuseUrl(fixture: SuiteFixture, recorder: CaseRecorder, score: Score, caseId: string, owner: Actor, asker: Actor, id: string, code: string, control: () => Promise<{ probe: Probe; ok: boolean; operation: string }>, before: Snap, ownerSnap: () => Promise<Snap>, askerFresh?: () => Promise<boolean>): Promise<void> {
  const refused = await urlReq(fixture, asker, id); recorder.recordInput({ httpStatus: refused.status }); track(recorder, caseId, 'refusal-result-delivered', refused, 404, 'thumbnail', code);
  const after = await ownerSnap(); const checked = await control(); track(recorder, caseId, 'control-result-delivered', checked.probe, 200, checked.operation);
  score.ok('http', '404-expected-code-no-url-field', errorIs(refused, 404, code) && isRecord(refused.json) && !('url' in refused.json) && !refused.text.includes('X-Amz') && !refused.text.includes('versionId'));
  score.ok('http', 'control-200', checked.ok);
  score.ok('dynamodb', 'storage-jobs-rows-unchanged', isDeepStrictEqual(before.row, after.row) && isDeepStrictEqual(before.jobs, after.jobs) && isDeepStrictEqual(before.state, after.state) && (askerFresh ? await askerFresh() : true));
  score.ok('s3', 'owned-versions-unchanged', isDeepStrictEqual(before.versions, after.versions) && isDeepStrictEqual(before.markers, after.markers) && owner.ownerId.length === 64);
}
register('IMG-05/other-owner', async (fixture, recorder, score) => {
  const caseId = 'IMG-05/other-owner'; const id = 'img-1'; const a = await fresh(fixture); const b = await actor(fixture, 'b'); if (a.ownerId === b.ownerId) throw new Error('IMAGE_OWNER_NOT_DISTINCT');
  const created = await setup(fixture, recorder, caseId, a, id, base64Of(imageBytes('gif', 64, 5))); const before = await snap(fixture, a, id);
  await refuseUrl(fixture, recorder, score, caseId, a, b, id, 'REMINDER_NOT_FOUND', async () => { const probe = await urlReq(fixture, a, id); return { probe, ok: !!urlBody(probe, created.ref!), operation: 'thumbnail' }; }, before, () => snap(fixture, a, id),
    async () => { const other = await snap(fixture, b, id); return other.row === null && other.jobs.length === 0 && other.versions.length === 0 && other.state.itemCount === 0 && other.state.imageBytes === 0; });
});
register('IMG-05/no-image', async (fixture, recorder, score) => {
  const caseId = 'IMG-05/no-image'; const id = 'img-1'; const who = await fresh(fixture); const created = await setup(fixture, recorder, caseId, who, id, null); const before = await snap(fixture, who, id);
  await refuseUrl(fixture, recorder, score, caseId, who, who, id, 'THUMBNAIL_NOT_FOUND', async () => { const probe = await getReq(fixture, who, id); return { probe, ok: probe.status === 200 && probe.bytes.equals(created.probe.bytes), operation: 'get' }; }, before, () => snap(fixture, who, id));
});
register('IMG-05/deleted-item', async (fixture, recorder, score) => {
  const caseId = 'IMG-05/deleted-item'; const id = 'img-1'; const who = await fresh(fixture); const created = await setup(fixture, recorder, caseId, who, id, base64Of(imageBytes('jpeg', 64, 6)));
  const removed = await deleteReq(fixture, who, id, created.etag); if (removed.status !== 200) throw new Error('IMAGE_SETUP_FAILED'); track(recorder, caseId, 'delete-result-delivered', removed, 200, 'remove'); const before = await snap(fixture, who, id);
  await refuseUrl(fixture, recorder, score, caseId, who, who, id, 'REMINDER_NOT_FOUND', async () => { const probe = await send(fixture, '/v2/reminders', { token: who.token }); return { probe, ok: !!listOf(probe) && listOf(probe)!.items.length === 0, operation: 'list' }; }, before, () => snap(fixture, who, id));
});

// IMG-06 replace, keep, clear and delete: job states, due times, counters and retained versions.
const patchedAt = (probe: Probe): number => Date.parse(String(dtoOf(probe)?.updatedAt));
register('IMG-06/replace', async (fixture, recorder, score) => {
  const caseId = 'IMG-06/replace'; const id = 'img-1'; const who = await fresh(fixture); const first = imageBytes('png', 100, 1); const second = imageBytes('jpeg', 200, 2);
  const created = await setup(fixture, recorder, caseId, who, id, base64Of(first)); const ref1 = created.ref!;
  const patched = await patchReq(fixture, who, id, created.etag, { thumbnail: dataUrlOf('jpeg', second) }); recorder.recordInput({ httpStatus: patched.status }); track(recorder, caseId, 'patch-result-delivered', patched, 200, 'patch');
  const after = await snap(fixture, who, id); const ref2 = refOf(after.row); const read = await getReq(fixture, who, id); track(recorder, caseId, 'get-result-delivered', read, 200, 'get');
  const issued = await urlReq(fixture, who, id); track(recorder, caseId, 'url-result-delivered', issued, 200, 'thumbnail'); const issuedUrl = ref2 ? urlBody(issued, ref2, 2) : undefined;
  const served = issuedUrl && ref2 ? await fetched(fixture, issuedUrl.url, ref2, who.token) : undefined; const old = await inspect(fixture, ref1); const current = ref2 ? await inspect(fixture, ref2) : undefined;
  score.ok('http', 'patch-200-new-thumbnail-metadata-revision-2', patched.status === 200 && itemHeaders(patched) && dtoOf(patched)?.revision === 2 && !!ref2 && ref2.imageId !== ref1.imageId && etagOf(patched) !== created.etag && metadataOnly(patched, ref2, who.ownerId, second) && ref2.mime === 'image/jpeg');
  score.ok('http', 'get-current-reference-matches-patch', read.status === 200 && read.bytes.equals(patched.bytes) && etagOf(read) === etagOf(patched));
  score.ok('http', 'url-serves-new-original-bytes', !!issuedUrl && !!ref2 && !!served && served.status === 200 && served.bytes.equals(second) && served.type.split(';')[0] === 'image/jpeg' && !!urlParts(issuedUrl.url, ref2));
  score.ok('dynamodb', 'new-committed-old-retired-due-plus-24h', !!ref2 && after.jobs.length === 2 && isCommitted(jobOf(after.jobs, ref2.imageId), ref2, who.ownerId) && isRetired(jobOf(after.jobs, ref1.imageId), ref1, who.ownerId, patchedAt(patched)));
  score.ok('dynamodb', 'row-reference-and-counter-delta', !!ref2 && after.row?.revision === 2 && after.row?.deleted === false && after.state.itemCount === 1 && after.state.imageBytes === second.length && second.length - first.length === 100);
  score.ok('s3', 'both-versions-retained-original-bytes', !!ref2 && after.versions.length === 2 && after.markers.length === 0 && exactObject(old, ref1, first) && exactObject(current, ref2, second));
});
register('IMG-06/omit-keeps', async (fixture, recorder, score) => {
  const caseId = 'IMG-06/omit-keeps'; const id = 'img-1'; const who = await fresh(fixture); const data = imageBytes('webp', 120, 4); const created = await setup(fixture, recorder, caseId, who, id, base64Of(data)); const ref = created.ref!; const before = await snap(fixture, who, id);
  const patched = await patchReq(fixture, who, id, created.etag, { title: 'kept image, new title' }); recorder.recordInput({ httpStatus: patched.status }); track(recorder, caseId, 'patch-result-delivered', patched, 200, 'patch');
  const after = await snap(fixture, who, id); const found = await inspect(fixture, ref);
  score.ok('http', 'patch-200-thumbnail-unchanged-revision-2', patched.status === 200 && itemHeaders(patched) && dtoOf(patched)?.revision === 2 && dtoOf(patched)?.title === 'kept image, new title' && metadataOnly(patched, ref, who.ownerId, data));
  score.ok('dynamodb', 'image-ref-job-and-counter-unchanged', isDeepStrictEqual(refOf(after.row), ref) && after.row?.revision === 2 && isDeepStrictEqual(before.jobs, after.jobs) && isCommitted(jobOf(after.jobs, ref.imageId), ref, who.ownerId) && isDeepStrictEqual(before.state, after.state) && after.state.imageBytes === data.length);
  score.ok('s3', 'no-new-version-original-bytes-intact', isDeepStrictEqual(before.versions, after.versions) && after.versions.length === 1 && after.markers.length === 0 && exactObject(found, ref, data));
});
for (const [label, value] of [['clear-null', null], ['clear-empty', '']] as const) register(`IMG-06/${label}`, async (fixture, recorder, score) => {
  const caseId = `IMG-06/${label}`; const id = 'img-1'; const who = await fresh(fixture); const data = imageBytes('gif', 90, 7); const created = await setup(fixture, recorder, caseId, who, id, base64Of(data)); const ref = created.ref!;
  const patched = await patchReq(fixture, who, id, created.etag, { thumbnail: value }); recorder.recordInput({ httpStatus: patched.status }); track(recorder, caseId, 'patch-result-delivered', patched, 200, 'patch');
  const after = await snap(fixture, who, id); const issued = await urlReq(fixture, who, id); track(recorder, caseId, 'url-result-delivered', issued, 404, 'thumbnail', 'THUMBNAIL_NOT_FOUND'); const found = await inspect(fixture, ref);
  score.ok('http', 'patch-200-thumbnail-null-revision-2', patched.status === 200 && itemHeaders(patched) && dtoOf(patched)?.revision === 2 && dtoOf(patched)?.thumbnail === null);
  score.ok('http', 'thumbnail-url-404-thumbnail-not-found', errorIs(issued, 404, 'THUMBNAIL_NOT_FOUND') && isRecord(issued.json) && !('url' in issued.json));
  score.ok('dynamodb', 'image-ref-removed-job-retired-due-plus-24h-counter-zero', after.row?.thumbnail === null && after.row?.revision === 2 && after.state.itemCount === 1 && after.state.imageBytes === 0 && after.jobs.length === 1 && isRetired(jobOf(after.jobs, ref.imageId), ref, who.ownerId, patchedAt(patched)));
  score.ok('s3', 'original-version-retained-bytes-intact', after.versions.length === 1 && after.markers.length === 0 && after.versions[0]!.versionId === ref.versionId && exactObject(found, ref, data));
});
register('IMG-06/delete', async (fixture, recorder, score) => {
  const caseId = 'IMG-06/delete'; const id = 'img-1'; const who = await fresh(fixture); const data = imageBytes('png', 80, 8); const created = await setup(fixture, recorder, caseId, who, id, base64Of(data)); const ref = created.ref!;
  const removed = await deleteReq(fixture, who, id, created.etag); recorder.recordInput({ httpStatus: removed.status }); track(recorder, caseId, 'delete-result-delivered', removed, 200, 'remove');
  const after = await snap(fixture, who, id); const issued = await urlReq(fixture, who, id); track(recorder, caseId, 'url-result-delivered', issued, 404, 'thumbnail', 'REMINDER_NOT_FOUND'); const found = await inspect(fixture, ref);
  const deletedAt = Date.parse(String(after.row?.deletedAt));
  score.ok('http', 'delete-200-exact-body', removed.status === 200 && removed.text === JSON.stringify({ id, deleted: true, revision: 2 }));
  score.ok('http', 'thumbnail-url-404-reminder-not-found', errorIs(issued, 404, 'REMINDER_NOT_FOUND') && isRecord(issued.json) && !('url' in issued.json));
  score.ok('dynamodb', 'tombstone-job-retired-due-plus-24h-counters-zero', after.row?.deleted === true && after.row.thumbnail === undefined && ISO.test(String(after.row.deletedAt)) && after.state.itemCount === 0 && after.state.imageBytes === 0 && after.jobs.length === 1 && isRetired(jobOf(after.jobs, ref.imageId), ref, who.ownerId, deletedAt));
  score.ok('s3', 'original-version-retained-bytes-intact', after.versions.length === 1 && after.markers.length === 0 && exactObject(found, ref, data));
});

// IMG-07 duplicate create with a new image: S3 succeeded, the commit was refused, so an orphan pending job and its version remain.
async function duplicateCase(fixture: SuiteFixture, recorder: CaseRecorder, score: Score, caseId: string, afterDelete: boolean): Promise<void> {
  const id = 'img-1'; const who = await fresh(fixture); const original = imageBytes('png', 100, 1); const orphan = imageBytes('gif', 150, 9);
  const created = await setup(fixture, recorder, caseId, who, id, base64Of(original)); const ref = created.ref!;
  if (afterDelete) { const removed = await deleteReq(fixture, who, id, created.etag); if (removed.status !== 200) throw new Error('IMAGE_SETUP_FAILED'); track(recorder, caseId, 'delete-result-delivered', removed, 200, 'remove'); }
  const before = await snap(fixture, who, id); const duplicate = await createItem(fixture, who, body(id, base64Of(orphan))); recorder.recordInput({ httpStatus: duplicate.status });
  track(recorder, caseId, 'duplicate-result-delivered', duplicate, 409, 'create', 'ALREADY_EXISTS'); const after = await snap(fixture, who, id);
  const read = await getReq(fixture, who, id); if (afterDelete) track(recorder, caseId, 'get-404-result-delivered', read, 404, 'get', 'REMINDER_NOT_FOUND'); else track(recorder, caseId, 'get-result-delivered', read, 200, 'get');
  const fresher = after.jobs.filter(job => !before.jobs.some(old => old.jobId === job.jobId)); const added = fresher[0]; const addedVersion = after.versions.filter(item => !before.versions.some(old => old.key === item.key && old.versionId === item.versionId));
  const stored = added && typeof added.versionId === 'string' ? await inspect(fixture, { key: String(added.key), versionId: added.versionId }) : undefined; const original1 = await inspect(fixture, ref);
  score.ok('http', '409-already-exists', errorIs(duplicate, 409, 'ALREADY_EXISTS'));
  score.ok('http', afterDelete ? 'get-still-404' : 'original-get-bytes-and-etag-unchanged', afterDelete ? errorIs(read, 404, 'REMINDER_NOT_FOUND') : read.status === 200 && read.bytes.equals(created.probe.bytes) && etagOf(read) === created.etag);
  const originalJobs = after.jobs.filter(job => before.jobs.some(old => old.jobId === job.jobId));
  score.ok('dynamodb', 'original-row-counters-and-committed-job-unchanged', isDeepStrictEqual(before.row, after.row) && isDeepStrictEqual(before.state, after.state) && isDeepStrictEqual(originalJobs, before.jobs) && (afterDelete ? isRetired(jobOf(after.jobs, ref.imageId), ref, who.ownerId, Date.parse(String(after.row?.deletedAt))) && after.state.imageBytes === 0 && after.state.itemCount === 0 : isCommitted(jobOf(after.jobs, ref.imageId), ref, who.ownerId) && after.state.imageBytes === original.length && after.state.itemCount === 1));
  score.ok('dynamodb', 'one-new-pending-orphan-job-due-plus-24h-unique-key', fresher.length === 1 && after.jobs.length === before.jobs.length + 1 && isPending(added, who.ownerId, orphan, 'image/gif') && added!.jobId !== ref.imageId && added!.key !== ref.key);
  score.ok('s3', 'orphan-version-holds-new-original-bytes-original-retained', addedVersion.length === 1 && after.versions.length === before.versions.length + 1 && after.markers.length === 0 && !!added && addedVersion[0]!.key === added.key && addedVersion[0]!.versionId === added.versionId && !!stored && stored.bytes.equals(orphan) && stored.checksum === sha256Base64(orphan) && stored.contentType === 'image/gif' && exactObject(original1, ref, original));
}
register('IMG-07/duplicate-id-with-image', (fixture, recorder, score) => duplicateCase(fixture, recorder, score, 'IMG-07/duplicate-id-with-image', false));
register('IMG-07/duplicate-after-delete', (fixture, recorder, score) => duplicateCase(fixture, recorder, score, 'IMG-07/duplicate-after-delete', true));
