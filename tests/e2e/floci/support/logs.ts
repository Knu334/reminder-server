import { FilterLogEventsCommand } from '@aws-sdk/client-cloudwatch-logs';
import type { CloudWatchLogsClient } from '@aws-sdk/client-cloudwatch-logs';
import type { CleanupResult } from '../../../../src/images/types.ts';
import type { LogExpectation, PendingLogCheck, LogCheckResult, SuiteFixture, OutputResult } from './types.ts';
export type ObservedEvent = { eventId: string; message: string; logStreamName: string; group: string; timestamp: number };
export type CleanupCompletion = { since: number; until: number; completed: boolean; failed?: string; status?: number; result?: CleanupResult; storageUnchanged?: boolean };
export type CleanupExpectation = { since: number; until: number; nextSince?: number; status?: number; evaluated?: number; deletes?: number; skippedUnpublished?: boolean };
/** Floci stamps Lambda log events when it ingests them, slightly after the HTTP response returns. */
export const LOG_TIMESTAMP_GRACE_MS = 500;
/** Bounded budget of every observation poll, including the last one. */
export const FINAL_POLL_BUDGET_MS = 30_000;
/** A failed observation, reduced to a fixed vocabulary: never the raw SDK message. */
export type ObserverCause = 'deadline-abort' | 'request-timeout' | 'pagination-repeat' | 'sdk-error' | 'other';
const SAFE_ERROR_NAMES = new Set(['TimeoutError', 'AbortError', 'ResourceNotFoundException', 'ThrottlingException', 'InvalidParameterException', 'ServiceUnavailableException', 'InternalFailure', 'UnknownOperationException', 'AccessDeniedException', 'UnrecognizedClientException']);
export class ObserverFailure extends Error {
  constructor(readonly service: LogExpectation['service'], readonly cause: ObserverCause, readonly errorName: string) { super('OBSERVER_FAILED'); this.name = 'ObserverFailure'; }
  toJSON(): { service: string; cause: ObserverCause; errorName: string } { return { service: this.service, cause: this.cause, errorName: this.errorName }; }
}
export function toObserverFailure(error: unknown, service: LogExpectation['service']): ObserverFailure {
  if (error instanceof ObserverFailure) return error;
  const name = (error as { name?: string })?.name; const message = (error as { message?: string })?.message;
  const errorName = typeof name === 'string' && SAFE_ERROR_NAMES.has(name) ? name : 'other';
  const cause: ObserverCause = message === 'LOG_PAGINATION_FAILED' ? 'pagination-repeat' : name === 'TimeoutError' ? 'request-timeout' : name === 'AbortError' ? 'deadline-abort' : errorName !== 'other' || (error as { $metadata?: unknown })?.$metadata ? 'sdk-error' : 'other';
  return new ObserverFailure(service, cause, errorName);
}
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
  /** Upper bound of the lag grace: LOG_TIMESTAMP_GRACE_MS past `until`, but never at or beyond the harness-known start of the next tracked input. */
  private limit(until: number, graceMs: number, notAfter?: number): number { return Math.min(until + graceMs, notAfter === undefined ? Infinity : Math.max(until, notAfter - 1)); }
  private window(expect: LogExpectation, graceMs = 0): Parsed[] { const limit = expect.until === undefined ? Infinity : this.limit(expect.until, graceMs, expect.notAfter); return [...this.events.values()].filter(event => event.group === this.groups[expect.service] && event.timestamp >= expect.since && event.timestamp <= limit); }
  match(expect: LogExpectation): boolean {
    if (expect.service === 'api' && (!expect.requestId || expect.status === undefined)) return false;
    const present = expect.mode === 'present';
    const matched = this.window(expect, present ? LOG_TIMESTAMP_GRACE_MS : 0).filter(({ doc }) => (!expect.requestId || doc.requestId === expect.requestId) && (!expect.lambdaRequestId || doc.lambdaRequestId === expect.lambdaRequestId) && (expect.status === undefined || Number(doc.status) === expect.status) && (!expect.operation || doc.operation === expect.operation) && (!expect.code || doc.code === expect.code));
    if (present) return matched.length === 1;
    // A refused request must have no result log at all, however late Floci stamps it.
    return matched.length === 0 && !(expect.requestId && [...this.events.values()].some(e => e.group === this.groups[expect.service] && e.doc.requestId === expect.requestId));
  }
  check(check: PendingLogCheck): LogCheckResult {
    const before = check.controls ? this.match(check.controls.before) : false; const after = check.controls ? this.match(check.controls.after) : false;
    let matched = this.match(check.expectation);
    if (check.expectation.mode === 'absent') {
      // Any owned-window API result is extra: normal controls sit outside this window.
      matched = matched && !!check.controls && before && after && this.window({ ...check.expectation, notAfter: check.controls.after.since }, LOG_TIMESTAMP_GRACE_MS).filter(e => typeof e.doc.requestId === 'string' && typeof e.doc.status === 'number' && ![check.controls?.before.requestId, check.controls?.after.requestId].includes(e.doc.requestId)).length === 0;
    }
    return { caseId: check.caseId, assertion: check.assertion, matched, ...(check.controls ? { controlsMatched: { before, after } } : {}) };
  }
  cleanupMatch(expected: CleanupExpectation, completion?: CleanupCompletion): boolean {
    // Floci stamps events at ingestion, after the invoke returned: accept a bounded lag, capped at the next tracked invoke's harness-known start.
    const limit = this.limit(expected.until, LOG_TIMESTAMP_GRACE_MS, expected.nextSince);
    const events = [...this.events.values()].filter(e => e.group === this.groups.cleanup && e.timestamp >= expected.since && e.timestamp <= limit);
    const isStart = (e: Parsed): boolean => e.doc.operation === 'cleanup_start' && typeof e.doc.lambdaRequestId === 'string';
    // The invoke is identified by its bounded window alone (the HTTP invoke id is not the runtime invokeId): exactly one start, or the pairing is ambiguous.
    const starts = events.filter(isStart);
    if (starts.length !== 1) return false;
    const start = starts[0]!;
    const nextStart = Math.min(Infinity, ...events.filter(e => isStart(e) && e !== start && e.timestamp >= start.timestamp).map(e => e.timestamp));
    const own = events.filter(e => e === start || e.timestamp < nextStart);
    if (start.invokeId && start.invokeId !== start.doc.lambdaRequestId) return false;
    if (expected.skippedUnpublished === true) {
      return !!completion && completion.completed && completion.since === expected.since && completion.until === expected.until && completion.status === 200 && completion.result?.skippedUnpublished === true && completion.result.incomplete === false && completion.result.evaluated === (expected.evaluated ?? 0) && completion.result.deletes === (expected.deletes ?? 0) && completion.storageUnchanged === true && !own.some(e => e.doc.operation === 'cleanup');
    }
    const ends = own.filter(e => e.logStreamName === start.logStreamName && e.timestamp >= start.timestamp && e.doc.operation === 'cleanup' && typeof e.doc.requestId === 'string');
    if (ends.length !== 1) return false;
    if (ends[0]!.invokeId && ends[0]!.invokeId !== start.doc.lambdaRequestId) return false;
    const end = ends[0]!.doc;
    if (completion && (!completion.completed || completion.since !== expected.since || completion.until !== expected.until || completion.status !== 200 || !completion.result || completion.result.evaluated !== end.evaluated || completion.result.deletes !== end.deletes)) return false;
    return (expected.status === undefined || end.status === expected.status) && (expected.evaluated === undefined || end.evaluated === expected.evaluated) && (expected.deletes === undefined || end.deletes === expected.deletes) && (!completion?.result || completion.result.skippedUnpublished === false);
  }
  async poll(since: number, until?: number): Promise<void> { if (!this.io) return; const deadline = until ?? this.io.clock() + 30_000; for (const [service, group] of Object.entries(this.groups) as [LogExpectation['service'], string][]) { const remaining = deadline - this.io.clock(); if (remaining <= 0) break; try { this.ingest(await this.io.fetch(group, since, remaining)); } catch (error) { throw toObserverFailure(error, service); } } }
  /**
   * Observation window: every poll gets its own bounded budget (never the leftover of the deadline), and the scan only ends once a poll
   * started at or after until + grace, so an absent check is never judged on a scan that stopped inside its window. Any poll failure rejects
   * with a fixed ObserverFailure; nothing is ever passed on an incomplete scan.
   */
  async flush(checks: PendingLogCheck[], lastInput: number, timeout = 60_000, additionalReady: () => boolean = () => true): Promise<LogCheckResult[]> {
    if (!this.io) return checks.map(check => this.check(check));
    const until = lastInput + Math.min(60_000, timeout); const since = Math.min(lastInput, ...checks.map(check => check.expectation.since), ...checks.flatMap(check => check.controls ? [check.controls.before.since] : []));
    const covered = until + LOG_TIMESTAMP_GRACE_MS;
    for (;;) {
      const started = this.io.clock(); await this.poll(since, started + FINAL_POLL_BUDGET_MS);
      if (checks.length && checks.every(check => check.expectation.mode === 'present' && this.check(check).matched) && additionalReady()) break;
      if (started >= covered) break;
      await this.io.sleep(Math.max(1, Math.min(1000, covered - this.io.clock())));
    }
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
/** One case may register several cleanup expectations, each bound to its own tracked invoke window (first 'delivered', then 'delivered-2', ...). A window already registered, or an overlapping one, is rejected. */
export function expectCleanupLogs(fixture: SuiteFixture, caseId: string, expected: CleanupExpectation): PendingLogCheck { const state = suiteLogStates.get(fixture); if (!state || [...state.cleanup.values()].some(other => expected.since <= other.until && other.since <= expected.until)) throw new Error('FIXTURE_REJECTED'); const own = [...state.cleanup.keys()].filter(key => key === caseId || key.startsWith(`${caseId}#`)).length; const check = registerLogCheck(fixture, caseId, { service: 'cleanup', since: expected.since, until: expected.until, mode: 'present', operation: expected.skippedUnpublished ? 'cleanup_start' : 'cleanup' }); if (own > 0) check.assertion = `delivered-${own + 1}`; state.cleanup.set(own === 0 ? caseId : `${caseId}#${own + 1}`, expected); return check; }
/** The harness-known `since` of the next tracked input (pending check, control or cleanup invoke) that starts at or after `until` and after its own `since`. */
export function nextSinceAfter(state: SuiteLogState, until: number, since: number): number | undefined { const sinces = [...state.pending.flatMap(c => [c.expectation.since, ...(c.controls ? [c.controls.before.since, c.controls.after.since] : [])]), ...state.completions.map(c => c.since), ...[...state.cleanup.values()].map(c => c.since)].filter(next => next >= until && next > since); return sinces.length ? Math.min(...sinces) : undefined; }
/** Binds every check's lag grace to the next tracked input; call on the checks about to be flushed. */
export function capCleanupGrace(state: SuiteLogState, checks: PendingLogCheck[]): void { for (const check of checks) { const notAfter = check.expectation.notAfter ?? nextSinceAfter(state, check.expectation.until ?? check.expectation.since, check.expectation.since); if (notAfter !== undefined) check.expectation.notAfter = notAfter; } }
const capped = (state: SuiteLogState, expected: CleanupExpectation): CleanupExpectation => { const nextSince = expected.nextSince ?? nextSinceAfter(state, expected.until, expected.since); return nextSince === undefined ? expected : { ...expected, nextSince }; };
export function cleanupChecksMatch(state: SuiteLogState): boolean { return [...state.cleanup.values()].every(expected => { const completion = state.completions.find(completion => completion.since === expected.since && completion.until === expected.until); return !!completion && state.observer.cleanupMatch(capped(state, expected), completion); }); }
export function cleanupCaseMatches(state: SuiteLogState, caseId: string): boolean { return [...state.cleanup.entries()].filter(([key]) => key === caseId || key.startsWith(`${caseId}#`)).every(([, expected]) => { const completion = state.completions.find(c => c.since === expected.since && c.until === expected.until); return !!completion && state.observer.cleanupMatch(capped(state, expected), completion); }); }
export async function flushSuiteLogs(fixture: SuiteFixture): Promise<Map<string, OutputResult>> { const state = suiteLogStates.get(fixture); if (!state) throw new Error('FIXTURE_REJECTED'); capCleanupGrace(state, state.pending); const checks = await state.observer.flush(state.pending, state.lastInput, 60_000, () => cleanupChecksMatch(state)); const result = new Map<string, OutputResult>(); for (const check of checks) { const matched = check.matched && cleanupCaseMatches(state, check.caseId); const output = result.get(check.caseId) ?? { kind: 'logs', status: 'pass', assertions: [] }; if (output.assertions.some(a => a.name === check.assertion)) throw new Error('INVALID_LOG_CHECK'); output.assertions.push({ name: check.assertion, status: matched ? 'pass' : 'fail' }); if (!matched) output.status = 'fail'; result.set(check.caseId, output); } return result; }
