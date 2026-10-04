import { isDeepStrictEqual } from "node:util";
import { GetCommand, ScanCommand, TransactWriteCommand, type DynamoDBDocumentClient, type TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import type { Config } from "../../src/config";
import { createOwnerStore } from "../../src/reminders/owner-store";
import { createJobsStore } from "../../src/images/jobs-store";
import { cleanupKeys } from "../../src/images/job-keys";
import { createHash } from "node:crypto";
import { ownerIdFor } from "../../src/api/identity";
import { requireBudget } from "../../src/shared/budget";
import { keys } from "../../src/shared/ports";
import { parseStoredReminder } from "../../src/reminders/dynamo-store";
import type { ImageRef } from "../../src/images/types";
import type { OwnerId, ActiveReminder, StoredReminder } from "../../src/reminders/types";
import type { ImageJob } from "../../src/images/types";
import type { ImagesStore, Budget, PublicationGate } from "../../src/shared/ports";
import type { EnvironmentIdentity } from "./legacy";
export interface RecoveryInput { source: EnvironmentIdentity; restored: EnvironmentIdentity; runId: string; ownerIdentities: Array<{ ownerId: OwnerId; issuer: string; sub: string }> }
export interface RecoveryOwnerMap { oldIssuer: string; oldSub: string; newIssuer: string; newSub: string }
export interface RecoveryIssue { location: string; field: string; reason: string }
export interface RecoveryReport { matched: number; missingImages: RecoveryIssue[]; mismatchedOwners: RecoveryIssue[]; countDiscrepancies: RecoveryIssue[]; unresolvedJobs: RecoveryIssue[]; readyToSwitch: boolean; cognitoCredentialsRestored: false }
export interface RecoveryStore {
  bindRun(input: RecoveryInput, mapping: RecoveryOwnerMap[], budget: Budget): Promise<void>;
  hasIncompleteRemap(runId: string, budget: Budget): Promise<boolean>;
  listJobs(): AsyncIterable<ImageJob>;
  stageImageReplacement(previous: ActiveReminder, targetOwnerId: OwnerId, runId: string, budget: Budget): Promise<ImageJob>;
  gate(budget: Budget): Promise<PublicationGate>;
  prepareUnpublished(runId: string, budget: Budget): Promise<void>;
  listItems(): AsyncIterable<StoredReminder>;
  listOwners(): AsyncIterable<{ ownerId: OwnerId; itemCount: number; imageBytes: number }>;
  getJob(jobId: string, budget: Budget): Promise<ImageJob | null>;
  replaceImage(previous: ActiveReminder, next: ActiveReminder, job: ImageJob, runId: string, budget: Budget): Promise<void>;
  remapOwner(from: OwnerId, to: OwnerId, runId: string, budget: Budget): Promise<void>;
  saveReport(runId: string, report: RecoveryReport, budget: Budget): Promise<void>;
}
export interface RecoveryDeps { restored: RecoveryStore; sourceImages: ImagesStore; restoredImages: ImagesStore; budget: Budget; clock: () => number; uuid: () => string }
const failure = (): Error => new Error("RECOVERY_REJECTED");
const validUuid = (value: string): boolean => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
export function assertRecoveryInput(input: RecoveryInput): void {
  if (!validUuid(input.runId) || !Array.isArray(input.ownerIdentities)) throw failure();
  const fields = ["accountId", "region", "remindersTable", "ownerStateTable", "imageJobsTable", "imagesBucket", "issuer"] as const;
  for (const env of [input.source, input.restored]) {
    if (!env || fields.some(field => typeof env[field] !== "string" || env[field].length === 0) || !/^\d{12}$/.test(env.accountId)) throw failure();
    if (new Set([env.remindersTable, env.ownerStateTable, env.imageJobsTable]).size !== 3) throw failure();
  }
  // Table names across roles must also be disjoint: swapped live table names are unsafe.
  const live = new Set([input.source.remindersTable, input.source.ownerStateTable, input.source.imageJobsTable]);
  if ([input.restored.remindersTable, input.restored.ownerStateTable, input.restored.imageJobsTable].some(table => live.has(table)) || input.source.accountId !== input.restored.accountId || input.source.region !== input.restored.region) throw failure();
  for (const value of input.ownerIdentities) if (!value || !/^[0-9a-f]{64}$/.test(value.ownerId) || typeof value.issuer !== "string" || !value.issuer || typeof value.sub !== "string" || !value.sub) throw failure();
}
async function unpublished(input: RecoveryInput, deps: RecoveryDeps): Promise<void> {
  assertRecoveryInput(input); requireBudget(deps.budget);
  if ((await deps.restored.gate(deps.budget)).published) throw failure();
}
const issue = (location: string, field: string, reason: string): RecoveryIssue => ({ location, field, reason });
async function inventory(deps: RecoveryDeps) {
  const items: StoredReminder[] = []; const owners: Array<{ ownerId: string; itemCount: number; imageBytes: number }> = [];
  for await (const item of deps.restored.listItems()) { requireBudget(deps.budget); items.push(parseStoredReminder(item, item.ownerId)); }
  for await (const owner of deps.restored.listOwners()) { requireBudget(deps.budget); owners.push(owner); }
  return { items, owners };
}
function jobMatches(job: ImageJob | null, item: ActiveReminder): boolean {
  const ref = item.thumbnail!;
  return job !== null && job.jobId === ref.imageId && job.ownerId === item.ownerId && job.key === ref.key && job.versionId === ref.versionId && job.mime === ref.mime && job.bytes === ref.bytes && job.sha256 === ref.sha256 && job.state === "committed" && job.cleanupPartition === undefined && job.cleanupSortKey === undefined && job.dueAtMs === undefined && job.leaseOwner === undefined;
}
async function pinnedBytes(ref: ImageRef, deps: RecoveryDeps): Promise<Uint8Array> {
  let data: Uint8Array;
  try { data = await deps.restoredImages.get(ref, deps.budget); }
  catch { requireBudget(deps.budget); data = await deps.sourceImages.get(ref, deps.budget); }
  requireBudget(deps.budget);
  if (data.length !== ref.bytes || hash(data) !== ref.sha256 || !ref.versionId || ref.versionId === "null") throw failure();
  return data;
}
async function isCurrent(ref: ImageRef, deps: RecoveryDeps): Promise<boolean> {
  const head = await deps.restoredImages.head(ref.key, null, deps.budget);
  return head !== null && !head.deleteMarker && head.versionId === ref.versionId && head.sha256 === ref.sha256;
}
export async function verifyRecovery(input: RecoveryInput, deps: RecoveryDeps): Promise<RecoveryReport> {
  await unpublished(input, deps);
  const report: RecoveryReport = { matched: 0, missingImages: [], mismatchedOwners: [], countDiscrepancies: [], unresolvedJobs: [], readyToSwitch: false, cognitoCredentialsRestored: false };
  const { items, owners } = await inventory(deps);
  const identities = new Map<string, RecoveryInput["ownerIdentities"][number]>();
  input.ownerIdentities.forEach((identity, index) => {
    if (identities.has(identity.ownerId)) report.mismatchedOwners.push(issue(`identities[${index}]`, "ownerId", "DUPLICATE_IDENTITY"));
    identities.set(identity.ownerId, identity);
  });
  const referencedJobs = new Set<string>();
  const totals = new Map<string, { itemCount: number; imageBytes: number }>(); const seen = new Set<string>();
  owners.forEach((owner, index) => {
    const location = `owners[${index}]`; const identity = identities.get(owner.ownerId);
    if (!identity || identity.issuer !== input.restored.issuer || ownerIdFor(identity.issuer, identity.sub) !== owner.ownerId) report.mismatchedOwners.push(issue(location, "ownerId", "CURRENT_IDENTITY_REQUIRED"));
    if (totals.has(owner.ownerId) || !/^[0-9a-f]{64}$/.test(owner.ownerId) || !Number.isSafeInteger(owner.itemCount) || owner.itemCount < 0 || !Number.isSafeInteger(owner.imageBytes) || owner.imageBytes < 0) report.countDiscrepancies.push(issue(location, "storage", "INVALID_COUNTER"));
    totals.set(owner.ownerId, { itemCount: 0, imageBytes: 0 });
  });
  for (let index = 0; index < items.length; index++) {
    const item = items[index]!; const location = `items[${index}]`; const key = JSON.stringify([item.ownerId, item.id]);
    if (seen.has(key)) report.countDiscrepancies.push(issue(location, "id", "DUPLICATE_ITEM")); seen.add(key);
    const total = totals.get(item.ownerId);
    if (!total) { report.countDiscrepancies.push(issue(location, "storage", "MISSING_COUNTER")); continue; }
    if (item.deleted) continue;
    total.itemCount++; total.imageBytes += item.thumbnail?.bytes ?? 0;
    const before = report.missingImages.length + report.unresolvedJobs.length;
    if (item.thumbnail) {
      if (referencedJobs.has(item.thumbnail.imageId)) report.unresolvedJobs.push(issue(location, "job", "DUPLICATE_IMAGE_REFERENCE"));
      referencedJobs.add(item.thumbnail.imageId);
      if (!jobMatches(await deps.restored.getJob(item.thumbnail.imageId, deps.budget), item)) report.unresolvedJobs.push(issue(location, "job", "JOB_REFERENCE_MISMATCH"));
      try {
        await pinnedBytes(item.thumbnail, deps);
        if (!await isCurrent(item.thumbnail, deps)) report.missingImages.push(issue(location, "thumbnail", "NONCURRENT_VERSION"));
        else {
          const currentBytes = await deps.restoredImages.get(item.thumbnail, deps.budget);
          if (currentBytes.length !== item.thumbnail.bytes || hash(currentBytes) !== item.thumbnail.sha256) throw failure();
        }
      }
      catch { requireBudget(deps.budget); report.missingImages.push(issue(location, "thumbnail", "MISSING_VERSION_OR_BAD_CHECKSUM")); }
    }
    if (before === report.missingImages.length + report.unresolvedJobs.length) report.matched++;
  }
  owners.forEach((owner, index) => { const total = totals.get(owner.ownerId)!;
    for (const field of ["itemCount", "imageBytes"] as const) if (total[field] !== owner[field] || !Number.isSafeInteger(total[field])) report.countDiscrepancies.push(issue(`owners[${index}]`, field, "COUNTER_MISMATCH"));
  });
  for (const [index, identity] of input.ownerIdentities.entries()) if (!totals.has(identity.ownerId)) report.mismatchedOwners.push(issue(`identities[${index}]`, "ownerId", "OWNER_NOT_RESTORED"));
  if (await deps.restored.hasIncompleteRemap(input.runId, deps.budget)) report.unresolvedJobs.push(issue("recovery", "job", "INCOMPLETE_REMAP"));
  let jobIndex = 0;
  for await (const job of deps.restored.listJobs()) {
    requireBudget(deps.budget);
    if (job.state === "committed" && !referencedJobs.has(job.jobId)) report.unresolvedJobs.push(issue(`jobs[${jobIndex}]`, "job", "UNREFERENCED_COMMITTED_JOB"));
    jobIndex++;
  }
  report.readyToSwitch = report.missingImages.length + report.mismatchedOwners.length + report.countDiscrepancies.length + report.unresolvedJobs.length === 0;
  await unpublished(input, deps); return report;
}
export async function preserveRecoveryImages(input: RecoveryInput, deps: RecoveryDeps): Promise<RecoveryReport> {
  await unpublished(input, deps); await deps.restored.bindRun(input, [], deps.budget);
  const before = await verifyRecovery(input, deps);
  if (before.countDiscrepancies.length || before.unresolvedJobs.length || before.missingImages.some(value => value.reason !== "NONCURRENT_VERSION")) throw failure();
  const { items } = await inventory(deps);
  for (const item of items) {
    if (item.deleted || !item.thumbnail || await isCurrent(item.thumbnail, deps)) continue;
    const data = await pinnedBytes(item.thumbnail, deps);
    const pending = await deps.restored.stageImageReplacement(item, item.ownerId, input.runId, deps.budget);
    const imageId = pending.jobId; const key = pending.key;
    if (!validUuid(imageId) || imageId === item.thumbnail.imageId || key !== keys.image(item.ownerId, imageId)) throw failure();
    const existing = await deps.restoredImages.head(key, null, deps.budget);
    let uploaded: ImageRef | null = null;
    if (existing) {
      if (existing.deleteMarker || existing.sha256 !== item.thumbnail.sha256) throw failure();
      uploaded = { ...item.thumbnail, imageId, key, versionId: existing.versionId };
      const actual = await deps.restoredImages.get(uploaded, deps.budget);
      if (actual.length !== data.length || !Buffer.from(actual).equals(Buffer.from(data))) throw failure();
    }
    const ref = uploaded ?? await deps.restoredImages.put(pending, { data, mime: item.thumbnail.mime, bytes: item.thumbnail.bytes, sha256: item.thumbnail.sha256 }, deps.budget);
    if (ref.imageId !== imageId || ref.key !== key || !ref.versionId || ref.versionId === "null" || ref.mime !== item.thumbnail.mime || ref.bytes !== item.thumbnail.bytes || ref.sha256 !== item.thumbnail.sha256) throw failure();
    await deps.restoredImages.get(ref, deps.budget);
    if (!await isCurrent(ref, deps)) throw failure();
    await deps.restored.replaceImage(item, { ...item, thumbnail: ref }, { jobId: imageId, ownerId: item.ownerId, key, versionId: ref.versionId, mime: ref.mime, bytes: ref.bytes, sha256: ref.sha256, state: "committed", createdAtMs: pending.createdAtMs, updatedAtMs: deps.clock() }, input.runId, deps.budget);
  }
  const report = await verifyRecovery(input, deps); await deps.restored.saveReport(input.runId, report, deps.budget); return report;
}
export async function remapRecoveryOwners(input: RecoveryInput, mapping: RecoveryOwnerMap[], deps: RecoveryDeps): Promise<RecoveryReport> {
  await unpublished(input, deps); if (!Array.isArray(mapping) || mapping.length === 0) throw failure();
  const fromIds = new Set<string>(); const toIds = new Set<string>();
  const pairs = mapping.map(value => {
    if (!value || typeof value.oldIssuer !== "string" || !value.oldIssuer || value.newIssuer !== input.restored.issuer || typeof value.oldSub !== "string" || !value.oldSub || typeof value.newSub !== "string" || !value.newSub) throw failure();
    const from = ownerIdFor(value.oldIssuer, value.oldSub); const to = ownerIdFor(value.newIssuer, value.newSub);
    if (from === to || fromIds.has(from) || toIds.has(to) || !input.ownerIdentities.some(identity => identity.ownerId === to && identity.issuer === value.newIssuer && identity.sub === value.newSub)) throw failure();
    fromIds.add(from); toIds.add(to); return { from, to };
  });
  if (pairs.some(pair => fromIds.has(pair.to))) throw failure();
  // The adapter preflights ALL pairs and recognizes only this run's durable copy manifests.
  await deps.restored.bindRun(input, mapping, deps.budget);
  for (const { from, to } of pairs) await deps.restored.remapOwner(from, to, input.runId, deps.budget);
  const report = await verifyRecovery(input, deps); await deps.restored.saveReport(input.runId, report, deps.budget); return report;
}

// Recovery writes are confined to the explicitly bound restored environment.
type Row = Record<string, unknown>;
type Actions = NonNullable<TransactWriteCommandInput["TransactItems"]>;
const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const ownerHash = z.string().regex(/^[0-9a-f]{64}$/);
const natural = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const rootSchema = z.strictObject({ pk: z.literal("GLOBAL"), sk: z.string(), inputSha256: ownerHash, mappingSha256: ownerHash.nullable(), report: z.unknown().nullable() });
const ownerIntentSchema = z.strictObject({ pk: z.literal("GLOBAL"), sk: z.string(), inputSha256: ownerHash, from: ownerHash, to: ownerHash, phase: z.enum(["preparing", "copying", "copied", "done"]), itemCount: natural, imageBytes: natural, recordCount: natural, recordsSha256: ownerHash });
export interface RecoveryImageServices { sourceImages: ImagesStore; restoredImages: ImagesStore; clock: () => number; uuid: () => string }
/** Clients are supplied by the explicit CLI factory; constructors themselves perform no I/O. */
export function createRecoveryStore(client: DynamoDBDocumentClient, config: Config, input: RecoveryInput, images: RecoveryImageServices, budget: Budget): RecoveryStore {
  assertRecoveryInput(input);
  for (const field of ["region", "remindersTable", "ownerStateTable", "imageJobsTable", "imagesBucket", "issuer"] as const) if (config[field] !== input.restored[field]) throw failure();
  const inputSha256 = digest({ contractVersion: 1, input, limits: config.limits }); const rootKey = { pk: "GLOBAL", sk: `RECOVERY#${input.runId}` };
  const ownerKey = (from: string) => ({ pk: "GLOBAL" as const, sk: `${rootKey.sk}#OWNER#${from}` });
  const manifestKey = (from: string, id: string) => ({ pk: "GLOBAL" as const, sk: `${rootKey.sk}#ITEM#${from}#${digest(id)}` });
  const imageKey = (previous: ActiveReminder, target: string) => ({ pk: "GLOBAL" as const, sk: `${rootKey.sk}#IMAGE#${digest([previous.ownerId, previous.id, previous.thumbnail, target])}` });
  const authorizedPairs = new Set<string>();
  const jobs = createJobsStore(client, config); const ownerStore = createOwnerStore(client, config);
  function bound(runId: string, suppliedBudget: Budget): void { if (runId !== input.runId || suppliedBudget !== budget) throw failure(); requireBudget(budget); }
  async function get(TableName: string, Key: Row): Promise<Row | null> {
    requireBudget(budget); const response = await client.send(new GetCommand({ TableName, Key, ConsistentRead: true }), { abortSignal: budget.signal }); return response.Item ?? null;
  }
  async function *scan(TableName: string): AsyncIterable<Row> {
    let cursor: Row | undefined; const seen = new Set<string>();
    do {
      requireBudget(budget); const response = await client.send(new ScanCommand({ TableName, ConsistentRead: true, Limit: 100, ...(cursor ? { ExclusiveStartKey: cursor } : {}) }), { abortSignal: budget.signal });
      if (response.Items !== undefined && !Array.isArray(response.Items)) throw failure();
      yield* response.Items ?? []; cursor = response.LastEvaluatedKey;
      if (cursor && Object.keys(cursor).length === 0) cursor = undefined;
      if (cursor) { const key = digest(cursor); if (seen.has(key)) throw failure(); seen.add(key); }
    } while (cursor);
  }
  const gateCheck = (): Actions[number] => ({ ConditionCheck: { TableName: config.ownerStateTable, Key: keys.publication, ConditionExpression: "#published = :false", ExpressionAttributeNames: { "#published": "published" }, ExpressionAttributeValues: { ":false": false } } });
  const rootCheck = (): Actions[number] => ({ ConditionCheck: { TableName: config.ownerStateTable, Key: rootKey, ConditionExpression: "#identity = :identity", ExpressionAttributeNames: { "#identity": "inputSha256" }, ExpressionAttributeValues: { ":identity": inputSha256 } } });
  async function tx(actions: Actions, checkRoot = true): Promise<void> {
    requireBudget(budget); await client.send(new TransactWriteCommand({ TransactItems: [gateCheck(), ...(checkRoot ? [rootCheck()] : []), ...actions] }), { abortSignal: budget.signal });
  }
  function absent(TableName: string, Item: Row, field: string): Actions[number] { return { Put: { TableName, Item, ConditionExpression: "attribute_not_exists(#key)", ExpressionAttributeNames: { "#key": field } } }; }
  function exact(row: Row): { ConditionExpression: string; ExpressionAttributeNames: Record<string, string>; ExpressionAttributeValues: Row } {
    const names: Record<string, string> = {}; const values: Row = {}; const conditions: string[] = [];
    Object.entries(row).forEach(([field, value], index) => { const suffix = String.fromCharCode(65 + index); names[`#f${suffix}`] = field; values[`:v${suffix}`] = value; conditions.push(`#f${suffix} = :v${suffix}`); });
    return { ConditionExpression: conditions.join(" AND "), ExpressionAttributeNames: names, ExpressionAttributeValues: values };
  }
  async function storage(ownerId: string): Promise<{ itemCount: number; imageBytes: number } | null> {
    const row = await get(config.ownerStateTable, keys.storage(ownerId)); if (!row) return null;
    const value = z.strictObject({ pk: z.literal(keys.storage(ownerId).pk), sk: z.literal("STORAGE"), itemCount: natural, imageBytes: natural, migrationRunId: z.string().min(1).optional() }).parse(row);
    return { itemCount: value.itemCount, imageBytes: value.imageBytes };
  }
  function counter(ownerId: string, previous: { itemCount: number; imageBytes: number }, next: { itemCount: number; imageBytes: number }): Actions[number] {
    if (!Number.isSafeInteger(next.itemCount) || !Number.isSafeInteger(next.imageBytes) || next.itemCount < 0 || next.imageBytes < 0) throw failure();
    return { Update: { TableName: config.ownerStateTable, Key: keys.storage(ownerId), UpdateExpression: "SET #items = :items, #bytes = :bytes", ConditionExpression: "#items = :oldItems AND #bytes = :oldBytes", ExpressionAttributeNames: { "#items": "itemCount", "#bytes": "imageBytes" }, ExpressionAttributeValues: { ":items": next.itemCount, ":bytes": next.imageBytes, ":oldItems": previous.itemCount, ":oldBytes": previous.imageBytes } } };
  }
  async function ownerIntent(from: string) {
    const row = await get(config.ownerStateTable, ownerKey(from)); if (!row) return null;
    const intent = ownerIntentSchema.parse(row);
    if (intent.pk !== "GLOBAL" || intent.sk !== ownerKey(from).sk || intent.from !== from || intent.inputSha256 !== inputSha256) throw failure(); return intent;
  }
  async function manifests(intent: NonNullable<Awaited<ReturnType<typeof ownerIntent>>>): Promise<StoredReminder[]> {
    const records: StoredReminder[] = [];
    for await (const row of scan(config.ownerStateTable)) if (String(row.sk).startsWith(`${rootKey.sk}#ITEM#${intent.from}#`)) {
      if (!isDeepStrictEqual(Object.keys(row).sort(), ["inputSha256", "pk", "previous", "sk"].sort()) || row.inputSha256 !== inputSha256 || row.pk !== "GLOBAL") throw failure();
      const item = parseStoredReminder(row.previous, intent.from); if (row.sk !== manifestKey(intent.from, item.id).sk) throw failure(); records.push(item);
    }
    records.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    if (records.length !== intent.recordCount || digest(records) !== intent.recordsSha256) throw failure(); return records;
  }
  function totals(records: StoredReminder[]) { return records.reduce((sum, item) => item.deleted ? sum : { itemCount: sum.itemCount + 1, imageBytes: sum.imageBytes + (item.thumbnail?.bytes ?? 0) }, { itemCount: 0, imageBytes: 0 }); }
  async function originalRecords(ownerId: string): Promise<StoredReminder[]> {
    const records: StoredReminder[] = []; for await (const item of store.listItems()) if (item.ownerId === ownerId) records.push(item);
    return records.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  }
  async function preflight(mapping: RecoveryOwnerMap[]): Promise<void> {
    const all = await inventory({ restored: store, ...images, budget, clock: images.clock, uuid: images.uuid });
    for (const owner of all.owners) if (!isDeepStrictEqual(totals(all.items.filter(item => item.ownerId === owner.ownerId)), { itemCount: owner.itemCount, imageBytes: owner.imageBytes })) throw failure();
    if (all.items.some(item => !all.owners.some(owner => owner.ownerId === item.ownerId))) throw failure();
    const imageIds = new Set<string>();
    for (const item of all.items) if (!item.deleted && item.thumbnail) {
      if (imageIds.has(item.thumbnail.imageId) || !jobMatches(await jobs.get(item.thumbnail.imageId, budget), item)) throw failure(); imageIds.add(item.thumbnail.imageId);
      await pinnedBytes(item.thumbnail, { restored: store, ...images, budget, clock: images.clock, uuid: images.uuid });
    }
    for await (const job of store.listJobs()) if (job.state === "committed" && !imageIds.has(job.jobId)) throw failure();
    for (const pair of mapping) {
      const from = ownerIdFor(pair.oldIssuer, pair.oldSub); const to = ownerIdFor(pair.newIssuer, pair.newSub); const prior = await ownerIntent(from);
      const sourceRecords = all.items.filter(item => item.ownerId === from); const targetRecords = all.items.filter(item => item.ownerId === to);
      if (prior) { if (prior.to !== to) throw failure(); if (prior.phase !== "preparing") await manifests(prior); }
      else if (!all.owners.some(owner => owner.ownerId === from) || all.owners.some(owner => owner.ownerId === to) || targetRecords.length || [...await collectJobs()].some(job => job.ownerId === to)) throw failure();
      const aggregate = prior ? { itemCount: prior.itemCount, imageBytes: prior.imageBytes } : totals(sourceRecords);
      if (aggregate.itemCount > config.limits.itemCount || aggregate.imageBytes > config.limits.imageBytes) throw failure();
    }
  }
  async function collectJobs(): Promise<ImageJob[]> { const values: ImageJob[] = []; for await (const job of store.listJobs()) values.push(job); return values; }
  async function copiedRef(previous: ActiveReminder, to: string): Promise<ImageRef> {
    const original = previous.thumbnail!; const data = await pinnedBytes(original, { restored: store, ...images, budget, clock: images.clock, uuid: images.uuid });
    const job = await store.stageImageReplacement(previous, to, input.runId, budget);
    const head = await images.restoredImages.head(job.key, null, budget);
    const ref = head ? { ...original, imageId: job.jobId, key: job.key, versionId: head.versionId } : await images.restoredImages.put(job, { data, mime: original.mime, bytes: original.bytes, sha256: original.sha256 }, budget);
    if (head?.deleteMarker || head && head.sha256 !== original.sha256 || ref.imageId !== job.jobId || ref.key !== job.key || ref.mime !== original.mime || ref.bytes !== original.bytes || ref.sha256 !== original.sha256 || !ref.versionId || ref.versionId === "null") throw failure();
    const actual = await images.restoredImages.get(ref, budget);
    if (!Buffer.from(actual).equals(Buffer.from(data)) || !await isCurrent(ref, { restored: store, ...images, budget, clock: images.clock, uuid: images.uuid })) throw failure(); return ref;
  }
  async function verifyTarget(intent: NonNullable<Awaited<ReturnType<typeof ownerIntent>>>): Promise<void> {
    const records = await manifests(intent); const actual = await originalRecords(intent.to);
    if (actual.length !== records.length || !isDeepStrictEqual(await storage(intent.to), { itemCount: intent.itemCount, imageBytes: intent.imageBytes })) throw failure();
    for (const previous of records) {
      let expected: StoredReminder = { ...previous, ownerId: intent.to };
      if (!previous.deleted && previous.thumbnail) {
        const row = await get(config.ownerStateTable, imageKey(previous, intent.to));
        if (!row || row.inputSha256 !== inputSha256 || row.targetOwnerId !== intent.to || !isDeepStrictEqual(row.previous, previous)) throw failure();
        const staged = row.job as ImageJob; const job = await jobs.get(staged.jobId, budget);
        if (!job || job.state !== "committed" || !job.versionId || staged.key !== keys.image(intent.to, staged.jobId)) throw failure();
        const ref: ImageRef = { ...previous.thumbnail, imageId: staged.jobId, key: staged.key, versionId: job.versionId };
        const record = { ...previous, ownerId: intent.to, thumbnail: ref };
        if (!jobMatches(job, record)) throw failure();
        const bytes = await images.restoredImages.get(ref, budget);
        if (bytes.length !== ref.bytes || hash(bytes) !== ref.sha256 || !await isCurrent(ref, { restored: store, ...images, budget, clock: images.clock, uuid: images.uuid })) throw failure();
        expected = record;
      }
      if (!isDeepStrictEqual(actual.find(item => item.id === previous.id), expected)) throw failure();
    }
  }
  const committedJob = (ref: ImageRef, ownerId: string, createdAtMs: number): ImageJob => ({ jobId: ref.imageId, ownerId, key: ref.key, versionId: ref.versionId, mime: ref.mime, bytes: ref.bytes, sha256: ref.sha256, state: "committed", createdAtMs, updatedAtMs: images.clock() });
  const finishOldJob = (ref: ImageRef, ownerId: string): Actions[number] => ({ Update: { TableName: config.imageJobsTable, Key: { jobId: ref.imageId }, UpdateExpression: "SET #state = :done, #updated = :at", ConditionExpression: "#state = :committed AND #owner = :owner AND #key = :key AND #version = :version", ExpressionAttributeNames: { "#state": "state", "#updated": "updatedAtMs", "#owner": "ownerId", "#key": "key", "#version": "versionId" }, ExpressionAttributeValues: { ":done": "done", ":at": images.clock(), ":committed": "committed", ":owner": ownerId, ":key": ref.key, ":version": ref.versionId } } });
  const store: RecoveryStore = {
    gate: ownerStore.gate,
    async prepareUnpublished(runId, suppliedBudget) {
      bound(runId, suppliedBudget); const existing = await get(config.ownerStateTable, keys.publication);
      if (!existing) {
        requireBudget(budget); await client.send(new TransactWriteCommand({ TransactItems: [absent(config.ownerStateTable, { ...keys.publication, published: false, runId }, "pk")] }), { abortSignal: budget.signal }); return;
      }
      const gate = await ownerStore.gate(budget); requireBudget(budget);
      await client.send(new TransactWriteCommand({ TransactItems: [{ Update: { TableName: config.ownerStateTable, Key: keys.publication, UpdateExpression: "SET #published = :false, #run = :run", ConditionExpression: "#published = :prior AND #run = :priorRun", ExpressionAttributeNames: { "#published": "published", "#run": "runId" }, ExpressionAttributeValues: { ":false": false, ":run": runId, ":prior": gate.published, ":priorRun": gate.runId } } }] }), { abortSignal: budget.signal });
    },
    async bindRun(value, mapping, suppliedBudget) {
      bound(value.runId, suppliedBudget); if (!isDeepStrictEqual(value, input)) throw failure();
      const row = await get(config.ownerStateTable, rootKey); const mappingSha256 = mapping.length ? digest(mapping) : null;
      if (row) {
        const root = rootSchema.parse(row); if (root.sk !== rootKey.sk || root.inputSha256 !== inputSha256 || mappingSha256 && root.mappingSha256 && mappingSha256 !== root.mappingSha256) throw failure();
        await tx([{ Update: { TableName: config.ownerStateTable, Key: rootKey, UpdateExpression: "SET #mapping = :mapping, #report = :report", ...exact(row), ExpressionAttributeNames: { ...exact(row).ExpressionAttributeNames, "#mapping": "mappingSha256", "#report": "report" }, ExpressionAttributeValues: { ...exact(row).ExpressionAttributeValues, ":mapping": mappingSha256 ?? root.mappingSha256, ":report": null } } }], false);
      } else await tx([absent(config.ownerStateTable, { ...rootKey, inputSha256, mappingSha256, report: null }, "pk")], false);
      if (mapping.length) {
        await preflight(mapping);
        authorizedPairs.clear(); for (const pair of mapping) authorizedPairs.add(JSON.stringify([ownerIdFor(pair.oldIssuer, pair.oldSub), ownerIdFor(pair.newIssuer, pair.newSub)]));
      }
    },
    async hasIncompleteRemap(runId, suppliedBudget) {
      bound(runId, suppliedBudget); let incomplete = false;
      const current = await get(config.ownerStateTable, rootKey);
      if (current) { const root = rootSchema.parse(current); if (root.sk !== rootKey.sk || root.inputSha256 !== inputSha256) throw failure(); }
      for await (const row of scan(config.ownerStateTable)) if (typeof row.sk === "string" && row.sk.startsWith("RECOVERY#") && row.sk.includes("#OWNER#")) {
        const marker = ownerIntentSchema.parse(row);
        const match = /^RECOVERY#([0-9a-f-]{36})#OWNER#([0-9a-f]{64})$/.exec(marker.sk);
        if (!match || !validUuid(match[1]!) || marker.from !== match[2]) throw failure();
        const root = rootSchema.parse(await get(config.ownerStateTable, { pk: "GLOBAL", sk: `RECOVERY#${match[1]}` }));
        if (root.inputSha256 !== marker.inputSha256 || root.mappingSha256 === null || root.sk !== `RECOVERY#${match[1]}`) throw failure();
        if (marker.phase !== "done") incomplete = true;
      }
      return incomplete;
    },
    async *listItems() { for await (const row of scan(config.remindersTable)) { if (typeof row.ownerId !== "string" || !/^[0-9a-f]{64}$/.test(row.ownerId)) throw failure(); yield parseStoredReminder(row, row.ownerId); } },
    async *listOwners() { for await (const row of scan(config.ownerStateTable)) if (row.sk === "STORAGE") {
      if (typeof row.pk !== "string" || !/^OWNER#[0-9a-f]{64}$/.test(row.pk)) throw failure(); const ownerId = row.pk.slice(6); const counter = await storage(ownerId); if (!counter) throw failure(); yield { ownerId, ...counter };
    } },
    async *listJobs() { for await (const row of scan(config.imageJobsTable)) {
      if (row.jobId === keys.cleanupCheckpoint) { await jobs.checkpoint(budget); continue; }
      if (typeof row.jobId !== "string") throw failure(); const job = await jobs.get(row.jobId, budget); if (!job || !/^[0-9a-f]{64}$/.test(job.ownerId)) throw failure(); yield job;
    } },
    getJob: jobs.get,
    async stageImageReplacement(previous, target, runId, suppliedBudget) {
      bound(runId, suppliedBudget); const item = parseStoredReminder(previous, previous.ownerId); if (item.deleted || !item.thumbnail || !/^[0-9a-f]{64}$/.test(target)) throw failure();
      if (target !== item.ownerId && !authorizedPairs.has(JSON.stringify([item.ownerId, target]))) throw failure();
      const key = imageKey(item, target); const row = await get(config.ownerStateTable, key);
      if (row) {
        if (!isDeepStrictEqual(Object.keys(row).sort(), ["inputSha256", "job", "pk", "previous", "sk", "targetOwnerId"].sort()) || row.inputSha256 !== inputSha256 || row.pk !== "GLOBAL" || row.sk !== key.sk || row.targetOwnerId !== target || !isDeepStrictEqual(row.previous, item)) throw failure();
        const job = row.job as ImageJob; const actual = await jobs.get(job.jobId, budget);
        if (!actual || !validUuid(job.jobId) || job.key !== keys.image(target, job.jobId) || job.ownerId !== target || actual.key !== job.key || actual.ownerId !== target || actual.createdAtMs !== job.createdAtMs || !["pending", "committed"].includes(actual.state)) throw failure();
        const expected: ImageJob = { jobId: job.jobId, ownerId: target, key: job.key, state: "pending", createdAtMs: job.createdAtMs, updatedAtMs: job.createdAtMs, dueAtMs: job.createdAtMs + 86_400_000, ...cleanupKeys("pending", job.jobId, job.createdAtMs + 86_400_000) };
        if (!isDeepStrictEqual(job, expected) || actual.state === "pending" && !isDeepStrictEqual(actual, job) || actual.state === "committed" && (actual.bytes !== item.thumbnail.bytes || actual.mime !== item.thumbnail.mime || actual.sha256 !== item.thumbnail.sha256)) throw failure(); return job;
      }
      const jobId = images.uuid(); if (!validUuid(jobId) || jobId === item.thumbnail.imageId) throw failure();
      if (await images.restoredImages.head(keys.image(target, jobId), null, budget)) throw failure();
      const at = images.clock(); const dueAtMs = at + 86_400_000; const job: ImageJob = { jobId, ownerId: target, key: keys.image(target, jobId), state: "pending", createdAtMs: at, updatedAtMs: at, dueAtMs, ...cleanupKeys("pending", jobId, dueAtMs) };
      await tx([{ ConditionCheck: { TableName: config.remindersTable, Key: { ownerId: item.ownerId, id: item.id }, ...exact(item as unknown as Row) } }, absent(config.ownerStateTable, { ...key, inputSha256, previous: item, targetOwnerId: target, job }, "pk"), absent(config.imageJobsTable, job as unknown as Row, "jobId")]); return job;
    },
    async replaceImage(previous, next, job, runId, suppliedBudget) {
      bound(runId, suppliedBudget); const current = parseStoredReminder(next, previous.ownerId); if (current.deleted || !current.thumbnail || !previous.thumbnail || !isDeepStrictEqual({ ...current, thumbnail: previous.thumbnail }, previous) || !jobMatches(job, current) || current.thumbnail.bytes !== previous.thumbnail.bytes || current.thumbnail.mime !== previous.thumbnail.mime || current.thumbnail.sha256 !== previous.thumbnail.sha256 || current.thumbnail.key === previous.thumbnail.key) throw failure();
      const pending = await jobs.get(job.jobId, budget); if (!pending || pending.state !== "pending") throw failure();
      await tx([{ Put: { TableName: config.remindersTable, Item: current, ...exact(previous as unknown as Row) } }, { Put: { TableName: config.imageJobsTable, Item: job, ...exact(pending as unknown as Row) } }, finishOldJob(previous.thumbnail, previous.ownerId)]);
    },
    async remapOwner(from, to, runId, suppliedBudget) {
      bound(runId, suppliedBudget); if (!authorizedPairs.has(JSON.stringify([from, to]))) throw failure(); let intent = await ownerIntent(from);
      if (!intent) {
        const records = await originalRecords(from); const aggregate = totals(records);
        if (!await storage(from) || await storage(to) || aggregate.itemCount > config.limits.itemCount || aggregate.imageBytes > config.limits.imageBytes) throw failure();
        intent = { ...ownerKey(from), inputSha256, from, to, phase: "preparing", ...aggregate, recordCount: records.length, recordsSha256: digest(records) };
        await tx([absent(config.ownerStateTable, intent, "pk")]);
      }
      if (intent.to !== to) throw failure(); if (intent.phase === "done") { await verifyTarget(intent); return; }
      if (intent.phase === "preparing") {
        const records = await originalRecords(from); if (records.length !== intent.recordCount || digest(records) !== intent.recordsSha256) throw failure();
        for (const previous of records) {
          const key = manifestKey(from, previous.id); const row = await get(config.ownerStateTable, key);
          if (row) { if (!isDeepStrictEqual(row, { ...key, inputSha256, previous })) throw failure(); }
          else await tx([absent(config.ownerStateTable, { ...key, inputSha256, previous }, "pk")]);
        }
        const next = { ...intent, phase: "copying" as const };
        await tx([{ Put: { TableName: config.ownerStateTable, Item: next, ...exact(intent) } }, absent(config.ownerStateTable, { ...keys.storage(to), itemCount: 0, imageBytes: 0 }, "pk")]); intent = next;
      }
      const records = await manifests(intent);
      if (intent.phase === "copying") {
        if (digest(await originalRecords(from)) !== intent.recordsSha256) throw failure();
        for (const previous of records) {
          const row = await get(config.remindersTable, { ownerId: to, id: previous.id });
          if (row) {
            const actual = parseStoredReminder(row, to, previous.id); const expected = { ...previous, ownerId: to };
            if (!actual.deleted && !previous.deleted) {
              if (previous.thumbnail) { const replacement = await copiedRef(previous, to); if (!isDeepStrictEqual(actual, { ...expected, thumbnail: replacement })) throw failure(); }
              else if (!isDeepStrictEqual(actual, expected)) throw failure();
            } else if (!isDeepStrictEqual(actual, expected)) throw failure(); continue;
          }
          let next: StoredReminder = { ...previous, ownerId: to }; const actions: Actions = [];
          if (!previous.deleted && previous.thumbnail) {
            const ref = await copiedRef(previous, to); next = { ...previous, ownerId: to, thumbnail: ref }; const pending = await jobs.get(ref.imageId, budget); if (!pending || pending.state !== "pending") throw failure();
            actions.push({ Put: { TableName: config.imageJobsTable, Item: committedJob(ref, to, pending.createdAtMs), ...exact(pending as unknown as Row) } });
          }
          const before = await storage(to); if (!before) throw failure();
          const after = previous.deleted ? before : { itemCount: before.itemCount + 1, imageBytes: before.imageBytes + (previous.thumbnail?.bytes ?? 0) };
          if (after.itemCount > config.limits.itemCount || after.imageBytes > config.limits.imageBytes) throw failure();
          actions.push(absent(config.remindersTable, next as unknown as Row, "ownerId"), counter(to, before, after), { ConditionCheck: { TableName: config.remindersTable, Key: { ownerId: from, id: previous.id }, ...exact(previous as unknown as Row) } });
          await tx(actions);
        }
        const actual = await originalRecords(to); if (actual.length !== intent.recordCount || !isDeepStrictEqual(await storage(to), { itemCount: intent.itemCount, imageBytes: intent.imageBytes })) throw failure();
        for (const item of actual) if (!item.deleted && item.thumbnail) { if (!jobMatches(await jobs.get(item.thumbnail.imageId, budget), item)) throw failure(); await images.restoredImages.get(item.thumbnail, budget); if (!await isCurrent(item.thumbnail, { restored: store, ...images, budget, clock: images.clock, uuid: images.uuid })) throw failure(); }
        const next = { ...intent, phase: "copied" as const }; await tx([{ Put: { TableName: config.ownerStateTable, Item: next, ...exact(intent) } }]); intent = next;
      }
      await verifyTarget(intent);
      // Only fully copied and verified owners reach the old-record cleanup phase.
      for (const previous of records) {
        const row = await get(config.remindersTable, { ownerId: from, id: previous.id }); if (!row) continue;
        if (!isDeepStrictEqual(row, previous)) throw failure(); const before = await storage(from); if (!before) throw failure();
        const after = previous.deleted ? before : { itemCount: before.itemCount - 1, imageBytes: before.imageBytes - (previous.thumbnail?.bytes ?? 0) };
        const actions: Actions = [{ Delete: { TableName: config.remindersTable, Key: { ownerId: from, id: previous.id }, ...exact(previous as unknown as Row) } }, counter(from, before, after)];
        if (!previous.deleted && previous.thumbnail) actions.push(finishOldJob(previous.thumbnail, from)); await tx(actions);
      }
      if ((await originalRecords(from)).length || !isDeepStrictEqual(await storage(from), { itemCount: 0, imageBytes: 0 }) || !isDeepStrictEqual(await storage(to), { itemCount: intent.itemCount, imageBytes: intent.imageBytes })) throw failure();
      await tx([{ Delete: { TableName: config.ownerStateTable, Key: keys.storage(from), ConditionExpression: "#items = :zero AND #bytes = :zero", ExpressionAttributeNames: { "#items": "itemCount", "#bytes": "imageBytes" }, ExpressionAttributeValues: { ":zero": 0 } } }, { Put: { TableName: config.ownerStateTable, Item: { ...intent, phase: "done" }, ...exact(intent) } }]);
    },
    async saveReport(runId, report, suppliedBudget) {
      bound(runId, suppliedBudget);
      // Bounded persistent receipt. Full position-only diagnostics are returned to the operator.
      const receipt = { sha256: digest(report), matched: report.matched, missingImages: report.missingImages.length, mismatchedOwners: report.mismatchedOwners.length, countDiscrepancies: report.countDiscrepancies.length, unresolvedJobs: report.unresolvedJobs.length, readyToSwitch: report.readyToSwitch, cognitoCredentialsRestored: false };
      await tx([{ Update: { TableName: config.ownerStateTable, Key: rootKey, UpdateExpression: "SET #report = :report", ConditionExpression: "#identity = :identity", ExpressionAttributeNames: { "#report": "report", "#identity": "inputSha256" }, ExpressionAttributeValues: { ":report": receipt, ":identity": inputSha256 } } }], false);
    },
  };
  return store;
}

/** This factory performs AWS reads only when an operator explicitly executes the CLI. */
export async function createRecoveryDeps(source: import("./legacy").MigrationTarget, restored: import("./legacy").MigrationTarget, input: RecoveryInput): Promise<RecoveryDeps> {
  const { environmentIdentityFor } = await import("./legacy");
  assertRecoveryInput(input);
  if (!isDeepStrictEqual(environmentIdentityFor(source), input.source) || !isDeepStrictEqual(environmentIdentityFor(restored), input.restored)) throw failure();
  const { createAwsClients } = await import("../../src/shared/aws");
  const { createBudget } = await import("../../src/shared/budget");
  const { createMigrationImagesStore, verifyMigrationCaller } = await import("./migration-store");
  const { STSClient } = await import("@aws-sdk/client-sts"); const { randomUUID } = await import("node:crypto");
  const deadline = Date.now() + 900_000; const budget = createBudget(() => deadline - Date.now(), 1000);
  await verifyMigrationCaller(new STSClient({ region: restored.region, maxAttempts: 1 }), restored.accountId, budget);
  const sourceClients = createAwsClients(source); const targetClients = createAwsClients(restored);
  const original = createMigrationImagesStore(sourceClients.s3, source);
  const forbidden = (): Promise<never> => Promise.reject(failure());
  const sourceImages: ImagesStore = { ...original, put: forbidden, markDeleted: forbidden, signGet: forbidden };
  const restoredImages = createMigrationImagesStore(targetClients.s3, restored);
  const services: RecoveryImageServices = { sourceImages, restoredImages, clock: Date.now, uuid: randomUUID };
  return { ...services, budget, restored: createRecoveryStore(targetClients.dynamo, restored, input, services, budget) };
}
