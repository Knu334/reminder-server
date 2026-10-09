import { createHash } from 'node:crypto';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { ImageRef } from '../../../../src/images/types.ts';
import { localRequest, withOwnedBucketHost } from './transport.ts';
import type { HttpResult, SuiteFixture } from './types.ts';

/**
 * Synthetic image bytes: a real format signature followed by deterministic filler. They are not decodable images; the product
 * only checks the signature and preserves the bytes, and this suite never claims an image decoder accepted them.
 * The generation rule is documented in tests/fixtures/synthetic/formal-e2e/image-fixtures.md.
 */
export type ImageFormat = 'png' | 'jpeg' | 'gif' | 'webp';
export const IMAGE_MIME: Readonly<Record<ImageFormat, string>> = { png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
const SIGNATURE: Record<ImageFormat, number[]> = { png: [137, 80, 78, 71, 13, 10, 26, 10], jpeg: [255, 216, 255], gif: [...Buffer.from('GIF89a', 'latin1')], webp: [...Buffer.from('RIFF', 'latin1'), 0, 0, 0, 0, ...Buffer.from('WEBP', 'latin1')] };
export const FORMATS: readonly ImageFormat[] = ['png', 'jpeg', 'gif', 'webp'];
export const MAX_IMAGE_BYTES = 1_048_576;

/** Exactly `bytes` bytes (default 64): signature, then filler byte i = (31*i + 7*seed + format index) mod 256. */
export function imageBytes(format: ImageFormat, bytes = 64, seed = 0): Buffer {
  const head = SIGNATURE[format]; if (!Number.isSafeInteger(bytes) || bytes < head.length || bytes > 2 ** 24 || !Number.isSafeInteger(seed) || seed < 0) throw new Error('IMAGE_FIXTURE_REJECTED');
  const result = Buffer.alloc(bytes); const offset = FORMATS.indexOf(format);
  for (let index = 0; index < bytes; index++) result[index] = index < head.length ? head[index]! : (31 * index + 7 * seed + offset) & 255;
  if (format === 'webp') result.writeUInt32LE(bytes - 8, 4);
  return result;
}
export const base64Of = (data: Buffer): string => data.toString('base64');
export const dataUrlOf = (format: ImageFormat, data: Buffer): string => `data:${IMAGE_MIME[format]};base64,${data.toString('base64')}`;
export const sha256Of = (data: Buffer): string => createHash('sha256').update(data).digest('hex');
export const sha256Base64 = (data: Buffer): string => createHash('sha256').update(data).digest('base64');

const REJECT = (): never => { throw new Error('IMAGE_URL_REJECTED'); };
const KEY = /^images\/([a-f0-9]{64})\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Owner prefix of the S3 keys one synthetic owner may hold. */
export const ownedPrefix = (ownerId: string): string => { if (!/^[a-f0-9]{64}$/.test(ownerId)) throw new Error('OWNER_REJECTED'); return `images/${ownerId}/`; };

/**
 * GET a presigned image URL exactly as issued: no Authorization, no rewriting, no redirect. Before any socket opens the URL must
 * name the run-owned bucket on the pinned local host (path style `floci` or virtual-hosted `<bucket>.floci`), the exact owned key and
 * version, and carry one SigV4 signature. The URL is a secret: it is never logged, stored or part of an error.
 */
export async function fetchOwnedImage(fixture: SuiteFixture, url: string, ref: ImageRef): Promise<HttpResult> {
  const bucket = fixture.config.imagesBucket; let parsed: URL;
  try { parsed = new URL(url); } catch { return REJECT(); }
  if (!KEY.test(ref.key) || ref.versionId.length === 0 || parsed.protocol !== 'http:' || parsed.port !== '4566' || parsed.username || parsed.password || parsed.hash) return REJECT();
  const pathStyle = parsed.hostname === 'floci' && parsed.pathname === `/${bucket}/${ref.key}`;
  const hostStyle = parsed.hostname === `${bucket}.floci` && parsed.pathname === `/${ref.key}`;
  const versions = parsed.searchParams.getAll('versionId'); const signatures = parsed.searchParams.getAll('X-Amz-Signature');
  if (!(pathStyle || hostStyle) || versions.length !== 1 || versions[0] !== ref.versionId || signatures.length !== 1 || !/^[0-9a-f]{64}$/.test(signatures[0]!)) return REJECT();
  let target; try { target = withOwnedBucketHost(fixture.target, bucket); } catch { return REJECT(); }
  const result = await localRequest(target, parsed, { method: 'GET' });
  if (result.status >= 300 && result.status < 400) throw new Error('IMAGE_REDIRECT_REJECTED');
  return result;
}

/** Seams for the offline double: production uses the guarded local transport and the SigV4 expiry parameter. */
export const imageIo = {
  fetch: (fixture: SuiteFixture, url: string, ref: ImageRef): Promise<HttpResult> => fetchOwnedImage(fixture, url, ref),
  expirySeconds: (url: string): number => { try { return Number(new URL(url).searchParams.get('X-Amz-Expires')); } catch { return Number.NaN; } },
};

/** Replace only the signature value (same length, different digits). */
export function tamperUrlSignature(url: string): string {
  let parsed: URL; try { parsed = new URL(url); } catch { return REJECT(); }
  const signature = parsed.searchParams.get('X-Amz-Signature'); if (!signature || !/^[0-9a-f]{64}$/.test(signature)) return REJECT();
  parsed.searchParams.set('X-Amz-Signature', `${signature.slice(0, -1)}${signature.endsWith('0') ? '1' : '0'}`);
  return parsed.href;
}
/** A short-lived URL for the exact owned object, independent of the API's 900 second URL. Its lifetime is the harness's, not the product's. */
export async function shortLivedUrl(fixture: SuiteFixture, ref: ImageRef, seconds: number): Promise<string> {
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 60) throw new Error('IMAGE_FIXTURE_REJECTED');
  return getSignedUrl(fixture.clients.s3, new GetObjectCommand({ Bucket: fixture.config.imagesBucket, Key: ref.key, VersionId: ref.versionId }), { expiresIn: seconds });
}
export type SignatureProbeInput = { control: string; tampered: string; shortLived: string; fetch(url: string): Promise<number>; waitUntilExpired(): Promise<void> };
/**
 * Compare a valid control, a signature-only change and a short-lived independent URL after expiry. A lenient server (tampered or
 * expired URL accepted) means signature enforcement is unsupported here; a failing control means the probe itself proves nothing.
 */
export async function probeSignatureEnforcement(input: SignatureProbeInput): Promise<'enforced' | 'unsupported' | 'control-failed'> {
  const [control, early] = [await input.fetch(input.control), await input.fetch(input.shortLived)];
  if (control !== 200 || early !== 200) return 'control-failed';
  const tampered = await input.fetch(input.tampered); await input.waitUntilExpired(); const late = await input.fetch(input.shortLived);
  return [400, 403].includes(tampered) && [400, 403].includes(late) ? 'enforced' : 'unsupported';
}
