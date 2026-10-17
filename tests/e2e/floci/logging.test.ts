import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { definitions, caseActions, caseGuards, loggingDefinitions, caseAuthId } from './support/cases.ts';
import './support/logging-cases.ts';
import { createEvidence, evidenceContext, flushPendingLogs, finalizeResults } from './support/evidence.ts';
import { capCleanupGrace, cleanupChecksMatch, cleanupCaseMatches, suiteLogStates } from './support/logs.ts';
import type { ObservedEvent } from './support/logs.ts';
import { createSim } from './api-sim.ts';
import type { SimOptions } from './api-sim.ts';
import { runSuiteCase } from '../../../scripts/e2e/run.ts';
import { fixtureStates } from './support/fixture.ts';

const logging = definitions.filter(def => def.suite === 'logging');
type Saved = { id: string; status: string; reason?: string; httpStatus?: number; outputs?: { kind: string; status: string; assertions: { name: string; status: string }[] }[] };

void test('the logging inventory has independent E cases for OBS-02 success, rejection and Gateway refusal and the OBS-03 cleanup pairing', () => {
  assert.equal(logging.length, loggingDefinitions.length); assert.equal(new Set(logging.map(def => def.id)).size, logging.length);
  assert.deepEqual(logging.map(def => def.id), ['OBS-02/crud-success-result-logs', 'OBS-02/input-rejection-result-logs', 'OBS-02/gateway-refusal-result-absence', 'OBS-03/cleanup-start-end-pairing']);
  for (const def of logging) {
    assert.equal(def.layer, 'E'); assert.equal(def.required, true); assert.equal(def.acceptance, 'behavior'); assert.deepEqual(def.outputs.map(output => output.kind), ['http', 'dynamodb', 's3', 'logs']);
    assert.ok(def.outputs.every(output => output.assertions.length > 0), `${def.id} asserts every output`); assert.equal(caseActions.has(def.id), true); assert.equal(caseAuthId(def), def.id, `${def.id} owns its synthetic users`); assert.equal(caseGuards.has(def.id), false);
  }
  const refusal = logging.find(def => def.id === 'OBS-02/gateway-refusal-result-absence')!; assert.deepEqual(refusal.outputs.find(output => output.kind === 'logs')!.assertions, ['no-jwt-api-result-absent', 'write-only-api-result-absent']);
  assert.deepEqual(logging.find(def => def.id === 'OBS-03/cleanup-start-end-pairing')!.outputs.find(output => output.kind === 'logs')!.assertions, ['delivered', 'delivered-2']);
  assert.ok(definitions.findIndex(def => def.suite === 'logging') > definitions.findIndex(def => def.suite === 'operations'), 'the logging suite follows the earlier suites');
});

async function runSuite(options: SimOptions = {}, prepare?: (sim: ReturnType<typeof createSim>) => void, observe?: (checks: Parameters<typeof flushPendingLogs>[1]) => Parameters<typeof flushPendingLogs>[1]): Promise<{ results: Map<string, Saved>; failures: string[]; sim: ReturnType<typeof createSim> }> {
  const directory = await mkdtemp(join(tmpdir(), 'logging-suite-')); const sim = createSim(options); prepare?.(sim);
  try {
    const evidence = await createEvidence(logging, join(directory, 'run'));
    for (const def of logging) await runSuiteCase(evidence, def, sim.fixture, { createAuth: async (_suite, authId) => sim.authFor(authId), bind(view, source) { fixtureStates.set(view, fixtureStates.get(source)!); suiteLogStates.set(view, suiteLogStates.get(source)!); } });
    const state = suiteLogStates.get(sim.fixture)!;
    const real: Parameters<typeof flushPendingLogs>[1] = async checks => { capCleanupGrace(state, checks); const results = await sim.observer.flush(checks, Date.now(), 60_000, () => cleanupChecksMatch(state)); return results.map(result => ({ ...result, matched: result.matched && cleanupCaseMatches(state, result.caseId) })); };
    await flushPendingLogs(evidence, observe ? observe(real) : real); await finalizeResults(evidence);
    const saved = JSON.parse(await readFile(join(evidenceContext(evidence).directory, 'results.json'), 'utf8')) as { cases: { id: string; result: Saved }[] };
    const results = new Map(saved.cases.map(item => [item.id, item.result]));
    return { results, sim, failures: [...results.values()].filter(result => result.status !== 'pass').map(result => `${result.id}:${result.status}:${result.reason ?? ''}:${(result.outputs ?? []).flatMap(output => output.assertions.filter(item => item.status === 'fail').map(item => `${output.kind}/${item.name}`)).join(',')}`) };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

void test('every logging case passes over the real handler, the Gateway double and the real cleanup handler, and leaves nothing owned behind', async () => {
  const { results, failures, sim } = await runSuite(); assert.deepEqual(failures, []); assert.equal(results.size, logging.length);
  for (const result of results.values()) { const logs = result.outputs?.find(output => output.kind === 'logs'); assert.ok(logs && logs.status === 'pass' && logs.assertions.length > 0, `${result.id} logs`); }
  const refusal = results.get('OBS-02/gateway-refusal-result-absence')!; assert.deepEqual(refusal.outputs!.find(output => output.kind === 'logs')!.assertions.map(item => item.name), ['no-jwt-api-result-absent', 'write-only-api-result-absent']);
  assert.equal(sim.harness.snapshot().jobs.length, 0); assert.equal(sim.harness.imageVersions().length, 0); assert.equal(sim.harness.imageDeleteMarkers().length, 0);
  assert.equal(suiteLogStates.get(sim.fixture)!.cleanup.size, 2, 'both invokes register their own cleanup-log window');
});

void test('re-fetched events with the same event id never count as a second result log', async () => {
  const { failures } = await runSuite({}, sim => { const ingest = sim.observer.ingest.bind(sim.observer); sim.observer.ingest = events => { ingest(events); ingest(events); }; }); assert.deepEqual(failures, []);
});

void test('a second delivery of the same API result under a new event id is an extra result log and fails the case', async () => {
  const { results } = await runSuite({}, sim => { const ingest = sim.observer.ingest.bind(sim.observer); let serial = 0; sim.observer.ingest = events => { ingest(events); ingest(events.filter(event => event.group === 'api-group').map(event => ({ ...event, eventId: `dup-${++serial}` }))); }; });
  for (const id of ['OBS-02/crud-success-result-logs', 'OBS-02/input-rejection-result-logs']) { const result = results.get(id)!; assert.equal(result.status, 'fail', id); assert.equal(result.reason, 'logs-missing', id); assert.ok(result.outputs!.find(output => output.kind === 'http')!.status === 'pass', `${id}: the HTTP and storage outputs are kept`); assert.ok(result.httpStatus !== undefined, `${id}: the input is kept`); }
});

void test('a Gateway refusal case cannot pass absence when a normal control log is missing', async () => {
  const { results } = await runSuite({}, sim => { const ingest = sim.observer.ingest.bind(sim.observer); sim.observer.ingest = events => ingest(events.filter(event => !(event.group === 'api-group' && JSON.parse(event.message.slice(event.message.indexOf('{'))).operation === 'list' && JSON.parse(event.message.slice(event.message.indexOf('{'))).status === 200))); });
  const result = results.get('OBS-02/gateway-refusal-result-absence')!; assert.equal(result.status, 'fail'); assert.equal(result.reason, 'logs-missing');
  assert.ok(result.outputs!.find(output => output.kind === 'logs')!.assertions.every(item => item.status === 'fail'), 'no absence is accepted without delivered controls'); assert.equal(result.httpStatus, 403, 'the executed input is retained');
});

void test('an extra API result log inside a refusal window fails the absence check', async () => {
  const { results } = await runSuite({ tamper: (_method, _path, result) => { if (result.status === 401) { const sim = current!; sim.observer.ingest([{ eventId: 'rogue-1', message: JSON.stringify({ requestId: 'rogue-request', operation: 'list', status: 401, code: 'UNAUTHORIZED' }), logStreamName: 'rogue', group: 'api-group', timestamp: Date.now() }]); } return result; } }, sim => { current = sim; });
  const result = results.get('OBS-02/gateway-refusal-result-absence')!; assert.equal(result.status, 'fail'); assert.equal(result.reason, 'logs-missing');
  assert.equal(result.outputs!.find(output => output.kind === 'logs')!.assertions.find(item => item.name === 'no-jwt-api-result-absent')!.status, 'fail');
});
let current: ReturnType<typeof createSim> | undefined;

void test('a failed bulk observation fails every executed case as observer-failed and keeps the input and the other outputs', async () => {
  const { results } = await runSuite({}, undefined, () => async () => { throw new Error('OBSERVER_SECRET_CANARY'); });
  assert.equal(results.size, logging.length);
  for (const result of results.values()) { assert.equal(result.status, 'fail', result.id); assert.equal(result.reason, 'observer-failed', result.id); assert.ok(result.httpStatus !== undefined, `${result.id} keeps the executed input`); assert.ok(result.outputs!.filter(output => output.kind !== 'logs').every(output => output.status === 'pass'), `${result.id} keeps the storage and HTTP results`); assert.equal(JSON.stringify(result).includes('OBSERVER_SECRET_CANARY'), false); }
});

void test('cleanup log pairing fails the whole case when the second invoke window carries different counts than its own result', async () => {
  const { results } = await runSuite({}, sim => { const ingest = sim.observer.ingest.bind(sim.observer); sim.observer.ingest = events => ingest(events.map((event: ObservedEvent) => event.group === 'cleanup-group' && event.message.includes('"operation":"cleanup"') && !event.message.includes('cleanup_start') && event.message.includes('"deletes":0') ? { ...event, message: event.message.replace('"deletes":0', '"deletes":1') } : event)); });
  const result = results.get('OBS-03/cleanup-start-end-pairing')!; assert.equal(result.status, 'fail'); assert.deepEqual(result.outputs!.find(output => output.kind === 'logs')!.assertions.map(item => `${item.name}:${item.status}`), ['delivered:fail', 'delivered-2:fail']);
});
