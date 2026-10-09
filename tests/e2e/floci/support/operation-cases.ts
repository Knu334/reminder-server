import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { DeleteObjectCommand, ListObjectVersionsCommand } from '@aws-sdk/client-s3';
import { GetFunctionConfigurationCommand } from '@aws-sdk/client-lambda';
import { GetRolePolicyCommand } from '@aws-sdk/client-iam';
import { GetScheduleCommand } from '@aws-sdk/client-scheduler';
import { GetCommand, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { caseActions, caseGuards, definitions } from './cases.ts';
import { Score } from './auth-cases.ts';
import { actor, commonHeaders, defer, errorIs, listOf, logOf, send } from './api-cases.ts';
import type { Probe } from './api-cases.ts';
import { exactObject, inspect, isCommitted, versionsOf } from './image-cases.ts';
import { fixtureState, readDeployedSettings } from './fixture.ts';
import { resetStorage } from './storage.ts';
import { TABLE_KEYS, assertRestoredTables, createRestoredTables, describeRestoredTables, removeRestoredTables, restoredTableNames, restoredTargetFor, type RestoredContext } from './restored-tables.ts';
import { buildOperationInputs, captureIo, localMigrationRuntime, localRecoveryRuntime, migrationFault, operationBlocked, projectCliResult, snapshotTables } from './operation-fixtures.ts';
import type { CliProjection, MigrationFault, OperationInputs } from './operation-fixtures.ts';
import { migrationMain } from '../../../../scripts/operations/migrate-json.ts';
import { migrationImageId } from '../../../../scripts/operations/migration.ts';
import { recoveryMain } from '../../../../scripts/operations/verify-recovery.ts';
import type { CaseRecorder, RestoredTarget, SuiteFixture } from './types.ts';

/**
 * Migration, recovery and restored_tables cases (OPS-01..04). Every case owns its inputs, its synthetic users and its data and starts from
 * empty owned storage with no publication row (the migration accepts only an empty target); nothing is shared between cases. The real
 * entry points migrationMain/recoveryMain run with explicit local runtimes, only the fixed safe fields of their output are scored, and every
 * result is then compared with the stored rows, counters, jobs and S3 versions. The API is only used while a case has published its target.
 */
type Row = Record<string, unknown>;
type Tables = { reminders: string; owners: string; jobs: string };
type Ctx = { fixture: SuiteFixture; recorder: CaseRecorder; caseId: string; score: Score; directory: string; restored: RestoredTarget | undefined };
const sourceTables = (fixture: SuiteFixture): Tables => ({ reminders: fixture.config.remindersTable, owners: fixture.config.ownerStateTable, jobs: fixture.config.imageJobsTable });
const targetTables = (target: RestoredTarget): Tables => ({ reminders: target.tableNames.reminders!, owners: target.tableNames.owner_state!, jobs: target.tableNames.image_jobs! });
const context = (fixture: SuiteFixture): RestoredContext => { const b = fixtureState(fixture).stack.bindings; return { prefix: fixture.prefix, account: b.account_id!, region: fixture.target.region }; };
const CREATED: Record<string, string> = { 'ops-a-1': '2026-01-01T18:04:05.678Z', 'ops-ä-2': '2026-01-03T00:00:00.000Z', 'ops-a-3': '2026-01-04T12:00:00.500Z' };
const REMINDER = new Date('2026-11-05T09:30:00+09:00').toISOString();
const sha256Hex = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

const register = (id: string, run: (c: Ctx) => Promise<void>): void => {
  if (!definitions.some(def => def.id === id)) throw new Error('OPERATION_CASE_UNDEFINED');
  caseGuards.set(id, operationBlocked);
  caseActions.set(id, async (fixture, recorder) => {
    const c: Ctx = { fixture, recorder, caseId: id, score: new Score(), directory: await mkdtemp(join(tmpdir(), 'ops-case-')), restored: undefined };
    let failure: unknown; let failed = false;
    try { await fixture.setPublication(false); await quiescent(fixture); await resetStorage(fixture); await run(c); } catch (error) { failure = error; failed = true; }
    // Always: back to the original tables first (only then may the owned SDK tables go), no stray inputs, empty owned storage.
    const closing = async (): Promise<void> => {
      const stack = fixtureState(fixture).stack; let returned = true;
      if (stack.restoredTablesState() !== 'original') { try { await stack.setRestoredTables(null); } catch (error) { returned = false; if (!failed) { failure = error; failed = true; } } }
      if (c.restored && returned) await removeRestoredTables(fixture.clients.dynamodb, c.restored, fixtureState(fixture).evidence);
      await rm(c.directory, { recursive: true, force: true }); await resetStorage(fixture);
    };
    try { await closing(); } catch (error) { if (!failed) { failure = error; failed = true; } }
    if (failed) throw failure; c.score.emit(id, recorder);
  });
};

/** The API input is stopped: nothing outstanding, no cleanup run open, Scheduler disabled and the target not published. */
async function quiescent(fixture: SuiteFixture): Promise<void> {
  const state = fixtureState(fixture); const b = state.stack.bindings;
  if (state.outstanding !== 0 || state.cleanupIntervals.some(interval => !interval.completed)) throw new Error('OPERATION_NOT_QUIESCENT');
  const schedule = await state.scheduler.send(new GetScheduleCommand({ Name: `${b.prefix}-production-cleanup`, GroupName: `${b.prefix}-production-cleanup` }));
  if (schedule.State !== 'DISABLED') throw new Error('OPERATION_NOT_QUIESCENT');
  const gate = (await fixture.clients.dynamodb.send(new GetCommand({ TableName: fixture.config.ownerStateTable, Key: { pk: 'GLOBAL', sk: 'PUBLICATION' }, ConsistentRead: true }))).Item;
  if (gate?.published === true) throw new Error('OPERATION_NOT_QUIESCENT');
}
async function rows(fixture: SuiteFixture, table: string): Promise<Row[]> {
  const found: Row[] = []; let ExclusiveStartKey: Record<string, unknown> | undefined;
  do { const page = await fixture.clients.dynamodb.send(new ScanCommand({ TableName: table, ConsistentRead: true, ...(ExclusiveStartKey ? { ExclusiveStartKey } : {}) })); found.push(...(page.Items ?? [])); ExclusiveStartKey = page.LastEvaluatedKey; } while (ExclusiveStartKey);
  return found;
}
const getRow = async (fixture: SuiteFixture, table: string, Key: Row): Promise<Row | undefined> => (await fixture.clients.dynamodb.send(new GetCommand({ TableName: table, Key, ConsistentRead: true }))).Item;
const storageOf = (fixture: SuiteFixture, tables: Tables, ownerId: string) => getRow(fixture, tables.owners, { pk: `OWNER#${ownerId}`, sk: 'STORAGE' });
const gateOf = (fixture: SuiteFixture, tables: Tables) => getRow(fixture, tables.owners, { pk: 'GLOBAL', sk: 'PUBLICATION' });
/** Everything a recovery or migration may change except its own bookkeeping rows: items, jobs, counters and the gate. */
async function domain(fixture: SuiteFixture, tables: Tables): Promise<string> {
  const owners = (await rows(fixture, tables.owners)).filter(row => !/^(RECOVERY#|MIGRATION#|PUBLICATION$)/.test(String(row.sk)));
  return createHash('sha256').update(JSON.stringify([await rows(fixture, tables.reminders), owners, await rows(fixture, tables.jobs)].map(list => list.map(row => JSON.stringify(Object.entries(row).sort(([a], [b]) => a.localeCompare(b)))).sort()))).digest('hex');
}
async function keyVersions(fixture: SuiteFixture, keys: string[]): Promise<string> {
  const found: string[] = [];
  for (const key of keys) { const page = await fixture.clients.s3.send(new ListObjectVersionsCommand({ Bucket: fixture.config.imagesBucket, Prefix: key })); found.push(JSON.stringify([key, (page.Versions ?? []).filter(item => item.Key === key).map(item => [item.VersionId, item.Size]).sort(), (page.DeleteMarkers ?? []).filter(item => item.Key === key).map(item => item.VersionId).sort()])); }
  return found.sort().join('\n');
}
const refsOf = (list: Row[]): { key: string; versionId: string; imageId: string; mime: string; bytes: number; sha256: string }[] => list.flatMap(row => row.thumbnail && typeof row.thumbnail === 'object' ? [row.thumbnail as never] : []);

type Files = OperationInputs['files'];
type Mode = 'dry-run' | 'import' | 'verify' | 'publish';
async function migrate(c: Ctx, mode: Mode, files: Pick<Files, 'source' | 'mapping' | 'config'>, runId: string, fault?: MigrationFault, restored = false): Promise<CliProjection> {
  const { io, stdout, stderr } = captureIo(); const base = localMigrationRuntime(c.fixture, restored ? c.restored : undefined);
  const code = await migrationMain(['--mode', mode, '--source', files.source, '--mapping', files.mapping, '--config', files.config, ...(mode === 'dry-run' ? [] : ['--run-id', runId])], io, fault ? migrationFault(base, fault) : base);
  return projectCliResult(code, stdout, stderr);
}
async function recover(c: Ctx, files: Files, runId: string, extra: string[] = [], identities = files.ownerIdentities): Promise<CliProjection> {
  const { io, stdout, stderr } = captureIo();
  const code = await recoveryMain(['--source-config', files.config, '--restored-config', files.restoredConfig, '--owner-identities', identities, '--run-id', runId, ...extra], io, localRecoveryRuntime(c.fixture, c.restored!));
  return projectCliResult(code, stdout, stderr);
}
const ok = (result: CliProjection, mode: Mode, fields: Partial<CliProjection> = {}): boolean => result.exitCode === 0 && result.mode === mode && Object.entries(fields).every(([name, value]) => isDeepStrictEqual((result as Record<string, unknown>)[name], value));
const failedCli = (result: CliProjection): boolean => result.exitCode === 2 && result.errorCodes?.includes('MIGRATION_FAILED') === true;
const placeholderRestored = (fixture: SuiteFixture): RestoredTarget => { const ctx = context(fixture); return restoredTargetFor(restoredTableNames(ctx.prefix, 'plc'), ctx); };

/** A published or unpublished readiness answer from the real API, recorded for its result log. */
const readyAnswer = (probe: Probe, status: 200 | 503): boolean => status === 200 ? probe.status === 200 && probe.text === '{"ready":true}' && commonHeaders(probe) : errorIs(probe, 503, 'SERVICE_UNAVAILABLE');
/** Every call is a real Gateway request; only the named ones are also required in the delivered API result logs. */
async function ready(c: Ctx, status: 200 | 503, assertion?: string): Promise<boolean> {
  const probe = await send(c.fixture, '/readyz'); c.recorder.recordInput({ httpStatus: probe.status });
  if (assertion) defer(c.recorder, c.caseId, assertion, logOf(probe, status, status === 503 ? { operation: 'ready', code: 'SERVICE_UNAVAILABLE' } : { operation: 'ready' }));
  return readyAnswer(probe, status);
}
async function begin(c: Ctx, restoredTag?: string): Promise<OperationInputs> {
  if (restoredTag) c.restored = await createRestoredTables(c.fixture.clients.dynamodb, fixtureState(c.fixture).evidence, context(c.fixture), restoredTag);
  return buildOperationInputs(c.fixture, c.restored ?? placeholderRestored(c.fixture), c.directory);
}

/** Compares one imported dataset (three items, two images, one empty owner) with the stored rows, counters, jobs and objects. */
async function importedState(c: Ctx, tables: Tables, inputs: OperationInputs, runId: string, phase: 'importing' | 'verified' | 'published'): Promise<{ items: boolean; counters: boolean; jobs: boolean; objects: boolean; run: boolean; count: number }> {
  const [a, b] = inputs.owners as [OperationInputs['owners'][0], OperationInputs['owners'][0]];
  const list = await rows(c.fixture, tables.reminders); const mine = list.filter(row => row.ownerId === a.ownerId);
  const images = a.items.flatMap((item, position) => item.bytes ? [{ item, position }] : []);
  const items = list.length === 3 && mine.length === 3 && a.items.every((expected, position) => {
    const row = mine.find(entry => entry.id === expected.id); if (!row) return false;
    const image = expected.bytes ? { imageId: migrationImageId(runId, 0, position), key: `images/${a.ownerId}/${migrationImageId(runId, 0, position)}`, mime: expected.mime, bytes: expected.bytes.length, sha256: sha256Hex(expected.bytes) } : null;
    const thumbnail = row.thumbnail as Row | null;
    return row.deleted === false && row.revision === 1 && row.createdAt === CREATED[expected.id] && row.updatedAt === row.createdAt && row.reminderTime === REMINDER && row.autoOpen === false && row.webPush === true && row.hidden === false && row.migrationRunId === runId
      && (image === null ? thumbnail === null : !!thumbnail && thumbnail.imageId === image.imageId && thumbnail.key === image.key && thumbnail.mime === image.mime && thumbnail.bytes === image.bytes && thumbnail.sha256 === image.sha256 && typeof thumbnail.versionId === 'string');
  });
  const total = images.reduce((sum, { item }) => sum + item.bytes!.length, 0); const storageA = await storageOf(c.fixture, tables, a.ownerId); const storageB = await storageOf(c.fixture, tables, b.ownerId);
  const storageRows = (await rows(c.fixture, tables.owners)).filter(row => row.sk === 'STORAGE');
  const counters = storageRows.length === 2 && storageA?.itemCount === 3 && storageA.imageBytes === total && storageA.migrationRunId === runId && storageB?.itemCount === 0 && storageB.imageBytes === 0 && storageB.migrationRunId === runId;
  const jobList = await rows(c.fixture, tables.jobs); const refs = refsOf(mine);
  const jobs = jobList.length === 2 && refs.length === 2 && refs.every(ref => isCommitted(jobList.find(job => job.jobId === ref.imageId) as never, ref as never, a.ownerId));
  let objects = refs.length === 2;
  for (const { item, position } of images) { const ref = refs.find(entry => entry.imageId === migrationImageId(runId, 0, position)); objects &&= !!ref && exactObject(await inspect(c.fixture, ref), ref as never, item.bytes!); }
  const root = await getRow(c.fixture, tables.owners, { pk: 'GLOBAL', sk: `MIGRATION#${runId}` }) as { phase?: string; progress?: { completedItems?: { count?: number }; completedOwners?: { count?: number } } } | undefined;
  const gate = await gateOf(c.fixture, tables);
  const run = root?.phase === phase && root.progress?.completedItems?.count === 3 && root.progress.completedOwners?.count === 2 && gate?.published === (phase === 'published') && gate.runId === runId;
  return { items, counters, jobs, objects, run, count: list.length };
}
const owned = (c: Ctx, inputs: OperationInputs) => versionsOf(c.fixture, inputs.owners[0]!.ownerId);
const sourceBytes = async (inputs: OperationInputs): Promise<string> => sha256Hex(await readFile(inputs.files.source));

register('OPS-01/two-owners-import-verify-publish', async c => {
  const inputs = await begin(c); const runId = randomUUID(); const before = await sourceBytes(inputs); const a = await actor(c.fixture, 'a'); const b = await actor(c.fixture, 'b');
  const dry = await migrate(c, 'dry-run', inputs.files, runId); const untouched = (await rows(c.fixture, sourceTables(c.fixture).reminders)).length === 0 && (await rows(c.fixture, sourceTables(c.fixture).owners)).length === 0;
  c.score.ok('http', 'dry-run-valid-without-aws-exit0', dry.exitCode === 0 && dry.mode === 'dry-run' && dry.valid === true && dry.owners === 2 && dry.items === 3 && untouched);
  const closed = await ready(c, 503, 'ready-503-result-delivered');
  const imported = await migrate(c, 'import', inputs.files, runId); const gated = await send(c.fixture, '/v2/reminders', { token: a.token });
  c.score.ok('http', 'unpublished-ready-503', closed && ok(imported, 'import', { completed: true, owners: 2, items: 3 }) && errorIs(gated, 503, 'SERVICE_UNAVAILABLE') && await ready(c, 503));
  const verified = await migrate(c, 'verify', inputs.files, runId); const publishedCli = await migrate(c, 'publish', inputs.files, runId);
  const after = await importedState(c, sourceTables(c.fixture), inputs, runId, 'published');
  const open = await ready(c, 200, 'ready-200-result-delivered'); const list = await send(c.fixture, '/v2/reminders', { token: a.token }); const empty = await send(c.fixture, '/v2/reminders', { token: b.token });
  defer(c.recorder, c.caseId, 'list-result-delivered', logOf(list, 200, { operation: 'list' }));
  const listed = listOf(list); const others = listOf(empty);
  c.score.ok('http', 'published-ready-200-and-owner-reads-match', ok(verified, 'verify', { exactMatch: true, mismatchCount: 0 }) && ok(publishedCli, 'publish', { exactMatch: true }) && open && !!listed && listed.items.map(item => item.id).join(',') === ['ops-a-1', 'ops-a-3', 'ops-ä-2'].sort().join(',') && listed.items.every(item => item.revision === 1 && item.createdAt === CREATED[String(item.id)] && item.reminderTime === REMINDER) && others?.items.length === 0);
  c.score.ok('dynamodb', 'items-fields-counters-exact-empty-owner-zero-row', after.items && after.counters && after.jobs);
  c.score.ok('dynamodb', 'checkpoint-and-gate-bound-to-run', after.run);
  const versions = await owned(c, inputs);
  c.score.ok('s3', 'pinned-original-bytes-exact-and-source-hash-unchanged', after.objects && versions.versions.length === 2 && versions.markers.length === 0 && before === await sourceBytes(inputs));
});

const strictState = async (c: Ctx, inputs: OperationInputs, tables: Tables): Promise<string> => `${await snapshotTables(c.fixture, [tables.reminders, tables.owners, tables.jobs])}|${JSON.stringify(await owned(c, inputs))}`;
async function bucketVersions(fixture: SuiteFixture): Promise<number> {
  let count = 0; let KeyMarker: string | undefined; let VersionIdMarker: string | undefined;
  do { const page = await fixture.clients.s3.send(new ListObjectVersionsCommand({ Bucket: fixture.config.imagesBucket, ...(KeyMarker ? { KeyMarker } : {}), ...(VersionIdMarker ? { VersionIdMarker } : {}) })); count += (page.Versions?.length ?? 0) + (page.DeleteMarkers?.length ?? 0); KeyMarker = page.NextKeyMarker; VersionIdMarker = page.NextVersionIdMarker; } while (KeyMarker);
  return count;
}

register('OPS-02/interrupted-import-resumes-without-duplicates', async c => {
  const inputs = await begin(c); const runId = randomUUID(); const tables = sourceTables(c.fixture);
  const first = await migrate(c, 'import', inputs.files, runId, { method: 'putImported', nth: 2, phase: 'before' });
  const closedFirst = await ready(c, 503, 'ready-503-result-delivered'); const afterFirst = (await rows(c.fixture, tables.reminders)).length;
  c.score.ok('http', 'before-commit-fault-exit2-unpublished-ready-503', failedCli(first) && closedFirst && afterFirst === 1 && (await gateOf(c.fixture, tables))?.published === false);
  const second = await migrate(c, 'import', inputs.files, runId, { method: 'putImported', nth: 1, phase: 'after' });
  // migration.ts:147-150 (docs/operations/migration.md step 6): a lost putImported response is confirmed by a strong re-read of the item and job and the
  // run continues (progress is saved at :155-156, owners at :158), so the run completes unpublished with exit 0, all 3 rows and no duplicate.
  const afterSecond = await importedState(c, tables, inputs, runId, 'importing'); const sealed = await strictState(c, inputs, tables);
  c.score.ok('http', 'after-commit-fault-reconciled-completes-unpublished-ready-503', ok(second, 'import', { completed: true, owners: 2, items: 3 }) && await ready(c, 503) && (await gateOf(c.fixture, tables))?.published === false);
  c.score.ok('dynamodb', 'reconciled-run-matches-source-and-checkpoint', afterSecond.items && afterSecond.counters && afterSecond.jobs && afterSecond.objects && afterSecond.run && afterSecond.count === 3);
  const resumed = await migrate(c, 'import', inputs.files, runId); const idempotent = sealed === await strictState(c, inputs, tables); const verified = await migrate(c, 'verify', inputs.files, runId); const publish = await migrate(c, 'publish', inputs.files, runId);
  const open = await ready(c, 200, 'ready-200-result-delivered'); const state = await importedState(c, tables, inputs, runId, 'published');
  c.score.ok('http', 'exact-rerun-completes-publishes-ready-200', ok(resumed, 'import', { completed: true, owners: 2, items: 3 }) && idempotent && ok(verified, 'verify', { exactMatch: true, mismatchCount: 0 }) && ok(publish, 'publish', { exactMatch: true }) && open);
  const versions = await owned(c, inputs);
  c.score.ok('dynamodb', 'resume-adds-no-item-version-or-counter', state.items && state.counters && state.jobs && state.count === 3 && state.run);
  c.score.ok('s3', 'one-version-per-image-pinned-bytes-exact', state.objects && versions.versions.length === 2 && versions.markers.length === 0);
  const keys = refsOf(await rows(c.fixture, tables.reminders)).map(ref => ref.key); const before = `${await strictState(c, inputs, tables)}|${await keyVersions(c.fixture, keys)}`;
  const rerun = await migrate(c, 'import', inputs.files, runId); const after = `${await strictState(c, inputs, tables)}|${await keyVersions(c.fixture, keys)}`;
  c.score.ok('dynamodb', 'published-rerun-rejected-state-unchanged', failedCli(rerun) && before === after && (await gateOf(c.fixture, tables))?.published === true);
});

register('OPS-02/changed-inputs-rejected-state-unchanged', async c => {
  const inputs = await begin(c); const runId = randomUUID(); const tables = sourceTables(c.fixture);
  const partial = await migrate(c, 'import', inputs.files, runId, { method: 'putImported', nth: 2, phase: 'before' }); const base = await strictState(c, inputs, tables); const versionsBefore = (await owned(c, inputs)).versions.length;
  const source = join(c.directory, 'source-changed.json'); const mapping = join(c.directory, 'mapping-changed.json'); const config = join(c.directory, 'config-limits.json');
  await writeFile(source, `${await readFile(inputs.files.source, 'utf8')}\n`, { mode: 0o600 }); await writeFile(mapping, `${await readFile(inputs.files.mapping, 'utf8')}\n`, { mode: 0o600 });
  await writeFile(config, JSON.stringify({ ...JSON.parse(await readFile(inputs.files.config, 'utf8')) as Row, limits: { itemCount: 999 } }), { mode: 0o600 });
  const attempts = [{ ...inputs.files, source }, { ...inputs.files, mapping }, { ...inputs.files, config }];
  const results: CliProjection[] = []; let unchanged = true;
  for (const files of attempts) { results.push(await migrate(c, 'import', files, runId)); unchanged &&= base === await strictState(c, inputs, tables); }
  c.score.ok('http', 'changed-source-mapping-and-limits-exit2-ready-503', failedCli(partial) && results.every(failedCli) && await ready(c, 503, 'ready-503-result-delivered'));
  c.score.ok('dynamodb', 'rejected-runs-leave-all-tables-unchanged', unchanged);
  c.score.ok('s3', 'rejected-runs-add-no-object-version', unchanged && (await owned(c, inputs)).versions.length === versionsBefore && versionsBefore === 1);
  const resumed = await migrate(c, 'import', inputs.files, runId); const verified = await migrate(c, 'verify', inputs.files, runId); const state = await importedState(c, tables, inputs, runId, 'verified');
  c.score.ok('dynamodb', 'exact-rerun-resumes-after-rejections', ok(resumed, 'import', { completed: true, items: 3 }) && ok(verified, 'verify', { exactMatch: true, mismatchCount: 0 }) && state.items && state.counters && state.jobs && state.objects && state.run && state.count === 3);
});

register('OPS-02/corrupt-image-and-checksum-mismatch-never-publish', async c => {
  const inputs = await begin(c); const runId = randomUUID(); const tables = sourceTables(c.fixture);
  const corrupt = join(c.directory, 'source-corrupt.json'); const raw = await readFile(inputs.files.source, 'utf8');
  if (!raw.includes('data:image/png;base64,')) throw new Error('OPERATION_SETUP_FAILED');
  await writeFile(corrupt, raw.replace('data:image/png;base64,', 'data:image/png;base64,AAAA'), { mode: 0o600 });
  const bad = { ...inputs.files, source: corrupt }; const dry = await migrate(c, 'dry-run', bad, runId); const refused = await migrate(c, 'import', bad, runId);
  const empty = (await Promise.all(Object.values(tables).map(table => rows(c.fixture, table)))).every(list => list.length === 0);
  c.score.ok('http', 'corrupt-image-dry-run-and-import-exit2', dry.exitCode === 2 && dry.valid === false && refused.exitCode === 2 && refused.valid === false);
  c.score.ok('dynamodb', 'corrupt-source-writes-nothing', empty); c.score.ok('s3', 'rejected-source-stores-no-object', await bucketVersions(c.fixture) === 0);
  const imported = await migrate(c, 'import', inputs.files, runId); const clean = await migrate(c, 'verify', inputs.files, runId);
  const imageId = migrationImageId(runId, 0, 0); const job = await getRow(c.fixture, tables.jobs, { jobId: imageId }); const original = String(job?.sha256);
  const setChecksum = (value: string) => c.fixture.clients.dynamodb.send(new UpdateCommand({ TableName: tables.jobs, Key: { jobId: imageId }, UpdateExpression: 'SET sha256 = :value', ExpressionAttributeValues: { ':value': value } }));
  await setChecksum('f'.repeat(64));
  const tampered = await migrate(c, 'verify', inputs.files, runId); const refusedPublish = await migrate(c, 'publish', inputs.files, runId); const gate = await gateOf(c.fixture, tables);
  c.score.ok('http', 'tampered-job-verify-exit2-publish-refused-ready-503', ok(imported, 'import', { completed: true }) && ok(clean, 'verify', { exactMatch: true }) && tampered.exitCode === 2 && tampered.exactMatch === false && (tampered.mismatchCount ?? 0) > 0 && failedCli(refusedPublish) && await ready(c, 503, 'ready-503-result-delivered'));
  c.score.ok('dynamodb', 'tampered-checksum-keeps-gate-false', gate?.published === false && gate.runId === runId && /^[0-9a-f]{64}$/.test(original) && original !== 'f'.repeat(64));
  await setChecksum(original);
  const fixed = await migrate(c, 'verify', inputs.files, runId); const published = await migrate(c, 'publish', inputs.files, runId);
  c.score.ok('http', 'restored-row-verifies-and-publishes-ready-200', ok(fixed, 'verify', { exactMatch: true, mismatchCount: 0 }) && ok(published, 'publish', { exactMatch: true }) && await ready(c, 200, 'ready-200-result-delivered') && (await importedState(c, tables, inputs, runId, 'published')).run);
});

/** Two unpublished datasets of the same three items: one in the fixture's source tables, one in the owned restored tables. */
async function seed(c: Ctx, inputs: OperationInputs, mapping: string, tables: 'source' | 'restored', runId: string): Promise<boolean> {
  const result = await migrate(c, 'import', { source: inputs.files.source, mapping, config: tables === 'source' ? inputs.files.config : inputs.files.restoredConfig }, runId, undefined, tables === 'restored');
  return ok(result, 'import', { completed: true, owners: 2, items: 3 });
}
const clean = (value: CliProjection['issues']): boolean => !!value && Object.values(value).every(list => list.length === 0);

register('OPS-03/restored-prepare-verify-preserve-rerun', async c => {
  const inputs = await begin(c, 'rp'); const src = sourceTables(c.fixture); const rst = targetTables(c.restored!); const [a] = inputs.owners as [OperationInputs['owners'][0]];
  const stopped = await ready(c, 503, 'ready-503-result-delivered'); const gate = await gateOf(c.fixture, src);
  c.score.ok('http', 'api-input-stopped-source-unpublished-ready-503', stopped && gate?.published !== true && fixtureState(c.fixture).outstanding === 0);
  const runS = randomUUID(); const runR = randomUUID();
  if (!await seed(c, inputs, inputs.files.mapping, 'source', runS) || !await seed(c, inputs, inputs.files.mapping, 'restored', runR)) throw new Error('OPERATION_SETUP_FAILED');
  const restoredRows = (await rows(c.fixture, rst.reminders)).filter(row => row.ownerId === a.ownerId); const stale = restoredRows.find(row => row.id === 'ops-a-1'); const old = stale?.thumbnail as { key: string; versionId: string; imageId: string; bytes: number; mime: string; sha256: string };
  if (!old) throw new Error('OPERATION_SETUP_FAILED');
  // The current object of one restored image goes away behind a delete marker; the pinned version stays readable.
  await c.fixture.clients.s3.send(new DeleteObjectCommand({ Bucket: c.fixture.config.imagesBucket, Key: old.key }));
  const sourceKeys = refsOf(await rows(c.fixture, src.reminders)).map(ref => ref.key);
  const sourceBefore = `${await snapshotTables(c.fixture, Object.values(src))}|${await keyVersions(c.fixture, sourceKeys)}`;
  const runId = randomUUID(); const restoredTables = Object.values(rst);
  const prepared = await recover(c, inputs.files, runId, ['--prepare-restored']); const afterPrepare = await snapshotTables(c.fixture, restoredTables);
  const plain = await recover(c, inputs.files, runId); const afterVerify = await snapshotTables(c.fixture, restoredTables);
  const onlyNoncurrent = (result: CliProjection): boolean => result.exitCode === 2 && result.readyToSwitch === false && result.cognitoCredentialsRestored === false && isDeepStrictEqual(result.issues?.missingImages, ['NONCURRENT_VERSION']) && ['mismatchedOwners', 'countDiscrepancies', 'unresolvedJobs'].every(name => result.issues?.[name]?.length === 0) && result.matched === 2;
  c.score.ok('http', 'verify-reports-only-noncurrent-image', onlyNoncurrent(prepared) && onlyNoncurrent(plain));
  const before = await rows(c.fixture, rst.reminders); const countersBefore = await Promise.all(inputs.owners.map(owner => storageOf(c.fixture, rst, owner.ownerId)));
  const preserved = await recover(c, inputs.files, runId, ['--preserve-images']); const afterPreserve = await snapshotTables(c.fixture, restoredTables);
  const afterRows = await rows(c.fixture, rst.reminders); const next = afterRows.find(row => row.ownerId === a.ownerId && row.id === 'ops-a-1'); const fresh = next?.thumbnail as typeof old | undefined;
  const bytes = a.items[0]!.bytes!; const jobs = await rows(c.fixture, rst.jobs); const freshJob = jobs.find(job => job.jobId === fresh?.imageId);
  const versionsAfterPreserve = JSON.stringify(await versionsOf(c.fixture, a.ownerId));
  const rerun = await recover(c, inputs.files, runId, ['--preserve-images']); const afterRerun = await snapshotTables(c.fixture, restoredTables);
  const ready0 = (result: CliProjection): boolean => result.exitCode === 0 && result.readyToSwitch === true && result.cognitoCredentialsRestored === false && clean(result.issues);
  c.score.ok('http', 'preserve-and-rerun-ready-to-switch-exit0', ready0(preserved) && ready0(rerun));
  const sameButImage = (row: Row): Row => ({ ...row, thumbnail: undefined });
  const keep = before.every(row => { const found = afterRows.find(entry => entry.ownerId === row.ownerId && entry.id === row.id); return !!found && (row.id === 'ops-a-1' ? isDeepStrictEqual(sameButImage(row), sameButImage(found)) : isDeepStrictEqual(row, found)); });
  const countersAfter = await Promise.all(inputs.owners.map(owner => storageOf(c.fixture, rst, owner.ownerId))); const restoredGate = await gateOf(c.fixture, rst);
  c.score.ok('dynamodb', 'restored-created-revision-counters-unchanged-gate-false', keep && afterRows.length === before.length && isDeepStrictEqual(countersBefore, countersAfter) && restoredGate?.published === false && restoredGate.runId === runId && !!fresh && !!freshJob && isCommitted(freshJob as never, fresh as never, a.ownerId) && jobs.length === 3 && next?.revision === 1);
  c.score.ok('dynamodb', 'default-verify-leaves-restored-unchanged', afterPrepare === afterVerify && afterPreserve === afterRerun);
  const current = fresh ? await inspect(c.fixture, fresh) : undefined; const retained = await inspect(c.fixture, old);
  c.score.ok('s3', 'new-unique-current-key-holds-original-bytes', !!fresh && fresh.key !== old.key && fresh.imageId !== old.imageId && fresh.key === `images/${a.ownerId}/${fresh.imageId}` && exactObject(current, fresh as never, bytes) && exactObject(retained, old as never, bytes) && versionsAfterPreserve === JSON.stringify(await versionsOf(c.fixture, a.ownerId)));
  const sourceAfter = `${await snapshotTables(c.fixture, Object.values(src))}|${await keyVersions(c.fixture, sourceKeys)}`;
  c.score.ok('dynamodb', 'source-tables-unchanged', sourceAfter.split('|')[0] === sourceBefore.split('|')[0]);
  c.score.ok('s3', 'source-owned-versions-unchanged', sourceAfter === sourceBefore);
});

/** Independent read of what the running functions and their roles select: the Lambda environments and the two runtime policies. */
async function selection(c: Ctx, names: Record<string, string>): Promise<boolean> {
  const state = fixtureState(c.fixture); const b = state.stack.bindings; const ctx = context(c.fixture); const arn = (name: string): string => `arn:aws:dynamodb:${ctx.region}:${ctx.account}:table/${name}`;
  let selected = true;
  for (const alias of [b.api_alias_arn!, b.cleanup_alias_arn!]) {
    const variables = (await c.fixture.clients.lambda.send(new GetFunctionConfigurationCommand({ FunctionName: alias }))).Environment?.Variables;
    selected &&= variables?.REMINDERS_TABLE === names.reminders && variables?.OWNER_STATE_TABLE === names.owner_state && variables?.IMAGE_JOBS_TABLE === names.image_jobs;
  }
  const others = TABLE_KEYS.flatMap(key => key === 'reminders' ? [] : [key]);
  for (const kind of ['api', 'cleanup'] as const) {
    const document = decodeURIComponent(String((await state.iam.send(new GetRolePolicyCommand({ RoleName: `${b.prefix}-production-${kind}`, PolicyName: `${b.prefix}-production-${kind}-runtime` }))).PolicyDocument));
    selected &&= (kind === 'api' ? TABLE_KEYS : others).every(key => document.includes(arn(names[key]!))) && (names.reminders!.includes('-rst') ? !document.includes(`table/${b.prefix}-production-`) : !document.includes(`table/${b.prefix}-rst`));
  }
  return selected;
}

register('OPS-03/restored-tables-switch-and-return', async c => {
  await begin(c, 'sw'); const target = c.restored!; const ctx = context(c.fixture); const stack = fixtureState(c.fixture).stack; const db = c.fixture.clients.dynamodb;
  const accepted = (): Promise<boolean> => describeRestoredTables(db, target).then(described => { assertRestoredTables(described, target, ctx); return true; }, () => false);
  const schemaOk = await accepted();
  c.score.ok('http', 'restored-descriptors-match-production-schema', schemaOk);
  // Real mutations of the owned set: each one-condition deviation must be refused, and the restored condition accepted again.
  const { UpdateTableCommand, UpdateContinuousBackupsCommand } = await import('@aws-sdk/client-dynamodb');
  await db.send(new UpdateTableCommand({ TableName: target.tableNames.owner_state!, DeletionProtectionEnabled: false })); const noProtection = !await accepted();
  await db.send(new UpdateTableCommand({ TableName: target.tableNames.owner_state!, DeletionProtectionEnabled: true })); const protectedAgain = await accepted();
  await db.send(new UpdateContinuousBackupsCommand({ TableName: target.tableNames.reminders!, PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true, RecoveryPeriodInDays: 7 } })); const shortPitr = !await accepted();
  await db.send(new UpdateContinuousBackupsCommand({ TableName: target.tableNames.reminders!, PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true, RecoveryPeriodInDays: 35 } })); const pitrAgain = await accepted();
  const foreign = { ...target, tableArns: { ...target.tableArns, image_jobs: target.tableArns.image_jobs!.replace(ctx.account, '999999999999') } };
  const refusedForeign = await stack.setRestoredTables(foreign).then(() => false, error => error instanceof Error && error.message === 'RESTORED_TARGET_REJECTED') && stack.restoredTablesState() === 'original';
  c.score.ok('dynamodb', 'bad-restored-descriptors-rejected-before-switch', noProtection && protectedAgain && shortPitr && pitrAgain && refusedForeign);
  await quiescent(c.fixture);
  await stack.setRestoredTables(target); const switched = stack.restoredTablesState() === 'restored' && await selection(c, target.tableNames);
  await stack.setRestoredTables(null); const returned = stack.restoredTablesState() === 'original';
  const original = { reminders: c.fixture.config.remindersTable, owner_state: c.fixture.config.ownerStateTable, image_jobs: c.fixture.config.imageJobsTable };
  const selectedAgain = await selection(c, original); await readDeployedSettings(c.fixture); const settings = fixtureState(c.fixture).settingsComplete;
  c.score.ok('http', 'switch-reads-back-restored-then-return-reads-back-empty', switched && returned && selectedAgain && settings);
  c.score.ok('dynamodb', 'bootstrap-platform-application-readback-consistent', switched && returned && settings);
  await c.fixture.setPublication(true);
  try { c.score.ok('http', 'api-resumed-ready-200-after-return', await ready(c, 200, 'api-resumed-ready-result-delivered')); } finally { await c.fixture.setPublication(false); }
});

/** Restored dataset whose first owner is keyed by an old (deleted-and-recreated) subject, plus the given second owner. */
async function legacyDataset(c: Ctx, inputs: OperationInputs, secondSub: string, runId: string): Promise<void> {
  const mapping = join(c.directory, 'mapping-legacy.json');
  await writeFile(mapping, JSON.stringify([{ legacyKey: '__proto__', issuer: inputs.issuer, sub: inputs.legacySub }, { legacyKey: '', issuer: inputs.issuer, sub: secondSub }]), { mode: 0o600 });
  if (!await seed(c, inputs, mapping, 'restored', runId)) throw new Error('OPERATION_SETUP_FAILED');
}

register('OPS-04/no-automatic-mapping-explicit-remap', async c => {
  const inputs = await begin(c, 'rm'); const rst = targetTables(c.restored!); const [a, b] = inputs.owners as [OperationInputs['owners'][0], OperationInputs['owners'][0]];
  const { ownerIdFor } = await import('../../../../src/api/identity.ts'); const legacy = ownerIdFor(inputs.issuer, inputs.legacySub);
  await legacyDataset(c, inputs, b.sub, randomUUID()); const previous = (await rows(c.fixture, rst.reminders)).filter(row => row.ownerId === legacy); const legacyRefs = refsOf(previous);
  const runId = randomUUID(); const seeded = await domain(c.fixture, rst);
  const unmapped = await recover(c, inputs.files, runId, ['--prepare-restored']);
  const reasons = unmapped.issues?.mismatchedOwners ?? [];
  c.score.ok('http', 'recreated-sub-verify-not-ready-exit2', unmapped.exitCode === 2 && unmapped.readyToSwitch === false && unmapped.cognitoCredentialsRestored === false && reasons.includes('CURRENT_IDENTITY_REQUIRED') && reasons.includes('OWNER_NOT_RESTORED'));
  const untouched = await domain(c.fixture, rst) === seeded && (await rows(c.fixture, rst.reminders)).every(row => row.ownerId !== a.ownerId) && !await storageOf(c.fixture, rst, a.ownerId);
  const mapped = await recover(c, inputs.files, runId, ['--owner-map', inputs.files.ownerMap]); const after = await rows(c.fixture, rst.reminders); const moved = after.filter(row => row.ownerId === a.ownerId); const movedRefs = refsOf(moved);
  const strip = (row: Row): Row => ({ ...row, ownerId: undefined, thumbnail: row.thumbnail ? { mime: (row.thumbnail as Row).mime, bytes: (row.thumbnail as Row).bytes, sha256: (row.thumbnail as Row).sha256 } : null });
  const total = a.items.reduce((sum, item) => sum + (item.bytes?.length ?? 0), 0);
  const jobs = await rows(c.fixture, rst.jobs); const committed = movedRefs.every(ref => isCommitted(jobs.find(job => job.jobId === ref.imageId) as never, ref as never, a.ownerId));
  c.score.ok('dynamodb', 'old-owner-moved-only-by-explicit-map', untouched && mapped.exitCode === 0 && mapped.readyToSwitch === true && moved.length === 3 && previous.length === 3 && previous.every(row => { const found = moved.find(entry => entry.id === row.id); return !!found && isDeepStrictEqual(strip(row), strip(found)); }) && after.every(row => row.ownerId !== legacy) && !await storageOf(c.fixture, rst, legacy) && committed && movedRefs.length === 2);
  const countersB = await storageOf(c.fixture, rst, b.ownerId); const countersA = await storageOf(c.fixture, rst, a.ownerId);
  c.score.ok('dynamodb', 'counters-follow-owner', countersA?.itemCount === 3 && countersA.imageBytes === total && countersB?.itemCount === 0 && countersB.imageBytes === 0);
  c.score.ok('dynamodb', 'cognito-credentials-restored-false', unmapped.cognitoCredentialsRestored === false && mapped.cognitoCredentialsRestored === false);
  let bytesOk = movedRefs.length === 2;
  for (const [index, ref] of movedRefs.entries()) { const original = a.items.find(item => item.bytes && sha256Hex(item.bytes) === ref.sha256); const old = legacyRefs.find(entry => entry.sha256 === ref.sha256); bytesOk &&= !!original && !!old && ref.key !== old.key && ref.key.startsWith(`images/${a.ownerId}/`) && exactObject(await inspect(c.fixture, ref), ref as never, original.bytes!) && !!await inspect(c.fixture, old) && index < 2; }
  c.score.ok('s3', 'moved-images-keep-original-bytes', bytesOk);
  const mappedState = await domain(c.fixture, rst); const keys = movedRefs.map(ref => ref.key); const versions = await keyVersions(c.fixture, keys);
  const rerun = await recover(c, inputs.files, runId, ['--owner-map', inputs.files.ownerMap]);
  c.score.ok('http', 'explicit-map-remap-exit0', mapped.exitCode === 0 && mapped.readyToSwitch === true && clean(mapped.issues));
  c.score.ok('http', 'rerun-remap-idempotent', rerun.exitCode === 0 && rerun.readyToSwitch === true && mappedState === await domain(c.fixture, rst) && versions === await keyVersions(c.fixture, keys));
});

register('OPS-04/collision-and-bad-counter-never-ready', async c => {
  const inputs = await begin(c, 'cb'); const rst = targetTables(c.restored!); const [a] = inputs.owners as [OperationInputs['owners'][0]];
  const { ownerIdFor } = await import('../../../../src/api/identity.ts'); const legacy = ownerIdFor(inputs.issuer, inputs.legacySub);
  await legacyDataset(c, inputs, a.sub, randomUUID());
  // Both restored owners are current identities here, so the only open question is the one condition under test.
  const identities = join(c.directory, 'owner-identities-all.json');
  await writeFile(identities, JSON.stringify([{ ownerId: legacy, issuer: inputs.issuer, sub: inputs.legacySub }, { ownerId: a.ownerId, issuer: inputs.issuer, sub: a.sub }]), { mode: 0o600 });
  const runId = randomUUID(); const control = await recover(c, inputs.files, runId, ['--prepare-restored'], identities);
  const before = await domain(c.fixture, rst); const collision = await recover(c, inputs.files, runId, ['--owner-map', inputs.files.ownerMap], identities);
  const kept = await domain(c.fixture, rst) === before && (await rows(c.fixture, rst.reminders)).filter(row => row.ownerId === legacy).length === 3 && (await rows(c.fixture, rst.reminders)).every(row => row.ownerId !== a.ownerId);
  c.score.ok('dynamodb', 'target-collision-rejected-nothing-moved', control.exitCode === 0 && control.readyToSwitch === true && collision.exitCode === 2 && collision.errorCodes?.includes('RECOVERY_FAILED') === true && kept);
  const key = { pk: `OWNER#${a.ownerId}`, sk: 'STORAGE' };
  const setCount = (value: number) => c.fixture.clients.dynamodb.send(new UpdateCommand({ TableName: rst.owners, Key: key, UpdateExpression: 'SET itemCount = :value', ExpressionAttributeValues: { ':value': value } }));
  await setCount(4); const bad = await recover(c, inputs.files, runId, [], identities); await setCount(0); const fixed = await recover(c, inputs.files, runId, [], identities);
  c.score.ok('dynamodb', 'bad-counter-ready-to-switch-false', bad.exitCode === 2 && bad.readyToSwitch === false && (bad.issues?.countDiscrepancies ?? []).includes('COUNTER_MISMATCH') && fixed.exitCode === 0 && fixed.readyToSwitch === true);
  c.score.ok('http', 'collision-and-bad-counter-exit2-not-ready', collision.exitCode === 2 && bad.exitCode === 2 && bad.readyToSwitch === false);
});
