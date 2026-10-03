import { isDeepStrictEqual } from "node:util";
import { GetCommand, QueryCommand, TransactWriteCommand, type TransactWriteCommandInput, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import type { Config } from "../config";
import { cleanupKeys } from "../images/job-keys";
import { requireBudget } from "../shared/budget";
import { ApiError } from "../shared/errors";
import { keys, type Budget, type RemindersStore } from "../shared/ports";
import type { ChangeSet, OwnerId, StoredReminder } from "./types";
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
  bytes: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER), sha256: z.string().regex(/^[0-9a-f]{64}$/),
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

function storageLimit(): ApiError { return new ApiError(413, "OWNER_STORAGE_LIMIT_EXCEEDED", "Owner storage limit exceeded"); }

/** One action per item: preconditions belong to the Put/Update that performs the mutation. */
function transaction(change: ChangeSet, config: Config): TransactWriteCommand {
  if (change.next.ownerId !== change.ownerId || (change.previous !== null && (change.previous.ownerId !== change.ownerId || change.previous.id !== change.next.id))
    || !Number.isSafeInteger(change.itemDelta) || !Number.isSafeInteger(change.byteDelta) || new Set(change.jobs.map(job => job.jobId)).size !== change.jobs.length) throw unavailable();
  const maxItems = config.limits.itemCount - change.itemDelta; const minItems = Math.max(0, -change.itemDelta);
  const maxBytes = config.limits.imageBytes - change.byteDelta; const minBytes = Math.max(0, -change.byteDelta);
  if (maxItems < minItems || maxBytes < minBytes) throw storageLimit();
  const bounded = (alias: string, min: string, max: string, minimum: number): string => minimum === 0
    ? `(attribute_not_exists(${alias}) OR ${alias} BETWEEN ${min} AND ${max})` : `${alias} BETWEEN ${min} AND ${max}`;
  const actions: NonNullable<TransactWriteCommandInput["TransactItems"]> = [{ Put: {
    TableName: config.remindersTable, Item: change.next,
    ConditionExpression: change.previous === null ? "attribute_not_exists(#id)" : "attribute_exists(#id) AND #deleted = :false AND #revision = :revision",
    ExpressionAttributeNames: change.previous === null ? { "#id": "id" } : { "#id": "id", "#deleted": "deleted", "#revision": "revision" },
    ...(change.previous === null ? {} : { ExpressionAttributeValues: { ":false": false, ":revision": change.previous.revision } }),
  } }, { Update: {
    TableName: config.ownerStateTable, Key: keys.storage(change.ownerId),
    UpdateExpression: "SET #items = if_not_exists(#items, :zero) + :itemDelta, #bytes = if_not_exists(#bytes, :zero) + :byteDelta",
    ConditionExpression: `${bounded("#items", ":minItems", ":maxItems", minItems)} AND ${bounded("#bytes", ":minBytes", ":maxBytes", minBytes)}`,
    ExpressionAttributeNames: { "#items": "itemCount", "#bytes": "imageBytes" },
    ExpressionAttributeValues: { ":zero": 0, ":itemDelta": change.itemDelta, ":byteDelta": change.byteDelta, ":minItems": minItems, ":maxItems": maxItems, ":minBytes": minBytes, ":maxBytes": maxBytes },
  } }];
  for (const transition of change.jobs) {
    const names: Record<string, string> = { "#owner": "ownerId", "#state": "state", "#updated": "updatedAtMs", "#partition": "cleanupPartition", "#sort": "cleanupSortKey", "#due": "dueAtMs", "#lease": "leaseOwner" };
    const values: Record<string, unknown> = { ":owner": change.ownerId, ":from": transition.from, ":to": transition.to, ":at": transition.atMs };
    let condition = "#owner = :owner AND #state = :from";
    if (transition.expectedVersionId !== undefined) { names["#version"] = "versionId"; values[":version"] = transition.expectedVersionId; condition += " AND #version = :version"; }
    let update = "SET #state = :to, #updated = :at";
    if (transition.to === "pending" || transition.to === "retired" || transition.to === "deleting") {
      const dueAtMs = transition.atMs + (transition.to === "deleting" ? 1_200_000 : 86_400_000);
      const index = cleanupKeys(transition.to, transition.jobId, dueAtMs);
      values[":due"] = dueAtMs; values[":partition"] = index.cleanupPartition; values[":sort"] = index.cleanupSortKey;
      update += ", #due = :due, #partition = :partition, #sort = :sort";
      // JobTransition has no lease owner; cleanup claim() owns deleting transitions/leases.
      update += " REMOVE #lease";
    } else update += " REMOVE #partition, #sort, #due, #lease";
    actions.push({ Update: { TableName: config.imageJobsTable, Key: { jobId: transition.jobId }, UpdateExpression: update, ConditionExpression: condition, ExpressionAttributeNames: names, ExpressionAttributeValues: values } });
  }
  return new TransactWriteCommand({ TransactItems: actions, ClientRequestToken: change.clientRequestToken });
}

function cancellationCodes(error: unknown): string[] | null {
  if (!(error instanceof Error) || error.name !== "TransactionCanceledException") return null;
  const reasons: unknown = Reflect.get(error, "CancellationReasons");
  if (!Array.isArray(reasons)) return null;
  return reasons.map(reason => typeof reason === "object" && reason !== null && typeof Reflect.get(reason, "Code") === "string" ? Reflect.get(reason, "Code") as string : "Unknown");
}
function knownRetry(error: unknown, codes: string[] | null): boolean {
  const retryCodes = ["TransactionConflict", "ProvisionedThroughputExceeded", "ThrottlingError"];
  if (codes !== null) return codes.some(code => retryCodes.includes(code)) && codes.every(code => code === "None" || retryCodes.includes(code));
  return error instanceof Error && ["TransactionConflictException", "TransactionInProgressException", "ProvisionedThroughputExceededException", "ThrottlingException", "RequestLimitExceeded"].includes(error.name);
}

export function createRemindersStore(client: DynamoDBDocumentClient, config: Config): RemindersStore {
  const store: RemindersStore = {
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
    async commit(change, budget: Budget) {
      const command = transaction(change, config); let uncertain = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          requireBudget(budget);
          await client.send(command, { abortSignal: budget.signal });
          return;
        } catch (error) {
          const codes = cancellationCodes(error);
          if (!uncertain && codes?.[0] === "ConditionalCheckFailed") throw new ApiError(change.previous === null ? 409 : 412, change.previous === null ? "ALREADY_EXISTS" : "PRECONDITION_FAILED", change.previous === null ? "Reminder already exists" : "Reminder has changed");
          if (!uncertain && codes?.[1] === "ConditionalCheckFailed") throw storageLimit();
          if (codes?.some(code => code === "ConditionalCheckFailed") || (error instanceof ApiError)) throw unavailable();
          if (knownRetry(error, codes)) continue;
          if (codes !== null || (error instanceof Error && ["ValidationException", "AccessDeniedException", "IdempotentParameterMismatchException"].includes(error.name))) throw unavailable();
          uncertain = true;
          try {
            const actual = await store.get(change.ownerId, change.next.id, budget);
            if (isDeepStrictEqual(actual, change.next)) {
              let jobsMatch = true;
              for (const transition of change.jobs) {
                requireBudget(budget);
                const response = await client.send(new GetCommand({ TableName: config.imageJobsTable, Key: { jobId: transition.jobId }, ConsistentRead: true }), { abortSignal: budget.signal });
                const job = response.Item;
                if (job === undefined || job.jobId !== transition.jobId || job.ownerId !== change.ownerId || job.state !== transition.to
                  || (transition.expectedVersionId !== undefined && job.versionId !== transition.expectedVersionId)) jobsMatch = false;
              }
              if (jobsMatch) return;
            }
          } catch { throw unavailable(); }
          // Same command and token only: never manufacture a fresh operation after an unknown outcome.
        }
      }
      throw unavailable();
    },
  };
  return store;
}
