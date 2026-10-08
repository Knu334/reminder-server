import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import http from 'node:http';
import { PassThrough, Readable } from 'node:stream';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createEvidence, runCase, flushPendingLogs, recordProcess } from '../../e2e/floci/support/evidence.ts';
import { localRequest } from '../../e2e/floci/support/transport.ts';
import { definitions } from '../../e2e/floci/support/cases.ts';
import { runMain, runChild, childEnvironment, RunBudget } from '../../../scripts/e2e/run.ts';
import type { CaseDefinition, Evidence, LocalTarget, OutputResult, PendingLogCheck, LogExpectation } from '../../e2e/floci/support/types.ts';

const target: LocalTarget = { endpoint: 'http://floci:4566', region: 'ap-northeast-1', addresses: new Map([['floci', '172.18.0.2']]) };
const cleanup = { attempted: 0, succeeded: 0, errors: 0, leaks: 0 };
function definition(id = 'SAFE-01/test'): CaseDefinition {
  return { id, requirementId: 'SAFE-01', layer: 'I', required: true, acceptance: 'behavior', suite: 'harness', source: 'formal-e2e-coverage/SAFE-01', outputs: [
    { kind: 'http', assertions: ['status', 'headers'] }, { kind: 'dynamodb', assertions: ['unchanged'] },
    { kind: 's3', assertions: ['no-additional-write'] }, { kind: 'logs', assertions: ['delivered'] },
  ] };
}
const outputs: OutputResult[] = [
  { kind: 'http', status: 'pass', assertions: [{ name: 'status', status: 'pass' }, { name: 'headers', status: 'pass' }] },
  { kind: 'dynamodb', status: 'pass', assertions: [{ name: 'unchanged', status: 'pass' }] },
  { kind: 's3', status: 'pass', assertions: [{ name: 'no-additional-write', status: 'pass' }] },
  { kind: 'logs', status: 'pass', assertions: [{ name: 'delivered', status: 'pass' }] },
];
async function temporary(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'formal-e2e-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, 'run');
}
async function report(directory: string): Promise<string> {
  return (await Promise.all((await readdir(directory)).map(name => readFile(join(directory, name), 'utf8')))).join('\n');
}
const check: PendingLogCheck = { caseId: 'SAFE-01/test', assertion: 'delivered', expectation: { service: 'api', requestId: 'synthetic-request', since: 100, status: 200, mode: 'present' } };
async function deferred(evidence: Evidence) {
  await runCase(definition(), evidence, async recorder => {
    recorder.recordInput({ httpStatus: 200 });
    outputs.slice(0, 3).forEach(output => recorder.recordOutput(output));
    recorder.deferLogs(check);
  });
}

void test('reject_public_redirect_unknown_host_before_socket', async t => {
  let sockets = 0;
  t.mock.method(http, 'request', () => { sockets++; throw new Error('socket must not open'); });
  for (const url of ['http://example.com:4566/', 'http://169.254.169.254:4566/', 'http://172.18.0.2:4566/', 'https://floci:4566/', 'http://user:password@floci:4566/', 'http://floci:80/']) {
    await assert.rejects(localRequest(target, new URL(url), {}), /LOCAL_TARGET_REJECTED/);
  }
  await assert.rejects(localRequest({ ...target, addresses: new Map([['floci', '8.8.8.8']]) }, new URL(target.endpoint), {}));
  await assert.rejects(localRequest(target, new URL(target.endpoint), { headers: { Host: 'example.com' } }));
  assert.equal(sockets, 0);
});

void test('dns_drift_preserves_host_and_does_not_follow_redirect', async t => {
  let sockets = 0;
  t.mock.method(http, 'request', (url: URL, options: http.RequestOptions, callback: (response: http.IncomingMessage) => void) => {
    sockets++;
    assert.equal(url.hostname, 'floci');
    assert.equal(options.headers && (options.headers as Record<string, string>).host, 'floci:4566');
    assert.ok(options.lookup);
    (options.lookup as (host: string, options: { all: boolean }, callback: (error: null, addresses: { address: string; family: number }[]) => void) => void)('floci', { all: true }, (_error, addresses) => {
      assert.deepEqual(addresses, [{ address: '172.18.0.2', family: 4 }]);
    });
    const response = Readable.from([Buffer.from('redirect')]) as http.IncomingMessage;
    response.statusCode = 302; response.rawHeaders = ['location', 'http://example.com:4566/'];
    const outgoing = new PassThrough();
    process.nextTick(() => callback(response));
    return outgoing;
  });
  const result = await localRequest(target, new URL(target.endpoint), {});
  assert.equal(result.status, 302);
  await assert.rejects(localRequest(target, new URL(result.headers.get('location')!), {}));
  assert.equal(sockets, 1);
});

void test('failed_case_keeps_inventory_and_siblings', async t => {
  const directory = await temporary(t);
  const defs = ['first', 'second', 'third'].map(id => definition(`SAFE-01/${id}`));
  const evidence = await createEvidence(defs, directory);
  assert.match(await report(directory), /not-run/);
  await runCase(defs[0]!, evidence, async recorder => { outputs.forEach(output => recorder.recordOutput(output)); });
  await runCase(defs[1]!, evidence, async recorder => { recorder.recordInput({ httpStatus: 200 }); recorder.recordOutput(outputs[0]!); throw new Error('synthetic failure'); });
  const summary = await evidence.finish(cleanup);
  assert.deepEqual([summary.selected, summary.passed, summary.failed, summary.notRun, summary.exitCode], [3, 1, 1, 1, 1]);
  const saved = await report(directory);
  assert.match(saved, /"httpStatus": 200/);
  assert.match(saved, /SAFE-01\/third/);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  for (const file of await readdir(directory)) assert.equal((await stat(join(directory, file))).mode & 0o777, 0o600);
});

void test('canary_never_reaches_report_or_stderr', async t => {
  const canary = 'SECRET_CANARY_password_token_cookie_raw_body';
  const directory = await temporary(t);
  const evidence = await createEvidence([definition()], directory);
  let printed = '';
  t.mock.method(process.stderr, 'write', (chunk: string) => { printed += chunk; return true; });
  await runCase(definition(), evidence, async recorder => {
    recorder.recordInput({ httpStatus: 200, code: canary });
    assert.equal(canary, 'safe expected');
  });
  await evidence.finish(cleanup);
  const child = await runChild('node', ['-e', `process.stdout.write('${canary}');process.stderr.write('${canary}');process.exit(1)`], { cwd: directory, timeoutMs: 5000 });
  assert.equal(child.status, 'failed');
  assert.equal((await report(directory) + printed + JSON.stringify(child)).includes(canary), false);
});

void test('cleanup_failure_changes_exit', async t => {
  const evidence = await createEvidence([definition()], await temporary(t));
  await runCase(definition(), evidence, async recorder => { outputs.forEach(output => recorder.recordOutput(output)); });
  assert.equal((await evidence.finish({ attempted: 1, succeeded: 0, errors: 1, leaks: 0 })).exitCode, 1);
});

void test('missing_or_duplicate_assertions_and_unexpected_not_applicable_cannot_pass', async t => {
  const invalid: OutputResult[][] = [outputs.slice(0, 1), outputs.slice(0, 3), [...outputs, outputs[0]!],
    [{ ...outputs[0]!, assertions: [{ name: 'status', status: 'pass' }] }, ...outputs.slice(1)],
    [{ ...outputs[0]!, assertions: [{ name: 'status', status: 'pass' }, { name: 'status', status: 'pass' }] }, ...outputs.slice(1)],
    [{ kind: 'http', status: 'not-applicable', assertions: [], reason: 'not-http' }, ...outputs.slice(1)],
    [{ ...outputs[0]!, assertions: [{ name: 'status', status: 'fail' }, { name: 'headers', status: 'pass' }] }, ...outputs.slice(1)],
  ];
  for (const results of invalid) {
    const evidence = await createEvidence([definition()], await temporary(t));
    await runCase(definition(), evidence, async recorder => { results.forEach(output => recorder.recordOutput(output)); });
    assert.equal((await evidence.finish(cleanup)).failed, 1);
  }
});

void test('not_applicable_requires_definition_reason_and_exact_match', async t => {
  const def = definition(); def.outputs[0] = { kind: 'http', assertions: [], notApplicableReason: 'non-http-input' };
  for (const reason of [undefined, 'wrong-reason', 'non-http-input']) {
    const evidence = await createEvidence([def], await temporary(t));
    await runCase(def, evidence, async recorder => {
      recorder.recordOutput({ kind: 'http', status: 'not-applicable', assertions: [], ...(reason ? { reason } : {}) });
      outputs.slice(1).forEach(output => recorder.recordOutput(output));
    });
    assert.equal((await evidence.finish(cleanup)).passed, reason === 'non-http-input' ? 1 : 0);
  }
  def.outputs[0] = { kind: 'http', assertions: [] };
  await assert.rejects(createEvidence([def], await temporary(t)), /INVALID_DEFINITION/);
});

void test('pending_logs_cannot_pass_before_suite_flush', async t => {
  const directory = await temporary(t); const evidence = await createEvidence([definition()], directory);
  await deferred(evidence);
  const snapshot = JSON.parse(await readFile(join(directory, 'results.json'), 'utf8')) as { cases: { result: { status: string } }[] };
  assert.equal(snapshot.cases.some(item => item.result.status === 'pass'), false);
  await flushPendingLogs(evidence, async checks => checks.map(item => ({ caseId: item.caseId, assertion: item.assertion, matched: true })));
  assert.equal((await evidence.finish(cleanup)).passed, 1);
});

void test('observer_failure_keeps_http_input_and_fails_executed_case', async t => {
  const directory = await temporary(t); const evidence = await createEvidence([definition()], directory);
  await deferred(evidence);
  await flushPendingLogs(evidence, async () => { throw new Error('SECRET_CANARY'); });
  const summary = await evidence.finish(cleanup);
  assert.equal(summary.failed, 1); assert.equal(summary.notRun, 0);
  assert.match(await report(directory), /"httpStatus": 200/);
  assert.equal((await report(directory)).includes('SECRET_CANARY'), false);
});

void test('finish_fails_unflushed_input_instead_of_reporting_not_run', async t => {
  const evidence = await createEvidence([definition()], await temporary(t)); await deferred(evidence);
  const summary = await evidence.finish(cleanup); assert.equal(summary.failed, 1); assert.equal(summary.notRun, 0);
});

void test('absence_requires_both_control_logs', async t => {
  for (const controlsMatched of [undefined, { before: true, after: false }, { before: true, after: true }]) {
    const evidence = await createEvidence([definition()], await temporary(t));
    await runCase(definition(), evidence, async recorder => {
      outputs.slice(0, 3).forEach(output => recorder.recordOutput(output));
      recorder.deferLogs({ ...check, expectation: { service: 'api', since: 200, until: 300, mode: 'absent' }, controls: {
        before: { ...check.expectation, since: 100, mode: 'present' }, after: { ...check.expectation, since: 400, mode: 'present' },
      } });
    });
    await flushPendingLogs(evidence, async () => [{ caseId: check.caseId, assertion: check.assertion, matched: true, ...(controlsMatched ? { controlsMatched } : {}) }]);
    assert.equal((await evidence.finish(cleanup)).passed, controlsMatched?.after === true ? 1 : 0);
  }
});

void test('direct_record_cannot_bypass_assertions_or_erase_executed_case', async t => {
  const evidence = await createEvidence([definition()], await temporary(t));
  await evidence.record({ id: definition().id, status: 'pass', phase: 'complete', durationMs: 1, outputs: [outputs[0]!] });
  await assert.rejects(evidence.record({ id: definition().id, status: 'not-run', phase: 'preflight', durationMs: 0 }));
  assert.equal((await evidence.finish(cleanup)).failed, 1);
});

void test('real_terraform_layer_is_L_and_driver_negative_is_I', () => {
  assert.equal(definitions.find(def => def.id === 'TF-01/apply')?.layer, 'L');
  assert.equal(definitions.find(def => def.id === 'TF-02/driver-isolation')?.layer, 'I');
});

void test('unknown_selection_exits_2_without_preflight', async t => {
  let diagnostic = ''; t.mock.method(console, 'error', (value: string) => { diagnostic += value; });
  assert.equal(await runMain(['--suite', 'unknown']), 2);
  assert.equal(await runMain(['--case', 'SAFE-01/not-defined']), 2);
  assert.equal(await runMain(['--layer', 'TF']), 2);
  assert.equal(diagnostic, 'E2E_INVALID_SELECTION'.repeat(3));
});

void test('child_env_discards_ambient_credentials_proxy_and_node_hooks', () => {
  const env = childEnvironment();
  assert.equal(env.AWS_PROFILE, undefined); assert.equal(env.HTTP_PROXY, undefined); assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.AWS_SHARED_CREDENTIALS_FILE, '/dev/null'); assert.equal(env.AWS_CONFIG_FILE, '/dev/null');
  assert.equal(env.AWS_EC2_METADATA_DISABLED, 'true'); assert.equal(env.AWS_ACCESS_KEY_ID, 'local');
  assert.equal(env.AWS_REGION, 'ap-northeast-1');
});

void test('child_timeout_records_safe_diagnostic_and_never_raw_output', async t => {
  const result = await runChild('node', ['-e', "process.stderr.write('SECRET_CANARY');setInterval(()=>{},1000)"], { cwd: dirname(await temporary(t)), timeoutMs: 30 });
  assert.equal(result.status, 'timeout'); assert.equal(JSON.stringify(result).includes('SECRET_CANARY'), false);
});

void test('budget_reserves_cleanup_and_refuses_new_input_after_cleanup', () => {
  let now = 0; const budget = new RunBudget(() => now);
  assert.equal(budget.allow('cleanupInvoke'), 700000);
  now = 75 * 60 * 1000 - 1; assert.equal(budget.allow('http'), 0);
  budget.beginCleanup(); assert.equal(budget.allow('http'), 0); assert.equal(budget.cleanupRemaining(), 900000);
  now = 90 * 60 * 1000; assert.equal(budget.cleanupRemaining(), 0);
});

void test('sanitized_npm_child_can_verify_pinned_version', async () => {
  const result = await runChild('npm', ['--version'], { cwd: process.cwd(), timeoutMs: 5000, expectedOutput: '11.11.1' });
  assert.equal(result.status, 'succeeded'); assert.equal(result.expectedOutputMatched, true);
});

void test('child_timeout_manifest_is_safe_and_keeps_deadline', async t => {
  const directory = await temporary(t); const evidence = await createEvidence([definition()], directory);
  await runChild('node', ['-e', "process.stderr.write('SECRET_CANARY');setInterval(()=>{},1000)"], {
    cwd: directory, timeoutMs: 30, record: result => recordProcess(evidence, result),
  });
  await evidence.finish(cleanup);
  const manifest = await readFile(join(directory, 'manifest.json'), 'utf8');
  assert.match(manifest, /"status": "timeout"/); assert.match(manifest, /"timeoutMs": 30/);
  assert.equal(manifest.includes('SECRET_CANARY'), false);
});

void test('unsupported_only_completes_measured_compatibility_with_fixed_reason', async t => {
  for (const [acceptance, reason, expected] of [
    ['behavior', 'gateway-delivery-unsupported', 1],
    ['compatibility', 'SECRET_CANARY', 1],
    ['compatibility', 'gateway-delivery-unsupported', 0],
  ] as const) {
    const def = { ...definition(), acceptance }; const directory = await temporary(t);
    const evidence = await createEvidence([def], directory);
    await evidence.record({ id: def.id, status: 'unsupported', phase: 'complete', durationMs: 1, reason, outputs });
    assert.equal((await evidence.finish(cleanup)).exitCode, expected);
    assert.equal((await report(directory)).includes('SECRET_CANARY'), false);
  }
});

void test('preflight_blocker_is_not_run_with_exit_2_in_saved_summary', async t => {
  const directory = await temporary(t); const evidence = await createEvidence([definition()], directory);
  await evidence.record({ id: definition().id, status: 'not-run', phase: 'preflight', durationMs: 0, reason: 'preflight-failed' });
  const summary = await evidence.finish(cleanup);
  assert.equal(summary.notRun, 1); assert.equal(summary.exitCode, 2);
  assert.match(await report(directory), /"exitCode": 2/);
});

void test('not_run_cannot_hide_http_input', async t => {
  const evidence = await createEvidence([definition()], await temporary(t));
  await evidence.record({ id: definition().id, status: 'not-run', phase: 'input', durationMs: 1, httpStatus: 200, outputs: [outputs[0]!] });
  const summary = await evidence.finish(cleanup);
  assert.equal(summary.failed, 1); assert.equal(summary.notRun, 0);
});

void test('api_log_expectation_requires_request_id_and_status', async t => {
  const evidence = await createEvidence([definition()], await temporary(t));
  await runCase(definition(), evidence, async recorder => {
    outputs.slice(0, 3).forEach(output => recorder.recordOutput(output));
    recorder.deferLogs({ ...check, expectation: { service: 'api', since: 100, mode: 'present' } });
  });
  await flushPendingLogs(evidence, async () => [{ caseId: check.caseId, assertion: check.assertion, matched: true }]);
  assert.equal((await evidence.finish(cleanup)).failed, 1);
});

void test('evidence_definition_allowlist_discards_unexpected_secret_fields', async t => {
  const directory = await temporary(t);
  const def = Object.assign(definition(), { token: 'SECRET_CANARY' });
  Object.assign(def.outputs[0]!, { body: 'SECRET_CANARY' });
  const evidence = await createEvidence([def], directory);
  await evidence.finish(cleanup);
  assert.equal((await report(directory)).includes('SECRET_CANARY'), false);
});

void test('runner_directory_and_manifest_use_the_same_run_id', async t => {
  const directory = join(dirname(await temporary(t)), 'e2e-00000000-0000-4000-8000-000000000000');
  const evidence = await createEvidence([definition()], directory);
  assert.equal(evidence.runId, 'e2e-00000000-0000-4000-8000-000000000000');
  await evidence.finish(cleanup);
});

const invalidControls: [string, (control: LogExpectation) => void][] = [
  ['missing_request_id', control => { delete control.requestId; }],
  ['empty_request_id', control => { control.requestId = ''; }],
  ['blank_request_id', control => { control.requestId = '   '; }],
  ['missing_status', control => { delete control.status; }],
  ['fractional_status', control => { control.status = 200.5; }],
  ['status_below_http_range', control => { control.status = 99; }],
  ['status_above_http_range', control => { control.status = 600; }],
];
for (const position of ['before', 'after'] as const) {
  for (const [label, invalidate] of invalidControls) {
    void test(`api_absence_rejects_${position}_control_${label}`, async t => {
      const directory = await temporary(t);
      const evidence = await createEvidence([definition()], directory);
      const controls = {
        before: { ...check.expectation, since: 100, mode: 'present' as const },
        after: { ...check.expectation, since: 400, mode: 'present' as const },
      };
      invalidate(controls[position]);
      await runCase(definition(), evidence, async recorder => {
        recorder.recordInput({ httpStatus: 401 });
        outputs.slice(0, 3).forEach(output => recorder.recordOutput(output));
        recorder.deferLogs({ ...check, expectation: { service: 'api', since: 200, until: 300, mode: 'absent' }, controls });
      });
      await flushPendingLogs(evidence, async () => [{
        caseId: check.caseId, assertion: check.assertion, matched: true,
        controlsMatched: { before: true, after: true },
      }]);
      const summary = await evidence.finish(cleanup);
      assert.equal(summary.passed, 0);
      assert.equal(summary.failed, 1);
      assert.equal(summary.exitCode, 1);
      assert.match(await report(directory), /"httpStatus": 401/);
    });
  }
}
