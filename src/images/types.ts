import type { OwnerId } from "../reminders/types";

export interface ImageRef {
  imageId: string;
  key: string;
  versionId: string;
  mime: string;
  bytes: number;
  sha256: string;
}
export interface DecodedImage { data: Uint8Array; mime: string; bytes: number; sha256: string }
export interface ImageHead { versionId: string; sha256: string | null; deleteMarker: boolean }
export interface ImageJob {
  jobId: string;
  ownerId: OwnerId;
  key: string;
  versionId?: string;
  mime?: string;
  bytes?: number;
  sha256?: string;
  state: "pending" | "committed" | "retired" | "deleting" | "done";
  createdAtMs: number;
  updatedAtMs: number;
  dueAtMs?: number;
  leaseOwner?: string;
  cleanupPartition?: string;
  cleanupSortKey?: string;
  migrationRunId?: string;
}
export interface JobTransition {
  jobId: string;
  from: ImageJob["state"];
  to: ImageJob["state"];
  atMs: number;
  expectedVersionId?: string;
}
export type CleanupPartition = `${"pending" | "retired" | "deleting"}#${"00" | "01" | "02" | "03"}`;
export interface CleanupPage { jobs: ImageJob[]; evaluated: number; lastKey: Record<string, string> | null }
export interface CleanupCheckpoint { roundRobinIndex: number; cursors: Partial<Record<CleanupPartition, Record<string, string> | null>> }
export interface CleanupResult { evaluated: number; deletes: number; incomplete: boolean; skippedUnpublished: boolean }
