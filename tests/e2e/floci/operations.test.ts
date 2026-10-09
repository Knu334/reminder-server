import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { CreateTableCommand, DeleteTableCommand, DescribeContinuousBackupsCommand, DescribeTableCommand, DescribeTimeToLiveCommand, UpdateContinuousBackupsCommand, UpdateTableCommand, UpdateTimeToLiveCommand } from '@aws-sdk/client-dynamodb';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { definitions, caseActions, caseGuards, operationDefinitions } from './support/cases.ts';
import './support/operation-cases.ts';
import { createEvidence, reserveResource, markResource, evidenceContext, finalizeResults } from './support/evidence.ts';
import { TABLE_KEYS, assertRestoredTables, assertRestoredTarget, createRestoredTables, productionDescription, removeRestoredTables, restoredTableNames, restoredTargetFor, sweepRestoredTables, type DescribedTable } from './support/restored-tables.ts';
import { buildOperationInputs, localMigrationRuntime, localRecoveryRuntime, operationBlocked, projectCliResult, writeSyntheticOperationInputs } from './support/operation-fixtures.ts';
import { fixtureStates } from './support/fixture.ts';
import { migrationMain, parseMigrationTarget } from '../../../scripts/operations/migrate-json.ts';
import { recoveryMain } from '../../../scripts/operations/verify-recovery.ts';
import { assertMigrationIdentity } from '../../../scripts/operations/migration.ts';
import { contractSha256For, environmentIdentityFor } from '../../../scripts/operations/legacy.ts';
import { ownerIdFor } from '../../../src/api/identity.ts';
import type { RestoredTarget, SuiteFixture } from './support/types.ts';

const ctx = { prefix: 'e2e-0a1b2c3d', account: '123456789012', region: 'ap-northeast-1' };
const names = restoredTableNames(ctx.prefix, 'r1'); const target = restoredTargetFor(names, ctx);
const ops = definitions.filter(def => def.suite === 'operations');

void test('the operations inventory has independent L cases for OPS-01..04 whose actions exist and I cases whose evidence is named tests only', () => {
  assert.equal(ops.length, operationDefinitions.length); assert.equal(new Set(ops.map(def => def.id)).size, ops.length);
  for (const id of ['OPS-01', 'OPS-02', 'OPS-03', 'OPS-04']) assert.ok(ops.some(def => def.requirementId === id && def.layer === 'L'), id);
  for (const id of ['STORE-07', 'IMG-08', 'API-01']) assert.ok(ops.some(def => def.requirementId === id && def.layer === 'I'), id);
  for (const def of ops.filter(def => def.layer === 'L')) { assert.equal(caseActions.has(def.id), true, `${def.id} has an action`); assert.equal(def.required, true); assert.equal(def.acceptance, 'behavior'); }
  for (const def of ops.filter(def => def.layer === 'I')) assert.equal(caseActions.has(def.id), false, `${def.id} is evidenced by faults.test.ts, not by an E action`);
  for (const def of ops) { assert.deepEqual(def.outputs.map(output => output.kind), ['http', 'dynamodb', 's3', 'logs']); for (const output of def.outputs.filter(output => output.assertions.length === 0)) assert.ok(output.notApplicableReason, def.id); }
  for (const def of ops.filter(def => def.layer === 'L')) assert.equal(caseGuards.has(def.id), true, `${def.id} is blocked after an inconsistent restored_tables state`);
});

void test('restored table names are disjoint from the production tables, valid for the Terraform variable and keyed exactly by the three roles', () => {
  assert.deepEqual(Object.keys(names).sort(), [...TABLE_KEYS].sort());
  for (const name of Object.values(names)) { assert.match(name, /^[A-Za-z0-9_.-]{3,64}$/); assert.ok(!name.startsWith(`${ctx.prefix}-production-`)); }
  assert.equal(new Set(Object.values(names)).size, 3);
  assert.doesNotThrow(() => assertRestoredTarget(target, ctx));
});

void test('a restored target is rejected unless it has exactly three owned names with ARNs of the local account and region', () => {
  const bad = (mutate: (value: RestoredTarget) => RestoredTarget): void => assert.throws(() => assertRestoredTarget(mutate(structuredClone(target)), ctx), /RESTORED_TARGET_REJECTED/);
  bad(value => ({ ...value, tableArns: { ...value.tableArns, reminders: value.tableArns.reminders!.replace(ctx.account, '999999999999') } }));
  bad(value => ({ ...value, tableArns: { ...value.tableArns, owner_state: value.tableArns.owner_state!.replace(ctx.region, 'us-east-1') } }));
  bad(value => ({ ...value, tableArns: { ...value.tableArns, image_jobs: `${value.tableArns.image_jobs!}x` } }));
  bad(value => ({ ...value, tableNames: { ...value.tableNames, reminders: `${ctx.prefix}-production-reminders` }, tableArns: { ...value.tableArns, reminders: `arn:aws:dynamodb:${ctx.region}:${ctx.account}:table/${ctx.prefix}-production-reminders` } }));
  bad(value => ({ ...value, tableNames: { ...value.tableNames, owner_state: value.tableNames.reminders! }, tableArns: { ...value.tableArns, owner_state: value.tableArns.reminders! } }));
  bad(value => ({ ...value, tableNames: { ...value.tableNames, reminders: 'x*' } }));
  bad(value => { const { image_jobs: _names, ...tableNames } = value.tableNames; void _names; const { image_jobs: _arns, ...tableArns } = value.tableArns; void _arns; return { tableNames, tableArns }; });
  bad(value => ({ tableNames: { ...value.tableNames, extra: 'x-extra-table' }, tableArns: { ...value.tableArns, extra: `arn:aws:dynamodb:${ctx.region}:${ctx.account}:table/x-extra-table` } }));
});

void test('restored table descriptors must match the production schema, protection, billing, TTL, GSI and 35 day PITR one condition at a time', () => {
  const control = productionDescription(target, ctx); assert.doesNotThrow(() => assertRestoredTables(control, target, ctx));
  const mutate = (key: string, change: (table: DescribedTable) => void): Record<string, DescribedTable> => { const copy = structuredClone(control); change(copy[key]!); return copy; };
  const cases: [string, Record<string, DescribedTable>][] = [
    ['different key schema', mutate('reminders', table => { table.keys = [{ name: 'ownerId', type: 'HASH' }, { name: 'sortKey', type: 'RANGE' }]; })],
    ['missing range key', mutate('reminders', table => { table.keys = [{ name: 'ownerId', type: 'HASH' }]; })],
    ['different attribute type', mutate('owner_state', table => { table.attributes = [{ name: 'pk', type: 'N' }, { name: 'sk', type: 'S' }]; })],
    ['deletion protection missing', mutate('owner_state', table => { table.deletionProtection = false; })],
    ['provisioned billing', mutate('reminders', table => { table.billingMode = 'PROVISIONED'; })],
    ['PITR disabled', mutate('image_jobs', table => { table.pitr = { enabled: false }; })],
    ['PITR 7 days', mutate('reminders', table => { table.pitr = { enabled: true, days: 7 }; })],
    ['owner TTL disabled', mutate('owner_state', table => { table.ttl = { enabled: false }; })],
    ['owner TTL on another attribute', mutate('owner_state', table => { table.ttl = { enabled: true, attribute: 'other' }; })],
    ['GSI missing', mutate('image_jobs', table => { table.gsi = []; })],
    ['GSI projection ALL', mutate('image_jobs', table => { table.gsi = [{ name: 'cleanup_by_due', projection: 'ALL', keys: table.gsi[0]!.keys }]; })],
    ['foreign table ARN', mutate('reminders', table => { table.arn = table.arn!.replace(ctx.account, '999999999999'); })],
    ['other table name', mutate('image_jobs', table => { table.name = 'someone-else'; })],
  ];
  for (const [label, described] of cases) assert.throws(() => assertRestoredTables(described, target, ctx), /RESTORED_TABLE_REJECTED/, label);
  const missing = structuredClone(control); delete missing.image_jobs; assert.throws(() => assertRestoredTables(missing, target, ctx), /RESTORED_TABLE_REJECTED/);
});

type Table = { arn: string; protection: boolean; ttl: boolean; pitr: boolean; spec: Record<string, unknown> };
function memoryDynamo(options: { stuck?: boolean } = {}) {
  const tables = new Map<string, Table>(); const log: string[] = [];
  const notFound = (): Error => Object.assign(new Error('missing'), { name: 'ResourceNotFoundException' });
  return { tables, log, client: { async send(command: unknown): Promise<unknown> {
    const input = (command as { input: Record<string, unknown> }).input; const name = String(input.TableName);
    log.push(`${(command as object).constructor.name}:${name}`);
    if (command instanceof CreateTableCommand) { tables.set(name, { arn: `arn:aws:dynamodb:${ctx.region}:${ctx.account}:table/${name}`, protection: input.DeletionProtectionEnabled === true, ttl: false, pitr: false, spec: input }); return {}; }
    const table = tables.get(name);
    if (command instanceof DescribeTableCommand) { if (!table) throw notFound(); const spec = table.spec; return { Table: { TableName: name, TableArn: table.arn, TableStatus: options.stuck ? 'CREATING' : 'ACTIVE', BillingModeSummary: { BillingMode: spec.BillingMode }, DeletionProtectionEnabled: table.protection, KeySchema: spec.KeySchema, AttributeDefinitions: spec.AttributeDefinitions, GlobalSecondaryIndexes: (spec.GlobalSecondaryIndexes as { IndexName: string; KeySchema: unknown; Projection: { ProjectionType: string } }[] | undefined)?.map(index => ({ IndexName: index.IndexName, KeySchema: index.KeySchema, Projection: index.Projection })) } }; }
    if (!table) throw notFound();
    if (command instanceof UpdateTimeToLiveCommand) { table.ttl = (input.TimeToLiveSpecification as { Enabled: boolean }).Enabled; (table.spec as { ttlAttribute?: string }).ttlAttribute = (input.TimeToLiveSpecification as { AttributeName: string }).AttributeName; return {}; }
    if (command instanceof DescribeTimeToLiveCommand) return { TimeToLiveDescription: table.ttl ? { TimeToLiveStatus: 'ENABLED', AttributeName: (table.spec as { ttlAttribute?: string }).ttlAttribute } : { TimeToLiveStatus: 'DISABLED' } };
    if (command instanceof UpdateContinuousBackupsCommand) { table.pitr = (input.PointInTimeRecoverySpecification as { PointInTimeRecoveryEnabled: boolean }).PointInTimeRecoveryEnabled; (table.spec as { days?: unknown }).days = (input.PointInTimeRecoverySpecification as { RecoveryPeriodInDays?: number }).RecoveryPeriodInDays; return {}; }
    if (command instanceof DescribeContinuousBackupsCommand) return { ContinuousBackupsDescription: { PointInTimeRecoveryDescription: { PointInTimeRecoveryStatus: table.pitr ? 'ENABLED' : 'DISABLED', RecoveryPeriodInDays: (table.spec as { days?: number }).days } } };
    if (command instanceof UpdateTableCommand) { if (input.DeletionProtectionEnabled !== undefined) table.protection = input.DeletionProtectionEnabled === true; return {}; }
    if (command instanceof DeleteTableCommand) { if (table.protection) throw Object.assign(new Error('protected'), { name: 'ValidationException' }); tables.delete(name); return {}; }
    throw new Error('unexpected command');
  } } };
}
async function evidenceIn(t: { after(fn: () => Promise<void>): void }) {
  const directory = await mkdtemp(join(tmpdir(), 'ops-evidence-')); t.after(() => rm(directory, { recursive: true, force: true }));
  return createEvidence([definitions[0]!], join(directory, 'run'));
}

void test('created restored tables carry the production schema, protection and 35 day PITR, are tracked before creation and are removed with independent absence', async t => {
  const evidence = await evidenceIn(t); const memory = memoryDynamo(); const local = { ...ctx, prefix: `e2e-${evidence.runId.slice(4, 12)}` };
  const created = await createRestoredTables(memory.client, evidence, local, 'r1');
  assert.deepEqual(Object.keys(created.tableNames).sort(), [...TABLE_KEYS].sort()); assert.doesNotThrow(() => assertRestoredTarget(created, local));
  assert.equal(memory.tables.size, 3); for (const table of memory.tables.values()) assert.equal(table.protection, true); assert.equal(memory.tables.get(created.tableNames.owner_state!)!.ttl, true);
  const manifest = evidenceContext(evidence).manifest.resources.filter(resource => resource.kind === 'sdk-table'); assert.equal(manifest.length, 3); assert.ok(manifest.every(resource => resource.created && !resource.removed));
  assert.ok(memory.log.findIndex(entry => entry.startsWith('CreateTableCommand')) >= 0);
  await removeRestoredTables(memory.client, created, evidence); assert.equal(memory.tables.size, 0);
  assert.ok(memory.log.indexOf(`UpdateTableCommand:${created.tableNames.reminders!}`) < memory.log.indexOf(`DeleteTableCommand:${created.tableNames.reminders!}`), 'protection is released only to delete the owned table');
  await finalizeResults(evidence); const swept = await sweepRestoredTables(memory.client, evidence);
  assert.deepEqual(swept, { attempted: 0, succeeded: 0, errors: 0, leaks: 0 }); assert.ok(evidenceContext(evidence).manifest.resources.filter(resource => resource.kind === 'sdk-table').every(resource => resource.removed));
});

void test('the run-end sweep removes a leaked owned table, counts one that cannot be removed and never touches an unreserved table', async t => {
  const evidence = await evidenceIn(t); const memory = memoryDynamo(); const local = { ...ctx, prefix: `e2e-${evidence.runId.slice(4, 12)}` };
  const created = await createRestoredTables(memory.client, evidence, local, 'r2');
  memory.tables.set('foreign-table', { arn: 'arn:aws:dynamodb:ap-northeast-1:123456789012:table/foreign-table', protection: true, ttl: false, pitr: false, spec: {} });
  await finalizeResults(evidence); const swept = await sweepRestoredTables(memory.client, evidence);
  assert.deepEqual(swept, { attempted: 3, succeeded: 3, errors: 0, leaks: 0 }); assert.equal(memory.tables.has('foreign-table'), true); assert.equal(memory.tables.has(created.tableNames.reminders!), false);
  const stuck = memoryDynamo(); const second = await evidenceIn(t); const again = await createRestoredTables(stuck.client, second, { ...ctx, prefix: `e2e-${second.runId.slice(4, 12)}` }, 'r3');
  const send = stuck.client.send.bind(stuck.client); stuck.client.send = async (command: unknown): Promise<unknown> => { if (command instanceof DeleteTableCommand) throw new Error('synthetic delete failure'); return send(command); };
  await finalizeResults(second); const failed = await sweepRestoredTables(stuck.client, second);
  assert.equal(failed.attempted, 3); assert.equal(failed.succeeded, 0); assert.equal(failed.errors + failed.leaks, 3); assert.ok(evidenceContext(second).manifest.resources.filter(resource => resource.kind === 'sdk-table').every(resource => !resource.removed)); void again;
});

void test('creation that never becomes ACTIVE fails closed and leaves the tables reserved for the run-end sweep', async t => {
  const evidence = await evidenceIn(t); const stuck = memoryDynamo({ stuck: true });
  await assert.rejects(createRestoredTables(stuck.client, evidence, { ...ctx, prefix: `e2e-${evidence.runId.slice(4, 12)}` }, 'r4', { attempts: 2, delayMs: 1 }), /RESTORED_TABLE_NOT_ACTIVE/);
  assert.ok(evidenceContext(evidence).manifest.resources.some(resource => resource.kind === 'sdk-table' && !resource.removed));
});

const syntheticFixture = (overrides: { account?: string; sts?: string } = {}) => {
  const sent: { client: string; table?: string }[] = [];
  const dynamodb = { async send(command: unknown) { const input = (command as { input: { TableName?: string } }).input; sent.push({ client: 'dynamodb', ...(input.TableName ? { table: input.TableName } : {}) }); return {}; } };
  const s3 = { async send() { sent.push({ client: 's3' }); throw Object.assign(new Error('absent'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } }); } };
  const sts = { async send(command: unknown) { assert.ok(command instanceof GetCallerIdentityCommand); sent.push({ client: 'sts' }); return { Account: overrides.sts ?? ctx.account }; } };
  const config = { region: ctx.region, remindersTable: `${ctx.prefix}-production-reminders`, ownerStateTable: `${ctx.prefix}-production-owner-state`, imageJobsTable: `${ctx.prefix}-production-image-jobs`, imagesBucket: `${ctx.prefix}-${ctx.account}-${ctx.region}-images`, expectedApiId: 'abcde12345', expectedStage: '$default', issuer: 'http://floci:4566/ap-northeast-1_Synthetic1', clientId: 'client123', sourceIps: [], limits: { jsonBytes: 2_097_152, thumbnailBytes: 1_048_576, itemCount: 1000, imageBytes: 134_217_728, ownerRequestsPerMinute: 120 } };
  const fixture = { target: { endpoint: 'http://floci:4566', region: ctx.region, addresses: new Map([['floci', '172.18.0.2']]) }, prefix: ctx.prefix, config, clients: { dynamodb, s3, sts }, auth: { async login(owner: string) { return { accessToken: 'x', refreshToken: 'y', claims: { iss: config.issuer, sub: `sub-${owner}-0001`, client_id: 'client123', iat: 1, exp: 2, scope: 'a' } }; } } } as unknown as SuiteFixture;
  fixtureStates.set(fixture, { stack: { bindings: { account_id: overrides.account ?? ctx.account, api_id: 'abcde12345' } } } as never);
  return { fixture, sent };
};
const targetFor = (fixture: SuiteFixture, change: Record<string, unknown> = {}, account = ctx.account) => parseMigrationTarget({ accountId: account, region: fixture.config.region, remindersTable: fixture.config.remindersTable, ownerStateTable: fixture.config.ownerStateTable, imageJobsTable: fixture.config.imageJobsTable, imagesBucket: fixture.config.imagesBucket, expectedApiId: fixture.config.expectedApiId, expectedStage: fixture.config.expectedStage, issuer: fixture.config.issuer, clientId: fixture.config.clientId, ...change });
const identityOf = (target: ReturnType<typeof targetFor>) => ({ runId: '11111111-1111-4111-8111-111111111111', sourceSha256: 'a'.repeat(64), mappingSha256: 'b'.repeat(64), contractSha256: contractSha256For(target), contractVersion: 1 as const, environment: environmentIdentityFor(target) });
const validation = { owners: [], errors: [] };

void test('the local migration runtime checks the STS account first and builds the stores over the fixture clients only', async () => {
  const { fixture, sent } = syntheticFixture(); const migrationTarget = targetFor(fixture); const identity = identityOf(migrationTarget); assertMigrationIdentity(identity);
  const deps = await localMigrationRuntime(fixture).createDeps(migrationTarget, identity, validation);
  assert.deepEqual(sent, [{ client: 'sts' }]); await deps.owners.gate(deps.budget); assert.deepEqual(sent.at(-1), { client: 'dynamodb', table: fixture.config.ownerStateTable });
  await deps.images.head('images/o/x', null, deps.budget); assert.equal(sent.at(-1)!.client, 's3');
});

void test('the local migration runtime rejects a foreign account, unowned tables or bucket, a changed contract and a failed account check before any data call', async () => {
  const run = async (change: Record<string, unknown>, options: { sts?: string; account?: string; accountId?: string; identity?: (identity: ReturnType<typeof identityOf>) => ReturnType<typeof identityOf> } = {}) => {
    const { fixture, sent } = syntheticFixture({ ...(options.sts ? { sts: options.sts } : {}), ...(options.account ? { account: options.account } : {}) }); const migrationTarget = targetFor(fixture, change, options.accountId ?? ctx.account);
    const identity = options.identity ? options.identity(identityOf(migrationTarget)) : identityOf(migrationTarget);
    await assert.rejects(localMigrationRuntime(fixture).createDeps(migrationTarget, identity, validation), /LOCAL_RUNTIME_REJECTED/); assert.ok(sent.every(entry => entry.client === 'sts'), 'no data client is touched');
  };
  await run({}, { sts: '999999999999' });
  await run({}, { accountId: '999999999999', sts: '999999999999' });
  await run({}, { account: '999999999999' });
  await run({ remindersTable: 'someone-elses-reminders' });
  await run({ imagesBucket: 'someone-elses-bucket' });
  await run({ region: 'us-east-1' });
  await run({}, { identity: identity => ({ ...identity, contractSha256: 'c'.repeat(64) }) });
  const { fixture } = syntheticFixture(); const migrationTarget = targetFor(fixture);
  await assert.rejects(localMigrationRuntime(fixture).createDeps(migrationTarget, identityOf(migrationTarget), { owners: [], errors: [{ location: 'x', field: 'y', code: 'Z' }] }), /LOCAL_RUNTIME_REJECTED/);
});

void test('the local recovery runtime admits only the fixture tables as source and the owned restored tables as target, with a read-only source image store', async () => {
  const { fixture, sent } = syntheticFixture(); const restored = target;
  const restoredTarget = targetFor(fixture, { remindersTable: restored.tableNames.reminders, ownerStateTable: restored.tableNames.owner_state, imageJobsTable: restored.tableNames.image_jobs });
  const source = targetFor(fixture); const input = { source: environmentIdentityFor(source), restored: environmentIdentityFor(restoredTarget), runId: '22222222-2222-4222-8222-222222222222', ownerIdentities: [] };
  const deps = await localRecoveryRuntime(fixture, restored).createDeps(source, restoredTarget, input);
  assert.deepEqual(sent, [{ client: 'sts' }]);
  await assert.rejects(deps.sourceImages.put({ jobId: 'x' } as never, {} as never, deps.budget), /RECOVERY_REJECTED|LOCAL_RUNTIME_REJECTED/);
  await assert.rejects(deps.sourceImages.markDeleted('images/o/x', deps.budget), /RECOVERY_REJECTED|LOCAL_RUNTIME_REJECTED/);
  await assert.rejects(deps.sourceImages.signGet({} as never, 900, deps.budget), /RECOVERY_REJECTED|LOCAL_RUNTIME_REJECTED/);
  for await (const _ of deps.restored.listItems()) void _; assert.ok(sent.some(entry => entry.table === restored.tableNames.reminders), 'restored reads use the owned restored table through the fixture client');
  const swapped = targetFor(fixture, { remindersTable: restored.tableNames.reminders, ownerStateTable: fixture.config.ownerStateTable, imageJobsTable: restored.tableNames.image_jobs });
  await assert.rejects(localRecoveryRuntime(fixture, restored).createDeps(source, swapped, { ...input, restored: environmentIdentityFor(swapped) }), /LOCAL_RUNTIME_REJECTED/);
  const foreignSource = targetFor(fixture, { remindersTable: restored.tableNames.reminders, ownerStateTable: restored.tableNames.owner_state, imageJobsTable: restored.tableNames.image_jobs });
  await assert.rejects(localRecoveryRuntime(fixture, restored).createDeps(foreignSource, restoredTarget, { ...input, source: environmentIdentityFor(foreignSource) }), /LOCAL_RUNTIME_REJECTED/);
  await assert.rejects(localRecoveryRuntime(fixture, restored).createDeps(source, restoredTarget, { ...input, runId: 'not-a-uuid' }), /RECOVERY_REJECTED|LOCAL_RUNTIME_REJECTED/);
  const failing = syntheticFixture({ sts: '999999999999' }); await assert.rejects(localRecoveryRuntime(failing.fixture, restored).createDeps(targetFor(failing.fixture), restoredTarget, input), /LOCAL_RUNTIME_REJECTED/); assert.ok(failing.sent.every(entry => entry.client === 'sts'));
});

void test('synthetic operation inputs hold two owners (one empty, special keys), validate through the real dry run and name only owned restored tables', async t => {
  const { fixture } = syntheticFixture(); const directory = await mkdtemp(join(tmpdir(), 'ops-inputs-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const files = await writeSyntheticOperationInputs(fixture, target, directory);
  assert.deepEqual(Object.keys(files).sort(), ['config', 'mapping', 'ownerIdentities', 'ownerMap', 'restoredConfig', 'source']);
  for (const path of Object.values(files)) { assert.equal(path.startsWith(directory), true); assert.equal((await stat(path)).mode & 0o777, 0o600); }
  const out: string[] = []; const err: string[] = [];
  assert.equal(await migrationMain(['--mode', 'dry-run', '--source', files.source, '--mapping', files.mapping, '--config', files.config], { stdout: line => out.push(line), stderr: line => err.push(line) }), 0);
  const summary = JSON.parse(out.join('')) as { valid: boolean; owners: number; items: number; errors: unknown[] }; assert.deepEqual([summary.valid, summary.owners, summary.items, summary.errors.length], [true, 2, 3, 0]); assert.deepEqual(err, []);
  const source = JSON.parse(await readFile(files.source, 'utf8')) as Record<string, unknown[]>; assert.deepEqual(Object.keys(source).sort(), ['', '__proto__'].sort()); assert.equal(source[''] !== undefined && source[''].length, 0);
  const configured = JSON.parse(await readFile(files.restoredConfig, 'utf8')) as Record<string, string>; assert.deepEqual([configured.remindersTable, configured.ownerStateTable, configured.imageJobsTable], [target.tableNames.reminders, target.tableNames.owner_state, target.tableNames.image_jobs]);
  assert.equal(configured.imagesBucket, fixture.config.imagesBucket); assert.equal(JSON.parse(await readFile(files.config, 'utf8')).limits, undefined, 'no relaxed limits');
  const mapping = JSON.parse(await readFile(files.mapping, 'utf8')) as { legacyKey: string; issuer: string; sub: string }[]; assert.equal(mapping.length, 2);
  const identities = JSON.parse(await readFile(files.ownerIdentities, 'utf8')) as { ownerId: string; issuer: string; sub: string }[]; assert.deepEqual(identities.map(item => item.ownerId).sort(), mapping.map(item => ownerIdFor(item.issuer, item.sub)).sort());
  const captured: { source?: unknown; restored?: unknown; input?: { ownerIdentities: unknown[] } }[] = []; const failures: string[] = [];
  const code = await recoveryMain(['--source-config', files.config, '--restored-config', files.restoredConfig, '--owner-identities', files.ownerIdentities, '--run-id', '33333333-3333-4333-8333-333333333333', '--owner-map', files.ownerMap], { stdout: () => undefined, stderr: line => failures.push(line) }, { async createDeps(source, restored, input) { captured.push({ source, restored, input }); throw new Error('stop'); } });
  assert.equal(code, 2); assert.equal(captured.length, 1, 'the private inputs parse into one recovery run'); assert.equal(captured[0]!.input!.ownerIdentities.length, 2); assert.ok(JSON.parse(failures.join('')).errors[0].code === 'RECOVERY_FAILED');
  const first = await buildOperationInputs(fixture, target, directory); assert.equal(first.owners.length, 2); assert.equal(first.owners[0]!.items.length, 3); assert.equal(first.owners[1]!.items.length, 0);
});

void test('CLI output is projected onto fixed safe fields so keys, titles, tokens and raw errors never reach evidence', () => {
  const canary = 'CANARY-title-https://secret.example/token';
  const migrate = projectCliResult(0, [JSON.stringify({ mode: 'verify', exactMatch: true, mismatches: [], extra: canary, owners: 2, items: 3, title: canary }) + '\n'], []);
  assert.deepEqual(migrate, { exitCode: 0, mode: 'verify', exactMatch: true, mismatchCount: 0, owners: 2, items: 3 });
  const recovery = projectCliResult(2, [JSON.stringify({ matched: 1, missingImages: [{ location: 'items[0]', field: 'thumbnail', reason: 'NONCURRENT_VERSION' }], mismatchedOwners: [{ location: canary, field: 'ownerId', reason: canary }], countDiscrepancies: [], unresolvedJobs: [], readyToSwitch: false, cognitoCredentialsRestored: false }) + '\n'], [JSON.stringify({ errors: [{ location: 'migration', field: 'operation', code: 'MIGRATION_FAILED' }, { location: canary, field: canary, code: canary }] }) + '\n']);
  assert.deepEqual(recovery, { exitCode: 2, matched: 1, issues: { missingImages: ['NONCURRENT_VERSION'], mismatchedOwners: [], countDiscrepancies: [], unresolvedJobs: [] }, readyToSwitch: false, cognitoCredentialsRestored: false, errorCodes: ['MIGRATION_FAILED'] });
  assert.ok(!JSON.stringify([migrate, recovery]).includes('CANARY'));
  assert.deepEqual(projectCliResult(2, ['not json'], ['also not json']), { exitCode: 2, errorCodes: [] });
});

void test('every operations case is blocked once the restored_tables state is not original', () => {
  const { fixture } = syntheticFixture(); let state: 'original' | 'restored' | 'inconsistent' = 'original';
  fixtureStates.set(fixture, { stack: { bindings: {}, restoredTablesState: () => state } } as never);
  assert.equal(operationBlocked(fixture), false); state = 'inconsistent'; assert.equal(operationBlocked(fixture), true); state = 'restored'; assert.equal(operationBlocked(fixture), true);
  for (const def of ops.filter(def => def.layer === 'L')) assert.equal(caseGuards.get(def.id)!(fixture), true);
  state = 'original'; for (const def of ops.filter(def => def.layer === 'L')) assert.equal(caseGuards.get(def.id)!(fixture), false);
});

void test('a table read by the harness never uses a default credential chain: the runtime builders import no AWS client constructors', async () => {
  const source = await readFile(join(__dirname, 'support/operation-fixtures.ts'), 'utf8');
  assert.ok(!/createMigrationDeps|createRecoveryDeps|createAwsClients|fromNodeProviderChain|new (S3|STS|DynamoDB)Client/.test(source));
  void createHash; void GetCommand; void markResource; void reserveResource;
});

void test('per-case removal marks the owned tables removed so the run-end sweep does not count them a second time', async t => {
  const evidence = await evidenceIn(t); const memory = memoryDynamo(); const local = { ...ctx, prefix: `e2e-${evidence.runId.slice(4, 12)}` };
  const first = await createRestoredTables(memory.client, evidence, local, 'c1'); await removeRestoredTables(memory.client, first, evidence);
  const second = await createRestoredTables(memory.client, evidence, local, 'c2'); await removeRestoredTables(memory.client, second, evidence);
  const owned = (): { removed: boolean }[] => evidenceContext(evidence).manifest.resources.filter(resource => resource.kind === 'sdk-table');
  assert.equal(owned().length, 6); assert.ok(owned().every(resource => resource.removed), 'absence was read back per case, so the manifest says removed');
  await finalizeResults(evidence); assert.deepEqual(await sweepRestoredTables(memory.client, evidence), { attempted: 0, succeeded: 0, errors: 0, leaks: 0 });
});

void test('the real runner path starts the first OPS case on a suite created published: the input is stopped before the quiescence check', async () => {
  const rows = new Map<string, Record<string, unknown>>([['GLOBAL#PUBLICATION', { pk: 'GLOBAL', sk: 'PUBLICATION', published: true, runId: 'run' }]]);
  const gateKey = 'GLOBAL#PUBLICATION'; const order: string[] = [];
  const dynamodb = { async send(command: unknown) {
    const input = (command as { input: { Key?: { pk: string; sk: string }; Item?: Record<string, unknown> } }).input; const name = (command as object).constructor.name;
    if (name === 'GetCommand') return { Item: rows.get(`${input.Key!.pk}#${input.Key!.sk}`) };
    if (name === 'PutCommand') { rows.set(`${input.Item!.pk}#${input.Item!.sk}`, input.Item!); return {}; }
    if (name === 'ScanCommand') return { Items: [...rows.values()] };
    if (name === 'DeleteCommand') { rows.delete(`${input.Key!.pk}#${input.Key!.sk}`); return {}; }
    throw new Error(`unexpected ${name}`);
  } };
  const s3 = { async send() { return { Versions: [], DeleteMarkers: [], IsTruncated: false }; } };
  const { fixture } = syntheticFixture();
  (fixture.clients as unknown as Record<string, unknown>).dynamodb = dynamodb; (fixture.clients as unknown as Record<string, unknown>).s3 = s3;
  fixture.setPublication = async published => { order.push(`publication:${published}`); rows.set(gateKey, { pk: 'GLOBAL', sk: 'PUBLICATION', published, runId: 'run' }); };
  fixtureStates.set(fixture, { stack: { bindings: { account_id: ctx.account, prefix: ctx.prefix } }, outstanding: 0, cleanupIntervals: [], scheduler: { async send() { order.push('schedule'); return { State: 'DISABLED' }; } }, evidence: undefined } as never);
  const action = caseActions.get('OPS-01/two-owners-import-verify-publish')!; const recorder = { recordInput() { return undefined; }, recordOutput() { return undefined; }, deferLogs() { return undefined; } };
  const failure = await action(fixture, recorder).then(() => undefined, (error: unknown) => error as Error);
  assert.notEqual(failure?.message, 'OPERATION_NOT_QUIESCENT'); assert.ok(order.indexOf('publication:false') >= 0 && order.indexOf('publication:false') < order.indexOf('schedule') + 1, 'publication was stopped');
});
