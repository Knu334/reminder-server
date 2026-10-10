import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LogObserver } from '../../e2e/floci/support/logs.ts';
const groups = { api: 'owned-api', cleanup: 'owned-cleanup', gateway: 'owned-gateway' };
const event = (id: string, doc: object, stream = 'invoke-1', group = 'owned-api', timestamp = 100) => ({ eventId: id, message: JSON.stringify(doc), logStreamName: stream, group, timestamp });
void test('real delivered result requires exact group request status and window; raw canary is not projected', async () => {
  const observer = new LogObserver(groups);
  observer.ingest([event('1', { requestId: 'r1', status: 200, operation: 'health', token: 'SECRET_CANARY' })]);
  const expect = { service: 'api' as const, requestId: 'r1', status: 200, since: 90, until: 110, mode: 'present' as const };
  assert.equal(observer.match(expect), true);
  for (const changed of [{ requestId: 'other' }, { status: 401 }, { since: 101 }, { service: 'gateway' as const }]) assert.equal(observer.match({ ...expect, ...changed }), false);
  assert.equal(JSON.stringify(observer.safeCounts()).includes('SECRET_CANARY'), false);
  observer.ingest([event('1', { requestId: 'r1', status: 200 })]);
  assert.equal(observer.safeCounts().api, 1);
});
void test('absence requires delivered controls before and after and detects extra uncorrelated API arrivals', () => {
  const observer = new LogObserver(groups);
  const absent = { service: 'api' as const, requestId: 'refused', status: 401, since: 95, until: 105, mode: 'absent' as const };
  const before = { ...absent, requestId: 'before', status: 200, since: 90, until: 94, mode: 'present' as const };
  const after = { ...before, requestId: 'after', since: 106, until: 110 };
  assert.equal(observer.check({ caseId: 'case', assertion: 'absent', expectation: absent, controls: { before, after } }).matched, false);
  observer.ingest([event('b', { requestId: 'before', status: 200 }, 'invoke-1', 'owned-api', 92), event('a', { requestId: 'after', status: 200 }, 'invoke-2', 'owned-api', 108)]);
  assert.equal(observer.check({ caseId: 'case', assertion: 'absent', expectation: absent, controls: { before, after } }).matched, true);
  observer.ingest([event('extra', { requestId: 'unexpected', status: 200 }, 'invoke-3', 'owned-api', 100)]);
  assert.equal(observer.check({ caseId: 'case', assertion: 'absent', expectation: absent, controls: { before, after } }).matched, false);
});
void test('cleanup pairs differing Lambda/service IDs only in one stream and unambiguous invocation', () => {
  const observer = new LogObserver(groups);
  const expected = { since: 90, until: 120, status: 200, evaluated: 0, deletes: 0 };
  observer.ingest([event('s', { lambdaRequestId: 'lambda-1', operation: 'cleanup_start' }, 'invoke-1', 'owned-cleanup', 100), event('e', { requestId: 'service-1', operation: 'cleanup', status: 200, evaluated: 0, deletes: 0 }, 'invoke-2', 'owned-cleanup', 110)]);
  assert.equal(observer.cleanupMatch(expected), false);
  observer.ingest([event('e2', { requestId: 'service-1', operation: 'cleanup', status: 200, evaluated: 0, deletes: 0 }, 'invoke-1', 'owned-cleanup', 110)]);
  assert.equal(observer.cleanupMatch(expected), true);
  observer.ingest([event('s2', { lambdaRequestId: 'lambda-2', operation: 'cleanup_start' }, 'invoke-1', 'owned-cleanup', 105)]);
  assert.equal(observer.cleanupMatch(expected), false);
});
void test('all negative checks share one poll deadline; missing required delivery fails', async () => {
  let now = 100; let polls = 0;
  const observer = new LogObserver(groups, { clock: () => now, sleep: async ms => { now += ms; }, fetch: async () => { polls++; return []; } });
  const checks = Array.from({ length: 8 }, (_, i) => ({ caseId: `case${i}`, assertion: 'delivery', expectation: { service: 'api' as const, requestId: `r${i}`, status: 200, since: 100, mode: 'present' as const } }));
  const result = await observer.flush(checks, 100, 60_000);
  assert.equal(now, 60_600, "the scan ends only after a poll started at until plus grace"); assert.ok(polls <= 186); assert.ok(result.every(check => !check.matched));
});

void test('cleanup rejects a result emitted by a different Lambda invoke in the same stream', () => {
  const observer = new LogObserver(groups);
  observer.ingest([event('s', { lambdaRequestId: 'lambda-1', operation: 'cleanup_start' }, 'invoke-1', 'owned-cleanup', 100), { ...event('e', {}, 'invoke-1', 'owned-cleanup', 110), message: '2026-10-09T00:00:00.000Z\tlambda-2\tINFO\t' + JSON.stringify({ requestId: 'service-2', operation: 'cleanup', status: 200, evaluated: 0, deletes: 0 }) }]);
  assert.equal(observer.cleanupMatch({ since: 90, until: 120, status: 200, evaluated: 0, deletes: 0 }), false);
});

void test('unpublished cleanup requires real start tracked skipped response and unchanged storage without inventing end', () => {
  const observer = new LogObserver(groups); observer.ingest([event('s', { lambdaRequestId: 'lambda-1', operation: 'cleanup_start' }, 'invoke-1', 'owned-cleanup', 100)]);
  const expected = { since: 90, until: 120, skippedUnpublished: true, evaluated: 0, deletes: 0 };
  const completion = { since: 90, until: 120, completed: true, status: 200, result: { evaluated: 0, deletes: 0, incomplete: false, skippedUnpublished: true }, storageUnchanged: true };
  assert.equal(observer.cleanupMatch(expected, completion), true);
  for (const changed of [{ completed: false }, { storageUnchanged: false }, { status: 500 }, { result: { ...completion.result, skippedUnpublished: false } }]) assert.equal(observer.cleanupMatch(expected, { ...completion, ...changed }), false);
  assert.equal(observer.cleanupMatch({ since: 90, until: 120, status: 200, evaluated: 0, deletes: 0 }, completion), false);
  const empty = new LogObserver(groups); assert.equal(empty.cleanupMatch(expected, completion), false);
});

void test('unpublished cleanup rejects wrong invoke prefix and invalid-event invocation without start', () => {
  const observer = new LogObserver(groups);
  observer.ingest([{ ...event('s', {}, 'invoke-1', 'owned-cleanup', 100), message: 'time\tlambda-other\tINFO\t' + JSON.stringify({ operation: 'cleanup_start', lambdaRequestId: 'lambda-1' }) }]);
  const expected = { since: 90, until: 120, skippedUnpublished: true };
  const completion = { since: 90, until: 120, completed: true, status: 200, result: { evaluated: 0, deletes: 0, incomplete: false, skippedUnpublished: true }, storageUnchanged: true };
  assert.equal(observer.cleanupMatch(expected, completion), false);
  const { result: _result, ...invalidCompletion } = completion; void _result;
  assert.equal(new LogObserver(groups).cleanupMatch(expected, invalidCompletion), false);
});

void test('suite skip expectation uses delivered start and one flush waits for the cleanup pair', async () => {
  let now = 100; let calls = 0;
  const observer = new LogObserver(groups, { clock: () => now, sleep: async ms => { now += ms; }, fetch: async group => {
    if (group !== groups.cleanup) return []; calls++;
    return calls === 1 ? [event('e', { operation: 'cleanup', requestId: 'service', status: 200 }, 'invoke-1', groups.cleanup, 110)] : [event('s', { operation: 'cleanup_start', lambdaRequestId: 'lambda' }, 'invoke-1', groups.cleanup, 100)];
  } });
  const check = { caseId: 'cleanup', assertion: 'delivered', expectation: { service: 'cleanup' as const, operation: 'cleanup', mode: 'present' as const, since: 90, until: 120 } };
  const results = await observer.flush([check], 100, 60_000, () => observer.cleanupMatch({ since: 90, until: 120, status: 200 }));
  assert.equal(results[0]?.matched, true); assert.equal(calls, 2);
  const { expectCleanupLogs, suiteLogStates, flushSuiteLogs } = await import('../../e2e/floci/support/logs.ts');
  const fixture = {} as import('../../e2e/floci/support/types.ts').SuiteFixture; const skipObserver = new LogObserver(groups); skipObserver.ingest([event('s', { operation: 'cleanup_start', lambdaRequestId: 'lambda' }, 'invoke-1', groups.cleanup, 100)]);
  suiteLogStates.set(fixture, { observer: skipObserver, pending: [], cleanup: new Map(), lastInput: 120, completions: [{ since: 90, until: 120, completed: true, status: 200, result: { evaluated: 0, deletes: 0, incomplete: false, skippedUnpublished: true }, storageUnchanged: true }] });
  const pending = expectCleanupLogs(fixture, 'skip', { since: 90, until: 120, skippedUnpublished: true });
  assert.equal(pending.expectation.operation, 'cleanup_start'); assert.equal((await flushSuiteLogs(fixture)).get('skip')?.status, 'pass');
});

void test('normal cleanup delivered pair must agree with tracked response and completion', () => {
  const observer = new LogObserver(groups); observer.ingest([event('s', { operation: 'cleanup_start', lambdaRequestId: 'lambda' }, 'invoke', groups.cleanup, 100), event('e', { operation: 'cleanup', requestId: 'service', status: 200, evaluated: 0, deletes: 0 }, 'invoke', groups.cleanup, 110)]);
  const expected = { since: 90, until: 120, status: 200, evaluated: 0, deletes: 0 }; const completion = { since: 90, until: 120, completed: true, status: 200, result: { evaluated: 0, deletes: 0, incomplete: false, skippedUnpublished: false }, storageUnchanged: true };
  assert.equal(observer.cleanupMatch(expected, completion), true);
  for (const changed of [{ completed: false }, { status: 500 }, { since: 91 }, { result: { ...completion.result, evaluated: 1 } }]) assert.equal(observer.cleanupMatch(expected, { ...completion, ...changed }), false);
});

void test('one case can register several cleanup expectations, each paired with its own invoke window and stream', async () => {
  const { expectCleanupLogs, suiteLogStates, cleanupCaseMatches, cleanupChecksMatch } = await import('../../e2e/floci/support/logs.ts');
  const fixture = {} as import('../../e2e/floci/support/types.ts').SuiteFixture; const observer = new LogObserver(groups);
  const pair = (n: number, at: number, evaluated: number, deletes: number) => [event(`s${n}`, { operation: 'cleanup_start', lambdaRequestId: `lambda-${n}` }, `stream-${n}`, groups.cleanup, at), event(`e${n}`, { operation: 'cleanup', requestId: `run-${n}`, status: 200, evaluated, deletes }, `stream-${n}`, groups.cleanup, at + 5)];
  observer.ingest([...pair(1, 100, 1, 1), ...pair(2, 200, 0, 0)]);
  const result = (evaluated: number, deletes: number) => ({ evaluated, deletes, incomplete: false, skippedUnpublished: false });
  const state = { observer, pending: [], cleanup: new Map(), lastInput: 0, completions: [{ since: 90, until: 120, completed: true, status: 200, result: result(1, 1), storageUnchanged: true }, { since: 190, until: 220, completed: true, status: 200, result: result(0, 0), storageUnchanged: true }] };
  suiteLogStates.set(fixture, state);
  const first = expectCleanupLogs(fixture, 'multi', { since: 90, until: 120, status: 200, evaluated: 1, deletes: 1 }); const second = expectCleanupLogs(fixture, 'multi', { since: 190, until: 220, status: 200, evaluated: 0, deletes: 0 });
  assert.deepEqual([first.assertion, second.assertion], ['delivered', 'delivered-2']); assert.equal(state.cleanup.size, 2);
  assert.equal(cleanupCaseMatches(state, 'multi'), true); assert.equal(cleanupChecksMatch(state), true);
  assert.throws(() => expectCleanupLogs(fixture, 'multi', { since: 100, until: 130 }), /FIXTURE_REJECTED/, 'overlapping windows are ambiguous');
});

void test('a mismatched second-invoke cleanup log fails the case even when the first invoke matches', async () => {
  const { expectCleanupLogs, suiteLogStates, cleanupCaseMatches } = await import('../../e2e/floci/support/logs.ts');
  const build = (second: { deletes: number; streamEnd?: string; omitEnd?: boolean }) => {
    const fixture = {} as import('../../e2e/floci/support/types.ts').SuiteFixture; const observer = new LogObserver(groups);
    observer.ingest([event('s1', { operation: 'cleanup_start', lambdaRequestId: 'l1' }, 'a', groups.cleanup, 100), event('e1', { operation: 'cleanup', requestId: 'r1', status: 200, evaluated: 1, deletes: 1 }, 'a', groups.cleanup, 105), event('s2', { operation: 'cleanup_start', lambdaRequestId: 'l2' }, 'b', groups.cleanup, 200),
      ...(second.omitEnd ? [] : [event('e2', { operation: 'cleanup', requestId: 'r2', status: 200, evaluated: 0, deletes: second.deletes }, second.streamEnd ?? 'b', groups.cleanup, 205)])]);
    const result = (evaluated: number, deletes: number) => ({ evaluated, deletes, incomplete: false, skippedUnpublished: false });
    const state = { observer, pending: [], cleanup: new Map(), lastInput: 0, completions: [{ since: 90, until: 120, completed: true, status: 200, result: result(1, 1), storageUnchanged: true }, { since: 190, until: 220, completed: true, status: 200, result: result(0, 0), storageUnchanged: true }] };
    suiteLogStates.set(fixture, state); expectCleanupLogs(fixture, 'multi', { since: 90, until: 120, status: 200, evaluated: 1, deletes: 1 }); expectCleanupLogs(fixture, 'multi', { since: 190, until: 220, status: 200, evaluated: 0, deletes: 0 }); return state;
  };
  assert.equal(cleanupCaseMatches(build({ deletes: 0 }), 'multi'), true);
  assert.equal(cleanupCaseMatches(build({ deletes: 1 }), 'multi'), false, 'wrong count in the delivered log');
  assert.equal(cleanupCaseMatches(build({ deletes: 0, streamEnd: 'other' }), 'multi'), false, 'end in another stream is no pair');
  assert.equal(cleanupCaseMatches(build({ deletes: 0, omitEnd: true }), 'multi'), false, 'missing service end');
});
void test('Floci stamps a result log shortly after the HTTP response so the window tolerates bounded ingestion lag', () => {
  const observer = new LogObserver(groups);
  observer.ingest([event('late', { requestId: 'r-late', status: 200 }, 'invoke-1', 'owned-api', 112), event('far', { requestId: 'r-far', status: 200 }, 'invoke-1', 'owned-api', 110 + 60_000)]);
  const base = { service: 'api' as const, status: 200, since: 90, until: 110, mode: 'present' as const };
  assert.equal(observer.match({ ...base, requestId: 'r-late' }), true);
  assert.equal(observer.match({ ...base, requestId: 'r-far' }), false);
  assert.equal(observer.match({ ...base, requestId: 'r-late', since: 113, until: 120 }), false);
});
void test('absence is not weakened by the ingestion-lag grace: a late-stamped refused request is still detected', () => {
  const observer = new LogObserver(groups);
  observer.ingest([event('late-refused', { requestId: 'r-refused', status: 401 }, 'invoke-1', 'owned-api', 112)]);
  assert.equal(observer.match({ service: 'api', requestId: 'r-refused', status: 401, since: 90, until: 110, mode: 'absent' }), false);
  assert.equal(observer.match({ service: 'api', requestId: 'r-other', status: 401, since: 90, until: 110, mode: 'absent' }), true);
});
void test('cleanup pair stamped shortly after the invoke returned still matches, but a following invoke start does not join it', () => {
  const observer = new LogObserver(groups);
  const expected = { since: 90, until: 120, status: 200, evaluated: 0, deletes: 0 };
  observer.ingest([event('s', { lambdaRequestId: 'lambda-1', operation: 'cleanup_start' }, 'invoke-1', 'owned-cleanup', 119), event('e', { requestId: 'service-1', operation: 'cleanup', status: 200, evaluated: 0, deletes: 0 }, 'invoke-1', 'owned-cleanup', 125)]);
  assert.equal(observer.cleanupMatch(expected), true);
  observer.ingest([event('s2', { lambdaRequestId: 'lambda-2', operation: 'cleanup_start' }, 'invoke-1', 'owned-cleanup', 130), event('e2', { requestId: 'service-2', operation: 'cleanup', status: 200, evaluated: 0, deletes: 0 }, 'invoke-1', 'owned-cleanup', 135)]);
  assert.equal(observer.cleanupMatch(expected), false, 'two starts without a cap are ambiguous');
  assert.equal(observer.cleanupMatch({ ...expected, nextSince: 126 }), true);
  assert.equal(observer.cleanupMatch({ since: 126, until: 140, status: 200, evaluated: 0, deletes: 0 }), true);
  assert.equal(new LogObserver(groups).cleanupMatch(expected), false);
});
void test('a missing own cleanup start is not masked by the next sequential invoke start inside the grace', () => {
  const end = (id: string, ts: number) => event(id, { requestId: `svc-${id}`, operation: 'cleanup', status: 200, evaluated: 0, deletes: 0 }, 'invoke-1', 'owned-cleanup', ts);
  const start = (id: string, ts: number) => event(id, { lambdaRequestId: id, operation: 'cleanup_start' }, 'invoke-1', 'owned-cleanup', ts);
  const a = { since: 90, until: 120, status: 200, evaluated: 0, deletes: 0 }; const doneA = { since: 90, until: 120, completed: true, status: 200, result: { evaluated: 0, deletes: 0, incomplete: false, skippedUnpublished: false }, storageUnchanged: true };
  // A's own start/end are lost; B (since 130, harness-known) logs inside A's 500 ms grace.
  const observer = new LogObserver(groups); observer.ingest([start('lb', 140), end('eb', 145)]);
  assert.equal(observer.cleanupMatch({ ...a, nextSince: 130 }, doneA), false, 'cap at the next harness since');
  assert.equal(observer.cleanupMatch({ ...a, nextSince: 130 }), false);
  // Own late start still matches under the cap; the next invoke's later logs are excluded.
  const ok = new LogObserver(groups); ok.ingest([start('la', 125), end('ea', 128), start('lb', 140), end('eb', 145)]);
  assert.equal(ok.cleanupMatch({ ...a, nextSince: 130 }, doneA), true);
});
void test('cleanup matches by bounded window even when the invoke metadata id differs from the log lambdaRequestId', () => {
  const observer = new LogObserver(groups); const a = { since: 90, until: 120, status: 200, evaluated: 0, deletes: 0 };
  const done = { since: 90, until: 120, completed: true, lambdaRequestId: 'http-request-id', status: 200, result: { evaluated: 0, deletes: 0, incomplete: false, skippedUnpublished: false }, storageUnchanged: true } as never;
  observer.ingest([event('s', { lambdaRequestId: 'runtime-invoke-id', operation: 'cleanup_start' }, 'i', 'owned-cleanup', 125), event('e', { requestId: 'svc', operation: 'cleanup', status: 200, evaluated: 0, deletes: 0 }, 'i', 'owned-cleanup', 128)]);
  assert.equal(observer.cleanupMatch({ ...a, nextSince: 130 }, done), true);
});
void test('two cleanup starts in one capped window are ambiguous and fail', () => {
  const a = { since: 90, until: 120, status: 200, evaluated: 0, deletes: 0 };
  const ev = [event('s1', { lambdaRequestId: 'l1', operation: 'cleanup_start' }, 'i', 'owned-cleanup', 119), event('e1', { requestId: 'r1', operation: 'cleanup', status: 200, evaluated: 0, deletes: 0 }, 'i', 'owned-cleanup', 121), event('s2', { lambdaRequestId: 'l2', operation: 'cleanup_start' }, 'i', 'owned-cleanup', 130), event('e2', { requestId: 'r2', operation: 'cleanup', status: 200, evaluated: 0, deletes: 0 }, 'i', 'owned-cleanup', 132)];
  const observer = new LogObserver(groups); observer.ingest(ev);
  assert.equal(observer.cleanupMatch(a), false, 'no cap: both starts in the grace');
  assert.equal(observer.cleanupMatch({ ...a, nextSince: 125 }), true, 'cap excludes the next invoke');
});
void test('an uncorrelated refusal is failed by a late-stamped extra result log but not by the next control', () => {
  const absent = { service: 'api' as const, requestId: 'uncorrelated-gateway-refusal', status: 401, since: 95, until: 105, mode: 'absent' as const };
  const before = { service: 'api' as const, requestId: 'before', status: 200, since: 90, until: 94, mode: 'present' as const };
  const after = { ...before, requestId: 'after', since: 150, until: 160 };
  const build = (extra: ReturnType<typeof event>[]) => { const o = new LogObserver(groups); o.ingest([event('b', { requestId: 'before', status: 200 }, 'i', 'owned-api', 92), event('a', { requestId: 'after', status: 200 }, 'i', 'owned-api', 152), ...extra]); return o.check({ caseId: 'c', assertion: 'absent', expectation: absent, controls: { before, after } }).matched; };
  assert.equal(build([]), true);
  assert.equal(build([event('x', { requestId: 'late-extra', status: 200 }, 'i', 'owned-api', 115)]), false, 'late-stamped extra result');
  assert.equal(build([event('y', { requestId: 'way-later', status: 200 }, 'i', 'owned-api', 105 + 600)]), true, 'beyond grace and after the next control');
});
void test('present checks keyed only by lambdaRequestId or operation get the capped grace', () => {
  const observer = new LogObserver(groups); observer.ingest([event('g', { lambdaRequestId: 'l1', operation: 'gw' }, 'i', 'owned-gateway', 112)]);
  const base = { service: 'gateway' as const, since: 90, until: 110, mode: 'present' as const };
  assert.equal(observer.match({ ...base, lambdaRequestId: 'l1' }), true);
  assert.equal(observer.match({ ...base, operation: 'gw' }), true);
  assert.equal(observer.match({ ...base, operation: 'gw', notAfter: 111 }), false, 'capped at the next input');
  assert.equal(observer.match({ ...base, operation: 'gw', since: 113, until: 120 }), false);
});

// Slow-client race: the final poll of an absent-check flush inherited a near-zero budget and its abort failed every pending case.
import { sdkObserver, ObserverFailure } from '../../e2e/floci/support/logs.ts';
function slowClient(latencyMs: number, events: Record<string, { eventId: string; message: string; logStreamName: string; timestamp: number }[]>, failAfter = Infinity) {
  let calls = 0;
  return { async send(command: { input: { logGroupName: string } }, options?: { abortSignal?: AbortSignal }): Promise<unknown> {
    calls++; const signal = options?.abortSignal;
    await new Promise<void>((resolve, reject) => { const timer = setTimeout(resolve, latencyMs); signal?.addEventListener('abort', () => { clearTimeout(timer); reject(Object.assign(new Error('RAW_ABORT_CANARY'), { name: 'AbortError' })); }); });
    if (calls > failAfter) throw Object.assign(new Error('RAW_SDK_CANARY'), { name: 'TimeoutError' });
    return { events: events[command.input.logGroupName] ?? [] };
  } };
}
const apiEvent = (id: string, requestId: string, timestamp: number) => ({ eventId: id, message: JSON.stringify({ requestId, status: 200, operation: 'list' }), logStreamName: 's', timestamp });
void test('the last observation completes with its own bounded budget and absence covers the window up to until plus grace', async () => {
  const t0 = Date.now();
  const client = slowClient(200, { 'owned-api': [apiEvent('b', 'before', t0 + 10), apiEvent('a', 'after', t0 + 60)] });
  const observer = sdkObserver(client as never, groups);
  const absent = { service: 'api' as const, requestId: 'refused', status: 401, since: t0 + 20, until: t0 + 40, mode: 'absent' as const };
  const before = { service: 'api' as const, requestId: 'before', status: 200, since: t0, until: t0 + 15, mode: 'present' as const };
  const after = { ...before, requestId: 'after', since: t0 + 50, until: t0 + 70 };
  const results = await observer.flush([{ caseId: 'c', assertion: 'absent', expectation: absent, controls: { before, after } }], t0 + 40, 500);
  assert.equal(results[0]!.matched, true);
  assert.equal(Date.now() >= t0 + 40 + 500, true, 'the window was observed through until plus grace');
});
void test('an incomplete final scan never passes absence and fails with a fixed observer code', async () => {
  const t0 = Date.now(); const client = slowClient(100, {}, 3);
  const observer = sdkObserver(client as never, groups);
  const absent = { service: 'api' as const, requestId: 'refused', status: 401, since: t0 + 20, until: t0 + 40, mode: 'absent' as const };
  await assert.rejects(observer.flush([{ caseId: 'c', assertion: 'absent', expectation: absent }], t0 + 40, 400), (error: unknown) => error instanceof ObserverFailure && error.cause === 'request-timeout' && ['api', 'cleanup', 'gateway'].includes(error.service) && error.errorName === 'TimeoutError' && !JSON.stringify(error).includes('CANARY') && !error.message.includes('CANARY'));
});

import { safeObserverFailure } from '../../e2e/floci/support/evidence.ts';
import { toObserverFailure } from '../../e2e/floci/support/logs.ts';
void test('an observer failure is recorded as service, fixed cause and allowlisted SDK name only', () => {
  const cases: [unknown, string, string][] = [
    [Object.assign(new Error('RAW_CANARY'), { name: 'AbortError' }), 'deadline-abort', 'AbortError'], [Object.assign(new Error('RAW_CANARY'), { name: 'TimeoutError' }), 'request-timeout', 'TimeoutError'],
    [new Error('LOG_PAGINATION_FAILED'), 'pagination-repeat', 'other'], [Object.assign(new Error('RAW_CANARY'), { name: 'ThrottlingException', $metadata: { httpStatusCode: 400 } }), 'sdk-error', 'ThrottlingException'],
    [Object.assign(new Error('RAW_CANARY'), { name: 'SecretNamedError', $metadata: {} }), 'sdk-error', 'other'], [new Error('RAW_CANARY'), 'other', 'other'],
  ];
  for (const [error, cause, errorName] of cases) { const safe = safeObserverFailure(toObserverFailure(error, 'cleanup')); assert.deepEqual(safe, { service: 'cleanup', cause, errorName }); assert.equal(JSON.stringify(safe).includes('CANARY') || JSON.stringify(safe).includes('Secret'), false); }
  assert.deepEqual(safeObserverFailure(new Error('RAW_CANARY')), { service: 'unknown', cause: 'other', errorName: 'other' });
  assert.deepEqual(safeObserverFailure({ service: 'RAW_CANARY', cause: 'RAW_CANARY', errorName: 'RAW_CANARY' }), { service: 'unknown', cause: 'other', errorName: 'other' });
});
