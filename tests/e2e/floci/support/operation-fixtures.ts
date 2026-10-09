import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { createHash } from 'node:crypto';
import { createJobsStore } from '../../../../src/images/jobs-store.ts';
import { createOwnerStore } from '../../../../src/reminders/owner-store.ts';
import { createRemindersStore } from '../../../../src/reminders/dynamo-store.ts';
import { ownerIdFor } from '../../../../src/api/identity.ts';
import { createBudget } from '../../../../src/shared/budget.ts';
import type { ImagesStore } from '../../../../src/shared/ports.ts';
import { contractSha256For, environmentIdentityFor, type MigrationTarget } from '../../../../scripts/operations/legacy.ts';
import { assertMigrationIdentity, type MigrationDeps } from '../../../../scripts/operations/migration.ts';
import { createMigrationImagesStore, createMigrationStore, verifyMigrationCaller } from '../../../../scripts/operations/migration-store.ts';
import { assertRecoveryInput, createRecoveryStore, type RecoveryDeps, type RecoveryImageServices } from '../../../../scripts/operations/recovery.ts';
import type { MigrationRuntime, OperationIO } from '../../../../scripts/operations/migrate-json.ts';
import type { RecoveryRuntime } from '../../../../scripts/operations/verify-recovery.ts';
import { fixtureState } from './fixture.ts';
import { base64Of, dataUrlOf, imageBytes } from './image-fixtures.ts';
import type { RestoredTarget, SuiteFixture } from './types.ts';

/**
 * Local operations runtimes. The CLIs' own injection points receive stores built over the fixture's explicit local clients; the default
 * credential chain factories are never called. Every target is checked against the run-owned tables, bucket, account and region first,
 * and the STS account is compared before any data call. Operational full-table scans therefore touch owned resources only.
 */
const READ = 'reminder-api/read'; const WRITE = 'reminder-api/write';
const rejected = (): Error => new Error('LOCAL_RUNTIME_REJECTED');
type TableSet = { remindersTable: string; ownerStateTable: string; imageJobsTable: string };
const tablesOf = (value: TableSet): string[] => [value.remindersTable, value.ownerStateTable, value.imageJobsTable];
const sameTables = (a: TableSet, b: TableSet): boolean => isDeepStrictEqual(tablesOf(a), tablesOf(b));
const restoredSet = (restored: RestoredTarget): TableSet => ({ remindersTable: restored.tableNames.reminders!, ownerStateTable: restored.tableNames.owner_state!, imageJobsTable: restored.tableNames.image_jobs! });
function ownedAccount(fixture: SuiteFixture): string {
  const account = fixtureState(fixture).stack.bindings.account_id;
  if (typeof account !== 'string' || !/^\d{12}$/.test(account)) throw rejected(); return account;
}
function assertOwned(fixture: SuiteFixture, target: MigrationTarget, allowed: TableSet[]): void {
  if (target.accountId !== ownedAccount(fixture) || target.region !== fixture.target.region || target.imagesBucket !== fixture.config.imagesBucket || target.issuer !== fixture.config.issuer || !allowed.some(set => sameTables(target, set))) throw rejected();
}
const newBudget = () => { const deadline = Date.now() + 900_000; return createBudget(() => deadline - Date.now(), 1000); };

export function localMigrationRuntime(fixture: SuiteFixture, restored?: RestoredTarget): MigrationRuntime {
  return { async createDeps(target, identity, validation): Promise<MigrationDeps> {
    try {
      assertMigrationIdentity(identity);
      if (validation.errors.length || !isDeepStrictEqual(identity.environment, environmentIdentityFor(target)) || identity.contractSha256 !== contractSha256For(target)) throw rejected();
      assertOwned(fixture, target, [fixture.config, ...(restored ? [restoredSet(restored)] : [])]);
      const budget = newBudget(); await verifyMigrationCaller(fixture.clients.sts, target.accountId, budget);
      const client = fixture.clients.dynamodb;
      return { migration: createMigrationStore(client, target, identity, validation, budget), reminders: createRemindersStore(client, target), jobs: createJobsStore(client, target),
        images: createMigrationImagesStore(fixture.clients.s3, target), owners: createOwnerStore(client, target), validation, budget, clock: Date.now, uuid: randomUUID };
    } catch { throw rejected(); }
  } };
}
export function localRecoveryRuntime(fixture: SuiteFixture, restored: RestoredTarget): RecoveryRuntime {
  return { async createDeps(source, restoredTarget, input): Promise<RecoveryDeps> {
    try {
      assertRecoveryInput(input);
      if (!isDeepStrictEqual(environmentIdentityFor(source), input.source) || !isDeepStrictEqual(environmentIdentityFor(restoredTarget), input.restored)) throw rejected();
      assertOwned(fixture, source, [fixture.config]); assertOwned(fixture, restoredTarget, [restoredSet(restored)]);
      const budget = newBudget(); await verifyMigrationCaller(fixture.clients.sts, restoredTarget.accountId, budget);
      const original = createMigrationImagesStore(fixture.clients.s3, source); const forbidden = (): Promise<never> => Promise.reject(rejected());
      const sourceImages: ImagesStore = { ...original, put: forbidden, markDeleted: forbidden, signGet: forbidden };
      const services: RecoveryImageServices = { sourceImages, restoredImages: createMigrationImagesStore(fixture.clients.s3, restoredTarget), clock: Date.now, uuid: randomUUID };
      return { ...services, budget, restored: createRecoveryStore(fixture.clients.dynamodb, restoredTarget, input, services, budget) };
    } catch { throw rejected(); }
  } };
}
/** A deterministic interruption of the n-th call of one store method: before = never sent, after = performed and the response lost. */
export type MigrationFault = { method: 'putImported' | 'saveProgress'; nth: number; phase: 'before' | 'after' };
export function migrationFault(runtime: MigrationRuntime, fault: MigrationFault): MigrationRuntime {
  return { async createDeps(target, identity, validation) {
    const deps = await runtime.createDeps(target, identity, validation); let calls = 0; const original = deps.migration[fault.method].bind(deps.migration) as (...args: unknown[]) => Promise<void>;
    const wrapped = async (...args: unknown[]): Promise<void> => {
      calls++; if (calls === fault.nth && fault.phase === 'before') throw new Error('SYNTHETIC_FAULT');
      await original(...args); if (calls === fault.nth && fault.phase === 'after') throw new Error('SYNTHETIC_FAULT');
    };
    return { ...deps, migration: { ...deps.migration, [fault.method]: wrapped } };
  } };
}
/** The synthetic users' real identities are used so the migrated owners are the same owners the API authenticates. */
export type OperationOwner = { key: string; sub: string; ownerId: string; items: { id: string; bytes?: Buffer; mime?: string }[] };
export type OperationInputs = { files: { source: string; mapping: string; config: string; restoredConfig: string; ownerIdentities: string; ownerMap: string }; owners: OperationOwner[]; issuer: string; legacySub: string; target: MigrationTarget; restoredTarget: MigrationTarget };
const targetJson = (fixture: SuiteFixture, account: string, tables: TableSet) => ({ accountId: account, region: fixture.config.region, remindersTable: tables.remindersTable, ownerStateTable: tables.ownerStateTable, imageJobsTable: tables.imageJobsTable, imagesBucket: fixture.config.imagesBucket, expectedApiId: fixture.config.expectedApiId, expectedStage: fixture.config.expectedStage, issuer: fixture.config.issuer, clientId: fixture.config.clientId });
export async function buildOperationInputs(fixture: SuiteFixture, restored: RestoredTarget, directory: string): Promise<OperationInputs> {
  const account = ownedAccount(fixture); const issuer = fixture.config.issuer;
  const a = await fixture.auth.login('a', [READ, WRITE], 'primary'); const b = await fixture.auth.login('b', [READ, WRITE], 'primary');
  const png = imageBytes('png', 120, 1); const jpeg = imageBytes('jpeg', 150, 2); const legacySub = `legacy-${randomUUID()}`;
  const item = (id: string, title: string, created: string, thumbnail?: string) => ({ id, url: `https://example.test/${encodeURIComponent(id)}`, title, reminderTime: '2026-11-05T09:30:00+09:00', autoOpen: false, webPush: true, hidden: false, createdAt: created, ...(thumbnail === undefined ? {} : { thumbnail }) });
  const ownerA: OperationOwner = { key: '__proto__', sub: a.claims.sub, ownerId: ownerIdFor(issuer, a.claims.sub), items: [{ id: 'ops-a-1', bytes: png, mime: 'image/png' }, { id: 'ops-ä-2' }, { id: 'ops-a-3', bytes: jpeg, mime: 'image/jpeg' }] };
  const ownerB: OperationOwner = { key: '', sub: b.claims.sub, ownerId: ownerIdFor(issuer, b.claims.sub), items: [] };
  const source = Object.fromEntries([[ownerA.key, [item('ops-a-1', 'first', '2026-01-02T03:04:05.678+09:00', dataUrlOf('png', png)), item('ops-ä-2', 'ünï', '2026-01-03T00:00:00Z'), item('ops-a-3', 'third', '2026-01-04T12:00:00.5+00:00', base64Of(jpeg))]], [ownerB.key, []]]);
  const files = { source: join(directory, 'source.json'), mapping: join(directory, 'mapping.json'), config: join(directory, 'config.json'), restoredConfig: join(directory, 'restored-config.json'), ownerIdentities: join(directory, 'owner-identities.json'), ownerMap: join(directory, 'owner-map.json') };
  await mkdir(directory, { recursive: true });
  const write = (path: string, value: unknown): Promise<void> => writeFile(path, JSON.stringify(value), { mode: 0o600 });
  const config = targetJson(fixture, account, fixture.config); const restoredConfig = targetJson(fixture, account, restoredSet(restored));
  await write(files.source, source);
  await write(files.mapping, [ownerA, ownerB].map(owner => ({ legacyKey: owner.key, issuer, sub: owner.sub })));
  await write(files.config, config); await write(files.restoredConfig, restoredConfig);
  await write(files.ownerIdentities, [ownerA, ownerB].map(owner => ({ ownerId: owner.ownerId, issuer, sub: owner.sub })));
  await write(files.ownerMap, [{ oldIssuer: issuer, oldSub: legacySub, newIssuer: issuer, newSub: ownerA.sub }]);
  const { parseMigrationTarget } = await import('../../../../scripts/operations/migrate-json.ts');
  return { files, owners: [ownerA, ownerB], issuer, legacySub, target: parseMigrationTarget(config), restoredTarget: parseMigrationTarget(restoredConfig) };
}
export async function writeSyntheticOperationInputs(fixture: SuiteFixture, restored: RestoredTarget, directory: string): Promise<OperationInputs['files']> {
  return (await buildOperationInputs(fixture, restored, directory)).files;
}

/** Only fixed vocabulary reaches evidence: modes, counts, booleans and upper-case reason codes. Titles, keys, URLs and raw errors are dropped. */
export type CliProjection = { exitCode: number; mode?: string; exactMatch?: boolean; mismatchCount?: number; owners?: number; items?: number; imageBytes?: number; completed?: boolean; valid?: boolean; matched?: number; issues?: Record<string, string[]>; readyToSwitch?: boolean; cognitoCredentialsRestored?: boolean; errorCodes?: string[] };
const token = /^[A-Z][A-Z0-9_]{1,63}$/; const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
export function projectCliResult(exitCode: number, stdout: string[], stderr: string[]): CliProjection {
  const result: CliProjection = { exitCode };
  const parse = (lines: string[]): unknown => { try { return JSON.parse(lines.join('').trim().split('\n').at(-1) ?? ''); } catch { return undefined; } };
  const out = parse(stdout);
  if (record(out)) {
    if (typeof out.mode === 'string' && ['dry-run', 'import', 'verify', 'publish'].includes(out.mode)) result.mode = out.mode;
    for (const field of ['exactMatch', 'completed', 'valid', 'readyToSwitch', 'cognitoCredentialsRestored'] as const) if (typeof out[field] === 'boolean') (result as Record<string, unknown>)[field] = out[field];
    for (const field of ['owners', 'items', 'imageBytes', 'matched'] as const) if (count(out[field])) (result as Record<string, unknown>)[field] = out[field];
    if (Array.isArray(out.mismatches)) result.mismatchCount = out.mismatches.length;
    const lists = ['missingImages', 'mismatchedOwners', 'countDiscrepancies', 'unresolvedJobs'];
    if (lists.every(name => Array.isArray(out[name]))) result.issues = Object.fromEntries(lists.map(name => [name, (out[name] as unknown[]).flatMap(entry => record(entry) && typeof entry.reason === 'string' && token.test(entry.reason) ? [entry.reason] : [])]));
  }
  if (stderr.length) { const err = parse(stderr); result.errorCodes = record(err) && Array.isArray(err.errors) ? err.errors.flatMap(entry => record(entry) && typeof entry.code === 'string' && token.test(entry.code) ? [entry.code] : []) : []; }
  return result;
}
export function captureIo(): { io: OperationIO; stdout: string[]; stderr: string[] } {
  const stdout: string[] = []; const stderr: string[] = [];
  return { io: { stdout: line => { stdout.push(line); }, stderr: line => { stderr.push(line); } }, stdout, stderr };
}
/** True when the Terraform roots are not read back as original: no API input may follow and no case may start. */
export function operationBlocked(fixture: SuiteFixture): boolean {
  return fixtureState(fixture).stack.restoredTablesState() !== 'original';
}
/** Digest of every row of the named owned tables (strong scan); used only for equality, never printed. */
export async function snapshotTables(fixture: SuiteFixture, tables: string[]): Promise<string> {
  const rows: string[] = [];
  for (const TableName of tables) { let ExclusiveStartKey: Record<string, unknown> | undefined; do { const page = await fixture.clients.dynamodb.send(new ScanCommand({ TableName, ConsistentRead: true, ...(ExclusiveStartKey ? { ExclusiveStartKey } : {}) })); rows.push(...(page.Items ?? []).map(entry => JSON.stringify([TableName, Object.entries(entry).sort(([x], [y]) => x.localeCompare(y))]))); ExclusiveStartKey = page.LastEvaluatedKey; } while (ExclusiveStartKey); }
  return createHash('sha256').update(rows.sort().join('\0')).digest('hex');
}
