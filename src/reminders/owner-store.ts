import { GetCommand, UpdateCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import type { Config } from "../config";
import { requireBudget } from "../shared/budget";
import { ApiError } from "../shared/errors";
import { keys, type Budget, type OwnerStore, type PublicationGate } from "../shared/ports";
import type { OwnerId } from "./types";

function unavailable(): ApiError { return new ApiError(503, "SERVICE_UNAVAILABLE", "Service temporarily unavailable"); }
const publication = z.strictObject({ pk: z.literal("GLOBAL"), sk: z.literal("PUBLICATION"), published: z.boolean(), runId: z.string().min(1).nullable() });
const isConditionalFailure = (error: unknown): boolean => error instanceof Error && error.name === "ConditionalCheckFailedException";

export function createOwnerStore(client: DynamoDBDocumentClient, config: Config): OwnerStore {
  async function gate(budget: Budget): Promise<PublicationGate> {
    try {
      requireBudget(budget);
      const response = await client.send(new GetCommand({ TableName: config.ownerStateTable, Key: keys.publication, ConsistentRead: true }), { abortSignal: budget.signal });
      if (response.Item === undefined) return { published: false, runId: null };
      const parsed = publication.safeParse(response.Item);
      if (!parsed.success) throw unavailable();
      return { published: parsed.data.published, runId: parsed.data.runId };
    } catch { throw unavailable(); }
  }
  return {
    gate,
    async consumeRate(ownerId, minute, budget) {
      try {
        if (!Number.isSafeInteger(minute) || minute < 0) throw unavailable();
        requireBudget(budget);
        await client.send(new UpdateCommand({
          TableName: config.ownerStateTable, Key: keys.rate(ownerId, minute),
          UpdateExpression: "SET #count = if_not_exists(#count, :zero) + :one, #expires = :expires",
          ConditionExpression: "attribute_not_exists(#count) OR #count < :limit",
          ExpressionAttributeNames: { "#count": "count", "#expires": "expiresAt" },
          ExpressionAttributeValues: { ":zero": 0, ":one": 1, ":limit": config.limits.ownerRequestsPerMinute, ":expires": keys.rateExpiresAt(minute) },
        }), { abortSignal: budget.signal });
        return true;
      } catch (error) {
        // An unknown write outcome is not retried: it may already have consumed a slot.
        if (isConditionalFailure(error)) return false;
        throw unavailable();
      }
    },
    async probe(budget) {
      try {
        for (const [TableName, Key] of [
          [config.remindersTable, { ownerId: "__PROBE__", id: "__PROBE__" }],
          [config.imageJobsTable, { jobId: "__PROBE__" }],
        ] as const) {
          requireBudget(budget);
          await client.send(new GetCommand({ TableName, Key, ConsistentRead: true }), { abortSignal: budget.signal });
        }
        await gate(budget);
      } catch { throw unavailable(); }
    },
  };
}

/** UTC epoch-minute keys isolate windows even while DynamoDB TTL deletion is delayed. */
export async function checkRate(store: OwnerStore, ownerId: OwnerId, nowMs: number, budget: Budget): Promise<void> {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw unavailable();
  requireBudget(budget);
  let accepted: boolean;
  try { accepted = await store.consumeRate(ownerId, Math.floor(nowMs / 60_000), budget); }
  catch { throw unavailable(); }
  if (!accepted) {
    const seconds = Math.max(1, Math.ceil((60_000 - nowMs % 60_000) / 1000));
    throw new ApiError(429, "OWNER_RATE_LIMIT_EXCEEDED", "Rate limit exceeded", seconds);
  }
}
