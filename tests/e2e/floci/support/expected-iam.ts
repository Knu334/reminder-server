import { mkdir, mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { runChild, type RunBudget } from '../../../../scripts/e2e/run.ts';
import { assertRegular } from '../../../../scripts/e2e/terraform-source.ts';
import type { ProvisionedStack } from './types.ts';
const repository = resolve(__dirname, '../../../..');
const sourcePaths = ['infra/bootstrap/storage.tf', 'infra/bootstrap/oidc.tf', 'infra/bootstrap/runtime-roles.tf', 'infra/platform/production/storage.tf', 'infra/platform/production/iam.tf', 'infra/application/production/scheduler.tf'] as const;
/** Balanced HCL blocks, with quoted-string/comment state; no state/provider parser. */
export function blocks(source: string, pattern: RegExp): string[] {
  const result: string[] = []; for (const match of source.matchAll(pattern)) { const start = match.index! + match[0].lastIndexOf('{'); let depth = 0; let string = false; let escaped = false; let comment = false;
    for (let i = start; i < source.length; i++) { const c = source[i]!; if (comment) { if (c === '\n') comment = false; continue; } if (string) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') string = false; continue; } if (c === '#') { comment = true; continue; } if (c === '"') { string = true; continue; } if (c === '{') depth++; if (c === '}' && --depth === 0) { result.push(source.slice(start, i + 1)); break; } } }
  return result;
}
function jsonExpression(source: string, resource: string, name: string, attribute: string): string { const block = blocks(source, new RegExp(`resource "${resource}" "${name}" \\{`, 'g'))[0]; if (!block) throw new Error('EXPECTED_POLICY_REJECTED'); const match = new RegExp(`${attribute}\\s*=\\s*jsonencode\\(`).exec(block); if (!match) throw new Error('EXPECTED_POLICY_REJECTED'); const expression = blocks(block.slice(match.index), /jsonencode\(\{/g)[0]; if (!expression) throw new Error('EXPECTED_POLICY_REJECTED'); return `jsonencode(${expression})`; }
export type ExpectedIam = { runtimeCeiling: Record<string, string>; githubPolicies: Record<string, string>; productionRead: string; runtimeTrust: Record<string, string>; githubTrust: Record<string, string>; platformPolicies: Record<string, string>; schedulerPolicy: string; bucketPolicies: Record<string, string>; imagesBucketPolicy: string; sourceDigest: string };
export function canonicalPolicy(doc: unknown): string {
  const normalizeConditions = (conditions: Record<string, unknown>): unknown => {
    const operators = new Map<string, Map<string, unknown>>();
    for (const [operator, entries] of Object.entries(conditions)) {
      if (!entries || typeof entries !== 'object' || Array.isArray(entries)) throw new Error('POLICY_REJECTED');
      for (const [key, value] of Object.entries(entries)) {
        const values = Array.isArray(value) ? value : [value];
        // Exact StringLike literals have the same matching set as StringEquals.
        const normalizedOperator = operator === 'StringLike' && values.every(item => typeof item === 'string' && !/[*?]|\$\{/.test(item)) ? 'StringEquals' : operator;
        const target = operators.get(normalizedOperator) ?? new Map<string, unknown>(); const contextKey = key.toLowerCase();
        if (target.has(contextKey)) throw new Error('POLICY_REJECTED'); target.set(contextKey, normalize(value)); operators.set(normalizedOperator, target);
      }
    }
    return Object.fromEntries([...operators].sort(([a], [b]) => a.localeCompare(b)).map(([operator, values]) => [operator, Object.fromEntries([...values].sort(([a], [b]) => a.localeCompare(b)))]));
  };
  const normalize = (value: unknown): unknown => Array.isArray(value) ? value.map(normalize).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) : typeof value === 'object' && value !== null ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, val]) => [key, key === 'Condition' && val && typeof val === 'object' && !Array.isArray(val) ? normalizeConditions(val as Record<string, unknown>) : normalize(val)])) : value;
  return JSON.stringify(normalize(typeof doc === 'string' ? JSON.parse(decodeURIComponent(doc)) as unknown : doc));
}
export function policiesEqual(actual: unknown, expected: unknown): boolean { try { return canonicalPolicy(actual) === canonicalPolicy(expected); } catch { return false; } }
export async function expectedIam(stack: ProvisionedStack, options: { budget?: RunBudget; signal?: AbortSignal } = {}): Promise<ExpectedIam> {
  const b = stack.bindings; if (!/^e2e-[a-f0-9]{8}$/.test(b.prefix ?? '') || !/^\d{12}$/.test(b.account_id ?? '') || !/^[a-z0-9]{10}$/.test(b.api_id ?? '') || stack.target.region !== 'ap-northeast-1' || b.cleanup_alias_arn !== `arn:aws:lambda:ap-northeast-1:${b.account_id}:function:${b.prefix}-production-cleanup:production`) throw new Error('EXPECTED_POLICY_REJECTED');
  const sources = await Promise.all(sourcePaths.map(async path => { await assertRegular(join(repository, path)); return readFile(join(repository, path), 'utf8'); })); const digest = createHash('sha256').update(sources.join('\0')).digest('hex');
  const [storage, oidc, runtime, platformStorage, platformIam, scheduler] = sources as [string, string, string, string, string, string];
  const values = { name_prefix: b.prefix, account_id: b.account_id, region: stack.target.region, production_api_id: b.api_id, restored_tables: {}, oidc_subjects: { artifact: 'repo:synthetic/reminder-e2e:environment:production-artifact', plan: 'repo:synthetic/reminder-e2e:environment:production-plan', apply: 'repo:synthetic/reminder-e2e:environment:production' } };
  const variables = Object.entries(values).map(([key, value]) => `variable "${key}" { default = ${JSON.stringify(value)} }`).join('\n');
  const bootstrapLocals = [storage, oidc, runtime].flatMap(source => blocks(source, /locals\s*\{/g)).map(block => `locals ${block}`).join('\n');
  const runtimeTrust = jsonExpression(runtime, 'aws_iam_role', 'runtime', 'assume_role_policy').replaceAll('each.key', 'key'); const githubTrust = jsonExpression(oidc, 'aws_iam_role', 'github', 'assume_role_policy').replaceAll('each.value', 'value');
  const platformLocals = blocks(platformStorage, /locals\s*\{/g)[0]!;
  const platformPolicies = Object.fromEntries(['api', 'cleanup'].map(name => [name, jsonExpression(platformIam, 'aws_iam_role_policy', name, 'policy')]));
  // Platform locals have same named keys as bootstrap; put in a second stateless console.
  const production = `${b.prefix}-production`; const schedulerExpression = jsonExpression(scheduler, 'aws_iam_role_policy', 'scheduler', 'policy').replaceAll('aws_lambda_alias.cleanup.arn', JSON.stringify(b.cleanup_alias_arn));
  async function evaluate(config: string, expression: string): Promise<Record<string, unknown>> {
    if ((options.budget && !options.budget.allow('terraform')) || options.signal?.aborted) throw new Error('EXPECTED_POLICY_BUDGET_EXHAUSTED');
    if (/\b(resource|data|provider|module|terraform|backend)\s+"?/.test(config.replace(/#[^\n]*/g, '').replace(/"(?:\\.|[^"\\])*"/g, '""'))) throw new Error('EXPECTED_POLICY_REJECTED');
    const parent = join(repository, '.superpowers/tools/aws-sdd/expected-iam'); await mkdir(parent, { recursive: true, mode: 0o700 }); const directory = await mkdtemp(join(parent, 'eval-')); let captured = ''; let diagnostic = '';
    try { await writeFile(join(directory, 'expectations.tf'), config + '\nlocals {\n expected = ' + expression + '\n}\n', { mode: 0o600 }); await writeFile(join(directory, 'empty.tfstate'), '{"version":4,"terraform_version":"1.16.5","serial":0,"lineage":"00000000-0000-0000-0000-000000000000","outputs":{},"resources":[]}', { mode: 0o600 }); if ((await readdir(directory)).sort().join(',') !== 'empty.tfstate,expectations.tf') throw new Error('EXPECTED_POLICY_REJECTED');
      const result = await runChild('terraform', ['console', '-state=empty.tfstate', '-no-color'], { cwd: directory, timeoutMs: 30_000, ...(options.signal ? { signal: options.signal } : {}), stdin: 'local.expected\n', captureStdout: value => { captured = value; }, captureStderr: value => { diagnostic = value; } }); if (result.status !== 'succeeded' || !captured) { const error = new Error('EXPECTED_POLICY_EVALUATION_FAILED'); Object.assign(error, { lines: [...diagnostic.matchAll(/on expectations.tf line (\d+)/g)].map(match => Number(match[1])), processStatus: result.status, exitCode: result.exitCode, stderrBytes: diagnostic.length, stdoutBytes: captured.length, diagnostic: ['Invalid reference', 'Missing attribute separator', 'Duplicate local value definition', 'Reference to undeclared', 'Invalid expression', 'Invalid function argument', 'Invalid single-argument block definition', 'Failed to read state', 'Error acquiring state lock', 'Backend initialization required', 'Extra characters after expression', 'Too many command line arguments', 'Unclosed function call', 'Unterminated template string'].find(label => diagnostic.includes(label)) ?? 'unknown' }); throw error; } try { return JSON.parse(JSON.parse(captured.trim()) as string) as Record<string, unknown>; } catch { const error = new Error('EXPECTED_POLICY_EVALUATION_FAILED'); Object.assign(error, { lines: captured.split('\n').map(line => line.startsWith('Acquiring') ? 1 : line.startsWith('Releasing') ? 2 : line.startsWith('"') ? 3 : line.startsWith('<<') ? 5 : 0), diagnostic: 'console-json-shape', stderrBytes: diagnostic.length, stdoutBytes: captured.length }); throw error; }
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
  const bootstrap = await evaluate(variables + '\n' + bootstrapLocals, `jsonencode({bucketPolicies={for key in ["state","artifacts"]:key=>${jsonExpression(storage, 'aws_s3_bucket_policy', 'private', 'policy').replaceAll('each.key', 'key')}},runtimeCeiling=local.runtime_ceiling_text,githubPolicies=local.policy_text,productionRead=${jsonExpression(oidc, 'aws_iam_policy', 'production_read', 'policy')},runtimeTrust={for key in ["api","cleanup","scheduler"]: key=>${runtimeTrust}},githubTrust={for key,value in var.oidc_subjects:key=>${githubTrust}}})`);
  const platform = await evaluate(variables + `\nlocals { production=${JSON.stringify(production)} }\nlocals ${platformLocals}\n${blocks(platformIam, /locals\s*\{/g).map(block => `locals ${block}`).join('\n')}`, `jsonencode({imagesBucketPolicy=${jsonExpression(platformStorage, 'aws_s3_bucket_policy', 'images', 'policy')},platformPolicies={api=${platformPolicies.api},cleanup=${platformPolicies.cleanup}},schedulerPolicy=${schedulerExpression}})`);
  const after = await Promise.all(sourcePaths.map(path => readFile(join(repository, path), 'utf8'))); if (createHash('sha256').update(after.join('\0')).digest('hex') !== digest) throw new Error('EXPECTED_SOURCE_CHANGED');
  return { ...bootstrap, ...platform, sourceDigest: digest } as ExpectedIam;
}
