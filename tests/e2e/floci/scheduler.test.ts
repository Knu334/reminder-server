import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { definitions, caseActions, caseMeasurements, measurementUnsupportedReasons, schedulerDefinitions } from './support/cases.ts';
import './support/scheduler-cases.ts';
import { classifyTrigger, dailyScheduleMatches, probeOneTimeTrigger, schedulerIo, sweepOwnedSchedules } from './support/scheduler.ts';
import type { ScheduleView, TriggerObservation } from './support/scheduler.ts';
import { createEvidence, evidenceContext, finalizeResults, markResource, reserveResource } from './support/evidence.ts';
import { cleanupIo } from './support/cleanup-fixtures.ts';
import { suiteLogStates } from './support/logs.ts';
import { createSim } from './api-sim.ts';
import { runSuiteCase } from '../../../scripts/e2e/run.ts';
import { fixtureStates } from './support/fixture.ts';
import type { SuiteFixture } from './support/types.ts';

const scheduler = definitions.filter(def => def.suite === 'scheduler');
const ALIAS = 'arn:aws:lambda:ap-northeast-1:000000000000:function:sim-production-cleanup:production';
const ROLE = 'arn:aws:iam::000000000000:role/sim-production-scheduler';
const GROUP = 'sim-production-cleanup';
const daily = (): ScheduleView => ({ State: 'DISABLED', ScheduleExpression: 'cron(0 3 * * ? *)', ScheduleExpressionTimezone: 'UTC', FlexibleTimeWindow: { Mode: 'OFF' }, Target: { Arn: ALIAS, RoleArn: ROLE, Input: '{}', RetryPolicy: { MaximumRetryAttempts: 2, MaximumEventAgeInSeconds: 3600 } } });

void test('the scheduler inventory has the one-time trigger compatibility measurement before the daily-preserved read-back', () => {
  assert.equal(scheduler.length, schedulerDefinitions.length); assert.deepEqual(scheduler.map(def => def.id), ['OPS-06/one-time-trigger', 'OPS-06/daily-schedule-preserved']);
  const [trigger, preserved] = scheduler as [typeof scheduler[number], typeof scheduler[number]];
  assert.equal(trigger.layer, 'L'); assert.equal(trigger.required, true); assert.equal(trigger.acceptance, 'compatibility');
  assert.equal(preserved.layer, 'L'); assert.equal(preserved.required, true); assert.equal(preserved.acceptance, 'behavior');
  assert.equal(caseMeasurements.has(trigger.id), true); assert.equal(caseActions.has(trigger.id), true); assert.equal(measurementUnsupportedReasons.get(trigger.id), 'scheduler-trigger-unsupported');
  assert.equal(caseMeasurements.has(preserved.id), false); assert.equal(caseActions.has(preserved.id), true);
  for (const def of scheduler) assert.deepEqual(def.outputs.map(output => output.kind), ['http', 'dynamodb', 's3', 'logs']);
  assert.ok(trigger.outputs.every(output => output.assertions.length > 0), 'the trigger measurement covers every output');
});

void test('the daily schedule must match all of 03:00 UTC, OFF window, DISABLED, retry 2, age 3600, empty input and the cleanup alias', () => {
  const expected = { aliasArn: ALIAS, roleArn: ROLE }; assert.equal(dailyScheduleMatches(daily(), expected), true);
  const changes: [string, (view: ScheduleView) => void][] = [
    ['enabled', view => { view.State = 'ENABLED'; }], ['other cron', view => { view.ScheduleExpression = 'cron(0 4 * * ? *)'; }], ['timezone', view => { view.ScheduleExpressionTimezone = 'Asia/Tokyo'; }],
    ['flexible window', view => { view.FlexibleTimeWindow = { Mode: 'FLEXIBLE' }; }], ['other target', view => { view.Target!.Arn = `${ALIAS}x`; }], ['other role', view => { view.Target!.RoleArn = `${ROLE}x`; }],
    ['non-empty input', view => { view.Target!.Input = '{"a":1}'; }], ['retry 3', view => { view.Target!.RetryPolicy = { MaximumRetryAttempts: 3, MaximumEventAgeInSeconds: 3600 }; }],
    ['age 60', view => { view.Target!.RetryPolicy = { MaximumRetryAttempts: 2, MaximumEventAgeInSeconds: 60 }; }], ['no retry policy', view => { delete view.Target!.RetryPolicy; }],
  ];
  for (const [label, change] of changes) { const view = daily(); change(view); assert.equal(dailyScheduleMatches(view, expected), false, label); }
  assert.equal(dailyScheduleMatches(undefined, expected), false);
});

const base = (): TriggerObservation => ({ dailyBefore: true, dailyAfter: true, created: true, readBack: true, createRefusal: undefined, jobDone: true, marker: true, checkpoint: true, logsMatched: true, anyLog: true, removed: true });
void test('a trigger is a pass only with job, marker, checkpoint and matching logs; unsupported only when nothing at all happened or the API is identified as unimplemented', () => {
  assert.equal(classifyTrigger(base()), 'pass');
  const unsupportedCases: Partial<TriggerObservation>[] = [{ jobDone: false, marker: false, checkpoint: false, logsMatched: false, anyLog: false }, { created: false, readBack: false, createRefusal: 'non-support', jobDone: false, marker: false, checkpoint: false, logsMatched: false, anyLog: false }];
  for (const change of unsupportedCases) assert.equal(classifyTrigger({ ...base(), ...change }), 'unsupported', JSON.stringify(change));
  const failures: [string, Partial<TriggerObservation>][] = [
    ['state changed without logs', { logsMatched: false, anyLog: false }], ['logs delivered but mismatched', { logsMatched: false }], ['logs only', { jobDone: false, marker: false, checkpoint: false, logsMatched: false }],
    ['job only', { marker: false, checkpoint: false, logsMatched: false, anyLog: false }], ['no checkpoint', { checkpoint: false }], ['no marker', { marker: false }],
    ['create refused for another reason', { created: false, readBack: false, createRefusal: 'other', jobDone: false, marker: false, checkpoint: false, logsMatched: false, anyLog: false }],
    ['created but not readable', { readBack: false, jobDone: false, marker: false, checkpoint: false, logsMatched: false, anyLog: false }],
    ['daily changed before', { dailyBefore: false }], ['daily changed after', { dailyAfter: false }], ['schedule not removed', { removed: false }],
    ['unsupported-looking but daily changed', { jobDone: false, marker: false, checkpoint: false, logsMatched: false, anyLog: false, dailyAfter: false }],
    ['unsupported-looking but schedule left behind', { jobDone: false, marker: false, checkpoint: false, logsMatched: false, anyLog: false, removed: false }],
  ];
  for (const [label, change] of failures) assert.equal(classifyTrigger({ ...base(), ...change }), 'fail', label);
});

type Mode = 'fires' | 'never' | 'create-501' | 'create-denied' | 'fires-logs-dropped' | 'log-only' | 'daily-changed' | 'remove-fails' | 'readback-wrong' | 'daily-differs';
async function harness(mode: Mode) {
  const sim = createSim(); const state = suiteLogStates.get(sim.fixture)!; const store = new Map<string, ScheduleView & { fireAt: number; fired: boolean }>(); const calls: string[] = []; const events: string[] = []; const observed: TriggerObservation[] = [];
  let clock = Date.now(); const dailyView = daily(); if (mode === 'daily-differs') dailyView.State = 'ENABLED';
  const original = { ...schedulerIo };
  const ingest = state.observer.ingest.bind(state.observer); if (mode === 'fires-logs-dropped') state.observer.ingest = events => ingest(events.filter(event => event.group !== 'cleanup-group'));
  const fire = async (): Promise<void> => { if (mode === 'log-only') { state.observer.ingest([{ eventId: 'lo1', message: JSON.stringify({ operation: 'cleanup_start', lambdaRequestId: 'lr-1' }), logStreamName: 'stream', group: 'cleanup-group', timestamp: Date.now() }]); return; } await cleanupIo.invoke(sim.fixture, Buffer.from('{}')); };
  Object.assign(schedulerIo, {
    now: () => clock, sleep: async (ms: number) => { clock += ms; for (const [name, schedule] of store) if (!schedule.fired && schedule.fireAt <= clock && ['fires', 'fires-logs-dropped', 'log-only'].includes(mode)) { schedule.fired = true; events.push(`fire:${name}`); await fire(); } },
    bindings: () => ({ prefix: 'sim', aliasArn: ALIAS, roleArn: ROLE }),
    async get(_fixture: SuiteFixture, group: string, name: string) { calls.push(`get:${group}/${name}`); if (name === GROUP) return structuredClone(dailyView); const found = store.get(name); if (!found) return undefined; const { fireAt: _f, fired: _x, ...view } = found; void _f; void _x; return mode === 'readback-wrong' ? { ...structuredClone(view), ScheduleExpression: 'rate(1 hour)' } : structuredClone(view); },
    async list(_fixture: SuiteFixture, _group: string) { return [GROUP, ...store.keys()]; },
    async create(_fixture: SuiteFixture, spec: { name: string; group: string; at: string; aliasArn: string; roleArn: string }) {
      calls.push(`create:${spec.group}/${spec.name}`);
      if (mode === 'create-501') throw Object.assign(new Error('RAW_SECRET'), { name: 'NotImplementedException', $metadata: { httpStatusCode: 501 } });
      if (mode === 'create-denied') throw Object.assign(new Error('RAW_SECRET'), { name: 'AccessDeniedException', $metadata: { httpStatusCode: 403 } });
      const at = /^at\((\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\)$/.exec(spec.at); assert.ok(at, 'one-time at() expression'); const fireAt = clock + 10_000;
      store.set(spec.name, { State: 'ENABLED', ScheduleExpression: spec.at, ScheduleExpressionTimezone: 'UTC', FlexibleTimeWindow: { Mode: 'OFF' }, Target: { Arn: spec.aliasArn, RoleArn: spec.roleArn, Input: '{}', RetryPolicy: { MaximumRetryAttempts: 0 } }, fireAt, fired: false });
      if (mode === 'daily-changed') dailyView.State = 'ENABLED';
    },
    async remove(_fixture: SuiteFixture, group: string, name: string) { calls.push(`remove:${group}/${name}`); if (mode !== 'remove-fails') store.delete(name); },
    async reserve(_fixture: SuiteFixture, name: string) { events.push(`reserve:${name}`); return `id/${name}`; },
    async mark(_fixture: SuiteFixture, id: string, status: string) { events.push(`${status}:${id}`); },
    async record(_fixture: SuiteFixture, observation: TriggerObservation) { observed.push(observation); },
    windowMs: 90_000, pollMs: 2_000, logWaitMs: 6_000, fireDelayMs: 10_000,
  });
  return { sim, store, calls, events, observed, restore: () => { Object.assign(schedulerIo, original); state.observer.ingest = ingest; } };
}

void test('one-time trigger over the real cleanup handler: fired schedule changes job, marker, checkpoint and logs, then is removed with absence read back', async () => {
  const h = await harness('fires');
  try {
    const result = await probeOneTimeTrigger(h.sim.fixture); assert.equal(result.outcome, 'pass'); assert.deepEqual(h.observed[0], { ...base(), createRefusal: undefined });
    assert.equal(h.store.size, 0, 'the owned schedule is gone'); assert.equal(h.sim.harness.snapshot().jobs.length, 0, 'the synthetic job is collected'); assert.equal(h.sim.harness.imageVersions().length, 0); assert.equal(h.sim.harness.imageDeleteMarkers().length, 0);
    const name = h.calls.find(call => call.startsWith('create:'))!.split('/')[1]!; assert.notEqual(name, GROUP, 'never the daily schedule'); assert.ok(name.startsWith('sim-onetime-'));
    const order = h.events.map(event => event.split(':')[0]); assert.deepEqual(order, ['reserve', 'created', 'fire', 'removed']);
    assert.ok(h.calls.indexOf(`create:${GROUP}/${name}`) < h.calls.indexOf(`remove:${GROUP}/${name}`)); assert.ok(h.calls.some(call => call === `get:${GROUP}/${name}`), 'absence is read back after the removal');
    assert.ok(!h.calls.some(call => call.startsWith('remove:') && call.endsWith(`/${GROUP}`)), 'the daily schedule is never deleted');
  } finally { h.restore(); }
});

void test('a schedule that is accepted but never fires, and an unimplemented API, are the only unsupported outcomes', async () => {
  for (const mode of ['never', 'create-501'] as const) {
    const h = await harness(mode);
    try { const result = await probeOneTimeTrigger(h.sim.fixture); assert.equal(result.outcome, 'unsupported', mode); assert.equal(h.store.size, 0); assert.equal(h.sim.harness.snapshot().jobs.length, 0); assert.equal(h.sim.harness.imageVersions().length, 0); if (mode === 'never') assert.deepEqual(h.observed[0], { ...base(), jobDone: false, marker: false, checkpoint: false, logsMatched: false, anyLog: false }); else assert.equal(h.observed[0]?.createRefusal, 'non-support'); } finally { h.restore(); }
  }
});

void test('every other measured shape is a failure and still cleans up', async () => {
  const failing: Mode[] = ['create-denied', 'fires-logs-dropped', 'log-only', 'daily-changed', 'remove-fails', 'readback-wrong', 'daily-differs'];
  for (const mode of failing) {
    const h = await harness(mode);
    try { const result = await probeOneTimeTrigger(h.sim.fixture); assert.equal(result.outcome, 'fail', mode); assert.equal(h.sim.harness.snapshot().jobs.length, 0, `${mode}: synthetic job collected`); assert.equal(h.sim.harness.imageVersions().length, 0, `${mode}: versions collected`); assert.equal(h.observed.length, 1, `${mode}: the observation is kept`);
      if (mode === 'daily-differs') assert.equal(h.calls.some(call => call.startsWith('create:')), false, 'nothing is created while the daily schedule differs from the contract');
      if (mode !== 'remove-fails' && mode !== 'daily-differs') assert.equal(h.store.size, 0, `${mode}: the schedule is removed`);
    } finally { h.restore(); }
  }
});

void test('a processed job without the delivered logs is distinguished from missing delivery by the recorded observation', async () => {
  const h = await harness('fires-logs-dropped');
  try { await probeOneTimeTrigger(h.sim.fixture); const seen = h.observed[0]!; assert.equal(seen.jobDone && seen.marker && seen.checkpoint, true); assert.equal(seen.logsMatched, false); assert.equal(seen.anyLog, false); } finally { h.restore(); }
});

void test('the error text of a refused create never reaches the observation', async () => {
  const h = await harness('create-denied');
  try { await probeOneTimeTrigger(h.sim.fixture); assert.equal(JSON.stringify(h.observed).includes('RAW_SECRET'), false); } finally { h.restore(); }
});

async function evidenceFor(directory: string) { const def = scheduler[0]!; return createEvidence([def], join(directory, 'run')); }
void test('the runner records the trigger as pass or as unsupported with the fixed scheduler reason, and a failed probe as fail', async () => {
  for (const [mode, status, reason] of [['fires', 'pass', undefined], ['never', 'unsupported', 'scheduler-trigger-unsupported'], ['log-only', 'fail', 'action-failed']] as const) {
    const directory = await mkdtemp(join(tmpdir(), 'scheduler-run-')); const h = await harness(mode);
    try {
      const evidence = await evidenceFor(directory);
      await runSuiteCase(evidence, scheduler[0]!, h.sim.fixture, { createAuth: async (_suite, authId) => h.sim.authFor(authId), bind(view, source) { fixtureStates.set(view, fixtureStates.get(source)!); suiteLogStates.set(view, suiteLogStates.get(source)!); } });
      await finalizeResults(evidence);
      const saved = JSON.parse(await readFile(join(evidenceContext(evidence).directory, 'results.json'), 'utf8')) as { cases: { result: { status: string; reason?: string } }[] }; assert.equal(saved.cases[0]!.result.status, status, mode); assert.equal(saved.cases[0]!.result.reason, reason, mode);
    } finally { h.restore(); await rm(directory, { recursive: true, force: true }); }
  }
});

void test('the daily-preserved case passes only for the exact daily schedule alone in its group', async () => {
  const preserved = scheduler[1]!;
  for (const [label, mutate, expected] of [['exact', (_h: Awaited<ReturnType<typeof harness>>) => undefined, 'pass'], ['leftover one-time', (h: Awaited<ReturnType<typeof harness>>) => { h.store.set('sim-onetime-left', { ...daily(), fireAt: 0, fired: true }); }, 'fail'], ['daily enabled', (_h: Awaited<ReturnType<typeof harness>>) => 'daily', 'fail']] as const) {
    const directory = await mkdtemp(join(tmpdir(), 'scheduler-daily-')); const h = await harness(label === 'daily enabled' ? 'daily-differs' : 'never');
    try {
      mutate(h);
      const evidence = await createEvidence([preserved], join(directory, 'run'));
      await runSuiteCase(evidence, preserved, h.sim.fixture, { createAuth: async (_suite, authId) => h.sim.authFor(authId), bind(view, source) { fixtureStates.set(view, fixtureStates.get(source)!); suiteLogStates.set(view, suiteLogStates.get(source)!); } });
      await finalizeResults(evidence);
      const saved = JSON.parse(await readFile(join(evidenceContext(evidence).directory, 'results.json'), 'utf8')) as { cases: { result: { status: string } }[] }; assert.equal(saved.cases[0]!.result.status, expected, label);
      assert.equal(h.calls.some(call => call.startsWith('create:') || call.startsWith('remove:')), false, 'the read-back changes nothing');
    } finally { h.restore(); await rm(directory, { recursive: true, force: true }); }
  }
});

void test('the run-end sweep removes an owned schedule that was not removed, verifies absence and counts leaks and rejections separately', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'scheduler-sweep-'));
  try {
    const evidence = await createEvidence([definitions[0]!], join(directory, 'run')); const prefix = `e2e-${evidence.runId.slice(4, 12)}`;
    const ids = ['a', 'b'].map(tag => ({ name: `${prefix}-onetime-0000000${tag}`, id: `${evidence.runId}/sdk-schedule/${prefix}-onetime-0000000${tag}` }));
    for (const item of ids) { await reserveResource(evidence, { kind: 'sdk-schedule', name: item.name, id: item.id }); await markResource(evidence, item.id, 'created'); }
    await reserveResource(evidence, { kind: 'sdk-schedule', name: 'foreign-onetime-00000000', id: `${evidence.runId}/sdk-schedule/foreign-onetime-00000000` });
    await assert.rejects(sweepOwnedSchedules({ remove: async () => undefined, exists: async () => false }, evidence, `${prefix}-production-cleanup`), /CLEANUP_REJECTED/, 'only after the evidence is finalized');
    await finalizeResults(evidence); const present = new Set(ids.map(item => item.name)); const stuck = ids[1]!.name;
    const result = await sweepOwnedSchedules({ async remove(_group, name) { if (name !== stuck) present.delete(name); }, exists: async (_group, name) => present.has(name) }, evidence, `${prefix}-production-cleanup`);
    assert.deepEqual(result, { attempted: 3, succeeded: 1, errors: 1, leaks: 1 });
    const manifest = evidenceContext(evidence).manifest.resources.filter(resource => resource.kind === 'sdk-schedule'); assert.deepEqual(manifest.map(resource => resource.removed), [true, false, false]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
