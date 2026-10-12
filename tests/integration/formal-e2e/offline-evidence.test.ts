import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEvidence } from '../../e2e/floci/support/evidence.ts';
import { definitions, offlineEvidence } from '../../e2e/floci/support/cases.ts';
import { RunBudget, runIntegrationCases } from '../../../scripts/e2e/run.ts';
import { judgeCase, parseJunit, runOfflineEvidence, runOfflineFile, titleMatches, type FileOutcome, type FileRunner, type TestOutcome } from '../../../scripts/e2e/offline-evidence.ts';
import type { CaseResult } from '../../e2e/floci/support/types.ts';

const clean = { attempted: 0, succeeded: 0, errors: 0, leaks: 0 };
const caseById = (id: string) => definitions.find(def => def.id === id)!;
async function temporary(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'offline-evidence-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
/** Titles of every link of the given cases, all reported as passed unless `override` names a different status. */
function runnerFor(ids: string[], override: (file: string, title: string) => TestOutcome['status'] | 'absent' = () => 'pass'): { runner: FileRunner; started: string[] } {
  const started: string[] = [];
  const runner: FileRunner = async file => {
    started.push(file);
    const tests: TestOutcome[] = [];
    for (const id of ids) for (const link of offlineEvidence[id]!) if (link.file === file) for (const title of link.titles) {
      const status = override(file, title); if (status !== 'absent') tests.push({ name: title.endsWith(':') ? `${title} variant` : `${title} and detail`, status });
    }
    return { kind: 'tests', tests };
  };
  return { runner, started };
}
async function resultsOf(directory: string): Promise<Map<string, CaseResult>> {
  const parsed = JSON.parse(await readFile(join(directory, 'results.json'), 'utf8')) as { cases: { id: string; result: CaseResult }[] };
  return new Map(parsed.cases.map(item => [item.id, item.result]));
}
const SINGLE = 'CLEAN-02/exact-boundary-i';
const MULTI = 'SAFE-01/transport';

void test('title_matching_is_exact_or_a_word_boundary_prefix_only', () => {
  assert.equal(titleMatches('a_b', 'a_b'), true);
  assert.equal(titleMatches('a_b', 'a_b_c'), false, 'a title never matches the middle of an identifier');
  assert.equal(titleMatches('a_b', 'a_bc'), false);
  assert.equal(titleMatches('a_b', 'x a_b'), false, 'nor by substring');
  assert.equal(titleMatches('a_b', 'a_b and more'), true, 'a prefix that ends on a word boundary matches');
  assert.equal(titleMatches('STORE-06/x-i:', 'STORE-06/x-i: both reject'), true, 'a family title ends with a colon');
  assert.equal(titleMatches('STORE-06/x-i:', 'STORE-06/x-i'), false);
  assert.equal(titleMatches('STORE-06/x-i:', 'other STORE-06/x-i: y'), false);
  assert.equal(titleMatches('', 'anything'), false);
});

void test('junit_report_parsing_distinguishes_pass_fail_skipped_todo_and_unparsable', () => {
  const report = (body: string) => `<?xml version="1.0" encoding="utf-8"?>\n<testsuites>\n${body}\n</testsuites>\n`;
  const parsed = parseJunit(report([
    '<testcase name="ok" classname="test" file="/x.test.ts"/>',
    '<testcase name="sk" classname="test" file="/x.test.ts"><skipped type="skipped" message="true"/></testcase>',
    '<testcase name="td" classname="test" file="/x.test.ts"><skipped type="todo" message="true"/></testcase>',
    '<testcase name="bad" classname="test" file="/x.test.ts" failure="boom"><failure type="testCodeFailure" message="boom">x</failure></testcase>',
    '<testsuite name="s"><testcase name="a &amp; &lt;b&gt; &quot;q&quot;" classname="test" file="/x.test.ts"/></testsuite>',
  ].join('\n')));
  assert.deepEqual(parsed, [
    { name: 'ok', status: 'pass' }, { name: 'sk', status: 'not-pass' }, { name: 'td', status: 'not-pass' }, { name: 'bad', status: 'fail' }, { name: 'a & <b> "q"', status: 'pass' },
  ]);
  assert.equal(parseJunit(''), undefined);
  assert.equal(parseJunit('<testsuites>\n<testcase name="cut"'), undefined, 'a truncated report is unparsable');
  assert.equal(parseJunit(report('')), undefined, 'a report with no test is unparsable');
  assert.equal(parseJunit(report('<testcase name="/x.test.ts" classname="test" file="/x.test.ts" failure="test failed"><failure type="testCodeFailure" message="test failed"/></testcase>')), undefined, 'a file-level failure is a crashed run');
});

void test('judgement_is_pass_only_when_every_title_matches_a_passed_test', () => {
  const links = [{ file: 'f1', titles: ['one', 'two:'] }, { file: 'f2', titles: ['three'] }];
  const tests = (...items: [string, TestOutcome['status']][]): FileOutcome => ({ kind: 'tests', tests: items.map(([name, status]) => ({ name, status })) });
  const base = new Map<string, FileOutcome>([['f1', tests(['one', 'pass'], ['two: a', 'pass'], ['two: b', 'pass'])], ['f2', tests(['three', 'pass'])]]);
  assert.deepEqual(judgeCase(links, base), { status: 'pass' });
  assert.deepEqual(judgeCase(links, new Map(base).set('f1', tests(['one', 'pass'], ['two: a', 'pass'], ['two: b', 'fail']))), { status: 'fail', reason: 'offline-test-failed' }, 'one failing family member fails the case');
  assert.deepEqual(judgeCase(links, new Map(base).set('f2', tests(['three', 'not-pass']))), { status: 'fail', reason: 'offline-test-failed' });
  assert.deepEqual(judgeCase(links, new Map(base).set('f2', tests(['threefold', 'pass']))), { status: 'fail', reason: 'offline-test-missing' });
  assert.deepEqual(judgeCase(links, new Map(base).set('f2', { kind: 'run-failed' })), { status: 'fail', reason: 'offline-run-failed' });
  assert.deepEqual(judgeCase(links, new Map(base).set('f1', tests(['one', 'fail'])).set('f2', { kind: 'run-failed' })), { status: 'fail', reason: 'offline-run-failed' }, 'a crashed run outranks a test failure');
  assert.deepEqual(judgeCase(links, new Map([['f1', base.get('f1')!]])), { status: 'not-run' }, 'an unstarted file never passes');
  assert.deepEqual(judgeCase(links, new Map([['f1', tests(['one', 'fail'])]])), { status: 'fail', reason: 'offline-test-failed' });
});

void test('all_matching_tests_passing_records_pass_with_every_assertion', async t => {
  const directory = join(await temporary(t), 'run');
  const evidence = await createEvidence([caseById(SINGLE), caseById(MULTI)], directory);
  const { runner } = runnerFor([SINGLE, MULTI]);
  await runOfflineEvidence(evidence, [caseById(SINGLE), caseById(MULTI)], { runner });
  const results = await resultsOf(directory);
  for (const id of [SINGLE, MULTI]) {
    const result = results.get(id)!;
    assert.deepEqual([result.status, result.phase, result.reason], ['pass', 'offline', undefined], id);
    const expected = caseById(id).outputs.flatMap(output => output.assertions);
    const recorded = result.outputs!.flatMap(output => output.assertions);
    assert.deepEqual(recorded.map(item => item.name), expected); assert.ok(recorded.every(item => item.status === 'pass'));
  }
  const summary = await evidence.finish(clean);
  assert.deepEqual([summary.passed, summary.failed, summary.notRun], [2, 0, 0]);
});

void test('failed_skipped_todo_and_missing_matches_fail_with_fixed_reasons', async t => {
  type Override = (file: string, title: string) => TestOutcome['status'] | 'absent';
  const cases: [string, Override, string][] = [
    ['failed', () => 'fail', 'offline-test-failed'], ['skipped or todo', () => 'not-pass', 'offline-test-failed'], ['missing', () => 'absent', 'offline-test-missing'],
  ];
  for (const [label, override, reason] of cases) {
    const directory = join(await temporary(t), 'run');
    const evidence = await createEvidence([caseById(SINGLE)], directory);
    await runOfflineEvidence(evidence, [caseById(SINGLE)], { runner: runnerFor([SINGLE], override).runner });
    const result = (await resultsOf(directory)).get(SINGLE)!;
    assert.deepEqual([label, result.status, result.phase, result.reason], [label, 'fail', 'offline', reason]);
    assert.ok(result.outputs!.flatMap(output => output.assertions).every(item => item.status === 'fail'), label);
    const summary = await evidence.finish(clean); assert.equal(summary.exitCode, 1, `${label} fails the run`);
  }
});

void test('a_crashed_file_fails_only_the_cases_mapped_to_that_file', async t => {
  const ids = ['CLEAN-02/exact-boundary-i', 'CLEAN-04/stale-gsi-and-claim-race-i', 'STORE-07/transaction-uncertain-outcomes-i'];
  const crashed = offlineEvidence[ids[2]!]![0]!.file;
  const directory = join(await temporary(t), 'run');
  const evidence = await createEvidence(ids.map(caseById), directory);
  const inner = runnerFor(ids).runner;
  const runner: FileRunner = async (file, options) => file === crashed ? { kind: 'run-failed' } : inner(file, options);
  await runOfflineEvidence(evidence, ids.map(caseById), { runner });
  const results = await resultsOf(directory);
  for (const id of ids) {
    const mapped = offlineEvidence[id]!.some(link => link.file === crashed);
    assert.deepEqual([id, results.get(id)!.status, results.get(id)!.reason], mapped ? [id, 'fail', 'offline-run-failed'] : [id, 'pass', undefined]);
  }
});

void test('the_budget_and_cancellation_leave_cases_not_run_never_passed', async t => {
  const directory = join(await temporary(t), 'run');
  const evidence = await createEvidence([caseById(SINGLE), caseById(MULTI)], directory);
  const spent = runnerFor([SINGLE, MULTI]);
  await runOfflineEvidence(evidence, [caseById(SINGLE)], { runner: spent.runner, allow: () => 0 });
  const controller = new AbortController(); controller.abort();
  await runOfflineEvidence(evidence, [caseById(MULTI)], { runner: spent.runner, signal: controller.signal });
  assert.deepEqual(spent.started, [], 'no child starts without budget or after cancellation');
  const results = await resultsOf(directory);
  for (const id of [SINGLE, MULTI]) assert.deepEqual([results.get(id)!.status, results.get(id)!.reason], ['not-run', 'budget-exhausted'], id);
  assert.equal((await evidence.finish(clean)).exitCode, 1);
  // The same through the run driver with a real RunBudget whose offline allowance is spent.
  const second = await createEvidence([caseById(SINGLE)], join(await temporary(t), 'run'));
  const budget = new RunBudget(() => 0); budget.beginCleanup();
  await runIntegrationCases(second, [caseById(SINGLE)], { budget, signal: new AbortController().signal });
  assert.equal((await second.finish(clean)).notRun, 1);
});

void test('i_cases_run_whatever_the_floci_gate_did_and_never_stay_implementation_pending', async t => {
  const ids = definitions.filter(def => def.layer === 'I').map(def => def.id);
  assert.equal(ids.length, 24);
  const directory = join(await temporary(t), 'run');
  const evidence = await createEvidence(definitions.filter(def => def.layer === 'I'), directory);
  // The driver entry needs no fixture, settings or smoke result: it is callable with nothing but evidence, a budget and a signal.
  const { runner, started } = runnerFor(ids);
  const { runOfflineEvidence: run } = await import('../../../scripts/e2e/offline-evidence.ts');
  await run(evidence, definitions.filter(def => def.layer === 'I'), { runner, allow: () => new RunBudget().allow('offline') });
  assert.ok(started.length > 0);
  const results = await resultsOf(directory);
  for (const id of ids) { const result = results.get(id)!; assert.deepEqual([id, result.status, result.reason], [id, 'pass', undefined]); }
  const summary = await evidence.finish(clean);
  assert.deepEqual([summary.selected, summary.passed, summary.notRun], [24, 24, 0]);
  // The driver wires the same thing: run.ts keeps layer I out of the not-run recorders.
  const source = await readFile(join(process.cwd(), 'scripts/e2e/run.ts'), 'utf8');
  assert.match(source, /const live = selected\.filter\(def => def\.layer !== 'I'\)/);
  assert.match(source, /recordConstructionDependents\(evidence, live, stack\)/);
  assert.match(source, /runFixturePrerequisites\(evidence, live, fixture\)/);
});

void test('the_offline_child_cannot_start_another_run', async t => {
  const evidence = await createEvidence([caseById(SINGLE)], join(await temporary(t), 'run'));
  process.env.E2E_OFFLINE_CHILD = '1'; t.after(() => { delete process.env.E2E_OFFLINE_CHILD; });
  await assert.rejects(runOfflineEvidence(evidence, [caseById(SINGLE)], { runner: runnerFor([SINGLE]).runner }), /OFFLINE_RECURSION/);
});

void test('a_real_child_reports_outcomes_and_no_raw_output_reaches_evidence_or_the_console', async t => {
  const directory = await temporary(t);
  const canary = 'CANARY-offline-9f3a1c';
  const sample = join(directory, 'sample.test.ts');
  await writeFile(sample, [
    "import { test } from 'node:test';",
    `test('passes', () => { console.log('${canary}-stdout'); console.error('${canary}-stderr'); });`,
    `test('fails', () => { throw new Error('${canary}-error'); });`,
    "test('skipped', { skip: true }, () => {});",
    "test('todo', { todo: true }, () => {});",
  ].join('\n'));
  const writes: string[] = [];
  t.mock.method(process.stdout, 'write', (chunk: unknown) => { writes.push(String(chunk)); return true; });
  t.mock.method(process.stderr, 'write', (chunk: unknown) => { writes.push(String(chunk)); return true; });
  const outcome = await runOfflineFile(sample, { timeoutMs: 60_000 });
  assert.equal(outcome.kind, 'tests');
  if (outcome.kind === 'tests') assert.deepEqual(outcome.tests.map(item => [item.name, item.status]), [['passes', 'pass'], ['fails', 'fail'], ['skipped', 'not-pass'], ['todo', 'not-pass']]);
  const serialized = JSON.stringify(outcome);
  assert.ok(!serialized.includes(canary), 'the outcome carries no raw output or error text');
  assert.ok(!writes.join('').includes(canary), 'nothing is printed');
  // Evidence written for a run with this crash/failure stays free of the canary too.
  const run = join(directory, 'run');
  const evidence = await createEvidence([caseById(SINGLE)], run);
  await runOfflineEvidence(evidence, [caseById(SINGLE)], { runner: async () => outcome });
  await evidence.finish(clean);
  const text = (await Promise.all((await readdir(run)).map(name => readFile(join(run, name), 'utf8')))).join('\n');
  assert.ok(!text.includes(canary));
});

void test('a_real_child_that_crashes_times_out_or_cannot_load_is_run_failed', async t => {
  const directory = await temporary(t);
  const write = async (name: string, body: string) => { const file = join(directory, name); await writeFile(file, body); return file; };
  const crash = await write('crash.test.ts', "import { test } from 'node:test'; test('a', () => {}); process.exit(3);");
  const syntax = await write('syntax.test.ts', 'test(');
  const hang = await write('hang.test.ts', "import { test } from 'node:test'; test('h', async () => { await new Promise(() => setInterval(() => undefined, 1000)); });");
  assert.deepEqual(await runOfflineFile(crash, { timeoutMs: 60_000 }), { kind: 'run-failed' });
  assert.deepEqual(await runOfflineFile(syntax, { timeoutMs: 60_000 }), { kind: 'run-failed' });
  assert.deepEqual(await runOfflineFile(hang, { timeoutMs: 1500 }), { kind: 'run-failed' }, 'a timeout kills the child and fails the run');
  const controller = new AbortController(); setTimeout(() => controller.abort(), 700);
  assert.deepEqual(await runOfflineFile(hang, { timeoutMs: 60_000, signal: controller.signal }), { kind: 'run-failed' }, 'cancellation kills the child');
  assert.deepEqual(await runOfflineFile(join(directory, 'absent.test.ts'), { timeoutMs: 60_000 }), { kind: 'run-failed' });
});

void test('a_crash_after_passing_tests_is_run_failed_even_for_a_repo_relative_path', async t => {
  const directory = await temporary(t);
  const { relative } = await import('node:path');
  const relativeTo = (file: string) => relative(process.cwd(), file); // Node names a file-level failure after the path as given on the command line
  const write = async (name: string, body: string) => { const file = join(directory, name); await writeFile(file, body); return relativeTo(file); };
  const exitAfter = await write('exit.test.ts', "import { test } from 'node:test'; test('a', () => {}); test('b', () => { setTimeout(() => process.exit(3), 5); });");
  const asyncError = await write('async.test.ts', "import { test } from 'node:test'; test('a', () => {}); test('b', () => { setTimeout(() => { throw new Error('late'); }, 5); });");
  const plain = await write('plain.test.ts', "import { test } from 'node:test'; test('a', () => {});");
  assert.ok(!exitAfter.startsWith('/'), 'the probe path is relative');
  assert.deepEqual(await runOfflineFile(exitAfter, { timeoutMs: 60_000 }), { kind: 'run-failed' });
  assert.deepEqual(await runOfflineFile(asyncError, { timeoutMs: 60_000 }), { kind: 'run-failed' });
  assert.deepEqual(await runOfflineFile(plain, { timeoutMs: 60_000 }), { kind: 'tests', tests: [{ name: 'a', status: 'pass' }] });
  // A file that cannot load (syntax error) is a crashed run (offline-run-failed), not a missing title.
  assert.deepEqual(await runOfflineFile(await write('syntax.test.ts', 'test('), { timeoutMs: 60_000 }), { kind: 'run-failed' });
});

void test('a_link_without_titles_never_passes', () => {
  assert.deepEqual(judgeCase([{ file: 'f', titles: [] }], new Map<string, FileOutcome>([['f', { kind: 'tests', tests: [{ name: 'x', status: 'pass' }] }]])), { status: 'fail', reason: 'offline-test-missing' });
  assert.deepEqual(judgeCase([], new Map()), { status: 'fail', reason: 'offline-test-missing' });
});

void test('junit_attribute_edge_cases_are_parsed_exactly_or_fail_closed', () => {
  const wrap = (body: string) => `<?xml version="1.0" encoding="utf-8"?>\n<testsuites>\n${body}\n</testsuites>\n`;
  // An unescaped '>' inside an attribute value does not end the tag early.
  assert.deepEqual(parseJunit(wrap('<testcase name="a > b" classname="test" file="/x.test.ts"/>')), [{ name: 'a > b', status: 'pass' }]);
  assert.deepEqual(parseJunit(wrap('<testcase name="a > b" classname="test" file="/x.test.ts" failure="x > y"><failure message="m"/></testcase>')), [{ name: 'a > b', status: 'fail' }]);
  // A double-escaped quote decodes once: the name keeps the literal entity text and never becomes a different title.
  assert.deepEqual(parseJunit(wrap('<testcase name="say &amp;quot;hi&amp;quot;" classname="test" file="/x.test.ts"/>')), [{ name: 'say &quot;hi&quot;', status: 'pass' }]);
  // A raw quote or any attribute that is not name="value" makes the report unparsable instead of guessing.
  assert.equal(parseJunit(wrap('<testcase name="a"b" classname="test" file="/x.test.ts"/>')), undefined);
  assert.equal(parseJunit(wrap('<testcase name="ok" classname="test" file="/x.test.ts"/>\n<testcase name=unquoted classname="test"/>')), undefined);
  assert.equal(parseJunit(wrap('<testcase classname="test" file="/x.test.ts"/>')), undefined, 'no name');
  // A failed test is not hidden by a later passing test of the same name being the only one parsed.
  assert.deepEqual(parseJunit(wrap('<testcase name="d" file="/x.test.ts" failure="x"><failure/></testcase><testcase name="d" file="/x.test.ts"/>'))!.map(item => item.status), ['fail', 'pass']);
});

void test('budget_exhausted_cases_use_the_offline_phase', async t => {
  const directory = join(await temporary(t), 'run');
  const evidence = await createEvidence([caseById(SINGLE)], directory);
  await runOfflineEvidence(evidence, [caseById(SINGLE)], { runner: runnerFor([SINGLE]).runner, allow: () => 0 });
  const result = (await resultsOf(directory)).get(SINGLE)!;
  assert.deepEqual([result.status, result.phase, result.reason], ['not-run', 'offline', 'budget-exhausted']);
});
