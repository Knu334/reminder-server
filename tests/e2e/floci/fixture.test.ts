import assert from 'node:assert/strict';
import type { FunctionConfiguration } from '@aws-sdk/client-lambda';
import { test } from 'node:test';
import { assertRuntimeSettings } from './support/fixture.ts';
void test('real runner prerequisite path: settings failure sends zero inputs and marks dependents not-run', async t => {
  const { createEvidence, finalizeResults, evidenceContext } = await import('./support/evidence.ts');
  const { fixtureStates } = await import('./support/fixture.ts');
  const { runFixturePrerequisites } = await import('../../../scripts/e2e/run.ts');
  const { definitions } = await import('./support/cases.ts');
  const { mkdtemp, rm } = await import('node:fs/promises'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const directory = await mkdtemp(join(tmpdir(), 'fixture-prereq-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const ids = ['TF-03/settings', 'OBS-02/smoke', 'OBS-03/gateway-refusal', 'OBS-04/gateway-delivery'];
  const selected = ids.map(id => definitions.find(def => def.id === id)!);
  const evidence = await createEvidence(selected, join(directory, 'run'));
  let inputs = 0;
  const fixture = { request: async () => { inputs++; throw new Error('UNEXPECTED_INPUT'); }, setPublication: async () => { inputs++; }, clients: {}, stack: undefined } as unknown as import('./support/types.ts').E2EFixture;
  fixtureStates.set(fixture, { settingsComplete: false, smokeComplete: false, readbackPhase: '', readbackObserved: {}, outstanding: 0, cleanupIntervals: [], disposed: false } as unknown as import('./support/fixture.ts').RunFixtureState);
  assert.equal(await runFixturePrerequisites(evidence, selected, fixture), false);
  assert.equal(inputs, 0);
  await finalizeResults(evidence);
  const { readFile } = await import('node:fs/promises');
  const saved = JSON.parse(await readFile(join(evidenceContext(evidence).directory, 'results.json'), 'utf8')) as { cases: { id: string; result: { status: string } }[] };
  const byId = new Map(saved.cases.map(item => [item.id, item.result.status]));
  assert.equal(byId.get('TF-03/settings'), 'fail');
  for (const id of ids.slice(1)) assert.equal(byId.get(id), 'not-run', id);
});

void test('real runner disposes the owned fixture exactly once and never falls back to bare destroy', async () => {
  const { disposeRunOwned } = await import('../../../scripts/e2e/run.ts');
  let disposed = 0; let destroyed = 0;
  const stack = { destroy: async () => { destroyed++; return { attempted: 1, succeeded: 1, errors: 0, leaks: 0 }; } } as unknown as import('./support/types.ts').ProvisionedStack;
  const fixture = { dispose: async () => { disposed++; return { attempted: 3, succeeded: 3, errors: 0, leaks: 0 }; } } as unknown as import('./support/types.ts').E2EFixture;
  assert.deepEqual(await disposeRunOwned(stack, fixture), { attempted: 3, succeeded: 3, errors: 0, leaks: 0 });
  assert.deepEqual([disposed, destroyed], [1, 0]);
  assert.equal((await disposeRunOwned(stack, undefined)).attempted, 1); assert.equal(destroyed, 1);
  const failing = { dispose: async () => { disposed++; throw new Error('x'); } } as unknown as import('./support/types.ts').E2EFixture;
  assert.deepEqual(await disposeRunOwned(stack, failing), { attempted: 1, succeeded: 0, errors: 1, leaks: 0 });
  assert.deepEqual([disposed, destroyed], [2, 1]);
});
void test('current ZIP runtime handler alias concurrency and default limits must match independently', () => {
  const expected = { sha: 'current-zip', handler: 'dist/api.handler', timeout: 10, concurrency: 10, logGroup: 'owned-api', role: 'owned-role', env: { EXPECTED_API_STAGE: '$default' } };
  const settings: FunctionConfiguration = { Runtime: 'nodejs24.x', Handler: expected.handler, Timeout: 10, MemorySize: 512, Architectures: ['x86_64'], PackageType: 'Zip', Role: 'owned-role', CodeSha256: expected.sha, Environment: { Variables: expected.env }, LoggingConfig: { LogFormat: 'Text', LogGroup: 'owned-api' } };
  assert.doesNotThrow(() => assertRuntimeSettings(settings, 10, expected));
  for (const change of [{ CodeSha256: 'historical' }, { Handler: 'fake.handler' }, { Timeout: 1 }, { Environment: { Variables: { ...expected.env, MAX_OWNER_ITEMS: '1' } } }]) assert.throws(() => assertRuntimeSettings({ ...settings, ...change }, 10, expected), /SETTINGS_MISMATCH/);
  assert.throws(() => assertRuntimeSettings(settings, 0, expected), /SETTINGS_MISMATCH/);
});

void test('full IAM semantics detect changed Action Resource Condition and trust subject', async () => {
  const { policiesEqual } = await import('./support/expected-iam.ts');
  const expected = { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: ['s3:GetObject', 's3:GetObjectVersion'], Resource: ['owned/a', 'owned/b'], Condition: { StringEquals: { subject: 'owned-subject' } } }] };
  assert.equal(policiesEqual({ ...expected, Statement: [{ ...expected.Statement[0], Action: ['s3:GetObjectVersion', 's3:GetObject'], Resource: ['owned/b', 'owned/a'] }] }, expected), true);
  for (const changed of [{ Action: ['s3:*'] }, { Resource: ['*'] }, { Condition: { StringEquals: { subject: 'foreign' } } }]) assert.equal(policiesEqual({ ...expected, Statement: [{ ...expected.Statement[0], ...changed }] }, expected), false);
});

void test('case A/B users have independent synthetic identities and require completed real prerequisites', async t => {
  const { createEvidence, reserveResource, bindResourceIdentities, evidenceContext, finalizeResults } = await import('./support/evidence.ts');
  const { createRunFixture, fixtureState } = await import('./support/fixture.ts');
  const { createCaseAuth } = await import('./support/auth.ts');
  const { resetAuthControls } = await import('./support/auth.ts');
  const { cleanupOwnedSdk } = await import('./support/cleanup.ts');
  const { mkdtemp, rm } = await import('node:fs/promises'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const { definitions } = await import('./support/cases.ts'); const directory = await mkdtemp(join(tmpdir(), 'fixture-auth-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const evidence = await createEvidence([definitions[0]!], join(directory, 'run')); const prefix = `e2e-${evidence.runId.slice(4, 12)}`; const pool = 'ap-northeast-1_OwnedPool';
  const intent = `${evidence.runId}/platform/aws_cognito_user_pool.production`; await reserveResource(evidence, { kind: 'terraform-address', name: 'platform/aws_cognito_user_pool.production', id: intent }); await bindResourceIdentities(evidence, intent, [{ type: 'aws_cognito_user_pool', identity: pool }]);
  const stack = { target: { endpoint: 'http://floci:4566', region: 'ap-northeast-1', addresses: new Map([['floci', '172.18.0.2']]) }, bindings: { prefix, pool_id: pool, reminders_table: `${prefix}-production-reminders`, owner_state_table: `${prefix}-production-owner-state`, image_jobs_table: `${prefix}-production-image-jobs`, images_bucket: `${prefix}-000000000000-ap-northeast-1-images`, api_id: 'abcdefghij', cognito_issuer: `http://floci:4566/${pool}`, cognito_client_id: 'syntheticclient' }, artifact: {}, constructionOutputs: [{}, {}, {}, {}], setQuiescenceGuard() {}, async destroy() { return { attempted: 0, succeeded: 0, errors: 0, leaks: 0 }; }, manifest: evidenceContext(evidence).manifest, stateDirectory: directory } as unknown as import('./support/types.ts').ProvisionedStack;
  const fixture = await createRunFixture(stack, evidence); const state = fixtureState(fixture);
  const users: string[] = []; let sdkCalls = 0;
  const deleted = new Set<string>(); let failPassword = false; let poolName = ''; let clientName = ''; let recovered = 0; let removedClient = false; let removedPool = false; let failDelete = false;
  t.mock.method(state.cognito, 'send', async (command: { constructor: { name: string }; input: { Username: string; PoolName: string; ClientName: string; UserPoolId: string } }) => {
    sdkCalls++; const kind = command.constructor.name;
    const notFound = (name: string): never => { const error = new Error('not-found'); error.name = name; throw error; };
    if (kind === 'AdminCreateUserCommand') users.push(command.input.Username);
    if (kind === 'AdminSetUserPasswordCommand' && failPassword) throw new Error('SYNTHETIC_INITIALIZATION_FAILURE');
    if (kind === 'AdminDeleteUserCommand') { if (failDelete && command.input.Username === users[0]) throw new Error('SYNTHETIC_DELETE_FAILURE'); deleted.add(command.input.Username); }
    if (kind === 'AdminGetUserCommand') { if (deleted.has(command.input.Username)) notFound('UserNotFoundException'); return { UserStatus: 'CONFIRMED', UserAttributes: [{ Name: 'sub', Value: `sub-${command.input.Username}` }] }; }
    if (kind === 'CreateUserPoolCommand') { poolName = command.input.PoolName; return { UserPool: { Id: 'ap-northeast-1_ControlPool' } }; }
    if (kind === 'DescribeUserPoolCommand') { if (removedPool) notFound('ResourceNotFoundException'); return { UserPool: { Name: poolName, DeletionProtection: 'ACTIVE', AdminCreateUserConfig: { AllowAdminCreateUserOnly: true }, UserPoolTier: 'ESSENTIALS', AccountRecoverySetting: { RecoveryMechanisms: [{ Name: 'admin_only', Priority: 1 }] }, SchemaAttributes: [{ Name: 'email', AttributeDataType: 'String', Mutable: true, Required: true, StringAttributeConstraints: { MinLength: '0', MaxLength: '2048' } }] } }; }
    if (kind === 'CreateUserPoolClientCommand') { clientName = command.input.ClientName; throw new Error('SYNTHETIC_CLIENT_TIMEOUT'); }
    if (kind === 'ListUserPoolClientsCommand') { recovered++; return { UserPoolClients: [{ ClientName: clientName, ClientId: 'ownedclient123' }] }; }
    if (kind === 'DescribeUserPoolClientCommand') { if (removedClient) notFound('ResourceNotFoundException'); return { UserPoolClient: { ClientName: clientName } }; }
    if (kind === 'DeleteUserPoolClientCommand') removedClient = true;
    if (kind === 'DeleteUserPoolCommand') removedPool = true;
    return {};
  });
  await assert.rejects(createCaseAuth(fixture, 'case-before-gate'), /PREREQUISITE_FAILED/); assert.equal(users.length, 0); assert.equal(sdkCalls, 0);
  state.settingsComplete = true; state.smokeComplete = true;
  const firstAuth = await createCaseAuth(fixture, 'first'); await createCaseAuth(fixture, 'second'); await createCaseAuth(fixture, 'first'); assert.equal(users.length, 4); assert.equal(new Set(users).size, 4);
  assert.equal(evidenceContext(evidence).manifest.resources.filter(r => r.kind === 'sdk-user').length, 4);
  failPassword = true; await assert.rejects(createCaseAuth(fixture, 'partial'), /SYNTHETIC_INITIALIZATION_FAILURE/);
  await assert.rejects(firstAuth.login('a', ['openid'], 'foreign'), /SYNTHETIC_CLIENT_TIMEOUT/); assert.equal(recovered, 1);
  await finalizeResults(evidence); failDelete = true; const partialCleanup = await cleanupOwnedSdk(fixture); assert.deepEqual(partialCleanup, { attempted: 7, succeeded: 6, errors: 1, leaks: 1 }); failDelete = false; await resetAuthControls(fixture);
  assert.equal(deleted.size, 5); assert.equal(removedClient && removedPool, true); assert.equal(evidenceContext(evidence).manifest.resources.filter(r => r.kind === 'sdk-user' && r.removed).length, 5); assert.equal(evidenceContext(evidence).manifest.resources.filter(r => r.kind === 'sdk-control' && r.removed).length, 2); await fixture.dispose();
});

void test('artifact compares originally pinned version even when a newer version has identical bytes', async () => {
  const { assertPinnedArtifact } = await import('./support/fixture.ts');
  const receipt = { version: 'original', sha: 'same-bytes', bytes: 123 };
  const versions = { Versions: [{ VersionId: 'original', IsLatest: true }] };
  const head = { VersionId: 'original', ChecksumSHA256: 'same-bytes', ContentLength: 123 };
  assert.doesNotThrow(() => assertPinnedArtifact(versions, head, receipt));
  assert.throws(() => assertPinnedArtifact({ Versions: [{ VersionId: 'newer', IsLatest: true }] }, { ...head, VersionId: 'newer' }, receipt), /SETTINGS_MISMATCH/);
  assert.throws(() => assertPinnedArtifact({ ...versions, DeleteMarkers: [{ VersionId: 'marker' }] }, head, receipt), /SETTINGS_MISMATCH/);
  assert.throws(() => assertPinnedArtifact(versions, { ...head, ChecksumSHA256: 'changed' }, receipt), /SETTINGS_MISMATCH/);
});

void test('Lambda Gateway permission compares qualifier account ARN and complete scoped semantics', async () => {
  const { assertGatewayPermission } = await import('./support/fixture.ts');
  const identity = { account: '000000000000', apiId: 'abcdefghij', alias: 'arn:aws:lambda:ap-northeast-1:000000000000:function:e2e-12345678-production-api:production' };
  const policy = { Version: '2012-10-17', Statement: [{ Sid: 'ProductionGatewayOnly', Effect: 'Allow', Principal: { Service: 'apigateway.amazonaws.com' }, Action: 'lambda:InvokeFunction', Resource: identity.alias, Condition: { StringEquals: { 'AWS:SourceAccount': identity.account }, ArnLike: { 'AWS:SourceArn': `arn:aws:execute-api:ap-northeast-1:${identity.account}:${identity.apiId}/$default/*/*` } } }] };
  assert.doesNotThrow(() => assertGatewayPermission(JSON.stringify(policy), identity));
  for (const changed of [{ Resource: identity.alias.replace(':production', ':other') }, { Principal: { Service: 'other.amazonaws.com' } }, { Condition: {} }]) assert.throws(() => assertGatewayPermission(JSON.stringify({ ...policy, Statement: [{ ...policy.Statement[0], ...changed }] }), identity), /SETTINGS_MISMATCH/);
});

void test('all settings boundaries distinguish safe SDK rejection codec and semantic mismatch', async () => {
  const { runReadbackBoundary } = await import('./support/fixture.ts');
  const state = { readbackPhase: 'lambda-api-GetPolicy-production', readbackObserved: {} } as import('./support/fixture.ts').RunFixtureState;
  const sdk = Object.assign(new Error('SECRET_CANARY'), { name: 'ResourceNotFoundException', $metadata: { httpStatusCode: 404 } });
  await assert.rejects(runReadbackBoundary(state, async () => { throw sdk; }), /SETTINGS_READBACK_FAILED/);
  assert.deepEqual(state.readbackError, { code: 'ResourceNotFoundException', status: 404 }); assert.equal(state.readbackFailed, undefined);
  await assert.rejects(runReadbackBoundary(state, async () => { throw new SyntaxError('SECRET_CANARY'); }), /SETTINGS_READBACK_FAILED/);
  assert.equal(state.readbackError?.code, 'response-codec');
  await assert.rejects(runReadbackBoundary(state, async () => { throw new Error('SETTINGS_MISMATCH'); }), /SETTINGS_READBACK_FAILED/);
  assert.equal(state.readbackError?.code, 'SETTINGS_MISMATCH'); assert.deepEqual(state.readbackFailed, { api: 'lambda-api-GetPolicy-production', field: 'public-definition-fields', check: 1, expected: true, observed: false }); assert.equal(JSON.stringify(state).includes('SECRET_CANARY'), false);
  let probes = 0; state.readbackWire = { codec: 'json', policyPresent: false }; state.readbackProbe = async () => { probes++; return { succeeded: true, policyPresent: false, httpStatus: 200 }; };
  await assert.rejects(runReadbackBoundary(state, async () => { throw new Error('SETTINGS_MISMATCH'); }), /SETTINGS_READBACK_FAILED/); assert.equal(probes, 1); assert.deepEqual(state.readbackWirePrimary, { codec: 'json', policyPresent: false }); assert.deepEqual(state.independentReadback, { succeeded: true, policyPresent: false, httpStatus: 200 });
});

void test('synthetic service JSON goes through pinned SDK decoding and safe alias version classification', async t => {
  const { classifyAliasVersion } = await import('./support/fixture.ts'); const { localS3 } = await import('../../../scripts/e2e/terraform.ts'); const { LambdaClient, GetAliasCommand } = await import('@aws-sdk/client-lambda'); const http = await import('node:http'); const { PassThrough, Readable } = await import('node:stream');
  const target = { endpoint: 'http://floci:4566', region: 'ap-northeast-1', addresses: new Map([['floci', '172.18.0.2']]) } as const; const adapter = localS3(target); const client = new LambdaClient({ endpoint: target.endpoint, region: target.region, credentials: { accessKeyId: 'local', secretAccessKey: 'local' }, maxAttempts: 1, requestHandler: adapter.config.requestHandler }); t.after(() => { client.destroy(); adapter.destroy(); }); let document: object = { FunctionVersion: '$LATEST' };
  t.mock.method(http.default, 'request', (_url: URL, _options: unknown, callback: (response: import('node:http').IncomingMessage) => void) => { const response = Readable.from([Buffer.from(JSON.stringify(document))]) as import('node:http').IncomingMessage; response.statusCode = 200; response.rawHeaders = []; const outgoing = new PassThrough(); process.nextTick(() => callback(response)); return outgoing; });
  for (const [body, expected] of [[{ FunctionVersion: '$LATEST' }, { present: true, type: 'string', classification: 'latest' }], [{}, { present: false, type: 'undefined', classification: 'missing' }], [{ FunctionVersion: '' }, { present: true, type: 'string', classification: 'empty' }], [{ FunctionVersion: '12' }, { present: true, type: 'string', classification: 'published-numeric' }]] as const) { document = body; const response = await client.send(new GetAliasCommand({ FunctionName: 'e2e-12345678-production-api', Name: 'production' })); assert.equal(response.$metadata.httpStatusCode, 200); assert.deepEqual(classifyAliasVersion(response.FunctionVersion), expected); }
});

void test('alias policy canonical request forms remain qualified and never fall back to function policy', async () => {
  const { readAliasPolicy } = await import('./support/fixture.ts');
  const name = 'e2e-12345678-production-api'; const alias = `arn:aws:lambda:ap-northeast-1:000000000000:function:${name}:production`; const requests: unknown[] = []; const failures: unknown[] = [];
  const client = { async send(command: { input: unknown }) { requests.push(command.input); if (requests.length === 1) throw Object.assign(new Error('SECRET_CANARY'), { name: 'ResourceNotFoundException', $metadata: { httpStatusCode: 404 } }); return { Policy: 'synthetic-policy' }; } } as unknown as import('@aws-sdk/client-lambda').LambdaClient;
  const result = await readAliasPolicy(client, name, alias, failure => failures.push(failure));
  assert.equal(result.Policy, 'synthetic-policy'); assert.deepEqual(requests, [{ FunctionName: name, Qualifier: 'production' }, { FunctionName: alias }]); assert.deepEqual(failures, [{ code: 'ResourceNotFoundException', status: 404 }]);
  await assert.rejects(readAliasPolicy(client, name, alias.replace(':production', ':other'), () => {}), /ALIAS_POLICY_REJECTED/); assert.equal(requests.length, 2); assert.equal(JSON.stringify(failures).includes('SECRET_CANARY'), false);
});

void test('failed smoke retains actual HTTP input progress for honest dependent results', async () => {
  const { fixtureSmoke, fixtureStates, fixtureState } = await import('./support/fixture.ts');
  let calls = 0; const fixture = { async request() { calls++; if (calls === 2) throw new Error('SYNTHETIC_HTTP_FAILURE'); return { status: 503, headers: new Headers({ 'x-request-id': 'synthetic-ready' }), bytes: Buffer.alloc(0) }; } } as unknown as import('./support/types.ts').E2EFixture;
  fixtureStates.set(fixture, { settingsComplete: true } as import('./support/fixture.ts').RunFixtureState); const inputs: number[] = [];
  await assert.rejects(fixtureSmoke(fixture, status => inputs.push(status)), /SYNTHETIC_HTTP_FAILURE/);
  assert.deepEqual(inputs, [503]); assert.deepEqual(fixtureState(fixture).smokeObserved?.statuses, [503]); assert.equal(fixtureState(fixture).smokeObserved?.logs, false);
});

void test('Gateway CORS compares public settings with the API service zero MaxAge default', async () => {
  const { assertGatewayCors } = await import('./support/fixture.ts'); const cors = { AllowOrigins: ['https://extension.example.test'], AllowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'PUT', 'OPTIONS'], AllowHeaders: ['authorization', 'content-type', 'if-match'], ExposeHeaders: ['ETag', 'Location', 'X-Request-Id', 'Retry-After', 'Allow'], AllowCredentials: false, MaxAge: 0 };
  assert.doesNotThrow(() => assertGatewayCors(cors));
  const { AllowCredentials: _omitted, ...omitsFalseDefault } = cors; assert.doesNotThrow(() => assertGatewayCors(omitsFalseDefault));
  assert.doesNotThrow(() => assertGatewayCors({ ...cors, AllowHeaders: ['if-match', 'authorization', 'content-type'], AllowOrigins: [...cors.AllowOrigins] }));
  for (const changed of [{ AllowHeaders: ['authorization'] }, { AllowCredentials: true }, { AllowOrigins: ['https://foreign.test'] }, { MaxAge: 300 }, { AllowMethods: ['GET'] }, { ExposeHeaders: [] }]) assert.throws(() => assertGatewayCors({ ...cors, ...changed }), /SETTINGS_MISMATCH/);
});

void test('fixture HTTP preserves the actual owned Gateway endpoint path and rejects prefix escapes', async () => {
  const { gatewayRequestUrl } = await import('./support/fixture.ts');
  assert.equal(gatewayRequestUrl('http://floci:4566/owned-api/abcdefghij', '/v2/reminders?limit=1').href, 'http://floci:4566/owned-api/abcdefghij/v2/reminders?limit=1');
  assert.throws(() => gatewayRequestUrl('http://floci:4566/owned-api/abcdefghij', '/../other-api'), /LOCAL_TARGET_REJECTED/);
  assert.throws(() => gatewayRequestUrl('http://floci:4566/owned-api/abcdefghij', '//foreign.test/'), /LOCAL_TARGET_REJECTED/);
});

void test('Floci Gateway invocation maps the AWS-shaped owned endpoint onto the pinned local execute-api host', async () => {
  const { localGatewayInvocation } = await import('./support/fixture.ts');
  const target = { endpoint: 'http://floci:4566' as const, region: 'ap-northeast-1' as const, addresses: new Map([['floci', '172.18.0.2']]) };
  const mapped = localGatewayInvocation('https://abcdefghij.execute-api.ap-northeast-1.amazonaws.com', 'abcdefghij', target);
  assert.equal(mapped.base, 'http://abcdefghij.execute-api.ap-northeast-1.localhost:4566/');
  assert.equal(mapped.target.addresses.get('abcdefghij.execute-api.ap-northeast-1.localhost'), '172.18.0.2');
  assert.equal(mapped.target.addresses.has('abcdefghij.execute-api.ap-northeast-1.amazonaws.com'), false);
  for (const bad of ['https://zzzzzzzzzz.execute-api.ap-northeast-1.amazonaws.com', 'https://abcdefghij.execute-api.ap-northeast-1.amazonaws.com/x', 'https://abcdefghij.execute-api.ap-northeast-1.amazonaws.com.evil.test']) assert.throws(() => localGatewayInvocation(bad, 'abcdefghij', target), /LOCAL_TARGET_REJECTED/);
  assert.equal(localGatewayInvocation('http://floci:4566/owned-api/abcdefghij', 'abcdefghij', target).base, 'http://floci:4566/owned-api/abcdefghij');
});

void test('Lambda response observation preserves SDK bytes and projects only alias and qualified policy fields', async () => {
  const { observeLambdaResponse } = await import('./support/fixture.ts'); const { Readable } = await import('node:stream');
  const bytes = Buffer.from(JSON.stringify({ FunctionVersion: '$LATEST', Secret: 'SECRET_CANARY' }));
  const observed = await observeLambdaResponse(Readable.from([bytes]), 'lambda-api-GetAlias');
  const restored: Buffer[] = []; for await (const part of observed.body) restored.push(Buffer.from(part));
  assert.deepEqual(Buffer.concat(restored), bytes); assert.deepEqual(observed.safe, { codec: 'json', aliasVersion: { present: true, type: 'string', classification: 'latest' } });
  const policy = await observeLambdaResponse(Readable.from([Buffer.from(JSON.stringify({ Policy: JSON.stringify({ Version: '2012-10-17', Statement: [{ Sid: 'ProductionGatewayOnly', Resource: 'SECRET_CANARY' }] }) }))]), 'lambda-api-GetPolicy-production');
  assert.deepEqual(policy.safe, { codec: 'json', policyPresent: true, policyType: 'string', policyCodec: 'json', policyVersion: true, statementCount: 1, qualifiedSid: true });
  assert.equal(JSON.stringify([observed.safe, policy.safe]).includes('SECRET_CANARY'), false);
});

void test('IAM condition context-key case and exact StringLike preserve full SourceAccount requirements', async () => {
  const { policiesEqual } = await import('./support/expected-iam.ts');
  const expected = { Condition: { StringEquals: { 'AWS:SourceAccount': '000000000000' }, ArnLike: { 'AWS:SourceArn': 'arn:aws:execute-api:ap-northeast-1:000000000000:abcdefghij/$default/*/*' } } };
  assert.equal(policiesEqual({ Condition: { StringLike: { 'aws:sourceaccount': '000000000000' }, ArnLike: { 'aws:sourcearn': expected.Condition.ArnLike['AWS:SourceArn'] } } }, expected), true);
  for (const bad of [{ StringLike: { 'aws:sourceaccount': '*' } }, { StringEquals: { 'aws:sourceaccount': '111111111111' } }, { StringEqualsIgnoreCase: { 'aws:sourceaccount': '000000000000' } }, { StringEquals: {} }, { StringEquals: { 'AWS:SourceAccount': '000000000000', 'aws:sourceaccount': '111111111111' } }]) assert.equal(policiesEqual({ Condition: bad }, expected), false);
});

void test('foreign pool and client controls retain primary auth settings and reject secrets or wrong parent', async () => {
  const { assertForeignPoolSettings, assertControlClientSettings } = await import('./support/auth.ts');
  const pool = { Name: 'e2e-12345678-foreign-pool-0', DeletionProtection: 'ACTIVE' as const, UserPoolTier: 'ESSENTIALS' as const, AdminCreateUserConfig: { AllowAdminCreateUserOnly: true }, AccountRecoverySetting: { RecoveryMechanisms: [{ Name: 'admin_only' as const, Priority: 1 }] }, SchemaAttributes: [{ Name: 'email', AttributeDataType: 'String' as const, Mutable: true, Required: true, StringAttributeConstraints: { MinLength: '0', MaxLength: '2048' } }] };
  assert.doesNotThrow(() => assertForeignPoolSettings(pool, pool.Name));
  for (const changed of [{ AccountRecoverySetting: {} }, { SchemaAttributes: [] }, { UserPoolTier: 'LITE' as const }]) assert.throws(() => assertForeignPoolSettings({ ...pool, ...changed }, pool.Name), /AUTH_FIXTURE_FAILED/);
  const main = { AccessTokenValidity: 5, IdTokenValidity: 5, RefreshTokenValidity: 30, AllowedOAuthFlowsUserPoolClient: true, AllowedOAuthFlows: ['code' as const], RefreshTokenRotation: { Feature: 'ENABLED' as const, RetryGracePeriodSeconds: 10 } }; const read = { ...main, ClientId: 'controlclient', UserPoolId: 'ap-northeast-1_ControlPool' }; const identity = { client: read.ClientId, pool: read.UserPoolId };
  assert.doesNotThrow(() => assertControlClientSettings(read, main, identity));
  for (const changed of [{ ClientSecret: 'SECRET_CANARY' }, { UserPoolId: 'ap-northeast-1_ForeignPool' }, { AccessTokenValidity: 1 }]) assert.throws(() => assertControlClientSettings({ ...read, ...changed }, main, identity), /AUTH_FIXTURE_FAILED/);
});

void test('dispose retains SDK cleanup errors and independently counts final parent removal remaining and unknown IDs', async t => {
  const { mkdtemp, rm } = await import('node:fs/promises'); const { join } = await import('node:path'); const { tmpdir } = await import('node:os');
  const { createEvidence, reserveResource, bindResourceIdentities, finalizeResults, evidenceContext } = await import('./support/evidence.ts'); const { createRunFixture, fixtureState } = await import('./support/fixture.ts'); const { createCaseAuth } = await import('./support/auth.ts'); const { definitions } = await import('./support/cases.ts');
  const directory = await mkdtemp(join(tmpdir(), 'sdk-final-absence-')); t.after(() => rm(directory, { recursive: true, force: true }));
  for (const scenario of ['parent-removed', 'parent-remains', 'unknown-id']) {
    const evidence = await createEvidence([definitions[0]!], join(directory, scenario)); const prefix = `e2e-${evidence.runId.slice(4, 12)}`; const pool = 'ap-northeast-1_OwnedPool'; const intent = `${evidence.runId}/platform/aws_cognito_user_pool.production`; await reserveResource(evidence, { kind: 'terraform-address', name: 'platform/aws_cognito_user_pool.production', id: intent }); await bindResourceIdentities(evidence, intent, [{ type: 'aws_cognito_user_pool', identity: pool }]);
    let guard = async () => {}; let final = false; let parentRemoved = false; let sdkCalls = 0;
    const stack = { target: { endpoint: 'http://floci:4566', region: 'ap-northeast-1', addresses: new Map([['floci', '172.18.0.2']]) }, bindings: { prefix, pool_id: pool, reminders_table: `${prefix}-production-reminders`, owner_state_table: `${prefix}-production-owner-state`, image_jobs_table: `${prefix}-production-image-jobs`, images_bucket: `${prefix}-000000000000-ap-northeast-1-images`, api_id: 'abcdefghij', cognito_issuer: `http://floci:4566/${pool}`, cognito_client_id: 'syntheticclient' }, artifact: {}, constructionOutputs: [{}, {}, {}, {}], setQuiescenceGuard(value: () => Promise<void>) { guard = value; }, async destroy() { let errors = 0; try { await guard(); } catch { errors++; } final = true; parentRemoved = scenario !== 'parent-remains'; return { attempted: 18, succeeded: 18, errors, leaks: 0 }; }, manifest: evidenceContext(evidence).manifest, stateDirectory: directory } as unknown as import('./support/types.ts').ProvisionedStack;
    const fixture = await createRunFixture(stack, evidence); const state = fixtureState(fixture);
    t.mock.method(state.cognito, 'send', async (command: { constructor: { name: string }; input: { Username?: string; UserPoolId?: string } }) => {
      sdkCalls++; assert.equal(command.input.UserPoolId, pool); const kind = command.constructor.name;
      if (final) assert.ok(['AdminGetUserCommand', 'DescribeUserPoolCommand'].includes(kind), 'post-Terraform calls are read-only');
      if (kind === 'AdminDeleteUserCommand') throw new Error('SYNTHETIC_DELETE_FAILURE');
      if (parentRemoved) throw Object.assign(new Error('SECRET_CANARY'), { name: 'ResourceNotFoundException' });
      if (kind === 'AdminGetUserCommand') return { UserStatus: 'CONFIRMED', UserAttributes: [{ Name: 'sub', Value: `sub-${command.input.Username}` }] };
      if (kind === 'DescribeUserPoolCommand') return { UserPool: { Id: pool } }; return {};
    });
    state.settingsComplete = true; state.smokeComplete = true; await createCaseAuth(fixture, 'case');
    if (scenario === 'unknown-id') await reserveResource(evidence, { kind: 'sdk-control', name: `${prefix}-unknown-pool`, id: `${evidence.runId}/sdk-control/${prefix}-unknown-pool`, suite: state.suite });
    await finalizeResults(evidence); const cleanup = await fixture.dispose();
    assert.deepEqual(cleanup, { attempted: scenario === 'unknown-id' ? 21 : 20, succeeded: scenario === 'parent-remains' ? 18 : 20, errors: scenario === 'unknown-id' ? 3 : 2, leaks: scenario === 'parent-remains' ? 2 : 0 });
    assert.ok(sdkCalls > 0); assert.equal(evidenceContext(evidence).manifest.resources.filter(r => r.kind === 'sdk-user' && r.removed).length, scenario === 'parent-remains' ? 0 : 2);
  }
});

void test('failed fixture request or unfinished cleanup invoke still lets SDK-owned controls be recovered', async t => {
  const { createEvidence, reserveResource, bindResourceIdentities, evidenceContext, finalizeResults } = await import('./support/evidence.ts');
  const { createRunFixture, fixtureState } = await import('./support/fixture.ts');
  const { createCaseAuth } = await import('./support/auth.ts');
  const { mkdtemp, rm } = await import('node:fs/promises'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const { definitions } = await import('./support/cases.ts'); const directory = await mkdtemp(join(tmpdir(), 'fixture-guard-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const evidence = await createEvidence([definitions[0]!], join(directory, 'run')); const prefix = `e2e-${evidence.runId.slice(4, 12)}`; const pool = 'ap-northeast-1_OwnedPool';
  const intent = `${evidence.runId}/platform/aws_cognito_user_pool.production`; await reserveResource(evidence, { kind: 'terraform-address', name: 'platform/aws_cognito_user_pool.production', id: intent }); await bindResourceIdentities(evidence, intent, [{ type: 'aws_cognito_user_pool', identity: pool }]);
  let guard: (() => Promise<void>) | undefined;
  const stack = { target: { endpoint: 'http://floci:4566', region: 'ap-northeast-1', addresses: new Map([['floci', '172.18.0.2']]) }, bindings: { prefix, pool_id: pool, api_base_url: 'http://foreign.invalid:4566/', reminders_table: `${prefix}-production-reminders`, owner_state_table: `${prefix}-production-owner-state`, image_jobs_table: `${prefix}-production-image-jobs`, images_bucket: `${prefix}-000000000000-ap-northeast-1-images`, api_id: 'abcdefghij', cognito_issuer: `http://floci:4566/${pool}`, cognito_client_id: 'syntheticclient' }, artifact: {}, constructionOutputs: [{}, {}, {}, {}], setQuiescenceGuard(check: () => Promise<void>) { guard = check; }, async destroy() { await guard!(); return { attempted: 0, succeeded: 0, errors: 0, leaks: 0 }; }, manifest: evidenceContext(evidence).manifest, stateDirectory: directory } as unknown as import('./support/types.ts').ProvisionedStack;
  const fixture = await createRunFixture(stack, evidence); const state = fixtureState(fixture);
  const deleted = new Set<string>(); const users: string[] = [];
  t.mock.method(state.cognito, 'send', async (command: { constructor: { name: string }; input: { Username: string } }) => {
    const kind = command.constructor.name;
    if (kind === 'AdminCreateUserCommand') users.push(command.input.Username);
    if (kind === 'AdminDeleteUserCommand') deleted.add(command.input.Username);
    if (kind === 'AdminGetUserCommand') { if (deleted.has(command.input.Username)) { const error = new Error('gone'); error.name = 'UserNotFoundException'; throw error; } return { UserStatus: 'CONFIRMED', UserAttributes: [{ Name: 'sub', Value: 'sub-x' }] }; }
    return {};
  });
  state.settingsComplete = true; state.smokeComplete = true;
  await createCaseAuth(fixture, 'owned'); assert.equal(users.length, 2);
  await assert.rejects(fixture.request('/healthz'), /LOCAL_TARGET_REJECTED/);
  assert.equal(state.outstanding, 0, 'a settled failed request releases its accounting');
  state.cleanupIntervals.push({ since: Date.now(), until: 0, completed: false }); // a cleanup invoke that failed and may still be running
  await finalizeResults(evidence);
  await assert.rejects(fixture.dispose(), /SETTINGS_MISMATCH/, 'unfinished invoke must not satisfy quiescence');
  assert.equal(deleted.size, 2, 'SDK controls are still deleted even though quiescence failed');
  assert.deepEqual(state.sdkCleanup, { attempted: 2, succeeded: 2, errors: 0, leaks: 0 });
});
