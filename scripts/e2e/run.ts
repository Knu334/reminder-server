import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createEvidence, recordProcess } from '../../tests/e2e/floci/support/evidence.ts';
import type { ProcessEvidence } from '../../tests/e2e/floci/support/evidence.ts';
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
    PATH: '/tmp/aws-sdd-tools/node_modules/.bin:/tmp/aws-sdd-tools/bin:/usr/local/bin:/usr/bin:/bin',
    LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'UTC',
    AWS_REGION: 'ap-northeast-1', AWS_DEFAULT_REGION: 'ap-northeast-1',
    AWS_ACCESS_KEY_ID: 'local', AWS_SECRET_ACCESS_KEY: 'local', AWS_MAX_ATTEMPTS: '1',
    AWS_EC2_METADATA_DISABLED: 'true', AWS_CONFIG_FILE: '/dev/null', AWS_SHARED_CREDENTIALS_FILE: '/dev/null',
    AWS_ENDPOINT_URL: 'http://floci:4566',
    NPM_CONFIG_USERCONFIG: '/dev/null', NPM_CONFIG_GLOBALCONFIG: '/dev/null', PYTHONNOUSERSITE: '1',
  };
}
export async function runChild(tool: ProcessEvidence['tool'], args: string[], options: { cwd: string; timeoutMs: number; expectedOutput?: string; signal?: AbortSignal; record?: (result: ProcessEvidence) => Promise<void> }): Promise<ProcessEvidence> {
  if (!['node', 'npm', 'python3', 'terraform'].includes(tool) || !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0 || options.timeoutMs > deadlines.terraform) throw new Error('CHILD_REJECTED');
  const started = performance.now();
  const env = childEnvironment();
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
    let timedOut = false; let stdout = ''; let overflow = false; let settled = false;
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
    child.stderr.on('data', () => { /* Drain without storing or forwarding raw diagnostics. */ });
    const finish = (exitCode: number | null) => {
      if (settled) return; settled = true; clearTimeout(timer); options.signal?.removeEventListener('abort', kill);
      resolve({ tool, status: timedOut ? 'timeout' : exitCode === 0 ? 'succeeded' : 'failed', exitCode,
        durationMs: Math.round(performance.now() - started), timeoutMs: options.timeoutMs,
        expectedOutputMatched: options.expectedOutput !== undefined && !overflow && stdout.trim() === options.expectedOutput });
    };
    child.on('error', () => finish(null)); child.on('close', finish);
  });
  if (configDirectory) await rm(configDirectory, { recursive: true, force: true });
  await options.record?.(result);
  return result;
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
  const selected = definitions.filter(def => (layer !== 'terraform' || def.suite === 'terraform') && (!suite || def.suite === suite) && (!caseId || def.id === caseId));
  if (!['floci', 'terraform'].includes(layer) || !selected.length) { console.error('E2E_INVALID_SELECTION'); return 2; }
  const partial = selected.length !== definitions.length || suite !== undefined || caseId !== undefined || layer === 'terraform';
  console.log(partial ? 'E2E_PARTIAL_SELECTION' : 'E2E_FOUNDATION_INVENTORY');
  const budget = new RunBudget();
  let exit: 0 | 1 | 2 = 1;
  try {
    const evidence = await createEvidence(selected, join(process.cwd(), 'artifacts', 'formal-e2e', `e2e-${randomUUID()}`));
    try {
      const { preflight } = await import('./preflight.ts');
      await preflight(result => recordProcess(evidence, result));
      // Task3 supplies provisioning; Task4 supplies gated sequential execution.
      // Inventory remains not-run until those actions actually exist.
    } catch {
      exit = 2;
      for (const def of selected) await evidence.record({ id: def.id, status: 'not-run', phase: 'preflight', durationMs: 0, reason: 'preflight-failed' });
    } finally {
      budget.beginCleanup();
      const summary = await evidence.finish({ attempted: 0, succeeded: 0, errors: 0, leaks: 0 });
      if (exit !== 2) exit = summary.exitCode;
      console.log(JSON.stringify({ partial, foundationOnly: true, ...summary, exitCode: exit }));
    }
  } catch { console.error('E2E_HARNESS_FAILED'); exit = 1; }
  return exit;
}
if (require.main === module) {
  void runMain(process.argv.slice(2)).then(code => { process.exitCode = code; }, () => { console.error('E2E_HARNESS_FAILED'); process.exitCode = 1; });
}
