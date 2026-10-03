import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { ActiveReminder, OwnerId, StoredReminder } from "../../src/reminders/types";
import type { DecodedImage, ImageJob, ImageRef } from "../../src/images/types";
import { cleanupKeys } from "../../src/images/job-keys";
import { requireBudget } from "../../src/shared/budget";
import { keys, type Budget, type ImagesStore, type JobsStore, type OwnerStore, type RemindersStore } from "../../src/shared/ports";
import type { LegacyValidation, MigrationIdentity } from "./legacy";

export interface MigrationProgress {
  completedOwners: number[];
  completedItems: Array<{ ownerPosition: number; itemPosition: number; imageId: string | null }>;
}
export interface MigrationRun {
  identity: MigrationIdentity; phase: "importing" | "verified" | "published";
  progress: MigrationProgress; verification: MigrationVerification | null;
}
export interface MigrationSummary { owners: number; items: number; imageBytes: number; completed: boolean }
export interface MigrationVerification {
  identity: MigrationIdentity; exactMatch: boolean;
  mismatches: Array<{ location: string; field: string; reason: string }>;
}
export interface MigrationStorage { itemCount: number; imageBytes: number; migrationRunId: string }
export interface MigrationStore {
  assertEmptyOrSameRun(identity: MigrationIdentity): Promise<void>;
  loadRun(runId: string): Promise<MigrationRun | null>;
  saveProgress(runId: string, progress: MigrationProgress): Promise<void>;
  putImported(owner: OwnerId, item: ActiveReminder, imageJob: ImageJob | null, identity: MigrationIdentity): Promise<void>;
  recordVerification(runId: string, result: MigrationVerification): Promise<void>;
  publishIfVerified(identity: MigrationIdentity): Promise<void>;
  listRunItems(runId: string): AsyncIterable<StoredReminder>;
  stageImage(job: ImageJob, identity: MigrationIdentity): Promise<void>;
  ensureOwner(owner: OwnerId, identity: MigrationIdentity): Promise<void>;
  getStorage(owner: OwnerId): Promise<MigrationStorage | null>;
}
export interface MigrationDeps {
  migration: MigrationStore; reminders: RemindersStore; jobs: JobsStore; images: ImagesStore; owners: OwnerStore;
  validation: LegacyValidation; budget: Budget; clock: () => number; uuid: () => string;
}
const failure = (): Error => new Error("MIGRATION_REJECTED");
export function assertMigrationIdentity(identity: MigrationIdentity): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(identity.runId)
    || identity.contractVersion !== 1 || [identity.sourceSha256, identity.mappingSha256, identity.contractSha256].some(value => !/^[0-9a-f]{64}$/.test(value))
    || !/^\d{12}$/.test(identity.environment.accountId) || Object.values(identity.environment).some(value => typeof value !== "string" || value.length === 0)) throw failure();
}
function valid(input: LegacyValidation, deps: MigrationDeps): void {
  requireBudget(deps.budget);
  if (input.errors.length || deps.validation.errors.length || !isDeepStrictEqual(input, deps.validation)) throw failure();
}
async function runFor(identity: MigrationIdentity, deps: MigrationDeps): Promise<MigrationRun> {
  assertMigrationIdentity(identity); requireBudget(deps.budget);
  const run = await deps.migration.loadRun(identity.runId);
  if (!run || !isDeepStrictEqual(run.identity, identity) || run.phase === "published") throw failure();
  const gate = await deps.owners.gate(deps.budget);
  if (gate.published || gate.runId !== identity.runId) throw failure();
  return run;
}
/** SHA256 of a domain-separated JSON tuple, truncated to UUID with v5/variant bits. No source values enter keys. */
export function migrationImageId(runId: string, ownerPosition: number, itemPosition: number): string {
  const hex = createHash("sha256").update(JSON.stringify(["reminder-migration-image-v1", runId, ownerPosition, itemPosition])).digest("hex").slice(0, 32).split("");
  hex[12] = "5"; hex[16] = ((parseInt(hex[16]!, 16) & 3) | 8).toString(16);
  const value = hex.join(""); return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}
export async function prepareMigration(identity: MigrationIdentity, deps: MigrationDeps): Promise<void> {
  valid(deps.validation, deps); assertMigrationIdentity(identity);
  try { await deps.migration.assertEmptyOrSameRun(identity); }
  catch {
    // Only an unknown initialization outcome is recoverable; repeat the inventory check too.
    await runFor(identity, deps);
    await deps.migration.assertEmptyOrSameRun(identity);
  }
  await runFor(identity, deps);
}
function sameImage(data: Uint8Array, image: DecodedImage): boolean {
  return data.length === image.bytes && createHash("sha256").update(data).digest("hex") === image.sha256
    && Buffer.from(data).equals(Buffer.from(image.data));
}
async function recoverImage(job: ImageJob, image: DecodedImage, deps: MigrationDeps): Promise<ImageRef | null> {
  const head = await deps.images.head(job.key, job.versionId ?? null, deps.budget);
  if (!head) { if (job.versionId) throw failure(); return null; }
  if (head.deleteMarker || head.sha256 !== image.sha256 || head.versionId === "null" || head.versionId.length === 0) throw failure();
  const ref = { imageId: job.jobId, key: job.key, versionId: head.versionId, mime: image.mime, bytes: image.bytes, sha256: image.sha256 };
  if (!sameImage(await deps.images.get(ref, deps.budget), image)) throw failure(); return ref;
}
export async function importMigration(identity: MigrationIdentity, input: LegacyValidation, deps: MigrationDeps): Promise<MigrationSummary> {
  valid(input, deps); await prepareMigration(identity, deps);
  await runFor(identity, deps);
  // Completion lists are checkpoints, never evidence of actual writes. Read every item even on resume.
  const progress: MigrationProgress = { completedOwners: [], completedItems: [] };
  await deps.migration.recordVerification(identity.runId, { identity, exactMatch: false, mismatches: [{ location: "run", field: "phase", reason: "IMPORTING" }] });
  let count = 0; let imageBytes = 0;
  for (const [ownerPosition, owner] of input.owners.entries()) {
    requireBudget(deps.budget); await deps.migration.ensureOwner(owner.ownerId, identity);
    for (const [itemPosition, staged] of owner.items.entries()) {
      requireBudget(deps.budget); const image = owner.images.get(staged.id); let ref: ImageRef | null = null; let committedJob: ImageJob | null = null;
      if (image) {
        const jobId = migrationImageId(identity.runId, ownerPosition, itemPosition);
        const prior = await deps.jobs.get(jobId, deps.budget);
        if (prior && (prior.ownerId !== owner.ownerId || prior.key !== keys.image(owner.ownerId, jobId) || prior.migrationRunId !== identity.runId || !["pending", "committed"].includes(prior.state))) throw failure();
        const now = deps.clock(); const dueAtMs = now + 86_400_000;
        const job: ImageJob = prior ?? { jobId, ownerId: owner.ownerId, key: keys.image(owner.ownerId, jobId), state: "pending", createdAtMs: now, updatedAtMs: now, dueAtMs, ...cleanupKeys("pending", jobId, dueAtMs), migrationRunId: identity.runId };
        try { await deps.migration.stageImage(job, identity); }
        catch { if (!isDeepStrictEqual(await deps.jobs.get(jobId, deps.budget), job)) throw failure(); }
        ref = await recoverImage(job, image, deps);
        if (!ref) {
          try { ref = await deps.images.put(job, image, deps.budget); }
          catch { ref = await recoverImage(job, image, deps); if (!ref) throw failure(); }
          if (!ref || ref.imageId !== jobId || ref.key !== job.key || ref.mime !== image.mime || ref.bytes !== image.bytes || ref.sha256 !== image.sha256 || !sameImage(await deps.images.get(ref, deps.budget), image)) throw failure();
        }
        committedJob = { jobId, ownerId: owner.ownerId, key: job.key, state: "committed", createdAtMs: job.createdAtMs, updatedAtMs: job.updatedAtMs,
          versionId: ref.versionId, mime: ref.mime, bytes: ref.bytes, sha256: ref.sha256, migrationRunId: identity.runId };
      }
      const item: ActiveReminder = { ...staged, thumbnail: ref, migrationRunId: identity.runId };
      const existing = await deps.reminders.get(owner.ownerId, item.id, deps.budget);
      if (existing !== null && !isDeepStrictEqual(existing, item)) throw failure();
      if (existing === null) {
        try { await deps.migration.putImported(owner.ownerId, item, committedJob, identity); }
        catch {
          if (!isDeepStrictEqual(await deps.reminders.get(owner.ownerId, item.id, deps.budget), item)
            || (committedJob !== null && !isDeepStrictEqual(await deps.jobs.get(committedJob.jobId, deps.budget), committedJob))) throw failure();
        }
      } else if (committedJob && !isDeepStrictEqual(await deps.jobs.get(committedJob.jobId, deps.budget), committedJob)) throw failure();
      count++; imageBytes += image?.bytes ?? 0;
      progress.completedItems.push({ ownerPosition, itemPosition, imageId: ref?.imageId ?? null });
      // One-item batches bound each transaction and checkpoint only completed work.
      await deps.migration.saveProgress(identity.runId, progress);
    }
    progress.completedOwners.push(ownerPosition); await deps.migration.saveProgress(identity.runId, progress);
  }
  return { owners: progress.completedOwners.length, items: count, imageBytes, completed: true };
}
export async function verifyMigration(identity: MigrationIdentity, input: LegacyValidation, deps: MigrationDeps): Promise<MigrationVerification> {
  valid(input, deps); await runFor(identity, deps);
  const result: MigrationVerification = { identity, exactMatch: false, mismatches: [] };
  // Invalidate a previous success before any fallible read, including scan pagination.
  await deps.migration.recordVerification(identity.runId, { identity, exactMatch: false, mismatches: [{ location: "run", field: "verification", reason: "IN_PROGRESS" }] });
  const mismatch = (location: string, field: string, reason = "MISMATCH"): void => { result.mismatches.push({ location, field, reason }); };
  await deps.migration.assertEmptyOrSameRun(identity);
  const actual = new Map<string, StoredReminder>(); const key = (owner: string, id: string) => JSON.stringify([owner, id]);
  for await (const item of deps.migration.listRunItems(identity.runId)) { const k = key(item.ownerId, item.id); if (actual.has(k)) mismatch("run", "items", "DUPLICATE"); actual.set(k, item); }
  for (const [ownerPosition, owner] of input.owners.entries()) {
    const location = `owners[${ownerPosition}]`; let imageBytes = 0;
    for (const [itemPosition, expected] of owner.items.entries()) {
      const itemLocation = `${location}.items[${itemPosition}]`; const stored = actual.get(key(owner.ownerId, expected.id)); actual.delete(key(owner.ownerId, expected.id));
      const image = owner.images.get(expected.id); imageBytes += image?.bytes ?? 0;
      if (!stored) { mismatch(itemLocation, "item", "MISSING"); continue; }
      for (const field of Object.keys(expected).filter(field => field !== "thumbnail") as Array<keyof ActiveReminder>) {
        if (!isDeepStrictEqual(stored[field as keyof StoredReminder], expected[field])) mismatch(itemLocation, field);
      }
      if (stored.migrationRunId !== identity.runId) mismatch(itemLocation, "migrationRunId");
      if (!isDeepStrictEqual(Object.keys(stored).sort(), [...Object.keys(expected), "migrationRunId"].sort())) mismatch(itemLocation, "fields");
      if (stored.deleted) { mismatch(itemLocation, "deleted"); continue; }
      if (!image) { if (stored.thumbnail !== null) mismatch(itemLocation, "thumbnail"); continue; }
      const ref = stored.thumbnail; const imageId = migrationImageId(identity.runId, ownerPosition, itemPosition);
      if (!ref || ref.imageId !== imageId || ref.key !== keys.image(owner.ownerId, imageId) || ref.mime !== image.mime || ref.bytes !== image.bytes || ref.sha256 !== image.sha256 || !ref.versionId || ref.versionId === "null") { mismatch(itemLocation, "thumbnail"); continue; }
      try {
        const head = await deps.images.head(ref.key, ref.versionId, deps.budget);
        if (!head || head.deleteMarker || head.versionId !== ref.versionId || head.sha256 !== image.sha256 || !sameImage(await deps.images.get(ref, deps.budget), image)) mismatch(itemLocation, "thumbnail", "IMAGE_BYTES_OR_SHA256");
        const job = await deps.jobs.get(imageId, deps.budget);
        if (!job || job.migrationRunId !== identity.runId || job.state !== "committed" || job.ownerId !== owner.ownerId || job.key !== ref.key || job.versionId !== ref.versionId || job.mime !== image.mime || job.bytes !== image.bytes || job.sha256 !== image.sha256) mismatch(itemLocation, "imageJob");
      } catch { mismatch(itemLocation, "thumbnail", "IMAGE_READ_FAILED"); }
    }
    const storage = await deps.migration.getStorage(owner.ownerId);
    if (!storage || storage.migrationRunId !== identity.runId) mismatch(location, "storage", "MISSING_OR_OTHER_RUN");
    if (storage?.itemCount !== owner.items.length) mismatch(location, "itemCount");
    if (storage?.imageBytes !== imageBytes) mismatch(location, "imageBytes");
  }
  if (actual.size) mismatch("run", "items", "EXTRA");
  result.exactMatch = result.mismatches.length === 0;
  await deps.migration.recordVerification(identity.runId, result); return result;
}
export async function publishMigration(identity: MigrationIdentity, verification: MigrationVerification, deps: MigrationDeps): Promise<void> {
  if (!verification.exactMatch || verification.mismatches.length || !isDeepStrictEqual(verification.identity, identity)) throw failure();
  const fresh = await verifyMigration(identity, deps.validation, deps);
  if (!fresh.exactMatch) throw failure();
  await deps.migration.publishIfVerified(identity);
}
