import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, relative } from 'node:path';
import type { LocalTarget, PreparedTerraformRoots } from '../../tests/e2e/floci/support/types.ts';
import { isPrivateIPv4 } from '../../tests/e2e/floci/support/transport.ts';

const repository = resolve(__dirname, '../..');
export const publicFiles = {
  bootstrap: ['versions.tf', 'variables.tf', 'storage.tf', 'oidc.tf', 'runtime-roles.tf', 'outputs.tf', '.terraform.lock.hcl'],
  platform: ['versions.tf', 'variables.tf', 'storage.tf', 'cognito.tf', 'iam.tf', 'logs.tf', 'outputs.tf', '.terraform.lock.hcl'],
  application: ['versions.tf', 'variables.tf', 'gateway.tf', 'lambda.tf', 'scheduler.tf', 'monitoring.tf', 'outputs.tf', '.terraform.lock.hcl'],
} as const;
export type RootName = keyof typeof publicFiles;
const sourcePaths = { bootstrap: 'infra/bootstrap', platform: 'infra/platform/production', application: 'infra/application/production' };
type Snapshot = { originals: Map<string, string>; expected: Map<string, string>; target: LocalTarget; cleanup: boolean; directory: string };
const snapshots = new WeakMap<PreparedTerraformRoots, Snapshot>();
export function assertLocalTarget(target: LocalTarget): string {
  const address = target.addresses.get('floci');
  if (target.endpoint !== 'http://floci:4566' || target.region !== 'ap-northeast-1' || !address || !isPrivateIPv4(address)) throw new Error('LOCAL_TARGET_REJECTED');
  for (const [host, ip] of target.addresses) if (ip !== address || !/^[a-z0-9.-]+$/.test(host)) throw new Error('LOCAL_TARGET_REJECTED');
  return address;
}
export function discoveredCognitoIdentity(target: LocalTarget, poolId: string, document: Record<string, unknown>): { issuer: string; authBase: string; target: LocalTarget } {
  const address = assertLocalTarget(target);
  try {
    if (!/^ap-northeast-1_[A-Za-z0-9]+$/.test(poolId)) throw new Error();
    const get = (name: string): URL => {
      const value = document[name]; if (typeof value !== 'string') throw new Error();
      const url = new URL(value);
      if (url.protocol !== 'http:' || url.port !== '4566' || !['floci', address].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.href !== value) throw new Error();
      return url;
    };
    const issuer = get('issuer'); const jwks = get('jwks_uri'); const authorization = get('authorization_endpoint'); const token = get('token_endpoint');
    if (issuer.pathname !== `/${poolId}` || jwks.href !== `${issuer.href}/.well-known/jwks.json` || authorization.origin !== token.origin || authorization.pathname !== '/cognito-idp/oauth2/authorize' || token.pathname !== '/cognito-idp/oauth2/token') throw new Error();
    return { issuer: issuer.href, authBase: `${authorization.origin}/cognito-idp`, target: { ...target, addresses: new Map([...target.addresses, [address, address]]) } };
  } catch { throw new Error('DISCOVERY_REJECTED'); }
}
export async function assertRegular(path: string): Promise<void> {
  const absolute = resolve(path);
  for (let cursor = absolute; cursor !== dirname(cursor); cursor = dirname(cursor)) if ((await lstat(cursor)).isSymbolicLink()) throw new Error('SYMLINK_REJECTED');
  if (!(await lstat(absolute)).isFile() || await realpath(absolute) !== absolute) throw new Error('SOURCE_REJECTED');
}
function digest(files: Map<string, string>): string {
  const hash = createHash('sha256');
  for (const [name, content] of [...files].sort(([a], [b]) => a.localeCompare(b))) hash.update(name).update('\0').update(content).update('\0');
  return hash.digest('hex');
}
// Balanced HCL blocks, ignoring braces in strings/comments. Heredocs are rejected
// for the small validation/lifecycle blocks this scanner is permitted to edit.
function closeBrace(text: string, start: number): number {
  let depth = 0; let quoted = false; let line = false; let comment = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i]!; const next = text[i + 1];
    if (line) { if (c === '\n') line = false; continue; }
    if (comment) { if (c === '*' && next === '/') { comment = false; i++; } continue; }
    if (quoted) { if (c === '\\') i++; else if (c === '"') quoted = false; continue; }
    if (c === '"') { quoted = true; continue; }
    if (c === '#' || (c === '/' && next === '/')) { line = true; continue; }
    if (c === '/' && next === '*') { comment = true; i++; continue; }
    if (c === '{') depth++;
    if (c === '}' && --depth === 0) return i + 1;
  }
  throw new Error('HCL_STRUCTURE_REJECTED');
}
function replaceValidation(text: string, name: string, value: string): string {
  const starts = [...text.matchAll(new RegExp(`variable "${name}" \\{`, 'g'))];
  if (starts.length !== 1) throw new Error('HCL_STRUCTURE_REJECTED');
  const start = starts[0]!.index; const end = closeBrace(text, text.indexOf('{', start));
  const block = text.slice(start, end); const validation = /\bvalidation\s*\{/.exec(block);
  if (!validation || [...block.matchAll(/\bvalidation\s*\{/g)].length !== 1) throw new Error('HCL_STRUCTURE_REJECTED');
  const vstart = start + validation.index; const vend = closeBrace(text, text.indexOf('{', vstart));
  return text.slice(0, vstart) + `validation {\n    condition     = var.${name} == ${JSON.stringify(value)}\n    error_message = "Require the discovered owned local URL."\n  }` + text.slice(vend);
}
function provider(target: LocalTarget): string {
  const endpoint = `http://${assertLocalTarget(target)}:4566`;
  const endpoints = Object.fromEntries(['s3', 's3control', 'dynamodb', 'lambda', 'cloudwatchlogs', 'cloudwatch', 'cognitoidp', 'iam', 'apigateway', 'scheduler', 'sts'].map(service => [service, service === 's3control' ? target.endpoint : endpoint]));
  return JSON.stringify({ provider: { aws: { access_key: 'local', secret_key: 'local', region: 'ap-northeast-1', shared_config_files: [], shared_credentials_files: [], skip_metadata_api_check: true, skip_credentials_validation: true, skip_region_validation: true, skip_requesting_account_id: false, max_retries: 0, s3_use_path_style: true, endpoints } } }, null, 2) + '\n';
}
export async function prepareProductionRoots(target: LocalTarget, directory: string): Promise<PreparedTerraformRoots> {
  assertLocalTarget(target);
  await mkdir(directory, { mode: 0o700 });
  const originals = new Map<string, string>(); const expected = new Map<string, string>();
  const paths = { bootstrap: join(directory, 'bootstrap'), platform: join(directory, 'platform'), application: join(directory, 'application') };
  for (const root of Object.keys(publicFiles) as RootName[]) {
    await mkdir(paths[root], { mode: 0o700 });
    for (const name of publicFiles[root]) {
      const path = join(repository, sourcePaths[root], name); await assertRegular(path);
      const text = await readFile(path, 'utf8');
      originals.set(`${root}/${name}`, text); expected.set(`${root}/${name}`, text);
      await writeFile(join(paths[root], name), text, { mode: 0o600, flag: 'wx' });
    }
    for (const [name, text] of [['local-backend.tf.json', JSON.stringify({ terraform: { backend: { local: { path: 'owned.tfstate' } } } }, null, 2) + '\n'], ['connection_override.tf.json', provider(target)]]) {
      expected.set(`${root}/${name!}`, text!); await writeFile(join(paths[root], name!), text!, { mode: 0o600, flag: 'wx' });
    }
  }
  const roots: PreparedTerraformRoots = { ...paths, sourceDigest: digest(originals), transformedDigest: digest(expected), validationDiffs: [], generatedChanges: [
    { category: 'connection', destinations: ['provider.aws.endpoints', 'provider.aws.local-credentials'] },
    { category: 'isolation', destinations: ['terraform.backend.local'] },
  ] };
  snapshots.set(roots, { originals, expected, target, cleanup: false, directory: resolve(directory) });
  return roots;
}
export async function bindCognitoIdentity(roots: PreparedTerraformRoots, target: LocalTarget, poolId: string, issuer: string, authBase: string): Promise<void> {
  await verifyProductionRoots(roots); const snapshot = snapshots.get(roots)!;
  if (snapshot.cleanup || roots.validationDiffs.length || !/^ap-northeast-1_[A-Za-z0-9]+$/.test(poolId)) throw new Error('IDENTITY_REJECTED');
  assertLocalTarget(target);
  for (const [value, path] of [[issuer, `/${poolId}`], [authBase, '/cognito-idp']]) {
    const url = new URL(value!);
    if (![target.endpoint, `http://${assertLocalTarget(target)}:4566`].includes(url.origin) || url.pathname !== path || url.username || url.password || url.search || url.hash || value !== `${url.origin}${path}`) throw new Error('IDENTITY_REJECTED');
  }
  let text = snapshot.originals.get('application/variables.tf')!;
  text = replaceValidation(text, 'cognito_issuer', issuer); text = replaceValidation(text, 'cognito_auth_base_url', authBase);
  snapshot.expected.set('application/variables.tf', text); await writeFile(join(roots.application, 'variables.tf'), text, { mode: 0o600 });
  const outputs = JSON.stringify({ output: { cognito_issuer: { value: `${new URL(issuer).origin}/\${aws_cognito_user_pool.production.id}` }, cognito_auth_base_url: { value: authBase } } }, null, 2) + '\n';
  snapshot.expected.set('platform/identity_override.tf.json', outputs); await writeFile(join(roots.platform, 'identity_override.tf.json'), outputs, { mode: 0o600 });
  roots.validationDiffs = ['cognito_issuer', 'cognito_auth_base_url'].map(name => ({ location: `application.variable.${name}.validation`, kind: 'owned-url-validation' }));
  roots.generatedChanges.push({ category: 'connection', destinations: ['platform.output.cognito_issuer.value', 'platform.output.cognito_auth_base_url.value'] });
  roots.transformedDigest = digest(snapshot.expected);
}
export async function verifyProductionRoots(roots: PreparedTerraformRoots, allowCleanup = false): Promise<void> {
  const snapshot = snapshots.get(roots);
  if (!snapshot || (snapshot.cleanup && !allowCleanup) || roots.sourceDigest !== digest(snapshot.originals) || roots.transformedDigest !== digest(snapshot.expected)) throw new Error('SOURCE_REJECTED');
  for (const root of Object.keys(publicFiles) as RootName[]) {
    if (resolve(roots[root]) !== join(snapshot.directory, root)) throw new Error('FOREIGN_ROOT_REJECTED');
    const names = (await readdir(roots[root])).filter(name => name.endsWith('.tf') || name.endsWith('.tf.json') || name === '.terraform.lock.hcl' || name === 'terraform.tfvars' || name === 'terraform.tfvars.json' || name.endsWith('.auto.tfvars') || name.endsWith('.auto.tfvars.json'));
    const expectedNames = [...snapshot.expected.keys()].filter(name => name.startsWith(`${root}/`)).map(name => name.slice(root.length + 1));
    if (JSON.stringify(names.sort()) !== JSON.stringify(expectedNames.sort())) throw new Error('UNKNOWN_OVERRIDE_REJECTED');
    for (const name of names) {
      const path = join(roots[root], name); await assertRegular(path);
      if (await readFile(path, 'utf8') !== snapshot.expected.get(`${root}/${name}`)) throw new Error('SOURCE_REJECTED');
    }
  }
}
/** Only the driver's synthetic input writer can change expected auto-loaded bytes. */
export async function writeProductionInputs(roots: PreparedTerraformRoots, root: RootName, inputs: Record<string, unknown>): Promise<void> {
  await verifyProductionRoots(roots);
  const snapshot = snapshots.get(roots)!;
  if (!Object.hasOwn(publicFiles, root)) throw new Error('FOREIGN_ROOT_REJECTED');
  const text = JSON.stringify(inputs, null, 2) + '\n';
  await writeFile(join(roots[root], 'owned.auto.tfvars.json'), text, { mode: 0o600 });
  snapshot.expected.set(`${root}/owned.auto.tfvars.json`, text);
  roots.transformedDigest = digest(snapshot.expected);
}
export async function cleanupOverrides(roots: PreparedTerraformRoots, finalized: boolean): Promise<void> {
  if (!finalized) throw new Error('RESULTS_NOT_FINALIZED');
  await verifyProductionRoots(roots); const snapshot = snapshots.get(roots)!;
  for (const root of Object.keys(publicFiles) as RootName[]) {
    const overrides: Record<string, Record<string, { lifecycle: { prevent_destroy: false } }>> = {};
    for (const [path, text] of snapshot.originals) {
      if (!path.startsWith(`${root}/`)) continue;
      for (const match of text.matchAll(/resource "([a-z0-9_]+)" "([a-z0-9_]+)" \{/g)) {
        const block = text.slice(match.index, closeBrace(text, text.indexOf('{', match.index)));
        if (/prevent_destroy\s*=\s*true/.test(block)) (overrides[match[1]!] ??= {})[match[2]!] = { lifecycle: { prevent_destroy: false } };
      }
    }
    const text = JSON.stringify({ resource: overrides }, null, 2) + '\n';
    snapshot.expected.set(`${root}/cleanup_override.tf.json`, text); await writeFile(join(roots[root], 'cleanup_override.tf.json'), text, { mode: 0o600, flag: 'wx' });
  }
  snapshot.cleanup = true; roots.transformedDigest = digest(snapshot.expected);
  roots.generatedChanges.push({ category: 'cleanup', destinations: ['resource.lifecycle.prevent_destroy'] });
}
export function ownsRoot(roots: PreparedTerraformRoots, path: string): boolean {
  const snapshot = snapshots.get(roots);
  return !!snapshot && !relative(snapshot.directory, resolve(path)).startsWith('..') && Object.values({ bootstrap: roots.bootstrap, platform: roots.platform, application: roots.application }).includes(path);
}
export async function productionResourceAddresses(roots: PreparedTerraformRoots, root: RootName, allowCleanup = false): Promise<string[]> {
  await verifyProductionRoots(roots, allowCleanup);
  const addresses = new Set<string>();
  for (const [path, text] of snapshots.get(roots)!.originals) {
    if (!path.startsWith(`${root}/`)) continue;
    for (const match of text.matchAll(/^resource "([a-z0-9_]+)" "([a-z0-9_]+)" \{/gm)) addresses.add(`${match[1]}.${match[2]}`);
  }
  if (!addresses.size) throw new Error('SOURCE_REJECTED');
  return [...addresses].sort();
}
