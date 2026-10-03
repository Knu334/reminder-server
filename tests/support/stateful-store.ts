import { GetCommand, QueryCommand, TransactWriteCommand, UpdateCommand, type DynamoDBDocumentClient, type TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";
import { loadConfig } from "../../src/config";
import { createRemindersStore } from "../../src/reminders/dynamo-store";
import { createOwnerStore } from "../../src/reminders/owner-store";
import { createRemindersService } from "../../src/reminders/service";
import type { ImageJob } from "../../src/images/types";
import type { ImagesStore, JobsStore } from "../../src/shared/ports";
import { requireBudget } from "../../src/shared/budget";

export const harnessConfig = loadConfig({ AWS_REGION: "ap-northeast-1", REMINDERS_TABLE: "reminders", OWNER_STATE_TABLE: "owners", IMAGE_JOBS_TABLE: "jobs", IMAGES_BUCKET: "images", EXPECTED_API_ID: "api123", EXPECTED_API_STAGE: "$default", COGNITO_ISSUER: "https://cognito-idp.ap-northeast-1.amazonaws.com/test", COGNITO_CLIENT_ID: "client123" });
type Row = Record<string, unknown>;
export interface TestState { reminders: Row[]; storage: Row[]; rates: Row[]; jobs: ImageJob[]; transactions: TransactWriteCommandInput[] }
const conditional = (): Error => Object.assign(new Error("synthetic conditional failure"), { name: "ConditionalCheckFailedException" });
const cancellation = (codes: string[]): Error => Object.assign(new Error("synthetic cancellation"), { name: "TransactionCanceledException", CancellationReasons: codes.map(Code => ({ Code })) });

/** No awaits occur between condition evaluation and commit: this is the transport's critical section. */
export function createHarness() {
  let nowMs = Date.parse("2026-10-03T00:00:00.000Z"); let sequence = 0;
  const tables: Record<string, Map<string, Row>> = { reminders: new Map(), owners: new Map(), jobs: new Map() };
  const tokens = new Map<string, string>(); const transactions: TransactWriteCommand[] = [];
  const faults = new Map<string, "before" | "after-commit">();
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
    if (command instanceof GetCommand) { failure("get"); const row = table(command.input.TableName).get(rowKey(command.input.Key ?? {})); return row === undefined ? {} : { Item: structuredClone(row) }; }
    if (command instanceof QueryCommand) {
      const rows = [...table(command.input.TableName).values()].filter(row => row.ownerId === command.input.ExpressionAttributeValues?.[":owner"] && (command.input.ExclusiveStartKey === undefined || String(row.id) > String(command.input.ExclusiveStartKey.id))).sort((a, b) => String(a.id).localeCompare(String(b.id)));
      const page = rows.slice(0, command.input.Limit); const last = page.at(-1);
      return { Items: structuredClone(page), ...(rows.length > page.length && last ? { LastEvaluatedKey: { ownerId: last.ownerId, id: last.id } } : {}) };
    }
    if (command instanceof UpdateCommand) {
      const input = command.input; const bucket = table(input.TableName); const key = rowKey(input.Key ?? {}); const row = bucket.get(key);
      if (!passes(row, input.ExpressionAttributeNames ?? {}, input.ExpressionAttributeValues ?? {}, input.ConditionExpression ?? "")) throw conditional();
      bucket.set(key, applyUpdate(row ?? { ...input.Key }, input.ExpressionAttributeNames ?? {}, input.ExpressionAttributeValues ?? {}, input.UpdateExpression ?? "")); return {};
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
  const reminders = createRemindersStore(client, harnessConfig); const owners = createOwnerStore(client, harnessConfig);
  const jobs: JobsStore = {
    async createPending(job, budget) { requireBudget(budget); const bucket = table("jobs"); if (bucket.has(rowKey({ jobId: job.jobId }))) throw conditional(); bucket.set(rowKey({ jobId: job.jobId }), structuredClone(job) as unknown as Row); },
    async get(jobId, budget) { requireBudget(budget); return structuredClone(table("jobs").get(rowKey({ jobId })) ?? null) as ImageJob | null; },
    async recordUpload(ref, budget) { requireBudget(budget); const key = rowKey({ jobId: ref.imageId }); const row = table("jobs").get(key); if (!row) throw conditional(); table("jobs").set(key, { ...row, versionId: ref.versionId, mime: ref.mime, bytes: ref.bytes, sha256: ref.sha256 }); },
    async queryDue() { throw new Error("R06 owns cleanup"); }, async claim() { throw new Error("R06 owns cleanup"); }, async complete() { throw new Error("R06 owns cleanup"); },
    async checkpoint() { return { roundRobinIndex: 0, cursors: {} }; }, async saveCheckpoint() { throw new Error("R06 owns cleanup"); },
  };
  const images: ImagesStore = {
    async put() { throw new Error("R05 owns images"); }, async head() { throw new Error("R05 owns images"); }, async get() { throw new Error("R05 owns images"); },
    async signGet() { throw new Error("R05 owns images"); }, async markDeleted() { throw new Error("R05 owns images"); }, async probe() {},
  };
  const service = createRemindersService({ reminders, owners, jobs, images, config: harnessConfig, clock: () => nowMs, uuid: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, "0")}` });
  return {
    service, reminders, owners, jobs, images,
    snapshot(): TestState { const states = [...table("owners").values()]; return structuredClone({ reminders: [...table("reminders").values()], storage: states.filter(row => row.sk === "STORAGE"), rates: states.filter(row => String(row.sk).startsWith("RATE#")), jobs: [...table("jobs").values()] as unknown as ImageJob[], transactions: transactions.map(command => command.input) }); },
    injectFault(point: string, mode: "before" | "after-commit"): void { faults.set(point, mode); },
    advanceMs(ms: number): void { nowMs += ms; },
  };
}
