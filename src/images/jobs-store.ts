import { GetCommand, PutCommand, QueryCommand, UpdateCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import type { Config } from "../config";
import { requireBudget } from "../shared/budget";
import { ApiError } from "../shared/errors";
import { keys, type Budget, type JobsStore } from "../shared/ports";
import { cleanupKeys } from "./job-keys";
import type { CleanupCheckpoint, CleanupPartition, ImageJob } from "./types";

function unavailable(): ApiError { return new ApiError(503, "SERVICE_UNAVAILABLE", "Service temporarily unavailable"); }
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
const time = z.number().int().min(0).max(9_999_999_999_999);
const partition = z.string().regex(/^(pending|retired|deleting)#0[0-3]$/);
const jobSchema = z.strictObject({
  jobId: uuid, ownerId: z.string().min(1), key: z.string(), state: z.enum(["pending", "committed", "retired", "deleting", "done"]),
  createdAtMs: time, updatedAtMs: time, dueAtMs: time.optional(), leaseOwner: z.string().min(1).optional(),
  versionId: z.string().min(1).refine(value => value !== "null").optional(), mime: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]).optional(),
  bytes: z.number().int().min(1).max(1_048_576).optional(), sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  cleanupPartition: partition.optional(), cleanupSortKey: z.string().optional(), migrationRunId: z.string().min(1).optional(),
});
const cursorSchema = z.strictObject({ jobId: uuid, cleanupPartition: partition, cleanupSortKey: z.string() });
function parseCursor(value: unknown, expected: CleanupPartition): Record<string, string> {
  const result = cursorSchema.safeParse(value);
  if (!result.success || result.data.cleanupPartition !== expected || !/^\d{13}#/.test(result.data.cleanupSortKey)
    || result.data.cleanupSortKey.slice(14) !== result.data.jobId) throw unavailable();
  return result.data;
}
function parseJob(value: unknown, jobId: string): ImageJob {
  const result = jobSchema.safeParse(value);
  if (!result.success || result.data.jobId !== jobId || result.data.key !== keys.image(result.data.ownerId, jobId)
    || Object.values(result.data).some(field => field === undefined)) throw unavailable();
  const job = result.data;
  if (job.state === "pending" || job.state === "retired" || job.state === "deleting") {
    if (job.dueAtMs === undefined) throw unavailable();
    const expected = cleanupKeys(job.state, jobId, job.dueAtMs);
    if (job.cleanupPartition !== expected.cleanupPartition || job.cleanupSortKey !== expected.cleanupSortKey) throw unavailable();
    if (job.state === "pending" && job.dueAtMs !== job.createdAtMs + 86_400_000) throw unavailable();
  } else if (job.cleanupPartition !== undefined || job.cleanupSortKey !== undefined || job.dueAtMs !== undefined || job.leaseOwner !== undefined) throw unavailable();
  // R04 transition types can produce a deleting row before cleanup assigns its lease owner.
  if (job.state !== "deleting" && job.leaseOwner !== undefined) throw unavailable();
  return result.data as ImageJob;
}
function parseCheckpoint(value: unknown): CleanupCheckpoint {
  const result = z.strictObject({ roundRobinIndex: z.number().int().min(0).max(11), cursors: z.record(partition, z.unknown()) }).safeParse(value);
  if (!result.success) throw unavailable();
  const cursors: CleanupCheckpoint["cursors"] = {};
  for (const [name, cursor] of Object.entries(result.data.cursors)) {
    const p = name as CleanupPartition; cursors[p] = cursor === null ? null : parseCursor(cursor, p);
  }
  return { roundRobinIndex: result.data.roundRobinIndex, cursors };
}
const isConditionalFailure = (error: unknown): boolean => error instanceof Error && error.name === "ConditionalCheckFailedException";

export function createJobsStore(client: DynamoDBDocumentClient, config: Config): JobsStore {
  async function send<T>(budget: Budget, operation: () => Promise<T>): Promise<T> { requireBudget(budget); return operation(); }
  const store: JobsStore = {
    async createPending(job, budget) {
      try {
        if (job.state !== "pending" || job.leaseOwner !== undefined) throw unavailable();
        const dueAtMs = job.createdAtMs + 86_400_000;
        if (job.dueAtMs !== undefined && job.dueAtMs !== dueAtMs) throw unavailable();
        const item = parseJob({ ...job, dueAtMs, ...cleanupKeys("pending", job.jobId, dueAtMs) }, job.jobId);
        await send(budget, () => client.send(new PutCommand({ TableName: config.imageJobsTable, Item: item,
          ConditionExpression: "attribute_not_exists(#id)", ExpressionAttributeNames: { "#id": "jobId" } }), { abortSignal: budget.signal }));
      } catch { throw unavailable(); }
    },
    async recordUpload(ref, budget) {
      try {
        uuid.parse(ref.imageId);
        const ownerId = /^images\/([^/]+)\/([^/]+)$/.exec(ref.key)?.[1];
        if (!ownerId || ref.key !== keys.image(ownerId, ref.imageId)) throw unavailable();
        // The same validators enforce upload metadata without persisting a separate record shape.
        jobSchema.shape.versionId.unwrap().parse(ref.versionId); jobSchema.shape.mime.unwrap().parse(ref.mime);
        jobSchema.shape.bytes.unwrap().parse(ref.bytes); jobSchema.shape.sha256.unwrap().parse(ref.sha256);
        await send(budget, () => client.send(new UpdateCommand({ TableName: config.imageJobsTable, Key: { jobId: ref.imageId },
          UpdateExpression: "SET #version = :version, #mime = :mime, #bytes = :bytes, #sha = :sha",
          ConditionExpression: "#state = :pending AND #owner = :owner AND #key = :key AND (attribute_not_exists(#version) OR #version = :version)",
          ExpressionAttributeNames: { "#state": "state", "#owner": "ownerId", "#key": "key", "#version": "versionId", "#mime": "mime", "#bytes": "bytes", "#sha": "sha256" },
          ExpressionAttributeValues: { ":pending": "pending", ":owner": ownerId, ":key": ref.key, ":version": ref.versionId, ":mime": ref.mime, ":bytes": ref.bytes, ":sha": ref.sha256 },
        }), { abortSignal: budget.signal }));
      } catch { throw unavailable(); }
    },
    async get(jobId, budget) {
      try {
        uuid.parse(jobId);
        const response = await send(budget, () => client.send(new GetCommand({ TableName: config.imageJobsTable, Key: { jobId }, ConsistentRead: true }), { abortSignal: budget.signal }));
        return response.Item === undefined ? null : parseJob(response.Item, jobId);
      } catch { throw unavailable(); }
    },
    async queryDue(p, cutoffMs, after, budget) {
      try {
        partition.parse(p); time.parse(cutoffMs);
        const response = await send(budget, () => client.send(new QueryCommand({ TableName: config.imageJobsTable, IndexName: "cleanup_by_due", Limit: 50, Select: "ALL_PROJECTED_ATTRIBUTES",
          KeyConditionExpression: "#partition = :partition AND #sort <= :cutoff", ExpressionAttributeNames: { "#partition": "cleanupPartition", "#sort": "cleanupSortKey" },
          ExpressionAttributeValues: { ":partition": p, ":cutoff": `${String(cutoffMs).padStart(13, "0")}#~` },
          ...(after === null ? {} : { ExclusiveStartKey: parseCursor(after, p) }),
        }), { abortSignal: budget.signal }));
        if (!Array.isArray(response.Items ?? []) || !Number.isSafeInteger(response.ScannedCount) || response.ScannedCount! < 0 || response.ScannedCount! > 50) throw unavailable();
        const jobs: ImageJob[] = [];
        for (const candidate of response.Items ?? []) {
          const jobId = uuid.parse(candidate.jobId); const job = await store.get(jobId, budget); if (job !== null) jobs.push(job);
        }
        const lastKey = response.LastEvaluatedKey === undefined || Object.keys(response.LastEvaluatedKey).length === 0 ? null : parseCursor(response.LastEvaluatedKey, p);
        return { jobs, evaluated: response.ScannedCount!, lastKey };
      } catch { throw unavailable(); }
    },
    async claim(jobId, runId, nowMs, budget) {
      try {
        time.parse(nowMs); z.string().min(1).parse(runId);
        const job = await store.get(jobId, budget);
        if (job === null || (job.state !== "pending" && job.state !== "retired" && job.state !== "deleting") || job.dueAtMs === undefined || job.dueAtMs > nowMs) return null;
        const dueAtMs = nowMs + 1_200_000; const index = cleanupKeys("deleting", jobId, dueAtMs);
        const response = await send(budget, () => client.send(new UpdateCommand({ TableName: config.imageJobsTable, Key: { jobId }, ReturnValues: "ALL_NEW",
          UpdateExpression: "SET #state = :deleting, #lease = :run, #due = :due, #partition = :partition, #sort = :sort, #updated = :now",
          ConditionExpression: `#state = :state AND #due <= :now AND #due = :expectedDue AND #owner = :owner AND #key = :key AND ${job.versionId === undefined ? "attribute_not_exists(#version)" : "#version = :version"}`,
          ExpressionAttributeNames: { "#state": "state", "#lease": "leaseOwner", "#due": "dueAtMs", "#partition": "cleanupPartition", "#sort": "cleanupSortKey", "#updated": "updatedAtMs", "#owner": "ownerId", "#key": "key", "#version": "versionId" },
          ExpressionAttributeValues: { ":state": job.state, ":deleting": "deleting", ":run": runId, ":due": dueAtMs, ":partition": index.cleanupPartition, ":sort": index.cleanupSortKey, ":now": nowMs, ":expectedDue": job.dueAtMs, ":owner": job.ownerId, ":key": job.key, ...(job.versionId === undefined ? {} : { ":version": job.versionId }) },
        }), { abortSignal: budget.signal }));
        const claimed = parseJob(response.Attributes, jobId);
        if (claimed.state !== "deleting" || claimed.leaseOwner !== runId || claimed.dueAtMs !== dueAtMs) throw unavailable();
        return claimed;
      } catch (error) { if (isConditionalFailure(error)) return null; throw unavailable(); }
    },
    async complete(jobId, runId, budget) {
      try {
        uuid.parse(jobId); z.string().min(1).parse(runId);
        await send(budget, () => client.send(new UpdateCommand({ TableName: config.imageJobsTable, Key: { jobId },
          UpdateExpression: "SET #state = :done, #updated = :at REMOVE #partition, #sort, #due, #lease",
          ConditionExpression: "#state = :deleting AND #lease = :run", ExpressionAttributeNames: { "#state": "state", "#updated": "updatedAtMs", "#partition": "cleanupPartition", "#sort": "cleanupSortKey", "#due": "dueAtMs", "#lease": "leaseOwner" },
          ExpressionAttributeValues: { ":done": "done", ":deleting": "deleting", ":run": runId, ":at": Date.now() },
        }), { abortSignal: budget.signal }));
      } catch { throw unavailable(); }
    },
    async checkpoint(budget) {
      try {
        const response = await send(budget, () => client.send(new GetCommand({ TableName: config.imageJobsTable, Key: { jobId: keys.cleanupCheckpoint }, ConsistentRead: true }), { abortSignal: budget.signal }));
        if (response.Item === undefined) return { roundRobinIndex: 0, cursors: {} };
        const { jobId, ...value } = response.Item; if (jobId !== keys.cleanupCheckpoint) throw unavailable(); return parseCheckpoint(value);
      } catch { throw unavailable(); }
    },
    async saveCheckpoint(value, budget) {
      try {
        const item = { jobId: keys.cleanupCheckpoint, ...parseCheckpoint(value) };
        await send(budget, () => client.send(new PutCommand({ TableName: config.imageJobsTable, Item: item }), { abortSignal: budget.signal }));
      } catch { throw unavailable(); }
    },
  };
  return store;
}
