import assert from "node:assert/strict";
import { test } from "node:test";
import { GetCommand, QueryCommand, UpdateCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { loadConfig } from "../../src/config";
import { errorResponse } from "../../src/api/responses";
import { ownerIdFor } from "../../src/api/identity";
import { decodeCursor, encodeCursor, parseLimit } from "../../src/reminders/cursor";
import { createRemindersStore } from "../../src/reminders/dynamo-store";
import { checkRate, createOwnerStore } from "../../src/reminders/owner-store";
import { createAwsClients } from "../../src/shared/aws";
import { ApiError } from "../../src/shared/errors";
import { activeReminder, testBudget } from "../support/fixtures";
import { captureCommands } from "../support/commands";

const config = loadConfig({ AWS_REGION: "ap-northeast-1", REMINDERS_TABLE: "reminders", OWNER_STATE_TABLE: "owners", IMAGE_JOBS_TABLE: "jobs", IMAGES_BUCKET: "images", EXPECTED_API_ID: "api123", EXPECTED_API_STAGE: "$default", COGNITO_ISSUER: "https://cognito-idp.ap-northeast-1.amazonaws.com/test", COGNITO_CLIENT_ID: "client123" });
const owner = "a".repeat(64);
const other = "b".repeat(64);
const conditional = (): Error => Object.assign(new Error("private-aws-error"), { name: "ConditionalCheckFailedException" });
const unavailable = (error: unknown): boolean => error instanceof ApiError && error.status === 503 && !error.message.includes("private");
const rawCursor = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");

void test("reads_only_consistent_owner_keys", async () => {
  const record = activeReminder();
  const { client, sent } = captureCommands([{ Item: record }, { Items: [record] }, {}]);
  const store = createRemindersStore(client, config);
  assert.deepEqual(await store.get(owner, "reminder-1", testBudget()), record);
  assert.deepEqual(await store.query(owner, 20, "%2F😀", testBudget()), { records: [record], lastId: null });
  assert.equal(await store.get(owner, "missing", testBudget()), null);
  assert.ok(sent[0] instanceof GetCommand);
  assert.deepEqual(sent[0].input, { TableName: "reminders", Key: { ownerId: owner, id: "reminder-1" }, ConsistentRead: true });
  assert.ok(sent[1] instanceof QueryCommand);
  assert.equal(sent[1].input.ConsistentRead, true);
  assert.equal(sent[1].input.Limit, 20);
  assert.equal(sent[1].input.KeyConditionExpression, "#owner = :owner");
  assert.deepEqual(sent[1].input.ExpressionAttributeNames, { "#owner": "ownerId" });
  assert.deepEqual(sent[1].input.ExpressionAttributeValues, { ":owner": owner });
  assert.deepEqual(sent[1].input.ExclusiveStartKey, { ownerId: owner, id: "%2F😀" });
  assert.ok(sent.every((command) => command instanceof GetCommand || command instanceof QueryCommand));
});

void test("empty_filtered_page_keeps_evaluated_cursor", async () => {
  const tombstone = { ownerId: owner, id: "last-deleted", deleted: true, revision: 2, deletedAt: "2026-10-03T00:00:00.000Z" };
  const { client, sent } = captureCommands([{ Items: [tombstone], LastEvaluatedKey: { ownerId: owner, id: "last-deleted" } }, { Items: [], LastEvaluatedKey: { ownerId: owner, id: "next-deleted" } }]);
  const store = createRemindersStore(client, config);
  assert.deepEqual(await store.query(owner, 1, null, testBudget()), { records: [], lastId: "last-deleted" });
  assert.deepEqual(await store.query(owner, 1, "last-deleted", testBudget()), { records: [], lastId: "next-deleted" });
  assert.equal(sent.length, 2);
});

void test("forged_cursor_cannot_select_another_owner", () => {
  assert.equal(decodeCursor(encodeCursor("owner-a", "id-last"), "owner-a"), "id-last");
  assert.deepEqual(JSON.parse(Buffer.from(encodeCursor(owner, "%2F😀"), "base64url").toString("utf8")), { version: 1, ownerId: owner, lastId: "%2F😀" });
  for (const value of [encodeCursor(other, "last"), rawCursor({ version: 1, ownerId: owner, lastId: "last", extra: "bad" }), rawCursor({ version: 2, ownerId: owner, lastId: "last" }), rawCursor({ version: 1, ownerId: owner, lastId: "" }), rawCursor({ version: 1, ownerId: owner, lastId: "x\n" }), "%%%", "e30=", "e31", "a".repeat(2049), Buffer.from([0xff]).toString("base64url"), rawCursor(null)]) {
    assert.throws(() => decodeCursor(value, owner), (error: unknown) => error instanceof ApiError && error.status === 422);
  }
});

void test("limit_defaults_bounds_and_rejects_invalid_without_sdk_calls", async () => {
  assert.equal(parseLimit(undefined), 20);
  assert.equal(parseLimit("50"), 50);
  const { client, sent } = captureCommands([{ Items: [] }]);
  const store = createRemindersStore(client, config);
  await store.query(owner, parseLimit("50"), null, testBudget());
  assert.ok(sent[0] instanceof QueryCommand);
  assert.equal(sent[0].input.Limit, 50);
  for (const value of ["", "0", "51", "1.5", "1e1", " 2", "2 ", "2\n", "-1", null, [], Infinity, NaN]) assert.throws(() => parseLimit(value), (error: unknown) => error instanceof ApiError && error.status === 422);
  await assert.rejects(store.query(owner, 51, null, testBudget()), { status: 422 });
  assert.equal(sent.length, 1);
});

void test("corrupt_and_cross_owner_database_records_fail_closed", async () => {
  for (const record of [activeReminder({ ownerId: other }), activeReminder({ revision: 0 }), activeReminder({ migrationRunId: undefined } as never), activeReminder({ thumbnail: "private-base64" } as never), activeReminder({ title: undefined } as never), activeReminder({ reminderTime: "2026-02-30T00:00:00.000Z" }), { ownerId: owner, id: "reminder-1", deleted: true, revision: 1 }]) {
    const { client } = captureCommands([{ Item: record }, { Items: [record] }]);
    const store = createRemindersStore(client, config);
    await assert.rejects(store.get(owner, "reminder-1", testBudget()), unavailable);
    await assert.rejects(store.query(owner, 20, null, testBudget()), unavailable);
  }
  for (const response of [{ Item: activeReminder({ id: "wrong" }) }, { Item: null }]) await assert.rejects(createRemindersStore(captureCommands([response]).client, config).get(owner, "reminder-1", testBudget()), unavailable);
  for (const response of [{ Items: "bad" }, { Items: [], LastEvaluatedKey: { ownerId: other, id: "last" } }, { Items: [], LastEvaluatedKey: { ownerId: owner, id: "last", extra: "bad" } }]) await assert.rejects(createRemindersStore(captureCommands([response]).client, config).query(owner, 20, null, testBudget()), unavailable);
});

void test("publication_gate_and_probe_are_strong_and_do_not_return_personal_data", async () => {
  const gate = { pk: "GLOBAL", sk: "PUBLICATION", published: true, runId: "run-1" };
  const { client, sent } = captureCommands([{}, { Item: gate }, {}, {}, { Item: gate }]);
  const store = createOwnerStore(client, config);
  assert.deepEqual(await store.gate(testBudget()), { published: false, runId: null });
  assert.deepEqual(await store.gate(testBudget()), { published: true, runId: "run-1" });
  assert.equal(await store.probe(testBudget()), undefined);
  assert.deepEqual(sent.slice(2).map((command) => (command as GetCommand).input.TableName).sort(), ["jobs", "owners", "reminders"]);
  for (const command of sent) { assert.ok(command instanceof GetCommand); assert.equal(command.input.ConsistentRead, true); }
  for (const record of [{ ...gate, published: "true" }, { ...gate, runId: 1 }, { ...gate, pk: "OTHER" }, { published: false }, null]) await assert.rejects(createOwnerStore(captureCommands([{ Item: record }]).client, config).gate(testBudget()), unavailable);
});

void test("rate_has_fixed_utc_window_and_fail_closed", async () => {
  const { client, sent } = captureCommands([...Array.from({ length: 120 }, () => ({})), conditional(), {}, {}]);
  const store = createOwnerStore(client, config);
  for (let i = 0; i < 120; i++) await checkRate(store, owner, 59_001, testBudget());
  await assert.rejects(checkRate(store, owner, 59_001, testBudget()), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 429); assert.equal(error.code, "OWNER_RATE_LIMIT_EXCEEDED"); assert.equal(error.retryAfterSeconds, 1);
    const response = errorResponse(error, "request");
    assert.equal(response.headers?.["Retry-After"], "1");
    assert.deepEqual(JSON.parse(response.body ?? ""), { code: "OWNER_RATE_LIMIT_EXCEEDED", message: "Rate limit exceeded", requestId: "request", retryAfterSeconds: 1 });
    return true;
  });
  await checkRate(store, owner, 60_000, testBudget());
  await checkRate(store, other, 60_000, testBudget());
  assert.ok(sent[0] instanceof UpdateCommand);
  assert.deepEqual(sent[0].input.Key, { pk: `OWNER#${owner}`, sk: "RATE#0" });
  assert.deepEqual(sent[0].input.ExpressionAttributeValues, { ":zero": 0, ":one": 1, ":limit": 120, ":expires": 172800 });
  assert.equal(sent[0].input.ConditionExpression, "attribute_not_exists(#count) OR #count < :limit");
  assert.equal(sent[0].input.UpdateExpression, "SET #count = if_not_exists(#count, :zero) + :one, #expires = :expires");
  assert.deepEqual(sent[0].input.ExpressionAttributeNames, { "#count": "count", "#expires": "expiresAt" });
  assert.deepEqual((sent[121] as UpdateCommand).input.Key, { pk: `OWNER#${owner}`, sk: "RATE#1" });
  assert.equal((sent[121] as UpdateCommand).input.ExpressionAttributeValues?.[":expires"], 172860);
  assert.notDeepEqual((sent[122] as UpdateCommand).input.Key, (sent[121] as UpdateCommand).input.Key);
  for (const now of [0, 60_000, 119_999]) {
    await assert.rejects(checkRate(createOwnerStore(captureCommands([conditional()]).client, config), owner, now, testBudget()), (error: unknown) => error instanceof ApiError && error.retryAfterSeconds === (now === 119_999 ? 1 : 60));
  }
  const failed = captureCommands([new Error("private-aws-error"), {}]);
  await assert.rejects(checkRate(createOwnerStore(failed.client, config), owner, 0, testBudget()), unavailable);
  assert.equal(failed.sent.length, 1, "unknown outcome must never increment again");
});

void test("same_owner_different_tokens_use_same_rate_key", async () => {
  const { client, sent } = captureCommands([{}, {}]);
  const store = createOwnerStore(client, config);
  const id = ownerIdFor("issuer", "subject");
  // Tokens/client claims never enter the adapter: the authenticated issuer/sub owner does.
  await checkRate(store, id, 10_000, testBudget());
  await checkRate(store, ownerIdFor("issuer", "subject"), 59_000, testBudget());
  assert.deepEqual((sent[0] as UpdateCommand).input.Key, (sent[1] as UpdateCommand).input.Key);
});

void test("reads_probes_and_rate_obey_budget_and_sanitize_sdk_failures", async () => {
  const { client, sent } = captureCommands([]);
  const budget = { signal: new AbortController().signal, remainingMs: () => 0 };
  const reads = createRemindersStore(client, config); const owners = createOwnerStore(client, config);
  for (const call of [() => reads.get(owner, "reminder-1", budget), () => reads.query(owner, 20, null, budget), () => owners.gate(budget), () => owners.probe(budget), () => checkRate(owners, owner, 0, budget)]) await assert.rejects(call(), unavailable);
  assert.equal(sent.length, 0);
  for (const call of ["get", "query", "gate", "probe"] as const) {
    const fake = captureCommands([new Error("private-sdk-detail"), new Error("private-sdk-detail"), new Error("private-sdk-detail")]);
    const reminders = createRemindersStore(fake.client, config); const states = createOwnerStore(fake.client, config);
    const result = call === "get" ? reminders.get(owner, "reminder-1", testBudget()) : call === "query" ? reminders.query(owner, 20, null, testBudget()) : call === "gate" ? states.gate(testBudget()) : states.probe(testBudget());
    await assert.rejects(result, unavailable);
    assert.ok(fake.sent.length <= 3);
  }
});

void test("sdk_clients_reuse_environment_and_disable_implicit_retries", async () => {
  const clients = createAwsClients(config);
  assert.equal(createAwsClients({ ...config }), clients);
  assert.notEqual(createAwsClients({ ...config, region: "us-east-1" }), clients);
  assert.equal(await clients.dynamo.config.maxAttempts(), 1);
  assert.equal(await clients.s3.config.maxAttempts(), 1);
  assert.equal(await clients.cloudWatch.config.maxAttempts(), 1);
});

void test("every_sdk_send_carries_abort_signal_and_probe_rechecks_budget", async () => {
  const budget = testBudget();
  const optionsSeen: unknown[] = [];
  let remaining = 10_000;
  const client = { async send(command: unknown, options: unknown): Promise<unknown> {
    optionsSeen.push(options);
    if (command instanceof GetCommand && command.input.TableName === "reminders" && command.input.Key?.ownerId === "__PROBE__") remaining = 0;
    return command instanceof QueryCommand ? { Items: [] } : {};
  } } as unknown as DynamoDBDocumentClient;
  const reminders = createRemindersStore(client, config); const states = createOwnerStore(client, config);
  await reminders.get(owner, "missing", budget);
  await reminders.query(owner, 20, null, budget);
  await states.gate(budget);
  await checkRate(states, owner, 0, budget);
  await assert.rejects(states.probe({ ...budget, remainingMs: () => remaining }), unavailable);
  assert.equal(optionsSeen.length, 5);
  for (const options of optionsSeen) assert.deepEqual(options, { abortSignal: budget.signal });
});

void test("get_preserves_tombstones_and_writes_are_explicitly_unimplemented", async () => {
  const tombstone = { ownerId: owner, id: "deleted", revision: 2, deleted: true, deletedAt: "2026-10-03T00:00:00.000Z", migrationRunId: "run-1" };
  const { client, sent } = captureCommands([{ Item: tombstone }]);
  const store = createRemindersStore(client, config);
  assert.deepEqual(await store.get(owner, "deleted", testBudget()), tombstone);
  await assert.rejects(store.commit({ ownerId: owner, previous: null, next: activeReminder(), itemDelta: 1, byteDelta: 0, jobs: [], clientRequestToken: "token" }, testBudget()), /Reminder writes are not implemented/);
  assert.equal(sent.length, 1);
});

void test("image_references_are_owner_scoped_and_reject_trailing_line_breaks", async () => {
  const imageId = "00000000-0000-4000-8000-000000000001";
  const ref = { imageId, key: `images/${owner}/${imageId}`, versionId: "version-1", mime: "image/png", bytes: 8, sha256: "a".repeat(64) };
  const good = activeReminder({ thumbnail: ref });
  assert.deepEqual(await createRemindersStore(captureCommands([{ Item: good }]).client, config).get(owner, "reminder-1", testBudget()), good);
  for (const thumbnail of [{ ...ref, key: `images/${other}/${imageId}` }, { ...ref, sha256: "a".repeat(64) + "\n" }, { ...ref, imageId: imageId + "\n", key: `images/${owner}/${imageId}\n` }, { ...ref, bytes: 1_048_577 }]) {
    await assert.rejects(createRemindersStore(captureCommands([{ Item: activeReminder({ thumbnail }) }]).client, config).get(owner, "reminder-1", testBudget()), unavailable);
  }
});
