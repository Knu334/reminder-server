import assert from 'node:assert/strict';
import { generateKeyPairSync, createSign } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { requireOwner } from '../../../src/api/identity.ts';
import { ApiError } from '../../../src/shared/errors.ts';
import type { Config } from '../../../src/config.ts';
import type { GatewayRequest } from '../../../src/api/event.ts';
import { classifyAuthorize, tamperSignature, verifyJwt, verifySignature } from '../../e2e/floci/support/auth.ts';

const AUTH_E = ['AUTH-01/pkce-login', 'AUTH-02/pkce-negatives', 'AUTH-03/jwt-signature', 'AUTH-04/sibling-client', 'AUTH-05/foreign-issuer', 'AUTH-07/scope-and-id-token', 'AUTH-09/refresh-rotation', 'AUTH-10/rotation-grace', 'AUTH-11/revoke-disable', 'AUTH-12/refresh-negatives', 'AUTH-06/token-expiry'];
void test('AUTH cases are fully registered: E actions exist, expiry waits last, I cases are inventoried', async () => {
  const { definitions, caseActions } = await import('../../e2e/floci/support/cases.ts');
  await import('../../e2e/floci/support/auth-cases.ts');
  const auth = definitions.filter(def => def.id.startsWith('AUTH-'));
  assert.deepEqual(auth.filter(def => def.layer === 'E').map(def => def.id), AUTH_E);
  for (const id of AUTH_E) { const def = auth.find(item => item.id === id)!; assert.equal(def.suite, 'auth'); assert.equal(def.required, true); assert.equal(typeof caseActions.get(id), 'function', id); }
  assert.deepEqual(auth.filter(def => def.layer === 'I').map(def => def.id).sort(), ['AUTH-05/issuer-only', 'AUTH-07/token-use-only']);
  for (const def of auth.filter(item => item.layer === 'I')) assert.equal(caseActions.has(def.id), false);
  const { createEvidence, evidenceContext } = await import('../../e2e/floci/support/evidence.ts');
  const directory = await mkdtemp(join(tmpdir(), 'auth-inventory-')); try {
    const evidence = await createEvidence(auth, join(directory, 'run')); assert.ok(evidenceContext(evidence).directory);
  } finally { await rm(directory, { recursive: true, force: true }); }
  // Refusal cases defer an API-absence check per refusal; token-endpoint-only cases state why logs do not apply.
  for (const id of ['AUTH-02/pkce-negatives', 'AUTH-09/refresh-rotation', 'AUTH-10/rotation-grace', 'AUTH-11/revoke-disable', 'AUTH-12/refresh-negatives']) {
    const logs = auth.find(def => def.id === id)!.outputs.find(output => output.kind === 'logs')!; if (id !== 'AUTH-09/refresh-rotation') assert.ok(logs.notApplicableReason, id);
  }
  for (const id of ['AUTH-03/jwt-signature', 'AUTH-04/sibling-client', 'AUTH-05/foreign-issuer', 'AUTH-06/token-expiry', 'AUTH-07/scope-and-id-token']) assert.ok(auth.find(def => def.id === id)!.outputs.find(output => output.kind === 'logs')!.assertions.length > 0, id);
});

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = (key: typeof publicKey, kid: string) => ({ ...key.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' }) as unknown as JsonWebKey;
function sign(claims: Record<string, unknown>, key = privateKey, kid = 'k1'): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const body = `${part({ alg: 'RS256', kid })}.${part(claims)}`;
  return `${body}.${createSign('RSA-SHA256').update(body).sign(key).toString('base64url')}`;
}
const claims = { iss: 'https://issuer.test/pool', sub: 'subject', client_id: 'client', token_use: 'access', iat: 1000, exp: 1300, scope: 'reminder-api/read' };
void test('signature-only tampering changes nothing but the signature and fails real verification', () => {
  const keys = [jwk(publicKey, 'k1')]; const token = sign(claims);
  verifyJwt(token, keys, { client_id: 'client', lifetime: 300 });
  const tampered = tamperSignature(token);
  assert.notEqual(tampered, token); assert.equal(tampered.split('.').slice(0, 2).join('.'), token.split('.').slice(0, 2).join('.'));
  assert.throws(() => verifySignature(tampered, keys), /JWT_REJECTED/);
  const payload = token.split('.'); payload[1] = Buffer.from(JSON.stringify({ ...claims, sub: 'x' })).toString('base64url');
  assert.throws(() => verifySignature(payload.join('.'), keys), /JWT_REJECTED/);
  const foreign = sign(claims, other.privateKey, 'k1'); assert.throws(() => verifySignature(foreign, keys), /JWT_REJECTED/);
  assert.throws(() => verifyJwt(token, keys, { client_id: 'client', lifetime: 301 }), /JWT_REJECTED/);
  assert.throws(() => verifyJwt(sign({ ...claims, token_use: 'id' }), keys, { client_id: 'client' }), /JWT_REJECTED/);
  assert.throws(() => verifyJwt(token, keys, { client_id: 'sibling' }), /JWT_REJECTED/);
});

const config = { issuer: claims.iss, clientId: 'client', sourceIps: [] } as unknown as Config;
const now = Math.floor(Date.now() / 1000);
function request(overrides: Record<string, unknown> = {}, scopes = ['reminder-api/read'], method = 'GET'): GatewayRequest {
  return { method, routeKey: `${method} /v2/reminders`, rawPath: '/v2/reminders', pathParameters: {}, query: {}, headers: {}, body: undefined, isBase64Encoded: false, requestId: 'r', sourceIp: '203.0.113.9',
    jwt: { claims: { ...claims, scope: scopes.join(' '), iat: now - 10, exp: now + 290, ...overrides }, scopes } };
}
function status(action: () => unknown): number | undefined { try { action(); } catch (error) { return error instanceof ApiError ? error.status : -1; } return undefined; }
void test('real requireOwner rejects token_use and issuer each as the only wrong condition', () => {
  assert.equal(status(() => requireOwner(request(), config, 'read')), undefined);
  assert.equal(status(() => requireOwner(request({ token_use: 'id' }), config, 'read')), 401, 'token_use alone');
  assert.equal(status(() => requireOwner(request({ iss: 'https://issuer.test/other-pool' }), config, 'read')), 401, 'issuer alone');
  assert.equal(status(() => requireOwner(request({ client_id: 'sibling' }), config, 'read')), 401, 'client alone');
  // Everything else stays valid for each case above, including signature-derived scope lists and timestamps.
  assert.equal(status(() => requireOwner(request({ token_use: undefined }), config, 'read')), 401);
  assert.equal(status(() => requireOwner(request({}, ['reminder-api/write'], 'POST'), config, 'write')), undefined);
  assert.equal(status(() => requireOwner(request({ token_use: 'id' }, ['reminder-api/write'], 'POST'), config, 'write')), 401);
});

const callback = 'https://extension.example.test/callback';
void test('authorize classification reads an error redirect without following it and never invents a rejection', () => {
  assert.deepEqual(classifyAuthorize({ status: 302, location: `${callback}?error=invalid_request&state=x` }, callback), { kind: 'rejected', error: 'invalid_request' });
  assert.deepEqual(classifyAuthorize({ status: 302, location: `${callback}?code=abc&state=x` }, callback), { kind: 'unexpected' });
  assert.deepEqual(classifyAuthorize({ status: 302, location: `${callback}?error=BAD%20VALUE` }, callback), { kind: 'unexpected' });
  assert.deepEqual(classifyAuthorize({ status: 302, location: '/login?client_id=c' }, callback), { kind: 'login' });
  assert.deepEqual(classifyAuthorize({ status: 200 }, callback), { kind: 'login' });
  assert.deepEqual(classifyAuthorize({ status: 400 }, callback), { kind: 'rejected', status: 400 });
  assert.deepEqual(classifyAuthorize({ status: 500 }, callback), { kind: 'unexpected' });
  assert.deepEqual(classifyAuthorize({ status: 302 }, callback), { kind: 'unexpected' });
});
