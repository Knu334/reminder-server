import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { S3Client, PutObjectCommand, HeadObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import type { ArtifactSnapshot, Evidence } from './types.ts';
import { inputSnapshot } from '../../../../scripts/e2e/prepare-artifact.ts';
import { assertRegular } from '../../../../scripts/e2e/terraform-source.ts';
import { reserveResource, markResource } from './evidence.ts';

export async function verifyArtifactSnapshot(artifact: ArtifactSnapshot): Promise<Buffer> {
  try {
    await assertRegular(artifact.zipPath); const bytes = await readFile(artifact.zipPath);
    const hash = createHash('sha256').update(bytes).digest();
    if (bytes.length !== artifact.compressedBytes || bytes.length >= 50_000_000 || hash.toString('hex') !== artifact.sha256Hex || hash.toString('base64') !== artifact.sha256Base64 || (await inputSnapshot()).inputDigest !== artifact.inputDigest) throw new Error();
    return bytes;
  } catch { throw new Error('ARTIFACT_REJECTED'); }
}
export async function registerArtifact(client: S3Client, bucket: string, artifact: ArtifactSnapshot, evidence: Evidence): Promise<{ bucket: string; key: string; version_id: string; sha256_base64: string }> {
  const bytes = await verifyArtifactSnapshot(artifact);
  const key = `releases/${artifact.sha256Hex}/reminder-server.zip`; const id = `${evidence.runId}/artifact`;
  await reserveResource(evidence, { kind: 's3-object', name: 'current-source-zip', id });
  const result = await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: bytes, IfNoneMatch: '*', ChecksumSHA256: artifact.sha256Base64 }));
  await markResource(evidence, id, 'created');
  if (!result.VersionId || result.VersionId === 'null') throw new Error('ARTIFACT_REGISTRATION_FAILED');
  const input = { Bucket: bucket, Key: key, VersionId: result.VersionId, ChecksumMode: 'ENABLED' as const };
  const head = await client.send(new HeadObjectCommand(input));
  const stored = await client.send(new GetObjectCommand(input));
  const storedBytes = await stored.Body?.transformToByteArray();
  if (head.VersionId !== result.VersionId || head.ChecksumSHA256 !== artifact.sha256Base64 || head.ContentLength !== bytes.length || stored.VersionId !== result.VersionId || !storedBytes || createHash('sha256').update(storedBytes).digest('hex') !== artifact.sha256Hex) throw new Error('ARTIFACT_REGISTRATION_FAILED');
  return { bucket, key, version_id: result.VersionId, sha256_base64: artifact.sha256Base64 };
}
