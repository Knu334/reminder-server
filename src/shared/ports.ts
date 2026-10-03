import type { ChangeSet, OwnerId, QueryPage, StoredReminder } from "../reminders/types";
import type { CleanupCheckpoint, CleanupPage, CleanupPartition, DecodedImage, ImageHead, ImageJob, ImageRef } from "../images/types";

export interface Budget { signal: AbortSignal; remainingMs(): number }
export interface PublicationGate { published: boolean; runId: string | null }
/** Each adapter must validate DB records before returning them. */
export interface RemindersStore {
  get(ownerId: OwnerId, id: string, budget: Budget): Promise<StoredReminder | null>;
  query(ownerId: OwnerId, limit: number, afterId: string | null, budget: Budget): Promise<QueryPage>;
  commit(change: ChangeSet, budget: Budget): Promise<void>;
}
export interface OwnerStore {
  gate(budget: Budget): Promise<PublicationGate>;
  consumeRate(ownerId: OwnerId, minute: number, budget: Budget): Promise<boolean>;
  probe(budget: Budget): Promise<void>;
}
export interface ImagesStore {
  put(job: ImageJob, image: DecodedImage, budget: Budget): Promise<ImageRef>;
  head(key: string, versionId: string | null, budget: Budget): Promise<ImageHead | null>;
  get(ref: ImageRef, budget: Budget): Promise<Uint8Array>;
  signGet(ref: ImageRef, requestedSeconds: number, budget: Budget): Promise<string>;
  markDeleted(key: string, budget: Budget): Promise<void>;
  probe(budget: Budget): Promise<void>;
}
export interface JobsStore {
  createPending(job: ImageJob, budget: Budget): Promise<void>;
  recordUpload(ref: ImageRef, budget: Budget): Promise<void>;
  get(jobId: string, budget: Budget): Promise<ImageJob | null>;
  queryDue(partition: CleanupPartition, cutoffMs: number, after: Record<string, string> | null, budget: Budget): Promise<CleanupPage>;
  claim(jobId: string, runId: string, nowMs: number, budget: Budget): Promise<ImageJob | null>;
  complete(jobId: string, runId: string, budget: Budget): Promise<void>;
  checkpoint(budget: Budget): Promise<CleanupCheckpoint>;
  saveCheckpoint(value: CleanupCheckpoint, budget: Budget): Promise<void>;
}

/** Reminder keys are ownerId/id; image-job keys are jobId. Checkpoints have no GSI attributes. */
export const keys = {
  storage: (ownerId: OwnerId) => ({ pk: `OWNER#${ownerId}`, sk: "STORAGE" }),
  rate: (ownerId: OwnerId, minute: number) => ({ pk: `OWNER#${ownerId}`, sk: `RATE#${minute}` }),
  publication: { pk: "GLOBAL", sk: "PUBLICATION" },
  migration: (runId: string) => ({ pk: "GLOBAL", sk: `MIGRATION#${runId}` }),
  cleanupCheckpoint: "CHECKPOINT#cleanup",
  // Callers supply an ASCII UUID, never a user URL or reminder ID.
  image: (ownerId: OwnerId, imageId: string) => `images/${ownerId}/${imageId}`,
  rateExpiresAt: (minute: number) => minute * 60 + 172_800,
} as const;
