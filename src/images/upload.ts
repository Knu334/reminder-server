import type { ReminderDeps } from "../reminders/service";
import type { OwnerId } from "../reminders/types";
import { requireBudget } from "../shared/budget";
import { ApiError } from "../shared/errors";
import { keys, type Budget } from "../shared/ports";
import type { DecodedImage, ImageRef } from "./types";

/** Persist intent before Put; every failure leaves its unique pending job for cleanup after the grace period. */
export async function stageThumbnail(ownerId: OwnerId, image: DecodedImage, deps: ReminderDeps, budget: Budget): Promise<ImageRef> {
  try {
    requireBudget(budget);
    const jobId = deps.uuid(); const atMs = deps.clock();
    const job = { jobId, ownerId, key: keys.image(ownerId, jobId), state: "pending" as const, createdAtMs: atMs, updatedAtMs: atMs, dueAtMs: atMs + 86_400_000 };
    await deps.jobs.createPending(job, budget);
    requireBudget(budget);
    const ref = await deps.images.put(job, image, budget);
    requireBudget(budget);
    await deps.jobs.recordUpload(ref, budget);
    return ref;
  } catch { throw new ApiError(503, "SERVICE_UNAVAILABLE", "Service temporarily unavailable"); }
}
