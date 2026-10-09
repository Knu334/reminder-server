import { FilterLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';
import type { CloudWatchLogsClient } from '@aws-sdk/client-cloudwatch-logs';
import type { CleanupResult } from '../../../../src/images/types.ts';
import type { LogExpectation, PendingLogCheck, LogCheckResult, SuiteFixture, OutputResult } from './types.ts';
export type ObservedEvent = { eventId: string; message: string; logStreamName: string; group: string; timestamp: number };
export type CleanupCompletion = { since: number; until: number; completed: boolean; status?: number; result?: CleanupResult; storageUnchanged?: boolean };
export type CleanupExpectation = { since: number; until: number; status?: number; evaluated?: number; deletes?: number; skippedUnpublished?: boolean };
type Parsed = ObservedEvent & { invokeId?: string; doc: Record<string, unknown> };
export class LogObserver {
  private events = new Map<string, Parsed>();
  constructor(readonly groups: Record<LogExpectation['service'], string>, private readonly io?: { clock(): number; sleep(ms: number): Promise<void>; fetch(group: string, since: number, remainingMs: number): Promise<ObservedEvent[]> }) {}
  ingest(events: ObservedEvent[]): void {
    for (const event of events) {
      if (!Object.values(this.groups).includes(event.group)) continue;
      try {
        // Docker Lambda Text logs can prefix the JSON with timestamp/request ID.
        const start = event.message.indexOf('{'); if (start < 0) continue;
        const doc: unknown = JSON.parse(event.message.slice(start));
        if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) continue;
        const invokeId = /\t([A-Za-z0-9-]+)\t(?:INFO|WARN|ERROR|DEBUG)\t/.exec(event.message.slice(0, start))?.[1];
        this.events.set(`${event.group}/${event.eventId}`, { ...event, ...(invokeId ? { invokeId } : {}), doc: doc as Record<string, unknown> });
      } catch { /* platform/other text is not an application result */ }
    }
  }
  safeCounts(): Record<LogExpectation['service'], number> { return Object.fromEntries(Object.entries(this.groups).map(([service, group]) => [service, [...this.events.values()].filter(e => e.group === group).length])) as Record<LogExpectation['service'], number>; }
  private window(expect: LogExpectation): Parsed[] { return [...this.events.values()].filter(event => event.group === this.groups[expect.service] && event.timestamp >= expect.since && event.timestamp <= (expect.until ?? Infinity)); }
  match(expect: LogExpectation): boolean {
    if (expect.service === 'api' && (!expect.requestId || expect.status === undefined)) return false;
    const matched = this.window(expect).filter(({ doc }) => (!expect.requestId || doc.requestId === expect.requestId) && (!expect.lambdaRequestId || doc.lambdaRequestId === expect.lambdaRequestId) && (expect.status === undefined || Number(doc.status) === expect.status) && (!expect.operation || doc.operation === expect.operation) && (!expect.code || doc.code === expect.code));
    return expect.mode === 'present' ? matched.length === 1 : matched.length === 0;
  }
  check(check: PendingLogCheck): LogCheckResult {
    const before = check.controls ? this.match(check.controls.before) : false; const after = check.controls ? this.match(check.controls.after) : false;
    let matched = this.match(check.expectation);
    if (check.expectation.mode === 'absent') {
      // Any owned-window API result is extra: normal controls sit outside this window.
      matched = matched && !!check.controls && before && after && this.window(check.expectation).filter(e => typeof e.doc.requestId === 'string' && typeof e.doc.status === 'number' && ![check.controls?.before.requestId, check.controls?.after.requestId].includes(e.doc.requestId)).length === 0;
    }
    return { caseId: check.caseId, assertion: check.assertion, matched, ...(check.controls ? { controlsMatched: { before, after } } : {}) };
  }
  cleanupMatch(expected: CleanupExpectation, completion?: CleanupCompletion): boolean {
    const events = [...this.events.values()].filter(e => e.group === this.groups.cleanup && e.timestamp >= expected.since && e.timestamp <= expected.until);
    const starts = events.filter(e => e.doc.operation === 'cleanup_start' && typeof e.doc.lambdaRequestId === 'string');
    if (starts.length !== 1) return false;
    const start = starts[0]!;
    if (start.invokeId && start.invokeId !== start.doc.lambdaRequestId) return false;
    if (expected.skippedUnpublished === true) {
      return !!completion && completion.completed && completion.since === expected.since && completion.until === expected.until && completion.status === 200 && completion.result?.skippedUnpublished === true && completion.result.incomplete === false && completion.result.evaluated === (expected.evaluated ?? 0) && completion.result.deletes === (expected.deletes ?? 0) && completion.storageUnchanged === true && !events.some(e => e.doc.operation === 'cleanup');
    }
    const ends = events.filter(e => e.logStreamName === start.logStreamName && e.timestamp >= start.timestamp && e.doc.operation === 'cleanup' && typeof e.doc.requestId === 'string');
    if (ends.length !== 1) return false;
    if (ends[0]!.invokeId && ends[0]!.invokeId !== start.doc.lambdaRequestId) return false;
    const end = ends[0]!.doc;
    if (completion && (!completion.completed || completion.since !== expected.since || completion.until !== expected.until || completion.status !== 200 || !completion.result || completion.result.evaluated !== end.evaluated || completion.result.deletes !== end.deletes)) return false;
    return (expected.status === undefined || end.status === expected.status) && (expected.evaluated === undefined || end.evaluated === expected.evaluated) && (expected.deletes === undefined || end.deletes === expected.deletes) && (!completion?.result || completion.result.skippedUnpublished === false);
  }
  async poll(since: number, until?: number): Promise<void> { if (!this.io) return; const deadline = until ?? this.io.clock() + 30_000; for (const group of Object.values(this.groups)) { const remaining = deadline - this.io.clock(); if (remaining <= 0) break; this.ingest(await this.io.fetch(group, since, remaining)); } }
  async flush(checks: PendingLogCheck[], lastInput: number, timeout = 60_000, additionalReady: () => boolean = () => true): Promise<LogCheckResult[]> {
    if (!this.io) return checks.map(check => this.check(check));
    const until = lastInput + Math.min(60_000, timeout); const since = Math.min(lastInput, ...checks.map(check => check.expectation.since), ...checks.flatMap(check => check.controls ? [check.controls.before.since] : []));
    do { await this.poll(since, until); if (checks.length && checks.every(check => check.expectation.mode === 'present' && this.check(check).matched) && additionalReady()) break; const remaining = until - this.io.clock(); if (remaining <= 0) break; await this.io.sleep(Math.min(1000, remaining)); } while (this.io.clock() < until);
    return checks.map(check => this.check(check));
  }
}
export function sdkObserver(client: CloudWatchLogsClient, groups: Record<LogExpectation['service'], string>): LogObserver {
  return new LogObserver(groups, { clock: Date.now, sleep: ms => new Promise(resolve => setTimeout(resolve, ms)), async fetch(group, since, remainingMs) {
    const deadline = Date.now() + remainingMs;
    const events: ObservedEvent[] = []; let nextToken: string | undefined; const tokens = new Set<string>();
    do { const remaining = Math.min(30_000, deadline - Date.now()); if (remaining <= 0) break; const page = await client.send(new FilterLogEventsCommand({ logGroupName: group, startTime: since, ...(nextToken ? { nextToken } : {}) }), { requestTimeout: remaining, abortSignal: AbortSignal.timeout(remaining) });
      for (const event of page.events ?? []) if (event.eventId && event.message && event.logStreamName && event.timestamp !== undefined) events.push({ eventId: event.eventId, message: event.message, logStreamName: event.logStreamName, timestamp: event.timestamp, group });
      if (page.nextToken && tokens.has(page.nextToken)) throw new Error('LOG_PAGINATION_FAILED'); nextToken = page.nextToken; if (nextToken) tokens.add(nextToken);
    } while (nextToken); return events;
  } });
}
export type SuiteLogState = { observer: LogObserver; pending: PendingLogCheck[]; cleanup: Map<string, CleanupExpectation>; completions: CleanupCompletion[]; lastInput: number };
export const suiteLogStates = new WeakMap<SuiteFixture, SuiteLogState>();
export function registerLogCheck(fixture: SuiteFixture, caseId: string, expected: LogExpectation): PendingLogCheck { const state = suiteLogStates.get(fixture); if (!state) throw new Error('FIXTURE_REJECTED'); const check = { caseId, assertion: 'delivered', expectation: expected }; state.pending.push(check); state.lastInput = Math.max(state.lastInput, expected.until ?? expected.since); return check; }
export function expectCleanupLogs(fixture: SuiteFixture, caseId: string, expected: CleanupExpectation): PendingLogCheck { const state = suiteLogStates.get(fixture); if (!state || state.cleanup.has(caseId)) throw new Error('FIXTURE_REJECTED'); const check = registerLogCheck(fixture, caseId, { service: 'cleanup', since: expected.since, until: expected.until, mode: 'present', operation: expected.skippedUnpublished ? 'cleanup_start' : 'cleanup' }); state.cleanup.set(caseId, expected); return check; }
export function cleanupChecksMatch(state: SuiteLogState): boolean { return [...state.cleanup.values()].every(expected => { const completion = state.completions.find(completion => completion.since === expected.since && completion.until === expected.until); return !!completion && state.observer.cleanupMatch(expected, completion); }); }
export function cleanupCaseMatches(state: SuiteLogState, caseId: string): boolean { const expected = state.cleanup.get(caseId); if (!expected) return true; const completion = state.completions.find(c => c.since === expected.since && c.until === expected.until); return !!completion && state.observer.cleanupMatch(expected, completion); }
export async function flushSuiteLogs(fixture: SuiteFixture): Promise<Map<string, OutputResult>> { const state = suiteLogStates.get(fixture); if (!state) throw new Error('FIXTURE_REJECTED'); const checks = await state.observer.flush(state.pending, state.lastInput, 60_000, () => cleanupChecksMatch(state)); const result = new Map<string, OutputResult>(); for (const check of checks) { const matched = check.matched && cleanupCaseMatches(state, check.caseId); const output = result.get(check.caseId) ?? { kind: 'logs', status: 'pass', assertions: [] }; if (output.assertions.some(a => a.name === check.assertion)) throw new Error('INVALID_LOG_CHECK'); output.assertions.push({ name: check.assertion, status: matched ? 'pass' : 'fail' }); if (!matched) output.status = 'fail'; result.set(check.caseId, output); } return result; }
