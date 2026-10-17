import { createHash } from "node:crypto";
import type { CleanupPartition } from "./types";

/** Sparse cleanup index keys, shared by producer transactions and cleanup leases. */
export function cleanupKeys(state: "pending" | "retired" | "deleting", jobId: string, dueAtMs: number): { cleanupPartition: CleanupPartition; cleanupSortKey: string } {
  if (!Number.isSafeInteger(dueAtMs) || dueAtMs < 0 || dueAtMs > 9_999_999_999_999) throw new Error("Invalid cleanup deadline");
  const shard = (createHash("sha256").update(jobId).digest()[0]! % 4).toString().padStart(2, "0") as "00" | "01" | "02" | "03";
  return { cleanupPartition: `${state}#${shard}`, cleanupSortKey: `${String(dueAtMs).padStart(13, "0")}#${jobId}` };
}
