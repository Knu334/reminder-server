import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { mkdtemp, writeFile, rm, readFile, readdir, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createEvidence, recordProcess, terraformActions, finalizeResults, runCase, evidenceContext, flushPendingLogs } from '../../tests/e2e/floci/support/evidence.ts';
import type { ProcessEvidence } from '../../tests/e2e/floci/support/evidence.ts';
import type { CaseDefinition, Evidence, ProvisionedStack, E2EFixture } from '../../tests/e2e/floci/support/types.ts';
import { definitions, caseActions, caseGuards, sharedCaseAuth } from '../../tests/e2e/floci/support/cases.ts';
import '../../tests/e2e/floci/support/auth-cases.ts';
import '../../tests/e2e/floci/support/api-cases.ts';

export const deadlines = { run: 75 * 60_000, cleanup: 15 * 60_000, total: 90 * 60_000, http: 30_000, terraform: 10 * 60_000, authExpiry: 330_000, logs: 60_000, scheduler: 90_000, cleanupInvoke: 700_000 } as const;
export class RunBudget {
  private readonly started: number;
  private cleanupStarted: number | undefined;
  constructor(private readonly clock: () => number = () => performance.now()) { this.started = clock(); }
  allow(phase: 'http' | 'terraform' | 'authExpiry' | 'logs' | 'scheduler' | 'cleanupInvoke'): number {
    if (this.cleanupStarted !== undefined) return 0;
    return this.clock() - this.started + deadlines[phase] <= deadlines.run ? deadlines[phase] : 0;
  }
  beginCleanup(): void { this.cleanupStarted ??= this.clock(); }
  cleanupRemaining(): number {
    if (this.cleanupStarted === undefined) return 0;
    return Math.max(0, Math.min(deadlines.cleanup - (this.clock() - this.cleanupStarted), deadlines.total - (this.clock() - this.started)));
  }
}
export function childEnvironment(): NodeJS.ProcessEnv {
  // Do not copy PATH, NODE_OPTIONS, npm config, credentials, profiles, proxy or
  // endpoint variables from the invoking process. Values below are synthetic.
  return {
    PATH: '/workspace/.worktrees/aws-sdd/.superpowers/tools/aws-sdd/node_modules/.bin:/workspace/.worktrees/aws-sdd/.superpowers/tools/aws-sdd/bin:/usr/local/bin:/usr/bin:/bin',
    CHECKPOINT_DISABLE: '1', TF_IN_AUTOMATION: '1', TF_CLI_CONFIG_FILE: '/dev/null',
    LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'UTC',
    AWS_REGION: 'ap-northeast-1', AWS_DEFAULT_REGION: 'ap-northeast-1',
    AWS_ACCESS_KEY_ID: 'local', AWS_SECRET_ACCESS_KEY: 'local', AWS_MAX_ATTEMPTS: '1',
    AWS_EC2_METADATA_DISABLED: 'true', AWS_CONFIG_FILE: '/dev/null', AWS_SHARED_CREDENTIALS_FILE: '/dev/null',
    AWS_ENDPOINT_URL: 'http://floci:4566',
    NPM_CONFIG_USERCONFIG: '/dev/null', NPM_CONFIG_GLOBALCONFIG: '/dev/null', PYTHONNOUSERSITE: '1',
  };
}
export async function runChild(tool: ProcessEvidence['tool'], args: string[], options: { cwd: string; timeoutMs: number; expectedOutput?: string; stdin?: string; captureStdout?: (text: string) => void; captureStderr?: (text: string) => void; terraformProxy?: string; signal?: AbortSignal; record?: (result: ProcessEvidence) => Promise<void> }): Promise<ProcessEvidence> {
  if (!['node', 'npm', 'python3', 'terraform'].includes(tool) || !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0 || options.timeoutMs > deadlines.terraform) throw new Error('CHILD_REJECTED');
  if (options.terraformProxy && (tool !== 'terraform' || !/^http:\/\/e2e:[a-f0-9]{48}@127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(options.terraformProxy))) throw new Error('CHILD_REJECTED');
  if ((options.stdin !== undefined || options.captureStdout || options.captureStderr) && (tool !== 'terraform' || args.join(' ') !== 'console -state=empty.tfstate -no-color' || options.stdin !== 'local.expected\n' || !options.captureStdout)) throw new Error('CHILD_REJECTED');
  if (options.stdin !== undefined) {
    const prefix = join(process.cwd(), '.superpowers/tools/aws-sdd/expected-iam/eval-');
    if (!options.cwd.startsWith(prefix) || !/^[A-Za-z0-9]{6}$/.test(options.cwd.slice(prefix.length)) || (await lstat(options.cwd)).isSymbolicLink()) throw new Error('CHILD_REJECTED');
    const files = await readdir(options.cwd); if (files.sort().join(',') !== 'empty.tfstate,expectations.tf') throw new Error('CHILD_REJECTED');
    for (const name of files) { const file = await lstat(join(options.cwd, name)); if (!file.isFile() || file.isSymbolicLink() || file.size > 262144) throw new Error('CHILD_REJECTED'); }
    const state = JSON.parse(await readFile(join(options.cwd, 'empty.tfstate'), 'utf8')) as { resources?: unknown[]; outputs?: object };
    if (state.resources?.length !== 0 || !state.outputs || Object.keys(state.outputs).length !== 0) throw new Error('CHILD_REJECTED');
    const config = await readFile(join(options.cwd, 'expectations.tf'), 'utf8');
    if (/\b(resource|data|provider|module|terraform|backend)\s+"?/.test(config.replace(/#[^\n]*/g, '').replace(/"(?:\\.|[^"\\])*"/g, '""')) || /\b(file[a-z0-9_]*|templatefile|pathexpand)\s*\(/.test(config)) throw new Error('CHILD_REJECTED');
  }
  const started = performance.now();
  const env = childEnvironment();
  if (options.terraformProxy) { env.HTTP_PROXY = options.terraformProxy; env.HTTPS_PROXY = options.terraformProxy; env.NO_PROXY = ''; }
  // npm rejects loading the same config filename at two levels. Use distinct
  // empty files owned by this invocation, with no ambient user/global config.
  const configDirectory = tool === 'npm' ? await mkdtemp(join(tmpdir(), 'e2e-child-')) : undefined;
  if (configDirectory) {
    env.NPM_CONFIG_USERCONFIG = join(configDirectory, 'user.npmrc');
    env.NPM_CONFIG_GLOBALCONFIG = join(configDirectory, 'global.npmrc');
    await writeFile(env.NPM_CONFIG_USERCONFIG, '', { mode: 0o600 });
    await writeFile(env.NPM_CONFIG_GLOBALCONFIG, '', { mode: 0o600 });
    env.NPM_CONFIG_CACHE = join(configDirectory, 'cache');
    env.NPM_CONFIG_LOGS_MAX = '0';
  }
  const result = await new Promise<ProcessEvidence>(resolve => {
    let timedOut = false; let stdout = ''; let stderr = ''; let overflow = false; let settled = false; let failedAction: string | undefined;
    const child = spawn(tool, args, { cwd: options.cwd, env, stdio: [options.stdin !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'], shell: false, detached: true });
    const kill = () => { timedOut = true; if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } } };
    const timer = setTimeout(kill, options.timeoutMs);
    options.signal?.addEventListener('abort', kill, { once: true });
    if (options.signal?.aborted) kill();
    child.stdout!.on('data', (chunk: Buffer) => {
      if ((options.expectedOutput !== undefined || options.captureStdout) && !overflow) {
        if (stdout.length + chunk.length > (options.captureStdout ? 262144 : 4096)) { overflow = true; stdout = ''; } else stdout += chunk.toString('utf8');
      }
    });
    child.stderr!.on('data', (chunk: Buffer) => {
      if (options.captureStderr && stderr.length + chunk.length <= 262144) stderr += chunk.toString('utf8');
      // Match only fixed API action names; raw Terraform diagnostics are discarded.
      const action = /operation error [A-Za-z0-9 ]+: ([A-Za-z0-9]+)/.exec(chunk.toString('utf8'))?.[1];
      if (action && terraformActions.has(action)) failedAction ??= action;
    });
    const finish = (exitCode: number | null) => {
      if (settled) return; settled = true; clearTimeout(timer); options.signal?.removeEventListener('abort', kill);
      resolve({ tool, status: timedOut ? 'timeout' : exitCode === 0 ? 'succeeded' : 'failed', exitCode,
        durationMs: Math.round(performance.now() - started), timeoutMs: options.timeoutMs,
        ...(failedAction ? { failedAction } : {}), expectedOutputMatched: options.expectedOutput !== undefined && !overflow && stdout.trim() === options.expectedOutput });
    };
    child.on('error', () => finish(null)); child.on('close', code => { options.captureStderr?.(stderr); if (code === 0 && !timedOut && !overflow) options.captureStdout?.(stdout); finish(code); });
    if (options.stdin !== undefined) { child.stdin?.on('error', () => undefined); child.stdin?.end(options.stdin); }
  });
  if (configDirectory) await rm(configDirectory, { recursive: true, force: true });
  await options.record?.(result);
  return result;
}
export async function runConstruction(evidence: Evidence, definition: CaseDefinition, construct: () => Promise<ProvisionedStack>): Promise<ProvisionedStack | undefined> {
  let stack: ProvisionedStack | undefined;
  await runCase(definition, evidence, async recorder => {
    try { stack = await construct(); }
    catch (error) {
      const { ProvisioningFailure } = await import('./terraform.ts');
      if (error instanceof ProvisioningFailure) { stack = error.ownedStack; throw error.unsupported ?? error; }
      throw error;
    }
    for (const output of stack.constructionOutputs) recorder.recordOutput(output);
  });
  return stack;
}
export async function recordConstructionDependents(evidence: Evidence, selected: CaseDefinition[], stack?: ProvisionedStack): Promise<void> {
  for (const def of selected.filter(def => def.id !== 'TF-01/apply')) await evidence.record({ id: def.id, status: 'not-run', phase: 'provision', durationMs: 0, reason: stack?.constructionOutputs.length ? 'implementation-pending' : 'prerequisite-failed' });
}
export async function runMain(argv: string[]): Promise<0 | 1 | 2> {
  // Parse before DNS, files, children or any other external side effect.
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]; const value = argv[index + 1];
    if (!key || !['--layer', '--suite', '--case'].includes(key) || !value || flags.has(key)) { console.error('E2E_INVALID_SELECTION'); return 2; }
    flags.set(key, value);
  }
  const layer = flags.get('--layer') ?? 'floci';
  const suite = flags.get('--suite'); const caseId = flags.get('--case');
  const inventory = definitions.map(def => structuredClone(def));
  const selected = inventory.filter(def => (layer !== 'terraform' || (def.suite === 'terraform' && def.layer === 'L')) && (!suite || def.suite === suite) && (!caseId || def.id === caseId));
  if (!['floci', 'terraform'].includes(layer) || !selected.length) { console.error('E2E_INVALID_SELECTION'); return 2; }
  const partial = selected.length !== definitions.length || suite !== undefined || caseId !== undefined || layer === 'terraform';
  console.log(partial ? 'E2E_PARTIAL_SELECTION' : 'E2E_FOUNDATION_INVENTORY');
  const budget = new RunBudget();
  let exit: 0 | 1 | 2 = 1; let driverFailed = false; let suiteErrors = 0;
  const controller = new AbortController(); const cancel = () => controller.abort();
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try {
    const evidence = await createEvidence(selected, join(process.cwd(), 'artifacts', 'formal-e2e', `e2e-${randomUUID()}`));
    await writeFile(join(evidenceContext(evidence).directory, 'inventory.json'), JSON.stringify(inventory, null, 2) + '\n', { mode: 0o600 });
    let stack: ProvisionedStack | undefined; let fixture: E2EFixture | undefined; let phase = 'preflight';
    try {
      const { preflight } = await import('./preflight.ts');
      const target = await preflight(result => recordProcess(evidence, result));
      const definition = layer === 'terraform' ? selected.find(def => def.id === 'TF-01/apply') : inventory.find(def => def.id === 'TF-01/apply');
      if (definition) {
        phase = 'provision';
        if (!budget.allow('terraform') || controller.signal.aborted) await evidence.record({ id: definition.id, status: 'not-run', phase: 'provision', durationMs: 0, reason: 'budget-exhausted' });
        else {
          const construct = async () => {
          const { prepareArtifact } = await import('./prepare-artifact.ts');
          const artifact = await prepareArtifact(evidenceContext(evidence).directory, { budget, signal: controller.signal, record: result => recordProcess(evidence, result) });
          const { provisionStack } = await import('./terraform.ts');
          return provisionStack(target, { publication: false, budget, signal: controller.signal }, artifact, evidence);
          };
          if (selected.some(def => def.id === definition.id)) stack = await runConstruction(evidence, definition, construct);
          else { try { stack = await construct(); } catch (error) { const { ProvisioningFailure } = await import('./terraform.ts'); if (error instanceof ProvisioningFailure) stack = error.ownedStack; } }
        }
      }
      if (layer !== 'terraform' && stack?.constructionOutputs.length === 4) {
        phase = 'fixture'; const { createRunFixture, readDeployedSettings } = await import('../../tests/e2e/floci/support/fixture.ts');
        fixture = await createRunFixture(stack, evidence, { budget, signal: controller.signal });
        const ready = await runFixturePrerequisites(evidence, selected, fixture);
        const remaining = selected.filter(def => !['TF-01/apply', 'TF-03/settings', 'TF-03/settings-final', 'OBS-02/smoke', 'OBS-03/gateway-refusal', 'OBS-04/gateway-delivery'].includes(def.id));
        const executable = remaining.filter(def => caseActions.has(def.id));
        if (ready && executable.length) {
          const { createFixture, fixtureState, fixtureStates } = await import('../../tests/e2e/floci/support/fixture.ts');
          const { createCaseAuth } = await import('../../tests/e2e/floci/support/auth.ts');
          const { suiteLogStates, cleanupChecksMatch, cleanupCaseMatches } = await import('../../tests/e2e/floci/support/logs.ts');
          const suiteResult = await executeSuites(executable, {
            create: suite => createFixture({ suite, publication: true }, fixture!),
            async action(def, suite) { if (caseGuards.get(def.id)?.(suite)) { await evidence.record({ id: def.id, status: 'not-run', phase: 'provision', durationMs: 0, reason: 'prerequisite-failed' }); return; } await runCase(def, evidence, async recorder => { const view = { ...suite, auth: await createCaseAuth(suite, sharedCaseAuth.has(def.suite) ? `${def.suite}-default` : def.id) }; fixtureStates.set(view, fixtureState(suite)); suiteLogStates.set(view, suiteLogStates.get(suite)!); await caseActions.get(def.id)!(view, recorder); }); },
            async flush(suite) { const state = suiteLogStates.get(suite)!; await flushPendingLogs(evidence, async checks => { const results = await state.observer.flush(checks, Math.max(state.lastInput, fixtureState(suite).lastInput), 60_000, () => cleanupChecksMatch(state)); return results.map(result => ({ ...result, matched: result.matched && cleanupCaseMatches(state, result.caseId) })); }); },
            reset: suite => suite.resetSuite(),
            blocked: def => evidence.record({ id: def.id, status: 'not-run', phase: 'provision', durationMs: 0, reason: 'prerequisite-failed' }),
          });
          suiteErrors += suiteResult.errors;
        }
        await recordUnstarted(evidence, remaining, ready);
        const finalSettings = selected.find(def => def.id === 'TF-03/settings-final');
        const { fixtureState } = await import('../../tests/e2e/floci/support/fixture.ts');
        if (fixtureState(fixture).settingsComplete) {
          if (finalSettings) await runCase(finalSettings, evidence, async recorder => { await readDeployedSettings(fixture!); for (const output of finalSettings.outputs) recorder.recordOutput({ kind: output.kind, status: 'pass', assertions: output.assertions.map(name => ({ name, status: 'pass' })) }); });
          else await readDeployedSettings(fixture);
        } else if (finalSettings) await evidence.record({ id: finalSettings.id, status: 'not-run', phase: 'provision', durationMs: 0, reason: 'prerequisite-failed' });
      } else await recordConstructionDependents(evidence, selected, stack);
    } catch {
      driverFailed = true; exit = phase === 'preflight' ? 2 : 1;
      for (const def of selected) { try { await evidence.record({ id: def.id, status: 'not-run', phase: phase === 'preflight' ? 'preflight' : 'provision', durationMs: 0, reason: phase === 'preflight' ? 'preflight-failed' : 'prerequisite-failed' }); } catch (error) { if (!(error instanceof Error) || error.message !== 'INVALID_CASE_TRANSITION') throw error; } }
    } finally {
      await finalizeResults(evidence);
      budget.beginCleanup();
      let cleanup = { attempted: 0, succeeded: 0, errors: 0, leaks: 0 };
      if (stack) cleanup = await disposeRunOwned(stack, fixture);
      cleanup.errors += suiteErrors + (driverFailed ? 1 : 0);
      const summary = await evidence.finish(cleanup);
      if (exit !== 2) exit = driverFailed ? 1 : summary.exitCode;
      console.log(JSON.stringify({ runId: evidence.runId, partial, foundationOnly: false, ...summary, exitCode: exit }));
    }
  } catch { console.error('E2E_HARNESS_FAILED'); exit = 1; }
  finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
  return exit;
}
if (require.main === module) {
  void runMain(process.argv.slice(2)).then(code => { process.exitCode = code; }, () => { console.error('E2E_HARNESS_FAILED'); process.exitCode = 1; });
}

/** Cases never started stay not-run: prerequisite-failed when the settings/smoke gate failed, implementation-pending when no action exists. */
export async function recordUnstarted(evidence: Evidence, remaining: CaseDefinition[], ready: boolean): Promise<void> {
  for (const def of remaining.filter(def => !ready || !caseActions.has(def.id))) await evidence.record({ id: def.id, status: 'not-run', phase: 'provision', durationMs: 0, reason: ready ? 'implementation-pending' : 'prerequisite-failed' });
}

/** The one run-end disposal: the fixture owns SDK recovery and Terraform teardown, so it is called exactly once. */
export async function disposeRunOwned(stack: ProvisionedStack, fixture: E2EFixture | undefined): Promise<{ attempted: number; succeeded: number; errors: number; leaks: number }> {
  try { return fixture ? await fixture.dispose() : await stack.destroy(); } catch { return { attempted: 1, succeeded: 0, errors: 1, leaks: 0 }; }
}

/** Settings and real delivery are prerequisites even for a filtered case selection. */
export async function runFixturePrerequisites(evidence: Evidence, selected: CaseDefinition[], fixture: import('../../tests/e2e/floci/support/types.ts').E2EFixture): Promise<boolean> {
  const { readDeployedSettings, fixtureSmoke, fixtureState } = await import('../../tests/e2e/floci/support/fixture.ts');
  const settings = selected.find(def => def.id === 'TF-03/settings');
  let settingsFailed = false;
  if (settings) await runCase(settings, evidence, async recorder => { await readDeployedSettings(fixture); for (const output of settings.outputs) recorder.recordOutput({ kind: output.kind, status: 'pass', assertions: output.assertions.map(name => ({ name, status: 'pass' })) }); });
  else { try { await readDeployedSettings(fixture); } catch { settingsFailed = true; } }
  await writeFile(join(evidenceContext(evidence).directory, 'fixture-settings.json'), JSON.stringify({ complete: fixtureState(fixture).settingsComplete, phase: fixtureState(fixture).readbackPhase, error: fixtureState(fixture).readbackError, wire: fixtureState(fixture).readbackWirePrimary, independentReadback: fixtureState(fixture).independentReadback, failedCheck: fixtureState(fixture).readbackFailed, observed: fixtureState(fixture).readbackObserved, expectedSourceDigest: fixtureState(fixture).expectedIam?.sourceDigest }, null, 2) + '\n', { mode: 0o600 });
  if (settingsFailed || !fixtureState(fixture).settingsComplete) { for (const def of selected.filter(d => ['OBS-02/smoke', 'OBS-03/gateway-refusal', 'OBS-04/gateway-delivery'].includes(d.id))) await evidence.record({ id: def.id, status: 'not-run', phase: 'provision', durationMs: 0, reason: 'prerequisite-failed' }); return false; }
  const smokeDefinition = selected.find(def => def.id === 'OBS-02/smoke');
  let smoke: import('../../tests/e2e/floci/support/fixture.ts').SmokeResult | undefined;
  if (smokeDefinition) await runCase(smokeDefinition, evidence, async recorder => { smoke = await fixtureSmoke(fixture, status => recorder.recordInput({ httpStatus: status }));
    for (const output of smokeDefinition.outputs) { const matched = output.kind === 'http' ? smoke.statuses.every((status, index) => status === [503, 200, 200, 401, 200][index]) : output.kind === 'logs' ? smoke.logs && smoke.cleanupLogs : smoke.unchanged; recorder.recordOutput({ kind: output.kind, status: matched ? 'pass' : 'fail', assertions: output.assertions.map(name => ({ name, status: matched ? 'pass' : 'fail' })) }); }
  }); else smoke = await fixtureSmoke(fixture);
  smoke ??= fixtureState(fixture).smokeObserved;
  await writeFile(join(evidenceContext(evidence).directory, 'fixture-smoke.json'), JSON.stringify(smoke ?? { started: false }, null, 2) + '\n', { mode: 0o600 });
  for (const def of selected.filter(d => ['OBS-03/gateway-refusal', 'OBS-04/gateway-delivery'].includes(d.id))) {
    if (!smoke || smoke.statuses.length < (def.id.startsWith('OBS-03') ? 4 : 2)) { await evidence.record({ id: def.id, status: 'not-run', phase: 'provision', durationMs: 0, reason: 'prerequisite-failed' }); continue; }
    if (def.id === 'OBS-04/gateway-delivery' && smoke?.logs && smoke.gatewayObserved === 0) {
      await evidence.record({ id: def.id, status: 'unsupported', phase: 'logs', durationMs: 0, reason: 'gateway-delivery-unsupported', httpStatus: smoke.statuses[1]!, outputs: def.outputs.map(output => output.assertions.length ? { kind: output.kind, status: 'pass', assertions: output.assertions.map(name => ({ name, status: 'pass' })) } : { kind: output.kind, status: 'not-applicable', assertions: [], reason: output.notApplicableReason! }) }); continue;
    }
    await runCase(def, evidence, async recorder => {
      recorder.recordInput({ httpStatus: smoke!.statuses[def.id.startsWith('OBS-03') ? 3 : 1]! });
      for (const output of def.outputs) { if (!output.assertions.length) recorder.recordOutput({ kind: output.kind, status: 'not-applicable', assertions: [], reason: output.notApplicableReason! }); else { const matched = def.id.startsWith('OBS-03') ? output.kind === 'logs' ? smoke!.rejection : output.kind === 'http' ? smoke!.statuses[3] === 401 : smoke!.unchanged : smoke!.gatewayLogs; recorder.recordOutput({ kind: output.kind, status: matched ? 'pass' : 'fail', assertions: output.assertions.map(name => ({ name, status: matched ? 'pass' : 'fail' })) }); } }
    });
  }
  return fixtureState(fixture).smokeComplete;
}

export async function executeSuites<T>(selected: CaseDefinition[], hooks: { create(suite: string): Promise<T>; action(def: CaseDefinition, suite: T): Promise<void>; flush(suite: T): Promise<void>; reset(suite: T): Promise<unknown>; blocked(def: CaseDefinition): Promise<void> }): Promise<{ errors: number }> {
  let blocked = false; let errors = 0;
  for (const name of new Set(selected.map(def => def.suite))) {
    const definitions = selected.filter(def => def.suite === name);
    if (blocked) { for (const def of definitions) await hooks.blocked(def); continue; }
    let suite: T | undefined; let started = 0; let flushAttempted = false;
    try { suite = await hooks.create(name); for (const def of definitions) { started++; await hooks.action(def, suite); } flushAttempted = true; await hooks.flush(suite); const cleanup = await hooks.reset(suite) as { errors?: number; leaks?: number } | undefined; if (cleanup?.errors || cleanup?.leaks) throw new Error('RESET_FAILED'); }
    catch { blocked = true; errors++; if (suite && !flushAttempted) { try { await hooks.flush(suite); } catch { /* executed cases retain their failure */ } } for (const def of definitions.slice(started)) await hooks.blocked(def); }
  }
  return { errors };
}
