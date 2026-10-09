import { DeleteCommand, GetCommand, PutCommand, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { ListObjectVersionsCommand } from '@aws-sdk/client-s3';
import type { Context } from 'aws-lambda';
import { createApiHandler, withApiResultLogging } from '../../../src/api';
import { createHarness, harnessConfig } from '../../support/stateful-store';
import { LogObserver } from './support/logs';
import { fixtureStates } from './support/fixture';
import { suiteLogStates } from './support/logs';
import { apiIo } from './support/api-cases';
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
export type SimOptions = { /** Replace the handler's answer to break one behavior (negative tests). */ tamper?: (method: string, path: string, result: HttpResult) => HttpResult };
export function createSim(options: SimOptions = {}) {
  const h = createHarness(); h.setPublication(true);
  let offset = 0; const clock = () => Date.now() + offset;
  apiIo.now = clock; apiIo.sleep = async ms => { offset += ms; };
  const observer = new LogObserver({ api: 'api-group', gateway: 'gateway-group', cleanup: 'cleanup-group' });
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
      s3: { async send(command: unknown): Promise<unknown> { if (command instanceof ListObjectVersionsCommand) return { Versions: h.imageVersions().map(item => ({ Key: item.key, VersionId: item.versionId, Size: item.bytes })), DeleteMarkers: h.imageDeleteMarkers().map(item => ({ Key: item.key, VersionId: item.versionId })) }; throw new Error('SIM_COMMAND_UNSUPPORTED'); } },
    },
  } as unknown as SuiteFixture;
  fixtureStates.set(fixture, { disposed: false } as never);
  suiteLogStates.set(fixture, { observer, pending: [], cleanup: new Map(), completions: [], lastInput: 0 });
  apiIo.raw = async (_fixture, _url, request) => request.headers.origin === ORIGIN ? { status: 200, headers: new Headers({ 'access-control-allow-origin': ORIGIN, 'access-control-allow-methods': 'GET,HEAD' }), bytes: Buffer.alloc(0) } : { status: 403, headers: new Headers(), bytes: Buffer.alloc(0) };
  return { fixture, observer, harness: h, authFor: (authId: string) => authFor(authId) as SuiteFixture['auth'], authIds, advance: (ms: number) => { offset += ms; } };
}
