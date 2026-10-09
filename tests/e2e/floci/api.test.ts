import assert from 'node:assert/strict';
import { test } from 'node:test';
import { definitions, caseActions, caseGuards, apiDefinitions } from './support/cases.ts';
import './support/api-cases.ts';
import { makeInput, makeJsonBodyBytes, MAX_JSON_BYTES, codePoints, urlOfCodePoints, rejectParams, acceptParams } from './support/input-fixtures.ts';

void test('makeInput is synthetic and never accepts an owner identity', () => {
  const input = makeInput();
  assert.deepEqual(Object.keys(input), ['id', 'url', 'title', 'reminderTime', 'autoOpen', 'webPush', 'hidden', 'thumbnail']);
  assert.match(String(input.url), /^https:\/\/example\.test\//);
  assert.throws(() => makeInput({ ownerId: 'a'.repeat(64) }), /INPUT_OWNER_FORBIDDEN/);
  assert.equal(JSON.stringify(makeInput({ title: undefined })).includes('title'), false);
});

void test('makeJsonBodyBytes yields valid JSON of the exact UTF-8 length at and around the 2 MiB limit', () => {
  for (const bytes of [MAX_JSON_BYTES - 1, MAX_JSON_BYTES, MAX_JSON_BYTES + 1]) {
    const body = makeJsonBodyBytes(bytes, { id: 'size-probe' });
    assert.equal(Buffer.byteLength(body, 'utf8'), bytes);
    assert.equal((JSON.parse(body) as { id: string }).id, 'size-probe');
  }
  const multibyte = makeJsonBodyBytes(MAX_JSON_BYTES, { title: 'あ'.repeat(1000) });
  assert.equal(Buffer.byteLength(multibyte, 'utf8'), MAX_JSON_BYTES);
  assert.throws(() => makeJsonBodyBytes(10), /INPUT_BODY_TOO_SMALL/);
  assert.throws(() => makeJsonBodyBytes(1.5), /INPUT_BODY_REJECTED/);
});

void test('code point helpers count Unicode code points, not UTF-16 units', () => {
  assert.equal(codePoints(urlOfCodePoints(4096)), 4096); assert.equal(codePoints(urlOfCodePoints(4097)), 4097);
  assert.equal(codePoints('\u{1F600}'.repeat(128)), 128); assert.equal('\u{1F600}'.repeat(128).length, 256);
});

void test('boundary parameters cover limit, limit plus one and limit minus one for every bounded field', () => {
  const ids = new Set([...rejectParams, ...acceptParams].map(item => item.id));
  for (const id of ['API-09/id-128', 'API-09/id-129', 'API-09/id-1', 'API-09/id-empty', 'API-09/url-4096', 'API-09/url-4097', 'API-09/title-0', 'API-09/title-1024', 'API-09/title-1025', 'API-11/body-2097151', 'API-11/body-2097152', 'API-11/body-2097153']) assert.equal(ids.has(id), true, id);
  assert.equal(ids.size, rejectParams.length + acceptParams.length, 'parameter ids are unique');
  assert.equal(JSON.parse(rejectParams.find(item => item.id === 'API-09/id-129')!.body!).id.length, 129);
  assert.equal(codePoints(JSON.parse(acceptParams.find(item => item.id === 'API-09/id-128-astral')!.body).id), 128);
  assert.equal(codePoints(JSON.parse(rejectParams.find(item => item.id === 'API-09/title-1025-astral')!.body!).title), 1025);
  assert.equal(Buffer.byteLength(rejectParams.find(item => item.id === 'API-11/body-2097153')!.body!), MAX_JSON_BYTES + 1);
  assert.equal(acceptParams.find(item => item.id === 'API-11/body-2097152-utf8')!.bodyBytes, MAX_JSON_BYTES);
});

void test('every API requirement has E cases with four output expectations and a registered action', () => {
  const api = definitions.filter(def => def.suite === 'api');
  assert.equal(api.length, apiDefinitions.length); assert.ok(api.length > 100);
  assert.equal(new Set(api.map(def => def.id)).size, api.length);
  for (let n = 1; n <= 14; n++) assert.ok(api.some(def => def.requirementId === `API-${String(n).padStart(2, '0')}`), `API-${n}`);
  for (const def of api) {
    assert.equal(def.layer, 'E'); assert.equal(def.required, true); assert.equal(def.acceptance, 'behavior');
    assert.deepEqual(def.outputs.map(output => output.kind), ['http', 'dynamodb', 's3', 'logs']);
    assert.ok(def.outputs[0]!.assertions.length > 0, `${def.id} http`);
    assert.equal(caseActions.has(def.id), true, `${def.id} action`);
  }
  assert.ok(api.every(def => def.outputs.find(output => output.kind === 's3')!.assertions.length > 0), 'S3 no-additional-image-version is asserted for every API case');
  for (const guarded of caseGuards.keys()) assert.equal(api.some(def => def.id === guarded), true, guarded);
});

// ---- Real runner path against the real API handler (in-process Gateway stand-in, no network, no Floci) ----
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEvidence, runCase, evidenceContext, flushPendingLogs, finalizeResults } from './support/evidence.ts';
import { createSim } from './api-sim.ts';
import type { Sim, SimOptions } from './api-sim.ts';
import type { HttpResult } from './support/types.ts';
import { executeSuites, runFixturePrerequisites, recordUnstarted } from '../../../scripts/e2e/run.ts';
import { fixtureStates } from './support/fixture.ts';
import { snapshotOwnedStorage } from './support/storage.ts';

type Saved = { id: string; status: string; reason?: string; outputs?: { kind: string; status: string; assertions: { name: string; status: string }[] }[] };
async function runSuite(ids: string[] | undefined, options: SimOptions = {}): Promise<{ results: Map<string, Saved>; sim: Sim; failures: string[] }> {
  const directory = await mkdtemp(join(tmpdir(), 'api-suite-')); const sim = createSim(options);
  try {
    const selected = definitions.filter(def => def.suite === 'api' && (!ids || ids.includes(def.id)));
    const evidence = await createEvidence(selected, join(directory, 'run'));
    for (const def of selected) {
      if (caseGuards.get(def.id)?.(sim.fixture)) { await evidence.record({ id: def.id, status: 'not-run', phase: 'provision', durationMs: 0, reason: 'prerequisite-failed' }); continue; }
      await runCase(def, evidence, async recorder => { await caseActions.get(def.id)!(sim.fixture, recorder); });
    }
    await flushPendingLogs(evidence, async checks => sim.observer.flush(checks, Date.now()));
    await finalizeResults(evidence);
    const saved = JSON.parse(await readFile(join(evidenceContext(evidence).directory, 'results.json'), 'utf8')) as { cases: { id: string; result: Saved }[] };
    const results = new Map(saved.cases.map(item => [item.id, item.result]));
    const failures = [...results.values()].filter(result => result.status !== 'pass').map(result => `${result.id}:${result.status}:${result.reason ?? ''}:${(result.outputs ?? []).flatMap(output => output.assertions.filter(item => item.status === 'fail').map(item => `${output.kind}/${item.name}`)).join('|')}`);
    return { results, sim, failures };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

void test('every API case passes against the real handler, store and result logger in registered order', async () => {
  const { failures, results } = await runSuite(undefined);
  assert.deepEqual(failures, []);
  assert.equal(results.size, apiDefinitions.length);
  // Delivered-result checks were evaluated by the real log observer, not skipped.
  for (const result of results.values()) { const logs = result.outputs?.find(output => output.kind === 'logs'); assert.ok(logs, result.id); }
});

function tamper(match: (method: string, path: string) => boolean, change: (result: HttpResult) => HttpResult): SimOptions { return { tamper: (method, path, result) => match(method, path) ? change(result) : result }; }
const withStatus = (status: number) => (result: HttpResult): HttpResult => ({ ...result, status });
const without = (header: string) => (result: HttpResult): HttpResult => { const headers = new Headers(result.headers); headers.delete(header); return { ...result, headers }; };

void test('negative controls: each broken contract fails exactly its own case and independent cases still run', async () => {
  const cases: [string, SimOptions][] = [
    ['API-03/list-delete', tamper((m, p) => m === 'DELETE' && p === '/v2/reminders', without('allow'))],
    ['API-02/legacy-post', tamper((m, p) => m === 'POST' && p === '/reminders', withStatus(200))],
    ['API-09/id-129', tamper((m, p) => m === 'POST' && p === '/v2/reminders', result => String(result.bytes).includes('INVALID_INPUT') ? { ...result, status: 201 } : result)],
    ['API-04/create', tamper((m, p) => m === 'POST' && p === '/v2/reminders', without('location'))],
    ['API-12/default', tamper((_m, p) => p === '/v2/reminders', result => { const body = JSON.parse(String(result.bytes)) as { items?: unknown[] }; return Array.isArray(body.items) && body.items.length === 20 ? { ...result, bytes: Buffer.from(JSON.stringify({ ...body, items: body.items.slice(0, 19) })) } : result; })],
    ['API-06/allowed-origin-actual', tamper((_m, p) => p === '/v2/reminders', without('access-control-allow-origin'))],
  ];
  for (const [id, options] of cases) {
    const { results, failures } = await runSuite(undefined, options);
    assert.equal(results.get(id)?.status, 'fail', `${id} must fail`);
    const others = [...results.values()].filter(result => result.id !== id && result.status === 'pass').length;
    assert.ok(others > apiDefinitions.length * 0.5, `${id}: independent cases keep running (${others} passed, failures ${failures.slice(0, 4).join(';')})`);
  }
});

void test('a failed prerequisite case makes its dependents not-run rather than failed or passed', async () => {
  const { results } = await runSuite(undefined, tamper((m, p) => m === 'POST' && p === '/v2/reminders', response => (String(response.bytes).includes('"id":"crud-1"') || String(response.bytes).includes('crud-1')) ? withStatus(500)(response) : response));
  assert.equal(results.get('API-04/create')?.status, 'fail');
  for (const id of ['API-04/get', 'API-04/patch', 'API-04/delete']) { assert.equal(results.get(id)?.status, 'not-run', id); assert.equal(results.get(id)?.reason, 'prerequisite-failed'); }
  assert.equal(results.get('API-04/empty-list')?.status, 'pass');
});

void test('fixture initialisation failure leaves every unstarted API case not-run through the real suite runner and evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'api-blocked-')); try {
    const selected = definitions.filter(def => def.suite === 'api'); const evidence = await createEvidence(selected, join(directory, 'run'));
    const flushed: string[] = [];
    const outcome = await executeSuites(selected, {
      create: async () => { throw new Error('FIXTURE_INIT_FAILED'); },
      action: async () => { throw new Error('UNEXPECTED_ACTION'); },
      flush: async () => { flushed.push('flush'); }, reset: async () => ({ errors: 0, leaks: 0 }),
      blocked: def => evidence.record({ id: def.id, status: 'not-run', phase: 'provision', durationMs: 0, reason: 'prerequisite-failed' }),
    });
    await finalizeResults(evidence);
    const saved = JSON.parse(await readFile(join(evidenceContext(evidence).directory, 'results.json'), 'utf8')) as { cases: { id: string; result: Saved }[] };
    assert.equal(outcome.errors, 1); assert.deepEqual(flushed, []);
    assert.equal(saved.cases.length, selected.length);
    assert.ok(saved.cases.every(item => item.result.status === 'not-run' && item.result.reason === 'prerequisite-failed'), 'none is pass, fail or unsupported');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

void test('more negative controls: rate limit, cursors, ownership, request-id correlation and unchanged storage', async () => {
  const cases: [string, SimOptions][] = [
    ['API-14/rate-limit-120', tamper((_m, p) => p === '/v2/reminders', result => result.status === 429 ? withStatus(200)(result) : result)],
    ['API-14/rate-limit-120', tamper((_m, p) => p === '/v2/reminders', result => result.status === 429 ? { ...result, headers: new Headers({ ...Object.fromEntries(result.headers.entries()), 'retry-after': '7' }) } : result)],
    ['API-13/forged-owner', tamper((_m, p) => p.includes('cursor=') && p.includes('limit=1'), result => result.status === 422 ? withStatus(200)(result) : result)],
    ['API-13/tombstone-head-limit-1', tamper((m, p) => m === 'GET' && p === '/v2/reminders?limit=1', result => ({ ...result, bytes: Buffer.from('{"items":[],"nextCursor":null}') }))],
    ['API-05/other-owner-get', tamper((m, p) => m === 'GET' && p === '/v2/reminders/own-a-only', withStatus(200))],
    ['API-04/patch', tamper((m, p) => m === 'PATCH' && p === '/v2/reminders/crud-1', result => { const headers = new Headers(result.headers); headers.set('x-request-id', 'not-the-logged-id'); return { ...result, headers }; })],
    ['API-11/body-2097153', tamper((m, p) => m === 'POST' && p === '/v2/reminders', result => result.status === 413 ? withStatus(201)(result) : result)],
    ['API-03/unknown-v2-sibling', tamper((_m, p) => p === '/v2/other', withStatus(200))],
  ];
  for (const [id, options] of cases) { const { results, failures } = await runSuite(undefined, options); assert.equal(results.get(id)?.status, 'fail', `${id} must fail: ${failures.slice(0, 3).join(';')}`); }
});

void test('a refusal that changes storage is detected by the rate-excluding snapshot, and a rate-only change is not', async () => {
  const sim = createSim(); const who = { ownerId: 'a'.repeat(64) };
  const first = await snapshotOwnedStorage(sim.fixture, { excludeRate: true }); const fullFirst = await snapshotOwnedStorage(sim.fixture);
  const token = (await sim.fixture.auth.login('a', ['reminder-api/read', 'reminder-api/write'], 'primary')).accessToken;
  await sim.fixture.request('/v2/reminders', { token });
  assert.equal(await snapshotOwnedStorage(sim.fixture, { excludeRate: true }), first, 'a rate-only change does not alter the domain snapshot');
  assert.notEqual(await snapshotOwnedStorage(sim.fixture), fullFirst, 'the full snapshot sees the rate row');
  await sim.fixture.request('/v2/reminders', { token, method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'x', url: 'https://example.test/', title: 't', reminderTime: '2026-10-03T00:00:00Z', autoOpen: false, webPush: false, hidden: false }) });
  assert.notEqual(await snapshotOwnedStorage(sim.fixture, { excludeRate: true }), first, 'a stored reminder changes it'); void who;
});

void test('settings failure leaves every API case not-run, never pass, fail or unsupported, and sends no input', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'api-prereq-')); try {
    const selected = definitions.filter(def => ['TF-03/settings', 'OBS-02/smoke', 'OBS-03/gateway-refusal', 'OBS-04/gateway-delivery'].includes(def.id) || def.suite === 'api');
    const evidence = await createEvidence(selected, join(directory, 'run')); let inputs = 0;
    const fixture = { request: async () => { inputs++; throw new Error('UNEXPECTED_INPUT'); }, setPublication: async () => { inputs++; }, clients: {} } as unknown as import('./support/types.ts').E2EFixture;
    fixtureStates.set(fixture, { settingsComplete: false, smokeComplete: false, readbackPhase: '', readbackObserved: {}, outstanding: 0, cleanupIntervals: [], disposed: false } as unknown as import('./support/fixture.ts').RunFixtureState);
    const ready = await runFixturePrerequisites(evidence, selected, fixture);
    assert.equal(ready, false);
    await recordUnstarted(evidence, selected.filter(def => def.suite === 'api'), ready);
    await finalizeResults(evidence);
    const saved = JSON.parse(await readFile(join(evidenceContext(evidence).directory, 'results.json'), 'utf8')) as { cases: { id: string; result: Saved }[] };
    const api = saved.cases.filter(item => item.id.startsWith('API-'));
    assert.equal(api.length, apiDefinitions.length); assert.equal(inputs, 0);
    assert.ok(api.every(item => item.result.status === 'not-run' && item.result.reason === 'prerequisite-failed'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
