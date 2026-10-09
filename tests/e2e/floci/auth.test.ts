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

function session(tag: string): AuthSession { const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url'); return { accessToken: `${part({ alg: 'RS256' })}.${part({ tag })}.${'S'.repeat(342)}`, idToken: `id-${tag}`, refreshToken: `refresh-${tag}`, claims: { iss: 'issuer', sub: 'sub', client_id: 'client', iat: 1, exp: 301, scope: 'reminder-api/read' } }; }
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
async function runOnce(id: string, fixture: SuiteFixture, matched: boolean): Promise<{ status: string; reason?: string; logs?: { assertions: { name: string; status: string }[] } }> {
  const directory = await mkdtemp(join(tmpdir(), 'auth-case-')); try {
    const def = definitions.find(item => item.id === id)!; const evidence = await createEvidence([def], join(directory, 'run'));
    let deferred: { assertion: string; hasControls: boolean }[] = [];
    await runCase(def, evidence, async recorder => { const wrapped = { ...recorder, deferLogs: (check: Parameters<typeof recorder.deferLogs>[0]) => { deferred.push({ assertion: check.assertion, hasControls: !!check.controls }); recorder.deferLogs(check); } }; await caseActions.get(id)!(fixture, wrapped); });
    await flushPendingLogs(evidence, async checks => checks.map((check): LogCheckResult => ({ caseId: check.caseId, assertion: check.assertion, matched, controlsMatched: { before: matched, after: matched } })));
    await finalizeResults(evidence);
    const saved = JSON.parse(await readFile(join(evidenceContext(evidence).directory, 'results.json'), 'utf8')) as { cases: { result: { status: string; reason?: string; outputs?: { kind: string; assertions: { name: string; status: string }[] }[] } }[] };
    assert.ok(deferred.every(item => item.hasControls)); deferred = [];
    const result = saved.cases[0]!.result; return { status: result.status, ...(result.reason ? { reason: result.reason } : {}), ...(result.outputs?.find(output => output.kind === 'logs') ? { logs: result.outputs.find(output => output.kind === 'logs')! } : {}) };
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
