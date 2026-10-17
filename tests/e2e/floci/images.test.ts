import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { definitions, caseActions, caseGuards, imageDefinitions, caseAuthId } from './support/cases.ts';
import './support/image-cases.ts';
import { createEvidence, evidenceContext, flushPendingLogs, finalizeResults } from './support/evidence.ts';
import { createSim } from './api-sim.ts';
import type { Sim, SimOptions } from './api-sim.ts';
import type { HttpResult } from './support/types.ts';
import { imageBytes, FORMATS } from './support/image-fixtures.ts';
import { executeSuites, runFixturePrerequisites, recordUnstarted, runSuiteCase } from '../../../scripts/e2e/run.ts';
import { fixtureStates } from './support/fixture.ts';

const images = definitions.filter(def => def.suite === 'images');
const e = images.filter(def => def.layer === 'E');

void test('the image inventory has independent E cases for IMG-01..07, an I case for IMG-08 and a compatibility L case for IMG-09', () => {
  assert.equal(images.length, imageDefinitions.length); assert.equal(new Set(images.map(def => def.id)).size, images.length);
  for (const id of ['IMG-01', 'IMG-02', 'IMG-03', 'IMG-04', 'IMG-05', 'IMG-06', 'IMG-07']) assert.ok(e.some(def => def.requirementId === id), id);
  for (const format of FORMATS) for (const kind of ['base64', 'dataurl']) assert.ok(e.some(def => def.id === `IMG-01/${format}-${kind}`), `${format}-${kind}`);
  for (const id of ['IMG-01/null', 'IMG-01/empty', 'IMG-01/omitted', 'IMG-03/bytes-1048575', 'IMG-03/bytes-1048576', 'IMG-03/bytes-1048577', 'IMG-04/issue-and-fetch', 'IMG-06/replace', 'IMG-06/omit-keeps', 'IMG-06/clear-null', 'IMG-06/clear-empty', 'IMG-06/delete', 'IMG-07/duplicate-id-with-image', 'IMG-07/duplicate-after-delete', 'IMG-05/other-owner', 'IMG-05/no-image', 'IMG-05/deleted-item']) assert.ok(e.some(def => def.id === id), id);
  for (const def of e) {
    assert.equal(def.required, true); assert.equal(def.acceptance, 'behavior');
    assert.deepEqual(def.outputs.map(output => output.kind), ['http', 'dynamodb', 's3', 'logs']);
    assert.ok(def.outputs.every(output => output.assertions.length > 0), `${def.id} asserts all four outputs`);
    assert.equal(caseActions.has(def.id), true, `${def.id} action`); assert.equal(caseAuthId(def), def.id, `${def.id} owns its synthetic users`);
    assert.equal(caseGuards.has(def.id), false, `${def.id} has no dependency group`);
  }
  const integration = images.find(def => def.id.startsWith('IMG-08'))!; assert.equal(integration.layer, 'I'); assert.equal(caseActions.has(integration.id), false);
  const signature = images.find(def => def.id.startsWith('IMG-09'))!; assert.equal(signature.layer, 'L'); assert.equal(signature.acceptance, 'compatibility'); assert.equal(caseActions.has(signature.id), true);
});

void test('IMG-08 names runtime tests that exist and IMG-09 is never executed as a plain valid-GET pass', async () => {
  const source = await readFile(join(process.cwd(), 'tests/runtime/images.test.ts'), 'utf8'); const i = images.find(def => def.id.startsWith('IMG-08'))!;
  for (const name of i.outputs.find(output => output.kind === 'dynamodb')!.assertions) assert.ok(source.includes(`"${name}"`), name);
  const l = images.find(def => def.id.startsWith('IMG-09'))!; assert.deepEqual(l.outputs[0]!.assertions, ['control-get-measured', 'signature-tamper-measured', 'expired-url-measured']);
});

async function runSignature(signature: NonNullable<SimOptions['signature']>): Promise<Saved> {
  const directory = await mkdtemp(join(tmpdir(), 'images-signature-')); const sim = createSim({ signature });
  try {
    const def = images.find(item => item.id === 'IMG-09/signature-enforcement')!; const evidence = await createEvidence([def], join(directory, 'run'));
    await runSuiteCase(evidence, def, sim.fixture, { createAuth: async (_suite, authId) => sim.authFor(authId), bind(view, source) { fixtureStates.set(view, fixtureStates.get(source)!); } });
    await finalizeResults(evidence);
    const saved = JSON.parse(await readFile(join(evidenceContext(evidence).directory, 'results.json'), 'utf8')) as { cases: { id: string; result: Saved }[] };
    return saved.cases[0]!.result;
  } finally { await rm(directory, { recursive: true, force: true }); }
}
void test('IMG-09 is executed: enforced passes, lenient tamper or expiry is unsupported, and an unusable control or unexpected answer fails', async () => {
  assert.equal(caseActions.has('IMG-09/signature-enforcement'), true);
  const enforced = await runSignature('enforced'); assert.equal(enforced.status, 'pass'); assert.ok(enforced.outputs?.every(output => output.status !== 'fail'));
  for (const mode of ['lenient-tamper', 'lenient-expiry'] as const) {
    const result = await runSignature(mode); assert.equal(result.status, 'unsupported', mode); assert.equal(result.reason, 'signature-enforcement-unsupported', mode);
    assert.ok(result.outputs?.filter(output => output.assertions.length).every(output => output.status === 'pass' && output.assertions.length > 0));
  }
  for (const mode of ['control-fails', 'unexpected-tamper'] as const) assert.equal((await runSignature(mode)).status, 'fail', mode);
});

type Saved = { id: string; status: string; reason?: string; outputs?: { kind: string; status: string; assertions: { name: string; status: string }[] }[] };
async function runSuite(ids: string[] | undefined, options: SimOptions = {}): Promise<{ results: Map<string, Saved>; sim: Sim; failures: string[] }> {
  const directory = await mkdtemp(join(tmpdir(), 'images-suite-')); const sim = createSim(options);
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

void test('every image E case passes against the real handler, stateful store and result logger', async () => {
  const { failures, results } = await runSuite(undefined);
  assert.deepEqual(failures, []); assert.equal(results.size, e.length);
  for (const result of results.values()) assert.ok(result.outputs?.find(output => output.kind === 'logs' && output.status === 'pass'), `${result.id} logs`);
});

void test('independent image cases get their own synthetic users', async () => {
  const { sim, failures } = await runSuite(undefined);
  assert.deepEqual(failures, []);
  assert.deepEqual(new Set(sim.authIds.filter(id => id !== 'default')), new Set(e.map(def => def.id)));
  assert.equal(sim.authIds.filter(id => id !== 'default').length, e.length);
});

const withStatus = (status: number) => (result: HttpResult): HttpResult => ({ ...result, status });
const tamper = (match: (method: string, path: string) => boolean, change: (result: HttpResult) => HttpResult): SimOptions => ({ tamper: (method, path, result) => match(method, path) ? change(result) : result });
const itemPath = /^\/v2\/reminders\/[^/?]+$/; const urlPath = /\/thumbnail-url$/;

void test('negative controls: each broken contract fails exactly its own case and leaves unrelated cases passing', async () => {
  const cases: [string, SimOptions, string][] = [
    ['IMG-01/png-base64', tamper((m, p) => m === 'POST' && p === '/v2/reminders', result => result.status === 201 ? withStatus(200)(result) : result), 'IMG-02/bad-alphabet'],
    ['IMG-01/webp-dataurl', { tamperObject: bytes => Buffer.concat([bytes.subarray(0, bytes.length - 1), Buffer.from([0])]) }, 'IMG-05/no-image'],
    ['IMG-02/bad-alphabet', tamper((m, p) => m === 'POST' && p === '/v2/reminders', result => result.status === 422 ? withStatus(201)(result) : result), 'IMG-05/no-image'],
    ['IMG-03/bytes-1048577', tamper((m, p) => m === 'POST' && p === '/v2/reminders', result => result.status === 413 ? withStatus(201)(result) : result), 'IMG-05/no-image'],
    ['IMG-04/issue-and-fetch', tamper((_m, p) => urlPath.test(p), result => result.status !== 200 ? result : { ...result, headers: (() => { const headers = new Headers(result.headers); headers.set('etag', '"r1-x"'); return headers; })() }), 'IMG-05/no-image'],
    ['IMG-05/no-image', tamper((_m, p) => urlPath.test(p), result => result.status === 404 ? withStatus(200)(result) : result), 'IMG-01/png-base64'],
    ['IMG-06/replace', tamper((m, p) => m === 'PATCH' && itemPath.test(p), result => result.status === 200 ? withStatus(204)(result) : result), 'IMG-05/no-image'],
    ['IMG-07/duplicate-id-with-image', tamper((m, p) => m === 'POST' && p === '/v2/reminders', result => result.status === 409 ? withStatus(201)(result) : result), 'IMG-05/no-image'],
  ];
  for (const [id, options, unaffected] of cases) {
    const { results, failures } = await runSuite([id, unaffected], options);
    assert.equal(results.get(id)?.status, 'fail', `${id} must fail: ${failures.slice(0, 3).join(';')}`);
    assert.equal(results.get(unaffected)?.status, 'pass', `${id}: ${unaffected} is independent`);
  }
});

void test('a wrong image served from the signed URL fails only the fetch assertion', async () => {
  const { results, failures } = await runSuite(['IMG-04/issue-and-fetch'], { tamperFetch: result => ({ ...result, bytes: Buffer.concat([result.bytes, imageBytes('png', 8)]) }) });
  assert.equal(results.get('IMG-04/issue-and-fetch')?.status, 'fail');
  assert.match(failures.join(';'), /http\/get-original-bytes-no-bearer/);
  assert.doesNotMatch(failures.join(';'), /dynamodb\/|s3\//);
});

void test('a failed prerequisite leaves image cases not-run and sends no input', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'images-prereq-')); try {
    const selected = definitions.filter(def => ['TF-03/settings', 'OBS-02/smoke', 'OBS-03/gateway-refusal', 'OBS-04/gateway-delivery'].includes(def.id) || def.suite === 'images');
    const evidence = await createEvidence(selected, join(directory, 'run')); let inputs = 0;
    const fixture = { request: async () => { inputs++; throw new Error('UNEXPECTED_INPUT'); }, setPublication: async () => { inputs++; }, clients: {} } as unknown as import('./support/types.ts').E2EFixture;
    fixtureStates.set(fixture, { settingsComplete: false, smokeComplete: false, readbackPhase: '', readbackObserved: {}, outstanding: 0, cleanupIntervals: [], disposed: false } as unknown as import('./support/fixture.ts').RunFixtureState);
    const ready = await runFixturePrerequisites(evidence, selected, fixture); assert.equal(ready, false);
    await recordUnstarted(evidence, selected.filter(def => def.suite === 'images'), ready); await finalizeResults(evidence);
    const saved = JSON.parse(await readFile(join(evidenceContext(evidence).directory, 'results.json'), 'utf8')) as { cases: { id: string; result: Saved }[] };
    const rows = saved.cases.filter(item => images.some(def => def.id === item.id));
    assert.equal(rows.length, images.length); assert.equal(inputs, 0);
    assert.ok(rows.every(item => item.result.status === 'not-run' && item.result.reason === 'prerequisite-failed'), 'E, I and L image cases are not-run, never pass, fail or unsupported');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

void test('fixture initialisation failure leaves every image E case not-run', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'images-blocked-')); try {
    const evidence = await createEvidence(e, join(directory, 'run'));
    const outcome = await executeSuites(e, { create: async () => { throw new Error('FIXTURE_INIT_FAILED'); }, action: async () => { throw new Error('UNEXPECTED_ACTION'); }, flush: async () => undefined, reset: async () => ({ errors: 0, leaks: 0 }), blocked: def => evidence.record({ id: def.id, status: 'not-run', phase: 'provision', durationMs: 0, reason: 'prerequisite-failed' }) });
    await finalizeResults(evidence);
    const saved = JSON.parse(await readFile(join(evidenceContext(evidence).directory, 'results.json'), 'utf8')) as { cases: { id: string; result: Saved }[] };
    assert.equal(outcome.errors, 1); assert.equal(saved.cases.length, e.length);
    assert.ok(saved.cases.every(item => item.result.status === 'not-run' && item.result.reason === 'prerequisite-failed'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

void test('image fixtures follow their documented rule and every format passes the product signature check', async () => {
  const { decodeThumbnail } = await import('../../../src/images/validation.ts');
  for (const format of FORMATS) {
    const a = imageBytes(format, 100); assert.equal(a.length, 100); assert.ok(a.equals(imageBytes(format, 100))); assert.ok(!a.equals(imageBytes(format, 100, 1)));
    assert.equal(decodeThumbnail(a.toString('base64'))?.bytes, 100);
  }
  assert.equal(imageBytes('webp', 20).readUInt32LE(4), 12); assert.throws(() => imageBytes('png', 4), /IMAGE_FIXTURE_REJECTED/);
});
