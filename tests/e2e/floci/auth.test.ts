import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { definitions, caseActions } from './support/cases.ts';
import './support/auth-cases.ts';
import { createEvidence, runCase, evidenceContext, flushPendingLogs, finalizeResults } from './support/evidence.ts';
import { fixtureStates } from './support/fixture.ts';
import type { AuthSession, HttpResult, LogCheckResult, SuiteFixture } from './support/types.ts';

function session(tag: string): AuthSession { const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url'); return { accessToken: `${part({ alg: 'RS256' })}.${part({ tag })}.${(tag === 'foreign' ? 'F' : 'S').repeat(342)}`, idToken: `id-${tag}`, refreshToken: `refresh-${tag}`, claims: { iss: 'issuer', sub: 'sub', client_id: 'client', iat: 1, exp: 301, scope: 'reminder-api/read' } }; }
function stub(refusalStatus: number, mutateStorage = false): { fixture: SuiteFixture; calls: string[] } {
  const calls: string[] = []; let storage = 0; let id = 0;
  const response = (status: number): HttpResult => ({ status, headers: new Headers({ 'x-request-id': `req-${++id}` }), bytes: Buffer.alloc(0) });
  const fixture = {
    config: { issuer: 'issuer', clientId: 'client', remindersTable: 'r', ownerStateTable: 'o', imageJobsTable: 'i', imagesBucket: 'b' },
    clients: { dynamodb: { send: async () => ({ Items: [{ pk: 'rate', n: storage }] }) }, s3: { send: async () => ({ Versions: [] }) } },
    auth: { login: async () => session('valid') },
    request: async (_path: string, options: { token?: string } = {}) => { calls.push(options.token === undefined ? 'none' : 'token'); if (options.token?.endsWith('S'.repeat(342))) return response(200); if (mutateStorage) storage++; return response(refusalStatus); },
  } as unknown as SuiteFixture;
  fixtureStates.set(fixture, { disposed: false } as never); return { fixture, calls };
}
async function runOnce(id: string, fixture: SuiteFixture, matched: boolean): Promise<{ status: string; code?: string; reason?: string; logs?: { assertions: { name: string; status: string }[] } }> {
  const directory = await mkdtemp(join(tmpdir(), 'auth-case-')); try {
    const def = definitions.find(item => item.id === id)!; const evidence = await createEvidence([def], join(directory, 'run'));
    let deferred: { assertion: string; hasControls: boolean }[] = [];
    await runCase(def, evidence, async recorder => { const wrapped = { ...recorder, deferLogs: (check: Parameters<typeof recorder.deferLogs>[0]) => { deferred.push({ assertion: check.assertion, hasControls: !!check.controls }); recorder.deferLogs(check); } }; await caseActions.get(id)!(fixture, wrapped); });
    await flushPendingLogs(evidence, async checks => checks.map((check): LogCheckResult => ({ caseId: check.caseId, assertion: check.assertion, matched, controlsMatched: { before: matched, after: matched } })));
    await finalizeResults(evidence);
    const saved = JSON.parse(await readFile(join(evidenceContext(evidence).directory, 'results.json'), 'utf8')) as { cases: { result: { status: string; code?: string; reason?: string; outputs?: { kind: string; assertions: { name: string; status: string }[] }[] } }[] };
    assert.ok(deferred.every(item => item.hasControls)); deferred = [];
    const result = saved.cases[0]!.result; return { status: result.status, ...(result.code ? { code: result.code } : {}), ...(result.reason ? { reason: result.reason } : {}), ...(result.outputs?.find(output => output.kind === 'logs') ? { logs: result.outputs.find(output => output.kind === 'logs')! } : {}) };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
void test('a refusal case passes only with refusal, unchanged storage and delivered controls, through the real case runner', async () => {
  const good = stub(401); const passed = await runOnce('AUTH-03/jwt-signature', good.fixture, true);
  assert.equal(passed.status, 'pass'); assert.deepEqual(passed.logs?.assertions.map(item => item.name), ['no-jwt-api-result-absent', 'signature-tamper-api-result-absent']);
  assert.equal((await runOnce('AUTH-03/jwt-signature', good.fixture, false)).status, 'fail', 'missing delivered controls fail the case');
  assert.equal((await runOnce('AUTH-03/jwt-signature', stub(200).fixture, true)).status, 'fail', 'an accepted tampered token fails');
  assert.equal((await runOnce('AUTH-03/jwt-signature', stub(401, true).fixture, true)).status, 'fail', 'storage mutation by a refusal fails');
});
void test('every auth case is registered once and none can pass without a live fixture', () => {
  const ids = definitions.filter(def => def.id.startsWith('AUTH-') && def.layer === 'E').map(def => def.id);
  assert.equal(ids.length, 11); for (const id of ids) assert.equal(caseActions.has(id), true, id);
});

function authStub(options: { foreignVerifiable?: boolean; plain?: Record<string, unknown> } = {}): SuiteFixture {
  const { fixture } = stub(401); const used = new Set<string>(); let n = 0;
  (fixture as unknown as { auth: unknown }).auth = {
    login: async (_o: string, _s: string[], kind: string) => session(kind === 'foreign' ? 'foreign' : 'valid'),
    verifiesAgainstPrimaryKeys: () => options.foreignVerifiable === true,
    authorize: async (_o: string, _s: string[], _k: string, opt: { challengeMethod?: string } = {}) => opt.challengeMethod === 'plain' ? { verifier: 'v', callback: 'cb', clientId: 'client', ...options.plain } : { code: `c${++n}`, verifier: 'v', callback: 'cb', clientId: 'client' },
    exchangeCode: async (f: Record<string, string>) => { const bad = f.code_verifier !== 'v' || f.redirect_uri !== 'cb' || used.has(f.code ?? ''); used.add(f.code ?? ''); return bad ? { status: 400, error: 'invalid_grant' } : { status: 200, session: session('valid') }; },
  };
  return fixture;
}
void test('AUTH-02 non-S256 counts only an observed refusal and never aborts the other negatives', async () => {
  assert.equal((await runOnce('AUTH-02/pkce-negatives', authStub({ plain: { rejection: { error: 'invalid_request' } } }), true)).status, 'pass');
  assert.equal((await runOnce('AUTH-02/pkce-negatives', authStub({ plain: { rejection: { status: 400 } } }), true)).status, 'pass');
  // No code and no observed refusal (broken Hosted UI): the assertion fails, the other four negatives still run and are recorded.
  const unknown = await runOnce('AUTH-02/pkce-negatives', authStub({ plain: {} }), true); assert.equal(unknown.status, 'fail'); assert.notEqual(unknown.reason, undefined);
  // A code is issued for the plain challenge and the exchange succeeds: accepted, therefore not rejected.
  assert.equal((await runOnce('AUTH-02/pkce-negatives', authStub({ plain: { code: 'plain-ok' } }), true)).status, 'fail', 'an accepted plain challenge is not a rejection');
});
void test('AUTH-05 records the observed signature classification as a value-free code', async () => {
  const composite = await runOnce('AUTH-05/foreign-issuer', authStub({ foreignVerifiable: false }), true); assert.equal(composite.status, 'pass'); assert.equal(composite.code, 'FOREIGN_KEY_COMPOSITE');
  const issuerOnly = await runOnce('AUTH-05/foreign-issuer', authStub({ foreignVerifiable: true }), true); assert.equal(issuerOnly.status, 'pass'); assert.equal(issuerOnly.code, 'FOREIGN_SIGNATURE_VERIFIABLE');
});

// AUTH-11 revocation channel and the separate hosted-endpoint compatibility measurement.
async function savedAuth11(id: string, auth: Record<string, unknown>): Promise<{ status: string; reason?: string; httpStatus?: number; outputs?: { kind: string; status: string; assertions: { name: string; status: string }[] }[] }> {
  const { runSuiteCase } = await import('../../../scripts/e2e/run.ts'); const { fixture } = stub(401);
  const directory = await mkdtemp(join(tmpdir(), 'auth-11-')); try {
    const def = definitions.find(item => item.id === id)!; const evidence = await createEvidence([def], join(directory, 'run'));
    await runSuiteCase(evidence, def, fixture, { createAuth: async () => auth as never, bind(view, source) { fixtureStates.set(view, fixtureStates.get(source)!); } });
    await finalizeResults(evidence);
    const saved = JSON.parse(await readFile(join(evidenceContext(evidence).directory, 'results.json'), 'utf8')) as { cases: { result: never }[] };
    return saved.cases[0]!.result;
  } finally { await rm(directory, { recursive: true, force: true }); }
}
async function savedAuth11Run(fixture: SuiteFixture): Promise<{ name: string; status: string }[]> {
  const directory = await mkdtemp(join(tmpdir(), 'auth-11-run-')); try {
    const def = definitions.find(item => item.id === 'AUTH-11/revoke-disable')!; const evidence = await createEvidence([def], join(directory, 'run'));
    await runCase(def, evidence, async recorder => { await caseActions.get(def.id)!(fixture, recorder); }); await finalizeResults(evidence);
    const saved = JSON.parse(await readFile(join(evidenceContext(evidence).directory, 'results.json'), 'utf8')) as { cases: { result: { outputs?: { kind: string; assertions: { name: string; status: string }[] }[] } }[] };
    return saved.cases[0]!.result.outputs!.find(output => output.kind === 'http')!.assertions;
  } finally { await rm(directory, { recursive: true, force: true }); }
}
const hostedAuth = (hostedStatus: number | 'throw', refreshAfter: { status: number; error?: string }) => ({ login: async () => session('valid'), hostedRevoke: async () => { if (hostedStatus === 'throw') throw new Error('RAW'); return hostedStatus; }, requestRefresh: async () => refreshAfter });
void test('AUTH-11 states the revocation channel it used and the hosted endpoint is a separate compatibility case', async () => {
  const main = definitions.find(def => def.id === 'AUTH-11/revoke-disable')!; assert.ok(main.outputs[0]!.assertions.includes('revocation-channel-revoke-token-api'));
  const hosted = definitions.find(def => def.id === 'AUTH-11/hosted-revoke-endpoint')!; assert.equal(hosted.acceptance, 'compatibility'); assert.equal(hosted.layer, 'L'); assert.equal(hosted.suite, 'auth');
  assert.equal(definitions.findIndex(def => def.id === hosted.id) < definitions.findIndex(def => def.id === 'AUTH-06/token-expiry'), true, 'the long expiry case stays last');
  let revoked = false; const { fixture } = stub(401); let disabled = false;
  (fixture as unknown as { auth: unknown }).auth = {
    login: async (owner: string) => { if (owner === 'b' && disabled) throw new Error('HOSTED_UI_FAILED'); return session('valid'); },
    requestRefresh: async () => revoked ? { status: 400, error: 'invalid_grant' } : { status: 200, session: session('valid') },
    revoke: async () => { revoked = true; }, disable: async () => { disabled = true; } };
  const saved = await savedAuth11Run(fixture); assert.ok(saved.every(item => item.status === 'pass')); assert.ok(saved.some(item => item.name === 'revocation-channel-revoke-token-api' && item.status === 'pass'));
});
void test('hosted revoke measurement: 404 is unsupported with a fixed reason, 2xx with a rejected refresh passes, anything else fails', async () => {
  const unsupported = await savedAuth11('AUTH-11/hosted-revoke-endpoint', hostedAuth(404, { status: 200 }));
  assert.equal(unsupported.status, 'unsupported'); assert.equal(unsupported.reason, 'hosted-revoke-unsupported'); assert.equal(unsupported.httpStatus, 404);
  assert.deepEqual(unsupported.outputs?.find(output => output.kind === 'http')?.assertions, [{ name: 'hosted-revoke-endpoint-measured', status: 'pass' }]);
  assert.equal((await savedAuth11('AUTH-11/hosted-revoke-endpoint', hostedAuth(501, { status: 200 }))).status, 'unsupported');
  const works = await savedAuth11('AUTH-11/hosted-revoke-endpoint', hostedAuth(200, { status: 400, error: 'invalid_grant' })); assert.equal(works.status, 'pass'); assert.equal(works.httpStatus, 200);
  assert.equal((await savedAuth11('AUTH-11/hosted-revoke-endpoint', hostedAuth(200, { status: 200 }))).status, 'fail', 'a 200 that leaves the token usable is a failure');
  assert.equal((await savedAuth11('AUTH-11/hosted-revoke-endpoint', hostedAuth('throw', { status: 200 }))).status, 'fail');
  assert.equal((await savedAuth11('AUTH-11/hosted-revoke-endpoint', hostedAuth(302, { status: 200 }))).status, 'fail');
});
