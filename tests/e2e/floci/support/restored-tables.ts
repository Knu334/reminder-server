import { CreateTableCommand, DeleteTableCommand, DescribeContinuousBackupsCommand, DescribeTableCommand, DescribeTimeToLiveCommand, UpdateContinuousBackupsCommand, UpdateTableCommand, UpdateTimeToLiveCommand } from '@aws-sdk/client-dynamodb';
import type { CreateTableCommandInput, DescribeContinuousBackupsCommandOutput, DescribeTableCommandOutput, DescribeTimeToLiveCommandOutput } from '@aws-sdk/client-dynamodb';
import { evidenceContext, markResource, reserveResource } from './evidence.ts';
import type { CleanupSummary, Evidence, RestoredTarget } from './types.ts';

/**
 * Three owned SDK tables that stand in for a restored PITR set. They are created with the production schema, protection and 35 day PITR
 * (settings only: no real restore) and are tracked in the run manifest as kind sdk-table, so a leaked table is found and removed at run end.
 */
export const TABLE_KEYS = ['reminders', 'owner_state', 'image_jobs'] as const;
export type TableKey = typeof TABLE_KEYS[number];
export type RestoredContext = { prefix: string; account: string; region: string };
export type DynamoSender = { send(command: unknown): Promise<unknown> };
export type DescribedTable = {
  name?: string; arn?: string; billingMode?: string; deletionProtection?: boolean;
  keys: { name: string; type: string }[]; attributes: { name: string; type: string }[];
  gsi: { name: string; projection: string; keys: { name: string; type: string }[] }[];
  pitr?: { enabled: boolean; days?: number }; ttl?: { enabled: boolean; attribute?: string };
};
const reject = (): Error => new Error('RESTORED_TABLE_REJECTED');
const rejectTarget = (): Error => new Error('RESTORED_TARGET_REJECTED');
const schema: Record<TableKey, { suffix: string; hash: string; range: string | null; attributes: string[] }> = {
  reminders: { suffix: 'reminders', hash: 'ownerId', range: 'id', attributes: ['ownerId', 'id'] },
  owner_state: { suffix: 'owner-state', hash: 'pk', range: 'sk', attributes: ['pk', 'sk'] },
  image_jobs: { suffix: 'image-jobs', hash: 'jobId', range: null, attributes: ['jobId', 'cleanupPartition', 'cleanupSortKey'] },
};
const gsiKeys = [{ name: 'cleanupPartition', type: 'HASH' }, { name: 'cleanupSortKey', type: 'RANGE' }];
const arnOf = (ctx: RestoredContext, name: string): string => `arn:aws:dynamodb:${ctx.region}:${ctx.account}:table/${name}`;
const originals = (prefix: string): string[] => TABLE_KEYS.map(key => `${prefix}-production-${schema[key].suffix}`);

export function restoredTableNames(prefix: string, tag: string): Record<TableKey, string> {
  if (!/^e2e-[0-9a-f]{8}$/.test(prefix) || !/^[a-z0-9]{1,8}$/.test(tag)) throw rejectTarget();
  return Object.fromEntries(TABLE_KEYS.map(key => [key, `${prefix}-rst${tag}-${schema[key].suffix}`])) as Record<TableKey, string>;
}
export function restoredTargetFor(names: Record<string, string>, ctx: RestoredContext): RestoredTarget {
  return { tableNames: { ...names }, tableArns: Object.fromEntries(Object.entries(names).map(([key, name]) => [key, arnOf(ctx, name)])) };
}
/** Exactly three owned names with the local account/region ARNs, disjoint from the production tables. */
export function assertRestoredTarget(target: RestoredTarget, ctx: RestoredContext): void {
  const sameKeys = (value: Record<string, string>): boolean => Object.keys(value).sort().join(',') === [...TABLE_KEYS].sort().join(',');
  if (typeof target !== 'object' || target === null || Object.keys(target).sort().join(',') !== 'tableArns,tableNames' || !sameKeys(target.tableNames) || !sameKeys(target.tableArns)) throw rejectTarget();
  const names = TABLE_KEYS.map(key => target.tableNames[key]!);
  if (new Set(names).size !== 3 || names.some(name => typeof name !== 'string' || !/^[A-Za-z0-9_.-]{3,64}$/.test(name) || originals(ctx.prefix).includes(name))) throw rejectTarget();
  for (const key of TABLE_KEYS) if (target.tableArns[key] !== arnOf(ctx, target.tableNames[key]!)) throw rejectTarget();
}
const keySchema = (key: TableKey) => [{ AttributeName: schema[key].hash, KeyType: 'HASH' as const }, ...(schema[key].range ? [{ AttributeName: schema[key].range!, KeyType: 'RANGE' as const }] : [])];
export function createTableInput(name: string, key: TableKey): CreateTableCommandInput {
  return { TableName: name, BillingMode: 'PAY_PER_REQUEST', DeletionProtectionEnabled: true, KeySchema: keySchema(key), AttributeDefinitions: schema[key].attributes.map(AttributeName => ({ AttributeName, AttributeType: 'S' as const })),
    ...(key === 'image_jobs' ? { GlobalSecondaryIndexes: [{ IndexName: 'cleanup_by_due', KeySchema: gsiKeys.map(item => ({ AttributeName: item.name, KeyType: item.type as 'HASH' | 'RANGE' })), Projection: { ProjectionType: 'KEYS_ONLY' as const } }] } : {}) };
}
/** The description a conforming restored set returns (positive control for the checks). */
export function productionDescription(target: RestoredTarget, ctx: RestoredContext): Record<string, DescribedTable> {
  assertRestoredTarget(target, ctx);
  return Object.fromEntries(TABLE_KEYS.map(key => [key, {
    name: target.tableNames[key]!, arn: target.tableArns[key]!, billingMode: 'PAY_PER_REQUEST', deletionProtection: true,
    keys: keySchema(key).map(item => ({ name: item.AttributeName, type: item.KeyType })), attributes: schema[key].attributes.map(name => ({ name, type: 'S' })),
    gsi: key === 'image_jobs' ? [{ name: 'cleanup_by_due', projection: 'KEYS_ONLY', keys: gsiKeys }] : [], pitr: { enabled: true, days: 35 },
    ...(key === 'owner_state' ? { ttl: { enabled: true, attribute: 'expiresAt' } } : {}),
  } satisfies DescribedTable]));
}
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const sorted = (items: { name: string; type: string }[]) => [...items].sort((a, b) => a.name.localeCompare(b.name));
/** Rejects a restored set that differs from the production schema in any one respect; never assumes a missing field is acceptable. */
export function assertRestoredTables(described: Record<string, DescribedTable>, target: RestoredTarget, ctx: RestoredContext): void {
  assertRestoredTarget(target, ctx);
  if (Object.keys(described).sort().join(',') !== [...TABLE_KEYS].sort().join(',')) throw reject();
  for (const key of TABLE_KEYS) {
    const table = described[key]!; const expected = schema[key];
    if (table.name !== target.tableNames[key] || table.arn !== target.tableArns[key] || table.billingMode !== 'PAY_PER_REQUEST' || table.deletionProtection !== true) throw reject();
    if (!same(table.keys, keySchema(key).map(item => ({ name: item.AttributeName, type: item.KeyType }))) || !same(sorted(table.attributes), sorted(expected.attributes.map(name => ({ name, type: 'S' }))))) throw reject();
    if (key === 'image_jobs' ? !(table.gsi.length === 1 && table.gsi[0]!.name === 'cleanup_by_due' && table.gsi[0]!.projection === 'KEYS_ONLY' && same(table.gsi[0]!.keys, gsiKeys)) : table.gsi.length !== 0) throw reject();
    if (table.pitr?.enabled !== true || table.pitr.days !== 35) throw reject();
    if (key === 'owner_state' && !(table.ttl?.enabled === true && table.ttl.attribute === 'expiresAt')) throw reject();
  }
}
const named = (error: unknown): string => error instanceof Error ? error.name : '';
export async function describeTable(db: DynamoSender, name: string): Promise<DescribedTable> {
  const table = ((await db.send(new DescribeTableCommand({ TableName: name }))) as DescribeTableCommandOutput).Table;
  const backups = ((await db.send(new DescribeContinuousBackupsCommand({ TableName: name }))) as DescribeContinuousBackupsCommandOutput).ContinuousBackupsDescription?.PointInTimeRecoveryDescription;
  const ttl = ((await db.send(new DescribeTimeToLiveCommand({ TableName: name }))) as DescribeTimeToLiveCommandOutput).TimeToLiveDescription;
  if (!table) throw reject();
  return {
    ...(table.TableName ? { name: table.TableName } : {}), ...(table.TableArn ? { arn: table.TableArn } : {}), ...(table.BillingModeSummary?.BillingMode ? { billingMode: table.BillingModeSummary.BillingMode } : {}),
    ...(table.DeletionProtectionEnabled !== undefined ? { deletionProtection: table.DeletionProtectionEnabled } : {}),
    keys: (table.KeySchema ?? []).map(item => ({ name: String(item.AttributeName), type: String(item.KeyType) })), attributes: (table.AttributeDefinitions ?? []).map(item => ({ name: String(item.AttributeName), type: String(item.AttributeType) })),
    gsi: (table.GlobalSecondaryIndexes ?? []).map(index => ({ name: String(index.IndexName), projection: String(index.Projection?.ProjectionType), keys: (index.KeySchema ?? []).map(item => ({ name: String(item.AttributeName), type: String(item.KeyType) })) })),
    ...(backups ? { pitr: { enabled: backups.PointInTimeRecoveryStatus === 'ENABLED', ...(backups.RecoveryPeriodInDays !== undefined ? { days: backups.RecoveryPeriodInDays } : {}) } } : {}),
    ...(ttl ? { ttl: { enabled: ttl.TimeToLiveStatus === 'ENABLED', ...(ttl.AttributeName ? { attribute: ttl.AttributeName } : {}) } } : {}),
  };
}
export async function describeRestoredTables(db: DynamoSender, target: RestoredTarget): Promise<Record<string, DescribedTable>> {
  return Object.fromEntries(await Promise.all(TABLE_KEYS.map(async key => [key, await describeTable(db, target.tableNames[key]!)] as const)));
}
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
export async function createRestoredTables(db: DynamoSender, evidence: Evidence, ctx: RestoredContext, tag: string, options: { attempts?: number; delayMs?: number } = {}): Promise<RestoredTarget> {
  const target = restoredTargetFor(restoredTableNames(ctx.prefix, tag), ctx); assertRestoredTarget(target, ctx);
  const intent = (key: TableKey): string => `${evidence.runId}/sdk-table/${target.tableNames[key]!}`;
  // The attempted identity is kept before the create request: a partial request may have succeeded.
  for (const key of TABLE_KEYS) await reserveResource(evidence, { kind: 'sdk-table', name: target.tableNames[key]!, id: intent(key) });
  for (const key of TABLE_KEYS) { await db.send(new CreateTableCommand(createTableInput(target.tableNames[key]!, key))); await markResource(evidence, intent(key), 'created'); }
  const attempts = options.attempts ?? 60; const delayMs = options.delayMs ?? 250;
  for (const key of TABLE_KEYS) {
    let active = false;
    for (let attempt = 0; attempt < attempts && !active; attempt++) { active = ((await db.send(new DescribeTableCommand({ TableName: target.tableNames[key]! }))) as DescribeTableCommandOutput).Table?.TableStatus === 'ACTIVE'; if (!active) await sleep(delayMs); }
    if (!active) throw new Error('RESTORED_TABLE_NOT_ACTIVE');
  }
  await db.send(new UpdateTimeToLiveCommand({ TableName: target.tableNames.owner_state!, TimeToLiveSpecification: { Enabled: true, AttributeName: 'expiresAt' } }));
  for (const key of TABLE_KEYS) await db.send(new UpdateContinuousBackupsCommand({ TableName: target.tableNames[key]!, PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true, RecoveryPeriodInDays: 35 } }));
  assertRestoredTables(await describeRestoredTables(db, target), target, ctx);
  return target;
}
async function absent(db: DynamoSender, name: string, attempts = 40, delayMs = 250): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try { await db.send(new DescribeTableCommand({ TableName: name })); } catch (error) { if (named(error) === 'ResourceNotFoundException') return true; throw error; }
    await sleep(delayMs);
  }
  return false;
}
const ownedName = (name: string): boolean => /^e2e-[0-9a-f]{8}-rst[a-z0-9]{1,8}-(reminders|owner-state|image-jobs)$/.test(name);
async function removeOne(db: DynamoSender, name: string): Promise<void> {
  if (!ownedName(name)) throw new Error('RESTORED_TARGET_REJECTED');
  try { await db.send(new DescribeTableCommand({ TableName: name })); } catch (error) { if (named(error) === 'ResourceNotFoundException') return; throw error; }
  // Protection is released only to delete this run-owned table.
  await db.send(new UpdateTableCommand({ TableName: name, DeletionProtectionEnabled: false }));
  await db.send(new DeleteTableCommand({ TableName: name }));
  if (!await absent(db, name)) throw new Error('RESTORED_TABLE_REMOVAL_FAILED');
}
export async function removeRestoredTables(db: DynamoSender, target: RestoredTarget, evidence?: Evidence): Promise<void> {
  for (const key of TABLE_KEYS) {
    const name = target.tableNames[key]!; await removeOne(db, name);
    // removeOne has read the absence back; the run-end sweep must not count this table again.
    const resource = evidence ? evidenceContext(evidence).manifest.resources.find(item => item.kind === 'sdk-table' && item.name === name && !item.removed) : undefined;
    if (evidence && resource) await markResource(evidence, resource.id, 'removed');
  }
}
/** Run-end recovery: every reserved sdk-table that is not removed is deleted when present and its absence is read back independently. */
export async function sweepRestoredTables(db: DynamoSender, evidence: Evidence): Promise<CleanupSummary> {
  if (!evidenceContext(evidence).finalized) throw new Error('CLEANUP_REJECTED');
  const owned = evidenceContext(evidence).manifest.resources.filter(resource => resource.kind === 'sdk-table' && !resource.removed);
  const result: CleanupSummary = { attempted: owned.length, succeeded: 0, errors: 0, leaks: 0 };
  const prefix = `e2e-${evidence.runId.slice(4, 12)}-`;
  for (const resource of owned) {
    if (!resource.name.startsWith(prefix) || !ownedName(resource.name)) { result.errors++; continue; }
    try { await removeOne(db, resource.name); } catch { /* the independent read below decides */ }
    try {
      if (await absent(db, resource.name, 1, 0)) { await markResource(evidence, resource.id, 'removed'); result.succeeded++; } else result.leaks++;
    } catch { result.errors++; }
  }
  return result;
}
