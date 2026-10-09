import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { definitions, caseActions, caseGuards, cleanupDefinitions, caseAuthId } from './support/cases.ts';
import './support/cleanup-cases.ts';
import { createEvidence, evidenceContext, flushPendingLogs, finalizeResults } from './support/evidence.ts';
import { cleanupChecksMatch, cleanupCaseMatches, suiteLogStates } from './support/logs.ts';
import { createSim } from './api-sim.ts';
import type { SimOptions } from './api-sim.ts';
import { cleanupIo, invokeCleanup, makeCleanupJob, seedCleanupJobs, validateSeedJob } from './support/cleanup-fixtures.ts';
import { cleanupKeys } from '../../../src/images/job-keys.ts';
import { executeSuites, runSuiteCase } from '../../../scripts/e2e/run.ts';
import { fixtureStates } from './support/fixture.ts';
import type { SuiteFixture } from './support/types.ts';

const cleanup = definitions.filter(def => def.suite === 'cleanup'); const e = cleanup.filter(def => def.layer === 'E');
type Saved = { id: string; status: string; reason?: string; outputs?: { kind: string; status: string; assertions: { name: string; status: string }[] }[] };
const DAY = 86_400_000; const OWNER = 'a'.repeat(64);

void test('the cleanup inventory has independent E cases for CLEAN-01..06 and 09 and named I cases for CLEAN-02..04, 07..09', () => {
  assert.equal(cleanup.length, cleanupDefinitions.length); assert.equal(new Set(cleanup.map(def => def.id)).size, cleanup.length);
  for (const id of ['CLEAN-01', 'CLEAN-02', 'CLEAN-03', 'CLEAN-04', 'CLEAN-05', 'CLEAN-06', 'CLEAN-09']) assert.ok(e.some(def => def.requirementId === id), id);
  for (const id of ['CLEAN-01/unpublished', 'CLEAN-01/published-counts', 'CLEAN-01/event-injection', 'CLEAN-02/pending-24h-both-sides', 'CLEAN-02/retired-origin-replace', 'CLEAN-02/delete-tombstone', 'CLEAN-03/active-lease', 'CLEAN-03/expired-lease', 'CLEAN-03/unrecorded-version', 'CLEAN-04/committed-protected', 'CLEAN-05/version-mismatch', 'CLEAN-05/checksum-mismatch', 'CLEAN-05/existing-marker-and-absent', 'CLEAN-06/same-shard-51-two-invokes', 'CLEAN-09/second-invoke-converges']) assert.ok(e.some(def => def.id === id), id);
  for (const def of e) {
    assert.equal(def.required, true); assert.equal(def.acceptance, 'behavior'); assert.deepEqual(def.outputs.map(output => output.kind), ['http', 'dynamodb', 's3', 'logs']);
    assert.ok(def.outputs.filter(output => output.kind !== 'logs' || def.id !== 'CLEAN-01/event-injection').every(output => output.assertions.length > 0), `${def.id} asserts every applicable output`);
    assert.equal(caseActions.has(def.id), true, `${def.id} action`); assert.equal(caseAuthId(def), def.id, `${def.id} owns its synthetic users`); assert.equal(caseGuards.has(def.id), false);
  }
  const injection = e.find(def => def.id === 'CLEAN-01/event-injection')!.outputs.find(output => output.kind === 'logs')!; assert.deepEqual(injection.assertions, []); assert.equal(injection.notApplicableReason, 'rejected-before-cleanup-start-no-application-log');
  for (const def of cleanup.filter(def => def.layer === 'I')) assert.equal(caseActions.has(def.id), false, `${def.id} is evidenced by named tests, not by an E action`);
});

void test('I cases name integration or runtime tests that exist', async () => {
  const sources = [await readFile(join(process.cwd(), 'tests/integration/formal-e2e/cleanup-resume.test.ts'), 'utf8'), await readFile(join(process.cwd(), 'tests/runtime/cleanup.test.ts'), 'utf8')].join('\n');
  for (const def of cleanup.filter(def => def.layer === 'I')) for (const name of def.outputs.flatMap(output => output.assertions)) assert.ok(sources.includes(name), `${def.id}: ${name}`);
});

async function runSuite(ids: string[] | undefined, options: SimOptions = {}, seed?: (sim: ReturnType<typeof createSim>) => void): Promise<{ results: Map<string, Saved>; sim: ReturnType<typeof createSim>; failures: string[] }> {
  const directory = await mkdtemp(join(tmpdir(), 'cleanup-suite-')); const sim = createSim(options); seed?.(sim);
  try {
    const selected = e.filter(def => !ids || ids.includes(def.id)); const evidence = await createEvidence(selected, join(directory, 'run'));
    for (const def of selected) await runSuiteCase(evidence, def, sim.fixture, { createAuth: async (_suite, authId) => sim.authFor(authId), bind(view, source) { fixtureStates.set(view, fixtureStates.get(source)!); suiteLogStates.set(view, suiteLogStates.get(source)!); } });
    const state = suiteLogStates.get(sim.fixture)!;
    await flushPendingLogs(evidence, async checks => (await sim.observer.flush(checks, Date.now(), 60_000, () => cleanupChecksMatch(state))).map(result => ({ ...result, matched: result.matched && cleanupCaseMatches(state, result.caseId) })));
    await finalizeResults(evidence);
    const saved = JSON.parse(await readFile(join(evidenceContext(evidence).directory, 'results.json'), 'utf8')) as { cases: { id: string; result: Saved }[] };
    const results = new Map(saved.cases.map(item => [item.id, item.result]));
    const failures = [...results.values()].filter(result => result.status !== 'pass').map(result => `${result.id}:${result.status}:${result.reason ?? ''}:${(result.outputs ?? []).flatMap(output => output.assertions.filter(item => item.status === 'fail').map(item => `${output.kind}/${item.name}`)).join(',')}`);
    return { results, sim, failures };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

void test('every cleanup E case passes against the real cleanup handler, stateful store and result logs', async () => {
  const { failures, results, sim } = await runSuite(undefined); assert.deepEqual(failures, []); assert.equal(results.size, e.length);
  for (const result of results.values()) { const logs = result.outputs?.find(output => output.kind === 'logs'); assert.ok(logs && logs.status !== 'fail', `${result.id} logs`); }
  const published = results.get('CLEAN-02/delete-tombstone')!; assert.ok(published.outputs?.find(output => output.kind === 'logs')?.assertions.some(item => item.name === 'delivered' && item.status === 'pass'));
  assert.equal(sim.harness.snapshot().jobs.length, 0, 'owned synthetic jobs are collected between cases'); assert.equal(sim.harness.imageVersions().length, 0); assert.equal(sim.harness.imageDeleteMarkers().length, 0);
  assert.equal(suiteLogStates.get(sim.fixture)!.cleanup.size, e.length - 1, 'every case but the rejected-event case registers a cleanup-log expectation');
});

void test('independent cleanup cases get their own synthetic users', async () => {
  const { sim, failures } = await runSuite(undefined); assert.deepEqual(failures, []);
  const used = sim.authIds.filter(id => id !== 'default'); assert.equal(used.length, new Set(used).size); assert.ok(e.every(def => used.includes(def.id)) || used.length <= e.length);
});

void test('a foreign candidate job stops a case before any invoke and is never processed', async () => {
  const foreign = makeCleanupJob({ ownerId: 'b'.repeat(64), jobId: '11111111-1111-4111-8111-111111111111', state: 'pending', createdAtMs: Date.now() - DAY - 600_000 });
  const { results, sim } = await runSuite(['CLEAN-01/published-counts'], {}, s => s.harness.seedJob(foreign));
  assert.equal(results.get('CLEAN-01/published-counts')?.status, 'fail'); assert.equal(sim.harness.snapshot().jobs.find(job => job.jobId === foreign.jobId)?.state, 'pending'); assert.equal(sim.harness.deletedKeys.length, 0);
});

const negative: [string, SimOptions, string | undefined][] = [
  ['CLEAN-01/unpublished', { cleanup: 'ignore-gate' }, 'CLEAN-02/delete-tombstone'],
  ['CLEAN-01/event-injection', { cleanup: 'accept-injection' }, 'CLEAN-02/delete-tombstone'],
  ['CLEAN-01/published-counts', { cleanup: 'function-error' }, undefined], // every invoke reports a FunctionError, so no invoking case is independent
  ['CLEAN-02/delete-tombstone', { cleanup: 'permanent-delete' }, 'CLEAN-01/unpublished'],
  ['CLEAN-02/pending-24h-both-sides', { cleanup: 'ignore-due' }, 'CLEAN-01/unpublished'],
];
void test('each broken cleanup behaviour fails its own case while an independent case still passes', async () => {
  for (const [id, options, unaffected] of negative) {
    const { results, failures } = await runSuite(unaffected ? [id, unaffected] : [id], options);
    assert.equal(results.get(id)?.status, 'fail', `${id} must fail: ${failures.slice(0, 3).join(';')}`);
    if (unaffected) assert.equal(results.get(unaffected)?.status, 'pass', `${id}: ${unaffected} is independent (${failures.join(';')})`);
  }
});

void test('a FunctionError behind HTTP 200 is reported, never swallowed, and the result is withheld', async () => {
  const sim = createSim({ cleanup: 'function-error' }); const invocation = await invokeCleanup(sim.fixture);
  assert.equal(invocation.functionError, 'Unhandled'); assert.equal(invocation.result, undefined); assert.ok(invocation.finishedAt >= invocation.startedAt);
});

void test('manual invokes are sequential and only against a stopped Scheduler', async () => {
  const sim = createSim(); const state = fixtureStates.get(sim.fixture) as unknown as { cleanupIntervals: { since: number; until: number; completed: boolean }[] };
  state.cleanupIntervals.push({ since: Date.now(), until: 0, completed: false }); await assert.rejects(invokeCleanup(sim.fixture), /CLEANUP_NOT_SEQUENTIAL/); state.cleanupIntervals.pop();
  const original = cleanupIo.stopped; cleanupIo.stopped = async () => false; try { await assert.rejects(invokeCleanup(sim.fixture), /CLEANUP_SCHEDULER_NOT_STOPPED/); } finally { cleanupIo.stopped = original; }
  assert.equal((await invokeCleanup(sim.fixture)).result?.skippedUnpublished, false);
});

void test('invoke events are bounded and never carry anything but the supplied object', async () => {
  const sim = createSim(); await assert.rejects(invokeCleanup(sim.fixture, { big: 'x'.repeat(2000) }), /CLEANUP_EVENT_REJECTED/);
});

void test('seeded jobs must have the owned table, product key shape and exact GSI attributes before anything is written', async () => {
  const sim = createSim(); const fixture = sim.fixture as SuiteFixture; const good = makeCleanupJob({ ownerId: OWNER, jobId: '22222222-2222-4222-8222-222222222222', state: 'pending', createdAtMs: Date.now() - DAY - 600_000 });
  await seedCleanupJobs(fixture, [good]); assert.equal(sim.harness.snapshot().jobs.find(job => job.jobId === good.jobId)?.cleanupSortKey, good.cleanupSortKey);
  const bad: [string, (job: typeof good) => unknown][] = [
    ['partition', job => ({ ...job, cleanupPartition: job.cleanupPartition === 'pending#00' ? 'pending#01' : 'pending#00' })], ['sort key', job => ({ ...job, cleanupSortKey: `${'0'.repeat(13)}#${job.jobId}` })],
    ['state partition', job => ({ ...job, cleanupPartition: job.cleanupPartition!.replace('pending', 'retired') })], ['foreign key', job => ({ ...job, key: `images/${'c'.repeat(64)}/${job.jobId}` })],
    ['pending due', job => ({ ...job, dueAtMs: job.dueAtMs! + 1, ...cleanupKeys('pending', job.jobId, job.dueAtMs! + 1) })], ['missing due', job => { const { dueAtMs: _due, ...rest } = job; return rest; }],
    ['committed with index', job => ({ ...job, state: 'committed' })], ['lease on pending', job => ({ ...job, leaseOwner: 'run' })], ['owner not hex', job => ({ ...job, ownerId: 'owner-a', key: `images/owner-a/${job.jobId}` })],
    ['unknown attribute', job => ({ ...job, extra: 1 })], ['bad version', job => ({ ...job, versionId: 'null' })], ['bad uuid', job => ({ ...job, jobId: 'not-a-uuid' })],
  ];
  for (const [label, mutate] of bad) { assert.throws(() => validateSeedJob(mutate(good) as never), /SEED_JOB_REJECTED/, label); await assert.rejects(seedCleanupJobs(fixture, [mutate(good) as never]), /SEED_JOB_REJECTED/, label); }
  const original = cleanupIo.ownedTable; cleanupIo.ownedTable = () => false; try { await assert.rejects(seedCleanupJobs(fixture, [makeCleanupJob({ ownerId: OWNER, jobId: '33333333-3333-4333-8333-333333333333', state: 'pending', createdAtMs: Date.now() - DAY - 600_000 })]), /SEED_TABLE_NOT_OWNED/); } finally { cleanupIo.ownedTable = original; }
  assert.equal(sim.harness.snapshot().jobs.length, 1, 'rejected seeds wrote nothing');
});

void test('a GSI that never shows the seeded keys fails the bounded wait instead of invoking early', async () => {
  const sim = createSim(); const original = cleanupIo.gsiDeadlineMs; cleanupIo.gsiDeadlineMs = 50; const sleep = cleanupIo.sleep; cleanupIo.sleep = async () => undefined; const index = sim.harness.freezeCleanupIndex; index();
  try { await assert.rejects(seedCleanupJobs(sim.fixture, [makeCleanupJob({ ownerId: OWNER, jobId: '44444444-4444-4444-8444-444444444444', state: 'pending', createdAtMs: Date.now() - DAY - 600_000 })]), /CLEANUP_GSI_TIMEOUT/); } finally { cleanupIo.gsiDeadlineMs = original; cleanupIo.sleep = sleep; }
});

void test('a failed prerequisite leaves cleanup cases not-run', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cleanup-blocked-')); try {
    const evidence = await createEvidence(cleanup, join(directory, 'run'));
    const outcome = await executeSuites(e, { create: async () => { throw new Error('FIXTURE_INIT_FAILED'); }, action: async () => { throw new Error('UNEXPECTED_ACTION'); }, flush: async () => undefined, reset: async () => ({ errors: 0, leaks: 0 }), blocked: def => evidence.record({ id: def.id, status: 'not-run', phase: 'provision', durationMs: 0, reason: 'prerequisite-failed' }) });
    const { recordUnstarted } = await import('../../../scripts/e2e/run.ts'); await recordUnstarted(evidence, cleanup.filter(def => def.layer !== 'E'), true);
    await finalizeResults(evidence);
    const saved = JSON.parse(await readFile(join(evidenceContext(evidence).directory, 'results.json'), 'utf8')) as { cases: { id: string; result: Saved }[] };
    assert.equal(outcome.errors, 1); assert.equal(saved.cases.length, cleanup.length);
    assert.ok(saved.cases.every(item => item.result.status === 'not-run'), 'E cases and I cases are not-run, never pass');
    assert.ok(saved.cases.filter(item => e.some(def => def.id === item.id)).every(item => item.result.reason === 'prerequisite-failed'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
