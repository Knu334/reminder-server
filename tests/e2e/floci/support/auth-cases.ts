import { randomBytes } from 'node:crypto';
import { caseActions, definitions } from './cases.ts';
import { tamperSignature } from './auth.ts';
import { fixtureState } from './fixture.ts';
import { snapshotOwnedStorage } from './storage.ts';
import type { AuthSession, CaseRecorder, HttpResult, LogExpectation, OutputKind, SuiteFixture } from './types.ts';

const LIST = '/v2/reminders'; const READ = 'reminder-api/read'; const WRITE = 'reminder-api/write';
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
/** Every individual sleep stays at or below 30 seconds. */
async function waitUntil(epochMs: number): Promise<void> { for (let left = epochMs - Date.now(); left > 0; left = epochMs - Date.now()) await sleep(Math.min(30_000, left)); }

/** Collects named boolean assertions; only names, never values, reach evidence. */
class Score {
  private readonly results = new Map<string, boolean>();
  ok(kind: OutputKind, name: string, value: boolean): void { const key = `${kind}:${name}`; this.results.set(key, (this.results.get(key) ?? true) && value); }
  emit(caseId: string, recorder: CaseRecorder): void {
    const def = definitions.find(item => item.id === caseId)!; let failed = false;
    for (const output of def.outputs) {
      if (output.assertions.length === 0) { recorder.recordOutput({ kind: output.kind, status: 'not-applicable', assertions: [], reason: output.notApplicableReason! }); continue; }
      if (output.kind === 'logs') continue; // Delivery results come from the shared observer flush.
      const assertions = output.assertions.map(name => ({ name, status: this.results.get(`${output.kind}:${name}`) === true ? 'pass' as const : 'fail' as const }));
      const status = assertions.every(item => item.status === 'pass') ? 'pass' as const : 'fail' as const; failed ||= status === 'fail';
      recorder.recordOutput({ kind: output.kind, status, assertions });
    }
    if (failed) throw new Error('AUTH_ASSERTION_FAILED');
  }
}
const requestId = (response: HttpResult) => response.headers.get('x-request-id') ?? response.headers.get('apigw-requestid') ?? response.headers.get('x-amzn-requestid');
const rejected = (result: { status: number; error?: string }, errors = ['invalid_grant', 'invalid_request']) => result.status === 400 && errors.includes(result.error ?? '');
const scopeSet = (session: AuthSession) => session.claims.scope.split(/\s+/).filter(Boolean).sort().join(' ');
const sameGrant = (a: AuthSession, b: AuthSession) => a.claims.iss === b.claims.iss && a.claims.sub === b.claims.sub && a.claims.client_id === b.claims.client_id && scopeSet(a) === scopeSet(b);

/** A real signed-token GET 200 whose API result delivery is later required. */
async function valid(fixture: SuiteFixture, token: string): Promise<LogExpectation> {
  const since = Date.now(); const response = await fixture.request(LIST, { token }); const until = Date.now(); const id = requestId(response);
  if (response.status !== 200 || !id) throw new Error('AUTH_CONTROL_FAILED');
  return { service: 'api', requestId: id, since, until, status: 200, mode: 'present' };
}
type Refusal = { token?: string; method?: string; body?: string; status: number; http: string; log: string };
/** Valid control, refusal, valid control. Storage is compared immediately around each refusal, excluding the controls. */
async function refusals(fixture: SuiteFixture, recorder: CaseRecorder, score: Score, caseId: string, controlToken: string, items: Refusal[]): Promise<void> {
  let before = await valid(fixture, controlToken);
  for (const item of items) {
    await sleep(2); const stored = await snapshotOwnedStorage(fixture); const since = Date.now(); // strict ordering against the controls needs distinct milliseconds
    const response = await fixture.request(LIST, { ...(item.token ? { token: item.token } : {}), ...(item.method ? { method: item.method } : {}), ...(item.body !== undefined ? { body: item.body, headers: { 'content-type': 'application/json' } } : {}) });
    const until = Date.now(); const unchanged = stored === await snapshotOwnedStorage(fixture); await sleep(2);
    recorder.recordInput({ httpStatus: response.status });
    score.ok('http', item.http, response.status === item.status); score.ok('dynamodb', 'refusal-owner-rate-storage-unchanged', unchanged); score.ok('s3', 'refusal-image-versions-unchanged', unchanged);
    const after = await valid(fixture, controlToken);
    recorder.deferLogs({ caseId, assertion: item.log, expectation: { service: 'api', requestId: requestId(response) ?? 'uncorrelated-gateway-refusal', since, until, status: item.status, mode: 'absent' }, controls: { before, after } });
    before = after;
  }
  score.ok('http', 'valid-controls-200', true);
}

// A token issued at suite start so AUTH-06 only waits out the remainder of its real 300 second life.
const aging = new WeakMap<object, Promise<AuthSession>>();
function ensureAging(fixture: SuiteFixture): Promise<AuthSession> { const key = fixtureState(fixture); let current = aging.get(key); if (!current) { current = fixture.auth.login('a', [READ], 'primary'); aging.set(key, current); } return current; }

const run = (id: string, body: (fixture: SuiteFixture, recorder: CaseRecorder, score: Score) => Promise<void>) => caseActions.set(id, async (fixture, recorder) => {
  const score = new Score(); await ensureAging(fixture); await body(fixture, recorder, score); score.emit(id, recorder);
});

run('AUTH-01/pkce-login', async (fixture, recorder, score) => {
  const session = await fixture.auth.login('a', [READ], 'primary'); score.ok('http', 'hosted-ui-s256-code-exchange', true);
  let verified = true; try { fixture.auth.verifySession(session); } catch { verified = false; }
  score.ok('http', 'jwks-signature-iss-client-sub', verified && session.claims.iss === fixture.config.issuer && session.claims.client_id === fixture.config.clientId && session.claims.sub.length > 0);
  score.ok('http', 'access-lifetime-300s', session.claims.exp - session.claims.iat === 300);
  const control = await valid(fixture, session.accessToken); recorder.recordInput({ httpStatus: 200 }); score.ok('http', 'api-get-200', true);
  recorder.deferLogs({ caseId: 'AUTH-01/pkce-login', assertion: 'valid-get-result-delivered', expectation: control });
});

run('AUTH-02/pkce-negatives', async (fixture, recorder, score) => {
  const stored = await snapshotOwnedStorage(fixture);
  const fields = (flow: { code?: string; verifier: string; callback: string; clientId: string }) => ({ grant_type: 'authorization_code', client_id: flow.clientId, redirect_uri: flow.callback, code: flow.code ?? '', code_verifier: flow.verifier });
  const issue = async (method?: 'plain') => { const flow = await fixture.auth.authorize('a', [READ], 'primary', method ? { challengeMethod: method } : {}); return flow; };
  let flow = await issue(); const wrong = await fixture.auth.exchangeCode({ ...fields(flow), code_verifier: randomBytes(48).toString('base64url') }); score.ok('http', 'wrong-verifier-rejected', !!flow.code && rejected(wrong));
  flow = await issue(); const { code_verifier: _omit, ...withoutVerifier } = fields(flow); void _omit; const missing = await fixture.auth.exchangeCode(withoutVerifier); score.ok('http', 'missing-verifier-rejected', !!flow.code && rejected(missing));
  flow = await issue(); const mismatch = await fixture.auth.exchangeCode({ ...fields(flow), redirect_uri: 'https://extension.example.test/other' }); score.ok('http', 'callback-mismatch-rejected', !!flow.code && rejected(mismatch));
  flow = await issue(); const first = await fixture.auth.exchangeCode(fields(flow)); const reused = await fixture.auth.exchangeCode(fields(flow)); score.ok('http', 'code-reuse-rejected', first.status === 200 && rejected(reused));
  flow = await issue('plain'); const plain = flow.code ? await fixture.auth.exchangeCode(fields(flow)) : { status: 400, error: 'invalid_request' }; score.ok('http', 'non-s256-rejected', rejected(plain));
  flow = await issue(); const control = await fixture.auth.exchangeCode(fields(flow)); score.ok('http', 'independent-valid-control-issued', control.status === 200 && !!control.session);
  recorder.recordInput({ httpStatus: control.status });
  const unchanged = stored === await snapshotOwnedStorage(fixture); score.ok('dynamodb', 'token-rejections-storage-unchanged', unchanged); score.ok('s3', 'token-rejections-image-versions-unchanged', unchanged);
});

run('AUTH-03/jwt-signature', async (fixture, recorder, score) => {
  const session = await fixture.auth.login('a', [READ], 'primary');
  await refusals(fixture, recorder, score, 'AUTH-03/jwt-signature', session.accessToken, [
    { status: 401, http: 'no-jwt-401', log: 'no-jwt-api-result-absent' },
    { token: tamperSignature(session.accessToken), status: 401, http: 'signature-only-tamper-401', log: 'signature-tamper-api-result-absent' },
  ]);
});

run('AUTH-04/sibling-client', async (fixture, recorder, score) => {
  const control = await fixture.auth.login('a', [READ], 'primary'); const sibling = await fixture.auth.login('a', [READ], 'sibling');
  await refusals(fixture, recorder, score, 'AUTH-04/sibling-client', control.accessToken, [{ token: sibling.accessToken, status: 401, http: 'same-pool-sibling-client-401', log: 'sibling-api-result-absent' }]);
});

run('AUTH-05/foreign-issuer', async (fixture, recorder, score) => {
  const control = await fixture.auth.login('a', [READ], 'primary'); const foreign = await fixture.auth.login('a', [READ], 'foreign');
  // The classification records whether the expected JWKS could reject this token by signature alone; issuer-only evidence is the separate I case.
  const verifiable = fixture.auth.verifiesAgainstPrimaryKeys(foreign); score.ok('http', 'foreign-key-composite-classification', typeof verifiable === 'boolean');
  await refusals(fixture, recorder, score, 'AUTH-05/foreign-issuer', control.accessToken, [{ token: foreign.accessToken, status: 401, http: 'foreign-pool-401', log: 'foreign-api-result-absent' }]);
});

run('AUTH-07/scope-and-id-token', async (fixture, recorder, score) => {
  const control = await fixture.auth.login('a', [READ], 'primary'); const readOnly = await fixture.auth.login('a', [READ], 'primary'); const writeOnly = await fixture.auth.login('a', [WRITE], 'primary');
  if (!control.idToken) throw new Error('AUTH_ID_TOKEN_MISSING');
  await refusals(fixture, recorder, score, 'AUTH-07/scope-and-id-token', control.accessToken, [
    { token: readOnly.accessToken, method: 'POST', body: '{}', status: 403, http: 'read-only-post-403', log: 'read-only-post-api-result-absent' },
    { token: writeOnly.accessToken, status: 403, http: 'write-only-get-403', log: 'write-only-get-api-result-absent' },
    { token: control.idToken, status: 403, http: 'id-token-403', log: 'id-token-api-result-absent' },
  ]);
});

run('AUTH-09/refresh-rotation', async (fixture, recorder, score) => {
  const original = await fixture.auth.login('a', [READ, WRITE], 'primary'); const rotated = await fixture.auth.requestRefresh(original.refreshToken, 'primary'); const next = rotated.session;
  score.ok('http', 'rotation-200', rotated.status === 200 && !!next); if (!next) { recorder.recordInput({ httpStatus: rotated.status }); score.emit('AUTH-09/refresh-rotation', recorder); return; }
  score.ok('http', 'new-refresh-token-differs', next.refreshToken !== original.refreshToken);
  let verified = true; try { fixture.auth.verifySession(next); } catch { verified = false; }
  score.ok('http', 'access-lifetime-300s', verified && next.claims.exp - next.claims.iat === 300);
  score.ok('http', 'grant-identity-scope-owner-preserved', sameGrant(original, next) && scopeSet(next).includes(READ) && scopeSet(next).includes(WRITE));
  const control = await valid(fixture, next.accessToken); recorder.recordInput({ httpStatus: 200 }); score.ok('http', 'renewed-api-get-200', true);
  recorder.deferLogs({ caseId: 'AUTH-09/refresh-rotation', assertion: 'renewed-get-result-delivered', expectation: control });
});

run('AUTH-10/rotation-grace', async (fixture, recorder, score) => {
  const original = await fixture.auth.login('a', [READ], 'primary'); const started = Date.now(); const first = await fixture.auth.requestRefresh(original.refreshToken, 'primary');
  if (first.status !== 200 || !first.session) throw new Error('AUTH_ROTATION_FAILED');
  await sleep(1_000); const inner = await fixture.auth.requestRefresh(original.refreshToken, 'primary');
  await sleep(5_000); const innerLate = await fixture.auth.requestRefresh(original.refreshToken, 'primary');
  score.ok('http', 'grace-inner-reuse-200', inner.status === 200 && innerLate.status === 200);
  // 11.5 seconds after the first rotation, but under 10 seconds after the last reuse: reuse must not have moved the start.
  await waitUntil(started + 11_500); const outer = await fixture.auth.requestRefresh(original.refreshToken, 'primary'); recorder.recordInput({ httpStatus: outer.status });
  score.ok('http', 'grace-start-not-extended-invalid-grant', rejected(outer, ['invalid_grant']));
  const descendant = await fixture.auth.requestRefresh(first.session.refreshToken, 'primary'); score.ok('http', 'descendant-refresh-200', descendant.status === 200);
});

run('AUTH-11/revoke-disable', async (fixture, recorder, score) => {
  const original = await fixture.auth.login('a', [READ], 'primary'); const rotated = await fixture.auth.requestRefresh(original.refreshToken, 'primary'); if (!rotated.session) throw new Error('AUTH_ROTATION_FAILED');
  await fixture.auth.revoke(original);
  const originalAfter = await fixture.auth.requestRefresh(original.refreshToken, 'primary'); const descendantAfter = await fixture.auth.requestRefresh(rotated.session.refreshToken, 'primary'); recorder.recordInput({ httpStatus: descendantAfter.status });
  score.ok('http', 'revoked-original-refresh-400', rejected(originalAfter, ['invalid_grant'])); score.ok('http', 'revoked-descendant-refresh-400', rejected(descendantAfter, ['invalid_grant']));
  const issued = await fixture.auth.login('b', [READ], 'primary'); await fixture.auth.disable('b');
  let loginRefused = false; try { await fixture.auth.login('b', [READ], 'primary'); } catch (error) { loginRefused = (error as Error).message === 'HOSTED_UI_FAILED'; }
  score.ok('http', 'disabled-user-login-refused', loginRefused);
  score.ok('http', 'disabled-user-refresh-refused', rejected(await fixture.auth.requestRefresh(issued.refreshToken, 'primary'), ['invalid_grant']));
});

run('AUTH-12/refresh-negatives', async (fixture, recorder, score) => {
  const session = await fixture.auth.login('a', [READ], 'primary');
  const missing = await fixture.auth.exchangeCode({ grant_type: 'refresh_token', client_id: fixture.config.clientId }); score.ok('http', 'missing-refresh-rejected', rejected(missing));
  const malformed = await fixture.auth.requestRefresh('malformed-refresh-token', 'primary'); score.ok('http', 'malformed-refresh-rejected', rejected(malformed, ['invalid_grant']));
  const sibling = await fixture.auth.requestRefresh(session.refreshToken, 'sibling'); recorder.recordInput({ httpStatus: sibling.status }); score.ok('http', 'sibling-client-refresh-rejected', rejected(sibling, ['invalid_grant']));
  const refreshed = await fixture.auth.requestRefresh(session.refreshToken, 'primary');
  score.ok('http', 'valid-refresh-control-200', refreshed.status === 200 && !!refreshed.session);
  score.ok('http', 'scope-not-expanded', !!refreshed.session && scopeSet(refreshed.session) === scopeSet(session) && !scopeSet(refreshed.session).includes(WRITE));
});

// Real expiry of a signed token issued by the first auth case; the longest waiting case runs last.
run('AUTH-06/token-expiry', async (fixture, recorder, score) => {
  const expiring = await ensureAging(fixture); const expiresAt = expiring.claims.exp * 1000;
  await waitUntil(expiresAt - 6_000); await valid(fixture, expiring.accessToken); score.ok('http', 'valid-before-expiry-200', true);
  await waitUntil(expiresAt + 3_000);
  const control = await fixture.auth.login('a', [READ], 'primary');
  await refusals(fixture, recorder, score, 'AUTH-06/token-expiry', control.accessToken, [{ token: expiring.accessToken, status: 401, http: 'expired-401', log: 'expired-api-result-absent' }]);
  const refreshed = await fixture.auth.refresh(expiring); await valid(fixture, refreshed.accessToken); score.ok('http', 'refreshed-token-200', true);
});
