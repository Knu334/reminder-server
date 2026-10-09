import type { CaseDefinition, Layer, OutputExpectation } from './types.ts';

function checks(assertions: string[], reason: string): OutputExpectation[] {
  return [
    { kind: 'http', assertions },
    { kind: 'dynamodb', assertions: [], notApplicableReason: reason },
    { kind: 's3', assertions: [], notApplicableReason: reason },
    { kind: 'logs', assertions: [], notApplicableReason: reason },
  ];
}
function entry(id: string, layer: Layer, suite: string, assertions: string[], reason: string): CaseDefinition {
  return { id, requirementId: id.split('/')[0]!, layer, required: true, acceptance: 'behavior', suite,
    source: `formal-e2e-coverage/${id.split('/')[0]!}`, outputs: checks(assertions, reason) };
}
// The foundation inventory is intentionally unexecuted. Later tasks append their
// concrete parameterized cases and actions; missing actions never earn a pass.
export const definitions: CaseDefinition[] = [
  entry('SAFE-01/transport', 'I', 'harness', ['local-only', 'pinned-host', 'no-redirect'], 'isolated-transport'),
  entry('SAFE-02/inventory', 'I', 'harness', ['inventory-retained', 'cleanup-exit'], 'isolated-harness'),
  entry('SAFE-03/redaction', 'I', 'harness', ['no-secret-evidence', 'no-secret-stderr'], 'isolated-harness'),
  entry('TF-02/driver-isolation', 'I', 'terraform', ['reject-default-endpoint', 'owned-cleanup'], 'isolated-driver'),
  { id: 'TF-01/apply', requirementId: 'TF-01', layer: 'L', required: true, acceptance: 'behavior', suite: 'terraform', source: 'formal-e2e-coverage/TF-01', outputs: [
    { kind: 'http', assertions: ['provider-refresh-full-definition', 'routes16-alarms9', 'both-current-zip-aliases'] },
    { kind: 'dynamodb', assertions: ['three-protected-tables-pitr35'] },
    { kind: 's3', assertions: ['create-only-pinned-artifact', 'protected-versioned-buckets'] },
    { kind: 'logs', assertions: ['three-log-groups-retention30'] },
  ] },
];

export const fixtureDefinitions: CaseDefinition[] = [
  { id: 'TF-03/settings', requirementId: 'TF-03', layer: 'L', required: true, acceptance: 'behavior', suite: 'fixture', source: 'formal-e2e-coverage/TF-03', outputs: [
    { kind: 'http', assertions: ['cognito-gateway-lambda-iam-scheduler-alarms'] },
    { kind: 'dynamodb', assertions: ['keys-gsi-ttl-pitr35-protection'] },
    { kind: 's3', assertions: ['version-encryption-public-block-lifecycle-cors-policy-pinned-zip'] },
    { kind: 'logs', assertions: ['three-owned-groups-retention30'] },
  ] },
  { id: 'OBS-02/smoke', requirementId: 'OBS-02', layer: 'E', required: true, acceptance: 'behavior', suite: 'fixture', source: 'formal-e2e-coverage/OBS-02', outputs: [
    { kind: 'http', assertions: ['ready503-health200-ready200-unauth401'] },
    { kind: 'dynamodb', assertions: ['refusal-rate-storage-unchanged'] },
    { kind: 's3', assertions: ['refusal-versions-unchanged'] },
    { kind: 'logs', assertions: ['real-api-results-and-cleanup-delivered'] },
  ] },
  { id: 'OBS-03/gateway-refusal', requirementId: 'OBS-03', layer: 'E', required: true, acceptance: 'behavior', suite: 'fixture', source: 'formal-e2e-coverage/OBS-03', outputs: [
    { kind: 'http', assertions: ['gateway401'] }, { kind: 'dynamodb', assertions: ['refusal-rate-storage-unchanged'] }, { kind: 's3', assertions: ['refusal-versions-unchanged'] }, { kind: 'logs', assertions: ['delivered-controls-no-extra-api-results'] },
  ] },
  { id: 'OBS-04/gateway-delivery', requirementId: 'OBS-04', layer: 'L', required: true, acceptance: 'compatibility', suite: 'fixture', source: 'formal-e2e-coverage/OBS-04', outputs: checks(['measured-owned-gateway-delivery'], 'gateway-log-probe') },
];
definitions.push(...fixtureDefinitions);

/** Later task suites register concrete actions; absent actions remain explicit not-run. */
export const caseActions = new Map<string, (fixture: import('./types.ts').SuiteFixture, recorder: import('./types.ts').CaseRecorder) => Promise<void>>();

definitions.push({ ...fixtureDefinitions[0]!, id: 'TF-03/settings-final' });
