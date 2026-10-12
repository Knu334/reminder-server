import assert from 'node:assert/strict';
import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import * as ddb from '@aws-sdk/client-dynamodb';
import * as s3 from '@aws-sdk/client-s3';
import * as lambda from '@aws-sdk/client-lambda';
import { pinnedRequest, cleanBucketVersions } from './local-transport.mjs';

// No shared profile, ambient credentials, or real AWS transport may be consulted.
process.env.AWS_CONFIG_FILE = '/dev/null';
process.env.AWS_SHARED_CREDENTIALS_FILE = '/dev/null';
process.env.AWS_EC2_METADATA_DISABLED = 'true';
const endpoint = process.env.FLOCI_TEST_ENDPOINT ?? 'http://floci:4566';
const region = 'ap-northeast-1';
const prefix = `localauth-${randomBytes(6).toString('hex')}`;
const callback = 'https://app.example.test/callback';
const credentials = { accessKeyId: 'test', secretAccessKey: 'test' };
const password = `Synthetic-${randomBytes(16).toString('hex')}!Aa1`;
const cleanup = [];
let origins, addressesByHostname, poolId, client, sibling, jwks, issuer, apiId;
const managementAuth = 'AWS4-HMAC-SHA256 Credential=test/20261007/ap-northeast-1/apigateway/aws4_request, SignedHeaders=host, Signature=synthetic';

function localUrl(input) {
  const url = new URL(input, endpoint);
  assert.ok(origins.has(url.origin) && !url.username && !url.password && !url.hash, 'transport must stay on validated Floci origin');
  return url;
}

async function request(input, options = {}) {
  const response = await pinnedRequest(localUrl(input), options, addressesByHostname);
  // Redirects are never followed implicitly, including SDK transports.
  return { status: response.status, headers: response.headers, text: response.bytes.toString() };
}

const requestHandler = {
  async handle(req) {
    const url = new URL(`${req.protocol}//${req.hostname}:${req.port ?? 4566}${req.path}`);
    for (const [key, value] of Object.entries(req.query ?? {})) {
      for (const item of Array.isArray(value) ? value : [value]) url.searchParams.append(key, item ?? '');
    }
    const response = await pinnedRequest(localUrl(url), { method: req.method, headers: req.headers,
      body: req.body }, addressesByHostname);
    assert.ok(response.status < 300 || response.status >= 400, 'SDK redirect refused');
    return { response: { statusCode: response.status, headers: Object.fromEntries(response.headers),
      body: Readable.from([response.bytes]) } };
  },
  destroy() {},
};
const settings = { region, endpoint, credentials, maxAttempts: 1, requestHandler };

async function cognito(action, body) {
  const result = await request('/', { method: 'POST', headers: { 'content-type': 'application/x-amz-json-1.1',
    authorization: managementAuth, 'x-amz-target': `AWSCognitoIdentityProviderService.${action}` }, body: JSON.stringify(body) });
  assert.equal(result.status, 200, `Cognito ${action} status`);
  return JSON.parse(result.text);
}

async function gateway(path, body, method = 'POST') {
  const result = await request(`/v2/apis${path}`, { method, headers: { 'content-type': 'application/json',
    authorization: managementAuth }, ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.ok(result.status >= 200 && result.status < 300, `Gateway management ${method} status ${result.status}`);
  return result.text ? JSON.parse(result.text) : {};
}

async function iam(action, fields) {
  const result = await request('/', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded',
    authorization: managementAuth.replace('/apigateway/', '/iam/') },
  body: new URLSearchParams({ Action: action, Version: '2010-05-08', ...fields }) });
  assert.equal(result.status, 200, `IAM ${action} status`);
  return result.text;
}

async function oauth(fields) {
  const result = await request('/cognito-idp/oauth2/token', { method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields) });
  assert.equal(result.status, 200, 'OAuth token status');
  return JSON.parse(result.text);
}

function claims(token, use, target = client) {
  assert.equal(typeof token, 'string', 'token exists');
  const parts = token.split('.');
  assert.equal(parts.length, 3, 'JWT structure');
  const header = JSON.parse(Buffer.from(parts[0], 'base64url'));
  assert.equal(header.alg, 'RS256');
  const key = jwks.keys.find((key) => key.kid === header.kid);
  assert.ok(key, 'JWKS has signing key');
  assert.ok(verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`),
    createPublicKey({ key, format: 'jwk' }), Buffer.from(parts[2], 'base64url')), 'JWT signature verifies');
  const value = JSON.parse(Buffer.from(parts[1], 'base64url'));
  assert.equal(value.token_use, use);
  assert.ok(value.iss === issuer, 'issuer matches signed discovery identity');
  assert.ok((use === 'access' ? value.client_id : value.aud) === target.ClientId, 'client claim matches');
  assert.equal(value.exp - value.iat, 300, 'production token lifetime');
  assert.ok(value.exp > Date.now() / 1000 && value.iat <= Date.now() / 1000, 'token currently valid');
  return value;
}

async function login(username, target = client, scopes = 'openid reminder-api/read reminder-api/write') {
  const state = randomBytes(24).toString('base64url');
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const query = new URLSearchParams({ response_type: 'code', client_id: target.ClientId, redirect_uri: callback,
    scope: scopes, state, code_challenge: challenge, code_challenge_method: 'S256' });
  const auth = await request(`/cognito-idp/oauth2/authorize?${query}`);
  assert.equal(auth.status, 302, 'Hosted UI authorization redirect');
  const location = localUrl(auth.headers.get('location'));
  assert.equal(location.pathname, '/cognito-idp/login', 'Hosted UI login path');
  const page = await request(location);
  assert.equal(page.status, 200, 'Hosted UI login form');
  const fields = Object.fromEntries([...page.text.matchAll(/<input type="hidden" name="([^"]*)" value="([^"]*)">/g)]
    .map((match) => [match[1], match[2].replaceAll('&amp;', '&')]));
  assert.ok(fields.state === state, 'login form preserves state');
  const cookies = page.headers.getSetCookie().map((cookie) => cookie.split(';')[0]).join('; ');
  assert.ok(cookies.length > 0, 'Hosted UI sets session cookie');
  const submitted = await request('/cognito-idp/login', { method: 'POST', headers: {
    'content-type': 'application/x-www-form-urlencoded', cookie: cookies }, body: new URLSearchParams({ ...fields, username, password }) });
  assert.equal(submitted.status, 302, 'Hosted UI synthetic login redirect');
  const redirect = new URL(submitted.headers.get('location'));
  assert.ok(redirect.origin + redirect.pathname === callback && !redirect.username && !redirect.password, 'callback is exact registered callback');
  assert.ok(redirect.searchParams.get('state') === state && redirect.searchParams.get('code'), 'callback state and authorization code');
  // External callback is inspected only; it is never requested.
  return oauth({ grant_type: 'authorization_code', client_id: target.ClientId, redirect_uri: callback,
    code: redirect.searchParams.get('code'), code_verifier: verifier });
}

async function newClient(name) {
  return (await cognito('CreateUserPoolClient', { UserPoolId: poolId, ClientName: name, GenerateSecret: false,
    AllowedOAuthFlowsUserPoolClient: true, AllowedOAuthFlows: ['code'],
    AllowedOAuthScopes: ['openid', 'reminder-api/read', 'reminder-api/write'], CallbackURLs: [callback],
    SupportedIdentityProviders: ['COGNITO'], ExplicitAuthFlows: ['ALLOW_ADMIN_USER_PASSWORD_AUTH'],
    AccessTokenValidity: 5, IdTokenValidity: 5, RefreshTokenValidity: 30,
    TokenValidityUnits: { AccessToken: 'minutes', IdToken: 'minutes', RefreshToken: 'days' },
    RefreshTokenRotation: { Feature: 'ENABLED', RetryGracePeriodSeconds: 10 }, EnableTokenRevocation: true })).UserPoolClient;
}

async function call(path, token, method = 'GET', body, etag) {
  return request(`/execute-api/${apiId}/$default${path}`, { method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}),
      ...(etag ? { 'if-match': etag } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
}

test('real Hosted UI PKCE access tokens authorize Gateway Docker Lambda CRUD with owner isolation', { timeout: 240000 }, async (t) => {
  const passed = [], cleanupErrors = [];
  let phase = 'preflight', failure;
  const step = async (name, action) => { phase = name; await action(); passed.push(name); t.diagnostic(`PASS ${name}`); };
  try {
    assert.equal(endpoint, 'http://floci:4566', 'only the explicit approved Floci endpoint is allowed');
    assert.equal(process.version, 'v24.21.0', 'approved Node version');
    const addresses = await lookup('floci', { all: true, family: 4 });
    assert.ok(addresses.length > 0 && addresses.every(({ address }) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address)), 'Floci DNS resolves only private IPv4');
    origins = new Set([endpoint, ...addresses.map(({ address }) => `http://${address}:4566`)]);
    addressesByHostname = new Map([['floci', addresses[0].address], ...addresses.map(({ address }) => [address, address])]);
    const zip = await readFile(new URL('../../../artifacts/reminder-server.zip', import.meta.url));
    assert.equal(createHash('sha256').update(zip).digest('hex'), '6d3780c466a142039876a02f4ec99e389da874a8e9b22508ff90d1a194913915', 'approved artifact digest');
    const db = new ddb.DynamoDBClient(settings), images = new s3.S3Client({ ...settings, forcePathStyle: true }), functions = new lambda.LambdaClient(settings);
    cleanup.push(['SDK clients', async () => { db.destroy(); images.destroy(); functions.destroy(); }]);
    phase = 'Cognito provisioning';
    poolId = (await cognito('CreateUserPool', { PoolName: prefix })).UserPool.Id;
    cleanup.push(['Cognito pool', () => cognito('DeleteUserPool', { UserPoolId: poolId })]);
    await cognito('CreateResourceServer', { UserPoolId: poolId, Identifier: 'reminder-api', Name: prefix,
      Scopes: [{ ScopeName: 'read', ScopeDescription: 'synthetic read' }, { ScopeName: 'write', ScopeDescription: 'synthetic write' }] });
    client = await newClient(`${prefix}-public`); sibling = await newClient(`${prefix}-wrong-client`);
    for (const username of [`${prefix}-owner`, `${prefix}-other`]) {
      await cognito('AdminCreateUser', { UserPoolId: poolId, Username: username, MessageAction: 'SUPPRESS',
        UserAttributes: [{ Name: 'email', Value: `${username}@example.test` }] });
      await cognito('AdminSetUserPassword', { UserPoolId: poolId, Username: username, Password: password, Permanent: true });
    }
    phase = 'Hosted UI PKCE tokens';
    const owner = await login(`${prefix}-owner`), other = await login(`${prefix}-other`);
    const readOnly = await login(`${prefix}-owner`, client, 'openid reminder-api/read');
    const wrongClient = await login(`${prefix}-owner`, sibling);
    const keyResponse = await request(`/${poolId}/.well-known/jwks.json`);
    assert.equal(keyResponse.status, 200, 'JWKS status'); jwks = JSON.parse(keyResponse.text);
    issuer = JSON.parse(Buffer.from(owner.access_token.split('.')[1], 'base64url')).iss;
    const issuerUrl = localUrl(issuer);
    assert.equal(issuerUrl.pathname, `/${poolId}`, 'owned Cognito pool issuer path');
    const ownerClaims = claims(owner.access_token, 'access'); claims(owner.id_token, 'id');
    const otherClaims = claims(other.access_token, 'access'); claims(readOnly.access_token, 'access'); claims(wrongClient.access_token, 'access', sibling);
    assert.ok(ownerClaims.sub !== otherClaims.sub, 'users have distinct signed identities');
    passed.push('Hosted UI PKCE and local signature verification');
    const tables = { reminders: `${prefix}-reminders`, owner: `${prefix}-owner-state`, jobs: `${prefix}-image-jobs` };
    phase = 'storage provisioning';
    for (const [name, hash, range, extras] of [[tables.reminders, 'ownerId', 'id', []], [tables.owner, 'pk', 'sk', []], [tables.jobs, 'jobId', null, ['cleanupPartition', 'cleanupSortKey']]]) {
      await db.send(new ddb.CreateTableCommand({ TableName: name, BillingMode: 'PAY_PER_REQUEST',
        AttributeDefinitions: [hash, ...(range ? [range] : []), ...extras].map((AttributeName) => ({ AttributeName, AttributeType: 'S' })),
        KeySchema: [{ AttributeName: hash, KeyType: 'HASH' }, ...(range ? [{ AttributeName: range, KeyType: 'RANGE' }] : [])],
        ...(extras.length ? { GlobalSecondaryIndexes: [{ IndexName: 'cleanup_by_due', Projection: { ProjectionType: 'KEYS_ONLY' },
          KeySchema: [{ AttributeName: extras[0], KeyType: 'HASH' }, { AttributeName: extras[1], KeyType: 'RANGE' }] }] } : {}) }));
      cleanup.push([`table ${name}`, () => db.send(new ddb.DeleteTableCommand({ TableName: name }))]);
      const actual = await db.send(new ddb.DescribeTableCommand({ TableName: name })); assert.equal(actual.Table.TableName, name);
      assert.deepEqual(actual.Table.KeySchema, [{ AttributeName: hash, KeyType: 'HASH' }, ...(range ? [{ AttributeName: range, KeyType: 'RANGE' }] : [])]);
      if (extras.length) {
        const index = actual.Table.GlobalSecondaryIndexes.find((index) => index.IndexName === 'cleanup_by_due');
        assert.equal(index.Projection.ProjectionType, 'KEYS_ONLY');
        assert.deepEqual(index.KeySchema, [{ AttributeName: extras[0], KeyType: 'HASH' }, { AttributeName: extras[1], KeyType: 'RANGE' }]);
      }
    }
    await images.send(new s3.CreateBucketCommand({ Bucket: prefix, CreateBucketConfiguration: { LocationConstraint: region } }));
    cleanup.push(['S3 bucket versions and markers', () => cleanBucketVersions(images, s3, prefix)]);
    await images.send(new s3.PutBucketVersioningCommand({ Bucket: prefix, VersioningConfiguration: { Status: 'Enabled' } }));
    assert.equal((await images.send(new s3.GetBucketVersioningCommand({ Bucket: prefix }))).Status, 'Enabled');
    phase = 'IAM and Gateway provisioning';
    const role = await iam('CreateRole', { RoleName: prefix, AssumeRolePolicyDocument: JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' }] }) });
    cleanup.push(['IAM role', () => iam('DeleteRole', { RoleName: prefix })]);
    const roleArn = role.match(/<Arn>([^<]+)<\/Arn>/)?.[1]; assert.ok(roleArn, 'owned IAM role ARN');
    const account = roleArn.split(':')[4];
    await iam('PutRolePolicy', { RoleName: prefix, PolicyName: prefix, PolicyDocument: JSON.stringify({ Version: '2012-10-17', Statement: [
      { Effect: 'Allow', Action: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:Query', 'dynamodb:TransactWriteItems'], Resource: Object.values(tables).map((name) => `arn:aws:dynamodb:${region}:${account}:table/${name}`) },
      { Effect: 'Allow', Action: ['s3:ListBucket'], Resource: `arn:aws:s3:::${prefix}` },
      { Effect: 'Allow', Action: ['s3:GetObject', 's3:GetObjectVersion', 's3:PutObject', 's3:DeleteObject', 's3:DeleteObjectVersion'], Resource: `arn:aws:s3:::${prefix}/*` },
      { Effect: 'Allow', Action: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'], Resource: `arn:aws:logs:${region}:${account}:log-group:/aws/lambda/${prefix}:*` },
    ] }) });
    cleanup.push(['IAM inline execution policy', () => iam('DeleteRolePolicy', { RoleName: prefix, PolicyName: prefix })]);
    const api = await gateway('', { name: prefix, protocolType: 'HTTP' }); apiId = api.apiId; assert.ok(apiId);
    cleanup.push(['HTTP API', () => gateway(`/${apiId}`, undefined, 'DELETE')]);
    const fn = await functions.send(new lambda.CreateFunctionCommand({ FunctionName: prefix, Runtime: 'nodejs24.x', Architectures: ['x86_64'],
      Role: roleArn, Handler: 'dist/api.handler', Code: { ZipFile: zip }, MemorySize: 512, Timeout: 10,
      Environment: { Variables: { AWS_REGION: region, AWS_ACCESS_KEY_ID: 'test', AWS_SECRET_ACCESS_KEY: 'test',
        AWS_CONFIG_FILE: '/dev/null', AWS_SHARED_CREDENTIALS_FILE: '/dev/null', AWS_EC2_METADATA_DISABLED: 'true',
        REMINDERS_TABLE: tables.reminders, OWNER_STATE_TABLE: tables.owner, IMAGE_JOBS_TABLE: tables.jobs, IMAGES_BUCKET: prefix,
        EXPECTED_API_ID: apiId, EXPECTED_API_STAGE: '$default', COGNITO_ISSUER: issuer, COGNITO_CLIENT_ID: client.ClientId } } }));
    cleanup.push(['owned Lambda log group', async () => {
      const result = await request('/', { method: 'POST', headers: { 'content-type': 'application/x-amz-json-1.1', authorization: managementAuth.replace('/apigateway/', '/logs/'), 'x-amz-target': 'Logs_20140328.DeleteLogGroup' }, body: JSON.stringify({ logGroupName: `/aws/lambda/${prefix}` }) });
      assert.ok(result.status === 200 || (result.status === 400 && result.text.includes('ResourceNotFoundException')), 'owned log cleanup status');
    }]);
    cleanup.push(['Lambda function', () => functions.send(new lambda.DeleteFunctionCommand({ FunctionName: prefix }))]);
    assert.equal(fn.CodeSha256, createHash('sha256').update(zip).digest('base64'), 'registered Lambda code digest');
    await functions.send(new lambda.AddPermissionCommand({ FunctionName: prefix, StatementId: 'LocalGatewayOnly', Action: 'lambda:InvokeFunction', Principal: 'apigateway.amazonaws.com', SourceAccount: account, SourceArn: `arn:aws:execute-api:${region}:${account}:${apiId}/$default/*/*` }));
    const integration = await gateway(`/${apiId}/integrations`, { integrationType: 'AWS_PROXY', integrationMethod: 'POST', integrationUri: fn.FunctionArn, payloadFormatVersion: '2.0', timeoutInMillis: 15000 });
    const authorizer = await gateway(`/${apiId}/authorizers`, { name: `${prefix}-jwt`, authorizerType: 'JWT', identitySource: ['$request.header.Authorization'], jwtConfiguration: { issuer, audience: [client.ClientId] } });
    for (const [routeKey, scope] of [['ANY /healthz', null], ['ANY /readyz', null], ['ANY /reminders', null], ['ANY /v2/reminders', null], ['ANY /v2/reminders/{id}', null], ['ANY /v2/reminders/{id}/thumbnail-url', null], ['GET /healthz', null], ['GET /readyz', null], ['POST /reminders', null], ['PUT /reminders', null], ['GET /v2/reminders', 'read'], ['POST /v2/reminders', 'write'], ['GET /v2/reminders/{id}', 'read'], ['PATCH /v2/reminders/{id}', 'write'], ['DELETE /v2/reminders/{id}', 'write'], ['GET /v2/reminders/{id}/thumbnail-url', 'read']]) {
      await gateway(`/${apiId}/routes`, { routeKey, target: `integrations/${integration.integrationId}`, authorizationType: scope ? 'JWT' : 'NONE', ...(scope ? { authorizerId: authorizer.authorizerId, authorizationScopes: [`reminder-api/${scope}`] } : {}) });
    }
    await gateway(`/${apiId}/stages`, { stageName: '$default', autoDeploy: true });
    await step('health 200', async () => assert.equal((await call('/healthz')).status, 200));
    await step('unpublished ready 503', async () => assert.equal((await call('/readyz')).status, 503));
    await db.send(new ddb.PutItemCommand({ TableName: tables.owner, Item: { pk: { S: 'GLOBAL' }, sk: { S: 'PUBLICATION' }, published: { BOOL: true }, runId: { S: prefix } } }));
    await step('published ready 200', async () => assert.equal((await call('/readyz')).status, 200));
    await step('missing JWT rejected 401', async () => assert.equal((await call('/v2/reminders')).status, 401));
    const parts = owner.access_token.split('.'); const badSignature = Buffer.from(parts[2], 'base64url'); badSignature[0] ^= 1;
    await step('forged JWT rejected 401', async () => assert.equal((await call('/v2/reminders', `${parts[0]}.${parts[1]}.${badSignature.toString('base64url')}`)).status, 401));
    // Establish positive auth before interpreting further negative checks.
    await step('valid signed access token reaches owner list 200', async () => {
      const result = await call('/v2/reminders', owner.access_token); t.diagnostic(`valid access list HTTP ${result.status}`);
      assert.equal(result.status, 200, 'valid signed access token Gateway list status');
      assert.deepEqual(JSON.parse(result.text).items, []);
    });
    await step('ID token without required scope rejected 403', async () => assert.equal((await call('/v2/reminders', owner.id_token)).status, 403));
    const item = { id: `${prefix}-item`, url: 'https://example.test/synthetic', title: 'Synthetic reminder', reminderTime: '2026-10-07T12:00:00+09:00', autoOpen: false, webPush: true, hidden: false, thumbnail: null };
    await step('read-only access cannot write 403', async () => assert.equal((await call('/v2/reminders', readOnly.access_token, 'POST', item)).status, 403));
    await step('wrong-client token rejected 401', async () => assert.equal((await call('/v2/reminders', wrongClient.access_token)).status, 401));
    let etag;
    await step('owner create 201 and actual DynamoDB item', async () => {
      const result = await call('/v2/reminders', owner.access_token, 'POST', item); assert.equal(result.status, 201);
      etag = result.headers.get('etag'); assert.ok(/^"r1-[a-f0-9]+"$/.test(etag));
      assert.equal(result.headers.get('location'), `/v2/reminders/${item.id}`); assert.equal(JSON.parse(result.text).title, item.title);
      const ownerId = createHash('sha256').update(JSON.stringify([issuer, ownerClaims.sub])).digest('hex');
      const persisted = await db.send(new ddb.GetItemCommand({ TableName: tables.reminders, Key: { ownerId: { S: ownerId }, id: { S: item.id } }, ConsistentRead: true }));
      assert.equal(persisted.Item.title.S, item.title); assert.equal(persisted.Item.deleted.BOOL, false);
    });
    const path = `/v2/reminders/${item.id}`;
    await step('owner list and get match item', async () => {
      const list = await call('/v2/reminders', owner.access_token); assert.equal(list.status, 200); assert.equal(JSON.parse(list.text).items[0].id, item.id);
      const result = await call(path, owner.access_token); assert.equal(result.status, 200); assert.equal(result.headers.get('etag'), etag); assert.equal(JSON.parse(result.text).id, item.id);
    });
    await step('missing If-Match rejected 428', async () => {
      assert.equal((await call(path, owner.access_token, 'PATCH', { title: 'Denied' })).status, 428);
      assert.equal((await call(path, owner.access_token, 'DELETE')).status, 428);
    });
    await step('second owner get update delete isolation 404', async () => {
      for (const method of ['GET', 'PATCH', 'DELETE']) assert.equal((await call(path, other.access_token, method, method === 'PATCH' ? { title: 'Denied' } : undefined, etag)).status, 404);
      const list = await call('/v2/reminders', other.access_token); assert.equal(list.status, 200); assert.deepEqual(JSON.parse(list.text).items, []);
    });
    const stale = etag;
    await step('owner update changes body and ETag', async () => {
      const result = await call(path, owner.access_token, 'PATCH', { title: 'Synthetic updated' }, etag); assert.equal(result.status, 200);
      etag = result.headers.get('etag'); assert.ok(etag !== stale); assert.equal(JSON.parse(result.text).title, 'Synthetic updated');
    });
    await step('stale If-Match rejected 412', async () => {
      assert.equal((await call(path, owner.access_token, 'PATCH', { title: 'Denied' }, stale)).status, 412);
      assert.equal((await call(path, owner.access_token, 'DELETE', undefined, stale)).status, 412);
    });
    await step('refresh rotates and preserves owner read', async () => {
      const renewed = await oauth({ grant_type: 'refresh_token', client_id: client.ClientId, refresh_token: owner.refresh_token });
      assert.ok(renewed.refresh_token && renewed.refresh_token !== owner.refresh_token, 'refresh rotates');
      const value = claims(renewed.access_token, 'access'); assert.ok(value.sub === ownerClaims.sub && value.scope === ownerClaims.scope, 'refresh preserves owner and scopes');
      const result = await call(path, renewed.access_token); assert.equal(result.status, 200); assert.equal(JSON.parse(result.text).title, 'Synthetic updated');
    });
    await step('owner delete and tombstone forbid recreation', async () => {
      const result = await call(path, owner.access_token, 'DELETE', undefined, etag); assert.equal(result.status, 200); assert.equal(JSON.parse(result.text).deleted, true);
      assert.equal((await call(path, owner.access_token)).status, 404);
      assert.equal((await call('/v2/reminders', owner.access_token, 'POST', item)).status, 409);
      const ownerId = createHash('sha256').update(JSON.stringify([issuer, ownerClaims.sub])).digest('hex');
      const persisted = await db.send(new ddb.GetItemCommand({ TableName: tables.reminders, Key: { ownerId: { S: ownerId }, id: { S: item.id } }, ConsistentRead: true }));
      assert.equal(persisted.Item.deleted.BOOL, true, 'actual DynamoDB tombstone persists');
    });
  } catch (error) {
    failure = error;
    // Do not print SDK error messages, assertion values, response bodies, or stacks.
    t.diagnostic(`FAIL phase: ${phase}; error class: ${error.constructor.name}; HTTP status: ${error.$metadata?.httpStatusCode ?? 'see phase assertion'}`);
  } finally {
    for (const [name, action] of cleanup.reverse()) {
      try { await action(); t.diagnostic(`CLEANUP PASS ${name}`); }
      catch (error) {
        cleanupErrors.push(name);
        t.diagnostic(`CLEANUP FAIL ${name}; error class: ${error.constructor.name}; collected failures: ${error instanceof AggregateError ? error.errors.length : 1}`);
      }
    }
  }
  t.diagnostic(`completed checks: ${passed.length}; cleanup errors: ${cleanupErrors.length}; dependent checks after failure were not executed`);
  assert.equal(cleanupErrors.length, 0, 'all owned resource cleanup succeeds');
  assert.ok(!failure, `authenticated CRUD blocked at phase: ${phase}`);
});
