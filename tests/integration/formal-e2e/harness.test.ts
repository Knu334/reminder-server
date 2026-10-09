import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import http from 'node:http';
import { PassThrough, Readable } from 'node:stream';
import { mkdtemp, readFile, readdir, rm, stat, mkdir, writeFile } from 'node:fs/promises';
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

void test('suite finalization ignores unexecuted integration-layer cases but not unexecuted live cases', async t => {
  const { finalizeSuiteResources } = await import('../../e2e/floci/support/evidence.ts');
  const integration = { ...definition('SAFE-01/integration-only'), layer: 'I' as const };
  const live = { ...definition('SAFE-01/live-unrun'), layer: 'E' as const };
  const onlyIntegration = await createEvidence([integration], await temporary(t));
  await finalizeSuiteResources(onlyIntegration, 'harness');
  const withLive = await createEvidence([integration, live], await temporary(t));
  await assert.rejects(finalizeSuiteResources(withLive, 'harness'), /RESOURCE_REJECTED/);
});

void test('suite SDK manifest allows only bound owned verified absence after log finalization', async t => {
  const { reserveResource, markResource, bindResourceIdentities, finalizeSuiteResources, evidenceContext } = await import('../../e2e/floci/support/evidence.ts');
  const evidence = await createEvidence([definition()], await temporary(t));
  const name = `e2e-${evidence.runId.slice(4, 12)}-synthetic-user`;
  const id = `${evidence.runId}/sdk-user/${name}`;
  const poolId = `${evidence.runId}/platform/aws_cognito_user_pool.production`;
  await reserveResource(evidence, { kind: 'terraform-address', name: 'platform/aws_cognito_user_pool.production', id: poolId });
  await bindResourceIdentities(evidence, poolId, [{ type: 'aws_cognito_user_pool', identity: 'ap-northeast-1_OwnedPool' }]);
  await reserveResource(evidence, { kind: 'sdk-user', name, id, suite: 'harness' });
  await bindResourceIdentities(evidence, id, [{ type: 'aws_cognito_user', identity: name, parent: 'ap-northeast-1_OwnedPool' }]);
  await markResource(evidence, id, 'created');
  await assert.rejects(markResource(evidence, id, 'removed'), /RESOURCE_REJECTED/);
  await deferred(evidence);
  await assert.rejects(finalizeSuiteResources(evidence, 'harness'), /RESOURCE_REJECTED/);
  await flushPendingLogs(evidence, async checks => checks.map(check => ({ caseId: check.caseId, assertion: check.assertion, matched: true })));
  await finalizeSuiteResources(evidence, 'harness');
  await markResource(evidence, id, 'removed');
  assert.equal(evidenceContext(evidence).manifest.resources.find(r => r.id === id)?.removed, true);
  const rootId = `${evidence.runId}/root`;
  await reserveResource(evidence, { kind: 'terraform-root', name: 'root', id: rootId });
  await assert.rejects(markResource(evidence, rootId, 'removed'), /RESOURCE_REJECTED/);
});

void test('suite SDK rejects foreign names parents unsupported types and raw canary bindings', async t => {
  const { reserveResource, bindResourceIdentities } = await import('../../e2e/floci/support/evidence.ts');
  const evidence = await createEvidence([definition()], await temporary(t));
  const name = `e2e-${evidence.runId.slice(4, 12)}-control`;
  const id = `${evidence.runId}/sdk-control/${name}`;
  await reserveResource(evidence, { kind: 'sdk-control', name, id, suite: 'harness' });
  for (const binding of [{ type: 'aws_cognito_user_pool_client', identity: 'client', parent: 'ap-northeast-1_Foreign' }, { type: 'aws_lambda_function', identity: name }, { type: 'aws_cognito_user_pool', identity: 'SECRET_CANARY' }, { type: 'aws_cognito_user_pool', identity: 'ap-northeast-1_Owned', parent: 'foreign' }]) await assert.rejects(bindResourceIdentities(evidence, id, [binding]), /RESOURCE_REJECTED/);
  await assert.rejects(reserveResource(evidence, { kind: 'terraform-root', name: 'root', id: `${evidence.runId}/root`, suite: 'harness' }), /RESOURCE_REJECTED/);
});

void test('bounded Terraform console input/output stays in memory and rejects other tools', async t => {
  const directory = await temporary(t); let captured = '';
  await assert.rejects(runChild('node', ['-e', 'process.exit(0)'], { cwd: directory, timeoutMs: 1000, stdin: 'secret-canary', captureStdout: text => { captured = text; } }), /CHILD_REJECTED/);
  assert.equal(captured, '');
});

void test('stateless public evaluator permits only its fixed expression before console spawn', async t => {
  const parent = join(process.cwd(), '.superpowers/tools/aws-sdd/expected-iam'); await mkdir(parent, { recursive: true, mode: 0o700 }); const directory = await mkdtemp(join(parent, 'eval-')); t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'expectations.tf'), 'locals { expected = "synthetic" }', { mode: 0o600 }); await writeFile(join(directory, 'empty.tfstate'), '{"version":4,"terraform_version":"1.16.5","serial":0,"lineage":"00000000-0000-0000-0000-000000000000","outputs":{},"resources":[]}', { mode: 0o600 }); let capturedBytes = 0;
  await assert.rejects(runChild('terraform', ['console', '-state=empty.tfstate', '-no-color'], { cwd: directory, timeoutMs: 1000, stdin: '"SECRET_CANARY"\n', captureStdout: value => { capturedBytes += value.length; } }), /CHILD_REJECTED/);
  assert.equal(capturedBytes, 0);
});

void test('suite driver runs sequentially and resolves logs before reset and skips blocked sibling suites', async () => {
  const { executeSuites } = await import('../../../scripts/e2e/run.ts'); const order: string[] = [];
  const defs = [definition('SAFE-01/one'), { ...definition('SAFE-01/two'), suite: 'second' }];
  await executeSuites(defs, {
    async create(suite) { order.push(`create:${suite}`); return { suite }; }, async action(def) { order.push(`action:${def.id}`); }, async flush(suite) { order.push(`flush:${suite.suite}`); }, async reset(suite) { order.push(`reset:${suite.suite}`); throw new Error('RESET_FAILED'); }, async blocked(def) { order.push(`blocked:${def.id}`); },
  });
  assert.deepEqual(order, ['create:harness', 'action:SAFE-01/one', 'flush:harness', 'reset:harness', 'blocked:SAFE-01/two']);
});

void test('local SDK transport copies byte views without calling unsafe adapter string conversion', async t => {
  const { localS3 } = await import('../../../scripts/e2e/terraform.ts'); const client = localS3(target); t.after(() => client.destroy());
  let input = Buffer.alloc(0); t.mock.method(http, 'request', (_url: URL, _options: http.RequestOptions, callback: (response: http.IncomingMessage) => void) => { const outgoing = new PassThrough(); outgoing.on('data', chunk => { input = Buffer.concat([input, chunk]); }); const response = Readable.from([Buffer.from('{}')]) as http.IncomingMessage; response.statusCode = 200; response.rawHeaders = []; process.nextTick(() => callback(response)); return outgoing; });
  class BytesAdapter extends Uint8Array { override valueOf(): never { throw new Error('UNSAFE_STRING_CONVERSION'); } }
  const bytes = new BytesAdapter([1, 2, 3]); const handler = client.config.requestHandler;
  await handler.handle({ protocol: 'http:', hostname: 'floci', port: 4566, path: '/', query: {}, method: 'POST', headers: {}, body: bytes });
  assert.deepEqual(input, Buffer.from([1, 2, 3]));
});

void test('local SDK forwarding rejects exhausted and already aborted requests without upstream I/O', async t => {
  const { localS3 } = await import('../../../scripts/e2e/terraform.ts'); const client = localS3(target); t.after(() => client.destroy());
  let upstream = 0; t.mock.method(http, 'request', () => { upstream++; throw new Error('UNEXPECTED_UPSTREAM'); });
  const request = { protocol: 'http:', hostname: 'floci', port: 4566, path: '/', method: 'POST', headers: {} };
  const signal = AbortSignal.abort();
  await assert.rejects(client.config.requestHandler.handle(request, { abortSignal: signal }), /LOCAL_REQUEST_CANCELLED/);
  await assert.rejects(client.config.requestHandler.handle(request, { requestTimeout: 0 }), /LOCAL_REQUEST_CANCELLED/);
  assert.equal(upstream, 0);
});

void test('local transport bounds a slow response and closes active request on abort', async t => {
  let destroyed = 0; let upstream = 0; const signals: AbortSignal[] = [];
  t.mock.method(http, 'request', (_url: URL, options: http.RequestOptions) => { upstream++; signals.push(options.signal as AbortSignal); const request = new PassThrough(); options.signal?.addEventListener('abort', () => { destroyed++; request.destroy(new Error('cancelled')); }, { once: true }); return request; });
  const started = performance.now(); await assert.rejects(localRequest(target, new URL(target.endpoint), { timeoutMs: 10 }), /LOCAL_REQUEST_FAILED/); assert.ok(performance.now() - started < 1000);
  const controller = new AbortController(); const pending = localRequest(target, new URL(target.endpoint), { signal: controller.signal }); controller.abort(); await assert.rejects(pending, /LOCAL_REQUEST_FAILED/);
  assert.equal(upstream, 2); assert.equal(destroyed, 2); assert.ok(signals.every(signal => signal.aborted));
});

// Task 8: owned image URL transport. The signed URL is a secret held in memory only; every rejection happens before a socket opens.
const imageOwner = 'a'.repeat(64);
const imageRef = { imageId: '00000000-0000-4000-8000-000000000001', key: `images/${imageOwner}/00000000-0000-4000-8000-000000000001`, versionId: 'ver-1', mime: 'image/png', bytes: 12, sha256: 'b'.repeat(64) };
const imageFixture = { target, config: { imagesBucket: 'owned-images' } } as unknown as import('../../e2e/floci/support/types.ts').SuiteFixture;
const signed = (host: string, path: string, query = `versionId=ver-1&X-Amz-Expires=900&X-Amz-Signature=${'c'.repeat(64)}`): string => `http://${host}:4566${path}?${query}`;

void test('image_url_guard_rejects_unowned_targets_before_any_socket', async t => {
  const { fetchOwnedImage } = await import('../../e2e/floci/support/image-fixtures.ts');
  let sockets = 0; t.mock.method(http, 'request', () => { sockets++; throw new Error('socket must not open'); });
  const good = `/${imageRef.key}`;
  const rejected = [
    signed('other-bucket.floci', good), signed('floci', `/other-bucket/${imageRef.key}`), signed('example.com', good), signed('169.254.169.254', good),
    signed('owned-images.floci', `/images/${'d'.repeat(64)}/00000000-0000-4000-8000-000000000001`), signed('owned-images.floci', good, `versionId=ver-2&X-Amz-Signature=${'c'.repeat(64)}`),
    signed('owned-images.floci', good, `X-Amz-Signature=${'c'.repeat(64)}`), signed('owned-images.floci', good, `versionId=ver-1&versionId=ver-2&X-Amz-Signature=${'c'.repeat(64)}`),
    signed('owned-images.floci', good, 'versionId=ver-1'),
    `https://owned-images.floci:4566${good}?versionId=ver-1&X-Amz-Signature=${'c'.repeat(64)}`, `http://owned-images.floci:80${good}?versionId=ver-1&X-Amz-Signature=${'c'.repeat(64)}`,
    `http://user:pw@owned-images.floci:4566${good}?versionId=ver-1&X-Amz-Signature=${'c'.repeat(64)}`, `${signed('owned-images.floci', good)}#fragment`, 'not a url',
  ];
  for (const url of rejected) await assert.rejects(fetchOwnedImage(imageFixture, url, imageRef), /IMAGE_URL_REJECTED/);
  await assert.rejects(fetchOwnedImage(imageFixture, signed('owned-images.floci', good), { ...imageRef, key: 'images/not-an-owner/x' }), /IMAGE_URL_REJECTED/);
  await assert.rejects(fetchOwnedImage({ ...imageFixture, target: { ...target, addresses: new Map([['floci', '8.8.8.8']]) } } as never, signed('owned-images.floci', good), imageRef), /IMAGE_URL_REJECTED|LOCAL_TARGET_REJECTED/);
  assert.equal(sockets, 0);
});

void test('image_url_fetch_pins_the_owned_bucket_host_sends_no_credentials_and_never_follows_redirects', async t => {
  const { fetchOwnedImage } = await import('../../e2e/floci/support/image-fixtures.ts');
  const seen: { host: string; headers: Record<string, string>; address: string[]; method: string }[] = []; let status = 200;
  t.mock.method(http, 'request', (url: URL, options: http.RequestOptions, callback: (response: http.IncomingMessage) => void) => {
    const lookupAddresses: string[] = [];
    (options.lookup as (host: string, options: { all: boolean }, callback: (error: null, addresses: { address: string; family: number }[]) => void) => void)(url.hostname, { all: true }, (_error, addresses) => lookupAddresses.push(...addresses.map(item => item.address)));
    seen.push({ host: String((options.headers as Record<string, string>).host), headers: { ...(options.headers as Record<string, string>) }, address: lookupAddresses, method: String(options.method) });
    const response = Readable.from([Buffer.from('original-bytes')]) as http.IncomingMessage; response.statusCode = status; response.rawHeaders = status === 302 ? ['location', 'http://example.com:4566/'] : ['content-type', 'image/png'];
    process.nextTick(() => callback(response)); return new PassThrough();
  });
  for (const [host, path] of [['owned-images.floci', `/${imageRef.key}`], ['floci', `/owned-images/${imageRef.key}`]] as const) {
    const result = await fetchOwnedImage(imageFixture, signed(host, path), imageRef);
    assert.equal(result.status, 200); assert.equal(result.bytes.toString(), 'original-bytes');
  }
  assert.deepEqual(seen.map(item => item.host), ['owned-images.floci:4566', 'floci:4566']);
  assert.deepEqual(seen.map(item => item.address), [['172.18.0.2'], ['172.18.0.2']]);
  assert.ok(seen.every(item => item.method === 'GET' && !Object.keys(item.headers).some(name => ['authorization', 'cookie'].includes(name.toLowerCase()))));
  status = 302; await assert.rejects(fetchOwnedImage(imageFixture, signed('floci', `/owned-images/${imageRef.key}`), imageRef), /IMAGE_REDIRECT_REJECTED/);
  assert.equal(seen.length, 3);
});

void test('image_url_signature_helpers_alter_only_the_signature_and_the_probe_separates_enforcement_from_leniency', async () => {
  const { tamperUrlSignature, probeSignatureEnforcement } = await import('../../e2e/floci/support/image-fixtures.ts');
  const url = signed('floci', `/owned-images/${imageRef.key}`); const changed = tamperUrlSignature(url);
  const [left, right] = [new URL(url), new URL(changed)];
  assert.notEqual(left.searchParams.get('X-Amz-Signature'), right.searchParams.get('X-Amz-Signature'));
  assert.equal(right.searchParams.get('X-Amz-Signature')?.length, 64);
  for (const name of ['versionId', 'X-Amz-Expires']) assert.equal(left.searchParams.get(name), right.searchParams.get(name));
  assert.equal(left.pathname, right.pathname); assert.equal(left.host, right.host);
  assert.throws(() => tamperUrlSignature('http://floci:4566/x?versionId=1'), /IMAGE_URL_REJECTED/);
  const body = Buffer.from('original-bytes');
  const make = (control: number, tampered: number, early: number, late: number, other = body) => { let phase = 0;
    const answer = (status: number) => ({ status, bytes: status >= 200 && status < 300 ? other : Buffer.alloc(0) });
    return { control: 'control', tampered: 'tampered', shortLived: 'short', expected: body, fetch: async (name: string) => answer(name === 'control' ? control : name === 'tampered' ? tampered : phase++ === 0 ? early : late), waitUntilExpired: async () => undefined }; };
  assert.equal(await probeSignatureEnforcement(make(200, 403, 200, 403)), 'enforced');
  assert.equal(await probeSignatureEnforcement(make(200, 400, 200, 403)), 'enforced');
  assert.equal(await probeSignatureEnforcement(make(200, 200, 200, 403)), 'unsupported');
  assert.equal(await probeSignatureEnforcement(make(200, 403, 200, 200)), 'unsupported');
  assert.equal(await probeSignatureEnforcement(make(403, 403, 200, 403)), 'control-failed');
  assert.equal(await probeSignatureEnforcement(make(200, 403, 403, 403)), 'control-failed');
  for (const status of [404, 500, 301]) { assert.equal(await probeSignatureEnforcement(make(200, status, 200, 403)), 'unexpected', `tamper ${status}`); assert.equal(await probeSignatureEnforcement(make(200, 403, 200, status)), 'unexpected', `expired ${status}`); }
  assert.equal(await probeSignatureEnforcement(make(200, 403, 200, 403, Buffer.from('other'))), 'control-failed');
});
