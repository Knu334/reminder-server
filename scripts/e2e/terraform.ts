import { withTerraformTransport } from './terraform-transport.ts';
export { withTerraformTransport } from './terraform-transport.ts';
import { mkdir, readFile, writeFile, unlink, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import type { HttpHandlerOptions } from '@smithy/types';
import { S3Client, ListObjectVersionsCommand, DeleteObjectsCommand, DeleteBucketPolicyCommand, HeadBucketCommand } from '@aws-sdk/client-s3';
import { isDeepStrictEqual } from 'node:util';
import type { ArtifactSnapshot, CleanupSummary, Evidence, FixtureOptions, LocalTarget, PreparedTerraformRoots, ProvisionedStack, RequiredReadApi, RestoredState, RestoredTarget } from '../../tests/e2e/floci/support/types.ts';
import { assertRestoredTarget, TABLE_KEYS, type RestoredContext } from '../../tests/e2e/floci/support/restored-tables.ts';
import { localRequest } from '../../tests/e2e/floci/support/transport.ts';
import { evidenceContext, markResource, reserveResource, recordProcess, bindResourceIdentities, measureRequiredApiUnsupported, MeasuredRequiredApiUnsupported } from '../../tests/e2e/floci/support/evidence.ts';
import { registerArtifact, verifyArtifactSnapshot } from '../../tests/e2e/floci/support/artifact.ts';
import { assertLocalTarget, assertRegular, bindCognitoIdentity, discoveredCognitoIdentity, cleanupOverrides, ownsRoot, prepareProductionRoots, productionResourceAddresses, verifyProductionRoots, writeProductionInputs, type RootName } from './terraform-source.ts';
import { RunBudget, runChild } from './run.ts';

const repository = resolve(__dirname, '../..');
const toolRoot = join(repository, '.superpowers/tools/aws-sdd');
export async function acquireAccountLock(directory: string, account: string, owner: string): Promise<() => Promise<void>> {
  if (!/^\d{12}$/.test(account) || !/^e2e-[a-z0-9-]+$/.test(owner)) throw new Error('ACCOUNT_LOCK_REJECTED');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${account}.lock`);
  await writeFile(path, owner, { mode: 0o600, flag: 'wx' });
  return async () => { await assertRegular(path); if (await readFile(path, 'utf8') !== owner) throw new Error('ACCOUNT_LOCK_REJECTED'); await unlink(path); };
}
function authorization(service: string): string { return `AWS4-HMAC-SHA256 Credential=local/20261008/ap-northeast-1/${service}/aws4_request, SignedHeaders=host, Signature=${'0'.repeat(64)}`; }
async function query(target: LocalTarget, service: string, action: string, version: string, input: Record<string, string> = {}): Promise<string> {
  const result = await localRequest(target, new URL(target.endpoint), { method: 'POST', headers: { authorization: authorization(service), 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ Action: action, Version: version, ...input }).toString() });
  if (result.status !== 200) throw new Error(`LOCAL_API_${action}_FAILED`);
  return result.bytes.toString('utf8');
}
export async function checkAccountAndOidc(target: LocalTarget): Promise<string> {
  assertLocalTarget(target);
  const identity = await query(target, 'sts', 'GetCallerIdentity', '2011-06-15');
  const account = /<Account>(\d{12})<\/Account>/.exec(identity)?.[1];
  if (!account || !/^\d{12}$/.test(account)) throw new Error('ACCOUNT_REJECTED');
  return account;
}
export async function assertOidcAbsent(target: LocalTarget): Promise<void> {
  const providers = await query(target, 'iam', 'ListOpenIDConnectProviders', '2010-05-08');
  if (!providers.includes('ListOpenIDConnectProvidersResponse') || /oidc-provider\/token.actions.githubusercontent.com/.test(providers)) throw new Error('OIDC_OWNERSHIP_REJECTED');
}
export function localS3(target: LocalTarget): S3Client {
  assertLocalTarget(target);
  return new S3Client({ endpoint: target.endpoint, region: target.region, credentials: { accessKeyId: 'local', secretAccessKey: 'local' }, forcePathStyle: true, maxAttempts: 1,
    requestHandler: { async handle(request: { protocol: string; hostname: string; port?: number; path: string; query?: Record<string, string | string[] | null>; method: string; headers: Record<string, string>; body?: unknown }, options: HttpHandlerOptions = {}) {
      if (options.abortSignal && !('addEventListener' in options.abortSignal)) throw new Error('LOCAL_SIGNAL_REJECTED');
      const url = new URL(`${request.protocol}//${request.hostname}:${request.port ?? 4566}${request.path}`);
      for (const [key, value] of Object.entries(request.query ?? {})) for (const item of Array.isArray(value) ? value : [value ?? '']) url.searchParams.append(key, item);
      const headers = Object.fromEntries(Object.entries(request.headers).filter(([key]) => key.toLowerCase() !== 'host'));
      if (request.body !== undefined && typeof request.body !== 'string' && !Buffer.isBuffer(request.body) && !(request.body instanceof Uint8Array)) throw new Error('LOCAL_BODY_REJECTED');
      const body = request.body instanceof Uint8Array ? Buffer.from(request.body.buffer, request.body.byteOffset, request.body.byteLength) : request.body as string | Buffer | undefined;
      const response = await localRequest(target, url, { method: request.method, headers, ...(body !== undefined ? { body } : {}), ...(options.abortSignal ? { signal: options.abortSignal as AbortSignal } : {}), ...(options.requestTimeout !== undefined ? { timeoutMs: options.requestTimeout } : {}) });
      return { response: { statusCode: response.status, headers: Object.fromEntries(response.headers), body: Readable.from([response.bytes]) } };
    } },
  });
}
type Resource = { mode: string; type: string; name: string; instances: { attributes: Record<string, unknown> }[] };
type OwnedState = { resources?: Resource[]; outputs?: Record<string, { value: unknown }> };
const restoredRejected = (): Error => new Error('RESTORED_TABLES_REJECTED');
/**
 * The restored_tables switch as a small state machine. The state turns inconsistent BEFORE the first root is touched and only a complete
 * switch (or a complete return to {}) read back on all three roots moves it to restored (or original). While it is not original no API
 * input may be sent; a second switch is refused until the roots are back at {}; a failed return stays inconsistent and can be retried.
 */
export function createRestoreController(options: { context: RestoredContext; applyRoots(map: Record<string, string>): Promise<void> }): { set(target: RestoredTarget | null): Promise<void>; state(): RestoredState } {
  let state: RestoredState = 'original'; let busy = false;
  return {
    state: () => state,
    async set(target) {
      if (busy) throw restoredRejected();
      if (target !== null) { assertRestoredTarget(target, options.context); if (state !== 'original') throw restoredRejected(); }
      busy = true; state = 'inconsistent';
      try { await options.applyRoots(target === null ? {} : { ...target.tableNames }); state = target === null ? 'original' : 'restored'; }
      finally { busy = false; }
    },
  };
}
/** Read-back of one root's state against the expected map: the roles' table selection must be the restored set, or the originals with no trace of any restored name. */
export function assertRestoredState(root: RootName, state: OwnedState, map: Record<string, string>, owner: RestoredContext): void {
  const original: Record<string, string> = { reminders: `${owner.prefix}-production-reminders`, owner_state: `${owner.prefix}-production-owner-state`, image_jobs: `${owner.prefix}-production-image-jobs` };
  const switched = Object.keys(map).length > 0; const names = switched ? map : original;
  const arn = (name: string): string => `arn:aws:dynamodb:${owner.region}:${owner.account}:table/${name}`;
  const check = (condition: boolean): void => { if (!condition) throw restoredRejected(); };
  const attributes = (mode: string, type: string) => (state.resources ?? []).filter(resource => resource.mode === mode && resource.type === type).flatMap(resource => resource.instances.map(instance => instance.attributes));
  if (root !== 'application') {
    const policies = [...attributes('managed', 'aws_iam_policy'), ...attributes('managed', 'aws_iam_role_policy')].map(item => typeof item.policy === 'string' ? item.policy : '').join('\n');
    check(policies.length > 0);
    for (const key of TABLE_KEYS) check(policies.includes(arn(names[key]!)));
    if (!switched) check(!policies.includes(`table/${owner.prefix}-rst`));
  }
  if (root === 'platform') {
    const outputs = state.outputs ?? {};
    for (const key of TABLE_KEYS) check(outputs[`${key}_table`]?.value === names[key] && outputs[`${key}_table_arn`]?.value === arn(names[key]!));
    check(isDeepStrictEqual(outputs.restored_tables?.value, map));
    const described = attributes('data', 'aws_dynamodb_table');
    check(switched ? described.length === 3 && TABLE_KEYS.every(key => described.some(item => item.name === names[key] && item.arn === arn(names[key]!))) : described.length === 0);
  }
  if (root === 'application') {
    const data = state.outputs?.runtime_data?.value as { restored_tables?: unknown; reminders_table?: unknown; owner_state_table?: unknown; image_jobs_table?: unknown } | undefined;
    check(!!data && isDeepStrictEqual(data.restored_tables, map) && data.reminders_table === names.reminders && data.owner_state_table === names.owner_state && data.image_jobs_table === names.image_jobs);
    const functions = attributes('managed', 'aws_lambda_function'); check(functions.length === 2);
    for (const fn of functions) { const environment = (fn.environment as { variables?: Record<string, string> }[] | undefined)?.[0]?.variables; check(environment?.REMINDERS_TABLE === names.reminders && environment?.OWNER_STATE_TABLE === names.owner_state && environment?.IMAGE_JOBS_TABLE === names.image_jobs); }
  }
}
export async function setRestoredTables(stack: ProvisionedStack, target: RestoredTarget | null): Promise<void> { await stack.setRestoredTables(target); }
export type OwnedResource = { type: string; identity: string; parent?: string; address?: string };
export function assertOwnedIdentity(resource: OwnedResource, owner: { prefix: string; account: string }): void {
  const { type, identity, parent } = resource; const { prefix, account } = owner;
  const role = (name: string) => `${prefix}-${name}`;
  const roles = ['github-artifact', 'github-plan', 'github-apply', 'production-api', 'production-cleanup', 'production-scheduler'].map(role);
  const functions = ['production-api', 'production-cleanup'].map(role);
  const pool = (value: string | undefined) => typeof value === 'string' && /^ap-northeast-1_[A-Za-z0-9]+$/.test(value);
  const api = (value: string | undefined) => typeof value === 'string' && /^[a-z0-9]{10}$/.test(value);
  const policies = ['github-production-read', 'production-api-ceiling', 'production-cleanup-ceiling', 'production-scheduler-ceiling'].map(name => `arn:aws:iam::${account}:policy/${role(name)}`);
  const buckets = ['state', 'artifacts', 'images'].map(name => `${prefix}-${account}-ap-northeast-1-${name}`);
  const bucketTypes = ['aws_s3_bucket', 'aws_s3_bucket_versioning', 'aws_s3_bucket_policy', 'aws_s3_bucket_public_access_block', 'aws_s3_bucket_server_side_encryption_configuration', 'aws_s3_bucket_lifecycle_configuration', 'aws_s3_bucket_cors_configuration'];
  let valid = false;
  if (bucketTypes.includes(type)) valid = buckets.includes(identity) && parent === undefined;
  else if (type === 'aws_iam_openid_connect_provider') valid = identity === `arn:aws:iam::${account}:oidc-provider/token.actions.githubusercontent.com` && parent === undefined;
  else if (type === 'aws_iam_policy') valid = policies.includes(identity) && parent === undefined;
  else if (type === 'aws_iam_role') valid = roles.includes(identity) && parent === undefined;
  else if (type === 'aws_iam_role_policy') valid = roles.includes(parent!) && ['production-artifact', 'production-plan', 'production-apply', ...['production-api-runtime', 'production-cleanup-runtime', 'production-cleanup-invoke'].map(role)].includes(identity);
  else if (type === 'aws_iam_role_policy_attachment') valid = ['github-plan', 'github-apply'].map(role).includes(parent!) && identity === policies[0];
  else if (type === 'aws_dynamodb_table') valid = ['production-reminders', 'production-owner-state', 'production-image-jobs'].map(role).includes(identity) && parent === undefined;
  else if (type === 'aws_cloudwatch_log_group') valid = [`/aws/lambda/${role('production-api')}`, `/aws/lambda/${role('production-cleanup')}`, `/aws/apigateway/${role('production-api')}`].includes(identity) && parent === undefined;
  else if (type === 'aws_cognito_user_pool') valid = pool(identity) && parent === undefined;
  else if (type === 'aws_cognito_user_pool_client') valid = /^[A-Za-z0-9]{1,128}$/.test(identity) && pool(parent);
  else if (type === 'aws_cognito_resource_server') valid = identity === 'reminder-api' && pool(parent);
  else if (type === 'aws_cognito_user_pool_domain') valid = identity === prefix && pool(parent);
  else if (type === 'aws_apigatewayv2_api') valid = api(identity) && parent === undefined;
  else if (['aws_apigatewayv2_authorizer', 'aws_apigatewayv2_integration', 'aws_apigatewayv2_route'].includes(type)) valid = /^[a-z0-9]{8}$/.test(identity) && api(parent);
  else if (type === 'aws_apigatewayv2_stage') valid = identity === '$default' && api(parent);
  else if (type === 'aws_lambda_function') valid = functions.includes(identity) && parent === undefined;
  else if (['aws_lambda_alias', 'aws_lambda_function_event_invoke_config'].includes(type)) valid = identity === 'production' && functions.includes(parent!);
  else if (type === 'aws_lambda_permission') valid = identity === 'ProductionGatewayOnly' && parent === role('production-api');
  else if (type === 'aws_scheduler_schedule_group') valid = identity === role('production-cleanup') && parent === undefined;
  else if (type === 'aws_scheduler_schedule') valid = identity === role('production-cleanup') && parent === identity;
  else if (type === 'aws_cloudwatch_metric_alarm') valid = ['gateway-5xx', 'api-errors', 'api-throttles', 'api-duration', 'cleanup-errors', 'cleanup-async-dropped', 'cleanup-incomplete', 'scheduler-dropped', 'cleanup-heartbeat'].map(name => role(`production-${name}`)).includes(identity) && parent === undefined;
  if (!/^e2e-[a-f0-9]{8}$/.test(prefix) || !/^\d{12}$/.test(account) || !valid) throw new Error('FOREIGN_STATE_REJECTED');
}
/** Project only deletion identities, never state payloads, environment, policies or data. */
export function captureOwnedResources(state: OwnedState, owner: { prefix: string; account: string }): OwnedResource[] {
  const result: OwnedResource[] = [];
  const managed = (state.resources ?? []).filter(resource => resource.mode === 'managed');
  const text = (value: unknown): string => { if (typeof value !== 'string' || !value || value.length > 2048) throw new Error('FOREIGN_STATE_REJECTED'); return value; };
  const named = (value: unknown): string => { const name = text(value); if (!name.startsWith(owner.prefix + '-') && !name.startsWith('/aws/lambda/' + owner.prefix + '-') && !name.startsWith('/aws/apigateway/' + owner.prefix + '-')) throw new Error('FOREIGN_STATE_REJECTED'); return name; };
  const pools = new Set(managed.filter(r => r.type === 'aws_cognito_user_pool').flatMap(r => r.instances.map(i => { named(i.attributes.name); return text(i.attributes.id); })));
  const apis = new Set(managed.filter(r => r.type === 'aws_apigatewayv2_api').flatMap(r => r.instances.map(i => { named(i.attributes.name); return text(i.attributes.id); })));
  for (const resource of managed) for (const instance of resource.instances) {
    const a = instance.attributes; const type = resource.type; let item: OwnedResource;
    if (type.startsWith('aws_s3_bucket')) item = { type, identity: named(a.bucket) };
    else if (type === 'aws_iam_openid_connect_provider') {
      const arn = text(a.arn ?? a.id); if (arn !== `arn:aws:iam::${owner.account}:oidc-provider/token.actions.githubusercontent.com`) throw new Error('FOREIGN_STATE_REJECTED'); item = { type, identity: arn };
    } else if (type === 'aws_iam_policy') {
      const arn = text(a.arn); if (!arn.startsWith(`arn:aws:iam::${owner.account}:policy/${owner.prefix}-`)) throw new Error('FOREIGN_STATE_REJECTED'); item = { type, identity: arn };
    } else if (type === 'aws_iam_role') item = { type, identity: named(a.name) };
    else if (type === 'aws_iam_role_policy') item = { type, identity: text(a.name), parent: named(a.role) };
    else if (type === 'aws_iam_role_policy_attachment') {
      const arn = text(a.policy_arn); if (!arn.startsWith(`arn:aws:iam::${owner.account}:policy/${owner.prefix}-`)) throw new Error('FOREIGN_STATE_REJECTED'); item = { type, identity: arn, parent: named(a.role) };
    } else if (type === 'aws_dynamodb_table' || type === 'aws_cloudwatch_log_group') item = { type, identity: named(a.name) };
    else if (type === 'aws_cognito_user_pool') { named(a.name); item = { type, identity: text(a.id) }; }
    else if (type.startsWith('aws_cognito_')) {
      const pool = text(a.user_pool_id); if (!pools.has(pool)) throw new Error('FOREIGN_STATE_REJECTED');
      item = { type, identity: text(type === 'aws_cognito_resource_server' ? a.identifier : type === 'aws_cognito_user_pool_client' ? a.id : a.domain), parent: pool };
    } else if (type === 'aws_apigatewayv2_api') { named(a.name); item = { type, identity: text(a.id) }; }
    else if (type.startsWith('aws_apigatewayv2_')) {
      const api = text(a.api_id); if (!apis.has(api)) throw new Error('FOREIGN_STATE_REJECTED'); item = { type, identity: text(type === 'aws_apigatewayv2_stage' ? a.name : a.id), parent: api };
    } else if (type === 'aws_lambda_function') item = { type, identity: named(a.function_name) };
    else if (type.startsWith('aws_lambda_')) item = { type, identity: text(type === 'aws_lambda_alias' ? a.name : type === 'aws_lambda_permission' ? a.statement_id : a.qualifier), parent: named(a.function_name) };
    else if (type === 'aws_scheduler_schedule_group') item = { type, identity: named(a.name) };
    else if (type === 'aws_scheduler_schedule') item = { type, identity: named(a.name), parent: named(a.group_name) };
    else if (type === 'aws_cloudwatch_metric_alarm') item = { type, identity: named(a.alarm_name) };
    else throw new Error('FOREIGN_STATE_REJECTED');
    assertOwnedIdentity(item, owner);
    result.push({ ...item, address: `${type}.${resource.name}` });
  }
  return result;
}
export async function probeOwnedResource(target: LocalTarget, resource: OwnedResource): Promise<'exists' | 'absent' | 'unverified'> {
  assertLocalTarget(target);
  try {
    const { type, identity, parent } = resource;
    let service: string; let action: string; let version = ''; let payload: Record<string, string> = {}; let path: string | undefined;
    if (type.startsWith('aws_s3_bucket')) {
      const client = localS3(target); try { await client.send(new HeadBucketCommand({ Bucket: identity })); return 'exists'; }
      catch (error) { return (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404 ? 'absent' : 'unverified'; } finally { client.destroy(); }
    }
    if (type.startsWith('aws_iam_')) {
      service = 'iam'; version = '2010-05-08';
      const commands: Record<string, [string, Record<string, string>]> = {
        aws_iam_openid_connect_provider: ['GetOpenIDConnectProvider', { OpenIDConnectProviderArn: identity }], aws_iam_policy: ['GetPolicy', { PolicyArn: identity }], aws_iam_role: ['GetRole', { RoleName: identity }],
        aws_iam_role_policy: ['GetRolePolicy', { RoleName: parent!, PolicyName: identity }], aws_iam_role_policy_attachment: ['ListAttachedRolePolicies', { RoleName: parent! }],
      };
      const command = commands[type]; if (!command) return 'unverified'; [action, payload] = command;
    } else if (type === 'aws_dynamodb_table') { service = 'dynamodb'; action = 'DynamoDB_20120810.DescribeTable'; payload = { TableName: identity }; }
    else if (type === 'aws_cloudwatch_log_group') { service = 'logs'; action = 'Logs_20140328.DescribeLogGroups'; payload = { logGroupNamePrefix: identity }; }
    else if (type.startsWith('aws_cognito_')) {
      service = 'cognito-idp';
      const commands: Record<string, [string, Record<string, string>]> = {
        aws_cognito_user_pool: ['DescribeUserPool', { UserPoolId: identity }], aws_cognito_user_pool_client: ['DescribeUserPoolClient', { UserPoolId: parent!, ClientId: identity }],
        aws_cognito_resource_server: ['DescribeResourceServer', { UserPoolId: parent!, Identifier: identity }], aws_cognito_user_pool_domain: ['DescribeUserPoolDomain', { Domain: identity }],
      }; const command = commands[type]; if (!command) return 'unverified'; [action, payload] = command; action = 'AWSCognitoIdentityProviderService.' + action;
    } else if (type.startsWith('aws_apigatewayv2_')) {
      service = 'apigateway'; action = 'GetApi';
      const collection: Record<string, string> = { aws_apigatewayv2_authorizer: 'authorizers', aws_apigatewayv2_integration: 'integrations', aws_apigatewayv2_route: 'routes', aws_apigatewayv2_stage: 'stages' };
      path = type === 'aws_apigatewayv2_api' ? `/v2/apis/${encodeURIComponent(identity)}` : `/v2/apis/${encodeURIComponent(parent!)}/${collection[type]}/${encodeURIComponent(identity)}`;
    } else if (type.startsWith('aws_lambda_')) {
      service = 'lambda'; action = 'GetFunction';
      path = type === 'aws_lambda_function' ? `/2015-03-31/functions/${encodeURIComponent(identity)}` : type === 'aws_lambda_alias' ? `/2015-03-31/functions/${encodeURIComponent(parent!)}/aliases/${encodeURIComponent(identity)}` : type === 'aws_lambda_permission' ? `/2015-03-31/functions/${encodeURIComponent(parent!)}/policy` : `/2019-09-25/functions/${encodeURIComponent(parent!)}/event-invoke-config?Qualifier=${encodeURIComponent(identity)}`;
    } else if (type.startsWith('aws_scheduler_')) { service = 'scheduler'; action = 'GetSchedule'; path = type === 'aws_scheduler_schedule_group' ? `/schedule-groups/${encodeURIComponent(identity)}` : `/schedules/${encodeURIComponent(identity)}?groupName=${encodeURIComponent(parent!)}`; }
    else if (type === 'aws_cloudwatch_metric_alarm') { service = 'monitoring'; action = 'DescribeAlarms'; version = '2010-08-01'; payload = { 'AlarmNames.member.1': identity }; }
    else return 'unverified';
    const response = await localRequest(target, new URL(path ?? target.endpoint, target.endpoint), {
      method: path ? 'GET' : 'POST', headers: { authorization: authorization(service), ...(!path ? version ? { 'content-type': 'application/x-www-form-urlencoded' } : { 'content-type': service === 'dynamodb' ? 'application/x-amz-json-1.0' : 'application/x-amz-json-1.1', 'x-amz-target': action } : {}) },
      ...(!path ? { body: version ? new URLSearchParams({ Action: action, Version: version, ...payload }).toString() : JSON.stringify(payload) } : {}),
    });
    const body = response.bytes.toString('utf8');
    if ([400, 404].includes(response.status) && /NoSuchEntity|ResourceNotFoundException|NotFoundException|ResourceNotFound/.test(body)) return 'absent';
    if (response.status !== 200) return 'unverified';
    if (type === 'aws_iam_role_policy_attachment') return body.includes(identity) ? 'exists' : /IsTruncated>true/.test(body) ? 'unverified' : 'absent';
    if (type === 'aws_cloudwatch_metric_alarm') return body.includes(`<AlarmName>${identity}</AlarmName>`) ? 'exists' : /NextToken>[^<]/.test(body) ? 'unverified' : 'absent';
    if (type === 'aws_cloudwatch_log_group') { const doc = JSON.parse(body) as { logGroups?: { logGroupName: string }[]; nextToken?: string }; return doc.logGroups?.some(group => group.logGroupName === identity) ? 'exists' : doc.nextToken || !Array.isArray(doc.logGroups) ? 'unverified' : 'absent'; }
    if (type === 'aws_cognito_user_pool_domain') { const doc = JSON.parse(body) as { DomainDescription?: { UserPoolId?: string } }; return doc.DomainDescription?.UserPoolId === parent ? 'exists' : doc.DomainDescription && !doc.DomainDescription.UserPoolId ? 'absent' : 'unverified'; }
    if (type === 'aws_lambda_permission') { const doc = JSON.parse(body) as { Policy?: string }; if (!doc.Policy) return 'unverified'; const policy = JSON.parse(doc.Policy) as { Statement?: { Sid: string }[] }; return policy.Statement?.some(statement => statement.Sid === identity) ? 'exists' : 'absent'; }
    return 'exists';
  } catch { return 'unverified'; }
}
export class ProvisioningFailure extends Error {
  constructor(readonly phase: string, readonly ownedStack: ProvisionedStack, readonly reason = 'terraform-construction-failed', readonly unsupported?: MeasuredRequiredApiUnsupported) { super('E2E_PROVISION_FAILED'); }
}
export async function provisionStack(target: LocalTarget, options: FixtureOptions, artifact: ArtifactSnapshot, evidence: Evidence): Promise<ProvisionedStack> {
  assertLocalTarget(target); await verifyArtifactSnapshot(artifact);
  const context = evidenceContext(evidence); if (context.finalized) throw new Error('RESULTS_FINALIZED');
  const budget = options.budget ?? new RunBudget(); const signal = options.signal;
  const account = await checkAccountAndOidc(target);
  const release = await acquireAccountLock(join(repository, '.superpowers/locks'), account, evidence.runId);
  let roots: PreparedTerraformRoots | undefined; let phase = 'ownership'; let disposed = false;
  const attempted = new Set<RootName>(); const initialized = new Set<RootName>();
  const stateDirectory = join(context.directory, 'terraform');
  const retained = new Map<RootName, OwnedResource[]>();
  let quiescence: (() => Promise<void>) | undefined;
  const bindings: Record<string, string> = {}; const prefix = `e2e-${evidence.runId.slice(4, 12)}`;
  const common = { account_id: account, region: target.region, name_prefix: prefix, restored_tables: {} };
  const role = (name: string) => `arn:aws:iam::${account}:role/${prefix}-production-${name}`;
  const bootstrap: Record<string, unknown> = { ...common, repository: 'synthetic/reminder-e2e', github_environment: 'production', oidc_subjects: { artifact: 'repo:synthetic/reminder-e2e:environment:production-artifact', plan: 'repo:synthetic/reminder-e2e:environment:production-plan', apply: 'repo:synthetic/reminder-e2e:environment:production' }, production_api_id: null };
  const platform: Record<string, unknown> = { ...common, chrome_origin: 'https://extension.example.test', callback_url: 'https://extension.example.test/callback', logout_url: 'https://extension.example.test/logout', cognito_domain_prefix: prefix, api_role_arn: role('api'), cleanup_role_arn: role('cleanup') };
  const inputs: Partial<Record<RootName, Record<string, unknown>>> = { bootstrap, platform };
  async function ownedState(root: RootName): Promise<OwnedState> {
    if (!roots || !ownsRoot(roots, roots[root]) || !attempted.has(root)) throw new Error('FOREIGN_STATE_REJECTED');
    const path = join(roots[root], 'owned.tfstate');
    try { await lstat(path); } catch { return {}; }
    await assertRegular(path);
    const state = JSON.parse(await readFile(path, 'utf8')) as OwnedState;
    const known = await productionResourceAddresses(roots, root, disposed);
    if (captureOwnedResources(state, { prefix, account }).some(resource => !known.includes(resource.address!))) throw new Error('FOREIGN_STATE_REJECTED');
    return state;
  }
  async function command(root: RootName, args: string[], cleanup = false): Promise<void> {
    if (!roots || !ownsRoot(roots, roots[root])) throw new Error('FOREIGN_ROOT_REJECTED');
    await verifyProductionRoots(roots, cleanup);
    await ownedState(root);
    const timeoutMs = cleanup ? Math.min(600_000, budget.cleanupRemaining()) : budget.allow('terraform');
    if (!timeoutMs || (!cleanup && signal?.aborted)) throw new Error('BUDGET_EXHAUSTED');
    const transport = await withTerraformTransport(target, terraformProxy => runChild('terraform', args, { cwd: roots![root], timeoutMs, terraformProxy, ...(!cleanup && signal ? { signal } : {}) }), { accountId: account, buckets: ['state', 'artifacts', 'images'].map(suffix => `${prefix}-${account}-${target.region}-${suffix}`) });
    await recordProcess(evidence, { ...transport.value, blockedEndpoints: transport.denied, blockedEndpointCounts: transport.blockedEndpointCounts, forwarded: transport.forwarded });
    if (!cleanup && !transport.denied.length && transport.value.status === 'failed' && budget.allow('terraform')) {
      const types: Partial<Record<string, string>> = { DescribeTable: 'aws_dynamodb_table', GetRole: 'aws_iam_role', GetPolicy: 'aws_iam_policy', GetFunction: 'aws_lambda_function', GetOpenIDConnectProvider: 'aws_iam_openid_connect_provider', ListTagsForResource: 'aws_s3_bucket', GetBucketVersioning: 'aws_s3_bucket', GetBucketPolicy: 'aws_s3_bucket' };
      const action = transport.value.failedAction;
      const type = action ? types[action] : undefined;
      if (type) {
        for (const resource of captureOwnedResources(await ownedState(root), { prefix, account }).filter(resource => resource.type === type)) {
          const unsupported = await measureRequiredApiUnsupported(target, { action: action as RequiredReadApi, identity: resource.identity, prefix, account });
          if (unsupported) throw unsupported;
        }
      }
    }
    if (transport.denied.length || transport.value.status !== 'succeeded') throw new Error('TERRAFORM_COMMAND_FAILED');
  }
  async function apply(root: RootName, seed = false): Promise<void> {
    if (!roots) throw new Error('FOREIGN_ROOT_REJECTED');
    phase = `${root}-${seed ? 'seed' : 'apply'}`;
    attempted.add(root);
    await writeProductionInputs(roots, root, inputs[root]!);
    if (!initialized.has(root)) {
      await command(root, ['init', '-input=false', '-no-color', '-lockfile=readonly', `-plugin-dir=${join(toolRoot, 'provider-probe/.terraform/providers')}`]);
      initialized.add(root); await command(root, ['validate', '-no-color']);
    }
    try { await command(root, ['apply', '-input=false', '-auto-approve', '-no-color', '-parallelism=1', ...(seed ? ['-target=aws_apigatewayv2_api.production'] : [])]); }
    finally {
      const resources = captureOwnedResources(await ownedState(root), { prefix, account });
      for (const address of await productionResourceAddresses(roots, root)) await bindResourceIdentities(evidence, `${evidence.runId}/${root}/${address}`, resources.filter(resource => resource.address === address));
    }
    await markResource(evidence, `${evidence.runId}/${root}`, 'created');
  }
  function value(state: OwnedState, name: string): string {
    const result = state.outputs?.[name]?.value;
    if (typeof result !== 'string' || result.length > 2048) throw new Error('OUTPUT_REJECTED'); return result;
  }
  const restoreContext: RestoredContext = { prefix, account, region: target.region };
  const restore = createRestoreController({ context: restoreContext, async applyRoots(map) {
    if (disposed || !roots || stack.constructionOutputs.length === 0) throw restoredRejected();
    for (const root of ['bootstrap', 'platform', 'application'] as RootName[]) inputs[root]!.restored_tables = map;
    // Bootstrap must select the identical set first, then platform validates the tables, then application receives the platform's selection.
    await apply('bootstrap'); assertRestoredState('bootstrap', await ownedState('bootstrap'), map, restoreContext);
    await apply('platform'); const platformNow = await ownedState('platform'); assertRestoredState('platform', platformNow, map, restoreContext);
    for (const name of ['reminders_table', 'owner_state_table', 'image_jobs_table']) inputs.application![name] = value(platformNow, name);
    await apply('application'); assertRestoredState('application', await ownedState('application'), map, restoreContext);
  } });
  const stack: ProvisionedStack = { target, artifact, manifest: context.manifest, bindings, stateDirectory, constructionOutputs: [],
    setRestoredTables: target => restore.set(target), restoredTablesState: () => restore.state(),
    setQuiescenceGuard(check: () => Promise<void>) { if (disposed || quiescence) throw new Error('QUIESCENCE_REJECTED'); quiescence = check; },
    async destroy(): Promise<CleanupSummary> {
      if (disposed || !evidenceContext(evidence).finalized) throw new Error('CLEANUP_REJECTED');
      disposed = true; budget.beginCleanup();
      const summary = { attempted: 0, succeeded: 0, errors: 0, leaks: 0 };
      let absenceVerified = true;
      let schedulerDisabled = true;
      const unverifiedRoots = new Set<RootName>();
      const step = async (action: () => Promise<void>) => { summary.attempted++; try { await action(); summary.succeeded++; } catch { summary.errors++; } };
      if (roots) {
        // Only run-owned state is inspected. Never read another root's state to
        // obtain inputs; this path is exclusively for recovery and leak checks.
        for (const root of ['application', 'platform', 'bootstrap'] as RootName[]) {
          if (!attempted.has(root)) continue;
          const state = await ownedState(root).catch(() => { summary.errors++; unverifiedRoots.add(root); return {} as OwnedState; });
          const knownIdentities = evidenceContext(evidence).manifest.resources.filter(item => item.kind === 'terraform-address' && item.name.startsWith(`${root}/`)).flatMap(item => (item.identities ?? []).map(identity => ({ ...identity, address: item.name.slice(root.length + 1) })));
          const unique = new Map<string, OwnedResource>();
          for (const resource of [...knownIdentities, ...captureOwnedResources(state, { prefix, account })]) unique.set(JSON.stringify(resource), resource);
          const resources = [...unique.values()];
          retained.set(root, resources);
          await writeFile(join(context.directory, 'cleanup-identities.json'), JSON.stringify({ runId: evidence.runId, roots: Object.fromEntries(retained) }, null, 2) + '\n', { mode: 0o600 });
          for (const resource of resources.filter(item => item.type === 'aws_scheduler_schedule')) {
            if (!quiescence) {
              schedulerDisabled = false;
              await step(async () => {
                const current = await localRequest(target, new URL(`/schedules/${encodeURIComponent(resource.identity)}?groupName=${encodeURIComponent(resource.parent!)}`, target.endpoint), { headers: { authorization: authorization('scheduler') } });
                if (current.status !== 200 || (JSON.parse(current.bytes.toString('utf8')) as { State?: string }).State !== 'DISABLED') throw new Error('QUIESCENCE_UNVERIFIED');
                schedulerDisabled = true;
              });
            }
            await step(async () => {
              const response = await localRequest(target, new URL(`/schedules/${encodeURIComponent(resource.identity)}?groupName=${encodeURIComponent(resource.parent!)}`, target.endpoint), { method: 'DELETE', headers: { authorization: authorization('scheduler') } });
              if (![200, 204, 404].includes(response.status)) throw new Error('SCHEDULER_STOP_FAILED');
            });
          }
          if (root === 'application') await step(async () => {
            // This driver never invokes either function and always constructs a
            // disabled schedule. Consumers must install this guard BEFORE any
            // invocation or Scheduler enable, using tracked completion evidence.
            if (quiescence) await quiescence(); else if (!schedulerDisabled) throw new Error('QUIESCENCE_UNVERIFIED');
            await writeFile(join(context.directory, 'quiescence.json'), JSON.stringify({ method: quiescence ? 'consumer-completion-guard' : 'driver-never-invoked-disabled-scheduler', confirmed: true }) + '\n', { mode: 0o600 });
          });
          for (const resource of state.resources ?? []) for (const instance of resource.instances) {
            const a = instance.attributes;
            if (resource.type === 'aws_dynamodb_table' && typeof a.name === 'string' && a.name.startsWith(`${prefix}-`)) {
              await step(async () => { const response = await localRequest(target, new URL(target.endpoint), { method: 'POST', headers: { authorization: authorization('dynamodb'), 'content-type': 'application/x-amz-json-1.0', 'x-amz-target': 'DynamoDB_20120810.UpdateTable' }, body: JSON.stringify({ TableName: a.name, DeletionProtectionEnabled: false }) }); if (response.status !== 200) throw new Error('PROTECTION_RELEASE_FAILED'); });
            }
            if (resource.type === 'aws_cognito_user_pool' && typeof a.id === 'string' && typeof a.name === 'string' && a.name.startsWith(`${prefix}-`)) {
              await step(async () => {
                let token: string | undefined;
                do {
                  const response = await localRequest(target, new URL(target.endpoint), { method: 'POST', headers: { authorization: authorization('cognito-idp'), 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'AWSCognitoIdentityProviderService.ListUsers' }, body: JSON.stringify({ UserPoolId: a.id, ...(token ? { PaginationToken: token } : {}) }) });
                  if (response.status !== 200) throw new Error('USER_CLEANUP_FAILED');
                  const page = JSON.parse(response.bytes.toString('utf8')) as { Users: { Username: string }[]; PaginationToken?: string };
                  if (!Array.isArray(page.Users)) throw new Error('USER_CLEANUP_FAILED');
                  for (const user of page.Users) {
                    const deleted = await localRequest(target, new URL(target.endpoint), { method: 'POST', headers: { authorization: authorization('cognito-idp'), 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'AWSCognitoIdentityProviderService.AdminDeleteUser' }, body: JSON.stringify({ UserPoolId: a.id, Username: user.Username }) });
                    if (deleted.status !== 200) throw new Error('USER_CLEANUP_FAILED');
                  }
                  token = page.PaginationToken;
                } while (token && budget.cleanupRemaining());
                if (token) throw new Error('BUDGET_EXHAUSTED');
              });
              await step(async () => { const response = await localRequest(target, new URL(target.endpoint), { method: 'POST', headers: { authorization: authorization('cognito-idp'), 'content-type': 'application/x-amz-json-1.1', 'x-amz-target': 'AWSCognitoIdentityProviderService.UpdateUserPool' }, body: JSON.stringify({ UserPoolId: a.id, DeletionProtection: 'INACTIVE' }) }); if (response.status !== 200) throw new Error('PROTECTION_RELEASE_FAILED'); });
            }
            if (resource.type === 'aws_s3_bucket' && typeof a.bucket === 'string' && a.bucket.startsWith(`${prefix}-`)) {
              const bucket = a.bucket; const client = localS3(target);
              await step(async () => { await client.send(new DeleteBucketPolicyCommand({ Bucket: bucket })); });
              await step(async () => {
                let keyMarker: string | undefined; let versionMarker: string | undefined;
                do {
                  const page = await client.send(new ListObjectVersionsCommand({ Bucket: bucket, ...(keyMarker ? { KeyMarker: keyMarker } : {}), ...(versionMarker ? { VersionIdMarker: versionMarker } : {}) }));
                  const objects = [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])].map(item => ({ Key: item.Key!, VersionId: item.VersionId! }));
                  if (objects.length) { const deleted = await client.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects } })); if (deleted.Errors?.length) throw new Error('CLEANUP_FAILED'); }
                  keyMarker = page.IsTruncated ? page.NextKeyMarker : undefined; versionMarker = page.NextVersionIdMarker;
                } while (keyMarker);
              }); client.destroy();
            }
          }
        }
        await step(async () => { await cleanupOverrides(roots!, true); });
        for (const root of ['application', 'platform', 'bootstrap'] as RootName[]) {
          if (!attempted.has(root)) continue;
          await step(async () => {
            if (initialized.has(root)) await command(root, ['destroy', '-refresh=false', '-auto-approve', '-input=false', '-no-color', '-parallelism=1'], true);
            const remaining = (await ownedState(root)).resources?.filter(resource => resource.mode === 'managed') ?? [];
            if (remaining.some(resource => resource.instances.length)) throw new Error('OWNED_RESOURCES_REMAIN');
          });
        }
        const absence = { checked: 0, absent: 0, exists: 0, unverified: 0 };
        for (const [root, resources] of retained) {
          let rootAbsent = !unverifiedRoots.has(root);
          for (const resource of resources) {
            const status = budget.cleanupRemaining() ? await probeOwnedResource(target, resource) : 'unverified';
            absence.checked++; absence[status]++;
            if (status !== 'absent') rootAbsent = false;
          }
          if (rootAbsent) {
            const item = evidenceContext(evidence).manifest.resources.find(item => item.id === `${evidence.runId}/${root}`);
            if (item && !item.removed) await markResource(evidence, item.id, 'removed');
            for (const resource of evidenceContext(evidence).manifest.resources.filter(item => item.kind === 'terraform-address' && item.name.startsWith(`${root}/`) && item.created && !item.removed)) await markResource(evidence, resource.id, 'removed');
            if (root === 'bootstrap' && resources.some(resource => resource.type === 'aws_s3_bucket' && resource.identity === `${prefix}-${account}-${target.region}-artifacts`)) {
              const object = evidenceContext(evidence).manifest.resources.find(item => item.id === `${evidence.runId}/artifact`);
              if (object && !object.removed) await markResource(evidence, object.id, 'removed');
            }
          }
        }
        summary.leaks = absence.exists; summary.errors += absence.unverified;
        absenceVerified = absence.exists === 0 && absence.unverified === 0 && unverifiedRoots.size === 0;
        await writeFile(join(context.directory, 'independent-absence.json'), JSON.stringify(absence, null, 2) + '\n', { mode: 0o600 });
      }
      if (absenceVerified) await step(release);
      return summary;
    },
  };
  try {
    await assertOidcAbsent(target);
    roots = await prepareProductionRoots(target, stateDirectory);
    // Record every public family before any Terraform child can create resources.
    // Intent does not imply execution: cleanup visits only attempted roots.
    for (const root of ['bootstrap', 'platform', 'application'] as RootName[]) {
      await reserveResource(evidence, { kind: 'terraform-root', name: root, id: `${evidence.runId}/${root}` });
      for (const address of await productionResourceAddresses(roots, root)) await reserveResource(evidence, { kind: 'terraform-address', name: `${root}/${address}`, id: `${evidence.runId}/${root}/${address}` });
    }
    await writeFile(join(context.directory, 'terraform-snapshot.json'), JSON.stringify({ sourceDigest: roots.sourceDigest, transformedDigest: roots.transformedDigest, validationDiffs: roots.validationDiffs, generatedChanges: roots.generatedChanges }, null, 2), { mode: 0o600 });
    await apply('bootstrap');
    const bootstrapState = await ownedState('bootstrap');
    for (const name of ['api_role_arn', 'cleanup_role_arn']) platform[name] = value(bootstrapState, name);
    await apply('platform');
    const platformState = await ownedState('platform');
    const pool = platformState.resources?.find(resource => resource.type === 'aws_cognito_user_pool')?.instances[0]?.attributes.id;
    if (typeof pool !== 'string') throw new Error('OUTPUT_REJECTED');
    phase = 'discovery';
    const discovery = await localRequest(target, new URL(`${target.endpoint}/${pool}/.well-known/openid-configuration`), {});
    const document = JSON.parse(discovery.bytes.toString('utf8')) as Record<string, unknown>;
    await writeFile(join(context.directory, 'discovery-check.json'), JSON.stringify({ status: discovery.status, originKind: typeof document.issuer === 'string' && document.issuer.startsWith(`http://${target.addresses.get('floci')}:4566/`) ? 'verified-private-ip' : 'other' }) + '\n', { mode: 0o600 });
    if (discovery.status !== 200) throw new Error('DISCOVERY_REJECTED');
    const identity = discoveredCognitoIdentity(target, pool, document); const issuer = identity.issuer; const auth = identity.authBase;
    stack.target = identity.target;
    await bindCognitoIdentity(roots, target, pool, issuer, auth);
    const application: Record<string, unknown> = { ...common, chrome_origin: platform.chrome_origin, api_role_arn: value(bootstrapState, 'api_role_arn'), cleanup_role_arn: value(bootstrapState, 'cleanup_role_arn'), scheduler_role_arn: value(bootstrapState, 'scheduler_role_arn'), operator_api_seed: true, production_api_id: null, scheduler_enabled: false, runtime_limits: {}, cognito_issuer: issuer, cognito_auth_base_url: auth };
    for (const name of ['reminders_table', 'owner_state_table', 'image_jobs_table', 'images_bucket', 'api_log_group', 'cleanup_log_group', 'gateway_log_group', 'cognito_client_id']) application[name] = value(platformState, name);
    application.artifact = { bucket: value(bootstrapState, 'artifact_bucket'), key: `releases/${'0'.repeat(64)}/reminder-server.zip`, version_id: 'operator-api-seed-unused', sha256_base64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' };
    inputs.application = application; await apply('application', true);
    const apiId = value(await ownedState('application'), 'api_id'); if (!/^[a-z0-9]{10}$/.test(apiId)) throw new Error('API_ID_REJECTED');
    bootstrap.production_api_id = apiId; await apply('bootstrap');
    const s3 = localS3(target);
    try { application.artifact = await registerArtifact(s3, value(bootstrapState, 'artifact_bucket'), artifact, evidence); } finally { s3.destroy(); }
    application.operator_api_seed = false; application.production_api_id = apiId; application.scheduler_enabled = false;
    await apply('application');
    // Read back all roots through provider refresh before exporting bindings.
    for (const root of ['bootstrap', 'platform', 'application'] as RootName[]) await command(root, ['apply', '-refresh-only', '-auto-approve', '-input=false', '-no-color']);
    const finalApplication = await ownedState('application');
    if (value(finalApplication, 'release_sha256_base64') !== artifact.sha256Base64) throw new Error('CODE_SHA_REJECTED');
    const finalPlatform = await ownedState('platform'); const finalBootstrap = await ownedState('bootstrap');
    const attributes = (state: OwnedState, type: string) => (state.resources ?? []).filter(resource => resource.mode === 'managed' && resource.type === type).flatMap(resource => resource.instances.map(instance => instance.attributes));
    const requireCheck = (condition: boolean) => { if (!condition) throw new Error('READBACK_REJECTED'); };
    requireCheck(attributes(finalApplication, 'aws_apigatewayv2_route').length === 16 && attributes(finalApplication, 'aws_cloudwatch_metric_alarm').length === 9);
    const functions = attributes(finalApplication, 'aws_lambda_function'); const aliases = attributes(finalApplication, 'aws_lambda_alias');
    requireCheck(functions.length === 2 && functions.every(a => a.code_sha256 === artifact.sha256Base64 && a.source_code_hash === artifact.sha256Base64 && a.s3_object_version === (application.artifact as { version_id: string }).version_id));
    requireCheck(aliases.length === 2 && aliases.every(a => a.name === 'production' && functions.some(fn => fn.function_name === a.function_name && fn.version === a.function_version)));
    const tables = attributes(finalPlatform, 'aws_dynamodb_table');
    requireCheck(tables.length === 3 && tables.every(a => a.deletion_protection_enabled === true && a.billing_mode === 'PAY_PER_REQUEST' && (a.point_in_time_recovery as { enabled: boolean; recovery_period_in_days: number }[]).some(pitr => pitr.enabled && pitr.recovery_period_in_days === 35)));
    const all = { resources: [...(finalPlatform.resources ?? []), ...(finalBootstrap.resources ?? [])] };
    const buckets = attributes(all, 'aws_s3_bucket'); const versions = attributes(all, 'aws_s3_bucket_versioning'); const policies = attributes(all, 'aws_s3_bucket_policy');
    requireCheck(buckets.length === 3 && buckets.every(a => a.force_destroy === false) && versions.length === 3 && versions.every(a => (a.versioning_configuration as { status: string }[]).some(config => config.status === 'Enabled')) && policies.length === 3 && policies.every(a => typeof a.policy === 'string' && a.policy.includes('aws:SecureTransport')));
    const groups = attributes(finalPlatform, 'aws_cloudwatch_log_group'); requireCheck(groups.length === 3 && groups.every(a => a.retention_in_days === 30));
    requireCheck(attributes(finalApplication, 'aws_scheduler_schedule').every(a => a.state === 'DISABLED'));
    stack.constructionOutputs = [
      { kind: 'http', status: 'pass', assertions: ['provider-refresh-full-definition', 'routes16-alarms9', 'both-current-zip-aliases'].map(name => ({ name, status: 'pass' })) },
      { kind: 'dynamodb', status: 'pass', assertions: [{ name: 'three-protected-tables-pitr35', status: 'pass' }] },
      { kind: 's3', status: 'pass', assertions: ['create-only-pinned-artifact', 'protected-versioned-buckets'].map(name => ({ name, status: 'pass' })) },
      { kind: 'logs', status: 'pass', assertions: [{ name: 'three-log-groups-retention30', status: 'pass' }] },
    ];
    for (const name of ['api_id', 'api_base_url', 'api_alias_arn', 'cleanup_alias_arn']) bindings[name] = value(finalApplication, name);
    for (const [name, value] of Object.entries(application)) if (typeof value === 'string') bindings[name] = value;
    for (const [key, value] of Object.entries(application.artifact as { bucket: string; key: string; version_id: string; sha256_base64: string })) bindings[`artifact_${key}`] = value;
    bindings.pool_id = pool; bindings.prefix = prefix; bindings.account_id = account;
    await writeFile(join(context.directory, 'terraform-snapshot.json'), JSON.stringify({ sourceDigest: roots.sourceDigest, transformedDigest: roots.transformedDigest, validationDiffs: roots.validationDiffs, generatedChanges: roots.generatedChanges }, null, 2), { mode: 0o600 });
    stack.manifest = evidenceContext(evidence).manifest;
    return stack;
  } catch (error) {
    const causes = new Set(['RESOURCE_REJECTED', 'OUTPUT_REJECTED', 'DISCOVERY_REJECTED', 'IDENTITY_REJECTED', 'API_ID_REJECTED', 'CODE_SHA_REJECTED', 'READBACK_REJECTED', 'SOURCE_REJECTED', 'FOREIGN_STATE_REJECTED', 'BUDGET_EXHAUSTED', 'TERRAFORM_COMMAND_FAILED', 'OIDC_OWNERSHIP_REJECTED', 'ARTIFACT_REJECTED', 'ARTIFACT_REGISTRATION_FAILED', 'REQUIRED_API_UNSUPPORTED']);
    const cause = error instanceof Error && causes.has(error.message) ? error.message : 'DRIVER_FAILED';
    const unsupported = error instanceof MeasuredRequiredApiUnsupported ? error : undefined;
    await writeFile(join(context.directory, 'provision-failure.json'), JSON.stringify({ phase, cause, ...(unsupported ? { requiredApiNonSupport: unsupported.basis } : {}) }) + '\n', { mode: 0o600 });
    throw new ProvisioningFailure(phase, stack, 'terraform-construction-failed', unsupported);
  }
}
