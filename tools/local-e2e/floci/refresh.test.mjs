import assert from 'node:assert/strict';
import { createPublicKey, randomBytes, verify } from 'node:crypto';
import { before, after, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

const endpoint = process.env.FLOCI_TEST_ENDPOINT ?? 'http://floci:4566';
assert.ok(['http://floci:4566', 'http://127.0.0.1:4567'].includes(endpoint), 'local Floci endpoints only');
const prefix = `localrefresh-${randomBytes(4).toString('hex')}`;
const callback = 'https://app.example.test/callback';
const password = 'Synthetic1234!';
const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const challenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
let poolId, client, sibling, noRotation, noOpenid, jwks;

async function request(path, options = {}) {
  const response = await fetch(endpoint + path, { ...options, redirect: 'manual', signal: AbortSignal.timeout(20000) });
  return { status: response.status, headers: response.headers, text: await response.text() };
}

async function api(action, body) {
  const result = await request('/', {
    method: 'POST', headers: { 'content-type': 'application/x-amz-json-1.1',
      'x-amz-target': `AWSCognitoIdentityProviderService.${action}` }, body: JSON.stringify(body),
  });
  assert.equal(result.status, 200, `synthetic ${action}: ${result.status}`);
  return JSON.parse(result.text);
}

async function oauth(form) {
  const result = await request('/cognito-idp/oauth2/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form),
  });
  return { ...result, body: JSON.parse(result.text) };
}

async function newClient(name, rotation, scopes = ['openid', 'reminder-api/read', 'reminder-api/write']) {
  return (await api('CreateUserPoolClient', {
    UserPoolId: poolId, ClientName: name, AllowedOAuthFlowsUserPoolClient: true,
    AllowedOAuthFlows: ['code'], AllowedOAuthScopes: scopes, CallbackURLs: [callback],
    SupportedIdentityProviders: ['COGNITO'], ExplicitAuthFlows: ['ALLOW_USER_SRP_AUTH'],
    AccessTokenValidity: 5, IdTokenValidity: 5, RefreshTokenValidity: 30,
    TokenValidityUnits: { AccessToken: 'minutes', IdToken: 'minutes', RefreshToken: 'days' },
    RefreshTokenRotation: { Feature: rotation ? 'ENABLED' : 'DISABLED', RetryGracePeriodSeconds: rotation ? 10 : 0 },
    EnableTokenRevocation: true,
  })).UserPoolClient;
}

async function login(target = client, scopes = 'openid reminder-api/read') {
  const query = new URLSearchParams({ response_type: 'code', client_id: target.ClientId, redirect_uri: callback,
    scope: scopes, state: prefix, code_challenge: challenge, code_challenge_method: 'S256' });
  const authorization = await request(`/cognito-idp/oauth2/authorize?${query}`);
  assert.equal(authorization.status, 302, 'PKCE authorization');
  const location = new URL(authorization.headers.get('location'), endpoint);
  assert.equal(location.origin, endpoint, 'login stays on local emulator');
  const page = await request(location.pathname + location.search);
  assert.equal(page.status, 200, 'login form');
  const fields = Object.fromEntries([...page.text.matchAll(/<input type="hidden" name="([^"]*)" value="([^"]*)">/g)]
    .map((match) => [match[1], match[2].replaceAll('&amp;', '&')]));
  const cookies = page.headers.getSetCookie().map((cookie) => cookie.split(';')[0]).join('; ');
  const submitted = await request('/cognito-idp/login', { method: 'POST', headers: {
    'content-type': 'application/x-www-form-urlencoded', cookie: cookies,
  }, body: new URLSearchParams({ ...fields, username: prefix, password }) });
  assert.equal(submitted.status, 302, 'synthetic user login');
  const redirect = new URL(submitted.headers.get('location'));
  assert.equal(redirect.origin + redirect.pathname, callback);
  assert.equal(redirect.searchParams.get('state'), prefix);
  const result = await oauth({ grant_type: 'authorization_code', client_id: target.ClientId,
    redirect_uri: callback, code: redirect.searchParams.get('code'), code_verifier: verifier });
  assert.equal(result.status, 200, 'PKCE code redemption');
  return result.body;
}

function jwt(token) {
  const parts = token.split('.');
  const header = JSON.parse(Buffer.from(parts[0], 'base64url'));
  assert.equal(header.alg, 'RS256');
  const key = jwks.keys.find((candidate) => candidate.kid === header.kid);
  assert.ok(key, 'token signing key is in local JWKS');
  assert.ok(verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`),
    createPublicKey({ key, format: 'jwk' }), Buffer.from(parts[2], 'base64url')), 'valid JWT signature');
  return JSON.parse(Buffer.from(parts[1], 'base64url'));
}

function refresh(token, target = client) {
  return oauth({ grant_type: 'refresh_token', client_id: target.ClientId, refresh_token: token });
}

before(async () => {
  poolId = (await api('CreateUserPool', { PoolName: prefix })).UserPool.Id;
  await api('CreateResourceServer', { UserPoolId: poolId, Identifier: 'reminder-api', Name: prefix,
    Scopes: [{ ScopeName: 'read', ScopeDescription: 'synthetic read' },
      { ScopeName: 'write', ScopeDescription: 'synthetic write' }] });
  client = await newClient(`${prefix}-rotation`, true);
  sibling = await newClient(`${prefix}-sibling`, true);
  noRotation = await newClient(`${prefix}-stable`, false);
  noOpenid = await newClient(`${prefix}-no-openid`, true, ['reminder-api/read']);
  await api('AdminCreateUser', { UserPoolId: poolId, Username: prefix, MessageAction: 'SUPPRESS',
    UserAttributes: [{ Name: 'email', Value: `${prefix}@example.test` }] });
  await api('AdminSetUserPassword', { UserPoolId: poolId, Username: prefix, Password: password, Permanent: true });
  const keys = await request(`/${poolId}/.well-known/jwks.json`);
  assert.equal(keys.status, 200);
  jwks = JSON.parse(keys.text);
});

after(async () => {
  if (poolId) await api('DeleteUserPool', { UserPoolId: poolId });
});

test('OAuth refresh rotates the token while preserving signed identity, scopes and lifetime', async () => {
  const initial = await login();
  const result = await refresh(initial.refresh_token);
  assert.equal(result.status, 200, `refresh error: ${result.body.error}`);
  assert.equal(result.body.token_type, 'Bearer');
  assert.equal(result.body.expires_in, 300);
  assert.ok(result.body.refresh_token);
  assert.ok(result.body.refresh_token !== initial.refresh_token, 'rotation issues a distinct refresh token');
  assert.equal(result.headers.get('cache-control'), 'no-store');
  assert.equal(result.headers.get('pragma'), 'no-cache');
  const original = jwt(initial.access_token), renewed = jwt(result.body.access_token);
  for (const claim of ['iss', 'sub', 'client_id', 'origin_jti', 'scope']) assert.equal(renewed[claim], original[claim], claim);
  assert.deepEqual(new Set(renewed.scope.split(' ')), new Set(['openid', 'reminder-api/read']));
  assert.equal(renewed.exp - renewed.iat, 300);
  const id = jwt(result.body.id_token);
  assert.equal(id.token_use, 'id');
  assert.equal(id.exp - id.iat, 300);
  assert.equal(id.sub, renewed.sub);
  assert.equal(id.iss, renewed.iss);
  assert.equal(id.aud, client.ClientId);
});

test('OAuth and Cognito API refresh retain a grant containing both read and write', async () => {
  const initial = await login(client, 'openid reminder-api/read reminder-api/write');
  const oauthResult = await refresh(initial.refresh_token);
  assert.equal(oauthResult.status, 200);
  const apiResult = (await api('GetTokensFromRefreshToken', { ClientId: client.ClientId,
    RefreshToken: oauthResult.body.refresh_token })).AuthenticationResult;
  for (const token of [oauthResult.body.access_token, apiResult.AccessToken]) {
    assert.deepEqual(new Set(jwt(token).scope.split(' ')),
      new Set(['openid', 'reminder-api/read', 'reminder-api/write']));
  }
});

test('OAuth refresh rejects replay after the original ten-second grace deadline', async () => {
  const initial = await login();
  const first = await refresh(initial.refresh_token);
  assert.equal(first.status, 200);
  const retry = await refresh(initial.refresh_token);
  assert.equal(retry.status, 200, 'immediate retry is allowed');
  assert.ok(retry.body.refresh_token !== first.body.refresh_token, 'grace retry issues a distinct refresh token');
  await delay(11000);
  const replay = await refresh(initial.refresh_token);
  assert.equal(replay.status, 400);
  assert.equal(replay.body.error, 'invalid_grant');
  assert.equal((await refresh(first.body.refresh_token)).status, 200, 'rotated descendant remains usable');
});

test('Cognito API refresh also rotates and preserves OAuth scopes', async () => {
  const initial = await login();
  const result = (await api('GetTokensFromRefreshToken', { ClientId: client.ClientId,
    RefreshToken: initial.refresh_token })).AuthenticationResult;
  assert.ok(result.RefreshToken);
  assert.ok(result.RefreshToken !== initial.refresh_token, 'API rotation issues a distinct refresh token');
  assert.equal(jwt(result.AccessToken).scope, jwt(initial.access_token).scope);
});

test('OAuth refresh without rotation omits a new refresh token and permits reuse', async () => {
  const initial = await login(noRotation);
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await refresh(initial.refresh_token, noRotation);
    assert.equal(result.status, 200);
    assert.equal(result.body.refresh_token, undefined);
    assert.equal(jwt(result.body.access_token).scope, jwt(initial.access_token).scope);
  }
});

test('OAuth refresh without openid omits the ID token', async () => {
  const initial = await login(noOpenid, 'reminder-api/read');
  assert.equal(initial.id_token, undefined);
  const result = await refresh(initial.refresh_token, noOpenid);
  assert.equal(result.status, 200);
  assert.equal(result.body.id_token, undefined);
  assert.equal(jwt(result.body.access_token).scope, 'reminder-api/read');
});

test('OAuth refresh refuses a different client in the same pool', async () => {
  const initial = await login();
  const result = await refresh(initial.refresh_token, sibling);
  assert.equal(result.status, 400);
  assert.equal(result.body.error, 'invalid_grant');
});

test('OAuth refresh distinguishes missing and malformed tokens', async () => {
  const missing = await oauth({ grant_type: 'refresh_token', client_id: client.ClientId });
  assert.equal(missing.status, 400);
  assert.equal(missing.body.error, 'invalid_request');
  const forged = await refresh('synthetic-invalid-refresh');
  assert.equal(forged.status, 400);
  assert.equal(forged.body.error, 'invalid_grant');
});

test('Revocation refuses both original and rotated descendant refresh tokens', async () => {
  const initial = await login();
  const renewed = await refresh(initial.refresh_token);
  assert.equal(renewed.status, 200);
  await api('RevokeToken', { ClientId: client.ClientId, Token: renewed.body.refresh_token });
  for (const token of [initial.refresh_token, renewed.body.refresh_token]) {
    const result = await refresh(token);
    assert.equal(result.status, 400);
    assert.equal(result.body.error, 'invalid_grant');
  }
});
