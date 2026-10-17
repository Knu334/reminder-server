import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFile, lstat, mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { ArtifactSnapshot } from '../../tests/e2e/floci/support/types.ts';
import { assertRegular } from './terraform-source.ts';
import { childEnvironment, runChild } from './run.ts';

const repository = resolve(__dirname, '../..');
export async function inputSnapshot(): Promise<{ inputDigest: string; dirtyPaths: string[] }> {
  const files = ['scripts/build/bundle.ts', 'scripts/build/notices.ts', 'scripts/build/package.py', 'package.json', 'package-lock.json', 'tsconfig.json'];
  async function walk(directory: string): Promise<void> {
    for (const name of await readdir(join(repository, directory))) {
      const path = join(directory, name); const info = await lstat(join(repository, path));
      if (info.isSymbolicLink()) throw new Error('ARTIFACT_REJECTED');
      if (info.isDirectory()) await walk(path); else if (name.endsWith('.ts')) files.push(path);
    }
  }
  await walk('src'); files.sort(); const hash = createHash('sha256');
  for (const path of files) { await assertRegular(join(repository, path)); hash.update(path).update('\0').update(await readFile(join(repository, path))).update('\0'); }
  // Explicit allowlist prevents status from inspecting any private tracked path.
  const output = execFileSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...files], { cwd: repository, env: childEnvironment(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const dirtyPaths = output.split('\0').filter(Boolean).map(line => line.slice(3));
  if (dirtyPaths.some(path => !files.includes(path))) throw new Error('ARTIFACT_REJECTED');
  return { inputDigest: hash.digest('hex'), dirtyPaths: dirtyPaths.sort() };
}
export async function prepareArtifact(runDirectory: string, options?: { signal?: AbortSignal; budget?: { allow(phase: 'terraform'): number }; record?: Parameters<typeof runChild>[2]['record'] }): Promise<ArtifactSnapshot> {
  await mkdir(runDirectory, { recursive: true, mode: 0o700 });
  const lock = join(repository, 'artifacts', '.formal-e2e-build.lock');
  await mkdir(join(repository, 'artifacts'), { recursive: true, mode: 0o700 });
  await writeFile(lock, 'owned-build\n', { flag: 'wx', mode: 0o600 });
  try {
    const before = await inputSnapshot();
    for (const script of ['build', 'package', 'verify:zip']) {
      const timeoutMs = options?.budget?.allow('terraform') ?? 600_000;
      if (!timeoutMs || options?.signal?.aborted) throw new Error('ARTIFACT_BUILD_FAILED');
      const result = await runChild('npm', ['run', script], { cwd: repository, timeoutMs, ...(options?.signal ? { signal: options.signal } : {}), ...(options?.record ? { record: options.record } : {}) });
      if (result.status !== 'succeeded') throw new Error('ARTIFACT_BUILD_FAILED');
    }
    const after = await inputSnapshot();
    if (before.inputDigest !== after.inputDigest) throw new Error('ARTIFACT_INPUT_CHANGED');
    const zipPath = join(runDirectory, 'current-source.zip');
    await copyFile(join(repository, 'artifacts/reminder-server.zip'), zipPath);
    const bytes = await readFile(zipPath); const sha256 = createHash('sha256').update(bytes).digest();
    const snapshot = { zipPath, sha256Hex: sha256.toString('hex'), sha256Base64: sha256.toString('base64'), compressedBytes: bytes.length, ...after };
    await writeFile(join(runDirectory, 'artifact-snapshot.json'), JSON.stringify(snapshot, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    return snapshot;
  } finally { await unlink(lock); }
}
