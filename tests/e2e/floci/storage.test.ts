import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { definitions, caseActions, caseGuards, storageDefinitions, caseAuthId } from './support/cases.ts';
import './support/storage-cases.ts';
import { seedRateBeforeLimit } from './support/storage-cases.ts';
import { createEvidence, evidenceContext, flushPendingLogs, finalizeResults } from './support/evidence.ts';
import { createSim } from './api-sim.ts';
import type { Sim, SimOptions } from './api-sim.ts';
import type { HttpResult } from './support/types.ts';
import { executeSuites, runFixturePrerequisites, recordUnstarted, runSuiteCase } from '../../../scripts/e2e/run.ts';
import { fixtureStates } from './support/fixture.ts';
import { readReminder } from './support/storage.ts';

const root = process.cwd();
const storage = definitions.filter(def => def.suite === 'storage');
const e = storage.filter(def => def.layer === 'E');

void test('the storage inventory has an independent E case for every STORE/API-14 behavior and I cases that name their offline proof', async () => {
  assert.equal(storage.length, storageDefinitions.length);
  assert.equal(new Set(storage.map(def => def.id)).size, storage.length);
  for (const id of ['STORE-01', 'STORE-02', 'STORE-03', 'STORE-04', 'STORE-05', 'STORE-06', 'API-14']) assert.ok(storage.some(def => def.requirementId === id), id);
  for (const word of ['missing-if-match', 'weak-if-match', 'star-if-match', 'list-if-match', 'same-revision-other-hash', 'sequential-stale']) for (const op of ['patch', 'delete']) assert.ok(storage.some(def => def.id === `STORE-02/${op}-${word}`), `${op}-${word}`);
  for (const def of e) {
    assert.equal(def.required, true); assert.equal(def.acceptance, 'behavior');
    assert.deepEqual(def.outputs.map(output => output.kind), ['http', 'dynamodb', 's3', 'logs']);
    assert.ok(def.outputs.every(output => output.assertions.length > 0), `${def.id} asserts all four outputs`);
    assert.equal(caseActions.has(def.id), true, `${def.id} action`);
    assert.equal(caseAuthId(def), def.id, `${def.id} owns its synthetic users`);
  }
  // Layer display: the offline concurrency/quota proofs are I cases, separate from the E client sends, and no E case claims STORE-06.
  const integration = storage.filter(def => def.layer === 'I');
  assert.ok(integration.length >= 8);
  assert.ok(!e.some(def => def.requirementId === 'STORE-06'));
  const sources = (await readFile(join(root, 'tests/integration/formal-e2e/concurrency.test.ts'), 'utf8')) + (await readFile(join(root, 'tests/integration/formal-e2e/quota.test.ts'), 'utf8'));
  for (const def of integration) { assert.equal(caseActions.has(def.id), false, `${def.id} is not an E action`); assert.ok(sources.includes(def.id), `${def.id} is proven by a named integration test`); }
  assert.equal(definitions.some(def => def.id === 'API-14/rate-limit-120'), false, 'one rate-boundary case only');
  for (const guarded of caseGuards.keys()) assert.equal(storage.some(def => def.id === guarded), false, 'storage cases are independent (no guards)');
});

type Saved = { id: string; status: string; reason?: string; outputs?: { kind: string; status: string; assertions: { name: string; status: string }[] }[] };
async function runSuite(ids: string[] | undefined, options: SimOptions = {}): Promise<{ results: Map<string, Saved>; sim: Sim; failures: string[] }> {
  const directory = await mkdtemp(join(tmpdir(), 'storage-suite-')); const sim = createSim(options);
  try {
    const selected = e.filter(def => !ids || ids.includes(def.id));
    const evidence = await createEvidence(selected, join(directory, 'run'));
    for (const def of selected) await runSuiteCase(evidence, def, sim.fixture, { createAuth: async (_suite, authId) => sim.authFor(authId), bind(view, source) { fixtureStates.set(view, fixtureStates.get(source)!); } });
    await flushPendingLogs(evidence, async checks => sim.observer.flush(checks, Date.now()));
    await finalizeResults(evidence);
    const saved = JSON.parse(await readFile(join(evidenceContext(evidence).directory, 'results.json'), 'utf8')) as { cases: { id: string; result: Saved }[] };
    const results = new Map(saved.cases.map(item => [item.id, item.result]));
    const failures = [...results.values()].filter(result => result.status !== 'pass').map(result => `${result.id}:${result.status}:${result.reason ?? ''}:${(result.outputs ?? []).flatMap(output => output.assertions.filter(item => item.status === 'fail').map(item => `${output.kind}/${item.name}`)).join('|')}`);
    return { results, sim, failures };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

void test('every storage E case passes against the real handler, stateful store and result logger', async () => {
  const { failures, results } = await runSuite(undefined);
  assert.deepEqual(failures, []);
  assert.equal(results.size, e.length);
  for (const result of results.values()) assert.ok(result.outputs?.find(output => output.kind === 'logs' && output.status === 'pass'), `${result.id} logs`);
});

void test('independent storage cases get their own synthetic users', async () => {
  const { sim, failures } = await runSuite(undefined);
  assert.deepEqual(failures, []);
  assert.deepEqual(new Set(sim.authIds.filter(id => id !== 'default')), new Set(e.map(def => def.id)));
  assert.equal(sim.authIds.filter(id => id !== 'default').length, e.length);
});

const withStatus = (status: number) => (result: HttpResult): HttpResult => ({ ...result, status });
const tamper = (match: (method: string, path: string) => boolean, change: (result: HttpResult) => HttpResult): SimOptions => ({ tamper: (method, path, result) => match(method, path) ? change(result) : result });
const etagHash = (result: HttpResult): HttpResult => { const headers = new Headers(result.headers); const etag = headers.get('etag'); if (etag) headers.set('etag', etag.replace(/.{1}"$/, '0"')); return { ...result, headers }; };
const itemPath = /^\/v2\/reminders\/[^/?]+$/;

void test('negative controls: each broken contract fails exactly its own case', async () => {
  const cases: [string, SimOptions][] = [
    ['STORE-01/exact-etag-and-headers', tamper((m, p) => m === 'GET' && itemPath.test(p), etagHash)],
    ['STORE-02/patch-weak-if-match', tamper((m, p) => m === 'PATCH' && itemPath.test(p), result => result.status === 422 ? withStatus(200)(result) : result)],
    ['STORE-02/delete-sequential-stale', tamper((m, p) => m === 'DELETE' && itemPath.test(p), result => result.status === 412 ? withStatus(200)(result) : result)],
    ['STORE-03/patch-patch', tamper((m, p) => m === 'PATCH' && itemPath.test(p), result => result.status === 412 ? withStatus(200)(result) : result)],
    ['STORE-03/delete-delete', tamper((m, p) => m === 'DELETE' && itemPath.test(p), result => result.status === 412 || result.status === 404 ? withStatus(200)(result) : result)],
    ['STORE-04/same-id-create', tamper((m, p) => m === 'POST' && p === '/v2/reminders', result => result.status === 409 ? withStatus(201)(result) : result)],
    ['STORE-05/lifecycle-tombstone', tamper((m, p) => m === 'GET' && itemPath.test(p), result => result.status === 404 ? { ...withStatus(200)(result) } : result)],
    ['STORE-02/patch-missing-if-match', tamper((m, p) => m === 'PATCH' && itemPath.test(p), result => result.status === 428 ? withStatus(200)(result) : result)],
    ['STORE-02/delete-same-revision-other-hash', tamper((m, p) => m === 'DELETE' && itemPath.test(p), result => result.status === 412 ? withStatus(200)(result) : result)],
    ['STORE-04/resend-delete', tamper((m, p) => m === 'DELETE' && itemPath.test(p), result => result.status === 404 ? withStatus(200)(result) : result)],
    ['STORE-05/delete-with-image', tamper((m, p) => m === 'GET' && p.endsWith('/thumbnail-url'), result => result.status === 404 ? withStatus(200)(result) : result)],
    ['API-14/rate-boundary-seeded', tamper((_m, p) => p === '/v2/reminders', result => result.status === 429 ? { ...result, headers: new Headers({ ...Object.fromEntries(result.headers.entries()), 'retry-after': '7' }) } : result)],
    ['API-14/rate-boundary-seeded', tamper((_m, p) => p === '/v2/reminders', result => result.status === 429 ? withStatus(200)(result) : result)],
  ];
  for (const [id, options] of cases) {
    const { results, failures } = await runSuite(undefined, options);
    assert.equal(results.get(id)?.status, 'fail', `${id} must fail: ${failures.slice(0, 3).join(';')}`);
    // A broken response fails every case that exercises it, but cases that never send that request keep running and pass.
    const unaffected = id === 'API-14/rate-boundary-seeded' ? 'STORE-01/exact-etag-and-headers' : 'API-14/rate-boundary-seeded'; assert.equal(results.get(unaffected)?.status, 'pass', `${id}: ${unaffected} is independent`);
  }
});

void test('a failed prerequisite leaves storage cases not-run and sends no input', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'storage-prereq-')); try {
    const selected = definitions.filter(def => ['TF-03/settings', 'OBS-02/smoke', 'OBS-03/gateway-refusal', 'OBS-04/gateway-delivery'].includes(def.id) || def.suite === 'storage');
    const evidence = await createEvidence(selected, join(directory, 'run')); let inputs = 0;
    const fixture = { request: async () => { inputs++; throw new Error('UNEXPECTED_INPUT'); }, setPublication: async () => { inputs++; }, clients: {} } as unknown as import('./support/types.ts').E2EFixture;
    fixtureStates.set(fixture, { settingsComplete: false, smokeComplete: false, readbackPhase: '', readbackObserved: {}, outstanding: 0, cleanupIntervals: [], disposed: false } as unknown as import('./support/fixture.ts').RunFixtureState);
    const ready = await runFixturePrerequisites(evidence, selected, fixture);
    assert.equal(ready, false);
    await recordUnstarted(evidence, selected.filter(def => def.suite === 'storage'), ready);
    await finalizeResults(evidence);
    const saved = JSON.parse(await readFile(join(evidenceContext(evidence).directory, 'results.json'), 'utf8')) as { cases: { id: string; result: Saved }[] };
    const rows = saved.cases.filter(item => storage.some(def => def.id === item.id));
    assert.equal(rows.length, storage.length); assert.equal(inputs, 0);
    assert.ok(rows.every(item => item.result.status === 'not-run' && item.result.reason === 'prerequisite-failed'), 'E and I storage cases are not-run, never pass, fail or unsupported');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

void test('fixture initialisation failure leaves every storage E case not-run', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'storage-blocked-')); try {
    const evidence = await createEvidence(e, join(directory, 'run')); const flushed: string[] = [];
    const outcome = await executeSuites(e, { create: async () => { throw new Error('FIXTURE_INIT_FAILED'); }, action: async () => { throw new Error('UNEXPECTED_ACTION'); }, flush: async () => { flushed.push('flush'); }, reset: async () => ({ errors: 0, leaks: 0 }), blocked: def => evidence.record({ id: def.id, status: 'not-run', phase: 'provision', durationMs: 0, reason: 'prerequisite-failed' }) });
    await finalizeResults(evidence);
    const saved = JSON.parse(await readFile(join(evidenceContext(evidence).directory, 'results.json'), 'utf8')) as { cases: { id: string; result: Saved }[] };
    assert.equal(outcome.errors, 1); assert.deepEqual(flushed, []); assert.equal(saved.cases.length, e.length);
    assert.ok(saved.cases.every(item => item.result.status === 'not-run' && item.result.reason === 'prerequisite-failed'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

void test('seedRateBeforeLimit writes count 119 with the exact product expiry and refuses a missing or wrong read-back', async () => {
  const sim = createSim(); const ownerId = 'c'.repeat(64); const minute = Math.floor(Date.now() / 60_000);
  await seedRateBeforeLimit(sim.fixture, ownerId, minute);
  const { GetCommand } = await import('@aws-sdk/lib-dynamodb'); const { keys } = await import('../../../src/shared/ports.ts');
  const row = await sim.fixture.clients.dynamodb.send(new GetCommand({ TableName: sim.fixture.config.ownerStateTable, Key: keys.rate(ownerId, minute), ConsistentRead: true }));
  assert.equal(row.Item?.count, 119); assert.equal(row.Item?.expiresAt, keys.rateExpiresAt(minute));
  const broken = createSim(); (broken.fixture.clients.dynamodb as unknown as { send: (c: unknown) => Promise<unknown> }).send = async () => ({});
  await assert.rejects(seedRateBeforeLimit(broken.fixture, ownerId, minute), /RATE_SEED_REJECTED/);
  assert.equal(await readReminder(sim.fixture, ownerId, 'none'), null);
});
