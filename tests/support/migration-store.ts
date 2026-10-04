import { isDeepStrictEqual } from "node:util";
import type { MigrationIdentity, LegacyValidation } from "../../scripts/operations/legacy";
import type { MigrationDeps, MigrationRun, MigrationStore } from "../../scripts/operations/migration";
import type { StoredReminder, ActiveReminder } from "../../src/reminders/types";
import type { ImageJob, ImageRef } from "../../src/images/types";
import type { Budget, ImagesStore, JobsStore, RemindersStore, OwnerStore } from "../../src/shared/ports";
import { testBudget } from "./fixtures";

/** Stateful external ports: transactions and versioned object writes survive a new deps instance. */
export function migrationHarness(input: LegacyValidation) {
  const items = new Map<string, StoredReminder>(); const jobs = new Map<string, ImageJob>();
  const storage = new Map<string, { itemCount: number; imageBytes: number; migrationRunId: string }>();
  const objects = new Map<string, { ref: ImageRef; data: Uint8Array }>();
  let run: MigrationRun | null = null; const gate = { published: false, runId: null as string | null };
  let puts = 0; let sequence = 0; let commits = 0;
  const faults = new Map<string, "before" | "after">();
  const key = (owner: string, id: string) => JSON.stringify([owner, id]);
  function fault(point: string, phase: "before" | "after") {
    if (faults.get(point) === phase) { faults.delete(point); throw new Error("synthetic API503"); }
  }
  function same(identity: MigrationIdentity) {
    if (!run || !isDeepStrictEqual(run.identity, identity) || gate.published || gate.runId !== identity.runId) throw new Error("migration identity or gate");
  }
  const store: MigrationStore = {
    async assertEmptyOrSameRun(identity) {
      if (gate.published) throw new Error("published");
      if (run) { same(identity); return; }
      if (items.size || storage.size || jobs.size || gate.runId !== null) throw new Error("not empty");
      fault("prepare", "before");
      run = { identity: structuredClone(identity), phase: "importing", progress: { completedOwners: [], completedItems: [] }, verification: null };
      gate.runId = identity.runId; fault("prepare", "after");
    },
    async loadRun(runId) { return run?.identity.runId === runId ? structuredClone(run) : null; },
    async saveProgress(runId, progress) {
      if (!run || gate.published || run.identity.runId !== runId) throw new Error("run");
      fault("progress", "before"); run.progress = structuredClone(progress); run.phase = "importing"; run.verification = null; fault("progress", "after");
    },
    async stageImage(job, identity) {
      same(identity); fault("stage", "before"); const existing = jobs.get(job.jobId);
      if (existing && (existing.migrationRunId !== identity.runId || existing.ownerId !== job.ownerId || existing.key !== job.key)) throw new Error("job conflict");
      if (!existing) jobs.set(job.jobId, structuredClone(job)); fault("stage", "after");
    },
    async ensureOwner(owner, identity) {
      same(identity); fault("owner", "before");
      if (!storage.has(owner)) storage.set(owner, { itemCount: 0, imageBytes: 0, migrationRunId: identity.runId }); fault("owner", "after");
    },
    async getStorage(owner) { return structuredClone(storage.get(owner) ?? null); },
    async putImported(owner, item, imageJob, identity) {
      same(identity); fault("commit", "before");
      const existing = items.get(key(owner, item.id));
      if (existing) { if (!isDeepStrictEqual(existing, item)) throw new Error("item conflict"); return; }
      const counter = storage.get(owner); if (!counter) throw new Error("missing owner");
      items.set(key(owner, item.id), structuredClone(item)); counter.itemCount++; counter.imageBytes += item.thumbnail?.bytes ?? 0;
      if (imageJob) jobs.set(imageJob.jobId, structuredClone(imageJob)); commits++; fault("commit", "after");
    },
    async recordVerification(runId, result) {
      if (!run || run.identity.runId !== runId || !isDeepStrictEqual(run.identity, result.identity) || gate.published) throw new Error("verification identity");
      fault("verify", "before"); run.verification = structuredClone(result); run.phase = result.exactMatch ? "verified" : "importing"; fault("verify", "after");
    },
    async publishIfVerified(identity) {
      same(identity); if (run?.phase !== "verified" || run.verification?.exactMatch !== true || !isDeepStrictEqual(run.verification.identity, identity)) throw new Error("unverified");
      fault("publish", "before"); gate.published = true; run.phase = "published"; fault("publish", "after");
    },
    async *listRunItems(runId) { for (const item of items.values()) { fault("page", "before"); if (item.migrationRunId === runId) yield structuredClone(item); } },
  };
  const images: ImagesStore = {
    async put(job, image) {
      fault("put", "before"); if (objects.has(job.key)) throw new Error("conditional existing object");
      const ref: ImageRef = { imageId: job.jobId, key: job.key, versionId: `v${++puts}`, mime: image.mime, bytes: image.bytes, sha256: image.sha256 };
      objects.set(job.key, { ref, data: Buffer.from(image.data) }); fault("put", "after"); return structuredClone(ref);
    },
    async head(key, version) { fault("head", "before"); const obj = objects.get(key); return obj && (version === null || obj.ref.versionId === version) ? { versionId: obj.ref.versionId, sha256: obj.ref.sha256, deleteMarker: false } : null; },
    async get(ref) { fault("getImage", "before"); const obj = objects.get(ref.key); if (!obj || obj.ref.versionId !== ref.versionId) throw new Error("missing image"); return Buffer.from(obj.data); },
    async signGet() { throw new Error("forbidden"); }, async markDeleted() { throw new Error("forbidden"); }, async probe() {},
  };
  const reminders = { async get(owner: string, id: string) { return structuredClone(items.get(key(owner, id)) ?? null); } } as unknown as RemindersStore;
  const jobsPort = { async get(id: string) { return structuredClone(jobs.get(id) ?? null); } } as unknown as JobsStore;
  const owners = { async gate() { return structuredClone(gate); } } as unknown as OwnerStore;
  return {
    store, owners, items, storage, objects, jobs,
    deps(): MigrationDeps { return { migration: store, reminders, images, jobs: jobsPort, owners, validation: input, budget: testBudget(), clock: () => 1_791_072_000_000, uuid: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}` }; },
    fail(point: string, phase: "before" | "after") { faults.set(point, phase); },
    get puts() { return puts; }, get commits() { return commits; },
    ownerCount(owner: string) { return storage.get(owner)?.itemCount ?? 0; },
    setPublished() { gate.published = true; },
    mutateItem(mutator: (item: ActiveReminder) => void) { mutator([...items.values()][0] as ActiveReminder); },
  };
}

/** Real production migration/runtime adapters over an in-memory DynamoDB/S3 transport. */
export async function migrationAdapterHarness(identity: MigrationIdentity, validation: LegacyValidation) {
  const { loadConfig } = await import("../../src/config");
  const config = loadConfig({ AWS_REGION: identity.environment.region, REMINDERS_TABLE: identity.environment.remindersTable, OWNER_STATE_TABLE: identity.environment.ownerStateTable,
    IMAGE_JOBS_TABLE: identity.environment.imageJobsTable, IMAGES_BUCKET: identity.environment.imagesBucket, EXPECTED_API_ID: "synthetic", EXPECTED_API_STAGE: "synthetic", COGNITO_ISSUER: identity.environment.issuer, COGNITO_CLIENT_ID: "synthetic" });
  const { GetCommand, ScanCommand, TransactWriteCommand } = await import("@aws-sdk/lib-dynamodb");
  const { PutObjectCommand, HeadObjectCommand, GetObjectCommand } = await import("@aws-sdk/client-s3");
  const { createMigrationStore, createMigrationImagesStore } = await import("../../scripts/operations/migration-store");
  const { createRemindersStore } = await import("../../src/reminders/dynamo-store");
  const { createOwnerStore } = await import("../../src/reminders/owner-store");
  const { createJobsStore } = await import("../../src/images/jobs-store");
  type Row = Record<string, unknown>;
  const tables = new Map<string, Map<string, Row>>([config.remindersTable, config.ownerStateTable, config.imageJobsTable].map(name => [name, new Map()]));
  const faults = new Map<string, "before" | "after">(); const sent: unknown[] = []; let versions = 0; let commitNumber = 0; let stopCommitNumber = 0; let chunkNumber = 0; let stopChunkNumber = 0;
  const objects = new Map<string, { version: string; data: Uint8Array; sha256: string; mime: string }>();
  const keyFor = (row: Row): Row => row.pk !== undefined ? { pk: row.pk, sk: row.sk } : row.jobId !== undefined ? { jobId: row.jobId } : { ownerId: row.ownerId, id: row.id };
  const encodedKey = (row: Row) => JSON.stringify(keyFor(row));
  function fault(point: string, phase: "before" | "after") { if (faults.get(point) === phase) { faults.delete(point); throw new Error("synthetic timeout"); } }
  function table(name: string) { const value = tables.get(name); if (!value) throw new Error("unknown table"); return value; }
  function condition(row: Row | undefined, names: Record<string, string>, values: Row, expression: string): boolean {
    const tokens = expression.match(/attribute_not_exists|attribute_exists|BETWEEN|AND|OR|#[A-Za-z]+|:[A-Za-z]+|[()=]/g) ?? []; let cursor = 0;
    const take = () => { const token = tokens[cursor++]; if (!token) throw new Error("invalid expression"); return token; };
    const expect = (token: string) => { if (take() !== token) throw new Error("unsupported expression"); };
    const operand = (token: string): unknown => token.startsWith(":") ? values[token] : row?.[names[token]!];
    function primary(): boolean {
      const token = take(); if (token === "(") { const result = or(); expect(")"); return result; }
      if (token === "attribute_not_exists" || token === "attribute_exists") { expect("("); const value = operand(take()); expect(")"); return token === "attribute_exists" ? value !== undefined : value === undefined; }
      const left = operand(token); const operation = take();
      if (operation === "BETWEEN") { const low = operand(take()); expect("AND"); const high = operand(take()); return typeof left === "number" && typeof low === "number" && typeof high === "number" && left >= low && left <= high; }
      if (operation !== "=") throw new Error("unsupported comparison"); const right = operand(take()); return left !== undefined && right !== undefined && isDeepStrictEqual(left, right);
    }
    function and(): boolean { let result = primary(); while (tokens[cursor] === "AND") { take(); const right = primary(); result = result && right; } return result; }
    function or(): boolean { let result = and(); while (tokens[cursor] === "OR") { take(); const right = and(); result = result || right; } return result; }
    if (!tokens.length) return true; const result = or(); if (cursor !== tokens.length) throw new Error("incomplete condition"); return result;
  }
  function update(row: Row, names: Record<string, string>, values: Row, expression: string): Row {
    const next = structuredClone(row);
    for (const clause of expression.replace(/^SET /, "").split(", ")) {
      const assignment = /^(#[A-Za-z]+) = (:[A-Za-z]+)$/.exec(clause);
      const addition = /^(#[A-Za-z]+) = (#[A-Za-z]+) \+ (:[A-Za-z]+)$/.exec(clause);
      if (assignment) next[names[assignment[1]!]!] = structuredClone(values[assignment[2]!]);
      else if (addition) next[names[addition[1]!]!] = Number(row[names[addition[2]!]!]) + Number(values[addition[3]!]);
      else throw new Error("unsupported update");
    }
    return next;
  }
  const dynamo = { async send(command: unknown): Promise<unknown> {
    sent.push(command);
    if (command instanceof GetCommand) { assertStrong(command.input.ConsistentRead); const row = table(command.input.TableName!).get(encodedKey(command.input.Key!)); return row ? { Item: structuredClone(row) } : {}; }
    if (command instanceof ScanCommand) {
      assertStrong(command.input.ConsistentRead); fault("scan", "before");
      const rows = [...table(command.input.TableName!).values()].sort((a, b) => encodedKey(a).localeCompare(encodedKey(b)));
      const start = command.input.ExclusiveStartKey ? rows.findIndex(row => encodedKey(row) === encodedKey(command.input.ExclusiveStartKey!)) + 1 : 0;
      const page = rows.slice(start, start + 2); const last = page.at(-1);
      return { Items: structuredClone(page), ...(start + 2 < rows.length && last ? { LastEvaluatedKey: keyFor(last) } : {}) };
    }
    if (command instanceof TransactWriteCommand) {
      const actions = command.input.TransactItems!;
      const point = actions.some(action => action.Put?.Item?.sk === `MIGRATION#${identity.runId}`) ? "initialize"
        : actions.some(action => String(action.Put?.Item?.sk).includes("#CHUNK#")) ? "chunk"
        : actions.some(action => action.Put?.TableName === config.remindersTable) ? "commit"
          : actions.some(action => action.Put?.Item?.state === "pending") ? "stage"
            : actions.some(action => action.Put?.Item?.sk === "STORAGE") ? "owner"
              : actions.some(action => action.Update?.ExpressionAttributeValues?.[":true"] === true) ? "publish"
                : actions.some(action => action.Update?.ExpressionAttributeNames?.["#progress"]) ? "progress" : "verify";
      if (point === "commit" && ++commitNumber === stopCommitNumber) { stopCommitNumber = 0; throw new Error("synthetic API503 midway"); }
      if (point === "chunk" && ++chunkNumber === stopChunkNumber) { stopChunkNumber = 0; throw new Error("synthetic partial chunk failure"); }
      fault(point, "before"); const mutations: Array<{ bucket: Map<string, Row>; key: string; row: Row }> = []; const unique = new Set<string>();
      for (const action of actions) {
        const input = action.Put ?? action.Update ?? action.ConditionCheck; if (!input) throw new Error("unsupported action");
        const keyRow = action.Put ? action.Put.Item! : action.Update ? action.Update.Key! : action.ConditionCheck!.Key!;
        const bucket = table(input.TableName!); const key = encodedKey(keyRow); const identity = `${input.TableName}:${key}`;
        if (unique.has(identity)) throw new Error("duplicate action"); unique.add(identity);
        const existing = bucket.get(key);
        if (!condition(existing, input.ExpressionAttributeNames ?? {}, input.ExpressionAttributeValues ?? {}, input.ConditionExpression ?? "")) throw new Error("synthetic conditional failure");
        if (action.Put) mutations.push({ bucket, key, row: structuredClone(action.Put.Item!) });
        else if (action.Update) mutations.push({ bucket, key, row: update(existing ?? keyRow, action.Update.ExpressionAttributeNames ?? {}, action.Update.ExpressionAttributeValues ?? {}, action.Update.UpdateExpression!) });
      }
      for (const mutation of mutations) {
        if (Buffer.byteLength(JSON.stringify(mutation.row), "utf8") > 400 * 1024) throw new Error("synthetic DynamoDB item exceeds400KiB");
      }
      for (const mutation of mutations) mutation.bucket.set(mutation.key, mutation.row);
      fault(point, "after"); return {};
    }
    throw new Error("unsupported DynamoDB command");
  } } as unknown as import("@aws-sdk/lib-dynamodb").DynamoDBDocumentClient;
  function assertStrong(value: unknown) { if (value !== true) throw new Error("weak read"); }
  const s3 = { async send(command: unknown): Promise<unknown> {
    sent.push(command);
    if (command instanceof PutObjectCommand) {
      fault("put", "before"); if (command.input.IfNoneMatch !== "*" || objects.has(command.input.Key!)) throw new Error("conditional image write required");
      const version = `v${++versions}`; objects.set(command.input.Key!, { version, data: Buffer.from(command.input.Body as Uint8Array), sha256: command.input.ChecksumSHA256!, mime: command.input.ContentType! }); fault("put", "after"); return { VersionId: version, ChecksumSHA256: command.input.ChecksumSHA256 };
    }
    if (command instanceof HeadObjectCommand || command instanceof GetObjectCommand) {
      const obj = objects.get(command.input.Key!);
      if (!obj || (command.input.VersionId && command.input.VersionId !== obj.version)) throw Object.assign(new Error("synthetic missing object"), { $metadata: { httpStatusCode: 404 } });
      if (command instanceof HeadObjectCommand) return { VersionId: obj.version, ChecksumSHA256: obj.sha256 };
      return { VersionId: obj.version, ContentType: obj.mime, ContentLength: obj.data.length, ChecksumSHA256: obj.sha256, Body: { async transformToByteArray() { return Buffer.from(obj.data); } } };
    }
    throw new Error("unsupported S3 command");
  } } as unknown as import("@aws-sdk/client-s3").S3Client;
  return {
    deps(budget: Budget = testBudget()): MigrationDeps { return { migration: createMigrationStore(dynamo, config, identity, validation, budget), reminders: createRemindersStore(dynamo, config), jobs: createJobsStore(dynamo, config),
      owners: createOwnerStore(dynamo, config), images: createMigrationImagesStore(s3, config), validation, budget, clock: () => 1_791_072_000_000, uuid: () => "00000000-0000-4000-8000-000000000099" }; },
    fail(point: string, phase: "before" | "after") { faults.set(point, phase); },
    seed(tableName: string, row: Row) { table(tableName).set(encodedKey(row), structuredClone(row)); },
    snapshot(tableName: string) { return structuredClone([...table(tableName).values()]); },
    failSecondChunk() { stopChunkNumber = 2; },
    remove(tableName: string, row: Row) { table(tableName).delete(encodedKey(row)); },
    failSecondCommit() { stopCommitNumber = 2; },
    corruptImageMime() { [...objects.values()][0]!.mime = "image/jpeg"; },
    corruptImageChecksum() { [...objects.values()][0]!.sha256 = Buffer.alloc(32, 1).toString("base64"); },
    corruptImage() { const object = [...objects.values()][0]!; object.data[object.data.length - 1] = 9; },
    get versions() { return versions; }, sent,
  };
}
