import type { CleanupSummary, SuiteFixture } from './types.ts';
import { fixtureState } from './fixture.ts';
import { evidenceContext, finalizeSuiteResources } from './evidence.ts';
import { resetAuthControls, sdkAbsenceCounts } from './auth.ts';
import { resetStorage } from './storage.ts';
export async function resetOwnedSuite(fixture: SuiteFixture): Promise<CleanupSummary> {
  const state = fixtureState(fixture); await finalizeSuiteResources(state.evidence, state.suite);
  await resetAuthControls(fixture); const result = await resetStorage(fixture); await fixture.setPublication(false); state.suiteActive = false; return result;
}
export async function cleanupOwnedSdk(fixture: SuiteFixture): Promise<CleanupSummary> {
  const state = fixtureState(fixture); if (!evidenceContext(state.evidence).finalized) throw new Error('CLEANUP_REJECTED');
  const owned = evidenceContext(state.evidence).manifest.resources.filter(r => ['sdk-user', 'sdk-control'].includes(r.kind) && !r.removed);
  const result = { attempted: owned.length, succeeded: 0, errors: 0, leaks: 0 };
  try { await resetAuthControls(fixture); } catch { /* independent reads and manifest removal below determine failure counts */ }
  const after = evidenceContext(state.evidence).manifest.resources; result.succeeded = owned.filter(r => after.find(a => a.id === r.id)?.removed).length;
  // Unknown/unchecked controls are errors, never independently observed leaks/absence.
  result.errors = owned.length - result.succeeded; result.leaks = sdkAbsenceCounts(fixture, owned.map(resource => resource.id)).exists; return result;
}
