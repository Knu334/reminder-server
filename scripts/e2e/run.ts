import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createEvidence, recordProcess, terraformActions, finalizeResults, runCase, evidenceContext } from '../../tests/e2e/floci/support/evidence.ts';
import type { ProcessEvidence } from '../../tests/e2e/floci/support/evidence.ts';
import type { CaseDefinition, Evidence, ProvisionedStack } from '../../tests/e2e/floci/support/types.ts';
import { definitions } from '../../tests/e2e/floci/support/cases.ts';

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
export async function runChild(tool: ProcessEvidence['tool'], args: string[], options: { cwd: string; timeoutMs: number; expectedOutput?: string; terraformProxy?: string; signal?: AbortSignal; record?: (result: ProcessEvidence) => Promise<void> }): Promise<ProcessEvidence> {
  if (!['node', 'npm', 'python3', 'terraform'].includes(tool) || !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0 || options.timeoutMs > deadlines.terraform) throw new Error('CHILD_REJECTED');
  if (options.terraformProxy && (tool !== 'terraform' || !/^http:\/\/e2e:[a-f0-9]{48}@127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(options.terraformProxy))) throw new Error('CHILD_REJECTED');
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
    let timedOut = false; let stdout = ''; let overflow = false; let settled = false; let failedAction: string | undefined;
    const child = spawn(tool, args, { cwd: options.cwd, env, stdio: ['ignore', 'pipe', 'pipe'], shell: false, detached: true });
    const kill = () => { timedOut = true; if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } } };
    const timer = setTimeout(kill, options.timeoutMs);
    options.signal?.addEventListener('abort', kill, { once: true });
    if (options.signal?.aborted) kill();
    child.stdout.on('data', (chunk: Buffer) => {
      if (options.expectedOutput !== undefined && !overflow) {
        if (stdout.length + chunk.length > 4096) { overflow = true; stdout = ''; } else stdout += chunk.toString('utf8');
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
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
    child.on('error', () => finish(null)); child.on('close', finish);
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
  const selected = definitions.filter(def => (layer !== 'terraform' || (def.suite === 'terraform' && def.layer === 'L')) && (!suite || def.suite === suite) && (!caseId || def.id === caseId));
  if (!['floci', 'terraform'].includes(layer) || !selected.length) { console.error('E2E_INVALID_SELECTION'); return 2; }
  const partial = selected.length !== definitions.length || suite !== undefined || caseId !== undefined || layer === 'terraform';
  console.log(partial ? 'E2E_PARTIAL_SELECTION' : 'E2E_FOUNDATION_INVENTORY');
  const budget = new RunBudget();
  let exit: 0 | 1 | 2 = 1;
  const controller = new AbortController(); const cancel = () => controller.abort();
  process.once('SIGINT', cancel); process.once('SIGTERM', cancel);
  try {
    const evidence = await createEvidence(selected, join(process.cwd(), 'artifacts', 'formal-e2e', `e2e-${randomUUID()}`));
    let stack: ProvisionedStack | undefined; let phase = 'preflight';
    try {
      const { preflight } = await import('./preflight.ts');
      const target = await preflight(result => recordProcess(evidence, result));
      const definition = selected.find(def => def.id === 'TF-01/apply');
      if (definition) {
        phase = 'provision';
        if (!budget.allow('terraform') || controller.signal.aborted) await evidence.record({ id: definition.id, status: 'not-run', phase: 'provision', durationMs: 0, reason: 'budget-exhausted' });
        else stack = await runConstruction(evidence, definition, async () => {
          const { prepareArtifact } = await import('./prepare-artifact.ts');
          const artifact = await prepareArtifact(evidenceContext(evidence).directory, { budget, signal: controller.signal, record: result => recordProcess(evidence, result) });
          const { provisionStack } = await import('./terraform.ts');
          return provisionStack(target, { publication: false, budget, signal: controller.signal }, artifact, evidence);
        });
      }
      // Task4 attaches sequential fixture/suite execution here. Construction is
      // shared once per run; unrelated foundation actions remain unimplemented.
      await recordConstructionDependents(evidence, selected, stack);
    } catch {
      exit = phase === 'preflight' ? 2 : 1;
      for (const def of selected) await evidence.record({ id: def.id, status: 'not-run', phase: phase === 'preflight' ? 'preflight' : 'provision', durationMs: 0, reason: phase === 'preflight' ? 'preflight-failed' : 'prerequisite-failed' });
    } finally {
      await finalizeResults(evidence);
      budget.beginCleanup();
      let cleanup = { attempted: 0, succeeded: 0, errors: 0, leaks: 0 };
      if (stack) { try { cleanup = await stack.destroy(); } catch { cleanup = { attempted: 1, succeeded: 0, errors: 1, leaks: 0 }; } }
      const summary = await evidence.finish(cleanup);
      if (exit !== 2) exit = summary.exitCode;
      console.log(JSON.stringify({ runId: evidence.runId, partial, foundationOnly: layer !== 'terraform', ...summary, exitCode: exit }));
    }
  } catch { console.error('E2E_HARNESS_FAILED'); exit = 1; }
  finally { process.removeListener('SIGINT', cancel); process.removeListener('SIGTERM', cancel); }
  return exit;
}
if (require.main === module) {
  void runMain(process.argv.slice(2)).then(code => { process.exitCode = code; }, () => { console.error('E2E_HARNESS_FAILED'); process.exitCode = 1; });
}
