import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { DeleteObjectsCommand, ListObjectVersionsCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { InvokeCommand } from '@aws-sdk/client-lambda';
import { GetScheduleCommand } from '@aws-sdk/client-scheduler';
import { cleanupKeys } from '../../../../src/images/job-keys.ts';
import { keys } from '../../../../src/shared/ports.ts';
import type { CleanupResult, ImageJob } from '../../../../src/images/types.ts';
import { fixtureState } from './fixture.ts';
import { snapshotOwnedStorage } from './storage.ts';
import type { SuiteFixture } from './types.ts';

/**
 * Real-cleanup fixtures. Every object they write is run-owned: the image-jobs table and the images bucket belong to this run, jobs and
 * versions are always under one synthetic owner, and the cleanup Lambda itself is only ever invoked synchronously through the
 * confirmed-stopped Scheduler's production alias. The product gets no test clock and no cap override: synthetic timestamps live in the
 * seeded job data, with a margin of minutes on both sides of every boundary.
 */
export const DAY = 86_400_000; export const LEASE = 1_200_000; export const MARGIN = 600_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i; const OWNER = /^[a-f0-9]{64}$/;
const ALLOWED = ['jobId', 'ownerId', 'key', 'state', 'createdAtMs', 'updatedAtMs', 'dueAtMs', 'leaseOwner', 'versionId', 'mime', 'bytes', 'sha256', 'cleanupPartition', 'cleanupSortKey', 'migrationRunId'];
export type Job = ImageJob & Record<string, unknown>;
export type CleanupInvocation = { startedAt: number; finishedAt: number; status: number; functionError?: 'Unhandled' | 'Handled' | 'Unknown'; result?: CleanupResult; storageUnchanged: boolean };

/** Seams: the defaults talk to Lambda/Scheduler through the run fixture; the offline double replaces them. */
export const cleanupIo = {
  sleep: (ms: number): Promise<void> => new Promise<void>(resolve => setTimeout(resolve, ms)),
  gsiDeadlineMs: 30_000,
  ownedTable: (fixture: SuiteFixture): boolean => fixture.config.imageJobsTable.startsWith(`${fixture.prefix}-`) && fixture.config.imageJobsTable.endsWith('image-jobs'),
  async stopped(fixture: SuiteFixture): Promise<boolean> { const state = fixtureState(fixture); const b = state.stack.bindings; const schedule = await state.scheduler.send(new GetScheduleCommand({ Name: `${b.prefix}-production-cleanup`, GroupName: `${b.prefix}-production-cleanup` })); return schedule.State === 'DISABLED'; },
  async invoke(fixture: SuiteFixture, payload: Buffer): Promise<{ status: number; functionError?: string; payload?: Buffer }> {
    const state = fixtureState(fixture); const budget = state.budget?.allow('cleanupInvoke') ?? 700_000; if (budget <= 0) throw new Error('CLEANUP_BUDGET_EXHAUSTED');
    // RequestResponse only: an accepted asynchronous event (202) is never treated as processed work.
    const out = await fixture.clients.lambda.send(new InvokeCommand({ FunctionName: state.stack.bindings.cleanup_alias_arn!, InvocationType: 'RequestResponse', Payload: payload }), { requestTimeout: budget, abortSignal: AbortSignal.timeout(budget) });
    return { status: out.StatusCode ?? 0, ...(out.FunctionError ? { functionError: out.FunctionError } : {}), ...(out.Payload ? { payload: Buffer.from(out.Payload) } : {}) };
  },
};

/** A run-time shape check mirroring the product's job schema, applied before anything is written or after any synthetic rewrite. */
export function validateSeedJob(value: ImageJob): void {
  const fail = (): never => { throw new Error('SEED_JOB_REJECTED'); };
  const job = value as unknown as Record<string, unknown>;
  if (typeof job !== 'object' || job === null || Object.keys(job).some(name => !ALLOWED.includes(name) || job[name] === undefined)) fail();
  const { jobId, ownerId, key, state, createdAtMs, updatedAtMs, dueAtMs, leaseOwner, versionId, sha256, bytes, mime } = job; if (typeof state !== 'string') fail();
  const time = (item: unknown): boolean => Number.isSafeInteger(item) && (item as number) >= 0 && (item as number) <= 9_999_999_999_999;
  if (typeof jobId !== 'string' || !UUID.test(jobId) || typeof ownerId !== 'string' || !OWNER.test(ownerId) || key !== keys.image(ownerId, jobId)) fail();
  if (!['pending', 'committed', 'retired', 'deleting', 'done'].includes(String(state)) || !time(createdAtMs) || !time(updatedAtMs)) fail();
  if (versionId !== undefined && (typeof versionId !== 'string' || versionId.length === 0 || versionId === 'null')) fail();
  if (sha256 !== undefined && (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256))) fail();
  if (bytes !== undefined && (!Number.isSafeInteger(bytes) || (bytes as number) < 1)) fail();
  if (mime !== undefined && !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(String(mime))) fail();
  if (state === 'pending' || state === 'retired' || state === 'deleting') {
    if (!time(dueAtMs)) fail(); const expected = cleanupKeys(state as 'pending', jobId as string, dueAtMs as number);
    if (job.cleanupPartition !== expected.cleanupPartition || job.cleanupSortKey !== expected.cleanupSortKey) fail();
    if (state === 'pending' && dueAtMs !== (createdAtMs as number) + DAY) fail();
    if (state !== 'deleting' && leaseOwner !== undefined) fail(); if (state === 'deleting' && leaseOwner !== undefined && (typeof leaseOwner !== 'string' || !leaseOwner)) fail();
  } else if (['cleanupPartition', 'cleanupSortKey', 'dueAtMs', 'leaseOwner'].some(name => job[name] !== undefined)) fail();
}

export type JobSpec = { ownerId: string; jobId: string; state: ImageJob['state']; createdAtMs?: number; dueAtMs?: number; leaseOwner?: string; versionId?: string; mime?: string; bytes?: number; sha256?: string };
/** A product-shaped job: cleanup keys derived by the product's own key function, never typed by hand. */
export function makeCleanupJob(spec: JobSpec): Job {
  const createdAtMs = spec.createdAtMs ?? Date.now(); const candidate = spec.state === 'pending' || spec.state === 'retired' || spec.state === 'deleting';
  const dueAtMs = spec.state === 'pending' ? createdAtMs + DAY : spec.dueAtMs;
  const job: Record<string, unknown> = { jobId: spec.jobId, ownerId: spec.ownerId, key: keys.image(spec.ownerId, spec.jobId), state: spec.state, createdAtMs, updatedAtMs: createdAtMs };
  if (candidate && dueAtMs !== undefined && Number.isSafeInteger(dueAtMs) && dueAtMs >= 0) Object.assign(job, { dueAtMs, ...cleanupKeys(spec.state as 'pending', spec.jobId, dueAtMs) });
  for (const name of ['leaseOwner', 'versionId', 'mime', 'bytes', 'sha256'] as const) if (spec[name] !== undefined) job[name] = spec[name];
  return job as Job;
}
const isCandidate = (job: ImageJob): boolean => job.state === 'pending' || job.state === 'retired' || job.state === 'deleting';

/** Visible in the real sparse GSI before any invoke: the poll is bounded and a timeout is a failure, not a silent early invoke. */
export async function awaitGsi(fixture: SuiteFixture, jobs: ImageJob[]): Promise<void> {
  const wanted = jobs.filter(isCandidate); if (!wanted.length) return;
  const partitions = [...new Set(wanted.map(job => String(job.cleanupPartition)))]; const deadline = Date.now() + cleanupIo.gsiDeadlineMs;
  for (;;) {
    const seen = new Set<string>();
    for (const partition of partitions) {
      const cutoff = wanted.filter(job => job.cleanupPartition === partition).map(job => String(job.cleanupSortKey)).sort().at(-1)!; let ExclusiveStartKey: Record<string, unknown> | undefined;
      do { const page = await fixture.clients.dynamodb.send(new QueryCommand({ TableName: fixture.config.imageJobsTable, IndexName: 'cleanup_by_due', KeyConditionExpression: '#partition = :partition AND #sort <= :cutoff', ExpressionAttributeNames: { '#partition': 'cleanupPartition', '#sort': 'cleanupSortKey' }, ExpressionAttributeValues: { ':partition': partition, ':cutoff': cutoff }, ...(ExclusiveStartKey ? { ExclusiveStartKey } : {}) }));
        for (const item of page.Items ?? []) seen.add(`${String(item.cleanupPartition)}|${String(item.cleanupSortKey)}`); ExclusiveStartKey = page.LastEvaluatedKey; } while (ExclusiveStartKey);
    }
    if (wanted.every(job => seen.has(`${String(job.cleanupPartition)}|${String(job.cleanupSortKey)}`))) return;
    if (Date.now() >= deadline) throw new Error('CLEANUP_GSI_TIMEOUT'); await cleanupIo.sleep(500);
  }
}

/** Writes owned synthetic jobs (validated first, read back strongly, then waited for in the GSI). */
export async function seedCleanupJobs(fixture: SuiteFixture, jobs: ImageJob[]): Promise<void> {
  for (const job of jobs) validateSeedJob(job);
  if (new Set(jobs.map(job => job.jobId)).size !== jobs.length) throw new Error('SEED_JOB_REJECTED');
  if (!cleanupIo.ownedTable(fixture)) throw new Error('SEED_TABLE_NOT_OWNED');
  for (const job of jobs) {
    await fixture.clients.dynamodb.send(new PutCommand({ TableName: fixture.config.imageJobsTable, Item: job, ConditionExpression: 'attribute_not_exists(#id)', ExpressionAttributeNames: { '#id': 'jobId' } }));
    const stored = await fixture.clients.dynamodb.send(new GetCommand({ TableName: fixture.config.imageJobsTable, Key: { jobId: job.jobId }, ConsistentRead: true }));
    if (!isDeepStrictEqual(stored.Item, job)) throw new Error('SEED_READBACK_MISMATCH');
  }
  await awaitGsi(fixture, jobs);
}

export type Retime = { state: 'pending' | 'retired' | 'deleting'; createdAtMs?: number; dueAtMs?: number; leaseOwner?: string; dropVersion?: boolean };
/**
 * Synthetic time/state preparation for a job that a real API transition created: only that owner's job in its expected state is
 * rewritten, the result is revalidated against the product shape, and the GSI is awaited. The API's own transition is asserted by the caller before this.
 */
export async function retimeJob(fixture: SuiteFixture, ownerId: string, jobId: string, from: ImageJob['state'], change: Retime): Promise<Job> {
  const read = await fixture.clients.dynamodb.send(new GetCommand({ TableName: fixture.config.imageJobsTable, Key: { jobId }, ConsistentRead: true })); const current = read.Item as Job | undefined;
  if (!current || current.ownerId !== ownerId || current.state !== from) throw new Error('RETIME_REJECTED');
  const dueAtMs = change.state === 'pending' ? change.createdAtMs! + DAY : change.dueAtMs; if (dueAtMs === undefined || (change.state === 'pending' && change.createdAtMs === undefined) || (change.state === 'deleting') !== (change.leaseOwner !== undefined)) throw new Error('RETIME_REJECTED');
  const next: Record<string, unknown> = { ...current, state: change.state, dueAtMs, updatedAtMs: Date.now(), ...cleanupKeys(change.state, jobId, dueAtMs) };
  if (change.createdAtMs !== undefined) next.createdAtMs = change.createdAtMs; if (change.leaseOwner !== undefined) next.leaseOwner = change.leaseOwner; else delete next.leaseOwner;
  if (change.dropVersion) for (const name of ['versionId', 'mime', 'bytes', 'sha256']) delete next[name];
  validateSeedJob(next as unknown as ImageJob);
  await fixture.clients.dynamodb.send(new PutCommand({ TableName: fixture.config.imageJobsTable, Item: next, ConditionExpression: '#owner = :owner AND #state = :from', ExpressionAttributeNames: { '#owner': 'ownerId', '#state': 'state' }, ExpressionAttributeValues: { ':owner': ownerId, ':from': from } }));
  const stored = (await fixture.clients.dynamodb.send(new GetCommand({ TableName: fixture.config.imageJobsTable, Key: { jobId }, ConsistentRead: true }))).Item;
  if (!isDeepStrictEqual(stored, next)) throw new Error('SEED_READBACK_MISMATCH'); await awaitGsi(fixture, [next as unknown as ImageJob]); return next as Job;
}

/** A synthetic original written straight to the owned key (the API path creates its own through real transitions). */
export async function putOwnedObject(fixture: SuiteFixture, ownerId: string, jobId: string, data: Buffer, mime = 'image/png'): Promise<{ key: string; versionId: string; sha256: string; bytes: number }> {
  const key = keys.image(ownerId, jobId); const sha256 = createHash('sha256').update(data).digest('hex');
  const out = await fixture.clients.s3.send(new PutObjectCommand({ Bucket: fixture.config.imagesBucket, Key: key, Body: data, ContentType: mime, ChecksumSHA256: Buffer.from(sha256, 'hex').toString('base64') }));
  if (!out.VersionId || out.VersionId === 'null') throw new Error('STORAGE_MISMATCH'); return { key, versionId: out.VersionId, sha256, bytes: data.length };
}

export async function readCheckpoint(fixture: SuiteFixture): Promise<Record<string, unknown> | undefined> { return (await fixture.clients.dynamodb.send(new GetCommand({ TableName: fixture.config.imageJobsTable, Key: { jobId: keys.cleanupCheckpoint }, ConsistentRead: true }))).Item; }
/** The checkpoint is a run-owned control row: every case starts from an empty rotation so its counts do not depend on another case. */
export async function resetCheckpoint(fixture: SuiteFixture): Promise<void> { if (!cleanupIo.ownedTable(fixture)) throw new Error('SEED_TABLE_NOT_OWNED'); await fixture.clients.dynamodb.send(new DeleteCommand({ TableName: fixture.config.imageJobsTable, Key: { jobId: keys.cleanupCheckpoint } })); }
async function jobRows(fixture: SuiteFixture): Promise<Job[]> {
  const found: Job[] = []; let ExclusiveStartKey: Record<string, unknown> | undefined;
  do { const page = await fixture.clients.dynamodb.send(new ScanCommand({ TableName: fixture.config.imageJobsTable, ConsistentRead: true, ...(ExclusiveStartKey ? { ExclusiveStartKey } : {}) })); for (const item of page.Items ?? []) if (item.jobId !== keys.cleanupCheckpoint) found.push(item as Job); ExclusiveStartKey = page.LastEvaluatedKey; } while (ExclusiveStartKey);
  return found;
}
/** Cleanup processes every due job in the table. A candidate that belongs to anyone but this case stops the case before any invoke. */
export async function assertNoForeignJobs(fixture: SuiteFixture, ownerIds: string[]): Promise<void> { if ((await jobRows(fixture)).some(job => !ownerIds.includes(String(job.ownerId)))) throw new Error('CLEANUP_FOREIGN_JOBS'); }
/** Removes only this case's synthetic jobs and object versions (a test-fixture recovery role, separate from the product's marker-only deletes). */
export async function collectOwned(fixture: SuiteFixture, ownerIds: string[]): Promise<{ jobs: number; versions: number }> {
  if (!cleanupIo.ownedTable(fixture)) throw new Error('SEED_TABLE_NOT_OWNED'); let jobs = 0; let versions = 0;
  for (const job of await jobRows(fixture)) if (ownerIds.includes(String(job.ownerId))) { await fixture.clients.dynamodb.send(new DeleteCommand({ TableName: fixture.config.imageJobsTable, Key: { jobId: job.jobId } })); jobs++; }
  await resetCheckpoint(fixture);
  for (const ownerId of ownerIds) {
    if (!OWNER.test(ownerId)) throw new Error('OWNER_REJECTED'); const Prefix = `images/${ownerId}/`; let KeyMarker: string | undefined; let VersionIdMarker: string | undefined; const Objects: { Key: string; VersionId: string }[] = [];
    do { const page = await fixture.clients.s3.send(new ListObjectVersionsCommand({ Bucket: fixture.config.imagesBucket, Prefix, ...(KeyMarker ? { KeyMarker } : {}), ...(VersionIdMarker ? { VersionIdMarker } : {}) })); for (const item of [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])]) { if (!item.Key?.startsWith(Prefix)) throw new Error('STORAGE_MISMATCH'); Objects.push({ Key: item.Key, VersionId: item.VersionId! }); } KeyMarker = page.NextKeyMarker; VersionIdMarker = page.NextVersionIdMarker; if (page.IsTruncated && !KeyMarker) throw new Error('STORAGE_MISMATCH'); } while (KeyMarker);
    for (let start = 0; start < Objects.length; start += 500) { const removed = await fixture.clients.s3.send(new DeleteObjectsCommand({ Bucket: fixture.config.imagesBucket, Delete: { Objects: Objects.slice(start, start + 500) } })); if (removed.Errors?.length) throw new Error('CLEANUP_COLLECT_FAILED'); }
    versions += Objects.length; const check = await fixture.clients.s3.send(new ListObjectVersionsCommand({ Bucket: fixture.config.imagesBucket, Prefix })); if (check.Versions?.length || check.DeleteMarkers?.length) throw new Error('CLEANUP_COLLECT_FAILED');
  }
  if ((await jobRows(fixture)).some(job => ownerIds.includes(String(job.ownerId)))) throw new Error('CLEANUP_COLLECT_FAILED'); return { jobs, versions };
}

/**
 * One tracked synchronous invoke. It never throws on a FunctionError behind HTTP 200: the error is reported and the result withheld.
 * Invokes run strictly one after another, only with the Scheduler confirmed stopped. The interval is registered for the suite's log correlation.
 */
export async function invokeCleanup(fixture: SuiteFixture, event: unknown = {}): Promise<CleanupInvocation> {
  const state = fixtureState(fixture); const payload = JSON.stringify(event); if (!payload || Buffer.byteLength(payload) > 1024) throw new Error('CLEANUP_EVENT_REJECTED');
  if (state.cleanupIntervals.some(interval => !interval.completed)) throw new Error('CLEANUP_NOT_SEQUENTIAL');
  if (!await cleanupIo.stopped(fixture)) throw new Error('CLEANUP_SCHEDULER_NOT_STOPPED');
  const before = await snapshotOwnedStorage(fixture); const interval: import('./logs.ts').CleanupCompletion = { since: Date.now(), until: 0, completed: false }; state.cleanupIntervals.push(interval);
  const raw = await cleanupIo.invoke(fixture, Buffer.from(payload)); interval.until = Date.now(); interval.completed = true; interval.status = raw.status;
  const functionError = raw.functionError === undefined ? undefined : raw.functionError === 'Unhandled' || raw.functionError === 'Handled' ? raw.functionError : 'Unknown' as const;
  let result: CleanupResult | undefined;
  if (!functionError && raw.payload) {
    try { const parsed: unknown = JSON.parse(raw.payload.toString('utf8')); if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) { const safe = parsed as Record<string, unknown>;
      if (Number.isSafeInteger(safe.evaluated) && Number(safe.evaluated) >= 0 && Number.isSafeInteger(safe.deletes) && Number(safe.deletes) >= 0 && typeof safe.incomplete === 'boolean' && typeof safe.skippedUnpublished === 'boolean') result = { evaluated: Number(safe.evaluated), deletes: Number(safe.deletes), incomplete: safe.incomplete, skippedUnpublished: safe.skippedUnpublished }; } } catch { result = undefined; }
  }
  if (result) interval.result = result;
  const storageUnchanged = before === await snapshotOwnedStorage(fixture); interval.storageUnchanged = storageUnchanged;
  return { startedAt: interval.since, finishedAt: interval.until, status: raw.status, ...(functionError ? { functionError } : {}), ...(result ? { result } : {}), storageUnchanged };
}
