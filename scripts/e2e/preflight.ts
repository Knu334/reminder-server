import { lookup } from 'node:dns/promises';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { localRequest, isPrivateIPv4 } from '../../tests/e2e/floci/support/transport.ts';
import type { LocalTarget } from '../../tests/e2e/floci/support/types.ts';
import { runChild } from './run.ts';
import type { ProcessEvidence } from '../../tests/e2e/floci/support/evidence.ts';

export async function preflight(record?: (result: ProcessEvidence) => Promise<void>): Promise<LocalTarget> {
  try {
    if (process.version !== 'v24.21.0') throw new Error('version');
    for (const [tool, expectedOutput] of [['npm', '11.11.1'], ['python3', 'Python 3.13.16']] as const) {
      const result = await runChild(tool, ['--version'], { cwd: process.cwd(), timeoutMs: 30_000, expectedOutput, ...(record ? { record } : {}) });
      if (result.status !== 'succeeded' || !result.expectedOutputMatched) throw new Error('version');
    }
    const manifest = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf8')) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
    for (const [name, version] of Object.entries({ ...manifest.dependencies, ...manifest.devDependencies })) {
      const installed = JSON.parse(await readFile(join(process.cwd(), 'node_modules', name, 'package.json'), 'utf8')) as { version: string };
      if (/^\d/.test(version) && installed.version !== version) throw new Error('dependency');
    }
    const addresses = await lookup('floci', { family: 4, all: true });
    const unique = [...new Set(addresses.map(entry => entry.address))];
    if (unique.length !== 1 || !isPrivateIPv4(unique[0]!)) throw new Error('address');
    const target: LocalTarget = { endpoint: 'http://floci:4566', region: 'ap-northeast-1', addresses: new Map([['floci', unique[0]!]]) };
    const health = await localRequest(target, new URL('/_localstack/health', target.endpoint), {});
    if (health.status !== 200) throw new Error('health');
    const body: unknown = JSON.parse(health.bytes.toString('utf8'));
    if (!body || typeof body !== 'object' || !('version' in body) || body.version !== '2.2.0-local-refresh.2-native') throw new Error('version');
    return target;
  } catch { throw new Error('E2E_PREFLIGHT_FAILED'); }
}
if (require.main === module) {
  void preflight().then(() => { console.log('E2E_PREFLIGHT_OK'); }, () => { console.error('E2E_PREFLIGHT_FAILED'); process.exitCode = 2; });
}
