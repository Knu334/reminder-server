import { GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand, type DynamoDBDocumentClient, type TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";
import { loadConfig } from "../../src/config";
import { createRemindersStore } from "../../src/reminders/dynamo-store";
import { createOwnerStore } from "../../src/reminders/owner-store";
import { createRemindersService } from "../../src/reminders/service";
import type { ImageJob, ImageRef } from "../../src/images/types";
import type { ImagesStore } from "../../src/shared/ports";
import { requireBudget } from "../../src/shared/budget";
import { createJobsStore } from "../../src/images/jobs-store";
import type { CleanupPartition } from "../../src/images/types";

export const harnessConfig = loadConfig({ AWS_REGION: "ap-northeast-1", REMINDERS_TABLE: "reminders", OWNER_STATE_TABLE: "owners", IMAGE_JOBS_TABLE: "jobs", IMAGES_BUCKET: "images", EXPECTED_API_ID: "api123", EXPECTED_API_STAGE: "$default", COGNITO_ISSUER: "https://cognito-idp.ap-northeast-1.amazonaws.com/test", COGNITO_CLIENT_ID: "client123" });
type Row = Record<string, unknown>;
export interface TestState { reminders: Row[]; storage: Row[]; rates: Row[]; jobs: ImageJob[]; transactions: TransactWriteCommandInput[] }
const conditional = (): Error => Object.assign(new Error("synthetic conditional failure"), { name: "ConditionalCheckFailedException" });
const cancellation = (codes: string[]): Error => Object.assign(new Error("synthetic cancellation"), { name: "TransactionCanceledException", CancellationReasons: codes.map(Code => ({ Code })) });

/** No awaits occur between condition evaluation and commit: this is the transport's critical section. */
export function createHarness(config = harnessConfig) {
  let nowMs = Date.parse("2026-10-03T00:00:00.000Z"); let sequence = 0;
  const tables: Record<string, Map<string, Row>> = { reminders: new Map(), owners: new Map(), jobs: new Map() };
  const tokens = new Map<string, string>(); const transactions: TransactWriteCommand[] = [];
  const faults = new Map<string, "before" | "after-commit">();
  let frozenIndex: Row[] | null = null; let claimHook: (() => void) | undefined; let checkpointWrites = 0;
  const cleanupQueries: Array<{ partition: CleanupPartition; cutoffMs: number; after: Row | null }> = [];
  const deletedKeys: string[] = []; const markers = new Map<string, string>();
  function table(name: string | undefined): Map<string, Row> { const value = name === undefined ? undefined : tables[name]; if (!value) throw new Error("Unknown synthetic table"); return value; }
  const rowKey = (row: Row): string => JSON.stringify(row.ownerId !== undefined && row.id !== undefined ? [row.ownerId, row.id] : row.pk !== undefined ? [row.pk, row.sk] : [row.jobId]);
  function failure(point: string): void {
    if (faults.has(point)) { faults.delete(point); throw Object.assign(new Error("synthetic private timeout"), { name: "TimeoutError" }); }
  }
  function applyUpdate(row: Row, names: Record<string, string>, values: Row, expression: string): Row {
    const next = { ...row };
    // Split SET clauses only at commas outside function parentheses.
    const set = expression.replace(/^SET /, "").split(" REMOVE ")[0] ?? "";
    for (const clause of set.split(/, (?![^()]*\))/)) {
      const addition = /^(#[A-Za-z]+) = if_not_exists\(#[A-Za-z]+, (:\w+)\) \+ (:\w+)$/.exec(clause);
      const assign = /^(#[A-Za-z]+) = (:\w+)$/.exec(clause);
      if (addition) { const field = names[addition[1] ?? ""]!; next[field] = Number(row[field] ?? values[addition[2] ?? ""]) + Number(values[addition[3] ?? ""]); }
      else if (assign) next[names[assign[1] ?? ""]!] = values[assign[2] ?? ""];
      else throw new Error(`Unsupported synthetic update: ${clause}`);
    }
    for (const alias of expression.split(" REMOVE ")[1]?.split(", ") ?? []) delete next[names[alias]!];
    return next;
  }
  function passes(row: Row | undefined, names: Record<string, string>, values: Row, expression: string): boolean {
    const tokens = expression.match(/attribute_not_exists|attribute_exists|BETWEEN|AND|OR|#[A-Za-z]+|:[A-Za-z]+|<=|>=|<>|[()=<>]/g) ?? [];
    let index = 0;
    const take = (): string => { const token = tokens[index++]; if (token === undefined) throw new Error("Incomplete synthetic condition"); return token; };
    function expect(token: string): void { if (take() !== token) throw new Error("Unsupported synthetic condition"); }
    function operand(token: string): unknown { return token.startsWith(":") ? values[token] : row?.[names[token]!]; }
    function primary(): boolean {
      const token = take();
      if (token === "(") { const result = or(); expect(")"); return result; }
      if (token === "attribute_not_exists" || token === "attribute_exists") {
        expect("("); const value = operand(take()); expect(")"); return token === "attribute_exists" ? value !== undefined : value === undefined;
      }
      const left = operand(token); const operation = take();
      if (operation === "BETWEEN") { const low = operand(take()); expect("AND"); const high = operand(take()); return typeof left === "number" && typeof low === "number" && typeof high === "number" && left >= low && left <= high; }
      const right = operand(take());
      if (left === undefined || right === undefined) return false;
      if (operation === "=") return left === right;
      if (operation === "<>") return left !== right;
      if (typeof left !== "number" || typeof right !== "number") return false;
      if (operation === "<") return left < right;
      if (operation === ">") return left > right;
      if (operation === "<=") return left <= right;
      if (operation === ">=") return left >= right;
      throw new Error("Unsupported synthetic condition operation");
    }
    function and(): boolean { let result = primary(); while (tokens[index] === "AND") { take(); const right = primary(); result = result && right; } return result; }
    function or(): boolean { let result = and(); while (tokens[index] === "OR") { take(); const right = and(); result = result || right; } return result; }
    if (tokens.length === 0) return true;
    const result = or(); if (index !== tokens.length) throw new Error("Unconsumed synthetic condition"); return result;
  }
  const client = { async send(command: unknown): Promise<unknown> {
    if (command instanceof GetCommand) { failure(command.input.TableName === "jobs" ? "jobGet" : "get"); const row = table(command.input.TableName).get(rowKey(command.input.Key ?? {})); return row === undefined ? {} : { Item: structuredClone(row) }; }
    if (command instanceof PutCommand) {
      const input = command.input; const bucket = table(input.TableName); const item = input.Item!; const key = rowKey(item);
      if (input.TableName === "jobs" && item.state === "pending") failure("createPending");
      if (!passes(bucket.get(key), input.ExpressionAttributeNames ?? {}, input.ExpressionAttributeValues ?? {}, input.ConditionExpression ?? "")) throw conditional();
      bucket.set(key, structuredClone(item)); if (item.jobId === "CHECKPOINT#cleanup") { checkpointWrites++; failure("saveCheckpoint"); } return {};
    }
    if (command instanceof QueryCommand) {
      if (command.input.IndexName !== undefined) {
        const input = command.input; const cutoff = String(input.ExpressionAttributeValues?.[":cutoff"]);
        cleanupQueries.push({ partition: input.ExpressionAttributeValues?.[":partition"] as CleanupPartition, cutoffMs: Number(cutoff.split("#")[0]), after: input.ExclusiveStartKey ?? null });
        const rows = (frozenIndex ?? [...table(input.TableName).values()]).filter(row => row.cleanupPartition === input.ExpressionAttributeValues?.[":partition"] && String(row.cleanupSortKey) <= cutoff
          && (input.ExclusiveStartKey === undefined || String(row.cleanupSortKey) > String(input.ExclusiveStartKey.cleanupSortKey))).sort((a, b) => String(a.cleanupSortKey) < String(b.cleanupSortKey) ? -1 : 1);
        const page = rows.slice(0, input.Limit); const last = page.at(-1);
        return { Items: page.map(row => ({ jobId: row.jobId, cleanupPartition: row.cleanupPartition, cleanupSortKey: row.cleanupSortKey })), ScannedCount: page.length,
          ...(rows.length > page.length && last ? { LastEvaluatedKey: { jobId: last.jobId, cleanupPartition: last.cleanupPartition, cleanupSortKey: last.cleanupSortKey } } : {}) };
      }
      const rows = [...table(command.input.TableName).values()].filter(row => row.ownerId === command.input.ExpressionAttributeValues?.[":owner"] && (command.input.ExclusiveStartKey === undefined || String(row.id) > String(command.input.ExclusiveStartKey.id))).sort((a, b) => String(a.id).localeCompare(String(b.id)));
      const page = rows.slice(0, command.input.Limit); const last = page.at(-1);
      return { Items: structuredClone(page), ...(rows.length > page.length && last ? { LastEvaluatedKey: { ownerId: last.ownerId, id: last.id } } : {}) };
    }
    if (command instanceof UpdateCommand) {
      const input = command.input; const bucket = table(input.TableName); const key = rowKey(input.Key ?? {}); const row = bucket.get(key);
      if (input.TableName === "jobs" && input.ExpressionAttributeNames?.["#mime"] === "mime") failure("recordUpload");
      const point = input.ExpressionAttributeValues?.[":deleting"] === "deleting" && input.ExpressionAttributeValues?.[":run"] !== undefined ? (input.ExpressionAttributeValues?.[":done"] === "done" ? "complete" : "claim") : null;
      if (point === "claim" && claimHook) { const hook = claimHook; claimHook = undefined; hook(); }
      if (point && faults.get(point) === "before") failure(point);
      const currentRow = bucket.get(key);
      if (!passes(currentRow, input.ExpressionAttributeNames ?? {}, input.ExpressionAttributeValues ?? {}, input.ConditionExpression ?? "")) throw conditional();
      const next = applyUpdate(row ?? { ...input.Key }, input.ExpressionAttributeNames ?? {}, input.ExpressionAttributeValues ?? {}, input.UpdateExpression ?? "");
      bucket.set(key, next); if (point) failure(point); return input.ReturnValues === "ALL_NEW" ? { Attributes: structuredClone(next) } : {};
    }
    if (command instanceof TransactWriteCommand) {
      transactions.push(command);
      if (faults.get("commit") === "before") failure("commit");
      const signature = JSON.stringify(command.input); const token = command.input.ClientRequestToken!;
      if (tokens.has(token)) { if (tokens.get(token) !== signature) throw new Error("IdempotentParameterMismatch"); return {}; }
      const mutations: Array<{ bucket: Map<string, Row>; key: string; next: Row }> = []; const codes: string[] = []; const unique = new Set<string>();
      for (const action of command.input.TransactItems ?? []) {
        const input = action.Put ?? action.Update; if (!input) throw new Error("Unsupported action");
        const keyRow = action.Put ? action.Put.Item! : action.Update!.Key!; const key = rowKey(keyRow); const bucket = table(input.TableName);
        const identity = `${input.TableName}:${key}`; if (unique.has(identity)) throw new Error("Duplicate transaction item"); unique.add(identity);
        const row = bucket.get(key);
        codes.push(passes(row, input.ExpressionAttributeNames ?? {}, input.ExpressionAttributeValues ?? {}, input.ConditionExpression ?? "") ? "None" : "ConditionalCheckFailed");
        const next = action.Put ? structuredClone(action.Put.Item!) : applyUpdate(row ?? { ...keyRow }, input.ExpressionAttributeNames ?? {}, input.ExpressionAttributeValues ?? {}, action.Update!.UpdateExpression!);
        mutations.push({ bucket, key, next });
      }
      if (codes.some(code => code !== "None")) throw cancellation(codes);
      for (const mutation of mutations) mutation.bucket.set(mutation.key, mutation.next);
      tokens.set(token, signature);
      if (faults.get("commit") === "after-commit") failure("commit");
      return {};
    }
    throw new Error("Unsupported synthetic command");
  } } as unknown as DynamoDBDocumentClient;
  const reminders = createRemindersStore(client, config); const owners = createOwnerStore(client, config);
  const jobs = createJobsStore(client, config);
  const objects = new Map<string, { ref: ImageRef; data: Uint8Array }>(); let uploadSequence = 0;
  const images: ImagesStore = {
    async put(job, image, budget) {
      requireBudget(budget); if (faults.get("put") === "before") failure("put");
      const ref = { imageId: job.jobId, key: job.key, versionId: `v${++uploadSequence}`, mime: image.mime, bytes: image.bytes, sha256: image.sha256 };
      objects.set(job.key, { ref, data: Buffer.from(image.data) }); markers.delete(job.key);
      if (faults.get("put") === "after-commit") failure("put"); return structuredClone(ref);
    },
    async head(key, versionId, budget) { requireBudget(budget); const marker = markers.get(key); if (marker && versionId === null) return { versionId: marker, sha256: null, deleteMarker: true }; const object = objects.get(key); return object && (versionId === null || versionId === object.ref.versionId) ? { versionId: object.ref.versionId, sha256: object.ref.sha256, deleteMarker: false } : null; },
    async get(ref, budget) { requireBudget(budget); const object = objects.get(ref.key); if (!object || object.ref.versionId !== ref.versionId) throw new Error("Synthetic image missing"); return Buffer.from(object.data); },
    async signGet(ref, seconds, budget) { requireBudget(budget); return `https://synthetic.test/${ref.key}?versionId=${ref.versionId}&expires=${seconds}`; },
    async markDeleted(key, budget) { requireBudget(budget); if (faults.get("markDeleted") === "before") failure("markDeleted"); deletedKeys.push(key); markers.set(key, `marker-${deletedKeys.length}`); if (faults.get("markDeleted") === "after-commit") failure("markDeleted"); }, async probe() {},
  };
  const service = createRemindersService({ reminders, owners, jobs, images, config, clock: () => nowMs, uuid: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}` });
  return {
    service, reminders, owners, jobs, images, cleanupQueries, deletedKeys,
    get checkpointWrites(): number { return checkpointWrites; },
    seedJob(job: ImageJob): void { const row = Object.fromEntries(Object.entries(job).filter(([, value]) => value !== undefined)); table("jobs").set(rowKey(row), structuredClone(row)); },
    setPublication(published: boolean): void { const row = { pk: "GLOBAL", sk: "PUBLICATION", published, runId: null }; table("owners").set(rowKey(row), row); },
    freezeCleanupIndex(): void { frozenIndex = [...table("jobs").values()].filter(row => row.cleanupPartition !== undefined).map(row => ({ jobId: row.jobId, cleanupPartition: row.cleanupPartition, cleanupSortKey: row.cleanupSortKey })); },
    beforeClaim(hook: () => void): void { claimHook = hook; },
    snapshot(): TestState { const states = [...table("owners").values()]; return structuredClone({ reminders: [...table("reminders").values()], storage: states.filter(row => row.sk === "STORAGE"), rates: states.filter(row => String(row.sk).startsWith("RATE#")), jobs: [...table("jobs").values()].filter(row => row.jobId !== "CHECKPOINT#cleanup") as unknown as ImageJob[], transactions: transactions.map(command => command.input) }); },
    injectFault(point: string, mode: "before" | "after-commit"): void { faults.set(point, mode); },
    advanceMs(ms: number): void { nowMs += ms; },
  };
}
