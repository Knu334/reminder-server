import { randomBytes, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { CreateScheduleCommand, DeleteScheduleCommand, GetScheduleCommand, ListSchedulesCommand } from '@aws-sdk/client-scheduler';
import { evidenceContext, markResource, reserveResource } from './evidence.ts';
import { fixtureState } from './fixture.ts';
import { suiteLogStates } from './logs.ts';
import { DAY, MARGIN, assertNoForeignJobs, collectOwned, makeCleanupJob, putOwnedObject, readCheckpoint, resetCheckpoint, seedCleanupJobs } from './cleanup-fixtures.ts';
import { fresh, jobsOf, versionsOf } from './image-cases.ts';
import { imageBytes } from './image-fixtures.ts';
import type { CleanupSummary, Evidence, SuiteFixture } from './types.ts';

/**
 * One-time Scheduler start probe (OPS-06). The daily schedule is only read: an independent, run-owned `at()` schedule in the same
 * production Scheduler group (the group the Scheduler role trusts) invokes the cleanup alias with `{}`. Acceptance of the schedule is never
 * success: only real job, checkpoint and marker changes together with the delivered cleanup logs are. The schedule is stopped (removed and
 * its absence read back) and processing is awaited before the synthetic data is collected.
 */
export type ScheduleView = { State?: string | undefined; ScheduleExpression?: string | undefined; ScheduleExpressionTimezone?: string | undefined; FlexibleTimeWindow?: { Mode?: string | undefined } | undefined; Target?: { Arn?: string | undefined; RoleArn?: string | undefined; Input?: string | undefined; RetryPolicy?: { MaximumRetryAttempts?: number | undefined; MaximumEventAgeInSeconds?: number | undefined } | undefined } | undefined };
export type ScheduleSpec = { name: string; group: string; at: string; aliasArn: string; roleArn: string };
export type SchedulerBindings = { prefix: string; aliasArn: string; roleArn: string };
export type TriggerObservation = { dailyBefore: boolean; dailyAfter: boolean; created: boolean; readBack: boolean; createRefusal: 'non-support' | 'other' | undefined; jobDone: boolean; marker: boolean; checkpoint: boolean; logsMatched: boolean; anyLog: boolean; removed: boolean };
const NOT_FOUND = 'ResourceNotFoundException';
const named = (error: unknown): string | undefined => (error as { name?: string })?.name;

/** Seams: the defaults talk to the run fixture's Scheduler client and evidence; the offline double replaces them. */
export const schedulerIo = {
  now: (): number => Date.now(),
  sleep: (ms: number): Promise<void> => new Promise<void>(resolve => setTimeout(resolve, ms)),
  windowMs: 90_000, pollMs: 2_000, logWaitMs: 30_000, fireDelayMs: 10_000,
  bindings(fixture: SuiteFixture): SchedulerBindings { const b = fixtureState(fixture).stack.bindings; return { prefix: b.prefix!, aliasArn: b.cleanup_alias_arn!, roleArn: b.scheduler_role_arn! }; },
  async get(fixture: SuiteFixture, group: string, name: string): Promise<ScheduleView | undefined> {
    try { const out = await fixtureState(fixture).scheduler.send(new GetScheduleCommand({ Name: name, GroupName: group })); return { State: out.State, ScheduleExpression: out.ScheduleExpression, ScheduleExpressionTimezone: out.ScheduleExpressionTimezone, FlexibleTimeWindow: out.FlexibleTimeWindow ? { Mode: out.FlexibleTimeWindow.Mode } : undefined, Target: out.Target ? { Arn: out.Target.Arn, RoleArn: out.Target.RoleArn, Input: out.Target.Input, ...(out.Target.RetryPolicy ? { RetryPolicy: { MaximumRetryAttempts: out.Target.RetryPolicy.MaximumRetryAttempts, MaximumEventAgeInSeconds: out.Target.RetryPolicy.MaximumEventAgeInSeconds } } : {}) } : undefined }; }
    catch (error) { if (named(error) === NOT_FOUND) return undefined; throw error; }
  },
  async list(fixture: SuiteFixture, group: string): Promise<string[]> {
    const names: string[] = []; let NextToken: string | undefined;
    do { const page = await fixtureState(fixture).scheduler.send(new ListSchedulesCommand({ GroupName: group, ...(NextToken ? { NextToken } : {}) })); for (const item of page.Schedules ?? []) if (item.Name) names.push(item.Name); NextToken = page.NextToken; } while (NextToken);
    return names;
  },
  async create(fixture: SuiteFixture, spec: ScheduleSpec): Promise<void> {
    await fixtureState(fixture).scheduler.send(new CreateScheduleCommand({ Name: spec.name, GroupName: spec.group, ScheduleExpression: spec.at, ScheduleExpressionTimezone: 'UTC', FlexibleTimeWindow: { Mode: 'OFF' }, State: 'ENABLED', Target: { Arn: spec.aliasArn, RoleArn: spec.roleArn, Input: '{}', RetryPolicy: { MaximumRetryAttempts: 0 } } }));
  },
  async remove(fixture: SuiteFixture, group: string, name: string): Promise<void> {
    try { await fixtureState(fixture).scheduler.send(new DeleteScheduleCommand({ Name: name, GroupName: group })); } catch (error) { if (named(error) !== NOT_FOUND) throw error; }
  },
  async reserve(fixture: SuiteFixture, name: string): Promise<string> { const evidence = fixtureState(fixture).evidence; const id = `${evidence.runId}/sdk-schedule/${name}`; await reserveResource(evidence, { kind: 'sdk-schedule', name, id }); return id; },
  async mark(fixture: SuiteFixture, id: string, status: 'created' | 'removed'): Promise<void> { await markResource(fixtureState(fixture).evidence, id, status); },
  /** Fixed-vocabulary facts only: booleans and one fixed refusal class, never an error text. */
  async record(fixture: SuiteFixture, observation: TriggerObservation): Promise<void> { const evidence = fixtureState(fixture).evidence; await writeFile(join(evidenceContext(evidence).directory, 'scheduler-probe.json'), JSON.stringify(observation, null, 2) + '\n', { mode: 0o600 }); },
};

/** The daily schedule contract: 03:00 UTC, no flexible window, DISABLED, retry 2, event age 3600 s, empty input, cleanup alias target. */
export function dailyScheduleMatches(view: ScheduleView | undefined, expected: { aliasArn: string; roleArn: string }): boolean {
  if (!view?.Target) return false; let input: unknown; try { input = JSON.parse(view.Target.Input ?? ''); } catch { return false; }
  return view.State === 'DISABLED' && view.ScheduleExpression === 'cron(0 3 * * ? *)' && view.ScheduleExpressionTimezone === 'UTC' && view.FlexibleTimeWindow?.Mode === 'OFF' && view.Target.Arn === expected.aliasArn && view.Target.RoleArn === expected.roleArn
    && isDeepStrictEqual(input, {}) && isDeepStrictEqual(view.Target.RetryPolicy, { MaximumRetryAttempts: 2, MaximumEventAgeInSeconds: 3600 });
}
function oneTimeMatches(view: ScheduleView | undefined, spec: ScheduleSpec): boolean {
  if (!view?.Target) return false; let input: unknown; try { input = JSON.parse(view.Target.Input ?? ''); } catch { return false; }
  return view.State === 'ENABLED' && view.ScheduleExpression === spec.at && view.ScheduleExpressionTimezone === 'UTC' && view.FlexibleTimeWindow?.Mode === 'OFF' && view.Target.Arn === spec.aliasArn && view.Target.RoleArn === spec.roleArn && isDeepStrictEqual(input, {});
}
const NON_SUPPORT = new Set(['NotImplemented', 'NotImplementedException', 'UnknownOperationException']);
/** Only an HTTP 501 with a known not-implemented name is an identified non-support; any other refusal is a failure. */
export function refusalClass(error: unknown): 'non-support' | 'other' { const status = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode; return status === 501 && NON_SUPPORT.has(named(error) ?? '') ? 'non-support' : 'other'; }

/** pass: the real work and its logs; unsupported: nothing at all happened (or the API is identified as unimplemented); everything else fails. */
export function classifyTrigger(o: TriggerObservation): 'pass' | 'unsupported' | 'fail' {
  if (!o.dailyBefore || !o.dailyAfter || !o.removed) return 'fail';
  const nothing = !o.jobDone && !o.marker && !o.checkpoint && !o.logsMatched && !o.anyLog;
  if (o.createRefusal === 'other') return 'fail';
  if (o.createRefusal === 'non-support') return !o.created && !o.readBack && nothing ? 'unsupported' : 'fail';
  if (!o.created || !o.readBack) return 'fail';
  if (o.jobDone && o.marker && o.checkpoint && o.logsMatched) return 'pass';
  return nothing ? 'unsupported' : 'fail';
}

const atExpression = (epochMs: number): string => `at(${new Date(epochMs).toISOString().slice(0, 19)})`;
export async function probeOneTimeTrigger(fixture: SuiteFixture): Promise<{ outcome: 'pass' | 'unsupported' | 'fail'; observation: TriggerObservation }> {
  const io = schedulerIo; const b = io.bindings(fixture); const group = `${b.prefix}-production-cleanup`; const dailyName = group; const expected = { aliasArn: b.aliasArn, roleArn: b.roleArn };
  const observation: TriggerObservation = { dailyBefore: false, dailyAfter: false, created: false, readBack: false, createRefusal: undefined, jobDone: false, marker: false, checkpoint: false, logsMatched: false, anyLog: false, removed: true };
  const finish = async (): Promise<{ outcome: 'pass' | 'unsupported' | 'fail'; observation: TriggerObservation }> => { try { await io.record(fixture, observation); } catch { /* the outcome is decided by the observation, not by its file */ } return { outcome: classifyTrigger(observation), observation }; };
  const dailyView = await io.get(fixture, group, dailyName); observation.dailyBefore = dailyScheduleMatches(dailyView, expected);
  if (!observation.dailyBefore) return finish();
  const observer = suiteLogStates.get(fixture)!.observer; const name = `${b.prefix}-onetime-${randomBytes(4).toString('hex')}`; let resourceId: string | undefined; let ownerId: string | undefined; let failure = false; let stopped = false;
  try {
    await fixture.setPublication(true); const who = await fresh(fixture); ownerId = who.ownerId; await assertNoForeignJobs(fixture, [ownerId]); await resetCheckpoint(fixture);
    const jobId = randomUUID(); const data = imageBytes('png', 90, 5); const object = await putOwnedObject(fixture, ownerId, jobId, data);
    const job = makeCleanupJob({ ownerId, jobId, state: 'pending', createdAtMs: Date.now() - DAY - MARGIN, versionId: object.versionId, mime: 'image/png', bytes: object.bytes, sha256: object.sha256 });
    await seedCleanupJobs(fixture, [job]);
    const baseline = observer.safeCounts().cleanup; const since = Date.now(); const spec: ScheduleSpec = { name, group, at: atExpression(io.now() + io.fireDelayMs), aliasArn: b.aliasArn, roleArn: b.roleArn };
    resourceId = await io.reserve(fixture, name);
    try { await io.create(fixture, spec); observation.created = true; await io.mark(fixture, resourceId, 'created'); } catch (error) { observation.createRefusal = refusalClass(error); }
    if (observation.created) {
      observation.readBack = oneTimeMatches(await io.get(fixture, group, name), spec);
      const deadline = io.now() + io.windowMs;
      for (;;) {
        const rows = await jobsOf(fixture, ownerId); const stored = rows.find(row => row.jobId === jobId); observation.jobDone = stored?.state === 'done';
        observation.marker = (await versionsOf(fixture, ownerId)).markers.some(marker => marker.key === job.key); observation.checkpoint = (await readCheckpoint(fixture)) !== undefined;
        if ((observation.jobDone && observation.marker && observation.checkpoint) || io.now() >= deadline) break; await io.sleep(io.pollMs);
      }
    }
    // Stop first: the owned schedule is removed and its absence read back before processing is awaited and the data collected.
    observation.removed = await removeOwned(fixture, group, name, resourceId); stopped = true;
    if (observation.created) {
      const logDeadline = io.now() + io.logWaitMs;
      for (;;) {
        await observer.poll(since); observation.anyLog = observer.safeCounts().cleanup > baseline; observation.logsMatched = observer.cleanupMatch({ since, until: Date.now(), status: 200, evaluated: 1, deletes: 1 });
        if (observation.logsMatched || io.now() >= logDeadline) break; await io.sleep(1000);
      }
    }
  } catch { failure = true; }
  finally {
    if (resourceId && !stopped) observation.removed = await removeOwned(fixture, group, name, resourceId);
    if (ownerId) { try { await collectOwned(fixture, [ownerId]); } catch { failure = true; } }
  }
  observation.dailyAfter = isDeepStrictEqual(await io.get(fixture, group, dailyName).catch(() => undefined), dailyView) && dailyScheduleMatches(dailyView, expected);
  const result = await finish(); return failure ? { outcome: 'fail', observation: result.observation } : result;
}
/** Removal then an independent absence read; true only when the schedule is read back as absent. */
async function removeOwned(fixture: SuiteFixture, group: string, name: string, resourceId: string): Promise<boolean> {
  const io = schedulerIo;
  try { await io.remove(fixture, group, name); } catch { /* the independent read below decides */ }
  try { if ((await io.get(fixture, group, name)) !== undefined) return false; await io.mark(fixture, resourceId, 'removed'); return true; } catch { return false; }
}

/** Run-end recovery: every reserved sdk-schedule that is not removed is deleted when present and its absence read back. Only names this run created are touched. */
export async function sweepOwnedSchedules(client: { remove(group: string, name: string): Promise<void>; exists(group: string, name: string): Promise<boolean> }, evidence: Evidence, group: string): Promise<CleanupSummary> {
  if (!evidenceContext(evidence).finalized) throw new Error('CLEANUP_REJECTED');
  const owned = evidenceContext(evidence).manifest.resources.filter(resource => resource.kind === 'sdk-schedule' && !resource.removed); const prefix = `e2e-${evidence.runId.slice(4, 12)}-`;
  const result: CleanupSummary = { attempted: owned.length, succeeded: 0, errors: 0, leaks: 0 };
  for (const resource of owned) {
    if (!resource.name.startsWith(prefix) || !/^e2e-[0-9a-f]{8}-onetime-[0-9a-f]{8}$/.test(resource.name)) { result.errors++; continue; }
    try { await client.remove(group, resource.name); } catch { /* the independent read below decides */ }
    try { if (await client.exists(group, resource.name)) result.leaks++; else { await markResource(evidence, resource.id, 'removed'); result.succeeded++; } } catch { result.errors++; }
  }
  return result;
}
