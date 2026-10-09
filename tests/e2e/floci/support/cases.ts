import type { CaseDefinition, Layer, OutputExpectation } from './types.ts';
import { acceptParams, rejectParams } from './input-fixtures.ts';

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

/**
 * API contract, input boundary and pagination cases (API-01..API-14). Every
 * parameter becomes its own `<ID>/<label>` case so one failed input never hides
 * another. Cases that need an earlier case's data list it in `caseGuards`; a
 * guard that returns true records an explicit not-run instead of a failure.
 */
function apiCase(id: string, http: string[], logs: string[] | string, options: { ddb?: string[]; s3?: string[] } = {}): CaseDefinition {
  const logsOutput = typeof logs === 'string' ? { assertions: [] as string[], notApplicableReason: logs } : { assertions: logs };
  return { id, requirementId: id.split('/')[0]!, layer: 'E', required: true, acceptance: 'behavior', suite: 'api', source: `formal-e2e-coverage/${id.split('/')[0]!}`, outputs: [
    { kind: 'http', assertions: http },
    { kind: 'dynamodb', assertions: options.ddb ?? ['no-storage-or-rate-change'] },
    { kind: 's3', assertions: options.s3 ?? ['no-image-versions-added'] },
    { kind: 'logs', ...logsOutput },
  ] };
}
const rejection = { http: ['rejected-as-expected', 'valid-control-200'], logs: ['rejection-result-delivered', 'control-result-delivered'], ddb: ['rejection-storage-unchanged-rate-plus-one'] };
const accepted = { http: ['created-201-location-etag-dto', 'readback-get-matches'], logs: ['create-result-delivered', 'readback-result-delivered'], ddb: ['stored-reminder-and-counter-match'] };
const list = (id: string, http: string[]) => apiCase(id, http, ['list-result-delivered'], { ddb: ['list-leaves-rows-unchanged-rate-plus-one'] });
const ownership = (id: string, http: string[], logs: string[]) => apiCase(id, http, logs, { ddb: ['owner-a-rows-unchanged'] });
const gatewayAnswer = 'gateway-answer-no-api-result-required';

export const apiDefinitions: CaseDefinition[] = [
  apiCase('API-01/gate-transition', ['health-200', 'ready-unpublished-503', 'v2-unpublished-503', 'ready-published-200', 'v2-published-200'], ['health-result-delivered', 'ready-503-result-delivered', 'v2-503-result-delivered', 'ready-200-result-delivered', 'v2-200-result-delivered'], { ddb: ['gate-requests-leave-reminders-unchanged'] }),
  apiCase('API-02/legacy-post', ['legacy-410-replacement'], ['legacy-result-delivered']),
  apiCase('API-02/legacy-put', ['legacy-410-replacement'], ['legacy-result-delivered']),
  ...['healthz-delete', 'readyz-post', 'legacy-get', 'list-delete', 'item-post', 'thumbnail-post'].map(label => apiCase(`API-03/${label}`, ['method-not-allowed-405-allow-code'], ['method-result-delivered'])),
  ...['unknown-root-segment', 'unknown-extra-item-segment', 'unknown-v2-sibling'].map(label => apiCase(`API-03/${label}`, ['unknown-path-404'], ['unknown-path-api-result-absent'], { ddb: ['probe-leaves-storage-and-rate-unchanged'] })),
  apiCase('API-04/empty-list', ['list-200-empty-null-cursor-headers'], ['list-result-delivered'], { ddb: ['no-reminders-rate-plus-one'] }),
  apiCase('API-04/create', ['created-201-location-etag-dto'], ['create-result-delivered'], { ddb: ['stored-reminder-and-counter-match'] }),
  apiCase('API-04/get', ['get-200-same-body-etag'], ['get-result-delivered'], { ddb: ['get-leaves-row-unchanged-rate-plus-one'] }),
  apiCase('API-04/patch', ['patch-200-revision-2-etag-changed'], ['patch-result-delivered'], { ddb: ['row-revision-2-counter-unchanged'] }),
  apiCase('API-04/delete', ['delete-200-body-no-etag', 'get-after-delete-404', 'list-excludes-tombstone'], ['delete-result-delivered', 'get-404-result-delivered'], { ddb: ['tombstone-revision-3-counter-decremented'] }),
  // API-12 and API-13 run first on owner B, which holds nothing else at that point.
  apiCase('API-12/seed-51', ['fifty-one-created-201'], ['first-create-result-delivered', 'last-create-result-delivered'], { ddb: ['fifty-one-rows-counter-51'] }),
  ...[['default', 20], ['limit-1', 1], ['limit-20', 20], ['limit-50', 50]].map(([label]) => list(`API-12/${label}`, [`page-size-order-and-cursor`])),
  ...rejectIds('API-12/limit-').map(id => apiCase(id, rejection.http, rejection.logs, { ddb: rejection.ddb })),
  list('API-12/walk-limit-20', ['walk-all-51-ordered-no-duplicates']), list('API-12/walk-limit-7', ['walk-all-51-ordered-no-duplicates']),
  apiCase('API-13/tombstone-seed', ['three-deletes-200'], ['first-delete-result-delivered'], { ddb: ['three-tombstones-counter-48'] }),
  list('API-13/tombstone-head-limit-3', ['empty-first-page-with-cursor', 'walk-rest-ordered-complete']),
  list('API-13/tombstone-head-limit-1', ['three-empty-pages-then-first-live-item']),
  ...['forged-owner', 'forged-version', 'forged-extra-field', 'forged-lastid-control', 'not-base64url', 'not-json', 'oversize', 'other-owner-cursor'].map(label => apiCase(`API-13/${label}`, ['cursor-422-invalid-cursor', 'valid-cursor-control-200'], rejection.logs, { ddb: rejection.ddb })),
  apiCase('API-05/seed', ['both-owners-create-201'], ['a-create-result-delivered', 'b-create-result-delivered'], { ddb: ['rows-independent-per-owner'] }),
  ownership('API-05/other-owner-get', ['b-get-404-same-as-missing', 'a-get-200-unchanged'], ['b-get-404-result-delivered']),
  ownership('API-05/other-owner-patch', ['b-patch-404-same-as-missing'], ['b-patch-404-result-delivered']),
  ownership('API-05/other-owner-delete', ['b-delete-404-same-as-missing'], ['b-delete-404-result-delivered']),
  ownership('API-05/other-owner-thumbnail', ['b-thumbnail-404-owner-not-found'], ['b-thumbnail-404-result-delivered']),
  ownership('API-05/other-owner-list', ['b-list-excludes-a-only-keeps-own'], ['b-first-list-result-delivered']),
  apiCase('API-05/same-id-independent', ['a-patch-200', 'b-same-id-untouched'], ['a-patch-result-delivered'], { ddb: ['rows-independent-per-owner'] }),
  apiCase('API-06/allowed-origin-preflight', ['preflight-unauthenticated-2xx-cors-headers'], gatewayAnswer),
  apiCase('API-06/disallowed-origin-preflight', ['no-allow-origin-header'], gatewayAnswer),
  apiCase('API-06/allowed-origin-actual', ['get-200-allow-origin-expose-headers-no-credentials'], ['list-result-delivered'], { ddb: ['list-leaves-rows-unchanged-rate-plus-one'] }),
  apiCase('API-06/disallowed-origin-actual', ['get-200-no-allow-origin'], ['list-result-delivered'], { ddb: ['list-leaves-rows-unchanged-rate-plus-one'] }),
  apiCase('API-06/s3-allowed-origin-preflight', ['s3-preflight-allow-origin-get'], 's3-answer-no-api-result-required'),
  apiCase('API-06/s3-disallowed-origin-preflight', ['s3-no-allow-origin-header'], 's3-answer-no-api-result-required'),
  ...rejectIds('API-07/').map(id => apiCase(id, rejection.http, rejection.logs, { ddb: rejection.ddb })),
  ...acceptIds('API-07/').map(id => apiCase(id, accepted.http, accepted.logs, { ddb: accepted.ddb })),
  ...rejectIds('API-08/').map(id => apiCase(id, rejection.http, rejection.logs, { ddb: rejection.ddb })),
  ...rejectIds('API-09/').map(id => apiCase(id, rejection.http, rejection.logs, { ddb: rejection.ddb })),
  ...acceptIds('API-09/').map(id => apiCase(id, accepted.http, accepted.logs, { ddb: accepted.ddb })),
  ...rejectIds('API-10/').map(id => apiCase(id, rejection.http, rejection.logs, { ddb: rejection.ddb })),
  ...acceptIds('API-10/').map(id => apiCase(id, accepted.http, accepted.logs, { ddb: accepted.ddb })),
  ...acceptIds('API-11/').map(id => apiCase(id, accepted.http, accepted.logs, { ddb: accepted.ddb })),
  ...rejectIds('API-11/').map(id => apiCase(id, rejection.http, rejection.logs, { ddb: rejection.ddb })),
  apiCase('API-14/auth-refusal-rate-unchanged', ['unauthenticated-401'], ['refusal-api-result-absent'], { ddb: ['refusal-rate-and-storage-unchanged'] }),
  ...rejectIds('API-14/').map(id => apiCase(id, rejection.http, rejection.logs, { ddb: rejection.ddb })),
  apiCase('API-14/unpublished-503-rate-plus-one', ['unpublished-503'], ['unpublished-result-delivered'], { ddb: ['unpublished-rate-plus-one-storage-unchanged'] }),
  apiCase('API-14/rate-limit-120', ['request-120-200', 'request-121-429-retry-after-matches-body'], ['request-120-result-delivered', 'request-121-result-delivered'], { ddb: ['counter-held-at-120-storage-unchanged'] }),
];
function rejectIds(prefix: string): string[] { return rejectParams.filter(item => item.id.startsWith(prefix)).map(item => item.id); }
function acceptIds(prefix: string): string[] { return acceptParams.filter(item => item.id.startsWith(prefix)).map(item => item.id); }
definitions.push(...apiDefinitions);

/** A guard returns true when a prerequisite case has not passed; the runner then records not-run. */
export const caseGuards = new Map<string, (fixture: import('./types.ts').SuiteFixture) => boolean>();
/** Suites whose cases share one set of owners (the suite default auth) because later cases reuse earlier data. */
export const sharedCaseAuth = new Set<string>(['api']);
