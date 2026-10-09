import { caseActions, caseMeasurements } from './cases.ts';
import { Score } from './auth-cases.ts';
import { dailyScheduleMatches, probeOneTimeTrigger, schedulerIo } from './scheduler.ts';

/**
 * OPS-06. The one-time trigger is a compatibility measurement recorded by the runner (pass, unsupported, fail); the caseActions entry only
 * makes it selectable. The daily schedule is never changed: this case only reads it, after the probe, and requires it to be alone in its group.
 */
caseMeasurements.set('OPS-06/one-time-trigger', async fixture => (await probeOneTimeTrigger(fixture)).outcome);
caseActions.set('OPS-06/one-time-trigger', async () => { throw new Error('MEASURED_CASE_RECORDED_BY_RUNNER'); });

caseActions.set('OPS-06/daily-schedule-preserved', async (fixture, recorder) => {
  const score = new Score(); const io = schedulerIo; const b = io.bindings(fixture); const group = `${b.prefix}-production-cleanup`;
  const view = await io.get(fixture, group, group); const names = await io.list(fixture, group);
  score.ok('http', 'daily-03utc-off-disabled-retry2-age3600-alias-read-back', dailyScheduleMatches(view, { aliasArn: b.aliasArn, roleArn: b.roleArn }));
  score.ok('http', 'only-daily-schedule-in-group', names.length === 1 && names[0] === group);
  score.emit('OPS-06/daily-schedule-preserved', recorder);
});
