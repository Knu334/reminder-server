import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { GetCommand, ScanCommand, TransactWriteCommand, type DynamoDBDocumentClient, type GetCommandOutput, type ScanCommandOutput, type TransactWriteCommandOutput, type TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";
import { GetObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { z } from "zod";
import type { Config } from "../../src/config";
import { createAwsClients } from "../../src/shared/aws";
import { createBudget, requireBudget } from "../../src/shared/budget";
import { keys, type Budget, type ImagesStore } from "../../src/shared/ports";
import { createImagesStore } from "../../src/images/s3-store";
import { createJobsStore } from "../../src/images/jobs-store";
import { createOwnerStore } from "../../src/reminders/owner-store";
import { createRemindersStore, parseStoredReminder } from "../../src/reminders/dynamo-store";
import type { LegacyValidation, MigrationIdentity, MigrationTarget } from "./legacy";
import { contractSha256For, environmentIdentityFor } from "./legacy";
import { assertMigrationIdentity, migrationImageId, type MigrationDeps, type MigrationRun, type MigrationStore, type MigrationStorage } from "./migration";

const failure = (): Error => new Error("MIGRATION_STORE_REJECTED");
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const identitySchema = z.strictObject({ runId: uuid, sourceSha256: hash, mappingSha256: hash, contractSha256: hash, contractVersion: z.literal(1),
  environment: z.strictObject({ accountId: z.string().regex(/^\d{12}$/), region: z.string().min(1), remindersTable: z.string().min(1), ownerStateTable: z.string().min(1), imageJobsTable: z.string().min(1), imagesBucket: z.string().min(1), issuer: z.string().min(1) }) });
const position = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const progressSchema = z.strictObject({ completedOwners: z.array(position), completedItems: z.array(z.strictObject({ ownerPosition: position, itemPosition: position, imageId: uuid.nullable() })) });
const verificationSchema = z.strictObject({ identity: identitySchema, exactMatch: z.boolean(), mismatches: z.array(z.strictObject({
  location: z.string().regex(/^(run|owners\[\d+\](\.items\[\d+\])?)$/), field: z.string().regex(/^[A-Za-z]+$/), reason: z.string().regex(/^[A-Z0-9_]+$/),
})) });
const runSchema = z.strictObject({ identity: identitySchema, phase: z.enum(["importing", "verified", "published"]), progress: progressSchema, verification: verificationSchema.nullable() });
const storageSchema = z.strictObject({ pk: z.string().regex(/^OWNER#[0-9a-f]{64}$/), sk: z.literal("STORAGE"), itemCount: position, imageBytes: position, migrationRunId: uuid });
const chainPointerSchema = z.strictObject({ head: hash.nullable(), count: position });
type ChainPointer = z.infer<typeof chainPointerSchema>;
const emptyPointer = (): ChainPointer => ({ head: null, count: 0 });
const progressManifestSchema = z.strictObject({ format: z.literal("chain-v2"), sha256: hash, completedOwners: chainPointerSchema, completedItems: chainPointerSchema });
const mismatchesManifestSchema = z.strictObject({ format: z.literal("chain-v2"), sha256: hash, head: hash.nullable(), count: position });
const persistedVerificationSchema = verificationSchema.omit({ mismatches: true }).extend({ mismatches: mismatchesManifestSchema });
const persistedRunSchema = runSchema.omit({ progress: true, verification: true }).extend({ progress: progressManifestSchema, verification: persistedVerificationSchema.nullable() });
const chunkKind = z.enum(["completedOwners", "completedItems", "mismatches"]);
type ChunkKind = z.infer<typeof chunkKind>;
const chunkSchema = z.strictObject({ pk: z.literal("GLOBAL"), sk: z.string(), migrationRunId: uuid, kind: chunkKind,
  previousSha256: hash.nullable(), chunkSha256: hash, index: position, values: z.array(z.unknown()).min(1).max(64) });
const contentHash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const chunkKey = (runId: string, kind: ChunkKind, chunkSha256: string) => ({ pk: "GLOBAL", sk: `MIGRATION#${runId}#CHUNK#${kind}#${chunkSha256}` });
function parseChunk(value: unknown, runId: string) {
  const row = chunkSchema.parse(value);
  const values = row.kind === "completedOwners" ? progressSchema.shape.completedOwners.parse(row.values)
    : row.kind === "completedItems" ? progressSchema.shape.completedItems.parse(row.values) : verificationSchema.shape.mismatches.parse(row.values);
  if (row.migrationRunId !== runId || row.sk !== chunkKey(runId, row.kind, row.chunkSha256).sk || (row.index === 0) !== (row.previousSha256 === null)
    || row.chunkSha256 !== contentHash({ migrationRunId: row.migrationRunId, kind: row.kind, index: row.index, previousSha256: row.previousSha256, values })) throw failure();
  return { ...row, values };
}
type ChainState = { pointer: ChainPointer; chunks: Array<ReturnType<typeof parseChunk>>; values: unknown[] };
function chainPointerFor(kind: ChunkKind, runId: string, values: unknown[]): ChainPointer {
  let head: string | null = null;
  for (let offset = 0; offset < values.length; offset += 64) head = contentHash({ migrationRunId: runId, kind, index: offset / 64, previousSha256: head, values: values.slice(offset, offset + 64) });
  return { head, count: values.length };
}
function progressManifest(progress: MigrationRun["progress"], completedOwners = emptyPointer(), completedItems = emptyPointer()) {
  if (completedOwners.count !== progress.completedOwners.length || completedItems.count !== progress.completedItems.length) throw failure();
  return { format: "chain-v2" as const, sha256: contentHash(progressSchema.parse(progress)), completedOwners, completedItems };
}
function persistedVerification(result: NonNullable<MigrationRun["verification"]>, pointer?: ChainPointer) {
  const parsed = verificationSchema.parse(result);
  const chain = pointer ?? chainPointerFor("mismatches", result.identity.runId, parsed.mismatches);
  if (chain.count !== parsed.mismatches.length) throw failure();
  return { identity: parsed.identity, exactMatch: parsed.exactMatch, mismatches: { format: "chain-v2" as const, sha256: contentHash(parsed.mismatches), ...chain } };
}


/** Same persisted interface is available to O03; malformed or inconsistent run records fail closed. */
export function parseMigrationRun(value: unknown): MigrationRun {
  const run = runSchema.parse(value);
  if (new Set(run.progress.completedOwners).size !== run.progress.completedOwners.length
    || new Set(run.progress.completedItems.map(item => `${item.ownerPosition}:${item.itemPosition}`)).size !== run.progress.completedItems.length
    || (run.verification !== null && (!isDeepStrictEqual(run.verification.identity, run.identity) || run.verification.exactMatch !== (run.verification.mismatches.length === 0)))
    || (run.phase !== "importing" && run.verification?.exactMatch !== true)) throw failure();
  return run;
}
type Actions = NonNullable<TransactWriteCommandInput["TransactItems"]>;

/** Migration-only Scan is intentional. Runtime routes and cleanup do not consume this adapter. */
export function createMigrationStore(client: DynamoDBDocumentClient, config: Config, boundIdentity: MigrationIdentity, validation: LegacyValidation, budget: Budget): MigrationStore {
  assertMigrationIdentity(boundIdentity);
  const ownerIds = new Set(validation.owners.map(owner => owner.ownerId));
  const itemKeys = new Set(validation.owners.flatMap(owner => owner.items.map(item => JSON.stringify([owner.ownerId, item.id]))));
  const jobIds = new Set(validation.owners.flatMap((owner, ownerPosition) => owner.items.flatMap((item, itemPosition) => owner.images.has(item.id) ? [migrationImageId(boundIdentity.runId, ownerPosition, itemPosition)] : [])));
  function bound(identity: MigrationIdentity): void { if (!isDeepStrictEqual(identity, boundIdentity)) throw failure(); }
  function send(command: GetCommand): Promise<GetCommandOutput>;
  function send(command: ScanCommand): Promise<ScanCommandOutput>;
  function send(command: TransactWriteCommand): Promise<TransactWriteCommandOutput>;
  async function send(command: GetCommand | ScanCommand | TransactWriteCommand): Promise<GetCommandOutput | ScanCommandOutput | TransactWriteCommandOutput> {
    requireBudget(budget);
    if (command instanceof GetCommand) return client.send(command, { abortSignal: budget.signal });
    if (command instanceof ScanCommand) return client.send(command, { abortSignal: budget.signal });
    return client.send(command, { abortSignal: budget.signal });
  }
  async function get(TableName: string, Key: Record<string, string>): Promise<Record<string, unknown> | undefined> {
    const result = await send(new GetCommand({ TableName, Key, ConsistentRead: true })); return "Item" in result ? result.Item : undefined;
  }
  async function *scan(TableName: string): AsyncIterable<Record<string, unknown>> {
    let cursor: Record<string, unknown> | undefined; const seen = new Set<string>();
    do {
      const result = await send(new ScanCommand({ TableName, ConsistentRead: true, Limit: 100, ...(cursor === undefined ? {} : { ExclusiveStartKey: cursor }) }));
      if (result.Items !== undefined && !Array.isArray(result.Items)) throw failure();
      for (const row of result.Items ?? []) yield row;
      cursor = result.LastEvaluatedKey;
      if (cursor !== undefined) { const encoded = JSON.stringify(cursor); if (seen.has(encoded) || Object.keys(cursor).length === 0) throw failure(); seen.add(encoded); }
    } while (cursor !== undefined);
  }
  const gateCheck = (): Actions[number] => ({ ConditionCheck: { TableName: config.ownerStateTable, Key: keys.publication,
    ConditionExpression: "#published = :false AND #run = :run", ExpressionAttributeNames: { "#published": "published", "#run": "runId" }, ExpressionAttributeValues: { ":false": false, ":run": boundIdentity.runId } } });
  const runCheck = (): Actions[number] => ({ ConditionCheck: { TableName: config.ownerStateTable, Key: keys.migration(boundIdentity.runId),
    ConditionExpression: "#identity = :identity AND #phase = :importing", ExpressionAttributeNames: { "#identity": "identity", "#phase": "phase" }, ExpressionAttributeValues: { ":identity": boundIdentity, ":importing": "importing" } } });
  async function guarded(actions: Actions): Promise<void> { await send(new TransactWriteCommand({ TransactItems: [gateCheck(), runCheck(), ...actions] })); }
  // Cache only a pointer already read strongly or committed by this adapter. loadRun itself always rehydrates strongly.
  let progressCache: { manifest: z.infer<typeof progressManifestSchema>; progress: MigrationRun["progress"]; owners: ChainState; items: ChainState } | null = null;
  async function writeChunk(row: ReturnType<typeof parseChunk>): Promise<void> {
    const key = chunkKey(boundIdentity.runId, row.kind, row.chunkSha256);
    const existing = await get(config.ownerStateTable, key);
    if (existing) { if (!isDeepStrictEqual(parseChunk(existing, boundIdentity.runId), row)) throw failure(); return; }
    try { await guarded([{ Put: { TableName: config.ownerStateTable, Item: row, ConditionExpression: "attribute_not_exists(#pk)", ExpressionAttributeNames: { "#pk": "pk" } } }]); }
    catch { /* Read the exact immutable key to resolve an uncertain write. */ }
    const actual = await get(config.ownerStateTable, key);
    if (!actual || !isDeepStrictEqual(parseChunk(actual, boundIdentity.runId), row)) throw failure();
  }
  async function writeChain(kind: ChunkKind, values: unknown[], base?: ChainState): Promise<ChainState> {
    if (base && (values.length < base.values.length || !isDeepStrictEqual(values.slice(0, base.values.length), base.values))) throw failure();
    if (base && values.length === base.values.length) return base;
    const sealedCount = base ? Math.floor(base.values.length / 64) : 0;
    const chunks = base?.chunks.slice(0, sealedCount) ?? [];
    let previousSha256 = chunks.at(-1)?.chunkSha256 ?? null;
    for (let index = sealedCount; index < Math.ceil(values.length / 64); index++) {
      const payload = { migrationRunId: boundIdentity.runId, kind, index, previousSha256, values: values.slice(index * 64, (index + 1) * 64) };
      const chunkSha256 = contentHash(payload);
      const row = parseChunk({ ...chunkKey(boundIdentity.runId, kind, chunkSha256), chunkSha256, ...payload }, boundIdentity.runId);
      await writeChunk(row); chunks.push(row); previousSha256 = chunkSha256;
    }
    return { pointer: { head: previousSha256, count: values.length }, chunks, values: [...values] };
  }
  async function readChain(kind: ChunkKind, pointer: ChainPointer): Promise<ChainState> {
    if ((pointer.count === 0) !== (pointer.head === null)) throw failure();
    const reverse: Array<ReturnType<typeof parseChunk>> = []; const seen = new Set<string>(); let head = pointer.head;
    for (let index = Math.ceil(pointer.count / 64) - 1; index >= 0; index--) {
      if (head === null || seen.has(head)) throw failure(); seen.add(head);
      const raw = await get(config.ownerStateTable, chunkKey(boundIdentity.runId, kind, head));
      if (!raw) throw failure(); const row = parseChunk(raw, boundIdentity.runId);
      if (row.kind !== kind || row.chunkSha256 !== head || row.index !== index || row.values.length !== Math.min(64, pointer.count - index * 64)) throw failure();
      reverse.push(row); head = row.previousSha256;
    }
    if (head !== null) throw failure(); const chunks = reverse.reverse(); const values: unknown[] = [];
    for (const chunk of chunks) values.push(...chunk.values);
    return { pointer, chunks, values };
  }
  async function readProgress(manifest: z.infer<typeof progressManifestSchema>) {
    const owners = await readChain("completedOwners", manifest.completedOwners);
    const items = await readChain("completedItems", manifest.completedItems);
    const progress = progressSchema.parse({ completedOwners: owners.values, completedItems: items.values });
    if (contentHash(progress) !== manifest.sha256) throw failure();
    // The logical parser also rejects duplicate completion entries.
    parseMigrationRun({ identity: boundIdentity, phase: "importing", progress, verification: null });
    return { manifest, progress, owners, items };
  }
  async function hydrateRun(value: unknown): Promise<MigrationRun> {
    const record = persistedRunSchema.parse(value);
    if (!isDeepStrictEqual(record.identity, boundIdentity)) throw failure();
    const hydrated = await readProgress(record.progress);
    let verification: MigrationRun["verification"] = null;
    if (record.verification) {
      const chain = await readChain("mismatches", record.verification.mismatches);
      const mismatches = verificationSchema.shape.mismatches.parse(chain.values);
      if (contentHash(mismatches) !== record.verification.mismatches.sha256) throw failure();
      verification = { identity: record.verification.identity, exactMatch: record.verification.exactMatch, mismatches };
    }
    const run = parseMigrationRun({ ...record, progress: hydrated.progress, verification }); progressCache = hydrated; return run;
  }
  async function invalidateVerification(): Promise<void> {
    const update: Actions[number] = { Update: { TableName: config.ownerStateTable, Key: keys.migration(boundIdentity.runId), UpdateExpression: "SET #verification = :null, #phase = :importing",
      ConditionExpression: "#identity = :identity AND (#phase = :importing OR #phase = :verified)", ExpressionAttributeNames: { "#verification": "verification", "#phase": "phase", "#identity": "identity" },
      ExpressionAttributeValues: { ":null": null, ":identity": boundIdentity, ":importing": "importing", ":verified": "verified" } } };
    try { await send(new TransactWriteCommand({ TransactItems: [gateCheck(), update] })); }
    catch { const run = await store.loadRun(boundIdentity.runId); if (!run || run.phase !== "importing" || run.verification !== null) throw failure(); }
  }
  const store: MigrationStore = {
    async assertEmptyOrSameRun(identity) {
      bound(identity); let foundRun: MigrationRun | null = null; let gate: Record<string, unknown> | null = null; let hasData = false;
      const inventoryChunks = new Map<string, ReturnType<typeof parseChunk>>();
      // Scan all pages without filters, including unknown administrative rows.
      for await (const item of scan(config.remindersTable)) {
        hasData = true;
        if (item.migrationRunId !== identity.runId || !itemKeys.has(JSON.stringify([item.ownerId, item.id]))) throw failure();
        parseStoredReminder(item, String(item.ownerId));
      }
      for await (const job of scan(config.imageJobsTable)) {
        hasData = true;
        if (job.migrationRunId !== identity.runId || !jobIds.has(String(job.jobId))) throw failure();
        const parsed = await createJobsStore(client, config).get(String(job.jobId), budget); if (!parsed || parsed.migrationRunId !== identity.runId) throw failure();
      }
      for await (const row of scan(config.ownerStateTable)) {
        if (row.pk === "GLOBAL" && row.sk === "PUBLICATION") {
          if (!isDeepStrictEqual(Object.keys(row).sort(), ["pk", "published", "runId", "sk"]) || row.published !== false || (row.runId !== null && row.runId !== identity.runId)) throw failure(); gate = row;
        } else if (row.pk === "GLOBAL" && row.sk === `MIGRATION#${identity.runId}`) {
          const { pk: _pk, sk: _sk, ...value } = row; foundRun = await hydrateRun(value); if (!isDeepStrictEqual(foundRun.identity, identity) || foundRun.phase === "published") throw failure();
        } else if (row.pk === "GLOBAL" && typeof row.sk === "string" && row.sk.startsWith(`MIGRATION#${identity.runId}#CHUNK#`)) {
          hasData = true; const chunk = parseChunk(row, identity.runId); inventoryChunks.set(chunk.sk, chunk);
        } else {
          hasData = true; const parsed = storageSchema.parse(row);
          if (parsed.migrationRunId !== identity.runId || !ownerIds.has(parsed.pk.slice(6))) throw failure();
        }
      }
      for (const chunk of inventoryChunks.values()) {
        if (chunk.previousSha256 !== null) {
          const previous = inventoryChunks.get(chunkKey(identity.runId, chunk.kind, chunk.previousSha256).sk);
          if (!previous || previous.kind !== chunk.kind || previous.index !== chunk.index - 1 || previous.values.length !== 64) throw failure();
        }
      }
      if (foundRun) { if (!gate || gate.runId !== identity.runId) throw failure(); return; }
      if (hasData || (gate !== null && gate.runId !== null)) throw failure();
      const run: MigrationRun = { identity, phase: "importing", progress: { completedOwners: [], completedItems: [] }, verification: null };
      await send(new TransactWriteCommand({ TransactItems: [{ Put: { TableName: config.ownerStateTable, Item: { ...keys.migration(identity.runId), ...run, progress: progressManifest(run.progress) }, ConditionExpression: "attribute_not_exists(#pk)", ExpressionAttributeNames: { "#pk": "pk" } } },
        { Put: { TableName: config.ownerStateTable, Item: { ...keys.publication, published: false, runId: identity.runId },
          ConditionExpression: "attribute_not_exists(#pk) OR (#published = :false AND #run = :null)", ExpressionAttributeNames: { "#pk": "pk", "#published": "published", "#run": "runId" }, ExpressionAttributeValues: { ":false": false, ":null": null } } }] }));
    },
    async loadRun(runId) {
      if (runId !== boundIdentity.runId) throw failure(); const row = await get(config.ownerStateTable, keys.migration(runId));
      if (!row) return null; const { pk: _pk, sk: _sk, ...value } = row; const run = await hydrateRun(value);
      if (!isDeepStrictEqual(run.identity, boundIdentity)) throw failure(); return run;
    },
    async saveProgress(runId, progress) {
      if (runId !== boundIdentity.runId) throw failure(); progress = progressSchema.parse(progress);
      parseMigrationRun({ identity: boundIdentity, phase: "importing", progress, verification: null });
      const row = await get(config.ownerStateTable, keys.migration(runId)); if (!row) throw failure();
      const { pk: _pk, sk: _sk, ...value } = row; const record = persistedRunSchema.parse(value);
      if (!isDeepStrictEqual(record.identity, boundIdentity) || record.phase !== "importing") throw failure();
      const base = progressCache && isDeepStrictEqual(progressCache.manifest, record.progress) ? progressCache : await readProgress(record.progress);
      const owners = await writeChain("completedOwners", progress.completedOwners, base.owners);
      const items = await writeChain("completedItems", progress.completedItems, base.items);
      const manifest = progressManifest(progress, owners.pointer, items.pointer);
      const update: Actions[number] = { Update: { TableName: config.ownerStateTable, Key: keys.migration(runId),
        UpdateExpression: "SET #progress = :progress, #verification = :null, #phase = :importing",
        ConditionExpression: "#identity = :identity AND #phase = :importing AND #progress = :previous", ExpressionAttributeNames: { "#progress": "progress", "#verification": "verification", "#phase": "phase", "#identity": "identity" },
        ExpressionAttributeValues: { ":progress": manifest, ":previous": record.progress, ":null": null, ":importing": "importing", ":identity": boundIdentity } } };
      try { await send(new TransactWriteCommand({ TransactItems: [gateCheck(), update] })); }
      catch { const run = await store.loadRun(runId); if (!run || run.phase !== "importing" || !isDeepStrictEqual(run.progress, progress)) throw failure(); }
      progressCache = { manifest, progress, owners, items };
    },
    async ensureOwner(owner, identity) {
      bound(identity); if (!ownerIds.has(owner)) throw failure(); const existing = await store.getStorage(owner);
      if (existing) { if (existing.migrationRunId !== identity.runId) throw failure(); return; }
      try { await guarded([{ Put: { TableName: config.ownerStateTable, Item: { ...keys.storage(owner), itemCount: 0, imageBytes: 0, migrationRunId: identity.runId }, ConditionExpression: "attribute_not_exists(#pk)", ExpressionAttributeNames: { "#pk": "pk" } } }]); }
      catch { const actual = await store.getStorage(owner); if (!actual || actual.migrationRunId !== identity.runId || actual.itemCount !== 0 || actual.imageBytes !== 0) throw failure(); }
    },
    async getStorage(owner): Promise<MigrationStorage | null> {
      const row = await get(config.ownerStateTable, keys.storage(owner)); if (!row) return null;
      const parsed = storageSchema.parse(row); if (parsed.pk !== keys.storage(owner).pk) throw failure();
      return { itemCount: parsed.itemCount, imageBytes: parsed.imageBytes, migrationRunId: parsed.migrationRunId };
    },
    async stageImage(job, identity) {
      bound(identity); if (job.migrationRunId !== identity.runId || !jobIds.has(job.jobId) || !ownerIds.has(job.ownerId) || job.key !== keys.image(job.ownerId, job.jobId)) throw failure();
      const existing = await createJobsStore(client, config).get(job.jobId, budget);
      if (existing) { if (!isDeepStrictEqual(existing, job)) throw failure(); return; }
      await guarded([{ Put: { TableName: config.imageJobsTable, Item: job, ConditionExpression: "attribute_not_exists(#id)", ExpressionAttributeNames: { "#id": "jobId" } } }]);
    },
    async putImported(owner, item, imageJob, identity) {
      bound(identity); parseStoredReminder(item, owner, item.id);
      if (item.migrationRunId !== identity.runId || !itemKeys.has(JSON.stringify([owner, item.id])) || item.revision !== 1 || item.createdAt !== item.updatedAt) throw failure();
      const bytes = item.thumbnail?.bytes ?? 0;
      const actions: Actions = [{ Put: { TableName: config.remindersTable, Item: item, ConditionExpression: "attribute_not_exists(#id)", ExpressionAttributeNames: { "#id": "id" } } },
        { Update: { TableName: config.ownerStateTable, Key: keys.storage(owner), UpdateExpression: "SET #items = #items + :itemDelta, #bytes = #bytes + :byteDelta",
          ConditionExpression: "#run = :run AND #items BETWEEN :zero AND :maxItems AND #bytes BETWEEN :zero AND :maxBytes",
          ExpressionAttributeNames: { "#run": "migrationRunId", "#items": "itemCount", "#bytes": "imageBytes" },
          ExpressionAttributeValues: { ":run": identity.runId, ":zero": 0, ":itemDelta": 1, ":byteDelta": bytes, ":maxItems": config.limits.itemCount - 1, ":maxBytes": config.limits.imageBytes - bytes } } }];
      if (imageJob !== null) {
        const ref = item.thumbnail;
        if (!ref || imageJob.jobId !== ref.imageId || imageJob.versionId !== ref.versionId || imageJob.ownerId !== owner || imageJob.key !== ref.key || imageJob.migrationRunId !== identity.runId || imageJob.state !== "committed") throw failure();
        actions.push({ Put: { TableName: config.imageJobsTable, Item: imageJob,
          ConditionExpression: "#run = :run AND #owner = :owner AND #key = :key AND #state = :pending AND (attribute_not_exists(#version) OR #version = :version)",
          ExpressionAttributeNames: { "#run": "migrationRunId", "#owner": "ownerId", "#key": "key", "#state": "state", "#version": "versionId" },
          ExpressionAttributeValues: { ":run": identity.runId, ":owner": owner, ":key": ref.key, ":pending": "pending", ":version": ref.versionId } } });
      } else if (item.thumbnail !== null) throw failure();
      await guarded(actions);
    },
    async recordVerification(runId, result) {
      if (runId !== boundIdentity.runId || !isDeepStrictEqual(result.identity, boundIdentity) || result.exactMatch !== (result.mismatches.length === 0)) throw failure(); result = verificationSchema.parse(result);
      await invalidateVerification();
      const chain = await writeChain("mismatches", result.mismatches);
      const persisted = persistedVerification(result, chain.pointer);
      const phase = result.exactMatch ? "verified" : "importing";
      const update: Actions[number] = { Update: { TableName: config.ownerStateTable, Key: keys.migration(runId), UpdateExpression: "SET #verification = :result, #phase = :phase",
        ConditionExpression: "#identity = :identity AND (#phase = :importing OR #phase = :verified)", ExpressionAttributeNames: { "#verification": "verification", "#phase": "phase", "#identity": "identity" },
        ExpressionAttributeValues: { ":result": persisted, ":phase": phase, ":identity": boundIdentity, ":importing": "importing", ":verified": "verified" } } };
      try { await send(new TransactWriteCommand({ TransactItems: [gateCheck(), update] })); }
      catch { const run = await store.loadRun(runId); if (!run || run.phase !== phase || !isDeepStrictEqual(run.verification, result)) throw failure(); }
    },
    async publishIfVerified(identity) {
      bound(identity); const run = await store.loadRun(identity.runId);
      if (!run || run.phase !== "verified" || run.verification?.exactMatch !== true || !isDeepStrictEqual(run.verification.identity, identity)) throw failure();
      try { await send(new TransactWriteCommand({ TransactItems: [{ Update: { TableName: config.ownerStateTable, Key: keys.publication,
        UpdateExpression: "SET #published = :true", ConditionExpression: "#published = :false AND #run = :run", ExpressionAttributeNames: { "#published": "published", "#run": "runId" }, ExpressionAttributeValues: { ":true": true, ":false": false, ":run": identity.runId } } },
      { Update: { TableName: config.ownerStateTable, Key: keys.migration(identity.runId), UpdateExpression: "SET #phase = :published",
        ConditionExpression: "#identity = :identity AND #phase = :verified AND #verification = :verification", ExpressionAttributeNames: { "#identity": "identity", "#phase": "phase", "#verification": "verification" },
        ExpressionAttributeValues: { ":identity": identity, ":verified": "verified", ":published": "published", ":verification": persistedVerification(run.verification) } } }] })); }
      catch {
        const [actualRun, gate] = await Promise.all([store.loadRun(identity.runId), get(config.ownerStateTable, keys.publication)]);
        if (actualRun?.phase !== "published" || gate?.published !== true || gate.runId !== identity.runId || !isDeepStrictEqual(actualRun.verification, run.verification)) throw failure();
      }
    },
    async *listRunItems(runId) {
      if (runId !== boundIdentity.runId) throw failure();
      for await (const row of scan(config.remindersTable)) { if (row.migrationRunId !== runId) throw failure(); yield parseStoredReminder(row, String(row.ownerId)); }
    },
  };
  return store;
}

/** Migration uploads cannot add a new version blindly after an uncertain Put outcome. */
export function createMigrationImagesStore(client: S3Client, config: Config): ImagesStore {
  const runtime = createImagesStore(client, config);
  return { ...runtime, async get(ref, budget) {
    requireBudget(budget);
    const response = await client.send(new GetObjectCommand({ Bucket: config.imagesBucket, Key: ref.key, VersionId: ref.versionId, ChecksumMode: "ENABLED" }), { abortSignal: budget.signal });
    if (!response.Body) throw failure();
    // Consume the stream even if response metadata differs, so the SDK socket is released.
    const data = await response.Body.transformToByteArray(); requireBudget(budget);
    if (response.VersionId !== ref.versionId || response.ContentType !== ref.mime || response.ContentLength !== ref.bytes
      || data.length !== ref.bytes || createHash("sha256").update(data).digest("hex") !== ref.sha256
      || (response.ChecksumSHA256 !== undefined && response.ChecksumSHA256 !== Buffer.from(ref.sha256, "hex").toString("base64"))) throw failure();
    return data;
  }, async put(job, image, budget) {
    requireBudget(budget);
    const response = await client.send(new PutObjectCommand({ Bucket: config.imagesBucket, Key: job.key, Body: image.data,
      ContentType: image.mime, ChecksumSHA256: Buffer.from(image.sha256, "hex").toString("base64"), IfNoneMatch: "*" }), { abortSignal: budget.signal });
    if (!response.VersionId || response.VersionId === "null" || (response.ChecksumSHA256 !== undefined && response.ChecksumSHA256 !== Buffer.from(image.sha256, "hex").toString("base64"))) throw failure();
    return { imageId: job.jobId, key: job.key, versionId: response.VersionId, mime: image.mime, bytes: image.bytes, sha256: image.sha256 };
  } };
}
export async function verifyMigrationCaller(client: STSClient, accountId: string, budget: Budget): Promise<void> {
  requireBudget(budget); const caller = await client.send(new GetCallerIdentityCommand({}), { abortSignal: budget.signal });
  if (caller.Account !== accountId) throw failure();
}
/** Only explicit CLI modes load this module/factory. This function is never called in local task execution. */
export async function createMigrationDeps(target: MigrationTarget, identity: MigrationIdentity, validation: LegacyValidation): Promise<MigrationDeps> {
  assertMigrationIdentity(identity);
  if (validation.errors.length || !isDeepStrictEqual(identity.environment, environmentIdentityFor(target)) || identity.contractSha256 !== contractSha256For(target)) throw failure();
  const deadline = Date.now() + 900_000; const budget = createBudget(() => deadline - Date.now(), 1000);
  await verifyMigrationCaller(new STSClient({ region: target.region, maxAttempts: 1 }), target.accountId, budget);
  const clients = createAwsClients(target);
  return { migration: createMigrationStore(clients.dynamo, target, identity, validation, budget), reminders: createRemindersStore(clients.dynamo, target),
    jobs: createJobsStore(clients.dynamo, target), images: createMigrationImagesStore(clients.s3, target), owners: createOwnerStore(clients.dynamo, target),
    validation, budget, clock: Date.now, uuid: randomUUID };
}
