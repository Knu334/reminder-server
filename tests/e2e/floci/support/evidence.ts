import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { CaseDefinition, CaseRecorder, CaseResult, Evidence, LogCheckResult, OutputResult, PendingLogCheck, RunSummary } from './types.ts';

const kinds = ['http', 'dynamodb', 's3', 'logs'] as const;
const phases = new Set(['inventory', 'preflight', 'provision', 'input', 'outputs', 'logs', 'complete', 'cleanup']);
const reasons = new Set(['implementation-pending', 'preflight-failed', 'prerequisite-failed', 'budget-exhausted', 'action-failed', 'output-mismatch', 'logs-pending', 'logs-missing', 'observer-failed', 'out-of-scope', 'gateway-delivery-unsupported', 'scheduler-trigger-unsupported', 'signature-enforcement-unsupported']);
const compatibilityReasons = new Set(['gateway-delivery-unsupported', 'scheduler-trigger-unsupported', 'signature-enforcement-unsupported']);
const codes = new Set(['INVALID_JSON', 'INVALID_INPUT', 'UNSUPPORTED_MEDIA_TYPE', 'PAYLOAD_TOO_LARGE', 'LEGACY_API_REMOVED', 'REMINDER_NOT_FOUND', 'THUMBNAIL_NOT_FOUND', 'INVALID_THUMBNAIL', 'THUMBNAIL_TOO_LARGE', 'OWNER_STORAGE_LIMIT_EXCEEDED', 'INVALID_LIMIT', 'INVALID_CURSOR', 'PRECONDITION_REQUIRED', 'PRECONDITION_FAILED', 'METHOD_NOT_ALLOWED', 'RATE_LIMIT_EXCEEDED', 'SERVICE_UNAVAILABLE', 'UNAUTHORIZED', 'FORBIDDEN']);
const label = /^[a-zA-Z0-9][a-zA-Z0-9/_.-]{0,159}$/;
type PendingCase = { definition: CaseDefinition; result: CaseResult; checks: PendingLogCheck[] };
export type ProcessEvidence = { tool: 'node' | 'npm' | 'python3' | 'terraform'; status: 'succeeded' | 'failed' | 'timeout'; durationMs: number; timeoutMs: number; exitCode: number | null; expectedOutputMatched: boolean };
type State = { directory: string; definitions: CaseDefinition[]; results: Map<string, CaseResult>; pending: Map<string, PendingCase>; active: Set<string>; processes: ProcessEvidence[]; closed: boolean };
const states = new WeakMap<Evidence, State>();
function stateOf(evidence: Evidence): State {
  const state = states.get(evidence);
  if (!state || state.closed) throw new Error('EVIDENCE_CLOSED');
  return state;
}
function validateDefinition(def: CaseDefinition): void {
  if (![def.id, def.requirementId, def.suite, def.source].every(value => label.test(value)) ||
      !['U', 'I', 'E', 'L', 'A'].includes(def.layer) || !['behavior', 'compatibility'].includes(def.acceptance) ||
      typeof def.required !== 'boolean' || def.outputs.length !== 4 || new Set(def.outputs.map(output => output.kind)).size !== 4 ||
      def.outputs.some(output => !kinds.includes(output.kind) || new Set(output.assertions).size !== output.assertions.length ||
        output.assertions.some(name => !label.test(name)) || (output.assertions.length === 0
          ? !output.notApplicableReason || !label.test(output.notApplicableReason) : output.notApplicableReason !== undefined))) {
    throw new Error('INVALID_DEFINITION');
  }
}
function safeOutputs(def: CaseDefinition, results: OutputResult[]): { outputs: OutputResult[]; complete: boolean } {
  let complete = results.length === 4;
  const projected: OutputResult[] = [];
  for (const expected of def.outputs) {
    const matches = results.filter(result => result.kind === expected.kind);
    if (matches.length !== 1) { complete = false; continue; }
    const actual = matches[0]!;
    if (expected.assertions.length === 0) {
      const valid = actual.status === 'not-applicable' && actual.assertions.length === 0 && actual.reason === expected.notApplicableReason;
      complete &&= valid;
      projected.push({ kind: expected.kind, status: valid ? 'not-applicable' : 'fail', assertions: [], reason: expected.notApplicableReason! });
      continue;
    }
    const valid = actual.status === 'pass' && actual.reason === undefined && actual.assertions.length === expected.assertions.length &&
      expected.assertions.every(name => actual.assertions.filter(assertion => assertion.name === name && assertion.status === 'pass').length === 1) &&
      new Set(actual.assertions.map(assertion => assertion.name)).size === actual.assertions.length;
    complete &&= valid;
    projected.push({ kind: expected.kind, status: valid ? 'pass' : 'fail', assertions: expected.assertions.flatMap(name => {
      const found = actual.assertions.filter(assertion => assertion.name === name);
      return found.length ? [{ name, status: found.length === 1 && found[0]!.status === 'pass' ? 'pass' as const : 'fail' as const }] : [];
    }) });
  }
  return { outputs: projected, complete };
}
function safeResult(def: CaseDefinition, result: CaseResult): CaseResult {
  const projection = safeOutputs(def, result.outputs ?? []);
  const status = ['pass', 'fail', 'not-run', 'unsupported', 'out-of-scope'].includes(result.status) ? result.status : 'fail';
  const safe: CaseResult = { id: def.id, status, phase: phases.has(result.phase) ? result.phase : 'outputs', durationMs: Number.isFinite(result.durationMs) && result.durationMs >= 0 ? Math.round(result.durationMs) : 0 };
  if (Number.isInteger(result.httpStatus) && result.httpStatus! >= 100 && result.httpStatus! <= 599) safe.httpStatus = result.httpStatus!;
  if (result.code && codes.has(result.code)) safe.code = result.code;
  if (result.reason && reasons.has(result.reason)) safe.reason = result.reason;
  if (result.outputs) safe.outputs = projection.outputs;
  if (status === 'not-run' && (result.httpStatus !== undefined || (result.outputs?.length ?? 0) > 0 || ['input', 'outputs', 'logs', 'complete'].includes(result.phase))) { safe.status = 'fail'; safe.reason = 'output-mismatch'; }
  if (status === 'pass' && !projection.complete) { safe.status = 'fail'; safe.reason = 'output-mismatch'; }
  if (status === 'unsupported' && (def.acceptance !== 'compatibility' || !projection.complete || !compatibilityReasons.has(safe.reason ?? ''))) {
    safe.status = 'fail'; safe.reason = 'output-mismatch';
  }
  if (status === 'out-of-scope' && def.layer !== 'A' && def.layer !== 'U') { safe.status = 'fail'; safe.reason = 'output-mismatch'; }
  return safe;
}
async function save(evidence: Evidence, state: State, summary?: RunSummary): Promise<void> {
  const cases = state.definitions.map(def => ({ ...def, result: state.results.get(def.id)! }));
  await writeFile(join(state.directory, 'results.json'), JSON.stringify({ runId: evidence.runId, cases, ...(summary ? { summary } : {}) }, null, 2) + '\n', { mode: 0o600 });
  // In-flight log checks contain sensitive correlation values, so only their safe partial results are persisted.
  await writeFile(join(state.directory, 'pending.json'), JSON.stringify({ cases: [...state.pending.values()].map(pending => safeResult(pending.definition, { ...pending.result, status: 'fail', reason: 'logs-pending' })) }, null, 2) + '\n', { mode: 0o600 });
  await writeFile(join(state.directory, 'manifest.json'), JSON.stringify({ runId: evidence.runId, resources: [], processes: state.processes }, null, 2) + '\n', { mode: 0o600 });
}
export async function createEvidence(definitions: CaseDefinition[], runDirectory: string): Promise<Evidence> {
  definitions.forEach(validateDefinition);
  if (!definitions.length || new Set(definitions.map(def => def.id)).size !== definitions.length) throw new Error('INVALID_DEFINITION');
  await mkdir(dirname(runDirectory), { recursive: true, mode: 0o700 });
  // Exclusive directory creation avoids adopting another run's files or symlinks.
  await mkdir(runDirectory, { mode: 0o700 });
  const safeDefinitions = definitions.map(def => ({
    id: def.id, requirementId: def.requirementId, layer: def.layer, required: def.required, acceptance: def.acceptance, suite: def.suite, source: def.source,
    outputs: def.outputs.map(output => ({ kind: output.kind, assertions: [...output.assertions], ...(output.notApplicableReason ? { notApplicableReason: output.notApplicableReason } : {}) })),
  }));
  const directoryId = basename(runDirectory);
  const state: State = { directory: runDirectory, definitions: safeDefinitions, results: new Map(), pending: new Map(), active: new Set(), processes: [], closed: false };
  const evidence: Evidence = {
    runId: /^e2e-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(directoryId) ? directoryId : `e2e-${randomUUID()}`,
    async record(result) {
      stateOf(evidence);
      const def = state.definitions.find(item => item.id === result.id);
      if (!def || state.active.has(result.id) || state.pending.has(result.id)) throw new Error('INVALID_CASE_TRANSITION');
      const prior = state.results.get(result.id)!;
      if (prior.status !== 'not-run' || prior.phase !== 'inventory') throw new Error('INVALID_CASE_TRANSITION');
      state.results.set(result.id, safeResult(def, result));
      await save(evidence, state);
    },
    async finish(cleanup) {
      stateOf(evidence);
      if (state.active.size) throw new Error('CASE_STILL_ACTIVE');
      await flushPendingLogs(evidence, async () => []);
      if (Object.values(cleanup).some(value => !Number.isSafeInteger(value) || value < 0) || cleanup.succeeded > cleanup.attempted) throw new Error('INVALID_CLEANUP');
      const all = [...state.results.values()];
      const summary: RunSummary = { selected: all.length, passed: 0, failed: 0, notRun: 0, unsupported: 0, outOfScope: 0,
        cleanup: { attempted: cleanup.attempted, succeeded: cleanup.succeeded, errors: cleanup.errors, leaks: cleanup.leaks }, exitCode: 0 };
      for (const result of all) {
        const key = { pass: 'passed', fail: 'failed', 'not-run': 'notRun', unsupported: 'unsupported', 'out-of-scope': 'outOfScope' } as const;
        summary[key[result.status]]++;
      }
      if (cleanup.errors || cleanup.leaks || cleanup.attempted !== cleanup.succeeded || all.some(result => {
        const def = state.definitions.find(item => item.id === result.id)!;
        return result.status === 'fail' || (def.required && result.status !== 'pass' && !(result.status === 'unsupported' && def.acceptance === 'compatibility') && !(result.status === 'out-of-scope' && (def.layer === 'A' || def.layer === 'U')));
      })) summary.exitCode = 1;
      if (!cleanup.errors && !cleanup.leaks && cleanup.attempted === cleanup.succeeded && !summary.failed && all.some(result => result.phase === 'preflight' && result.reason === 'preflight-failed')) summary.exitCode = 2;
      await save(evidence, state, summary); state.closed = true;
      return summary;
    },
  };
  for (const def of state.definitions) state.results.set(def.id, { id: def.id, status: 'not-run', phase: 'inventory', durationMs: 0, reason: 'implementation-pending' });
  states.set(evidence, state); await save(evidence, state); return evidence;
}
export async function recordProcess(evidence: Evidence, result: ProcessEvidence): Promise<void> {
  const state = stateOf(evidence);
  if (!['node', 'npm', 'python3', 'terraform'].includes(result.tool) || !['succeeded', 'failed', 'timeout'].includes(result.status)) throw new Error('INVALID_PROCESS_RESULT');
  state.processes.push({ tool: result.tool, status: result.status, durationMs: Math.max(0, Math.round(result.durationMs)), timeoutMs: result.timeoutMs, exitCode: result.exitCode, expectedOutputMatched: result.expectedOutputMatched === true });
  await save(evidence, state);
}
export async function runCase(definition: CaseDefinition, evidence: Evidence, action: (recorder: CaseRecorder) => Promise<void>): Promise<void> {
  const state = stateOf(evidence); const def = state.definitions.find(item => item.id === definition.id);
  if (!def || state.active.has(def.id) || state.pending.has(def.id) || state.results.get(def.id)?.phase !== 'inventory') throw new Error('INVALID_CASE_TRANSITION');
  state.active.add(def.id);
  const started = performance.now(); const outputs: OutputResult[] = []; const checks: PendingLogCheck[] = [];
  const result: CaseResult = { id: def.id, status: 'fail', phase: 'input', durationMs: 0, outputs };
  let open = true;
  const assertOpen = () => { if (!open) throw new Error('RECORDER_CLOSED'); };
  try {
    await action({
      recordInput(input) { assertOpen(); if (input.httpStatus !== undefined) result.httpStatus = input.httpStatus; if (input.code !== undefined) result.code = input.code; },
      recordOutput(output) { assertOpen(); outputs.push(structuredClone(output)); },
      deferLogs(check) {
        assertOpen();
        if (check.caseId !== def.id || !def.outputs.find(output => output.kind === 'logs')!.assertions.includes(check.assertion) || checks.some(item => item.assertion === check.assertion)) throw new Error('INVALID_LOG_CHECK');
        if (check.expectation.service === 'api' && check.expectation.mode === 'present' && (!check.expectation.requestId || !Number.isInteger(check.expectation.status))) throw new Error('INVALID_LOG_CHECK');
        checks.push(structuredClone(check));
      },
    });
    result.status = 'pass'; result.phase = checks.length ? 'logs' : 'complete';
  } catch { result.status = 'fail'; result.reason = 'action-failed'; }
  finally { open = false; result.durationMs = Math.round(performance.now() - started); state.active.delete(def.id); }
  if (checks.length) { state.pending.set(def.id, { definition: def, result, checks }); await save(evidence, state); }
  else await evidence.record(result);
}
export async function flushPendingLogs(evidence: Evidence, observe: (checks: PendingLogCheck[]) => Promise<LogCheckResult[]>): Promise<void> {
  const state = stateOf(evidence); const pending = [...state.pending.values()];
  if (!pending.length) return;
  let matches: LogCheckResult[] = []; let observerFailed = false;
  try { matches = await observe(structuredClone(pending.flatMap(item => item.checks))); } catch { observerFailed = true; }
  for (const item of pending) {
    const assertions = item.checks.map(check => {
      const found = matches.filter(match => match.caseId === check.caseId && match.assertion === check.assertion);
      const match = found[0];
      const controls = check.expectation.mode !== 'absent' || (check.controls?.before.mode === 'present' && check.controls.after.mode === 'present' &&
        check.expectation.until !== undefined && check.expectation.until >= check.expectation.since &&
        check.controls.before.since < check.expectation.since && check.controls.after.since > check.expectation.until &&
        match?.controlsMatched?.before === true && match.controlsMatched.after === true);
      return { name: check.assertion, status: found.length === 1 && match?.matched === true && controls && !observerFailed ? 'pass' as const : 'fail' as const };
    });
    const passed = assertions.every(assertion => assertion.status === 'pass');
    const outputs = [...(item.result.outputs ?? []), { kind: 'logs' as const, status: passed ? 'pass' as const : 'fail' as const, assertions }];
    state.pending.delete(item.definition.id);
    await evidence.record({ ...item.result, outputs, phase: 'logs', ...(passed ? {} : { status: 'fail' as const, reason: observerFailed ? 'observer-failed' : 'logs-missing' }) });
  }
}
