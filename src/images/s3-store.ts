import { createHash } from "node:crypto";
import { DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, HeadObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { Config } from "../config";
import { requireBudget } from "../shared/budget";
import { ApiError } from "../shared/errors";
import type { Budget, ImagesStore } from "../shared/ports";

function unavailable(): ApiError { return new ApiError(503, "SERVICE_UNAVAILABLE", "Service temporarily unavailable"); }
function version(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value === "null") throw unavailable();
  return value;
}
function checksum(value: string | undefined): string | null {
  if (value === undefined) return null;
  const bytes = Buffer.from(value, "base64");
  if (bytes.length !== 32 || bytes.toString("base64") !== value) throw unavailable();
  return bytes.toString("hex");
}
function errorHead(error: unknown): { status: unknown; headers: Record<string, unknown> } {
  if (typeof error !== "object" || error === null) return { status: undefined, headers: {} };
  const metadata: unknown = Reflect.get(error, "$metadata"); const response: unknown = Reflect.get(error, "$response");
  const headers: unknown = typeof response === "object" && response !== null ? Reflect.get(response, "headers") : undefined;
  return { status: typeof metadata === "object" && metadata !== null ? Reflect.get(metadata, "httpStatusCode") : undefined,
    headers: typeof headers === "object" && headers !== null ? headers as Record<string, unknown> : {} };
}

export function createImagesStore(client: S3Client, config: Config): ImagesStore {
  return {
    async put(job, image, budget) {
      try {
        requireBudget(budget);
        const response = await client.send(new PutObjectCommand({ Bucket: config.imagesBucket, Key: job.key,
          Body: image.data, ContentType: image.mime, ChecksumSHA256: Buffer.from(image.sha256, "hex").toString("base64") }), { abortSignal: budget.signal });
        const versionId = version(response.VersionId);
        if (response.ChecksumSHA256 !== undefined && checksum(response.ChecksumSHA256) !== image.sha256) throw unavailable();
        return { imageId: job.jobId, key: job.key, versionId, mime: image.mime, bytes: image.bytes, sha256: image.sha256 };
      } catch { throw unavailable(); }
    },
    async head(key, versionId, budget) {
      try {
        requireBudget(budget);
        const response = await client.send(new HeadObjectCommand({ Bucket: config.imagesBucket, Key: key,
          ...(versionId === null ? {} : { VersionId: versionId }), ChecksumMode: "ENABLED" }), { abortSignal: budget.signal });
        const actualVersion = version(response.VersionId);
        if (versionId !== null && actualVersion !== versionId) throw unavailable();
        return { versionId: actualVersion, sha256: checksum(response.ChecksumSHA256), deleteMarker: response.DeleteMarker === true };
      } catch (error) {
        const details = errorHead(error);
        if ((details.status === 404 || details.status === 405) && details.headers["x-amz-delete-marker"] === "true") {
          const markerVersion = version(details.headers["x-amz-version-id"]);
          if (versionId !== null && versionId !== markerVersion) throw unavailable();
          return { versionId: markerVersion, sha256: null, deleteMarker: true };
        }
        if (details.status === 404) return null;
        throw unavailable();
      }
    },
    async get(ref, budget) {
      try {
        requireBudget(budget);
        const response = await client.send(new GetObjectCommand({ Bucket: config.imagesBucket, Key: ref.key, VersionId: ref.versionId, ChecksumMode: "ENABLED" }), { abortSignal: budget.signal });
        if (version(response.VersionId) !== ref.versionId || response.Body === undefined) throw unavailable();
        const data = await response.Body.transformToByteArray();
        requireBudget(budget);
        if (data.length !== ref.bytes || createHash("sha256").update(data).digest("hex") !== ref.sha256) throw unavailable();
        return data;
      } catch { throw unavailable(); }
    },
    async signGet(ref, requestedSeconds, budget) {
      try {
        requireBudget(budget);
        const url = await getSignedUrl(client, new GetObjectCommand({ Bucket: config.imagesBucket, Key: ref.key, VersionId: ref.versionId }), { expiresIn: requestedSeconds });
        requireBudget(budget);
        return url;
      } catch { throw unavailable(); }
    },
    async markDeleted(key, budget) {
      try {
        requireBudget(budget);
        // No VersionId: versioned buckets retain bytes and insert a delete marker.
        await client.send(new DeleteObjectCommand({ Bucket: config.imagesBucket, Key: key }), { abortSignal: budget.signal });
      } catch { throw unavailable(); }
    },
    async probe(budget: Budget) {
      try { requireBudget(budget); await client.send(new HeadBucketCommand({ Bucket: config.imagesBucket }), { abortSignal: budget.signal }); }
      catch { throw unavailable(); }
    },
  };
}
