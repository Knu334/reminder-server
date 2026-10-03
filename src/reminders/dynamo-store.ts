import { GetCommand, QueryCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import type { Config } from "../config";
import { requireBudget } from "../shared/budget";
import { ApiError } from "../shared/errors";
import { keys, type RemindersStore } from "../shared/ports";
import type { OwnerId, StoredReminder } from "./types";
import { parseLimit } from "./cursor";
import { normalizeInstant, parseCreate, parseReminderId } from "./validation";

function unavailable(): ApiError { return new ApiError(503, "SERVICE_UNAVAILABLE", "Service temporarily unavailable"); }
const instant = z.string().refine((value) => {
  try { return normalizeInstant(value) === value; } catch { return false; }
});
const base = { ownerId: z.string().min(1), id: z.string(), revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER), migrationRunId: z.string().min(1).optional() };
const image = z.strictObject({
  imageId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
  key: z.string(), versionId: z.string().min(1), mime: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
  bytes: z.number().int().min(1).max(1_048_576), sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
const stored = z.discriminatedUnion("deleted", [
  z.strictObject({ ...base, deleted: z.literal(true), deletedAt: instant }),
  z.strictObject({ ...base, deleted: z.literal(false), url: z.string(), title: z.string(), reminderTime: instant,
    autoOpen: z.boolean(), webPush: z.boolean(), hidden: z.boolean(), createdAt: instant, updatedAt: instant, thumbnail: image.nullable() }),
]);
const evaluatedKey = z.strictObject({ ownerId: z.string(), id: z.string() });

/** Validate the storage shape before filtering deletion records or exposing an image reference. */
export function parseStoredReminder(value: unknown, ownerId: OwnerId, id?: string): StoredReminder {
  try {
    const parsed = stored.safeParse(value);
    if (!parsed.success || parsed.data.ownerId !== ownerId || (id !== undefined && parsed.data.id !== id)) throw unavailable();
    const record = parsed.data;
    parseReminderId(record.id);
    if (!record.deleted) {
      parseCreate({ id: record.id, url: record.url, title: record.title, reminderTime: record.reminderTime,
        autoOpen: record.autoOpen, webPush: record.webPush, hidden: record.hidden, thumbnail: null });
      if (record.thumbnail !== null && record.thumbnail.key !== keys.image(ownerId, record.thumbnail.imageId)) throw unavailable();
    }
    const { migrationRunId, ...required } = record;
    if (Object.hasOwn(record, "migrationRunId") && migrationRunId === undefined) throw unavailable();
    return migrationRunId === undefined ? required : { ...required, migrationRunId };
  } catch { throw unavailable(); }
}

export function createRemindersStore(client: DynamoDBDocumentClient, config: Config): RemindersStore {
  return {
    async get(ownerId, id, budget) {
      parseReminderId(id);
      try {
        requireBudget(budget);
        const response = await client.send(new GetCommand({ TableName: config.remindersTable, Key: { ownerId, id }, ConsistentRead: true }), { abortSignal: budget.signal });
        return response.Item === undefined ? null : parseStoredReminder(response.Item, ownerId, id);
      } catch { throw unavailable(); }
    },
    async query(ownerId, limit, afterId, budget) {
      const pageLimit = parseLimit(limit);
      if (afterId !== null) parseReminderId(afterId);
      try {
        requireBudget(budget);
        const response = await client.send(new QueryCommand({
          TableName: config.remindersTable, ConsistentRead: true, Limit: pageLimit,
          KeyConditionExpression: "#owner = :owner", ExpressionAttributeNames: { "#owner": "ownerId" }, ExpressionAttributeValues: { ":owner": ownerId },
          ...(afterId === null ? {} : { ExclusiveStartKey: { ownerId, id: afterId } }),
        }), { abortSignal: budget.signal });
        if (response.Items !== undefined && !Array.isArray(response.Items)) throw unavailable();
        const records = (response.Items ?? []).map((value) => parseStoredReminder(value, ownerId));
        let lastId: string | null = null;
        if (response.LastEvaluatedKey !== undefined) {
          const parsed = evaluatedKey.safeParse(response.LastEvaluatedKey);
          if (!parsed.success || parsed.data.ownerId !== ownerId) throw unavailable();
          lastId = parseReminderId(parsed.data.id);
        }
        return { records: records.filter((record) => !record.deleted), lastId };
      } catch { throw unavailable(); }
    },
    async commit(_change, _budget) { throw new Error("Reminder writes are not implemented"); },
  };
}
