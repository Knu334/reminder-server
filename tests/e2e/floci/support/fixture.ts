import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { DynamoDBClient, DescribeTableCommand, DescribeContinuousBackupsCommand, DescribeTimeToLiveCommand } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { HttpHandlerOptions } from "@smithy/types";
import type { RunBudget } from "../../../../scripts/e2e/run.ts";
import type { FunctionConfiguration } from '@aws-sdk/client-lambda';
import { LambdaClient, GetFunctionCommand, GetAliasCommand, GetFunctionConcurrencyCommand, GetPolicyCommand as GetLambdaPolicyCommand, GetFunctionEventInvokeConfigCommand, InvokeCommand } from '@aws-sdk/client-lambda';
import { CloudWatchClient, DescribeAlarmsCommand } from '@aws-sdk/client-cloudwatch';
import { CloudWatchLogsClient, DescribeLogGroupsCommand } from '@aws-sdk/client-cloudwatch-logs';
import { STSClient } from '@aws-sdk/client-sts';
import { GetBucketVersioningCommand, GetBucketEncryptionCommand, GetPublicAccessBlockCommand, GetBucketPolicyCommand, GetBucketLifecycleConfigurationCommand, GetBucketCorsCommand, ListObjectVersionsCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import type { ListObjectVersionsCommandOutput, HeadObjectCommandOutput } from '@aws-sdk/client-s3';
import { CognitoIdentityProviderClient, DescribeUserPoolCommand, DescribeUserPoolClientCommand, DescribeResourceServerCommand, DescribeUserPoolDomainCommand } from '@aws-sdk/client-cognito-identity-provider';
import type { Cors } from '@aws-sdk/client-apigatewayv2';
import { ApiGatewayV2Client, GetApiCommand, GetRoutesCommand, GetAuthorizersCommand, GetIntegrationsCommand, GetStageCommand } from '@aws-sdk/client-apigatewayv2';
import { SchedulerClient, GetScheduleCommand } from '@aws-sdk/client-scheduler';
import { IAMClient, GetOpenIDConnectProviderCommand, GetRoleCommand, ListRolePoliciesCommand, GetRolePolicyCommand, ListAttachedRolePoliciesCommand, GetPolicyCommand, GetPolicyVersionCommand } from '@aws-sdk/client-iam';
import { localS3 } from '../../../../scripts/e2e/terraform.ts';
import { localRequest } from './transport.ts';
import { loadConfig } from '../../../../src/config.ts';
import { evidenceContext } from './evidence.ts';
import { sdkObserver, suiteLogStates, type LogObserver, type CleanupCompletion } from './logs.ts';
import type { E2EFixture, SuiteFixture, SuiteOptions, ProvisionedStack, Evidence, LogExpectation, CleanupSummary } from './types.ts';
import { createCaseAuth, verifyOwnedSdkAbsence } from './auth.ts';
import { expectedIam, policiesEqual, type ExpectedIam } from './expected-iam.ts';
import { snapshotOwnedStorage } from './storage.ts';
import { resetOwnedSuite, cleanupOwnedSdk } from './cleanup.ts';
const requireSetting = (value: boolean): void => { if (!value) throw new Error('SETTINGS_MISMATCH'); };
function same(actual: unknown, expected: unknown): void { try { assert.deepEqual(actual, expected); } catch { throw new Error('SETTINGS_MISMATCH'); } }
export function assertRuntimeSettings(actual: FunctionConfiguration, concurrency: number | undefined, expected: { sha: string; handler: string; timeout: number; concurrency: number; logGroup: string; role: string; env: Record<string, string> }): void {
  same([actual.Runtime, actual.Handler, actual.Timeout, actual.MemorySize, actual.Architectures, actual.PackageType, actual.Role, actual.CodeSha256, concurrency, actual.Environment?.Variables, actual.LoggingConfig], ['nodejs24.x', expected.handler, expected.timeout, 512, ['x86_64'], 'Zip', expected.role, expected.sha, expected.concurrency, expected.env, { LogFormat: 'Text', LogGroup: expected.logGroup }]);
}
export type RunFixtureState = { stack: ProvisionedStack; evidence: Evidence; budget?: RunBudget; signal?: AbortSignal; observer: LogObserver; cognito: CognitoIdentityProviderClient; api: ApiGatewayV2Client; scheduler: SchedulerClient; iam: IAMClient; lastInput: number; outstanding: number; cleanupIntervals: CleanupCompletion[]; suiteActive: boolean; suite: string; disposed: boolean; sdkCleanup?: CleanupSummary; expectedIam?: ExpectedIam; readbackObserved: Record<string, boolean | number | string | null>; readbackSdkStatus?: number; readbackWire?: Record<string, unknown>; readbackWirePrimary?: Record<string, unknown>; readbackField?: string; readbackProbe?: () => Promise<Record<string, unknown>>; independentReadback?: Record<string, unknown>; readbackError?: { code: string; status?: number }; readbackFailed?: { api: string; field: string; check: number; expected: unknown; observed: unknown }; readbackPhase: string; settingsComplete: boolean; smokeComplete: boolean; smokeObserved?: SmokeResult };
export const fixtureStates = new WeakMap<SuiteFixture, RunFixtureState>();
export function fixtureState(fixture: SuiteFixture): RunFixtureState { const state = fixtureStates.get(fixture); if (!state) throw new Error('FIXTURE_REJECTED'); return state; }
export async function readDeployedSettings(fixture: SuiteFixture): Promise<void> {
  const state = fixtureState(fixture); await runReadbackBoundary(state, () => readSettings(fixture));
}
export async function runReadbackBoundary(state: RunFixtureState, action: () => Promise<void>): Promise<void> {
  delete state.readbackError; delete state.readbackFailed;
  try { await action(); } catch (error) {
    const failure = error as { name?: string; message?: string; $metadata?: { httpStatusCode?: number } };
    const sdkCodes = ["ResourceNotFoundException", "AccessDeniedException", "UnknownOperationException", "NotImplemented", "NotImplementedException", "UnsupportedOperationException", "NoSuchEntity", "NoSuchBucket", "NoSuchKey", "ValidationException", "InvalidParameterValueException", "InvalidParameterException", "InvalidRequestException", "NotFoundException", "ThrottlingException", "TooManyRequestsException", "ServiceException", "InternalErrorException"];
    const localCodes = ["SETTINGS_MISMATCH", "EXPECTED_POLICY_EVALUATION_FAILED", "EXPECTED_POLICY_BUDGET_EXHAUSTED", "EXPECTED_POLICY_REJECTED", "EXPECTED_SOURCE_CHANGED", "FIXTURE_BUDGET_EXHAUSTED", "LOCAL_REQUEST_FAILED", "LOCAL_REQUEST_CANCELLED", "LOCAL_TARGET_REJECTED"];
    const code = error instanceof SyntaxError ? "response-codec" : sdkCodes.includes(failure.name ?? "") ? failure.name! : localCodes.includes(failure.message ?? "") ? failure.message! : "unclassified";
    const status = failure.$metadata?.httpStatusCode ?? state.readbackSdkStatus; state.readbackError = { code, ...(status !== undefined && Number.isInteger(status) && status >= 100 && status <= 599 ? { status } : {}) };
    if (code === "SETTINGS_MISMATCH" && !state.readbackFailed) state.readbackFailed = { api: state.readbackPhase, field: state.readbackField ?? 'public-definition-fields', check: 1, expected: true, observed: false };
    if (state.readbackWire) state.readbackWirePrimary = state.readbackWire; else delete state.readbackWirePrimary;
    if (state.readbackProbe) {
      try { state.independentReadback = await state.readbackProbe(); }
      catch (probeError) { const probe = probeError as { name?: string; $metadata?: { httpStatusCode?: number } }; const probeStatus = probe.$metadata?.httpStatusCode ?? state.readbackSdkStatus; state.independentReadback = { succeeded: false, code: sdkCodes.includes(probe.name ?? '') ? probe.name! : 'unclassified', ...(probeStatus !== undefined ? { httpStatus: probeStatus } : {}) }; }
    }
    throw new Error("SETTINGS_READBACK_FAILED");
  }
}
async function readSettings(fixture: SuiteFixture): Promise<void> {
  const state = fixtureState(fixture); state.settingsComplete = false; delete state.readbackFailed; delete state.readbackProbe; delete state.independentReadback; delete state.readbackField; delete state.readbackWire; delete state.readbackWirePrimary; state.readbackObserved = {}; state.readbackPhase = 'public-policy-evaluator'; let phase = ''; let check = 0;
  const safeValue = (value: unknown): unknown => {
    if (value === undefined || value === null) return null;
    if (typeof value === 'boolean' || typeof value === 'number') return value;
    if (typeof value === 'string') return ['HTTP', 'WEBSOCKET', 'JWT', 'NONE', 'AWS_PROXY', 'POST', '2.0', 'ACTIVE', 'ESSENTIALS', 'ENABLED', 'DISABLED', 'AES256', 'Enabled', 'minutes', 'days', 'nodejs24.x', 'Zip', 'Text', 'S', 'HASH', 'RANGE', 'KEYS_ONLY', 'PAY_PER_REQUEST', 'GET', 'HEAD', 'UTC', 'OFF', 'COGNITO', 'code', 'openid', 'reminder-api/read', 'reminder-api/write', 'ALLOW_ADMIN_USER_PASSWORD_AUTH', 'admin_only', 'notBreaching', 'string', 'number', 'undefined', 'null', 'object', 'array', 'boolean', 'published-numeric', 'latest', 'empty', 'missing', 'other'].includes(value) ? value : '<string>';
    if (Array.isArray(value)) return value.slice(0, 16).map(safeValue);
    return { type: valueType(value), fields: Object.keys(value as object).length, memberTypes: Object.values(value as object).slice(0, 16).map(valueType) };
  };
  const same = (actual: unknown, expected: unknown, field = 'public-definition-fields'): void => { if (phase !== state.readbackPhase) { phase = state.readbackPhase; check = 0; } check++; state.readbackField = field; try { assert.deepEqual(actual, expected); } catch { state.readbackFailed = { api: phase, field, check, expected: safeValue(expected), observed: safeValue(actual) }; throw new Error('SETTINGS_MISMATCH'); } };
  const requireSetting = (valid: boolean, field = 'required-public-definition'): void => same(valid, true, field);
  const read = <T>(send: (options: HttpHandlerOptions) => Promise<T>): Promise<T> => {
    const api = state.readbackPhase;
    state.readbackField = 'SDK-response-fields';
    delete state.readbackProbe;
    if (api.endsWith('GetAlias') || api === 'lambda-api-GetPolicy-production') state.readbackProbe = async () => {
      const result = await send({ requestTimeout: 5000, abortSignal: AbortSignal.timeout(5000) }); const doc = result as Record<string, unknown>; const metadata = doc.$metadata as { httpStatusCode?: number } | undefined;
      return { succeeded: true, api, httpStatus: metadata?.httpStatusCode ?? state.readbackSdkStatus ?? null, wire: state.readbackWire, ...(api.endsWith('GetAlias') ? { aliasVersion: classifyAliasVersion(doc.FunctionVersion) } : { policyPresent: doc.Policy !== undefined, policyType: valueType(doc.Policy), ...(typeof doc.Policy === 'string' ? sourceAccountProjection(JSON.parse(doc.Policy), fixtureState(fixture).stack.bindings.account_id) : {}) }) };
    };
    return send({});
  };
  const { stack } = state; const b = stack.bindings; const prefix = b.prefix!; const production = `${prefix}-production`; const account = b.account_id!; const region = stack.target.region;
  const expected = state.expectedIam ??= await expectedIam(stack, { ...(state.budget ? { budget: state.budget } : {}), ...(state.signal ? { signal: state.signal } : {}) });
  const env = { REMINDERS_TABLE: b.reminders_table!, OWNER_STATE_TABLE: b.owner_state_table!, IMAGE_JOBS_TABLE: b.image_jobs_table!, IMAGES_BUCKET: b.images_bucket!, EXPECTED_API_ID: b.api_id!, EXPECTED_API_STAGE: '$default', COGNITO_ISSUER: b.cognito_issuer!, COGNITO_CLIENT_ID: b.cognito_client_id! };
  state.readbackPhase = 'dynamodb';
  for (const [suffix, hash, range] of [['reminders', 'ownerId', 'id'], ['owner-state', 'pk', 'sk'], ['image-jobs', 'jobId', undefined]] as const) {
    const TableName = `${production}-${suffix}`; state.readbackPhase = `dynamodb-${suffix}-DescribeTable`; const result = await read(options => fixture.clients.dynamodb.send(new DescribeTableCommand({ TableName }), options)); const table = result.Table;
    same(table?.TableName, TableName, 'TableName'); same(table?.BillingModeSummary?.BillingMode, 'PAY_PER_REQUEST', 'BillingModeSummary-BillingMode'); same(table?.DeletionProtectionEnabled, true, 'DeletionProtectionEnabled');
    same(table?.KeySchema, [{ AttributeName: hash, KeyType: 'HASH' }, ...(range ? [{ AttributeName: range, KeyType: 'RANGE' }] : [])], 'KeySchema');
    same((table?.AttributeDefinitions ?? []).map(a => `${a.AttributeName}:${a.AttributeType}`).sort(), (suffix === 'image-jobs' ? ['jobId', 'cleanupPartition', 'cleanupSortKey'] : [hash, range!]).map(name => `${name}:S`).sort(), 'AttributeDefinitions-AttributeName-AttributeType');
    state.readbackPhase = `dynamodb-${suffix}-DescribeContinuousBackups`;
    const pitr = (await read(options => fixture.clients.dynamodb.send(new DescribeContinuousBackupsCommand({ TableName }), options))).ContinuousBackupsDescription?.PointInTimeRecoveryDescription;
    same([pitr?.PointInTimeRecoveryStatus, pitr?.RecoveryPeriodInDays], ['ENABLED', 35], 'PointInTimeRecoveryStatus-RecoveryPeriodInDays');
    state.readbackPhase = `dynamodb-${suffix}-DescribeTimeToLive`;
    const ttl = (await read(options => fixture.clients.dynamodb.send(new DescribeTimeToLiveCommand({ TableName }), options))).TimeToLiveDescription;
    if (suffix === 'owner-state') same([ttl?.TimeToLiveStatus, ttl?.AttributeName], ['ENABLED', 'expiresAt'], 'TimeToLiveStatus-AttributeName'); else requireSetting(ttl?.TimeToLiveStatus === 'DISABLED', 'TimeToLiveStatus');
    state.readbackPhase = `dynamodb-${suffix}-index-fields`;
    const indexes = table?.GlobalSecondaryIndexes ?? [];
    if (suffix === 'image-jobs') { same(indexes.length, 1, 'index-count'); same([indexes[0]?.IndexName, indexes[0]?.Projection?.ProjectionType, indexes[0]?.KeySchema], ['cleanup_by_due', 'KEYS_ONLY', [{ AttributeName: 'cleanupPartition', KeyType: 'HASH' }, { AttributeName: 'cleanupSortKey', KeyType: 'RANGE' }]], 'IndexName-Projection-ProjectionType-KeySchema'); } else same(indexes.length, 0, 'index-count');
  }
  state.readbackPhase = 's3';
  for (const suffix of ['state', 'artifacts', 'images']) {
    const Bucket = `${prefix}-${account}-${region}-${suffix}`; state.readbackPhase = `s3-${suffix}-versioning`;
    same((await read(options => fixture.clients.s3.send(new GetBucketVersioningCommand({ Bucket }), options))).Status, 'Enabled', 'VersioningStatus');
    state.readbackPhase = `s3-${suffix}-encryption`;
    const encryption = await read(options => fixture.clients.s3.send(new GetBucketEncryptionCommand({ Bucket }), options)); same(encryption.ServerSideEncryptionConfiguration?.Rules?.map(rule => rule.ApplyServerSideEncryptionByDefault?.SSEAlgorithm), ['AES256'], 'ServerSideEncryptionConfiguration-Rules-ApplyServerSideEncryptionByDefault-SSEAlgorithm');
    state.readbackPhase = `s3-${suffix}-public-access`;
    same((await read(options => fixture.clients.s3.send(new GetPublicAccessBlockCommand({ Bucket }), options))).PublicAccessBlockConfiguration, { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true }, 'PublicAccessBlockConfiguration');
    state.readbackPhase = `s3-${suffix}-policy`;
    const policy = JSON.parse((await read(options => fixture.clients.s3.send(new GetBucketPolicyCommand({ Bucket }), options))).Policy ?? '{}') as { Statement?: { Sid: string; Condition?: unknown }[] };
    requireSetting(policiesEqual(policy, suffix === 'images' ? expected.imagesBucketPolicy : expected.bucketPolicies[suffix]), 'full-policy-semantics');
    if (suffix === 'images') {
      state.readbackPhase = 's3-images-lifecycle';
      const lifecycle = await read(options => fixture.clients.s3.send(new GetBucketLifecycleConfigurationCommand({ Bucket }), options)); same(lifecycle.Rules?.map(r => [r.ID, r.Status, r.Filter?.Prefix, r.NoncurrentVersionExpiration?.NoncurrentDays]), [['retain-noncurrent-images-60-days', 'Enabled', 'images/', 60]], 'Rules-ID-Status-Filter-Prefix-NoncurrentVersionExpiration-NoncurrentDays');
      state.readbackPhase = 's3-images-cors';
      const cors = (await read(options => fixture.clients.s3.send(new GetBucketCorsCommand({ Bucket }), options))).CORSRules; same(cors?.length, 1, 'required-public-definition-fields'); same(cors?.[0]?.AllowedOrigins, ['https://extension.example.test'], 'AllowedOrigins'); same(cors?.[0]?.AllowedMethods?.slice().sort(), ['GET', 'HEAD'], 'AllowedMethods'); requireSetting(!cors?.[0]?.AllowedHeaders?.length && !cors?.[0]?.ExposeHeaders?.length, 'AllowedHeaders-ExposeHeaders');
    }
  }
  state.readbackPhase = 'artifact-original-receipt';
  same([b.artifact_bucket, b.artifact_key, b.artifact_sha256_base64], [`${prefix}-${account}-${region}-artifacts`, `releases/${fixture.artifact.sha256Hex}/reminder-server.zip`, fixture.artifact.sha256Base64], 'artifact_bucket-artifact_key-artifact_sha256_base64'); requireSetting(!!b.artifact_version_id && b.artifact_version_id !== 'null', 'artifact_version_id');
  state.readbackPhase = 'artifact-ListObjectVersions';
  const versions = await read(options => fixture.clients.s3.send(new ListObjectVersionsCommand({ Bucket: `${prefix}-${account}-${region}-artifacts`, Prefix: `releases/${fixture.artifact.sha256Hex}/reminder-server.zip` }), options));
  state.readbackPhase = 'artifact-HeadObject-pinned-version';
  const head = await read(options => fixture.clients.s3.send(new HeadObjectCommand({ Bucket: b.artifact_bucket!, Key: b.artifact_key!, VersionId: b.artifact_version_id!, ChecksumMode: 'ENABLED' }), options)); state.readbackField = 'original-pinned-version-checksum-bytes'; assertPinnedArtifact(versions, head, { version: b.artifact_version_id!, sha: fixture.artifact.sha256Base64, bytes: fixture.artifact.compressedBytes });
  state.readbackPhase = 'lambda';
  for (const service of ['api', 'cleanup'] as const) {
    const FunctionName = `${production}-${service}`; state.readbackPhase = `lambda-${service}-GetAlias`; const alias = await read(options => fixture.clients.lambda.send(new GetAliasCommand({ FunctionName, Name: 'production' }), options));
    const version = classifyAliasVersion(alias.FunctionVersion); state.readbackObserved[`${service}AliasVersionPresent`] = version.present; state.readbackObserved[`${service}AliasVersionType`] = version.type; state.readbackObserved[`${service}AliasVersionClass`] = version.classification; same([version.present, version.type, version.classification], [true, 'string', 'published-numeric'], 'function-version-published');
    state.readbackPhase = `lambda-${service}-GetFunction`;
    const fn = await read(options => fixture.clients.lambda.send(new GetFunctionCommand({ FunctionName, Qualifier: alias.FunctionVersion! }), options)); state.readbackPhase = `lambda-${service}-GetFunctionConcurrency`; const concurrency = await read(options => fixture.clients.lambda.send(new GetFunctionConcurrencyCommand({ FunctionName }), options));
    state.readbackPhase = `lambda-${service}-runtime-fields`;
    state.readbackField = 'runtime-handler-timeout-memory-architecture-role-sha-concurrency-env-logging';
    assertRuntimeSettings(fn.Configuration ?? {}, concurrency.ReservedConcurrentExecutions, { sha: fixture.artifact.sha256Base64, handler: `dist/${service}.handler`, timeout: service === 'api' ? 10 : 660, concurrency: service === 'api' ? 10 : 1, logGroup: b[`${service}_log_group`]!, role: b[`${service}_role_arn`]!, env });
    same(alias.AliasArn, b[`${service}_alias_arn`], 'AliasArn'); requireSetting(!Object.keys(alias.RoutingConfig?.AdditionalVersionWeights ?? {}).length, 'keys-RoutingConfig-AdditionalVersionWeights');
    state.readbackPhase = `lambda-${service}-GetFunction-latest`; const latest = await read(options => fixture.clients.lambda.send(new GetFunctionCommand({ FunctionName }), options)); same(latest.Configuration?.CodeSha256, fixture.artifact.sha256Base64, 'Configuration-CodeSha256');
  }
  state.readbackPhase = 'lambda-api-GetPolicy-production';
  const permission = await read(options => readAliasPolicy(fixture.clients.lambda, `${production}-api`, b.api_alias_arn!, failure => { state.readbackObserved.permissionPrimaryRejected = true; state.readbackObserved.permissionPrimaryCode = failure.code; state.readbackObserved.permissionPrimaryStatus = failure.status ?? null; }, options)); state.readbackObserved.permissionPresent = !!permission.Policy; const permissionDoc = JSON.parse(permission.Policy ?? '{}') as { Version?: string; Statement?: Record<string, unknown>[] }; const statement = permissionDoc.Statement?.find(s => s.Sid === 'ProductionGatewayOnly'); state.readbackObserved.permissionVersion = permissionDoc.Version === '2012-10-17'; state.readbackObserved.permissionStatements = permissionDoc.Statement?.length ?? 0; state.readbackObserved.permissionSid = !!statement; state.readbackObserved.permissionAllow = statement?.Effect === 'Allow'; state.readbackObserved.permissionPrincipal = policiesEqual(statement?.Principal, { Service: 'apigateway.amazonaws.com' }); state.readbackObserved.permissionAction = statement?.Action === 'lambda:InvokeFunction'; state.readbackObserved.permissionResource = statement?.Resource === b.api_alias_arn; const conditions = statement?.Condition as Record<string, Record<string, string>> | undefined; Object.assign(state.readbackObserved, sourceAccountProjection(permissionDoc, account)); state.readbackObserved.permissionSourceAccount = sourceAccountProjection(permissionDoc, account).sourceAccountMatches === true; state.readbackObserved.permissionSourceArn = conditions?.ArnLike?.['AWS:SourceArn'] === `arn:aws:execute-api:${region}:${account}:${b.api_id}/$default/*/*`; state.readbackField = 'full-qualified-gateway-policy-semantics'; assertGatewayPermission(permission.Policy, { account, apiId: b.api_id!, alias: b.api_alias_arn! });
  state.readbackPhase = 'lambda-cleanup-GetFunctionEventInvokeConfig-production';
  const asyncConfig = await read(options => fixture.clients.lambda.send(new GetFunctionEventInvokeConfigCommand({ FunctionName: `${production}-cleanup`, Qualifier: 'production' }), options)); same([asyncConfig.MaximumRetryAttempts, asyncConfig.MaximumEventAgeInSeconds, asyncConfig.DestinationConfig?.OnSuccess?.Destination, asyncConfig.DestinationConfig?.OnFailure?.Destination], [2, 3600, undefined, undefined], 'MaximumRetryAttempts-MaximumEventAgeInSeconds-DestinationConfig-OnSuccess-Destination-OnFailure');
  state.readbackPhase = 'cognito';
  const pool = (await read(options => state.cognito.send(new DescribeUserPoolCommand({ UserPoolId: b.pool_id! }), options))).UserPool;
  same([pool?.Name, pool?.DeletionProtection, pool?.UserPoolTier, pool?.AdminCreateUserConfig?.AllowAdminCreateUserOnly, pool?.AccountRecoverySetting?.RecoveryMechanisms], [production, 'ACTIVE', 'ESSENTIALS', true, [{ Name: 'admin_only', Priority: 1 }]], 'Name-DeletionProtection-UserPoolTier-AdminCreateUserConfig-AllowAdminCreateUserOnly-AccountRecoverySetting-RecoveryMechanisms');
  state.readbackPhase = 'cognito-email-schema'; const email = pool?.SchemaAttributes?.find(attribute => attribute.Name === 'email'); same([email?.AttributeDataType, email?.Mutable, email?.Required, email?.StringAttributeConstraints], ['String', true, true, { MinLength: '0', MaxLength: '2048' }], 'AttributeDataType-Mutable-Required-StringAttributeConstraints');
  state.readbackPhase = 'cognito-DescribeUserPoolDomain'; const domain = (await read(options => state.cognito.send(new DescribeUserPoolDomainCommand({ Domain: prefix }), options))).DomainDescription; same([domain?.Domain, domain?.UserPoolId, domain?.ManagedLoginVersion], [prefix, b.pool_id, 1], 'Domain-UserPoolId-ManagedLoginVersion');
  state.readbackPhase = 'cognito-DescribeUserPoolClient';
  const client = (await read(options => state.cognito.send(new DescribeUserPoolClientCommand({ UserPoolId: b.pool_id!, ClientId: b.cognito_client_id! }), options))).UserPoolClient;
  same([client?.ClientSecret, client?.AllowedOAuthFlowsUserPoolClient, client?.AllowedOAuthFlows, client?.AllowedOAuthScopes?.slice().sort(), client?.ExplicitAuthFlows, client?.EnableTokenRevocation, client?.AccessTokenValidity, client?.IdTokenValidity, client?.RefreshTokenValidity, client?.TokenValidityUnits, client?.RefreshTokenRotation], [undefined, true, ['code'], ['openid', 'reminder-api/read', 'reminder-api/write'], ['ALLOW_ADMIN_USER_PASSWORD_AUTH'], true, 5, 5, 30, { AccessToken: 'minutes', IdToken: 'minutes', RefreshToken: 'days' }, { Feature: 'ENABLED', RetryGracePeriodSeconds: 10 }], 'ClientSecret-AllowedOAuthFlowsUserPoolClient-AllowedOAuthFlows-AllowedOAuthScopes-ExplicitAuthFlows-EnableTokenRevocation-AccessTokenValidity-IdTokenValidity');
  same([client?.CallbackURLs, client?.LogoutURLs, client?.SupportedIdentityProviders, client?.ReadAttributes, client?.WriteAttributes, client?.PreventUserExistenceErrors], [['https://extension.example.test/callback'], ['https://extension.example.test/logout'], ['COGNITO'], ['email'], ['email'], 'ENABLED'], 'CallbackURLs-LogoutURLs-SupportedIdentityProviders-ReadAttributes-WriteAttributes-PreventUserExistenceErrors');
  state.readbackPhase = 'cognito-DescribeResourceServer';
  const server = (await read(options => state.cognito.send(new DescribeResourceServerCommand({ UserPoolId: b.pool_id!, Identifier: 'reminder-api' }), options))).ResourceServer; same(server?.Scopes?.map(s => s.ScopeName).sort(), ['read', 'write'], 'Scopes-ScopeName');
  state.readbackPhase = 'gateway-api';
  const api = await read(options => state.api.send(new GetApiCommand({ ApiId: b.api_id! }), options)); same(api.ApiEndpoint, b.api_base_url, 'ApiEndpoint'); state.readbackObserved.protocolHttp = api.ProtocolType === 'HTTP'; state.readbackObserved.endpointEnabled = api.DisableExecuteApiEndpoint === false; same([api.ProtocolType, api.DisableExecuteApiEndpoint], ['HTTP', false], 'ProtocolType-DisableExecuteApiEndpoint');
  state.readbackPhase = 'gateway-cors'; state.readbackObserved.corsCredentials = api.CorsConfiguration?.AllowCredentials ?? null; state.readbackObserved.corsOrigins = api.CorsConfiguration?.AllowOrigins?.length ?? -1; state.readbackObserved.corsMethods = api.CorsConfiguration?.AllowMethods?.length ?? -1; state.readbackObserved.corsHeaders = api.CorsConfiguration?.AllowHeaders?.length ?? -1; state.readbackObserved.corsExpose = api.CorsConfiguration?.ExposeHeaders?.length ?? -1; state.readbackObserved.corsMaxAge = api.CorsConfiguration?.MaxAge ?? null;
  state.readbackField = 'CorsConfiguration'; assertGatewayCors(api.CorsConfiguration);
  state.readbackPhase = 'gateway-routes';
  const routes = await read(options => state.api.send(new GetRoutesCommand({ ApiId: b.api_id! }), options)); requireSetting(!routes.NextToken && routes.Items?.length === 16, 'NextToken-Items');
  const expectedRoutes = ['ANY /healthz', 'ANY /readyz', 'ANY /reminders', 'ANY /v2/reminders', 'ANY /v2/reminders/{id}', 'ANY /v2/reminders/{id}/thumbnail-url', 'GET /healthz', 'GET /readyz', 'POST /reminders', 'PUT /reminders', 'GET /v2/reminders', 'POST /v2/reminders', 'GET /v2/reminders/{id}', 'PATCH /v2/reminders/{id}', 'DELETE /v2/reminders/{id}', 'GET /v2/reminders/{id}/thumbnail-url']; same(routes.Items?.map(r => r.RouteKey).sort(), expectedRoutes.sort(), 'Items-RouteKey');
  state.readbackPhase = 'gateway-authorizer';
  const authorizers = await read(options => state.api.send(new GetAuthorizersCommand({ ApiId: b.api_id! }), options)); same(authorizers.Items?.length, 1, 'Items'); const authorizer = authorizers.Items![0]!; same([authorizer.AuthorizerType, authorizer.IdentitySource, authorizer.JwtConfiguration], ['JWT', ['$request.header.Authorization'], { Issuer: b.cognito_issuer!, Audience: [b.cognito_client_id!] }], 'AuthorizerType-IdentitySource-JwtConfiguration');
  state.readbackPhase = 'gateway-integration';
  const integrations = await read(options => state.api.send(new GetIntegrationsCommand({ ApiId: b.api_id! }), options)); same(integrations.Items?.length, 1, 'Items'); const integration = integrations.Items![0]!; same([integration.IntegrationType, integration.IntegrationMethod, integration.PayloadFormatVersion, integration.TimeoutInMillis], ['AWS_PROXY', 'POST', '2.0', 15000], 'IntegrationType-IntegrationMethod-PayloadFormatVersion-TimeoutInMillis'); same(integration.IntegrationUri, `arn:aws:apigateway:${region}:lambda:path/2015-03-31/functions/${b.api_alias_arn}/invocations`, 'IntegrationUri');
  for (const route of routes.Items!) { const secured = !route.RouteKey!.startsWith('ANY ') && route.RouteKey!.includes('/v2/'); same(route.AuthorizationType, secured ? 'JWT' : 'NONE', 'AuthorizationType'); same(route.Target, `integrations/${integration.IntegrationId}`, 'Target'); if (secured) { same(route.AuthorizerId, authorizer.AuthorizerId, 'AuthorizerId'); same(route.AuthorizationScopes, [route.RouteKey!.startsWith('GET ') ? 'reminder-api/read' : 'reminder-api/write'], 'AuthorizationScopes'); } }
  state.readbackPhase = 'gateway-stage';
  const stage = await read(options => state.api.send(new GetStageCommand({ ApiId: b.api_id!, StageName: '$default' }), options)); same([stage.AutoDeploy, stage.DefaultRouteSettings?.ThrottlingRateLimit, stage.DefaultRouteSettings?.ThrottlingBurstLimit, stage.DefaultRouteSettings?.DetailedMetricsEnabled], [true, 20, 40, false], 'AutoDeploy-DefaultRouteSettings-ThrottlingRateLimit-ThrottlingBurstLimit-DetailedMetricsEnabled'); same(stage.AccessLogSettings?.DestinationArn, `arn:aws:logs:${region}:${account}:log-group:${b.gateway_log_group}`, 'AccessLogSettings-DestinationArn'); same(JSON.parse(stage.AccessLogSettings?.Format ?? '{}'), { requestId: '$context.requestId', routeKey: '$context.routeKey', status: '$context.status', responseLength: '$context.responseLength' }, 'parse-AccessLogSettings-Format');
  state.readbackPhase = 'logs';
  for (const [groupKind, group] of [['api', b.api_log_group!], ['cleanup', b.cleanup_log_group!], ['gateway', b.gateway_log_group!]]) { state.readbackPhase = `logs-${groupKind}-DescribeLogGroups`; const groups = await read(options => fixture.clients.logs.send(new DescribeLogGroupsCommand({ logGroupNamePrefix: group }), options)); same(groups.logGroups?.find(g => g.logGroupName === group)?.retentionInDays, 30, 'logGroups-logGroupName-retentionInDays'); }
  state.readbackPhase = 'scheduler';
  const schedule = await read(options => state.scheduler.send(new GetScheduleCommand({ Name: `${production}-cleanup`, GroupName: `${production}-cleanup` }), options)); same([schedule.State, schedule.ScheduleExpression, schedule.ScheduleExpressionTimezone, schedule.FlexibleTimeWindow?.Mode, schedule.Target?.Arn, schedule.Target?.RoleArn, schedule.Target?.RetryPolicy], ['DISABLED', 'cron(0 3 * * ? *)', 'UTC', 'OFF', b.cleanup_alias_arn!, b.scheduler_role_arn!, { MaximumRetryAttempts: 2, MaximumEventAgeInSeconds: 3600 }], 'State-ScheduleExpression-ScheduleExpressionTimezone-FlexibleTimeWindow-Mode-Target-Arn-RoleArn');
  state.readbackPhase = 'alarms';
  const alarms = await read(options => fixture.clients.cloudwatch.send(new DescribeAlarmsCommand({ AlarmNamePrefix: production }), options)); requireSetting(!alarms.NextToken && alarms.MetricAlarms?.length === 9, 'NextToken-MetricAlarms');
  const alarmSpecs = [
    ['gateway-5xx', 'AWS/ApiGateway', '5xx', { ApiId: b.api_id! }],
    ['api-errors', 'AWS/Lambda', 'Errors', { FunctionName: `${production}-api` }],
    ['api-throttles', 'AWS/Lambda', 'Throttles', { FunctionName: `${production}-api` }],
    ['api-duration', 'AWS/Lambda', 'Duration', { FunctionName: `${production}-api` }],
    ['cleanup-errors', 'AWS/Lambda', 'Errors', { FunctionName: `${production}-cleanup` }],
    ['cleanup-async-dropped', 'AWS/Lambda', 'AsyncEventsDropped', { FunctionName: `${production}-cleanup` }],
    ['cleanup-incomplete', 'ReminderServer', 'CleanupIncomplete', { Environment: 'production' }],
    ['scheduler-dropped', 'AWS/Scheduler', 'InvocationDroppedCount', { ScheduleGroup: `${production}-cleanup` }],
    ['cleanup-heartbeat', 'ReminderServer', 'CleanupHeartbeat', { Environment: 'production' }],
  ] as const;
  for (const [name, namespace, metric, dimensions] of alarmSpecs) {
    state.readbackPhase = `alarms-${name}-fields`;
    const alarm = alarms.MetricAlarms!.find(a => a.AlarmName === `${production}-${name}`); requireSetting(!!alarm, 'required-public-definition-fields');
    const duration = name === 'api-duration'; const heartbeat = name === 'cleanup-heartbeat'; const incomplete = name === 'cleanup-incomplete';
    same([alarm!.Namespace, alarm!.MetricName, Object.fromEntries((alarm!.Dimensions ?? []).map(d => [d.Name!, d.Value!])), alarm!.ComparisonOperator, alarm!.Threshold, alarm!.Period, alarm!.EvaluationPeriods, alarm!.Statistic, alarm!.ExtendedStatistic, alarm!.EvaluateLowSampleCountPercentile, alarm!.TreatMissingData, alarm!.ActionsEnabled], [namespace, metric, dimensions, duration ? 'GreaterThanThreshold' : heartbeat ? 'LessThanThreshold' : 'GreaterThanOrEqualToThreshold', duration ? 2000 : 1, heartbeat ? 86400 : incomplete ? 3600 : 300, duration ? 2 : 1, duration ? undefined : incomplete ? 'Maximum' : 'Sum', duration ? 'p95' : undefined, duration ? 'ignore' : undefined, 'notBreaching', !heartbeat], 'Namespace-MetricName-fromEntries-Dimensions-Name-Value-ComparisonOperator-Threshold');
    requireSetting(!(alarm!.AlarmActions?.length || alarm!.OKActions?.length || alarm!.InsufficientDataActions?.length), 'AlarmActions-OKActions-InsufficientDataActions');
  }

  state.readbackPhase = 'iam';
  state.readbackPhase = 'iam-GetOpenIDConnectProvider';
  const oidc = await read(options => state.iam.send(new GetOpenIDConnectProviderCommand({ OpenIDConnectProviderArn: `arn:aws:iam::${account}:oidc-provider/token.actions.githubusercontent.com` }), options)); same(oidc.Url?.replace(/^https:\/\//, ''), 'token.actions.githubusercontent.com', 'Url-replace'); same(oidc.ClientIDList, ['sts.amazonaws.com'], 'ClientIDList');
  for (const kind of ['artifact', 'plan', 'apply', 'api', 'cleanup', 'scheduler']) {
    const github = ['artifact', 'plan', 'apply'].includes(kind);
    const RoleName = `${prefix}-${github ? 'github' : 'production'}-${kind}`;
    state.readbackPhase = `iam-${kind}-GetRole-trust-boundary`;
    const role = (await read(options => state.iam.send(new GetRoleCommand({ RoleName }), options))).Role;
    same([role?.RoleName, role?.Arn, role?.MaxSessionDuration], [RoleName, `arn:aws:iam::${account}:role/${RoleName}`, 3600], 'RoleName-Arn-MaxSessionDuration');
    requireSetting(policiesEqual(role?.AssumeRolePolicyDocument, github ? expected.githubTrust[kind] : expected.runtimeTrust[kind]), 'full-policy-semantics');
    const boundary = github ? undefined : `arn:aws:iam::${account}:policy/${production}-${kind}-ceiling`;
    same(role?.PermissionsBoundary?.PermissionsBoundaryArn, boundary, 'PermissionsBoundary-PermissionsBoundaryArn');
    state.readbackPhase = `iam-${kind}-ListRolePolicies`;
    const policies = await read(options => state.iam.send(new ListRolePoliciesCommand({ RoleName }), options)); requireSetting(!policies.IsTruncated, 'IsTruncated');
    const PolicyName = github ? `production-${kind}` : kind === 'scheduler' ? `${production}-cleanup-invoke` : `${production}-${kind}-runtime`;
    same(policies.PolicyNames, [PolicyName], 'PolicyNames');
    state.readbackPhase = `iam-${kind}-GetRolePolicy-semantics`;
    const policy = await read(options => state.iam.send(new GetRolePolicyCommand({ RoleName, PolicyName }), options));
    requireSetting(policiesEqual(policy.PolicyDocument, github ? expected.githubPolicies[kind] : kind === 'scheduler' ? expected.schedulerPolicy : expected.platformPolicies[kind]), 'full-policy-semantics');
    state.readbackPhase = `iam-${kind}-ListAttachedRolePolicies`;
    const attached = await read(options => state.iam.send(new ListAttachedRolePoliciesCommand({ RoleName }), options)); requireSetting(!attached.IsTruncated, 'IsTruncated');
    const attachedExpected = kind === 'plan' || kind === 'apply' ? [`arn:aws:iam::${account}:policy/${prefix}-github-production-read`] : [];
    same(attached.AttachedPolicies?.map(policy => policy.PolicyArn).sort() ?? [], attachedExpected, 'AttachedPolicies-PolicyArn');
  }
  for (const kind of ['api', 'cleanup', 'scheduler', 'production-read']) {
    const PolicyArn = `arn:aws:iam::${account}:policy/${kind === 'production-read' ? `${prefix}-github-production-read` : `${production}-${kind}-ceiling`}`;
    state.readbackPhase = `iam-${kind}-GetPolicy`;
    const p = await read(options => state.iam.send(new GetPolicyCommand({ PolicyArn }), options)); same(p.Policy?.Arn, PolicyArn, 'Policy-Arn'); requireSetting(!!p.Policy?.DefaultVersionId, 'Policy-DefaultVersionId');
    state.readbackPhase = `iam-${kind}-GetPolicyVersion-semantics`;
    const version = await read(options => state.iam.send(new GetPolicyVersionCommand({ PolicyArn, VersionId: p.Policy!.DefaultVersionId! }), options));
    requireSetting(policiesEqual(version.PolicyVersion?.Document, kind === 'production-read' ? expected.productionRead : expected.runtimeCeiling[kind]), 'full-policy-semantics');
  }
  state.readbackPhase = 'complete';
  state.settingsComplete = true;
}
export async function createRunFixture(stack: ProvisionedStack, evidence: Evidence, controls: { budget?: RunBudget; signal?: AbortSignal } = {}): Promise<E2EFixture> {
  if (stack.constructionOutputs.length !== 4) throw new Error('PREREQUISITE_FAILED');
  const s3 = localS3(stack.target); const originalHandler = s3.config.requestHandler;
  const boundedHandler = { async handle(request: Parameters<typeof originalHandler.handle>[0], options: HttpHandlerOptions = {}) {
    delete state.readbackSdkStatus;
    const remaining = controls.budget ? (state.disposed ? controls.budget.cleanupRemaining() : controls.budget.allow("http")) : 30_000;
    if (remaining <= 0 || (!state.disposed && controls.signal?.aborted)) throw new Error("FIXTURE_BUDGET_EXHAUSTED");
    const signal = !state.disposed && controls.signal ? (options.abortSignal && "addEventListener" in options.abortSignal ? AbortSignal.any([controls.signal, options.abortSignal as AbortSignal]) : controls.signal) : options.abortSignal;
    const result = await originalHandler.handle(request, { ...options, requestTimeout: Math.min(remaining, options.requestTimeout ?? 30_000), ...(signal ? { abortSignal: signal } : {}) }); state.readbackSdkStatus = result.response.statusCode;
    if (state.readbackPhase.endsWith('GetAlias') || state.readbackPhase === 'lambda-api-GetPolicy-production') {
      const observed = await observeLambdaResponse(result.response.body, state.readbackPhase); state.readbackWire = observed.safe; result.response.body = observed.body;
    }
    return result;
  } }; s3.config.requestHandler = boundedHandler;
  const options = { endpoint: stack.target.endpoint, region: stack.target.region, credentials: { accessKeyId: 'local', secretAccessKey: 'local' }, maxAttempts: 1, requestHandler: s3.config.requestHandler };
  const clients = { s3, dynamodb: DynamoDBDocumentClient.from(new DynamoDBClient(options)), lambda: new LambdaClient(options), cloudwatch: new CloudWatchClient(options), logs: new CloudWatchLogsClient(options), sts: new STSClient(options) };
  const b = stack.bindings; const observer = sdkObserver(clients.logs, { api: b.api_log_group!, cleanup: b.cleanup_log_group!, gateway: b.gateway_log_group! });
  const state: RunFixtureState = { stack, evidence, ...controls, observer, cognito: new CognitoIdentityProviderClient(options), api: new ApiGatewayV2Client(options), scheduler: new SchedulerClient(options), iam: new IAMClient(options), lastInput: 0, outstanding: 0, cleanupIntervals: [], suiteActive: false, suite: 'fixture-smoke', disposed: false, readbackObserved: {}, readbackPhase: 'not-started', settingsComplete: false, smokeComplete: false };
  const config = loadConfig({ AWS_REGION: stack.target.region, REMINDERS_TABLE: b.reminders_table!, OWNER_STATE_TABLE: b.owner_state_table!, IMAGE_JOBS_TABLE: b.image_jobs_table!, IMAGES_BUCKET: b.images_bucket!, EXPECTED_API_ID: b.api_id!, EXPECTED_API_STAGE: '$default', COGNITO_ISSUER: b.cognito_issuer!, COGNITO_CLIENT_ID: b.cognito_client_id! });
  const fixture: E2EFixture = { target: stack.target, prefix: b.prefix!, config, artifact: stack.artifact, manifest: evidenceContext(evidence).manifest, clients, auth: { async login() { throw new Error('CASE_AUTH_REQUIRED'); }, async refresh() { throw new Error('CASE_AUTH_REQUIRED'); } }, async request(path, options = {}) { if ((state.budget && !state.budget.allow("http")) || state.signal?.aborted) throw new Error("FIXTURE_BUDGET_EXHAUSTED"); if (!path.startsWith('/') || path.startsWith('//') || new URL(path, b.api_base_url!).origin !== new URL(b.api_base_url!).origin) throw new Error('LOCAL_TARGET_REJECTED'); state.outstanding++; state.lastInput = Date.now(); const headers = { ...options.headers, ...(options.token ? { authorization: `Bearer ${options.token}` } : {}) }; try { return await localRequest(stack.target, gatewayRequestUrl(b.api_base_url!, path), { headers, ...(state.signal ? { signal: state.signal } : {}), ...(options.method ? { method: options.method } : {}), ...(options.body !== undefined ? { body: options.body } : {}) }); } finally { state.outstanding--; } }, async setPublication(published) { await clients.dynamodb.send(new PutCommand({ TableName: config.ownerStateTable, Item: { pk: 'GLOBAL', sk: 'PUBLICATION', published, runId: evidence.runId } })); const result = await clients.dynamodb.send(new GetCommand({ TableName: config.ownerStateTable, Key: { pk: 'GLOBAL', sk: 'PUBLICATION' }, ConsistentRead: true })); same(result.Item?.published, published); }, async resetSuite() { return resetOwnedSuite(fixture); }, async dispose() { if (state.disposed) throw new Error('CLEANUP_REJECTED'); state.disposed = true; const sdkIntents = evidenceContext(evidence).manifest.resources.filter(resource => ['sdk-user', 'sdk-control'].includes(resource.kind) && !resource.removed).map(resource => resource.id);
    try { const terraform = await stack.destroy(); const absence = await verifyOwnedSdkAbsence(fixture, sdkIntents); const pastErrors = state.sdkCleanup?.errors ?? 0; const guardError = state.sdkCleanup && (state.sdkCleanup.errors || state.sdkCleanup.leaks) ? Math.min(1, terraform.errors) : 0;
      const result = { attempted: terraform.attempted + sdkIntents.length, succeeded: terraform.succeeded + absence.absent, errors: terraform.errors + Math.max(pastErrors, absence.exists + absence.unverified) - guardError, leaks: terraform.leaks + absence.exists };
      await writeFile(join(evidenceContext(evidence).directory, 'sdk-independent-absence.json'), JSON.stringify({ ...absence, pastErrors, result }, null, 2) + '\n', { mode: 0o600 }); return result;
    } finally { Object.values(clients).forEach(c => c.destroy()); state.cognito.destroy(); state.api.destroy(); state.scheduler.destroy(); state.iam.destroy(); } } };
  fixtureStates.set(fixture, state);
  stack.setQuiescenceGuard(async () => { const quiescent = state.outstanding === 0 && state.cleanupIntervals.every(interval => interval.completed); const cleanup = await cleanupOwnedSdk(fixture); state.sdkCleanup = cleanup; requireSetting(quiescent); if (cleanup.errors || cleanup.leaks) throw new Error('SDK_CLEANUP_FAILED'); });
  return fixture;
}
export async function createFixture(options: SuiteOptions, runFixture: E2EFixture): Promise<SuiteFixture> { const state = fixtureState(runFixture); if (!state.settingsComplete || !state.smokeComplete || state.suiteActive || state.disposed) throw new Error('PREREQUISITE_FAILED'); state.suiteActive = true; state.suite = options.suite; const { dispose: _dispose, ...view } = runFixture; void _dispose; fixtureStates.set(view, state); suiteLogStates.set(view, { observer: state.observer, pending: [], cleanup: new Map(), completions: state.cleanupIntervals, lastInput: Date.now() }); await view.setPublication(options.publication); view.auth = await createCaseAuth(view, `${options.suite}-default`); return view; }
export async function invokeCleanup(fixture: SuiteFixture, event: unknown = {}): Promise<CleanupCompletion> {
  const state = fixtureState(fixture); const b = state.stack.bindings; const payload = JSON.stringify(event); if (!payload || Buffer.byteLength(payload) > 1024) throw new Error("CLEANUP_EVENT_REJECTED");
  const schedule = await state.scheduler.send(new GetScheduleCommand({ Name: `${b.prefix}-production-cleanup`, GroupName: `${b.prefix}-production-cleanup` }));
  requireSetting(schedule.State === 'DISABLED' && !state.cleanupIntervals.some(interval => !interval.completed));
  const storageBefore = await snapshotOwnedStorage(fixture); const interval: CleanupCompletion = { since: Date.now(), until: 0, completed: false }; state.cleanupIntervals.push(interval);
  const result = await fixture.clients.lambda.send(new InvokeCommand({ FunctionName: b.cleanup_alias_arn!, InvocationType: 'RequestResponse', Payload: Buffer.from(payload) })); interval.until = Date.now(); interval.completed = true; interval.status = result.StatusCode ?? 0;
  if (result.Payload) {
    const parsed: unknown = JSON.parse(Buffer.from(result.Payload.buffer, result.Payload.byteOffset, result.Payload.byteLength).toString());
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const safe = parsed as Record<string, unknown>;
      if (Number.isSafeInteger(safe.evaluated) && Number(safe.evaluated) >= 0 && Number.isSafeInteger(safe.deletes) && Number(safe.deletes) >= 0 && typeof safe.incomplete === 'boolean' && typeof safe.skippedUnpublished === 'boolean') interval.result = { evaluated: Number(safe.evaluated), deletes: Number(safe.deletes), incomplete: safe.incomplete, skippedUnpublished: safe.skippedUnpublished };
    }
  }
  interval.storageUnchanged = storageBefore === await snapshotOwnedStorage(fixture);
  requireSetting(result.StatusCode === 200 && !result.FunctionError && !!interval.result); return interval;
}
export type SmokeResult = { statuses: number[]; logs: boolean; cleanupLogs: boolean; gatewayLogs: boolean; gatewayObserved: number; rejection: boolean; unchanged: boolean; cleanupInvoke: boolean };
export async function fixtureSmoke(fixture: E2EFixture, input?: (status: number) => void): Promise<SmokeResult> {
  const state = fixtureState(fixture); requireSetting(state.settingsComplete); const expectations: LogExpectation[] = []; const statuses: number[] = []; state.smokeObserved = { statuses, logs: false, cleanupLogs: false, gatewayLogs: false, gatewayObserved: 0, rejection: false, unchanged: false, cleanupInvoke: false }; let refused: LogExpectation | undefined; let unchanged = false; let beforeState = ''; let refusalEnd = 0;
  for (const [path, expected] of [['/readyz', 503], ['/healthz', 200], ['/readyz', 200], ['/v2/reminders', 401], ['/healthz', 200]] as const) {
    if (statuses.length === 2) await fixture.setPublication(true);
    if (path === '/v2/reminders') beforeState = await snapshotOwnedStorage(fixture);
    const since = Date.now(); const response = await fixture.request(path); input?.(response.status); const until = Date.now(); statuses.push(response.status);
    const requestId = response.headers.get('x-request-id') ?? response.headers.get('apigw-requestid') ?? response.headers.get('x-amzn-requestid');
    if (path === '/v2/reminders') { unchanged = beforeState === await snapshotOwnedStorage(fixture); refusalEnd = until; refused = { service: 'api', requestId: requestId ?? 'uncorrelated-gateway-refusal', since, until, status: response.status, mode: 'absent' }; }
    else if (requestId) expectations.push({ service: 'api', requestId, since, until, status: expected, mode: 'present' });
  }
  let cleanupInvoke = false; let interval = { since: Date.now(), until: Date.now() }; try { interval = await invokeCleanup(fixture); cleanupInvoke = true; } catch { interval = state.cleanupIntervals.at(-1) ?? interval; }
  const checks = expectations.map((expectation, index) => ({ caseId: `smoke${index}`, assertion: 'delivered', expectation }));
  const before = expectations.filter(e => (e.until ?? Infinity) <= (refused?.since ?? 0) && e.status === 200).at(-1); const after = expectations.find(e => e.since >= refusalEnd && e.status === 200);
  const absent = refused && before && after ? { caseId: 'refusal', assertion: 'absent', expectation: refused, controls: { before, after } } : undefined;
  const results = await state.observer.flush([...checks, ...(absent ? [absent] : [])], Date.now()); // The one shared flush is the only delivery wait.

  const logs = expectations.length === 4 && results.filter(result => result.caseId !== 'refusal').every(result => result.matched); const cleanupLogs = cleanupInvoke && state.observer.cleanupMatch({ since: interval.since, until: interval.until, status: 200, evaluated: 0, deletes: 0 }, state.cleanupIntervals.find(completion => completion.since === interval.since)); const gatewayObserved = state.observer.safeCounts().gateway; const gatewayLogs = expectations.some(expectation => expectation.status === 200 && state.observer.match({ ...expectation, service: "gateway" }));
  const rejection = statuses[3] === 401 && unchanged && results.find(result => result.caseId === 'refusal')?.matched === true;
  await fixture.setPublication(false); state.smokeComplete = logs && cleanupLogs && rejection && statuses.every((status, index) => status === [503, 200, 200, 401, 200][index]);
  const measured = { statuses, logs, cleanupLogs, gatewayLogs, gatewayObserved, rejection, unchanged, cleanupInvoke }; state.smokeObserved = measured; return measured;
}

export function assertGatewayCors(actual: Cors | undefined): void {
same({ ...actual, MaxAge: actual?.MaxAge ?? 0, AllowMethods: actual?.AllowMethods?.slice().sort(), ExposeHeaders: actual?.ExposeHeaders?.slice().sort() }, { AllowOrigins: ['https://extension.example.test'], AllowMethods: ['DELETE', 'GET', 'OPTIONS', 'PATCH', 'POST', 'PUT'], AllowHeaders: ['authorization', 'content-type', 'if-match'], ExposeHeaders: ['Allow', 'ETag', 'Location', 'Retry-After', 'X-Request-Id'], AllowCredentials: false, MaxAge: 0 });
}

export function gatewayRequestUrl(base: string, path: string): URL {
  const endpoint = new URL(base);
  if (!path.startsWith('/') || path.startsWith('//') || endpoint.search || endpoint.hash || endpoint.username || endpoint.password) throw new Error('LOCAL_TARGET_REJECTED');
  const prefix = endpoint.pathname.replace(/\/$/, ''); const url = new URL(prefix + path, endpoint.origin);
  if (url.origin !== endpoint.origin || (prefix && !url.pathname.startsWith(prefix + '/'))) throw new Error('LOCAL_TARGET_REJECTED'); return url;
}

export function assertPinnedArtifact(versions: Pick<ListObjectVersionsCommandOutput, 'IsTruncated' | 'Versions' | 'DeleteMarkers'>, head: Pick<HeadObjectCommandOutput, 'VersionId' | 'ChecksumSHA256' | 'ContentLength'>, receipt: { version: string; sha: string; bytes: number }): void {
  requireSetting(!versions.IsTruncated && versions.Versions?.length === 1 && !versions.DeleteMarkers?.length);
  same([versions.Versions![0]!.VersionId, versions.Versions![0]!.IsLatest, head.VersionId, head.ChecksumSHA256, head.ContentLength], [receipt.version, true, receipt.version, receipt.sha, receipt.bytes]);
}
export function assertGatewayPermission(policy: string | undefined, identity: { account: string; apiId: string; alias: string }): void {
  const doc = JSON.parse(policy ?? '{}') as Record<string, unknown>; const { Id: _id, ...semantics } = doc; void _id;
  requireSetting(policiesEqual(semantics, { Version: '2012-10-17', Statement: [{ Sid: 'ProductionGatewayOnly', Effect: 'Allow', Principal: { Service: 'apigateway.amazonaws.com' }, Action: 'lambda:InvokeFunction', Resource: identity.alias, Condition: { StringEquals: { 'AWS:SourceAccount': identity.account }, ArnLike: { 'AWS:SourceArn': `arn:aws:execute-api:ap-northeast-1:${identity.account}:${identity.apiId}/$default/*/*` } } }] }));
}
export async function readAliasPolicy(client: LambdaClient, name: string, alias: string, rejected: (failure: { code: string; status?: number }) => void, options: HttpHandlerOptions = {}): Promise<{ Policy?: string | undefined }> {
  if (!/^e2e-[a-f0-9]{8}-production-api$/.test(name) || !new RegExp(`^arn:aws:lambda:ap-northeast-1:[0-9]{12}:function:${name}:production$`).test(alias)) throw new Error('ALIAS_POLICY_REJECTED');
  try { return await client.send(new GetLambdaPolicyCommand({ FunctionName: name, Qualifier: 'production' }), options); }
  catch (error) {
    const failure = error as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (failure.name !== 'ResourceNotFoundException') throw error;
    const status = failure.$metadata?.httpStatusCode;
    rejected({ code: 'ResourceNotFoundException', ...(status !== undefined && Number.isInteger(status) && status >= 100 && status <= 599 ? { status } : {}) });
    // Both documented formats explicitly identify the production alias.
    return client.send(new GetLambdaPolicyCommand({ FunctionName: alias }), options);
  }
}

function valueType(value: unknown): string { return value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value; }
export function classifyAliasVersion(value: unknown): { present: boolean; type: string; classification: string } { return { present: value !== undefined, type: valueType(value), classification: value === undefined ? 'missing' : value === '$LATEST' ? 'latest' : value === '' ? 'empty' : typeof value === 'string' && /^\d+$/.test(value) ? 'published-numeric' : 'other' }; }

/** Inspect only the two measured failing Lambda fields; retain bytes unchanged for the pinned SDK. */
export async function observeLambdaResponse(body: Readable, phase: string): Promise<{ body: Readable; safe: Record<string, unknown> }> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of body) { const bytes = Buffer.from(chunk as Uint8Array); size += bytes.length; if (size > 1_048_576) throw new Error('SETTINGS_RESPONSE_TOO_LARGE'); chunks.push(bytes); }
  const bytes = Buffer.concat(chunks); let safe: Record<string, unknown>;
  try {
    const doc = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
    if (phase.endsWith('GetAlias')) safe = { codec: 'json', aliasVersion: classifyAliasVersion(doc.FunctionVersion) };
    else {
      safe = { codec: 'json', policyPresent: doc.Policy !== undefined, policyType: valueType(doc.Policy) };
      try { const policy = JSON.parse(typeof doc.Policy === 'string' ? doc.Policy : '') as { Version?: unknown; Statement?: { Sid?: unknown }[] }; safe.policyCodec = 'json'; safe.policyVersion = policy.Version === '2012-10-17'; safe.statementCount = Array.isArray(policy.Statement) ? policy.Statement.length : -1; safe.qualifiedSid = Array.isArray(policy.Statement) && policy.Statement.some(statement => statement.Sid === 'ProductionGatewayOnly'); }
      catch { safe.policyCodec = 'invalid'; }
    }
  } catch { safe = { codec: 'invalid' }; }
  return { body: Readable.from([bytes]), safe };
}

/** Fixed safe classification of the measured SourceAccount boundary, never its value. */
export function sourceAccountProjection(policy: unknown, expected?: string): Record<string, boolean | number | string> {
  const statements = (policy as { Statement?: { Sid?: string; Condition?: Record<string, Record<string, unknown>> }[] })?.Statement;
  const condition = Array.isArray(statements) ? statements.find(statement => statement.Sid === 'ProductionGatewayOnly')?.Condition : undefined;
  const matches = Object.entries(condition ?? {}).flatMap(([operator, values]) => values && typeof values === 'object' ? Object.entries(values).filter(([key]) => key.toLowerCase() === 'aws:sourceaccount').map(([key, value]) => ({ operator, key, value })) : []);
  const match = matches[0]; return { sourceAccountEntries: matches.length, sourceAccountOperator: match ? ['StringEquals', 'StringLike'].includes(match.operator) ? match.operator : 'other' : 'missing', sourceAccountKeyCase: match ? match.key === 'AWS:SourceAccount' ? 'aws-api-canonical' : match.key === 'aws:sourceaccount' ? 'lowercase' : 'other-case' : 'missing', sourceAccountType: valueType(match?.value), ...(expected ? { sourceAccountMatches: matches.length === 1 && policiesEqual({ Condition: { [match!.operator]: { [match!.key]: match!.value } } }, { Condition: { StringEquals: { 'AWS:SourceAccount': expected } } }) } : {}) };
}
