/**
 * Synthetic inputs for the API contract suite. Everything here is invented text:
 * example.test URLs, plain titles, fixed dates and booleans. No owner identity is
 * ever an input; the API derives it from the signed token.
 */
export const MAX_JSON_BYTES = 2_097_152;

const FORBIDDEN_FIELDS = ['ownerId'] as const;

/** A valid POST body object. Pass `undefined` for a field to omit it from the JSON. */
export function makeInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  for (const field of FORBIDDEN_FIELDS) if (Object.hasOwn(overrides, field)) throw new Error('INPUT_OWNER_FORBIDDEN');
  return { id: 'reminder-1', url: 'https://example.test/reminder', title: 'Test reminder', reminderTime: '2026-10-03T09:00:00+09:00', autoOpen: false, webPush: true, hidden: false, thumbnail: null, ...overrides };
}

/** Valid JSON whose UTF-8 length is exactly `bytes`; the slack is trailing JSON whitespace. */
export function makeJsonBodyBytes(bytes: number, overrides: Record<string, unknown> = {}): string {
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('INPUT_BODY_REJECTED');
  const base = JSON.stringify(makeInput(overrides)); const used = Buffer.byteLength(base, 'utf8');
  if (bytes < used) throw new Error('INPUT_BODY_TOO_SMALL');
  return base + ' '.repeat(bytes - used);
}

export const codePoints = (value: string): number => Array.from(value).length;
const URL_PREFIX = 'https://example.test/';
/** An http URL of exactly `count` Unicode code points. */
export function urlOfCodePoints(count: number): string { if (count < URL_PREFIX.length) throw new Error('INPUT_URL_TOO_SHORT'); return URL_PREFIX + 'a'.repeat(count - URL_PREFIX.length); }
export const repeatCodePoint = (symbol: string, count: number): string => symbol.repeat(count);

/** A request that must be refused by the API Lambda after authentication and rate. */
export type RejectParam = { id: string; status: number; code: string; method: 'GET' | 'POST' | 'PATCH'; path: string; body?: string; contentType?: string | null; ifMatch?: string };
/** A request that must create a reminder with the given observable result. */
export type AcceptParam = { id: string; body: string; contentType?: string; storedId: string; title?: string; url?: string; reminderTime?: string; bodyBytes?: number };

const post = (id: string, status: number, code: string, body: string | undefined, extra: { contentType?: string | null } = {}): RejectParam => ({ id, status, code, method: 'POST', path: '/v2/reminders', ...(body !== undefined ? { body } : {}), ...extra });
const create = (overrides: Record<string, unknown> = {}): string => JSON.stringify(makeInput({ id: 'rej-1', ...overrides }));
const invalid = (id: string, overrides: Record<string, unknown>): RejectParam => post(id, 422, 'INVALID_INPUT', create(overrides));
const patch = (id: string, body: string): RejectParam => ({ id, status: 422, code: 'INVALID_INPUT', method: 'PATCH', path: '/v2/reminders/rej-patch', body, ifMatch: '"opaque-etag"' });
/** Fixed all-zero sentinel: a body that tries to name an owner must be refused, never honored. */
const SENTINEL_OWNER = '0'.repeat(64);
const date = (id: string, reminderTime: unknown): RejectParam => invalid(id, { reminderTime });

export const rejectParams: RejectParam[] = [
  // API-07 body and media type
  post('API-07/invalid-json', 400, 'INVALID_JSON', '{"id":'),
  post('API-07/empty-body', 400, 'INVALID_JSON', ''),
  post('API-07/no-body', 400, 'INVALID_JSON', undefined),
  post('API-07/plain-text-body', 400, 'INVALID_JSON', 'not json'),
  post('API-07/media-text-plain', 415, 'UNSUPPORTED_MEDIA_TYPE', create(), { contentType: 'text/plain' }),
  post('API-07/media-form', 415, 'UNSUPPORTED_MEDIA_TYPE', create(), { contentType: 'application/x-www-form-urlencoded' }),
  post('API-07/media-missing', 415, 'UNSUPPORTED_MEDIA_TYPE', create(), { contentType: null }),
  post('API-07/media-charset-latin1', 415, 'UNSUPPORTED_MEDIA_TYPE', create(), { contentType: 'application/json; charset=iso-8859-1' }),
  post('API-07/media-json-suffix', 415, 'UNSUPPORTED_MEDIA_TYPE', create(), { contentType: 'application/vnd.api+json' }),
  // API-08 required, unknown/readonly, type coercion
  ...(['id', 'url', 'title', 'reminderTime', 'autoOpen', 'webPush', 'hidden'] as const).map(field => invalid(`API-08/missing-${field}`, { [field]: undefined })),
  invalid('API-08/unknown-field', { extra: 1 }),
  invalid('API-08/readonly-revision', { revision: 1 }),
  invalid('API-08/readonly-createdAt', { createdAt: '2026-10-03T00:00:00.000Z' }),
  invalid('API-08/readonly-updatedAt', { updatedAt: '2026-10-03T00:00:00.000Z' }),
  post('API-08/owner-field', 422, 'INVALID_INPUT', JSON.stringify({ ...makeInput({ id: 'rej-1' }), ownerId: SENTINEL_OWNER })),
  invalid('API-08/boolean-string-autoOpen', { autoOpen: 'true' }),
  invalid('API-08/boolean-number-webPush', { webPush: 1 }),
  invalid('API-08/boolean-string-hidden', { hidden: 'false' }),
  invalid('API-08/type-url-number', { url: 7 }),
  invalid('API-08/type-title-null', { title: null }),
  invalid('API-08/type-id-number', { id: 7 }),
  invalid('API-08/type-thumbnail-number', { thumbnail: 7 }),
  invalid('API-08/url-ftp', { url: 'ftp://example.test/reminder' }),
  invalid('API-08/url-no-scheme', { url: 'example.test/reminder' }),
  post('API-08/body-array', 422, 'INVALID_INPUT', '[]'),
  post('API-08/body-null', 422, 'INVALID_INPUT', 'null'),
  post('API-08/body-number', 422, 'INVALID_INPUT', '123'),
  patch('API-08/patch-empty', '{}'),
  patch('API-08/patch-id-field', '{"id":"other"}'),
  patch('API-08/patch-unknown-field', '{"extra":true}'),
  patch('API-08/patch-readonly-revision', '{"revision":9}'),
  patch('API-08/patch-boolean-string', '{"hidden":"true"}'),
  patch('API-08/patch-title-null', '{"title":null}'),
  // API-09 over-limit identifiers, URL and title
  { id: 'API-09/path-id-129', status: 422, code: 'INVALID_INPUT', method: 'GET', path: `/v2/reminders/${'c'.repeat(129)}` },
  invalid('API-09/id-129', { id: 'a'.repeat(129) }),
  invalid('API-09/id-129-astral', { id: repeatCodePoint('\u{1F600}', 129) }),
  invalid('API-09/id-empty', { id: '' }),
  invalid('API-09/id-control', { id: 'a\u0007b' }),
  invalid('API-09/id-lone-surrogate', { id: 'a\uD800b' }),
  invalid('API-09/url-4097', { url: urlOfCodePoints(4097) }),
  invalid('API-09/title-1025', { title: 'a'.repeat(1025) }),
  invalid('API-09/title-1025-astral', { title: repeatCodePoint('\u{1F600}', 1025) }),
  // API-10 calendar and offset rejection
  date('API-10/no-offset', '2026-10-03T09:00:00'),
  date('API-10/leap-day-invalid', '2025-02-29T12:00:00Z'),
  date('API-10/month-13', '2026-13-01T00:00:00Z'),
  date('API-10/april-31', '2026-04-31T00:00:00Z'),
  date('API-10/hour-24', '2026-10-03T24:00:00Z'),
  date('API-10/offset-hour-24', '2026-10-03T00:00:00+24:00'),
  date('API-10/date-only', '2026-10-03'),
  date('API-10/space-separator', '2026-10-03 09:00:00Z'),
  date('API-10/offset-one-digit', '2026-10-03T09:00:00+9:00'),
  date('API-10/not-a-string', 1760000000),
  // API-11 over the 2 MiB body limit
  post('API-11/body-2097153', 413, 'PAYLOAD_TOO_LARGE', makeJsonBodyBytes(MAX_JSON_BYTES + 1, { id: 'rej-1' })),
  // API-12 invalid page limits: refused after authentication and rate, before any Query
  ...([['0', '0'], ['51', '51'], ['abc', 'abc'], ['negative', '-1'], ['decimal', '1.5'], ['hex', '0x10']] as const).map(([label, value]): RejectParam => ({ id: `API-12/limit-${label}`, status: 422, code: 'INVALID_LIMIT', method: 'GET', path: `/v2/reminders?limit=${value}` })),
  // API-14 authenticated input rejection consumes rate
  post('API-14/input-422-rate-plus-one', 422, 'INVALID_INPUT', '{}'),
];

const accept = (id: string, overrides: Record<string, unknown>, expected: { storedId: string; title?: string; url?: string; reminderTime?: string }, extra: { contentType?: string } = {}): AcceptParam => {
  const input = makeInput(overrides);
  return { id, body: JSON.stringify(input), storedId: expected.storedId, ...(expected.title !== undefined ? { title: expected.title } : {}), ...(expected.url !== undefined ? { url: expected.url } : {}), ...(expected.reminderTime !== undefined ? { reminderTime: expected.reminderTime } : {}), ...extra };
};
const when = (id: string, reminderTime: string, utc: string): AcceptParam => accept(id, { id: `t-${id.split('/')[1]}`, reminderTime }, { storedId: `t-${id.split('/')[1]}`, reminderTime: utc });
const sized = (id: string, bytes: number, overrides: Record<string, unknown>, title?: string): AcceptParam => {
  const storedId = `s-${bytes}${title ? '-utf8' : ''}`;
  return { id, body: makeJsonBodyBytes(bytes, { id: storedId, ...overrides }), storedId, bodyBytes: bytes, ...(title !== undefined ? { title } : {}) };
};
const MULTIBYTE_TITLE = 'あ'.repeat(1000);

export const acceptParams: AcceptParam[] = [
  accept('API-07/media-charset-utf8', { id: 'm-utf8' }, { storedId: 'm-utf8' }, { contentType: 'application/json; charset=utf-8' }),
  accept('API-07/media-charset-mixed-case', { id: 'm-mixed' }, { storedId: 'm-mixed' }, { contentType: 'Application/JSON; Charset=UTF-8' }),
  accept('API-09/id-1', { id: 'x' }, { storedId: 'x' }),
  accept('API-09/id-128', { id: 'b'.repeat(128) }, { storedId: 'b'.repeat(128) }),
  accept('API-09/id-128-astral', { id: repeatCodePoint('\u{1F600}', 128) }, { storedId: repeatCodePoint('\u{1F600}', 128) }),
  accept('API-09/id-unicode', { id: 'リマインダー-提醒' }, { storedId: 'リマインダー-提醒' }),
  accept('API-09/id-percent2f', { id: '%2F' }, { storedId: '%2F' }),
  accept('API-09/id-percent', { id: '100%' }, { storedId: '100%' }),
  accept('API-09/id-slash', { id: 'a/b' }, { storedId: 'a/b' }),
  accept('API-09/id-space', { id: 'a b' }, { storedId: 'a b' }),
  accept('API-09/url-4096', { id: 'u-4096', url: urlOfCodePoints(4096) }, { storedId: 'u-4096', url: urlOfCodePoints(4096) }),
  accept('API-09/title-0', { id: 'tt-0', title: '' }, { storedId: 'tt-0', title: '' }),
  accept('API-09/title-1024', { id: 'tt-1024', title: 'a'.repeat(1024) }, { storedId: 'tt-1024', title: 'a'.repeat(1024) }),
  accept('API-09/title-1024-astral', { id: 'tt-astral', title: repeatCodePoint('\u{1F600}', 1024) }, { storedId: 'tt-astral', title: repeatCodePoint('\u{1F600}', 1024) }),
  when('API-10/offset-plus9', '2026-10-03T09:00:00+09:00', '2026-10-03T00:00:00.000Z'),
  when('API-10/z-form', '2026-10-03T00:00:00Z', '2026-10-03T00:00:00.000Z'),
  when('API-10/offset-minus-0530', '2026-10-03T00:00:00-05:30', '2026-10-03T05:30:00.000Z'),
  when('API-10/leap-day', '2024-02-29T12:00:00Z', '2024-02-29T12:00:00.000Z'),
  when('API-10/past', '1999-12-31T23:59:59Z', '1999-12-31T23:59:59.000Z'),
  when('API-10/fraction', '2026-10-03T00:00:00.123Z', '2026-10-03T00:00:00.123Z'),
  when('API-10/year-boundary-offset', '2026-01-01T00:30:00+09:00', '2025-12-31T15:30:00.000Z'),
  sized('API-11/body-2097151', MAX_JSON_BYTES - 1, {}),
  sized('API-11/body-2097152', MAX_JSON_BYTES, {}),
  sized('API-11/body-2097152-utf8', MAX_JSON_BYTES, { title: MULTIBYTE_TITLE }, MULTIBYTE_TITLE),
];

/** Methods that are not routed, with the exact Allow set the API Lambda must answer. */
export const methodParams: { id: string; method: string; path: string; allow: string[] }[] = [
  { id: 'API-03/healthz-delete', method: 'DELETE', path: '/healthz', allow: ['GET'] },
  { id: 'API-03/readyz-post', method: 'POST', path: '/readyz', allow: ['GET'] },
  { id: 'API-03/legacy-get', method: 'GET', path: '/reminders', allow: ['POST', 'PUT'] },
  { id: 'API-03/list-delete', method: 'DELETE', path: '/v2/reminders', allow: ['GET', 'POST'] },
  { id: 'API-03/item-post', method: 'POST', path: '/v2/reminders/method-probe', allow: ['DELETE', 'GET', 'PATCH'] },
  { id: 'API-03/thumbnail-post', method: 'POST', path: '/v2/reminders/method-probe/thumbnail-url', allow: ['GET'] },
];
/** Paths with no Gateway route: answered by the Gateway edge, never by the API Lambda. */
export const unknownPaths: { id: string; path: string }[] = [
  { id: 'API-03/unknown-root-segment', path: '/unknown' },
  { id: 'API-03/unknown-extra-item-segment', path: '/v2/reminders/probe/extra/segment' },
  { id: 'API-03/unknown-v2-sibling', path: '/v2/other' },
];

export const forgedCursors: { id: string; forge(real: string): string }[] = [
  { id: 'API-13/forged-owner', forge: real => reencode(real, value => ({ ...value, ownerId: 'f'.repeat(64) })) },
  { id: 'API-13/forged-version', forge: real => reencode(real, value => ({ ...value, version: 2 })) },
  { id: 'API-13/forged-extra-field', forge: real => reencode(real, value => ({ ...value, extra: true })) },
  { id: 'API-13/forged-lastid-control', forge: real => reencode(real, value => ({ ...value, lastId: 'a\u0000b' })) },
  { id: 'API-13/not-base64url', forge: () => 'not a cursor!' },
  { id: 'API-13/not-json', forge: () => Buffer.from('plain text', 'utf8').toString('base64url') },
  { id: 'API-13/oversize', forge: () => 'A'.repeat(3000) },
];
function reencode(real: string, change: (value: Record<string, unknown>) => Record<string, unknown>): string {
  const value = JSON.parse(Buffer.from(real, 'base64url').toString('utf8')) as Record<string, unknown>;
  return Buffer.from(JSON.stringify(change(value)), 'utf8').toString('base64url');
}
