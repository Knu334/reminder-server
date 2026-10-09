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

/** Formal authentication cases. AUTH-06 waits for a real 300 second expiry, so it stays last in the suite. */
function authCase(id: string, layer: Layer, http: string[], logs: string[] | string, options: { ddb?: string[]; s3?: string[]; ddbReason?: string } = {}): CaseDefinition {
  const na = (reason: string) => ({ assertions: [] as string[], notApplicableReason: reason });
  const storage = (names: string[] | undefined, reason: string) => names?.length ? { assertions: names } : na(reason);
  return { id, requirementId: id.split('/')[0]!, layer, required: true, acceptance: 'behavior', suite: 'auth', source: `formal-e2e-coverage/${id.split('/')[0]!}`, outputs: [
    { kind: 'http', assertions: http },
    { kind: 'dynamodb', ...storage(options.ddb, options.ddbReason ?? 'token-endpoint-only-no-storage-effect') },
    { kind: 's3', ...storage(options.s3, options.ddbReason ?? 'token-endpoint-only-no-storage-effect') },
    { kind: 'logs', ...(typeof logs === 'string' ? na(logs) : { assertions: logs }) },
  ] };
}
const refusalStorage = { ddb: ['refusal-owner-rate-storage-unchanged'], s3: ['refusal-image-versions-unchanged'] };
export const authDefinitions: CaseDefinition[] = [
  authCase('AUTH-01/pkce-login', 'E', ['hosted-ui-s256-code-exchange', 'jwks-signature-iss-client-sub', 'access-lifetime-300s', 'api-get-200'], ['valid-get-result-delivered'], { ddbReason: 'positive-control-no-reminder-write' }),
  authCase('AUTH-02/pkce-negatives', 'E', ['wrong-verifier-rejected', 'missing-verifier-rejected', 'callback-mismatch-rejected', 'code-reuse-rejected', 'non-s256-rejected', 'independent-valid-control-issued'], 'token-endpoint-only-no-api-result', { ddb: ['token-rejections-storage-unchanged'], s3: ['token-rejections-image-versions-unchanged'] }),
  authCase('AUTH-03/jwt-signature', 'E', ['no-jwt-401', 'signature-only-tamper-401', 'valid-controls-200'], ['no-jwt-api-result-absent', 'signature-tamper-api-result-absent'], refusalStorage),
  authCase('AUTH-04/sibling-client', 'E', ['same-pool-sibling-client-401', 'valid-controls-200'], ['sibling-api-result-absent'], refusalStorage),
  authCase('AUTH-05/foreign-issuer', 'E', ['foreign-pool-401', 'foreign-rejection-classified', 'valid-controls-200'], ['foreign-api-result-absent'], refusalStorage),
  authCase('AUTH-07/scope-and-id-token', 'E', ['read-only-post-403', 'write-only-get-403', 'id-token-403', 'valid-controls-200'], ['read-only-post-api-result-absent', 'write-only-get-api-result-absent', 'id-token-api-result-absent'], refusalStorage),
  authCase('AUTH-09/refresh-rotation', 'E', ['rotation-200', 'new-refresh-token-differs', 'access-lifetime-300s', 'grant-identity-scope-owner-preserved', 'renewed-api-get-200'], ['renewed-get-result-delivered'], { ddbReason: 'positive-control-no-reminder-write' }),
  authCase('AUTH-10/rotation-grace', 'E', ['grace-inner-reuse-200', 'grace-start-not-extended-invalid-grant', 'descendant-refresh-200'], 'token-endpoint-only-no-api-result'),
  authCase('AUTH-11/revoke-disable', 'E', ['revoked-original-refresh-400', 'revoked-descendant-refresh-400', 'disabled-user-login-refused', 'disabled-user-refresh-refused'], 'token-endpoint-only-no-api-result'),
  authCase('AUTH-12/refresh-negatives', 'E', ['missing-refresh-rejected', 'malformed-refresh-rejected', 'sibling-client-refresh-rejected', 'scope-not-expanded', 'valid-refresh-control-200'], 'token-endpoint-only-no-api-result'),
  authCase('AUTH-06/token-expiry', 'E', ['valid-before-expiry-200', 'expired-401', 'refreshed-token-200'], ['expired-api-result-absent'], refusalStorage),
  // Independent product-handler cases run offline in tests/integration/formal-e2e/auth-claims.test.ts.
  authCase('AUTH-05/issuer-only', 'I', ['requireOwner-issuer-only-401'], 'handler-boundary-no-delivery', { ddbReason: 'handler-boundary-no-storage' }),
  authCase('AUTH-07/token-use-only', 'I', ['requireOwner-token-use-only-401'], 'handler-boundary-no-delivery', { ddbReason: 'handler-boundary-no-storage' }),
];
definitions.push(...authDefinitions);
