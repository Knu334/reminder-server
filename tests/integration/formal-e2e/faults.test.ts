import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import type { Context } from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { createApiHandler, withApiResultLogging } from '../../../src/api';
import { createJobsStore } from '../../../src/images/jobs-store';
import { createImagesStore } from '../../../src/images/s3-store';
import { createOwnerStore } from '../../../src/reminders/owner-store';
import { createRemindersStore } from '../../../src/reminders/dynamo-store';
import { createRemindersService } from '../../../src/reminders/service';
import { createHarness, harnessConfig } from '../../support/stateful-store';
import { gatewayEvent, syntheticPngBase64, syntheticPngBytes, validCreate } from '../../support/fixtures';
import { definitions } from '../../e2e/floci/support/cases.ts';
import '../../e2e/floci/support/operation-cases.ts';
import { createFaultTransport, type FaultRule } from './fault-transport.ts';
import { wireFakes } from './wire-fakes.ts';

/**
 * Uncertain-outcome cases (STORE-07, IMG-08) and the API-01 dependency-failure case, layer I. The product's real adapters (reminders store,
 * owner store, jobs store, images store, service and API handler) run over real SDK clients; only the transport underneath is replaced by a
 * stateful wire fake behind an explicit-command fault transport. This is not a Floci, Gateway or Lambda delivery observation.
 */
const credentials = { accessKeyId: 'synthetic', secretAccessKey: 'synthetic' };
const context = (): Context => ({ awsRequestId: 'lambda-synthetic', getRemainingTimeInMillis: () => 10_000 }) as Context;
const event = (method: string, path: string, body?: string): unknown => {
  const base = gatewayEvent() as { requestContext: Record<string, unknown> }; const routeKey = `${method} ${path}`;
  return gatewayEvent({ routeKey, rawPath: path, requestContext: { ...base.requestContext, routeKey, http: { method, path, sourceIp: '192.0.2.1' } }, ...(body === undefined ? { body: null } : { body }) });
};
type Rig = ReturnType<typeof rig>;
function rig(t: TestContext, rules: FaultRule[] = [], published = true) {
  const h = createHarness(); h.setPublication(published); const fakes = wireFakes(h);
  const ddb = createFaultTransport(fakes.dynamodb, rules); const s3 = createFaultTransport(fakes.s3, rules);
  const settings = { region: 'ap-northeast-1', maxAttempts: 1, credentials };
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ ...settings, requestHandler: ddb.handler }));
  const images = createImagesStore(new S3Client({ ...settings, requestHandler: s3.handler }), harnessConfig);
  const owners = createOwnerStore(doc, harnessConfig); let sequence = 0; const clock = (): number => Date.parse('2026-10-03T00:00:00.000Z') + 1000;
  const service = createRemindersService({ config: harnessConfig, reminders: createRemindersStore(doc, harnessConfig), owners, jobs: createJobsStore(doc, harnessConfig), images, clock, uuid: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}` });
  const lines: string[] = []; t.mock.method(console, 'log', (line: string) => { lines.push(line); });
  const api = withApiResultLogging(createApiHandler({ config: harnessConfig, service, owners, images, clock }));
  const trace = (command: string): number => [...ddb.trace, ...s3.trace].filter(entry => entry.command === command).length;
  const results = (): { operation?: string; status?: number; code?: string }[] => lines.map(line => JSON.parse(line) as { operation?: string; status?: number; code?: string });
  return { h, fakes, api, trace, results, call: (method: string, path: string, body?: string) => api(event(method, path, body), context()) };
}
const createWithImage = (r: Rig, id = 'reminder-1') => r.call('POST', '/v2/reminders', JSON.stringify(validCreate({ id, thumbnail: syntheticPngBase64 })));
const unavailable = (response: { statusCode?: number | undefined; body?: string | undefined }): boolean => response.statusCode === 503 && (JSON.parse(response.body ?? '{}') as { code?: string }).code === 'SERVICE_UNAVAILABLE';
const rule = (command: string, occurrence: number, phase: FaultRule['phase'], effect: FaultRule['effect']): FaultRule => ({ command, occurrence, phase, effect });
const effects: FaultRule['effect'][] = ['throw', 'abort'];
const png = syntheticPngBytes.length;

void test('the I inventory names STORE-07, IMG-08 and API-01 dependency cases and every assertion has a same-named test in this file', () => {
  const ids = ['STORE-07/transaction-uncertain-outcomes-i', 'IMG-08/real-adapter-fault-positions-i', 'API-01/ready-dependency-failure-keeps-health200-i'];
  const source = readFileSync(__filename, 'utf8');
  for (const id of ids) {
    const def = definitions.find(item => item.id === id); assert.ok(def, id); assert.equal(def.layer, 'I'); assert.equal(def.suite, 'operations');
    const names = def.outputs.flatMap(output => output.assertions); assert.ok(names.length >= 1, id);
    for (const name of names) assert.ok(source.includes(`void test('${name}'`), `${id} lacks a test named ${name}`);
    for (const output of def.outputs.filter(output => output.assertions.length === 0)) assert.ok(output.notApplicableReason);
  }
});

void test('store_07_commit_response_lost_is_confirmed_by_strong_read_without_a_second_send_or_double_count', async t => {
  for (const effect of effects) {
    const r = rig(t, [rule('TransactWriteItems', 1, 'after', effect)]);
    const response = await createWithImage(r); assert.equal(response.statusCode, 201);
    const state = r.h.snapshot();
    assert.equal(r.trace('TransactWriteItems'), 1, 'a confirmed outcome is never resent');
    assert.equal(state.reminders.length, 1); assert.deepEqual(state.storage.map(row => [row.itemCount, row.imageBytes]), [[1, png]]);
    assert.deepEqual(state.jobs.map(job => job.state), ['committed']);
  }
});

void test('store_07_commit_before_send_resends_the_same_command_and_commits_exactly_once', async t => {
  for (const effect of effects) {
    const r = rig(t, [rule('TransactWriteItems', 1, 'before', effect)]);
    const response = await createWithImage(r); assert.equal(response.statusCode, 201);
    const state = r.h.snapshot();
    assert.equal(r.trace('TransactWriteItems'), 2, 'the unknown outcome was verified absent and the same token was sent again');
    assert.equal(state.reminders.length, 1); assert.deepEqual(state.storage.map(row => [row.itemCount, row.imageBytes]), [[1, png]]);
    assert.deepEqual(state.jobs.map(job => job.state), ['committed']);
  }
});

void test('store_07_reconciliation_read_failure_is_503_while_the_committed_item_image_and_counter_stay_protected', async t => {
  for (const effect of effects) {
    // GetItem 1 is the publication gate; GetItem 2 is the strong re-read that the lost response forces.
    const r = rig(t, [rule('TransactWriteItems', 1, 'after', effect), rule('GetItem', 2, 'before', effect)]);
    const response = await createWithImage(r); assert.ok(unavailable(response));
    const state = r.h.snapshot();
    assert.equal(r.trace('TransactWriteItems'), 1);
    assert.equal(state.reminders.length, 1, 'the transaction did commit even though the client saw 503');
    assert.deepEqual(state.storage.map(row => [row.itemCount, row.imageBytes]), [[1, png]]);
    const [job] = state.jobs; assert.equal(state.jobs.length, 1); assert.equal(job!.state, 'committed');
    assert.deepEqual(r.h.imageVersions().map(item => item.key), [job!.key]); assert.deepEqual(r.h.imageDeleteMarkers(), []); assert.deepEqual(r.fakes.permanentDeletes, []);
    const retry = await createWithImage(r); assert.equal(retry.statusCode, 409, 'a client retry meets the committed item');
    assert.deepEqual(r.h.snapshot().storage.map(row => [row.itemCount, row.imageBytes]), [[1, png]], 'the counter is not incremented twice');
    assert.equal(r.h.snapshot().jobs.filter(item => item.state === 'committed').length, 1);
  }
});

void test('store_07_rate_failure_before_and_after_the_send_is_503_and_never_retried_into_a_second_increment', async t => {
  for (const effect of effects) {
    const before = rig(t, [rule('UpdateItem', 1, 'before', effect)]);
    assert.ok(unavailable(await before.call('GET', '/v2/reminders'))); assert.deepEqual(before.h.snapshot().rates, []); assert.equal(before.trace('UpdateItem'), 1);
    const after = rig(t, [rule('UpdateItem', 1, 'after', effect)]);
    assert.ok(unavailable(await after.call('GET', '/v2/reminders'))); assert.deepEqual(after.h.snapshot().rates.map(row => row.count), [1]); assert.equal(after.trace('UpdateItem'), 1, 'an unknown rate write is not retried');
    assert.equal(after.h.snapshot().reminders.length, 0);
  }
});

void test('img_08_put_before_send_is_503_with_one_tracked_pending_job_and_no_object', async t => {
  for (const effect of effects) {
    const r = rig(t, [rule('PutObject', 1, 'before', effect)]);
    assert.ok(unavailable(await createWithImage(r))); const state = r.h.snapshot();
    assert.deepEqual(state.jobs.map(job => [job.state, job.versionId]), [['pending', undefined]]);
    assert.ok(Number(state.jobs[0]!.dueAtMs) > Number(state.jobs[0]!.createdAtMs));
    assert.deepEqual(r.h.imageVersions(), []); assert.equal(state.reminders.length, 0); assert.deepEqual(state.storage, []);
  }
});

void test('img_08_put_response_lost_leaves_one_unrecorded_pending_key_and_never_puts_that_key_again', async t => {
  for (const effect of effects) {
    const r = rig(t, [rule('PutObject', 1, 'after', effect)]);
    assert.ok(unavailable(await createWithImage(r))); const state = r.h.snapshot();
    assert.equal(r.trace('PutObject'), 1, 'no unconditional second Put');
    assert.deepEqual(state.jobs.map(job => [job.state, job.versionId]), [['pending', undefined]]);
    assert.deepEqual(r.h.imageVersions().map(item => item.key), [state.jobs[0]!.key], 'the stored version is reachable only through the pending job key');
    assert.equal(state.reminders.length, 0); assert.deepEqual(state.storage, []);
  }
});

void test('img_08_upload_record_failure_leaves_the_object_under_a_pending_job_and_commits_nothing', async t => {
  for (const effect of effects) {
    // UpdateItem 1 is the rate write; UpdateItem 2 records the uploaded version on the pending job.
    const before = rig(t, [rule('UpdateItem', 2, 'before', effect)]);
    assert.ok(unavailable(await createWithImage(before)));
    assert.deepEqual(before.h.snapshot().jobs.map(job => [job.state, job.versionId]), [['pending', undefined]]); assert.equal(before.h.imageVersions().length, 1); assert.equal(before.h.snapshot().reminders.length, 0);
    const after = rig(t, [rule('UpdateItem', 2, 'after', effect)]);
    assert.ok(unavailable(await createWithImage(after)));
    const [job] = after.h.snapshot().jobs; assert.equal(job!.state, 'pending'); assert.equal(job!.versionId, after.h.imageVersions()[0]!.versionId, 'the lost response still recorded the version');
    assert.equal(after.h.snapshot().reminders.length, 0); assert.deepEqual(after.h.snapshot().storage, []);
  }
});

void test('img_08_commit_failure_never_exposes_or_deletes_the_image_and_keeps_the_pending_job_for_cleanup', async t => {
  for (const effect of effects) {
    // A commit that never reaches the service and whose retries all fail leaves a pending job with its recorded object and nothing else.
    const rules = [1, 2, 3].map(occurrence => rule('TransactWriteItems', occurrence, 'before', effect));
    const r = rig(t, rules); assert.ok(unavailable(await createWithImage(r))); const state = r.h.snapshot();
    assert.equal(r.trace('TransactWriteItems'), 3);
    assert.deepEqual(state.jobs.map(job => job.state), ['pending']); assert.equal(state.jobs[0]!.versionId, r.h.imageVersions()[0]!.versionId);
    assert.equal(state.reminders.length, 0); assert.deepEqual(state.storage, []); assert.deepEqual(r.h.imageDeleteMarkers(), []); assert.deepEqual(r.fakes.permanentDeletes, []);
    const list = await r.call('GET', '/v2/reminders'); assert.equal(list.statusCode, 200); assert.deepEqual(JSON.parse(list.body ?? '{}'), { items: [], nextCursor: null });
  }
});

void test('api_01_ready_dependency_probe_fault_is_503_with_the_logged_code_while_health_stays_200_without_dependency_calls', async t => {
  // Probe order: reminders GetItem 1, jobs GetItem 2, gate GetItem 3 (inside the owner probe), HeadBucket 1, then the gate GetItem 4.
  const faults: [string, number][] = [['GetItem', 1], ['GetItem', 2], ['GetItem', 3], ['HeadBucket', 1], ['GetItem', 4]];
  for (const [command, occurrence] of faults) for (const phase of ['before', 'after'] as const) {
    const r = rig(t, [rule(command, occurrence, phase, 'throw')]);
    const ready = await r.call('GET', '/readyz'); assert.ok(unavailable(ready), `${command}#${occurrence}/${phase}`);
    const dependencyCallsBefore = r.trace('GetItem') + r.trace('HeadBucket'); const health = await r.call('GET', '/healthz');
    assert.equal(health.statusCode, 200); assert.deepEqual(JSON.parse(health.body ?? '{}'), { healthy: true }); assert.equal(r.trace('GetItem') + r.trace('HeadBucket'), dependencyCallsBefore, 'health uses no dependency');
    assert.deepEqual(r.results().map(result => [result.operation, result.status, result.code]), [['ready', 503, 'SERVICE_UNAVAILABLE'], ['health', 200, undefined]]);
  }
  const control = rig(t); assert.equal((await control.call('GET', '/readyz')).statusCode, 200);
  const closed = rig(t, [], false); assert.ok(unavailable(await closed.call('GET', '/readyz'))); assert.equal((await closed.call('GET', '/healthz')).statusCode, 200);
});
