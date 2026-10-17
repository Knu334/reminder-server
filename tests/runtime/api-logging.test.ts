import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test, type TestContext } from "node:test";
import type { Context, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import * as apiModule from "../../src/api";
import { withApiResultLogging as wrap, type ApiDeps } from "../../src/api";
import { gatewayEvent, syntheticPngBase64, validCreate } from "../support/fixtures";
import { createHarness, harnessConfig } from "../support/stateful-store";

const context = (id = "lambda-synthetic"): Context => ({ awsRequestId: id, getRemainingTimeInMillis: () => 10_000 }) as Context;
function event(method: string, path: string, overrides: Record<string, unknown> = {}): unknown {
  const base = gatewayEvent() as { requestContext: Record<string, unknown> };
  const routeKey = `${method} ${path}`;
  return gatewayEvent({ routeKey, rawPath: path.replace("{id}", "reminder-1"), requestContext: { ...base.requestContext, routeKey, http: { method, path, sourceIp: "192.0.2.1" } }, ...overrides });
}
function setup(overrides: Partial<ApiDeps> = {}) {
  const h = createHarness(); h.setPublication(true);
  const api = wrap(apiModule.createApiHandler({ config: harnessConfig, service: h.service, owners: h.owners, images: h.images, clock: Date.now, ...overrides }));
  return { h, api };
}
function capture(t: TestContext): string[] {
  const lines: string[] = [];
  t.mock.method(console, "log", (line: string) => { lines.push(line); });
  return lines;
}
function outcome(lines: string[], response: APIGatewayProxyStructuredResultV2, operation: string, code?: string): Record<string, unknown> {
  assert.equal(lines.length, 1, "one safe result log per invocation");
  const line = lines[0]!;
  assert.ok(Buffer.byteLength(line, "utf8") <= 512, "JSON is at most 512 bytes");
  const value = JSON.parse(line) as Record<string, unknown>;
  assert.equal(value.operation, operation); assert.equal(value.status, response.statusCode);
  assert.equal(value.code, code);
  assert.equal(typeof value.durationMs, "number"); assert.ok(Number.isFinite(value.durationMs) && Number(value.durationMs) >= 0);
  assert.ok(Object.keys(value).every(key => ["requestId", "lambdaRequestId", "operation", "status", "code", "durationMs"].includes(key)));
  return value;
}

void test("create logs one 201 outcome without changing the representation", async t => {
  const s = setup(); const lines = capture(t);
  const result = await s.api(event("POST", "/v2/reminders", { body: JSON.stringify(validCreate()) }), context());
  assert.equal(result.statusCode, 201); assert.equal(result.headers?.Location, "/v2/reminders/reminder-1");
  assert.equal((JSON.parse(result.body!) as { title: string }).title, "Test reminder");
  const log = outcome(lines, result, "create");
  assert.equal(log.requestId, result.headers?.["X-Request-Id"]); assert.equal(log.lambdaRequestId, "lambda-synthetic");
});

for (const method of ["PATCH", "DELETE"] as const) {
  void test(`${method} logs one 200 outcome`, async t => {
    const s = setup(); const lines = capture(t);
    const created = await s.api(event("POST", "/v2/reminders", { body: JSON.stringify(validCreate()) }), context());
    lines.length = 0;
    const result = await s.api(event(method, "/v2/reminders/{id}", { pathParameters: { id: "reminder-1" }, headers: { "content-type": "application/json", "if-match": created.headers?.ETag }, body: '{"title":"updated"}' }), context());
    assert.equal(result.statusCode, 200); outcome(lines, result, method === "PATCH" ? "patch" : "remove");
    assert.equal((JSON.parse(result.body!) as { revision: number }).revision, 2);
  });
}

for (const [method, path, operation, status, code] of [
  ["GET", "/healthz", "health", 200, undefined], ["GET", "/readyz", "ready", 200, undefined],
  ["GET", "/v2/reminders", "list", 200, undefined], ["GET", "/v2/reminders/{id}", "get", 404, "REMINDER_NOT_FOUND"],
  ["GET", "/v2/reminders/{id}/thumbnail-url", "thumbnail", 404, "REMINDER_NOT_FOUND"],
  ["POST", "/reminders", "legacy", 410, "LEGACY_API_REMOVED"], ["GET", "/missing", "unknown", 404, "ROUTE_NOT_FOUND"],
  ["PUT", "/v2/reminders", "unknown", 405, "METHOD_NOT_ALLOWED"],
  ["POST", "/v2/reminders", "create", 422, "INVALID_INPUT"],
] as const) {
  void test(`${method} ${path} records the fixed ${operation} classification and ${status}`, async t => {
    const s = setup(); const lines = capture(t);
    const result = await s.api(event(method, path, { pathParameters: { id: "reminder-1" }, body: "{}" }), context());
    assert.equal(result.statusCode, status); const log = outcome(lines, result, operation, code);
    assert.equal(log.requestId, result.headers?.["X-Request-Id"]);
    if (code !== undefined) assert.equal((JSON.parse(result.body!) as { code: string }).code, log.code);
  });
}

void test("dependency failure logs the safe HTTP code and excludes request and exception secrets", async t => {
  const canaries = ["BODY_CANARY", "TOKEN_CANARY", "OWNER_CANARY", "ITEM_CANARY", "QUERY_CANARY", "SIGNATURE_CANARY", "EXCEPTION_CANARY", syntheticPngBase64];
  const h = createHarness();
  const s = setup({ service: { ...h.service, async list() { throw new Error("EXCEPTION_CANARY"); } } });
  const lines = capture(t);
  const result = await s.api(event("GET", "/v2/reminders", { body: JSON.stringify({ title: "BODY_CANARY", thumbnail: syntheticPngBase64 }), headers: { authorization: "Bearer TOKEN_CANARY" }, pathParameters: { id: "ITEM_CANARY" }, rawQueryString: "QUERY_CANARY", queryStringParameters: { cursor: "https://example.test/?signature=SIGNATURE_CANARY" }, ownerId: "OWNER_CANARY" }), context());
  assert.equal(result.statusCode, 503); outcome(lines, result, "list", "SERVICE_UNAVAILABLE");
  for (const canary of canaries) assert.equal(lines.join("").includes(canary), false);
});

void test("malformed gateway uses the response correlation ID and fixed unknown operation", async t => {
  const s = setup(); const lines = capture(t);
  const result = await s.api(null, context());
  assert.equal(result.statusCode, 400);
  const log = outcome(lines, result, "unknown", "INVALID_GATEWAY_EVENT");
  assert.equal(log.requestId, "lambda-synthetic");
});

void test("128 ASCII character IDs fit in one bounded JSON result", async t => {
  const s = setup(); const lines = capture(t); const id = "a".repeat(128);
  const base = event("GET", "/healthz") as { requestContext: object };
  const result = await s.api(event("GET", "/healthz", { requestContext: { ...base.requestContext, requestId: id } }), context(id));
  const log = outcome(lines, result, "health"); assert.equal(log.requestId, id); assert.equal(log.lambdaRequestId, id);
});

void test("invalid IDs are omitted rather than truncated or logged", async t => {
  const s = setup(); const lines = capture(t);
  for (const id of ["a".repeat(129), "unsafe\nvalue", "Bearer private", "https://example.test/?signature=private", "雪", "", "a\r", "a\n"]) {
    lines.length = 0;
    const base = event("GET", "/healthz") as { requestContext: object };
    const result = await s.api(event("GET", "/healthz", { requestContext: { ...base.requestContext, requestId: id } }), context(id));
    assert.equal(result.statusCode, id === "" ? 400 : 200);
    const log = outcome(lines, result, "health", id === "" ? "INVALID_GATEWAY_EVENT" : undefined);
    assert.equal(log.requestId, undefined); assert.equal(log.lambdaRequestId, undefined);
  }
});

void test("unrecognized error code and success body code cannot enter logs", async t => {
  const lines = capture(t);
  for (const status of [200, 422]) {
    lines.length = 0;
    const response = { statusCode: status, headers: { "X-Request-Id": "req-safe" }, body: '{"code":"SECRET_CANARY"}' };
    const result = await wrap(async () => response)(event("POST", "/v2/reminders"), context());
    assert.strictEqual(result, response); outcome(lines, result, "create"); assert.equal(lines.join("").includes("SECRET_CANARY"), false);
  }
});

void test("logging failure preserves successful and rejected HTTP response objects", async t => {
  t.mock.method(console, "log", () => { throw new Error("LOGGER_CANARY"); });
  for (const status of [201, 503]) {
    const response = { statusCode: status, body: status === 503 ? '{"code":"SERVICE_UNAVAILABLE"}' : "{}" };
    assert.strictEqual(await wrap(async () => response)(event("POST", "/v2/reminders"), context()), response);
  }
});

void test("delegate throws are logged once and rethrown with the original identity", async t => {
  const lines = capture(t); const error = new Error("THROW_CANARY");
  await assert.rejects(wrap(async () => { throw error; })(event("POST", "/v2/reminders"), context()), value => value === error);
  outcome(lines, { statusCode: 503 }, "create", "SERVICE_UNAVAILABLE"); assert.equal(lines.join("").includes("THROW_CANARY"), false);
});

void test("production initialization failure and health each log once without configuration", () => {
  const script = `const lines=[];console.log=line=>lines.push(line);const {handler}=require('./src/api');const e=${JSON.stringify(event("GET", "/healthz"))};const ctx={awsRequestId:'lambda-production',getRemainingTimeInMillis:()=>10000};(async()=>{const health=await handler(e,ctx);e.routeKey=e.requestContext.routeKey='GET /readyz';e.rawPath='/readyz';const unavailable=await handler(e,ctx);process.stdout.write(JSON.stringify({lines,health,unavailable}));})().catch(()=>process.exit(1));`;
  const result = spawnSync(process.execPath, ["--import", "tsx", "-e", script], { cwd: process.cwd(), env: {}, encoding: "utf8" });
  assert.equal(result.status, 0, "isolated production process succeeds");
  const value = JSON.parse(result.stdout) as { lines: string[]; health: APIGatewayProxyStructuredResultV2; unavailable: APIGatewayProxyStructuredResultV2 };
  assert.equal(value.lines.length, 2); assert.equal(value.health.statusCode, 200); assert.equal(value.unavailable.statusCode, 503);
  outcome(value.lines.slice(0, 1), value.health, "health"); outcome(value.lines.slice(1), value.unavailable, "ready", "SERVICE_UNAVAILABLE");
});

void test("production cold and warm invocations each log once around lazy initialization", () => {
  const script = `const lines=[];console.log=line=>lines.push(line);const {createHarness}=require('./tests/support/stateful-store');const h=createHarness();h.setPublication(true);let clients=0;const stub=(path,values)=>{require(path);require.cache[require.resolve(path)].exports=values};stub('./src/shared/aws',{createAwsClients:()=>{clients++;return {}}});stub('./src/reminders/dynamo-store',{createRemindersStore:()=>h.reminders});const owners=require('./src/reminders/owner-store');stub('./src/reminders/owner-store',{...owners,createOwnerStore:()=>h.owners});stub('./src/images/jobs-store',{createJobsStore:()=>h.jobs});stub('./src/images/s3-store',{createImagesStore:()=>h.images});const {handler}=require('./src/api');const e=${JSON.stringify(event("GET", "/v2/reminders"))};(async()=>{const cold=await handler(e,{awsRequestId:'lambda-cold',getRemainingTimeInMillis:()=>10000});e.requestContext.requestId='req-warm';const warm=await handler(e,{awsRequestId:'lambda-warm',getRemainingTimeInMillis:()=>10000});process.stdout.write(JSON.stringify({lines,cold,warm,clients}));})().catch(()=>process.exit(1));`;
  const env = { AWS_REGION: "ap-northeast-1", REMINDERS_TABLE: "reminders", OWNER_STATE_TABLE: "owners", IMAGE_JOBS_TABLE: "jobs", IMAGES_BUCKET: "images", EXPECTED_API_ID: "api123", EXPECTED_API_STAGE: "$default", COGNITO_ISSUER: "https://cognito-idp.ap-northeast-1.amazonaws.com/test", COGNITO_CLIENT_ID: "client123" };
  const result = spawnSync(process.execPath, ["--import", "tsx", "-e", script], { cwd: process.cwd(), env, encoding: "utf8" });
  assert.equal(result.status, 0, "isolated synthetic store process succeeds");
  const value = JSON.parse(result.stdout) as { lines: string[]; cold: APIGatewayProxyStructuredResultV2; warm: APIGatewayProxyStructuredResultV2; clients: number };
  assert.equal(value.clients, 1); assert.equal(value.cold.statusCode, 200); assert.equal(value.warm.statusCode, 200); assert.equal(value.lines.length, 2);
  const cold = outcome(value.lines.slice(0, 1), value.cold, "list"); const warm = outcome(value.lines.slice(1), value.warm, "list");
  assert.equal(cold.lambdaRequestId, "lambda-cold"); assert.equal(warm.lambdaRequestId, "lambda-warm"); assert.equal(warm.requestId, "req-warm");
});

void test("thumbnail validation outcome retains the public fixed code", async t => {
  const s = setup(); const lines = capture(t);
  const result = await s.api(event("POST", "/v2/reminders", { body: JSON.stringify(validCreate({ thumbnail: "invalid-image" })) }), context());
  assert.equal(result.statusCode, 422); outcome(lines, result, "create", "INVALID_THUMBNAIL");
});
