import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import http from 'node:http';
import dns from 'node:dns';
import { PassThrough, Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as store from '../../e2e/floci/support/evidence.ts';
import { definitions } from '../../e2e/floci/support/cases.ts';

void test('owned intent survives case and process saves before creation, finalized results prohibit further cases', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tf-evidence-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'run');
  const evidence = await store.createEvidence([definitions[0]!], path);
  assert.equal(typeof store.reserveResource, 'function');
  const resource = { kind: 'terraform-root', name: 'bootstrap', id: `${evidence.runId}/bootstrap` };
  await store.reserveResource(evidence, resource);
  await store.recordProcess(evidence, { tool: 'terraform', status: 'succeeded', exitCode: 0, durationMs: 1, timeoutMs: 10, expectedOutputMatched: false });
  let saved = JSON.parse(await readFile(join(path, 'manifest.json'), 'utf8'));
  assert.equal(saved.resources.length, 1);
  assert.equal(saved.resources[0].created, false);
  await store.markResource(evidence, resource.id, 'created');
  await store.finalizeResults(evidence);
  await assert.rejects(evidence.record({ id: definitions[0]!.id, status: 'not-run', phase: 'provision', durationMs: 0, reason: 'prerequisite-failed' }));
  await store.markResource(evidence, resource.id, 'removed');
  await evidence.finish({ attempted: 1, succeeded: 1, errors: 0, leaks: 0 });
  saved = JSON.parse(await readFile(join(path, 'manifest.json'), 'utf8'));
  assert.equal(saved.resources[0].created, true);
  assert.equal(saved.resources[0].removed, true);
  assert.equal(saved.resultsFinalized, true);
});

void test('public roots preserve source and reject unauthorized transformed or generated changes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tf-source-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = await import('../../../scripts/e2e/terraform-source.ts').catch(() => undefined);
  assert.equal(typeof source?.prepareProductionRoots, 'function');
  const target = { endpoint: 'http://floci:4566' as const, region: 'ap-northeast-1' as const, addresses: new Map([['floci', '172.18.0.2']]) };
  const roots = await source!.prepareProductionRoots(target, join(directory, 'roots'));
  assert.equal(roots.validationDiffs.length, 0);
  await source!.bindCognitoIdentity(roots, target, 'ap-northeast-1_Synthetic1', 'http://floci:4566/ap-northeast-1_Synthetic1', 'http://floci:4566/cognito-idp');
  assert.equal(roots.validationDiffs.length, 2);
  await source!.verifyProductionRoots(roots);
  const { writeFile } = await import('node:fs/promises');
  const path = join(roots.application, 'variables.tf');
  const original = await readFile(path, 'utf8');
  for (const bad of [original.replace('http://floci:4566', 'http://172.18.0.2:4566'), original.replace('runtime_limits', 'relaxed_limits'), original.replace('nullable = false', 'nullable = true')]) {
    await writeFile(path, bad); await assert.rejects(source!.verifyProductionRoots(roots));
  }
  await writeFile(path, original);
  await writeFile(join(roots.application, 'unexpected_override.tf'), '');
  await assert.rejects(source!.verifyProductionRoots(roots));
});

void test('default endpoint is rejected before public-source preparation', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tf-target-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = await import('../../../scripts/e2e/terraform-source.ts').catch(() => undefined);
  assert.equal(typeof source?.prepareProductionRoots, 'function');
  await assert.rejects(source!.prepareProductionRoots({ endpoint: 'https://amazonaws.com' as 'http://floci:4566', region: 'ap-northeast-1', addresses: new Map([['floci', '8.8.8.8']]) }, join(directory, 'roots')));
});

void test('artifact registration rejects tampered ZIP and changed source before any request', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tf-artifact-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const artifact = await import('../../e2e/floci/support/artifact.ts').catch(() => undefined);
  assert.equal(typeof artifact?.verifyArtifactSnapshot, 'function');
  const { writeFile } = await import('node:fs/promises');
  const { createHash } = await import('node:crypto');
  const bytes = Buffer.from('synthetic zip tamper canary');
  const zipPath = join(directory, 'current.zip'); await writeFile(zipPath, bytes);
  const snapshot = { zipPath, compressedBytes: bytes.length, sha256Hex: createHash('sha256').update(bytes).digest('hex'), sha256Base64: createHash('sha256').update(bytes).digest('base64'), inputDigest: '0'.repeat(64), dirtyPaths: [] };
  await assert.rejects(artifact!.verifyArtifactSnapshot(snapshot), /ARTIFACT_REJECTED/);
  await writeFile(zipPath, 'changed');
  await assert.rejects(artifact!.verifyArtifactSnapshot(snapshot), /ARTIFACT_REJECTED/);
});

void test('cleanup overrides require finalized results and prohibit subsequent construction verification', async t => {
  const source = await import('../../../scripts/e2e/terraform-source.ts');
  const directory = await mkdtemp(join(tmpdir(), 'tf-cleanup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const roots = await source.prepareProductionRoots({ endpoint: 'http://floci:4566', region: 'ap-northeast-1', addresses: new Map([['floci', '172.18.0.2']]) }, join(directory, 'roots'));
  await assert.rejects(source.cleanupOverrides(roots, false));
  await source.cleanupOverrides(roots, true);
  await assert.rejects(source.verifyProductionRoots(roots));
  await source.verifyProductionRoots(roots, true);
  const cleanup = await readFile(join(roots.application, 'cleanup_override.tf.json'), 'utf8');
  assert.match(cleanup, /"prevent_destroy": false/);
  assert.doesNotMatch(cleanup, /postcondition/);
  assert.match(await readFile(join(roots.application, 'gateway.tf'), 'utf8'), /postcondition/);
});

void test('driver rejects foreign target before launching Terraform and account locks reject a second owner', async t => {
  const driver = await import('../../../scripts/e2e/terraform.ts').catch(() => undefined);
  assert.equal(typeof driver?.acquireAccountLock, 'function');
  const directory = await mkdtemp(join(tmpdir(), 'tf-lock-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const release = await driver!.acquireAccountLock(directory, '000000000000', 'e2e-first');
  await assert.rejects(driver!.acquireAccountLock(directory, '000000000000', 'e2e-second'));
  await release();
  const releaseAgain = await driver!.acquireAccountLock(directory, '000000000000', 'e2e-second'); await releaseAgain();
  await assert.rejects(driver!.provisionStack({ endpoint: 'https://sts.amazonaws.com' as 'http://floci:4566', region: 'ap-northeast-1', addresses: new Map() }, { publication: false }, {} as never, {} as never), /LOCAL_TARGET_REJECTED/);
});

void test('partial apply retains cleanup handle, reserves before create, and refuses cleanup until finalized', async t => {
  const driver = await import('../../../scripts/e2e/terraform.ts');
  const { inputSnapshot } = await import('../../../scripts/e2e/prepare-artifact.ts');
  const { createHash } = await import('node:crypto');
  const { writeFile } = await import('node:fs/promises');
  const directory = await mkdtemp(join(tmpdir(), 'tf-partial-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const evidence = await store.createEvidence([definitions[0]!], join(directory, 'run'));
  t.after(async () => { const lock = join(process.cwd(), '.superpowers/locks/123456789012.lock'); try { if (await readFile(lock, 'utf8') === evidence.runId) await unlink(lock); } catch { /* no lock */ } });
  const bytes = Buffer.from('synthetic verified input'); const zipPath = join(directory, 'zip'); await writeFile(zipPath, bytes);
  const artifact = { zipPath, compressedBytes: bytes.length, sha256Hex: createHash('sha256').update(bytes).digest('hex'), sha256Base64: createHash('sha256').update(bytes).digest('base64'), ...await inputSnapshot() };
  let httpCount = 0;
  t.mock.method(http, 'request', (_url: URL, _options: unknown, callback: (response: http.IncomingMessage) => void) => {
    const response = Readable.from([Buffer.from(httpCount++ === 0 ? '<Account>123456789012</Account>' : '<ListOpenIDConnectProvidersResponse/>')]) as http.IncomingMessage;
    response.statusCode = 200; response.rawHeaders = [];
    const outgoing = new PassThrough(); process.nextTick(() => callback(response)); return outgoing;
  });
  const calls: string[] = []; let reserved = false; let initialIntents = 0;
  t.mock.method(childProcess, 'spawn', (_tool: string, args: string[]) => {
    calls.push(args[0]!);
    if (args[0] === 'init') {
      const manifest = JSON.parse(readFileSync(join(directory, 'run/manifest.json'), 'utf8'));
      initialIntents = manifest.resources.filter((resource: { kind: string }) => resource.kind === 'terraform-address').length;
    }
    if (args[0] === 'apply') {
      const manifest = JSON.parse(readFileSync(join(directory, 'run/manifest.json'), 'utf8'));
      reserved = manifest.resources[0].created === false && manifest.resources[0].name === 'bootstrap';
    }
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill() {} });
    process.nextTick(() => child.emit('close', args[0] === 'apply' ? 1 : 0)); return child;
  });
  const target = {endpoint:'http://floci:4566' as const, region:'ap-northeast-1' as const,addresses:new Map([['floci','172.18.0.2']])};
  let failure: InstanceType<typeof driver.ProvisioningFailure> | undefined;
  try { await driver.provisionStack(target,{publication:false},artifact,evidence); } catch(error) { if(error instanceof driver.ProvisioningFailure) failure=error; else throw error; }
  assert.ok(failure); assert.equal(failure.phase,'bootstrap-apply'); assert.equal(reserved, true);
  assert.equal(initialIntents, 44);
  await assert.rejects(failure.ownedStack.destroy(),/CLEANUP_REJECTED/);
  await store.finalizeResults(evidence);
  const result=await failure.ownedStack.destroy();
  assert.equal(calls.at(-1),'destroy'); assert.equal(result.errors,0); assert.equal(result.leaks,0);
  const after = store.evidenceContext(evidence).manifest.resources;
  assert.equal(after.filter(item => item.kind === 'terraform-address').length, 44);
  assert.ok(after.filter(item => item.name.startsWith('platform/') || item.name.startsWith('application/')).every(item => !item.created && !item.removed));
  assert.ok(after.filter(item => item.kind === 'terraform-root' && item.name !== 'bootstrap').every(item => !item.created && !item.removed));
  await evidence.finish(result);
});

void test('Terraform transport blocks default AWS CONNECT and HTTP before upstream sockets', async () => {
  const driver = await import('../../../scripts/e2e/terraform.ts');
  assert.equal(typeof driver.withTerraformTransport,'function');
  const target={endpoint:'http://floci:4566' as const,region:'ap-northeast-1' as const,addresses:new Map([['floci','172.18.0.2']])};
  const result=await driver.withTerraformTransport(target,async proxy=>{
    const proxyURL=new URL(proxy);const authorization='Basic '+Buffer.from(`${proxyURL.username}:${proxyURL.password}`).toString('base64');proxyURL.username='';proxyURL.password='';
    const connect=await new Promise<number>(resolve=>{const request=http.request(proxyURL,{method:'CONNECT',path:'s3.ap-northeast-1.amazonaws.com:443',headers:{'proxy-authorization':authorization}});request.on('connect',response=>resolve(response.statusCode??0));request.on('response',response=>{response.resume();resolve(response.statusCode??0);});request.end();});
    const ordinary=await new Promise<number>(resolve=>{const request=http.request(proxyURL,{method:'GET',path:'http://s3.ap-northeast-1.amazonaws.com/',headers:{'proxy-authorization':authorization}});request.on('response',response=>{response.resume();resolve(response.statusCode??0);});request.end();});
    return [connect,ordinary];
  });
  assert.deepEqual(result.value,[403,403]);assert.equal(result.forwarded,0);assert.equal(result.denied.length,2);
});

void test('pinned AWS provider auxiliary S3 Control uses explicit owned endpoint', async t => {
  const source=await import('../../../scripts/e2e/terraform-source.ts');const directory=await mkdtemp(join(tmpdir(),'tf-s3control-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const roots=await source.prepareProductionRoots({endpoint:'http://floci:4566',region:'ap-northeast-1',addresses:new Map([['floci','172.18.0.2']])},join(directory,'roots'));
  const provider=JSON.parse(await readFile(join(roots.bootstrap,'connection_override.tf.json'),'utf8'));
  assert.equal(provider.provider.aws.endpoints.s3control,'http://floci:4566');
});

void test('authenticated account relay preserves owned S3 Control request and rejects every unknown boundary', async t => {
  const {withTerraformTransport}=await import('../../../scripts/e2e/terraform-transport.ts');
  const target={endpoint:'http://floci:4566' as const,region:'ap-northeast-1' as const,addresses:new Map([['floci','172.18.0.2']])};
  const original=http.request;let forwarded=0;let preserved=false;let dnsLookups=0;
  const originalLookup=dns.lookup;
  t.mock.method(dns,'lookup',(host:string,...args: unknown[])=>{if(host==='127.0.0.1')return Reflect.apply(originalLookup,dns,[host,...args]);dnsLookups++;throw new Error('EXTERNAL_DNS_CANARY');});
  t.mock.method(http,'request',(url:URL,options: http.RequestOptions,callback:(response:http.IncomingMessage)=>void)=>{
    if(new URL(url).hostname==='127.0.0.1')return original(url,options,callback);
    forwarded++;preserved=url.hostname==='000000000000.floci'&&url.pathname==='/v20180820/tags/arn:aws:s3:::e2e-relay-bucket'&&options.headers!==undefined&&(options.headers as Record<string,string>).host==='000000000000.floci:4566'&&(options.headers as Record<string,string>).authorization==='synthetic-signature';
    (options.lookup as (host: string, options: { all: false }, callback: (error: unknown, address: string, family: number) => void) => void)(url.hostname,{all:false},(error,address,family)=>{assert.equal(error,null);assert.equal(address,'172.18.0.2');assert.equal(family,4);});
    const response=Readable.from([Buffer.from('synthetic response')]) as http.IncomingMessage;response.statusCode=200;response.headers={};const outgoing=new PassThrough();process.nextTick(()=>callback(response));return outgoing;
  });
  const result=await withTerraformTransport(target,async proxy=>{
    const proxyURL=new URL(proxy);const auth='Basic '+Buffer.from(`${proxyURL.username}:${proxyURL.password}`).toString('base64');proxyURL.username='';proxyURL.password='';
    const request=(path:string,authenticated=true)=>new Promise<number>(resolve=>{const logical=new URL(path);const outgoing=http.request(proxyURL,{method:'GET',path,headers:{host:logical.host,'x-amz-account-id':'000000000000',authorization:'synthetic-signature',...(authenticated?{'proxy-authorization':auth}:{})}},response=>{response.resume();resolve(response.statusCode??0);});outgoing.end();});
    const allowed='http://000000000000.floci:4566/v20180820/tags/arn:aws:s3:::e2e-relay-bucket';
    const statuses=[await request(allowed)];
    for(const path of [allowed.replace('000000000000','111111111111'),allowed.replace('4566','9999'),allowed.replace('e2e-relay-bucket','foreign-bucket'),allowed.replace('/v20180820/tags/','/other/'),allowed.replace('.floci','.example.com'),allowed+'?unknown=1'])statuses.push(await request(path));
    statuses.push(await request(allowed,false));return statuses;
  },{accountId:'000000000000',buckets:['e2e-relay-bucket']});
  assert.deepEqual(result.value,[200,403,403,403,403,403,403,407]);assert.equal(forwarded,1);assert.ok(preserved);assert.equal(dnsLookups,0);
});

void test('owned resource capture rejects foreign identities and independent probes do not infer absence from empty state', async t => {
  const driver = await import('../../../scripts/e2e/terraform.ts');
  assert.equal(typeof driver.captureOwnedResources, 'function');
  const owner = { prefix: 'e2e-deadbeef', account: '000000000000' };
  const state = { resources: [{ mode: 'managed', type: 'aws_iam_role', name: 'runtime', instances: [{ attributes: { name: 'e2e-deadbeef-production-api', arn: 'arn:aws:iam::000000000000:role/e2e-deadbeef-production-api', secret: 'never-project-canary' } }] }] };
  const resources = driver.captureOwnedResources(state, owner);
  assert.equal(resources.length, 1);
  assert.doesNotMatch(JSON.stringify(resources), /never-project-canary|secret/);
  assert.throws(() => driver.captureOwnedResources({ ...state, resources: [{ ...state.resources[0]!, instances: [{ attributes: { name: 'foreign-role' } }] }] }, owner), /FOREIGN_STATE_REJECTED/);
  const target = { endpoint: 'http://floci:4566' as const, region: 'ap-northeast-1' as const, addresses: new Map([['floci', '172.18.0.2']]) };
  let status = 200;
  t.mock.method(http, 'request', (_url: URL, _options: unknown, callback: (response: http.IncomingMessage) => void) => {
    const response = Readable.from([Buffer.from(status === 200 ? '<GetRoleResponse/>' : status === 404 ? '<Code>NoSuchEntity</Code>' : 'canary-unknown')]) as http.IncomingMessage;
    response.statusCode = status; response.rawHeaders = [];
    const outgoing = new PassThrough(); process.nextTick(() => callback(response)); return outgoing;
  });
  assert.equal(await driver.probeOwnedResource(target, resources[0]!), 'exists');
  status = 503; assert.equal(await driver.probeOwnedResource(target, resources[0]!), 'unverified');
  status = 404; assert.equal(await driver.probeOwnedResource(target, resources[0]!), 'absent');
});

void test('construction action failure is recorded before finalization and retained stack cleanup', async t => {
  const runner = await import('../../../scripts/e2e/run.ts');
  assert.equal(typeof runner.runConstruction, 'function');
  const directory = await mkdtemp(join(tmpdir(), 'tf-runner-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const definition = definitions.find(definition => definition.id === 'TF-01/apply')!;
  const evidence = await store.createEvidence([definition], join(directory, 'run'));
  const driver = await import('../../../scripts/e2e/terraform.ts');
  let cleaned = false;
  const stack = { async destroy() { assert.ok(store.evidenceContext(evidence).finalized); cleaned = true; return { attempted: 2, succeeded: 1, errors: 1, leaks: 0 }; } } as unknown as import('../../e2e/floci/support/types.ts').ProvisionedStack;
  const retained = await runner.runConstruction(evidence, definition, async () => { throw new driver.ProvisioningFailure('bootstrap-apply', stack); });
  assert.equal(retained, stack);
  const saved = JSON.parse(await readFile(join(directory, 'run/results.json'), 'utf8'));
  assert.equal(saved.cases[0].result.status, 'fail');
  await store.finalizeResults(evidence);
  const cleanup = await retained!.destroy(); const summary = await evidence.finish(cleanup);
  assert.equal(cleaned, true); assert.equal(summary.failed, 1); assert.equal(summary.cleanup.errors, 1); assert.equal(summary.exitCode, 1);
});

void test('DynamoDB absence probe uses its actual JSON protocol and rejects unverified responses', async t => {
  const { probeOwnedResource } = await import('../../../scripts/e2e/terraform.ts');
  let protocol = ''; let status = 400;
  t.mock.method(http, 'request', (_url: URL, options: http.RequestOptions, callback: (response: http.IncomingMessage) => void) => {
    protocol = (options.headers as Record<string, string>)['content-type']!;
    const response = Readable.from([Buffer.from(status === 400 ? '{"__type":"ResourceNotFoundException"}' : '{"__type":"UnknownCanary"}')]) as http.IncomingMessage;
    response.statusCode = status; response.rawHeaders = [];
    const outgoing = new PassThrough(); process.nextTick(() => callback(response)); return outgoing;
  });
  const target = { endpoint: 'http://floci:4566' as const, region: 'ap-northeast-1' as const, addresses: new Map([['floci', '172.18.0.2']]) };
  const resource = { type: 'aws_dynamodb_table', identity: 'e2e-deadbeef-production-reminders' };
  assert.equal(await probeOwnedResource(target, resource), 'absent'); assert.equal(protocol, 'application/x-amz-json-1.0');
  status = 503; assert.equal(await probeOwnedResource(target, resource), 'unverified');
});

void test('artifact upload is create-only and ownership intent is durable before any network call', async t => {
  const { registerArtifact } = await import('../../e2e/floci/support/artifact.ts');
  const { inputSnapshot } = await import('../../../scripts/e2e/prepare-artifact.ts');
  const { createHash } = await import('node:crypto'); const { writeFile } = await import('node:fs/promises');
  const directory = await mkdtemp(join(tmpdir(), 'tf-create-only-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const evidence = await store.createEvidence([definitions[0]!], join(directory, 'run'));
  const bytes = Buffer.from('synthetic create-only bytes'); const zipPath = join(directory, 'zip'); await writeFile(zipPath, bytes);
  const hash = createHash('sha256').update(bytes).digest(); const snapshot = { zipPath, compressedBytes: bytes.length, sha256Hex: hash.toString('hex'), sha256Base64: hash.toString('base64'), ...await inputSnapshot() };
  let requests = 0;
  const client = { async send(command: { input: { IfNoneMatch?: string } }) {
    requests++; assert.equal(command.input.IfNoneMatch, '*');
    const manifest = JSON.parse(await readFile(join(directory, 'run/manifest.json'), 'utf8'));
    assert.equal(manifest.resources[0].created, false); throw new Error('synthetic-conflict-canary');
  } } as unknown as import('@aws-sdk/client-s3').S3Client;
  await assert.rejects(registerArtifact(client, 'e2e-create-only-artifacts', snapshot, evidence)); assert.equal(requests, 1);
  await assert.rejects(registerArtifact(client, 'e2e-create-only-artifacts', { ...snapshot, inputDigest: '0'.repeat(64) }, evidence), /ARTIFACT_REJECTED/); assert.equal(requests, 1);
  assert.doesNotMatch(await readFile(join(directory, 'run/manifest.json'), 'utf8'), /synthetic-conflict-canary/);
});

void test('discovery preserves its literal private issuer and exact owned OAuth and JWKS URLs', async () => {
  const source = await import('../../../scripts/e2e/terraform-source.ts');
  assert.equal(typeof source.discoveredCognitoIdentity, 'function');
  const target = { endpoint: 'http://floci:4566' as const, region: 'ap-northeast-1' as const, addresses: new Map([['floci', '172.18.0.2']]) };
  const origin = 'http://172.18.0.2:4566'; const pool = 'ap-northeast-1_Synthetic1';
  const document = { issuer: `${origin}/${pool}`, jwks_uri: `${origin}/${pool}/.well-known/jwks.json`, authorization_endpoint: `${origin}/cognito-idp/oauth2/authorize`, token_endpoint: `${origin}/cognito-idp/oauth2/token` };
  const identity = source.discoveredCognitoIdentity(target, pool, document);
  assert.equal(identity.issuer, document.issuer); assert.equal(identity.authBase, `${origin}/cognito-idp`); assert.equal(identity.target.addresses.get('172.18.0.2'), '172.18.0.2');
  for (const bad of [{ ...document, issuer: document.issuer.replace('172.18.0.2', '8.8.8.8') }, { ...document, jwks_uri: document.jwks_uri + '?canary=1' }, { ...document, token_endpoint: 'http://foreign.example:4566/cognito-idp/oauth2/token' }, { ...document, authorization_endpoint: document.authorization_endpoint.replace('4566', '9999') }]) assert.throws(() => source.discoveredCognitoIdentity(target, pool, bad), /DISCOVERY_REJECTED/);
});

void test('a preexisting foreign state directory is rejected with zero Terraform spawns', async t => {
  const driver = await import('../../../scripts/e2e/terraform.ts');
  const { inputSnapshot } = await import('../../../scripts/e2e/prepare-artifact.ts');
  const { createHash } = await import('node:crypto'); const { mkdir, writeFile } = await import('node:fs/promises');
  const directory = await mkdtemp(join(tmpdir(), 'tf-foreign-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const evidence = await store.createEvidence([definitions[0]!], join(directory, 'run'));
  await mkdir(join(directory, 'run/terraform')); await writeFile(join(directory, 'run/terraform/foreign.tfstate'), 'private-state-canary');
  const bytes = Buffer.from('synthetic input'); const zipPath = join(directory, 'zip'); await writeFile(zipPath, bytes); const hash = createHash('sha256').update(bytes).digest();
  const artifact = { zipPath, compressedBytes: bytes.length, sha256Hex: hash.toString('hex'), sha256Base64: hash.toString('base64'), ...await inputSnapshot() };
  let requests = 0; let spawns = 0;
  t.mock.method(http, 'request', (_url: URL, _options: unknown, callback: (response: http.IncomingMessage) => void) => {
    const response = Readable.from([Buffer.from(requests++ === 0 ? '<Account>000000000000</Account>' : '<ListOpenIDConnectProvidersResponse/>')]) as http.IncomingMessage; response.statusCode = 200; response.rawHeaders = [];
    const outgoing = new PassThrough(); process.nextTick(() => callback(response)); return outgoing;
  });
  t.mock.method(childProcess, 'spawn', () => { spawns++; throw new Error('SPAWN_CANARY'); });
  let failure: InstanceType<typeof driver.ProvisioningFailure> | undefined;
  try { await driver.provisionStack({ endpoint: 'http://floci:4566', region: 'ap-northeast-1', addresses: new Map([['floci', '172.18.0.2']]) }, { publication: false }, artifact, evidence); } catch (error) { if (error instanceof driver.ProvisioningFailure) failure = error; else throw error; }
  assert.ok(failure); assert.equal(spawns, 0);
  await store.finalizeResults(evidence); const cleanup = await failure.ownedStack.destroy(); assert.equal(cleanup.errors, 0);
  assert.equal(await readFile(join(directory, 'run/terraform/foreign.tfstate'), 'utf8'), 'private-state-canary');
  assert.doesNotMatch(await readFile(join(directory, 'run/manifest.json'), 'utf8'), /private-state-canary|SPAWN_CANARY/);
});

void test('static intent retains every known instance ID across empty snapshots and removes only after result finalization', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tf-known-ids-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const evidence = await store.createEvidence([definitions[0]!], join(directory, 'run'));
  const id = `${evidence.runId}/bootstrap/aws_iam_role.runtime`;
  await store.reserveResource(evidence, { kind: 'terraform-address', name: 'bootstrap/aws_iam_role.runtime', id });
  await store.bindResourceIdentities(evidence, id, [{ type: 'aws_iam_role', identity: 'e2e-deadbeef-production-api', extra: 'INSTANCE_CANARY' } as never]);
  await store.bindResourceIdentities(evidence, id, []);
  await store.recordProcess(evidence, { tool: 'terraform', status: 'failed', exitCode: 1, durationMs: 1, timeoutMs: 10, expectedOutputMatched: false, blockedEndpointCounts: { 'aws-sts': 3, CANARY: 999 } });
  let saved = JSON.parse(await readFile(join(directory, 'run/manifest.json'), 'utf8'));
  assert.equal(saved.resources[0].created, true); assert.equal(saved.resources[0].identities.length, 1);
  assert.deepEqual(saved.processes[0].blockedEndpointCounts, { 'aws-sts': 3 }); assert.doesNotMatch(JSON.stringify(saved), /CANARY/);
  await assert.rejects(store.markResource(evidence, id, 'removed'));
  await store.finalizeResults(evidence); await store.markResource(evidence, id, 'removed');
  saved = JSON.parse(await readFile(join(directory, 'run/manifest.json'), 'utf8')); assert.equal(saved.resources[0].removed, true); assert.equal(saved.resources[0].identities.length, 1);
});

void test('protection release failure still destroys owned roots in reverse order and verifies actual absence', async t => {
  const driver = await import('../../../scripts/e2e/terraform.ts'); const { inputSnapshot } = await import('../../../scripts/e2e/prepare-artifact.ts');
  const { createHash } = await import('node:crypto'); const { writeFile } = await import('node:fs/promises'); const { writeFileSync } = await import('node:fs');
  const directory = await mkdtemp(join(tmpdir(), 'tf-unlock-fail-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const evidence = await store.createEvidence([definitions[0]!], join(directory, 'run')); const prefix = `e2e-${evidence.runId.slice(4, 12)}`;
  t.after(async () => { const lock = join(process.cwd(), '.superpowers/locks/123456789013.lock'); try { if (await readFile(lock, 'utf8') === evidence.runId) await unlink(lock); } catch { /* no lock */ } });
  const bytes = Buffer.from('synthetic cleanup input'); const zipPath = join(directory, 'zip'); await writeFile(zipPath, bytes); const hash = createHash('sha256').update(bytes).digest();
  const artifact = { zipPath, compressedBytes: bytes.length, sha256Hex: hash.toString('hex'), sha256Base64: hash.toString('base64'), ...await inputSnapshot() };
  let requests = 0; let protectionFailures = 0;
  t.mock.method(http, 'request', (_url: URL, options: http.RequestOptions, callback: (response: http.IncomingMessage) => void) => {
    const action = (options.headers as Record<string, string>)['x-amz-target'];
    let status = 200; let body = requests++ === 0 ? '<Account>123456789013</Account>' : '<ListOpenIDConnectProvidersResponse/>';
    if (action?.endsWith('.UpdateTable')) { status = 500; body = '{"__type":"SyntheticFailure"}'; protectionFailures++; }
    if (action?.endsWith('.DescribeTable')) { status = 400; body = '{"__type":"ResourceNotFoundException"}'; }
    const response = Readable.from([Buffer.from(body)]) as http.IncomingMessage; response.statusCode = status; response.rawHeaders = [];
    const outgoing = new PassThrough(); process.nextTick(() => callback(response)); return outgoing;
  });
  const destroyed: string[] = [];
  t.mock.method(childProcess, 'spawn', (_tool: string, args: string[], options: { cwd: string }) => {
    const root = options.cwd.split('/').at(-1)!;
    if (args[0] === 'apply') writeFileSync(join(options.cwd, 'owned.tfstate'), JSON.stringify(root === 'bootstrap' ? { outputs: { api_role_arn: { value: `arn:aws:iam::123456789013:role/${prefix}-production-api` }, cleanup_role_arn: { value: `arn:aws:iam::123456789013:role/${prefix}-production-cleanup` } } } : { resources: [{ mode: 'managed', type: 'aws_dynamodb_table', name: 'runtime', instances: [{ attributes: { name: `${prefix}-production-reminders` } }] }] }));
    if (args[0] === 'destroy') { destroyed.push(root); writeFileSync(join(options.cwd, 'owned.tfstate'), '{}'); }
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill() {} }); process.nextTick(() => child.emit('close', args[0] === 'apply' && root === 'platform' ? 1 : 0)); return child;
  });
  let failure: InstanceType<typeof driver.ProvisioningFailure> | undefined;
  try { await driver.provisionStack({ endpoint: 'http://floci:4566', region: 'ap-northeast-1', addresses: new Map([['floci', '172.18.0.2']]) }, { publication: false }, artifact, evidence); } catch (error) { if (error instanceof driver.ProvisioningFailure) failure = error; else throw error; }
  assert.ok(failure); assert.equal(failure.phase, 'platform-apply'); await store.finalizeResults(evidence);
  const cleanup = await failure.ownedStack.destroy(); assert.deepEqual(destroyed, ['platform', 'bootstrap']); assert.equal(protectionFailures, 1); assert.equal(cleanup.errors, 1); assert.equal(cleanup.leaks, 0);
  const absence = JSON.parse(await readFile(join(directory, 'run/independent-absence.json'), 'utf8')); assert.deepEqual(absence, { checked: 1, absent: 1, exists: 0, unverified: 0 });
  const manifest = JSON.parse(await readFile(join(directory, 'run/manifest.json'), 'utf8')); const intent = manifest.resources.find((item: { name: string }) => item.name === 'platform/aws_dynamodb_table.runtime'); assert.equal(intent.created, true); assert.equal(intent.removed, true); assert.equal(intent.identities.length, 1);
});

void test('blocked endpoint evidence keeps exact counts with a bounded detail array', async () => {
  const { withTerraformTransport } = await import('../../../scripts/e2e/terraform-transport.ts');
  const result = await withTerraformTransport({ endpoint: 'http://floci:4566', region: 'ap-northeast-1', addresses: new Map([['floci', '172.18.0.2']]) }, async proxy => {
    const url = new URL(proxy); const authentication = 'Basic ' + Buffer.from(`${url.username}:${url.password}`).toString('base64'); url.username = ''; url.password = '';
    for (let index = 0; index < 140; index++) await new Promise<void>(resolve => {
      const request = http.request(url, { path: 'http://sts.amazonaws.com/', headers: { host: 'sts.amazonaws.com', 'proxy-authorization': authentication } }, response => { assert.equal(response.statusCode, 403); response.resume(); response.on('end', resolve); }); request.end();
    });
  });
  assert.equal(result.forwarded, 0); assert.equal(result.denied.length, 128); assert.deepEqual(result.blockedEndpointCounts, { 'aws-sts': 140 });
});

void test('abort terminates the child process group and retains bounded safe evidence', async () => {
  const { runChild } = await import('../../../scripts/e2e/run.ts'); const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 50);
  try {
    const result = await runChild('node', ['-e', 'setInterval(() => {}, 1000)'], { cwd: process.cwd(), timeoutMs: 3_000, signal: controller.signal });
    assert.equal(result.status, 'timeout'); assert.ok(result.durationMs < 3_000); assert.equal(result.timeoutMs, 3_000);
    assert.deepEqual(Object.keys(result).sort(), ['durationMs', 'exitCode', 'expectedOutputMatched', 'status', 'timeoutMs', 'tool']);
  } finally { clearTimeout(timer); }
});

void test('durable identity projection accepts owned AWS log group slash IDs and rejects unsafe data', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tf-log-identity-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const evidence = await store.createEvidence([definitions[0]!], join(directory, 'run')); const id = `${evidence.runId}/platform/aws_cloudwatch_log_group.gateway`;
  await store.reserveResource(evidence, { kind: 'terraform-address', name: 'platform/aws_cloudwatch_log_group.gateway', id });
  await store.bindResourceIdentities(evidence, id, [{ type: 'aws_cloudwatch_log_group', identity: '/aws/apigateway/e2e-deadbeef-production-api' }]);
  const stage = `${evidence.runId}/application/aws_apigatewayv2_stage.production`;
  await store.reserveResource(evidence, { kind: 'terraform-address', name: 'application/aws_apigatewayv2_stage.production', id: stage });
  await store.bindResourceIdentities(evidence, stage, [{ type: 'aws_apigatewayv2_stage', identity: '$default', parent: 'abcdefghij' }]);
  await assert.rejects(store.bindResourceIdentities(evidence, id, [{ type: 'aws_cloudwatch_log_group', identity: '/aws/apigateway/\nSECRET_CANARY' }]));
  const saved = JSON.parse(await readFile(join(directory, 'run/manifest.json'), 'utf8')); assert.equal(saved.resources[0].created, true); assert.equal(saved.resources[0].identities[0].identity, '/aws/apigateway/e2e-deadbeef-production-api'); assert.doesNotMatch(JSON.stringify(saved), /SECRET_CANARY/);
});

void test('resource ID ownership rules reject unknown kinds, foreign accounts, composite stage IDs and secret values', async () => {
  const driver = await import('../../../scripts/e2e/terraform.ts'); const owner = { prefix: 'e2e-deadbeef', account: '123456789012' };
  const state = (type: string, bucket: string) => ({ resources: [{ mode: 'managed', type, name: 'images', instances: [{ attributes: { bucket } }] }] });
  assert.throws(() => driver.captureOwnedResources(state('aws_s3_bucket_unknown', 'e2e-deadbeef-123456789012-ap-northeast-1-images'), owner), /FOREIGN_STATE_REJECTED/);
  assert.throws(() => driver.captureOwnedResources(state('aws_s3_bucket', 'e2e-deadbeef-999999999999-ap-northeast-1-images'), owner), /FOREIGN_STATE_REJECTED/);
  for (const resource of [
    { type: 'aws_iam_policy', identity: 'arn:aws:iam::999999999999:policy/e2e-deadbeef-production-api-ceiling' },
    { type: 'aws_iam_role', identity: 'e2e-foreign-production-api' },
    { type: 'aws_apigatewayv2_stage', identity: 'abcdefghij/$default', parent: 'abcdefghij' },
    { type: 'aws_lambda_alias', identity: 'production', parent: 'foreign-function' },
    { type: 'aws_cloudwatch_log_group', identity: '/aws/lambda/SECRET_CANARY' },
    { type: 'aws_cognito_user_pool_client', identity: 'SECRET_CANARY', parent: 'ap-northeast-1_Synthetic1' },
  ]) assert.throws(() => driver.assertOwnedIdentity(resource, owner), /FOREIGN_STATE_REJECTED/);
  driver.assertOwnedIdentity({ type: 'aws_apigatewayv2_stage', identity: '$default', parent: 'abcdefghij' }, owner);
});
