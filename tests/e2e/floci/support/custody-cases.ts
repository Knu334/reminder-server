import { createHash, randomInt } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ListObjectVersionsCommand } from '@aws-sdk/client-s3';
import { createS3CustodyStore, custodyPrefix, readCustody, requiredFiles, writeCustody } from '../../../../scripts/release/custody.ts';
import type { CustodyLocation } from '../../../../scripts/release/custody.ts';
import { caseActions, caseMeasurements, definitions } from './cases.ts';
import type { MeasuredOutcome } from './cases.ts';
import { Score } from './auth-cases.ts';
import { ownedBucketNames } from './evidence.ts';
import { fixtureState } from './fixture.ts';
import type { CaseDefinition, SuiteFixture } from './types.ts';

/**
 * REL-01: release custody のモジュール（scripts/release/custody.ts）を、run が所有する custody bucket で動かす。
 * 書き込みはすべて createS3CustodyStore 経由（If-None-Match と SHA-256 の checksum 付き）で行う。
 * 必須の roundtrip は通信や認証のエラーを fail にする。互換性の条件付き書き込みだけが、測定の結果として unsupported になり得る。
 * 書いた object は suite の reset では消さず、run 末尾の清掃（policy の削除、全 version と delete marker の削除、destroy、不在の確認）で消える。
 */
const ROUNDTRIP = 'REL-01/custody-roundtrip';
const CONDITIONAL = 'REL-01/custody-conditional-write';
const na = (reason: string) => ({ assertions: [] as string[], notApplicableReason: reason });
function custodyCase(id: string, acceptance: CaseDefinition['acceptance'], s3: string[]): CaseDefinition {
  return { id, requirementId: 'REL-01', layer: 'L', required: true, acceptance, suite: 'custody', source: 'formal-e2e-coverage/REL-01', outputs: [
    { kind: 'http', ...na('direct-s3-sdk-no-gateway') }, { kind: 'dynamodb', ...na('custody-uses-s3-only') }, { kind: 's3', assertions: s3 }, { kind: 'logs', ...na('direct-s3-request-no-api-result') },
  ] };
}
export const custodyDefinitions: CaseDefinition[] = [
  custodyCase(ROUNDTRIP, 'behavior', ['files-and-manifest-written-under-run-prefix', 'manifest-read-by-sha256', 'extracted-files-match-source-sha256']),
  custodyCase(CONDITIONAL, 'compatibility', ['second-write-to-same-key-measured']),
];
definitions.push(...custodyDefinitions);

const hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const base64 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('base64');
/** case ごとに別の run ID を使い、同じ run の中で key が重ならないようにする。 */
const freshRunId = (): string => String(randomInt(1_000_000_000, 2 ** 47));

/** run が所有する custody bucket（bootstrap の output custody_bucket と同じ名前の作り方）。所有の4つ以外は拒否する。 */
export function custodyBucket(fixture: SuiteFixture): string {
  const account = fixtureState(fixture).stack.bindings.account_id;
  if (typeof account !== 'string' || !/^\d{12}$/.test(account)) throw new Error('CUSTODY_BUCKET_REJECTED');
  const bucket = ownedBucketNames(fixture.prefix, account, fixture.target.region).find(name => name.endsWith('-custody'));
  if (!bucket) throw new Error('CUSTODY_BUCKET_REJECTED');
  return bucket;
}

/** prefix の下の version と delete marker を数える。 */
async function listUnder(fixture: SuiteFixture, Bucket: string, Prefix: string): Promise<{ keys: string[]; markers: number }> {
  const keys: string[] = []; let markers = 0; let KeyMarker: string | undefined; let VersionIdMarker: string | undefined;
  do {
    const page = await fixture.clients.s3.send(new ListObjectVersionsCommand({ Bucket, Prefix, ...(KeyMarker ? { KeyMarker } : {}), ...(VersionIdMarker ? { VersionIdMarker } : {}) }));
    keys.push(...(page.Versions ?? []).map(item => item.Key!)); markers += page.DeleteMarkers?.length ?? 0;
    KeyMarker = page.IsTruncated ? page.NextKeyMarker : undefined; VersionIdMarker = page.NextVersionIdMarker;
    if (page.IsTruncated && !KeyMarker) throw new Error('CUSTODY_LISTING_REJECTED');
  } while (KeyMarker);
  return { keys, markers };
}
const sameSet = (a: string[], b: string[]): boolean => a.length === b.length && [...a].sort().join('\0') === [...b].sort().join('\0');

// 必須: release-review 相当の合成ファイルを書き、manifest の SHA-256 で読み、取り出したファイルを元の bytes と hash で照合する。
caseActions.set(ROUNDTRIP, async (fixture, recorder) => {
  const score = new Score(); const bucket = custodyBucket(fixture); const store = createS3CustodyStore(bucket, fixture.clients.s3);
  const location: CustodyLocation = { kind: 'release-review', runId: freshRunId(), runAttempt: 1 }; const prefix = custodyPrefix(location);
  const names = [...requiredFiles('release-review', 'platform')];
  const work = await mkdtemp(join(tmpdir(), 'custody-case-'));
  try {
    const source = join(work, 'source'); await mkdir(source, { mode: 0o700 });
    const bodies = new Map<string, Buffer>();
    for (const name of names.filter(name => name !== 'custody.json')) bodies.set(name, Buffer.from(`synthetic ${name} ${location.runId}\n`));
    bodies.set('custody.json', Buffer.from(JSON.stringify(Object.fromEntries([...bodies].map(([name, body]) => [name, hex(body)])), null, 2) + '\n'));
    for (const [name, body] of bodies) await writeFile(join(source, name), body, { mode: 0o600 });
    const written = await writeCustody(store, location, source, { root: 'platform', planReviewSha256: hex(bodies.get('plan.txt')!), custodySha256: hex(bodies.get('custody.json')!) }, new Date());
    const listed = await listUnder(fixture, bucket, prefix);
    score.ok('s3', 'files-and-manifest-written-under-run-prefix', listed.markers === 0 && sameSet(listed.keys, [...names, 'manifest.json'].map(name => `${prefix}${name}`)));
    const destination = join(work, 'extracted');
    const manifest = await readCustody(store, location, written.manifestSha256, destination, { root: 'platform', now: new Date() });
    score.ok('s3', 'manifest-read-by-sha256', manifest.kind === 'release-review' && manifest.runId === location.runId && manifest.root === 'platform' && sameSet(Object.keys(manifest.files), names));
    let matched = true;
    for (const [name, body] of bodies) { const extracted = await readFile(join(destination, name)); matched &&= extracted.equals(body) && hex(extracted) === manifest.files[name]; }
    score.ok('s3', 'extracted-files-match-source-sha256', matched);
  } finally { await rm(work, { recursive: true, force: true }); }
  score.emit(ROUNDTRIP, recorder);
});

export type SecondWrite = { accepted: true } | { accepted: false; status?: number; name?: string };
export type ConditionalWriteObservation = { first: 'failed' } | { first: 'stored'; second: SecondWrite; kept: boolean };
/**
 * 条件付き書き込みの判定。初回の失敗は fail。2回目が条件不成立（412、または 409 ConditionalRequestConflict）で、初回の内容が残っていれば pass。
 * 2回目の受理は unsupported（Floci が If-None-Match を強制しない）。認証エラー、通信失敗、その他の status は fail。
 */
export function classifyConditionalWrite(observation: ConditionalWriteObservation): MeasuredOutcome {
  if (observation.first === 'failed') return 'fail';
  const { second } = observation;
  if (second.accepted) return 'unsupported';
  const refused = second.status === 412 || (second.status === 409 && second.name === 'ConditionalRequestConflict');
  return refused && observation.kept ? 'pass' : 'fail';
}

/** 同じ key へ2回書く。2回目の応答と、その後の読み戻しを観測して判定する。 */
export async function probeConditionalWrite(fixture: SuiteFixture): Promise<MeasuredOutcome | { outcome: MeasuredOutcome; httpStatus: number }> {
  const store = createS3CustodyStore(custodyBucket(fixture), fixture.clients.s3);
  const key = `${custodyPrefix({ kind: 'failure-diagnostics', runId: freshRunId(), runAttempt: 1, job: 'conditional-write' })}probe.json`;
  const first = Buffer.from('{"write":"first"}\n'); const second = Buffer.from('{"write":"second"}\n');
  try { await store.put(key, first, base64(first)); } catch { return classifyConditionalWrite({ first: 'failed' }); }
  let observed: SecondWrite;
  try { await store.put(key, second, base64(second)); observed = { accepted: true }; }
  catch (error) { const detail = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } }; const status = detail.$metadata?.httpStatusCode; observed = { accepted: false, ...(typeof status === 'number' ? { status } : {}), ...(typeof detail.name === 'string' ? { name: detail.name } : {}) }; }
  let kept = false;
  try { kept = Buffer.from(await store.get(key)).equals(first); } catch { kept = false; }
  const outcome = classifyConditionalWrite({ first: 'stored', second: observed, kept });
  // 受理は SDK が 2xx を返したことを意味する。status の無い失敗（通信の失敗）は status を記録しない。
  const httpStatus = observed.accepted ? 200 : observed.status;
  return httpStatus === undefined ? outcome : { outcome, httpStatus };
}

// 互換性: 結果は runner が測定から記録する（unsupported の理由は conditional-write-unsupported）。caseActions は選択可能にするためだけにある。
caseMeasurements.set(CONDITIONAL, probeConditionalWrite);
caseActions.set(CONDITIONAL, async () => { throw new Error('MEASURED_CASE_RECORDED_BY_RUNNER'); });
