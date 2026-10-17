import { randomUUID } from "node:crypto";
import type { Context } from "aws-lambda";
import { loadConfig } from "./config";
import { runCleanup, type CleanupDeps } from "./cleanup/service";
import { createJobsStore } from "./images/jobs-store";
import { createImagesStore } from "./images/s3-store";
import { createOwnerStore } from "./reminders/owner-store";
import { createAwsClients } from "./shared/aws";
import { createBudget } from "./shared/budget";
import { ApiError } from "./shared/errors";
import { logEvent } from "./shared/logging";

function validateEvent(event: unknown): void {
  const invalid = (): never => { throw new ApiError(400, "INVALID_CLEANUP_EVENT", "Invalid cleanup event"); };
  if (typeof event !== "object" || event === null || Array.isArray(event)) invalid();
  const strings = ["version", "id", "detail-type", "source", "account", "time", "region", "scheduledTime", "executionId", "scheduleArn"];
  for (const [key, value] of Object.entries(event as Record<string, unknown>)) {
    if (strings.includes(key)) { if (typeof value !== "string") invalid(); }
    else if (key === "attemptNumber") { if (typeof value !== "string" && (!Number.isSafeInteger(value) || Number(value) < 1)) invalid(); }
    else if (key === "resources") { if (!Array.isArray(value) || !value.every((item: unknown) => typeof item === "string")) invalid(); }
    else if (key === "detail") { if (typeof value !== "object" || value === null || Array.isArray(value) || Object.keys(value).length !== 0) invalid(); }
    else invalid();
  }
  const source = (event as Record<string, unknown>).source;
  if (source !== undefined && source !== "aws.events" && source !== "aws.scheduler") invalid();
}
export function createCleanupHandler(deps: CleanupDeps): (event: unknown, context: Context) => ReturnType<typeof runCleanup> {
  return async (event, context) => {
    validateEvent(event);
    const budget = createBudget(() => context.getRemainingTimeInMillis(), 0);
    logEvent({ lambdaRequestId: context.awsRequestId, operation: "cleanup_start" });
    return runCleanup(deps, budget);
  };
}
let production: ReturnType<typeof createCleanupHandler> | undefined;
export async function handler(event: unknown, context: Context): ReturnType<typeof runCleanup> {
  validateEvent(event);
  if (production === undefined) {
    const config = loadConfig(process.env); const clients = createAwsClients(config);
    production = createCleanupHandler({ jobs: createJobsStore(clients.dynamo, config), images: createImagesStore(clients.s3, config), owners: createOwnerStore(clients.dynamo, config), config, clock: Date.now, uuid: randomUUID, metrics: clients.cloudWatch });
  }
  return production(event, context);
}
