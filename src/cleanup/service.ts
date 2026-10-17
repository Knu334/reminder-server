import type { CloudWatchClient } from "@aws-sdk/client-cloudwatch";
import type { Config } from "../config";
import type { CleanupCheckpoint, CleanupPartition, CleanupResult, ImageJob } from "../images/types";
import { requireBudget } from "../shared/budget";
import { ApiError } from "../shared/errors";
import { logEvent } from "../shared/logging";
import type { Budget, JobsStore, ImagesStore, OwnerStore } from "../shared/ports";
import { withCleanupDeadline } from "./budget";
import { emitCleanupMetrics } from "./metrics";

export interface CleanupDeps { jobs: JobsStore; images: ImagesStore; owners: OwnerStore; clock(): number; uuid(): string; metrics: CloudWatchClient; config: Config }
const partitions: readonly CleanupPartition[] = ["pending#00", "pending#01", "pending#02", "pending#03", "retired#00", "retired#01", "retired#02", "retired#03", "deleting#00", "deleting#01", "deleting#02", "deleting#03"];
class WorkStopped extends Error {}
const unavailable = (): ApiError => new ApiError(503, "SERVICE_UNAVAILABLE", "Service temporarily unavailable");

export async function runCleanup(deps: CleanupDeps, budget: Budget): Promise<CleanupResult> {
  const startedAt = deps.clock(); const runId = deps.uuid();
  const result: CleanupResult = { evaluated: 0, deletes: 0, incomplete: false, skippedUnpublished: false };
  let checkpoint: CleanupCheckpoint | null = null; let failed = false; let deleteAttempts = 0;
  const workingMs = (): number => Math.max(0, Math.min(budget.remainingMs() - 60_000, 600_000 - (deps.clock() - startedAt)));
  const canStart = (): boolean => !failed && workingMs() > 0 && deleteAttempts < 5_000;
  async function work<T>(operation: (active: Budget) => Promise<T>): Promise<T> {
    if (workingMs() <= 0) throw new WorkStopped();
    try { return await withCleanupDeadline(budget, workingMs, operation); }
    catch (error) { if (workingMs() <= 0) throw new WorkStopped(); throw error; }
  }
  async function read<T>(operation: (active: Budget) => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try { return await work(operation); }
      catch (error) { if (error instanceof WorkStopped || attempt === 3) throw error; }
    }
  }
  async function claim(job: ImageJob): Promise<ImageJob | null> {
    for (let attempt = 1; ; attempt++) {
      try { return await work(active => deps.jobs.claim(job.jobId, runId, deps.clock(), active)); }
      catch (error) {
        if (error instanceof WorkStopped) throw error;
        const current = await read(active => deps.jobs.get(job.jobId, active));
        if (current?.state === "deleting" && current.leaseOwner === runId) return current;
        if (current === null || current.state === "committed" || current.state === "done" || (current.dueAtMs ?? Infinity) > deps.clock()) return null;
        if (attempt === 3) throw error;
      }
    }
  }
  async function complete(job: ImageJob): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try { await work(active => deps.jobs.complete(job.jobId, runId, active)); return; }
      catch (error) {
        if (error instanceof WorkStopped) throw error;
        const current = await read(active => deps.jobs.get(job.jobId, active));
        if (current?.state === "done") return;
        if (attempt === 3 || current?.state !== "deleting" || current.leaseOwner !== runId) throw error;
      }
    }
  }
  async function candidate(job: ImageJob): Promise<boolean> {
    if (job.state === "committed" || job.state === "done" || (job.dueAtMs ?? Infinity) > startedAt) return true;
    if (!canStart()) return false;
    const claimed = await claim(job); if (claimed === null) return true;
    let attemptedDelete = false;
    for (let attempt = 1; ; attempt++) {
      const head = await read(active => deps.images.head(claimed.key, null, active));
      if (head === null || head.deleteMarker) { if (attemptedDelete) result.deletes++; await complete(claimed); return true; }
      if ((claimed.versionId !== undefined && head.versionId !== claimed.versionId) || (claimed.sha256 !== undefined && head.sha256 !== claimed.sha256)) return true;
      if (!canStart()) return false;
      // Reserve before awaiting: concurrent workers and uncertain outcomes consume the cap.
      deleteAttempts++; attemptedDelete = true;
      try { await work(active => deps.images.markDeleted(claimed.key, active)); }
      catch (error) {
        if (error instanceof WorkStopped) throw error;
        if (attempt === 3) {
          const reconciled = await read(active => deps.images.head(claimed.key, null, active));
          if (reconciled === null || reconciled.deleteMarker) { result.deletes++; await complete(claimed); return true; }
          throw error;
        }
        // Re-read the current HEAD before a new marker mutation; never delete a version.
        continue;
      }
      result.deletes++;
      await complete(claimed);
      return true;
    }
  }
  async function finalRead<T>(operation: (active: Budget) => Promise<T>): Promise<T> {
    return withCleanupDeadline(budget, () => budget.remainingMs(), operation);
  }
  try {
    const gate = await finalRead(active => deps.owners.gate(active));
    if (!gate.published) { result.skippedUnpublished = true; return result; }
    checkpoint = await finalRead(active => deps.jobs.checkpoint(active));
    const ended = new Set<CleanupPartition>();
    while (ended.size < partitions.length) {
      if (!canStart() || result.evaluated + 50 > 10_000) { result.incomplete = true; break; }
      const index = checkpoint.roundRobinIndex; const partition = partitions[index]!;
      checkpoint.roundRobinIndex = (index + 1) % partitions.length;
      if (ended.has(partition)) continue;
      // One bounded Query per turn; do not retry a query whose ScannedCount is unknown.
      const page = await work(active => deps.jobs.queryDue(partition, startedAt, checkpoint!.cursors[partition] ?? null, active));
      result.evaluated += page.evaluated;
      let next = 0; let pageComplete = true;
      const workers = Array.from({ length: Math.min(4, page.jobs.length) }, async () => {
        while (next < page.jobs.length) {
          if (!canStart()) { pageComplete = false; return; }
          const job = page.jobs[next++]!;
          try { if (!await candidate(job)) { pageComplete = false; return; } }
          catch (error) { pageComplete = false; if (!(error instanceof WorkStopped)) failed = true; else result.incomplete = true; return; }
        }
      });
      await Promise.allSettled(workers);
      if (!pageComplete) { result.incomplete = true; break; }
      checkpoint.cursors[partition] = page.lastKey;
      if (page.lastKey === null) ended.add(partition);
    }
  } catch (error) { result.incomplete = true; if (!(error instanceof WorkStopped)) failed = true; }
  // All candidate transports have settled before the saved page cursors and metrics.
  let checkpointSaved = false;
  if (checkpoint !== null) {
    try { await finalRead(active => deps.jobs.saveCheckpoint(checkpoint!, active)); checkpointSaved = true; }
    catch { result.incomplete = true; failed = true; }
  }
  try { await emitCleanupMetrics(result, checkpointSaved && !failed, deps.metrics, budget); }
  catch { result.incomplete = true; failed = true; }
  logEvent({ requestId: runId, operation: "cleanup", evaluated: result.evaluated, deletes: result.deletes, incomplete: result.incomplete, durationMs: Math.max(0, deps.clock() - startedAt), ...(failed ? { code: "SERVICE_UNAVAILABLE", status: 503 } : { status: 200 }) });
  if (failed) throw unavailable();
  requireBudget(budget);
  return result;
}
