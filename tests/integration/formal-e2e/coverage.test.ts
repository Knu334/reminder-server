import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEvidence } from '../../e2e/floci/support/evidence.ts';
import { definitions, offlineEvidence, requirementEvidence } from '../../e2e/floci/support/cases.ts';
import { claimsFullCompletion, recordConstructionDependents } from '../../../scripts/e2e/run.ts';
import { titleMatches } from '../../../scripts/e2e/offline-evidence.ts';
import type { CaseDefinition, OutputResult, RunSummary } from '../../e2e/floci/support/types.ts';

const root = process.cwd();
const read = (path: string): string => readFileSync(join(root, path), 'utf8');
const clean = { attempted: 3, succeeded: 3, errors: 0, leaks: 0 };

/** Rows of a Markdown table whose first cell starts with an inventory/requirement ID. */
function rows(markdown: string, pattern: RegExp): string[][] {
  return markdown.split('\n').filter(line => pattern.test(line)).map(line => line.split('|').slice(1, -1).map(cell => cell.trim()));
}
const coverageRows = rows(read('docs/operations/formal-e2e-coverage.md'), /^\| [A-Z]+-\d\d \//);
const resultRows = rows(read('docs/operations/formal-e2e-results.md'), /^\| `[A-Z]+-\d\d\//);
const resultId = (row: string[]): string => row[0]!.replaceAll('`', '');
const STATUSES = ['pass', 'fail', 'not-run', 'unsupported'];
/** Names of the tests a source file declares with test(...) or it(...). */
function declaredTests(text: string): string[] {
  return [...text.matchAll(/\b(?:void\s+)?(?:test|it)\(\s*(['"`])((?:\\.|(?!\1).)*)\1/g)].map(match => match[2]!);
}

function single(id: string, layer: CaseDefinition['layer'] = 'E', acceptance: CaseDefinition['acceptance'] = 'behavior'): CaseDefinition {
  return { id, requirementId: id.split('/')[0]!, layer, required: true, acceptance, suite: 'harness', source: `formal-e2e-coverage/${id.split('/')[0]!}`, outputs: [
    { kind: 'http', assertions: ['status'] }, { kind: 'dynamodb', assertions: ['unchanged'] }, { kind: 's3', assertions: ['unchanged'] }, { kind: 'logs', assertions: ['delivered'] },
  ] };
}
const passing: OutputResult[] = [
  { kind: 'http', status: 'pass', assertions: [{ name: 'status', status: 'pass' }] }, { kind: 'dynamodb', status: 'pass', assertions: [{ name: 'unchanged', status: 'pass' }] },
  { kind: 's3', status: 'pass', assertions: [{ name: 'unchanged', status: 'pass' }] }, { kind: 'logs', status: 'pass', assertions: [{ name: 'delivered', status: 'pass' }] },
];
async function temporary(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'formal-e2e-coverage-')); t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, 'run');
}

void test('every_required_case_has_result_and_source', () => {
  const coverageIds = new Set(coverageRows.map(row => row[0]!.split(' / ')[0]!));
  assert.equal(coverageIds.size, 70);
  for (const row of coverageRows) assert.equal(row.length, 10, `${row[0]} needs the result column`);
  const byId = new Map(resultRows.map(row => [resultId(row), row]));
  assert.equal(byId.size, resultRows.length, 'a result row is listed twice');
  // One to one: every registry case has exactly one result row and no case vanished from or was added to the report.
  assert.deepEqual([...byId.keys()].sort(), definitions.map(def => def.id).sort());
  for (const def of definitions) {
    assert.ok(coverageIds.has(def.requirementId), `${def.id} names a requirement missing from the coverage table`);
    assert.equal(def.source, `formal-e2e-coverage/${def.requirementId}`);
    assert.ok(def.required);
    const row = byId.get(def.id)!;
    assert.equal(row[1], def.layer, `${def.id} layer`); assert.equal(row[2], def.suite, `${def.id} suite`);
    assert.equal(row[3], def.acceptance === 'compatibility' ? 'compatibility' : 'behavior', `${def.id} acceptance`);
    assert.ok(STATUSES.includes(row[4]!), `${def.id} status ${row[4]}`);
    assert.ok(row[5]!.length > 0, `${def.id} needs a basis`);
    if (def.acceptance === 'behavior') assert.notEqual(row[4], 'unsupported', `${def.id} behavior cases are never unsupported`);
  }
  // Every coverage row is either backed by a registry case or by named offline files, and carries a result.
  for (const row of coverageRows) {
    const id = row[0]!.split(' / ')[0]!;
    assert.ok(definitions.some(def => def.requirementId === id) || requirementEvidence[id], `${id} has neither a case nor offline evidence`);
    assert.ok(row[9]!.length > 0, `${id} result`);
  }
  // The stated totals equal the table.
  const text = read('docs/operations/formal-e2e-results.md');
  const count = (status: string) => resultRows.filter(row => row[4] === status).length;
  const total = /全(\d+)件: pass (\d+) \/ fail (\d+) \/ not-run (\d+) \/ unsupported (\d+)/.exec(text);
  assert.ok(total, 'the totals line is missing');
  assert.deepEqual(total.slice(1).map(Number), [definitions.length, count('pass'), count('fail'), count('not-run'), count('unsupported')]);
});

void test('every_integration_case_is_linked_to_existing_offline_evidence', () => {
  const integration = definitions.filter(def => def.layer === 'I');
  assert.equal(integration.length, 24);
  assert.deepEqual(Object.keys(offlineEvidence).sort(), integration.map(def => def.id).sort());
  for (const def of integration) {
    const links = offlineEvidence[def.id]!; assert.ok(links.length > 0, def.id);
    for (const link of links) {
      assert.ok(existsSync(join(root, link.file)), `${def.id}: ${link.file} is missing`);
      const text = read(link.file); assert.ok(link.titles.length > 0, def.id);
      // The E2E run judges each title from an executed test: the title must equal a registered test name or continue it after a word boundary.
      const names = declaredTests(text);
      for (const title of link.titles) assert.equal(names.filter(name => titleMatches(title, name)).length, 1, `${def.id}: "${title}" must match exactly one test in ${link.file}`);
    }
    // The E2E run judges these from the real offline results (phase offline): the recorded row must be pass.
    const row = resultRows.find(item => resultId(item) === def.id)!;
    assert.equal(row[4], 'pass', `${def.id} must be recorded pass, not ${row[4]}`);
    for (const link of links) assert.ok(row[5]!.includes(link.file), `${def.id} result row cites ${link.file}`);
  }
  for (const [id, files] of Object.entries(requirementEvidence)) {
    assert.ok(coverageRows.some(row => row[0]!.startsWith(`${id} / `)), id);
    assert.ok(files.length > 0);
    for (const file of files) assert.ok(existsSync(join(root, file)), `${id}: ${file} is missing`);
  }
});

void test('partial_selection_cannot_claim_full_completion', async t => {
  const summary = (overrides: Partial<RunSummary>): RunSummary => ({ selected: 2, passed: 2, failed: 0, notRun: 0, unsupported: 0, outOfScope: 0, cleanup: clean, exitCode: 0, ...overrides });
  assert.equal(claimsFullCompletion(summary({}), 2, 2), true);
  assert.equal(claimsFullCompletion(summary({}), 2, 268), false, 'a subset that passes is still partial');
  assert.equal(claimsFullCompletion(summary({ passed: 1, unsupported: 1 }), 2, 2), true, 'measured compatibility unsupported completes');
  assert.equal(claimsFullCompletion(summary({ passed: 1, notRun: 1, exitCode: 1 }), 2, 2), false);
  assert.equal(claimsFullCompletion(summary({ passed: 1, failed: 1, exitCode: 1 }), 2, 2), false);
  assert.equal(claimsFullCompletion(summary({ cleanup: { ...clean, leaks: 1 } }), 2, 2), false);
  assert.equal(claimsFullCompletion(summary({ exitCode: 2 }), 2, 2), false);
  // The real evidence agrees: a passing one-case selection exits 0 yet cannot be complete against the full registry.
  const evidence = await createEvidence([single('SAFE-01/only')], await temporary(t));
  const { runCase } = await import('../../e2e/floci/support/evidence.ts');
  await runCase(single('SAFE-01/only'), evidence, async recorder => { passing.forEach(output => recorder.recordOutput(output)); });
  const result = await evidence.finish(clean);
  assert.equal(result.exitCode, 0); assert.equal(claimsFullCompletion(result, result.selected, definitions.length), false);
});

void test('unsupported_not_run_cleanup_are_separate', async t => {
  const defs = [single('SAFE-01/a'), single('SAFE-01/b'), single('SAFE-01/c', 'L', 'compatibility'), single('SAFE-01/d')];
  const directory = await temporary(t); const evidence = await createEvidence(defs, directory);
  const { runCase } = await import('../../e2e/floci/support/evidence.ts');
  await runCase(defs[0]!, evidence, async recorder => { passing.forEach(output => recorder.recordOutput(output)); });
  await evidence.record({ id: 'SAFE-01/c', status: 'unsupported', phase: 'outputs', durationMs: 1, reason: 'signature-enforcement-unsupported', outputs: passing });
  await evidence.record({ id: 'SAFE-01/d', status: 'not-run', phase: 'provision', durationMs: 0, reason: 'prerequisite-failed' });
  const summary = await evidence.finish({ attempted: 5, succeeded: 4, errors: 1, leaks: 2 });
  // Each class is counted once and cleanup never leaks into the case counters.
  assert.deepEqual([summary.passed, summary.failed, summary.notRun, summary.unsupported], [1, 0, 2, 1]);
  assert.deepEqual(summary.cleanup, { attempted: 5, succeeded: 4, errors: 1, leaks: 2 });
  assert.equal(summary.exitCode, 1);
  assert.equal(claimsFullCompletion(summary, defs.length, defs.length), false);
  // A compatibility measurement that was never run stays not-run; a measured unsupported alone does not fail the run.
  const second = await createEvidence([defs[2]!], await temporary(t));
  await second.record({ id: 'SAFE-01/c', status: 'unsupported', phase: 'outputs', durationMs: 1, reason: 'signature-enforcement-unsupported', outputs: passing });
  assert.equal((await second.finish(clean)).exitCode, 0);
  const third = await createEvidence([defs[2]!], await temporary(t));
  await third.record({ id: 'SAFE-01/c', status: 'not-run', phase: 'provision', durationMs: 0, reason: 'prerequisite-failed' });
  assert.equal((await third.finish(clean)).exitCode, 1);
  // Behavior cases can never be unsupported: they become failures and exit 1.
  const fourth = await createEvidence([defs[0]!], await temporary(t));
  await fourth.record({ id: 'SAFE-01/a', status: 'unsupported', phase: 'outputs', durationMs: 1, reason: 'gateway-delivery-unsupported', outputs: passing });
  const behavior = await fourth.finish(clean); assert.deepEqual([behavior.failed, behavior.unsupported, behavior.exitCode], [1, 0, 1]);
});

void test('fixture_failure_leaves_not_run_and_post_input_mismatch_stays_fail', async t => {
  const defs = [single('SAFE-01/a'), single('SAFE-01/b')];
  const evidence = await createEvidence(defs, await temporary(t));
  await recordConstructionDependents(evidence, defs);
  const summary = await evidence.finish(clean);
  assert.deepEqual([summary.passed, summary.failed, summary.notRun, summary.exitCode], [0, 0, 2, 1]);
  assert.equal(claimsFullCompletion(summary, 2, 2), false);
  // After an input was sent a mismatch is a failure; it is never turned back into not-run.
  const sent = await createEvidence([defs[0]!], await temporary(t));
  await sent.record({ id: 'SAFE-01/a', status: 'not-run', phase: 'logs', httpStatus: 200, durationMs: 1, reason: 'logs-missing' });
  const after = await sent.finish(clean); assert.deepEqual([after.failed, after.notRun, after.exitCode], [1, 0, 1]);
});

void test('http_success_without_storage_and_log_results_is_not_complete', async t => {
  const def = single('SAFE-01/a'); const evidence = await createEvidence([def], await temporary(t));
  await evidence.record({ id: def.id, status: 'pass', phase: 'complete', httpStatus: 200, durationMs: 1, outputs: [passing[0]!] });
  const summary = await evidence.finish(clean);
  assert.deepEqual([summary.passed, summary.failed, summary.exitCode], [0, 1, 1]);
  assert.equal(claimsFullCompletion(summary, 1, 1), false);
});

void test('not_applicable_output_requires_a_reason_and_canaries_never_reach_the_report', async t => {
  const reasonless: CaseDefinition = { ...single('SAFE-01/a'), outputs: [
    { kind: 'http', assertions: ['status'] }, { kind: 'dynamodb', assertions: [] }, { kind: 's3', assertions: ['unchanged'] }, { kind: 'logs', assertions: ['delivered'] },
  ] };
  await assert.rejects(createEvidence([reasonless], await temporary(t)), /INVALID_DEFINITION/);
  const directory = await temporary(t); const def = single('SAFE-01/a'); const evidence = await createEvidence([def], directory);
  const { runCase } = await import('../../e2e/floci/support/evidence.ts');
  await runCase(def, evidence, async () => { throw new Error('BODY_CANARY_7f3a authorization'); });
  await evidence.finish(clean);
  const saved = (await Promise.all((await readdir(directory)).map(name => readFile(join(directory, name), 'utf8')))).join('\n');
  assert.equal(saved.includes('BODY_CANARY_7f3a'), false);
  // The checked-in report carries no raw body, token or URL canary either.
  for (const doc of ['formal-e2e-results.md', 'formal-e2e-limitations.md', 'formal-e2e-README.md']) assert.doesNotMatch(read(`docs/operations/${doc}`), /eyJ[A-Za-z0-9_-]{10,}|Bearer [A-Za-z0-9]|X-Amz-Signature=|BODY_CANARY/);
});

void test('upper_layer_only_rows_do_not_require_live_cases', () => {
  for (const id of ['AUTH-08', 'SAFE-04']) {
    const row = coverageRows.find(item => item[0]!.startsWith(`${id} / `))!;
    assert.ok(!/[EIL]/.test(row[6]!), `${id} layer ${row[6]}`);
    assert.equal(definitions.filter(def => def.requirementId === id).length, 0, `${id} must not be a required live case`);
    assert.ok(requirementEvidence[id]!.length > 0);
  }
});

void test('documented_entrypoints_exist_in_package_scripts_and_registry', () => {
  const scripts = (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts;
  const guide = read('docs/operations/formal-e2e-README.md');
  for (const name of new Set([...guide.matchAll(/npm run ([a-z0-9:-]+)/g)].map(match => match[1]!))) assert.ok(scripts[name], `npm run ${name} is not defined`);
  for (const required of ['test:e2e:floci', 'test:e2e:terraform', 'test:integration:e2e']) assert.ok(guide.includes(`npm run ${required}`), required);
  const suites = new Set(definitions.map(def => def.suite));
  for (const suite of new Set([...guide.matchAll(/--suite ([a-z]+)/g)].map(match => match[1]!))) assert.ok(suites.has(suite), `--suite ${suite} is not a registry suite`);
  for (const suite of suites) assert.ok(guide.includes(`\`${suite}\``), `suite ${suite} is not described`);
  assert.match(read('README.md'), /formal-e2e-README\.md/);
});

void test('title_matching_counts_declared_tests_so_duplicates_and_missing_titles_are_caught', () => {
  const source = [
    "void test('alpha_one', () => {});", "void test('alpha_one', () => {});", "test(\"beta: first\", () => {});", "test('beta: second', () => {});", "it('gamma', () => {});",
  ].join('\n');
  const names = declaredTests(source);
  const count = (title: string): number => names.filter(name => titleMatches(title, name)).length;
  assert.equal(count('alpha_one'), 2, 'a duplicated test name is ambiguous');
  assert.equal(count('beta:'), 2, 'a family prefix matching two tests is not unique');
  assert.equal(count('beta: first'), 1);
  assert.equal(count('gamma'), 1);
  assert.equal(count('delta'), 0, 'a missing title matches nothing');
});
