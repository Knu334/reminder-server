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
  authCase('AUTH-11/revoke-disable', 'E', ['revoked-original-refresh-400', 'revoked-descendant-refresh-400', 'revocation-channel-revoke-token-api', 'disabled-user-login-refused', 'disabled-user-refresh-refused'], 'token-endpoint-only-no-api-result'),
  authCase('AUTH-12/refresh-negatives', 'E', ['missing-refresh-rejected', 'malformed-refresh-rejected', 'sibling-client-refresh-rejected', 'scope-not-expanded', 'valid-refresh-control-200'], 'token-endpoint-only-no-api-result'),
  // Floci serves no hosted /oauth2/revoke route (measured live). AUTH-11 revokes through the RevokeToken API, so the hosted endpoint is a separate compatibility measurement.
  { ...authCase('AUTH-11/hosted-revoke-endpoint', 'L', ['hosted-revoke-endpoint-measured'], 'token-endpoint-only-no-api-result'), acceptance: 'compatibility' },
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
];
function rejectIds(prefix: string): string[] { return rejectParams.filter(item => item.id.startsWith(prefix)).map(item => item.id); }
function acceptIds(prefix: string): string[] { return acceptParams.filter(item => item.id.startsWith(prefix)).map(item => item.id); }
definitions.push(...apiDefinitions);


/**
 * Strong ETag, concurrency, tombstone and rate-boundary cases. Each E case owns its synthetic users (own RATE and storage) and starts
 * from a fresh owner; there are no dependency groups. STORE-06 and the store-level concurrency proofs are I cases whose evidence is
 * tests/integration/formal-e2e/{concurrency,quota}.test.ts, shown as a separate layer from the E client sends.
 */
function storeCase(id: string, http: string[], ddb: string[], s3: string[], logs: string[]): CaseDefinition {
  return { id, requirementId: id.split('/')[0]!, layer: 'E', required: true, acceptance: 'behavior', suite: 'storage', source: `formal-e2e-coverage/${id.split('/')[0]!}`, outputs: [
    { kind: 'http', assertions: http }, { kind: 'dynamodb', assertions: ddb }, { kind: 's3', assertions: s3 }, { kind: 'logs', assertions: logs },
  ] };
}
function storeInt(id: string, assertions: string[]): CaseDefinition {
  const na = (reason: string) => ({ assertions: [] as string[], notApplicableReason: reason });
  return { id, requirementId: id.split('/')[0]!, layer: 'I', required: true, acceptance: 'behavior', suite: 'storage', source: `formal-e2e-coverage/${id.split('/')[0]!}`, outputs: [
    { kind: 'http', ...na('service-and-adapter-boundary-no-gateway') }, { kind: 'dynamodb', assertions }, { kind: 's3', ...na('image-bytes-counted-in-owner-state') }, { kind: 'logs', ...na('handler-boundary-no-delivery') },
  ] };
}
const ifMatchCases: [string, string[]][] = [['missing-if-match', ['428-precondition-required']], ['weak-if-match', ['422-invalid-if-match']], ['star-if-match', ['422-invalid-if-match']], ['list-if-match', ['422-invalid-if-match']], ['same-revision-other-hash', ['412-precondition-failed']], ['sequential-stale', ['412-precondition-failed']]];
export const storageDefinitions: CaseDefinition[] = [
  storeCase('STORE-01/exact-etag-and-headers', ['create-etag-is-rn-sha256-of-raw-bytes', 'get-same-bytes-and-etag', 'item-headers-no-transform-no-store', 'patch-etag-is-r2-sha256-of-raw-bytes', 'readonly-dto-fields-refused-etag-unchanged'], ['stored-row-matches-dto-and-etag-revision'], ['no-image-versions-added'], ['create-result-delivered', 'get-result-delivered', 'patch-result-delivered', 'readonly-result-delivered']),
  ...['patch', 'delete'].flatMap(op => ifMatchCases.map(([label, status]) => storeCase(`STORE-02/${op}-${label}`, [`${status[0]}`, 'current-get-same-bytes-and-etag', 'exact-if-match-control-200'], ['rejection-leaves-row-and-counters', 'control-changes-state-exactly-once'], ['no-image-versions-added'],
    ['create-result-delivered', ...(label === 'sequential-stale' ? ['stale-setup-result-delivered'] : []), 'rejection-result-delivered', 'current-get-result-delivered', 'control-result-delivered']))),
  storeCase('STORE-03/patch-patch', ['requests-overlapped-one-200-one-412', 'final-get-matches-winner'], ['revision-2-once-counter-unchanged-winner-fields'], ['image-versions-unchanged-by-race'], ['create-result-delivered', 'winner-result-delivered', 'loser-result-delivered', 'final-get-result-delivered']),
  storeCase('STORE-03/delete-delete', ['requests-overlapped-one-200-one-412-or-404', 'final-get-404'], ['one-tombstone-counters-decremented-once-job-retired-once'], ['image-versions-unchanged-by-race'], ['create-result-delivered', 'winner-result-delivered', 'loser-result-delivered', 'final-get-result-delivered']),
  storeCase('STORE-03/patch-delete', ['requests-overlapped-one-200-one-412-or-404', 'final-get-matches-winner'], ['one-winner-state-counters-and-job-consistent'], ['image-versions-unchanged-by-race'], ['create-result-delivered', 'winner-result-delivered', 'loser-result-delivered', 'final-get-result-delivered']),
  storeCase('STORE-04/same-id-create', ['requests-overlapped-one-201-one-409', 'winner-readback-matches'], ['one-row-winner-fields-counter-1'], ['no-image-versions-added'], ['winner-result-delivered', 'loser-result-delivered', 'readback-result-delivered']),
  storeCase('STORE-04/different-item-patch', ['requests-overlapped-both-200', 'both-readbacks-match'], ['both-rows-revision-2-counter-unchanged'], ['no-image-versions-added'], ['create-x-result-delivered', 'create-y-result-delivered', 'patch-x-result-delivered', 'patch-y-result-delivered', 'readback-x-result-delivered', 'readback-y-result-delivered']),
  storeCase('STORE-04/resend-create', ['first-create-201', 'resend-409-already-exists'], ['resend-leaves-row-and-counter-unchanged'], ['no-image-versions-added'], ['create-result-delivered', 'resend-result-delivered']),
  storeCase('STORE-04/resend-delete', ['first-delete-200', 'resend-404-not-found'], ['resend-leaves-tombstone-and-counter-unchanged'], ['no-image-versions-added'], ['create-result-delivered', 'delete-result-delivered', 'resend-result-delivered']),
  storeCase('STORE-05/lifecycle-tombstone', ['get-200-then-delete-200-exact-body', 'get-after-delete-404', 'list-excludes-tombstone', 'recreate-409'], ['exact-tombstone-fields-counter-decremented-other-item-unchanged'], ['no-image-versions-added'],
    ['create-x-result-delivered', 'create-y-result-delivered', 'get-result-delivered', 'delete-result-delivered', 'get-404-result-delivered', 'list-result-delivered', 'recreate-result-delivered']),
  storeCase('STORE-05/delete-with-image', ['create-with-thumbnail-201', 'delete-200', 'get-after-delete-404', 'thumbnail-url-after-delete-404'], ['tombstone-without-image-ref-counters-zero-job-retired'], ['image-version-retained-immediately-after-delete'], ['create-result-delivered', 'delete-result-delivered', 'get-404-result-delivered', 'thumbnail-404-result-delivered']),
  storeCase('API-14/rate-boundary-seeded', ['request-at-119-is-200', 'second-token-request-121-is-429-retry-after-matches-body', 'window-not-crossed'], ['seeded-119-exact-expires-at-then-120-held', 'rate-requests-leave-reminders-unchanged'], ['no-image-versions-added'], ['request-120-result-delivered', 'request-121-result-delivered']),
  storeInt('STORE-03/both-read-old-i', ['patch-patch-one-success-one-412', 'delete-delete-one-success-one-412', 'patch-delete-either-order-one-winner', 'delete-before-read-answers-404', 'gate-holds-both-reads-before-commit']),
  storeInt('STORE-04/create-race-i', ['same-id-one-201-one-409', 'different-items-both-retained']),
  storeInt('STORE-06/items-1000-boundary-i', ['1000th-succeeds-1001st-413-non-growth-allowed']),
  storeInt('STORE-06/items-1000-concurrent-i', ['two-creates-from-999-one-success-one-413']),
  storeInt('STORE-06/items-1000-delete-recovery-i', ['delete-at-cap-frees-exactly-one-slot']),
  storeInt('STORE-06/image-128mib-boundary-i', ['exactly-134217728-succeeds-one-more-byte-413']),
  storeInt('STORE-06/image-128mib-concurrent-i', ['two-1mib-creates-one-success-one-413-one-committed-job']),
  storeInt('STORE-06/image-128mib-delete-recovery-i', ['delete-returns-bytes-and-allows-new-image']),
];
definitions.push(...storageDefinitions);

/**
 * Original-image cases (IMG-01..IMG-09). Each E case owns its synthetic users (own RATE, storage and owned S3 prefix) and starts from
 * a fresh owner; there are no dependency groups. IMG-08 is an offline I case (named tests/runtime tests), IMG-09 is the conditional
 * signature-enforcement compatibility probe that cannot run until the settings gate passes and is never recorded as pass by a valid GET.
 */
function imgCase(id: string, http: string[], ddb: string[], s3: string[], logs: string[]): CaseDefinition {
  return { id, requirementId: id.split('/')[0]!, layer: 'E', required: true, acceptance: 'behavior', suite: 'images', source: `formal-e2e-coverage/${id.split('/')[0]!}`, outputs: [
    { kind: 'http', assertions: http }, { kind: 'dynamodb', assertions: ddb }, { kind: 's3', assertions: s3 }, { kind: 'logs', assertions: logs },
  ] };
}
const imageAccepted = (id: string): CaseDefinition => imgCase(id, ['created-201-metadata-only-dto', 'readback-identical-bytes-etag', 'no-secret-fields-in-dto'], ['stored-ref-metadata-and-no-bytes', 'counters-and-committed-job-exact'], ['original-bytes-mime-length-checksum-version-exact', 'owned-key-single-version-no-marker'], ['create-result-delivered', 'readback-result-delivered']);
const imageNone = (id: string): CaseDefinition => imgCase(id, ['created-201-thumbnail-null', 'readback-identical-bytes-etag'], ['row-thumbnail-null-counters-no-job'], ['no-owned-image-version'], ['create-result-delivered', 'readback-result-delivered']);
const imageRejected = (id: string): CaseDefinition => imgCase(id, ['rejected-as-expected', 'body-within-json-limit', 'valid-control-200-empty-list'], ['no-row-no-job-counters-unchanged'], ['no-owned-image-version'], ['rejection-result-delivered', 'control-result-delivered']);
const imageRefusedUrl = (id: string, logs: string[]): CaseDefinition => imgCase(id, ['404-expected-code-no-url-field', 'control-200'], ['storage-jobs-rows-unchanged'], ['owned-versions-unchanged'], logs);
const imageClear = (id: string): CaseDefinition => imgCase(id, ['patch-200-thumbnail-null-revision-2', 'thumbnail-url-404-thumbnail-not-found'], ['image-ref-removed-job-retired-due-plus-24h-counter-zero'], ['original-version-retained-bytes-intact'], ['create-result-delivered', 'patch-result-delivered', 'url-result-delivered']);
export const imageDefinitions: CaseDefinition[] = [
  ...(['png', 'jpeg', 'gif', 'webp'] as const).flatMap(format => [`IMG-01/${format}-base64`, `IMG-01/${format}-dataurl`].map(imageAccepted)),
  ...['IMG-01/null', 'IMG-01/empty', 'IMG-01/omitted'].map(imageNone),
  ...['bad-alphabet', 'bad-pad-bits', 'bad-padding', 'bad-length', 'mime-mismatch', 'unsupported-mime', 'not-an-image', 'missing-base64-marker'].map(label => imageRejected(`IMG-02/${label}`)),
  imageAccepted('IMG-03/bytes-1048575'), imageAccepted('IMG-03/bytes-1048576'), imageRejected('IMG-03/bytes-1048577'),
  imgCase('IMG-04/issue-and-fetch', ['issue-200-no-store-no-etag-dto', 'expires-900-and-expires-at', 'get-original-bytes-no-bearer', 'item-body-and-etag-unchanged', 'reissue-same-image'], ['row-job-counters-unchanged-by-issue'], ['url-pins-owned-key-and-version', 'original-version-unchanged'],
    ['create-result-delivered', 'item-get-before-result-delivered', 'url-result-delivered', 'reissue-result-delivered', 'item-get-after-result-delivered']),
  imageRefusedUrl('IMG-05/other-owner', ['create-result-delivered', 'refusal-result-delivered', 'control-result-delivered']),
  imageRefusedUrl('IMG-05/no-image', ['create-result-delivered', 'refusal-result-delivered', 'control-result-delivered']),
  imageRefusedUrl('IMG-05/deleted-item', ['create-result-delivered', 'delete-result-delivered', 'refusal-result-delivered', 'control-result-delivered']),
  imgCase('IMG-06/replace', ['patch-200-new-thumbnail-metadata-revision-2', 'get-current-reference-matches-patch', 'url-serves-new-original-bytes'], ['new-committed-old-retired-due-plus-24h', 'row-reference-and-counter-delta'], ['both-versions-retained-original-bytes'], ['create-result-delivered', 'patch-result-delivered', 'get-result-delivered', 'url-result-delivered']),
  imgCase('IMG-06/omit-keeps', ['patch-200-thumbnail-unchanged-revision-2'], ['image-ref-job-and-counter-unchanged'], ['no-new-version-original-bytes-intact'], ['create-result-delivered', 'patch-result-delivered']),
  imageClear('IMG-06/clear-null'), imageClear('IMG-06/clear-empty'),
  imgCase('IMG-06/delete', ['delete-200-exact-body', 'thumbnail-url-404-reminder-not-found'], ['tombstone-job-retired-due-plus-24h-counters-zero'], ['original-version-retained-bytes-intact'], ['create-result-delivered', 'delete-result-delivered', 'url-result-delivered']),
  imgCase('IMG-07/duplicate-id-with-image', ['409-already-exists', 'original-get-bytes-and-etag-unchanged'], ['original-row-counters-and-committed-job-unchanged', 'one-new-pending-orphan-job-due-plus-24h-unique-key'], ['orphan-version-holds-new-original-bytes-original-retained'], ['create-result-delivered', 'duplicate-result-delivered', 'get-result-delivered']),
  imgCase('IMG-07/duplicate-after-delete', ['409-already-exists', 'get-still-404'], ['original-row-counters-and-committed-job-unchanged', 'one-new-pending-orphan-job-due-plus-24h-unique-key'], ['orphan-version-holds-new-original-bytes-original-retained'], ['create-result-delivered', 'delete-result-delivered', 'duplicate-result-delivered', 'get-404-result-delivered']),
  { id: 'IMG-08/pending-and-unknown-results-i', requirementId: 'IMG-08', layer: 'I', required: true, acceptance: 'behavior', suite: 'images', source: 'formal-e2e-coverage/IMG-08', outputs: [
    { kind: 'http', assertions: [], notApplicableReason: 'service-and-adapter-boundary-no-gateway' },
    { kind: 'dynamodb', assertions: ['s3_success_db_reject_leaves_pending', 'unknown_put_result_leaves_unique_pending_key', 'unknown_commit_failed_reconciliation_keeps_committed_image', 'expired_budget_after_put_leaves_unrecorded_pending_without_transaction'] },
    { kind: 's3', assertions: [], notApplicableReason: 'injected-adapter-no-real-service-stop' }, { kind: 'logs', assertions: [], notApplicableReason: 'handler-boundary-no-delivery' },
  ] },
  { id: 'IMG-09/signature-enforcement', requirementId: 'IMG-09', layer: 'L', required: true, acceptance: 'compatibility', suite: 'images', source: 'formal-e2e-coverage/IMG-09', outputs: [
    { kind: 'http', assertions: ['control-get-measured', 'signature-tamper-measured', 'expired-url-measured'] },
    { kind: 'dynamodb', assertions: [], notApplicableReason: 'direct-s3-request-no-storage-effect' },
    { kind: 's3', assertions: ['owned-key-version-pinned-independent-short-url'] }, { kind: 'logs', assertions: [], notApplicableReason: 'direct-s3-request-no-api-result' },
  ] },
];
definitions.push(...imageDefinitions);

/**
 * Real cleanup (CLEAN-01..09). The E cases drive the same-ZIP cleanup alias through synchronous invokes against owned synthetic
 * data: API registration, delete/replace, synthetic times and the invoke are one case where an API transition exists. The I cases are
 * evidenced by named offline tests (fault transport over the real adapters, runtime limits) and are never an E action.
 */
function cleanCase(id: string, http: string[], ddb: string[], s3: string[], logs: string[], logsNa?: string): CaseDefinition {
  return { id, requirementId: id.split('/')[0]!, layer: 'E', required: true, acceptance: 'behavior', suite: 'cleanup', source: `formal-e2e-coverage/${id.split('/')[0]!}`, outputs: [
    { kind: 'http', assertions: http }, { kind: 'dynamodb', assertions: ddb }, { kind: 's3', assertions: s3 }, logs.length ? { kind: 'logs', assertions: logs } : { kind: 'logs', assertions: [], notApplicableReason: logsNa! },
  ] };
}
const orphanApi = ['create-result-delivered', 'duplicate-result-delivered'];
const published = (...extra: string[]): string[] => [...orphanApi, ...extra, 'delivered'];
const invokeOk = (counts: string): string => `invoke-200-no-function-error-${counts}`;
function cleanInteg(id: string, tests: string[]): CaseDefinition {
  const na = (reason: string) => ({ assertions: [] as string[], notApplicableReason: reason });
  return { id, requirementId: id.split('/')[0]!, layer: 'I', required: true, acceptance: 'behavior', suite: 'cleanup', source: `formal-e2e-coverage/${id.split('/')[0]!}`, outputs: [
    { kind: 'http', ...na('service-and-adapter-boundary-no-gateway') }, { kind: 'dynamodb', assertions: tests }, { kind: 's3', ...na('injected-wire-fake-no-real-service-stop') }, { kind: 'logs', ...na('handler-boundary-no-delivery') },
  ] };
}
export const cleanupDefinitions: CaseDefinition[] = [
  cleanCase('CLEAN-01/unpublished', [invokeOk('skipped-unpublished'), 'skipped-unpublished-evaluated0-deletes0'], ['jobs-and-counters-unchanged', 'checkpoint-not-written'], ['owned-versions-unchanged-no-marker'], published()),
  cleanCase('CLEAN-01/published-counts', [invokeOk('counts-1-1'), 'item-get-unchanged-after-cleanup'], ['due-orphan-done-committed-unchanged', 'checkpoint-saved-without-gsi-attributes'], ['marker-added-original-version-retained'], published('get-result-delivered')),
  cleanCase('CLEAN-01/event-injection', ['every-injected-event-function-error-behind-200', 'control-event-processed-200-one-delete'], ['rejected-events-leave-all-rows-unchanged', 'control-completes-only-owned-orphan'], ['rejected-events-add-no-marker', 'control-marker-added-original-version-retained'], ['delivered']),
  cleanCase('CLEAN-02/pending-24h-both-sides', [invokeOk('counts-1-1'), 'committed-item-get-unchanged'], ['due-orphan-done-not-due-orphan-and-committed-unchanged'], ['only-due-orphan-marked-all-versions-retained'], [...orphanApi, 'duplicate-late-result-delivered', 'get-result-delivered', 'delivered']),
  cleanCase('CLEAN-02/retired-origin-replace', ['both-replaces-200-and-retire-24h-after-transition', invokeOk('counts-1-1')], ['future-retired-kept-despite-old-creation-due-retired-done-new-images-unchanged'], ['only-due-retired-marked-all-versions-retained'], ['create-a-result-delivered', 'patch-a-result-delivered', 'create-b-result-delivered', 'patch-b-result-delivered', 'delivered']),
  cleanCase('CLEAN-02/delete-tombstone', ['delete-200-then-get-404-after-cleanup', invokeOk('counts-1-1')], ['tombstone-job-done-counters-zero-row-deleted'], ['current-get-404-original-version-get-200-one-marker'], ['create-result-delivered', 'delete-result-delivered', 'get-404-result-delivered', 'delivered']),
  cleanCase('CLEAN-03/active-lease', [invokeOk('counts-0-0')], ['active-lease-job-unchanged'], ['no-marker-current-object-intact'], published()),
  cleanCase('CLEAN-03/expired-lease', [invokeOk('counts-1-1')], ['expired-lease-reclaimed-to-done-lease-removed'], ['marker-added-original-version-retained'], published()),
  cleanCase('CLEAN-03/unrecorded-version', [invokeOk('counts-1-1')], ['unrecorded-pending-done-without-version-pin'], ['key-reconciled-marker-added-original-version-retained'], published()),
  cleanCase('CLEAN-04/committed-protected', [invokeOk('counts-1-1'), 'item-get-and-thumbnail-url-still-served'], ['committed-job-and-counters-unchanged-orphan-done'], ['committed-current-bytes-exact-orphan-marked-only'], [...orphanApi, 'get-result-delivered', 'url-result-delivered', 'delivered']),
  cleanCase('CLEAN-05/version-mismatch', [invokeOk('counts-1-0')], ['mismatched-version-job-left-leased-not-done'], ['no-marker-current-object-intact'], ['delivered']),
  cleanCase('CLEAN-05/checksum-mismatch', [invokeOk('counts-1-0')], ['mismatched-checksum-job-left-leased-not-done'], ['no-marker-current-object-intact'], ['delivered']),
  cleanCase('CLEAN-05/existing-marker-and-absent', [invokeOk('counts-2-0')], ['marker-and-absent-jobs-converge-to-done'], ['no-new-marker-no-version-deleted-original-readable'], ['delivered']),
  cleanCase('CLEAN-06/same-shard-51-two-invokes', [invokeOk('counts-51-51'), 'second-invoke-no-delete-200'], ['all-51-done-checkpoint-without-gsi-attributes-rotation-reset'], ['51-markers-one-each-51-versions-retained-second-invoke-adds-none'], ['delivered', 'delivered-2']),
  cleanCase('CLEAN-09/second-invoke-converges', ['both-invokes-synchronous-200-no-function-error', 'second-invoke-no-delete'], ['job-done-and-unchanged-by-second-invoke'], ['one-marker-total-original-version-retained'], published('delivered-2')),
  cleanInteg('CLEAN-02/exact-boundary-i', ['clean_02_pending_due_exactly_at_created_plus_24h']),
  cleanInteg('CLEAN-03/exact-lease-boundary-i', ['clean_03_deleting_lease_reclaimed_at_expiry_and_new_lease_20_minutes']),
  cleanInteg('CLEAN-04/stale-gsi-and-claim-race-i', ['clean_04_stale_gsi_rows_skipped_without_claim_or_delete', 'clean_04_upload_during_claim_race_is_protected', 'stale_index_and_commit_race_cannot_delete']),
  cleanInteg('CLEAN-07/page-abort-resume-i', ['clean_07_abort_mid_page_keeps_page_start_cursor_and_resume_has_one_marker_each', 'partial_page_replays_without_skipping', 'late_gsi_candidate_is_seen_next_invocation_after_partition_end']),
  cleanInteg('CLEAN-08/limits-and-resume-i', ['clean_08_runtime_limit_tests_retained_by_name', 'clean_08_600_second_cap_stops_new_work_then_later_invoke_finishes', 'limits_candidates_deletes_time_and_parallelism']),
  cleanInteg('CLEAN-09/fault-matrix-i', ['clean_09_marker_with_lost_response_found_by_head_not_repeated', 'clean_09_delete_never_sent_retried_once_with_one_marker', 'clean_09_checkpoint_failure_fails_invocation_without_heartbeat', 'clean_09_metric_failure_fails_invocation_after_checkpoint_saved', 'clean_09_heartbeat_only_after_saved_checkpoint_and_completed_run', 'no_permanent_version_delete_and_trace_can_see_one', 'unknown_claim_and_complete_outcomes_are_reconciled']),
];
definitions.push(...cleanupDefinitions);

/**
 * Cases whose result the runner records itself because it may be `unsupported` (compatibility acceptance): the probe returns the
 * measured outcome and the runner maps it. The matching caseActions entry only makes the case selectable; it is never run through runCase.
 */
export type MeasuredOutcome = 'pass' | 'unsupported' | 'fail';
export const caseMeasurements = new Map<string, (fixture: import('./types.ts').SuiteFixture) => Promise<MeasuredOutcome | { outcome: MeasuredOutcome; httpStatus: number }>>();
/** Fixed evidence reason of a measurement that ends unsupported; the default is signature-enforcement-unsupported. */
export const measurementUnsupportedReasons = new Map<string, 'hosted-revoke-unsupported'>([['AUTH-11/hosted-revoke-endpoint', 'hosted-revoke-unsupported']]);
/** A guard returns true when a prerequisite case has not passed; the runner then records not-run. */
export const caseGuards = new Map<string, (fixture: import('./types.ts').SuiteFixture) => boolean>();
/**
 * Auth/isolation key of a case. Every case gets its own synthetic users A/B (its own RATE and data) except cases inside an
 * explicit dependency group, which must see the same data: the CRUD life cycle, the owner-B pagination chain, and the ownership pair.
 */
const authGroups = new Map<string, string>([
  ...apiDefinitions.filter(def => def.id.startsWith('API-04/')).map(def => [def.id, 'API-group-04'] as const),
  ...apiDefinitions.filter(def => def.id.startsWith('API-05/')).map(def => [def.id, 'API-group-05'] as const),
  ...apiDefinitions.filter(def => ['API-12/seed-51', 'API-12/default', 'API-12/limit-1', 'API-12/limit-20', 'API-12/limit-50', 'API-12/walk-limit-20', 'API-12/walk-limit-7'].includes(def.id) || def.id.startsWith('API-13/tombstone')).map(def => [def.id, 'API-group-12-13'] as const),
]);
export function caseAuthId(def: { id: string; suite: string }): string { return def.suite === 'api' ? authGroups.get(def.id) ?? def.id : def.id; }
