import { DeleteCommand, GetCommand, PutCommand, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import type { CloudWatchClient } from '@aws-sdk/client-cloudwatch';
import { DeleteObjectCommand, DeleteObjectsCommand, GetObjectCommand, HeadObjectCommand, ListObjectVersionsCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import type { Context } from 'aws-lambda';
import { createApiHandler, withApiResultLogging } from '../../../src/api';
import { createHarness, harnessConfig } from '../../support/stateful-store';
import { LogObserver } from './support/logs';
import { fixtureStates } from './support/fixture';
import { suiteLogStates } from './support/logs';
import { apiIo } from './support/api-cases';
import { imageIo } from './support/image-fixtures';
import { cleanupIo } from './support/cleanup-fixtures';
import type { CleanupCompletion } from './support/logs';
import { createCleanupHandler } from '../../../src/cleanup';
import { runCleanup, type CleanupDeps } from '../../../src/cleanup/service';
import { createBudget } from '../../../src/shared/budget';
import type { AuthSession, HttpResult, SuiteFixture } from './support/types';

/**
 * An in-process stand-in for the Gateway in front of the real API handler and the real stateful store.
 * It is a test double only: routing, JWT presence/scope and CORS mimic the deployed route table so the
 * harness's expectations are checked against the product's actual response logic. It proves nothing about
 * Floci or the real Gateway.
 */
const ORIGIN = 'https://extension.example.test';
const PATTERNS = ['/healthz', '/readyz', '/reminders', '/v2/reminders', '/v2/reminders/{id}', '/v2/reminders/{id}/thumbnail-url'];
const SCOPES: Record<string, string | null> = {
  'GET /healthz': null, 'GET /readyz': null, 'POST /reminders': null, 'PUT /reminders': null,
  'GET /v2/reminders': 'reminder-api/read', 'POST /v2/reminders': 'reminder-api/write', 'GET /v2/reminders/{id}': 'reminder-api/read',
  'PATCH /v2/reminders/{id}': 'reminder-api/write', 'DELETE /v2/reminders/{id}': 'reminder-api/write', 'GET /v2/reminders/{id}/thumbnail-url': 'reminder-api/read',
};
const part = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');

export type Sim = ReturnType<typeof createSim>;
export type SimOptions = { /** Replace the handler's answer to break one behavior (negative tests). */ tamper?: (method: string, path: string, result: HttpResult) => HttpResult; /** Alter the stored original as S3 would return it (negative tests). */ tamperObject?: (bytes: Buffer) => Buffer; /** Alter what the signed image URL serves (negative tests). */ tamperFetch?: (result: HttpResult) => HttpResult; /** How the double's image URLs treat a changed signature or an expired short URL (IMG-09). */ signature?: 'enforced' | 'lenient-tamper' | 'lenient-expiry' | 'control-fails' | 'unexpected-tamper'; /** Break one cleanup behaviour of the double's cleanup Lambda (negative tests). */ cleanup?: 'ignore-gate' | 'accept-injection' | 'function-error' | 'permanent-delete' | 'ignore-due' };
export function createSim(options: SimOptions = {}) {
  const h = createHarness(); h.setPublication(true);
  // The store's synthetic clock starts in 2026-10; move it to now so DTO times (e.g. the 900 s URL end) are comparable with request times.
  h.advanceMs(Date.now() - Date.parse('2026-10-03T00:00:00.000Z'));
  let offset = 0; const clock = () => Date.now() + offset;
  apiIo.now = clock; apiIo.sleep = async ms => { offset += ms; };
  const observer = new LogObserver({ api: 'api-group', gateway: 'gateway-group', cleanup: 'cleanup-group' });
  const mimes = new Map<string, string>(); const budget = () => ({ signal: new AbortController().signal, remainingMs: () => 10_000 });
  // The double records the content type the upload carried, as S3 would store it with the object. The service holds this same object.
  const rawPut = h.images.put.bind(h.images);
  h.images.put = async (job, image, b) => { const ref = await rawPut(job, image, b); mimes.set(`${ref.key}#${ref.versionId}`, image.mime); return ref; };
  const handler = withApiResultLogging(createApiHandler({ config: harnessConfig, service: h.service, owners: h.owners, images: h.images, clock }));
  let counter = 0; let logId = 0; let sequence = 0;
  const authIds: string[] = [];
  const sessionFor = (authId: string, owner: string, scopes: string[]): AuthSession => {
    const now = Math.floor(Date.now() / 1000); const claims = { iss: harnessConfig.issuer, sub: `sim-${authId}-${owner}`, client_id: harnessConfig.clientId, iat: now - 1, exp: now + 300, scope: scopes.join(' '), token_use: 'access', jti: String(++sequence) };
    return { accessToken: `${part({ alg: 'RS256' })}.${part(claims)}.sim`, refreshToken: `refresh-${sequence}`, claims };
  };
  async function gateway(path: string, request: { token?: string; method?: string; headers?: Record<string, string>; body?: string }): Promise<HttpResult> {
    const method = request.method ?? 'GET'; const [rawPath, rawQuery = ''] = path.split('?') as [string, string?];
    const headers = Object.fromEntries(Object.entries(request.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]));
    const segments = rawPath.split('/'); const cors = headers.origin === ORIGIN ? { 'access-control-allow-origin': ORIGIN, 'access-control-expose-headers': 'Allow,ETag,Location,Retry-After,X-Request-Id' } : {};
    const respond = (status: number, text: string, extra: Record<string, string> = {}): HttpResult => ({ status, headers: new Headers({ 'content-type': 'application/json', ...extra }), bytes: Buffer.from(text) });
    // Route selection against the deployed table: exact method route first, then the finite ANY fallback.
    let pattern: string | undefined; let id: string | undefined;
    for (const candidate of PATTERNS) {
      const want = candidate.split('/');
      if (want.length !== segments.length) continue;
      const params: string[] = []; if (want.every((item, index) => item === '{id}' ? segments[index]!.length > 0 && !!params.push(segments[index]!) : item === segments[index])) { pattern = candidate; id = params[0]; break; }
    }
    if (method === 'OPTIONS') {
      if (!pattern) return respond(404, '{"message":"Not Found"}');
      return headers.origin === ORIGIN ? { status: 204, headers: new Headers({ 'access-control-allow-origin': ORIGIN, 'access-control-allow-methods': 'DELETE,GET,OPTIONS,PATCH,POST,PUT', 'access-control-allow-headers': 'authorization,content-type,if-match' }), bytes: Buffer.alloc(0) } : { status: 204, headers: new Headers(), bytes: Buffer.alloc(0) };
    }
    if (!pattern) return respond(404, '{"message":"Not Found"}', { 'apigw-requestid': `edge-${++counter}` });
    const exact = `${method} ${pattern}`; const routeKey = Object.hasOwn(SCOPES, exact) ? exact : `ANY ${pattern}`; const scope = Object.hasOwn(SCOPES, exact) ? SCOPES[exact]! : null;
    let jwt: { claims: Record<string, unknown>; scopes: string[] } | undefined;
    if (scope !== null) {
      let claims: Record<string, unknown> | undefined;
      try { const pieces = (request.token ?? '').split('.'); if (pieces.length === 3 && pieces[2] === 'sim') claims = JSON.parse(Buffer.from(pieces[1]!, 'base64url').toString()) as Record<string, unknown>; } catch { claims = undefined; }
      if (!claims || Number(claims.exp) * 1000 <= Date.now()) return respond(401, '{"message":"Unauthorized"}', { 'apigw-requestid': `edge-${++counter}` });
      const scopes = String(claims.scope).split(' '); if (!scopes.includes(scope)) return respond(403, '{"message":"Forbidden"}', { 'apigw-requestid': `edge-${++counter}` });
      jwt = { claims, scopes };
    }
    const requestId = `sim-req-${++counter}`; const base = { apiId: 'api123', stage: '$default', requestId, routeKey, http: { method, path: rawPath, sourceIp: '192.0.2.1' }, ...(jwt ? { authorizer: { jwt } } : {}) };
    const event = { version: '2.0', routeKey, rawPath, rawQueryString: rawQuery, headers, ...(rawQuery ? { queryStringParameters: Object.fromEntries(new URLSearchParams(rawQuery)) } : {}), requestContext: base, ...(id !== undefined ? { pathParameters: { id: decodeURIComponent(id) } } : {}), body: request.body ?? null, isBase64Encoded: false };
    const original = console.log; const lines: string[] = [];
    console.log = (line: unknown) => { lines.push(String(line)); };
    let result: Awaited<ReturnType<typeof handler>>;
    try { result = await handler(event, { awsRequestId: `lambda-${counter}`, getRemainingTimeInMillis: () => 10_000 } as Context); } finally { console.log = original; }
    observer.ingest(lines.map(message => ({ eventId: String(++logId), message, logStreamName: 'sim', group: 'api-group', timestamp: Date.now() })));
    const out = new Headers(); for (const [name, value] of Object.entries(result.headers ?? {})) out.set(name, String(value));
    for (const [name, value] of Object.entries(cors)) out.set(name, value);
    return respond(result.statusCode ?? 0, result.body ?? '', Object.fromEntries(out.entries()));
  }
  /** One auth per isolation key, like createCaseAuth: its own synthetic users A and B. */
  const auths = new Map<string, unknown>();
  function authFor(authId: string): unknown { let auth = auths.get(authId); if (!auth) { authIds.push(authId); auth = { login: async (owner: string, scopes: string[]) => sessionFor(authId, owner, scopes) }; auths.set(authId, auth); } return auth; }
  const rows = (table: string) => { const snap = h.snapshot(); return table === 'reminders' ? snap.reminders : table === 'jobs' ? snap.jobs as unknown as Record<string, unknown>[] : [...snap.storage, ...snap.rates]; };
  const fixture = {
    config: harnessConfig, target: { endpoint: 'http://floci:4566', region: 'ap-northeast-1', addresses: new Map() }, prefix: 'sim',
    auth: authFor('default'),
    async request(path: string, request: { token?: string; method?: string; headers?: Record<string, string>; body?: string } = {}) {
      const result = await gateway(path, request); return options.tamper ? options.tamper(request.method ?? 'GET', path, result) : result;
    },
    async setPublication(published: boolean) { h.setPublication(published); },
    clients: {
      dynamodb: { async send(command: unknown): Promise<unknown> {
        // The image-jobs table (seed, rewrite, index query, delete, checkpoint) is served by the harness's command-level store.
        if ((command as { input?: { TableName?: string } }).input?.TableName === 'jobs' && !(command instanceof ScanCommand)) return h.client.send(command as never);
        if (command instanceof GetCommand) { const input = command.input; const key = input.Key as Record<string, string>; const found = rows(String(input.TableName)).find(row => Object.entries(key).every(([name, value]) => row[name] === value)); return found ? { Item: structuredClone(found) } : {}; }
        if (command instanceof QueryCommand) { const values = command.input.ExpressionAttributeValues!; return { Items: structuredClone(rows(String(command.input.TableName)).filter(row => row.pk === values[':pk'] && String(row.sk).startsWith(String(values[':rate'])))) }; }
        if (command instanceof ScanCommand) return { Items: structuredClone(rows(String(command.input.TableName))) };
        if (command instanceof PutCommand) { // synthetic count seed: replay real consumption through the store, so the stored row stays product-shaped
          const item = command.input.Item as { pk: string; sk: string; count: number }; const ownerId = item.pk.replace('OWNER#', ''); const minute = Number(item.sk.replace('RATE#', ''));
          const have = Number(h.snapshot().rates.find(row => row.pk === item.pk && row.sk === item.sk)?.count ?? 0); if (have > item.count) throw new Error('SIM_SEED_REJECTED');
          for (let step = have; step < item.count; step++) await h.owners.consumeRate(ownerId, minute, { signal: new AbortController().signal, remainingMs: () => 10_000 }); return {};
        }
        if (command instanceof DeleteCommand) return {};
        throw new Error('SIM_COMMAND_UNSUPPORTED');
      } },
      s3: { async send(command: unknown): Promise<unknown> {
        if (command instanceof ListObjectVersionsCommand) { const prefix = command.input.Prefix ?? ''; return { Versions: h.imageVersions().filter(item => item.key.startsWith(prefix)).map(item => ({ Key: item.key, VersionId: item.versionId, Size: item.bytes })), DeleteMarkers: h.imageDeleteMarkers().filter(item => item.key.startsWith(prefix)).map(item => ({ Key: item.key, VersionId: item.versionId })) }; }
        if (command instanceof HeadObjectCommand || command instanceof GetObjectCommand) {
          const { Key, VersionId } = command.input; const stored = h.imageVersions().find(item => item.key === Key && (VersionId === undefined || item.versionId === VersionId)); if (!stored || (VersionId === undefined && h.imageDeleteMarkers().some(marker => marker.key === Key))) throw Object.assign(new Error('NoSuchVersion'), { name: 'NoSuchVersion', $metadata: { httpStatusCode: 404 } });
          const data = Buffer.from(await h.images.get({ imageId: '', key: stored.key, versionId: stored.versionId, mime: '', bytes: stored.bytes, sha256: '' }, budget()));
          const served = command instanceof GetObjectCommand && options.tamperObject ? options.tamperObject(data) : data;
          const common = { VersionId: stored.versionId, ContentLength: served.length, ContentType: mimes.get(`${stored.key}#${stored.versionId}`), ChecksumSHA256: createHash('sha256').update(data).digest('base64') };
          return command instanceof GetObjectCommand ? { ...common, Body: { transformToByteArray: async () => new Uint8Array(served) } } : common;
        }
        if (command instanceof PutObjectCommand) {
          const { Key, Body, ContentType, ChecksumSHA256 } = command.input; const data = Buffer.from(Body as Buffer); const sha = createHash('sha256').update(data).digest('hex'); if (ChecksumSHA256 !== Buffer.from(sha, 'hex').toString('base64')) throw new Error('SIM_CHECKSUM_REJECTED');
          const ref = await h.images.put({ jobId: String(Key).split('/').at(-1)!, key: String(Key) } as never, { data, mime: String(ContentType), bytes: data.length, sha256: sha }, budget()); return { VersionId: ref.versionId, ChecksumSHA256 };
        }
        if (command instanceof DeleteObjectCommand) { await h.images.markDeleted(String(command.input.Key), budget()); return { DeleteMarker: true, VersionId: h.imageDeleteMarkers().find(marker => marker.key === command.input.Key)?.versionId }; }
        if (command instanceof DeleteObjectsCommand) { for (const object of command.input.Delete?.Objects ?? []) h.purgeImages(String(object.Key)); return {}; }
        throw new Error('SIM_COMMAND_UNSUPPORTED');
      } },
    },
  } as unknown as SuiteFixture;
  imageIo.expirySeconds = url => { try { return Number(new URL(url).searchParams.get('expires')); } catch { return Number.NaN; } };
  imageIo.fetch = async (_fixture, url, ref) => {
    const parsed = new URL(url); if (parsed.hostname !== 'synthetic.test' || parsed.pathname !== `/${ref.key}` || parsed.searchParams.get('versionId') !== ref.versionId) throw new Error('IMAGE_URL_REJECTED');
    const mode = options.signature ?? 'enforced'; const refuse = (status: number): HttpResult => ({ status, headers: new Headers(), bytes: Buffer.alloc(0) });
    const serve = async (): Promise<HttpResult> => { const bytes = Buffer.from(await h.images.get(ref, budget())); const result = { status: 200, headers: new Headers({ 'content-type': mimes.get(`${ref.key}#${ref.versionId}`) ?? 'application/octet-stream' }), bytes }; return options.tamperFetch ? options.tamperFetch(result) : result; };
    if (mode === 'control-fails') return refuse(403);
    if (parsed.searchParams.get('sig') === 'bad') return mode === 'lenient-tamper' ? serve() : refuse(mode === 'unexpected-tamper' ? 500 : 403);
    const expiry = Number(parsed.searchParams.get('exp')); if (Number.isFinite(expiry) && expiry > 0 && apiIo.now() > expiry) return mode === 'lenient-expiry' ? serve() : refuse(403);
    return serve();
  };
  // Signature seams: the double's URLs carry a plain marker instead of SigV4; time is the simulated clock.
  imageIo.tamper = url => `${url}&sig=bad`; imageIo.shortUrl = async (_fixture, ref, seconds) => `https://synthetic.test/${ref.key}?versionId=${ref.versionId}&exp=${apiIo.now() + seconds * 1000}`; imageIo.sleep = ms => apiIo.sleep(ms);
  const intervals: CleanupCompletion[] = [];
  fixtureStates.set(fixture, { disposed: false, cleanupIntervals: intervals } as never);
  suiteLogStates.set(fixture, { observer, pending: [], cleanup: new Map(), completions: intervals, lastInput: 0 });
  // The double's cleanup Lambda: the real handler/service over the stateful store, with optional broken behaviours.
  const noMetrics = { async send() { return {}; } } as unknown as CloudWatchClient; let cleanupRuns = 0;
  async function invokeSimCleanup(payload: Buffer): Promise<{ status: number; functionError?: string; payload?: Buffer }> {
    const mode = options.cleanup; const event: unknown = JSON.parse(payload.toString('utf8')); const run = ++cleanupRuns;
    const deps: CleanupDeps = { jobs: mode === 'ignore-due' ? { ...h.jobs, queryDue: (partition, cutoff, after, b) => h.jobs.queryDue(partition, cutoff + 2 * 86_400_000, after, b) } : h.jobs,
      images: mode === 'permanent-delete' ? { ...h.images, markDeleted: async (key, b) => { await h.images.markDeleted(key, b); h.purgeImages(key); } } : h.images,
      owners: mode === 'ignore-gate' ? { ...h.owners, gate: async () => ({ published: true, runId: null }) } : h.owners, config: harnessConfig, clock, uuid: () => `sim-run-${run}`, metrics: noMetrics };
    const original = console.log; const lines: string[] = []; console.log = (line: unknown) => { lines.push(String(line)); };
    let outcome: { value?: unknown; failed: boolean };
    try { outcome = { value: await (mode === 'accept-injection' && typeof event === 'object' && event !== null && Object.keys(event).length > 0 ? runCleanup(deps, createBudget(() => 660_000, 0)) : createCleanupHandler(deps)(event, { awsRequestId: `lambda-cleanup-${run}`, getRemainingTimeInMillis: () => 660_000 } as Context)), failed: false }; } catch { outcome = { failed: true }; } finally { console.log = original; }
    observer.ingest(lines.map(message => ({ eventId: `c${++logId}`, message, logStreamName: `sim-cleanup-${run}`, group: 'cleanup-group', timestamp: Date.now() })));
    if (outcome.failed) return { status: 200, functionError: 'Unhandled', payload: Buffer.from(JSON.stringify({ errorType: 'Error' })) };
    return { status: 200, ...(mode === 'function-error' ? { functionError: 'Unhandled' } : {}), payload: Buffer.from(JSON.stringify(outcome.value)) };
  }
  cleanupIo.invoke = async (_fixture, payload) => invokeSimCleanup(payload); cleanupIo.stopped = async () => true; cleanupIo.ownedTable = () => true; cleanupIo.gsiDeadlineMs = 30_000; cleanupIo.sleep = async () => undefined;
  apiIo.raw = async (_fixture, _url, request) => request.headers.origin === ORIGIN ? { status: 200, headers: new Headers({ 'access-control-allow-origin': ORIGIN, 'access-control-allow-methods': 'GET,HEAD' }), bytes: Buffer.alloc(0) } : { status: 403, headers: new Headers(), bytes: Buffer.alloc(0) };
  return { fixture, observer, harness: h, authFor: (authId: string) => authFor(authId) as SuiteFixture['auth'], authIds, advance: (ms: number) => { offset += ms; } };
}
