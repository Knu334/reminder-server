import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import type { Context, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { createApiHandler, type ApiDeps } from "../../src/api";
import { ApiError } from "../../src/shared/errors";
import { createHarness, harnessConfig } from "../support/stateful-store";
import { activeReminder, gatewayEvent, syntheticPngBase64, validCreate } from "../support/fixtures";

const context = (remaining = 10_000): Context => ({ awsRequestId: "lambda-synthetic", getRemainingTimeInMillis: () => remaining }) as Context;
const json = (response: APIGatewayProxyStructuredResultV2): Record<string, unknown> => JSON.parse(response.body ?? "") as Record<string, unknown>;
function event(method: string, path: string, overrides: Record<string, unknown> = {}): unknown {
  const base = gatewayEvent() as { requestContext: Record<string, unknown> };
  const routeKey = `${method} ${path}`;
  return gatewayEvent({ routeKey, rawPath: path.replace("{id}", "reminder-1"), requestContext: { ...base.requestContext, routeKey, http: { method, path, sourceIp: "192.0.2.1" } }, ...overrides });
}
function setup(overrides: Partial<ApiDeps> = {}, config = harnessConfig) {
  const h = createHarness(config); h.setPublication(true);
  let nowMs = Date.parse("2026-10-03T00:00:00.000Z");
  const api = createApiHandler({ config, service: h.service, owners: h.owners, images: h.images, clock: () => nowMs, ...overrides });
  return { h, api, advance(ms: number) { nowMs += ms; h.advanceMs(ms); }, call(method: string, path: string, overrides: Record<string, unknown> = {}, ctx = context()) { return api(event(method, path, overrides), ctx); } };
}
const item = { pathParameters: { id: "reminder-1" } };

void test("v2_crud_returns_contract_and_etags", async () => {
  const s = setup();
  const empty = await s.call("GET", "/v2/reminders"); assert.equal(empty.statusCode, 200); assert.deepEqual(json(empty), { items: [], nextCursor: null });
  const created = await s.call("POST", "/v2/reminders", { body: JSON.stringify(validCreate()) });
  assert.equal(created.statusCode, 201); assert.equal(created.headers?.Location, "/v2/reminders/reminder-1"); assert.ok(created.headers?.ETag);
  assert.deepEqual(json(created), { id: "reminder-1", url: "https://example.test/reminder", title: "Test reminder", reminderTime: "2026-10-03T00:00:00.000Z", autoOpen: false, webPush: true, hidden: false, revision: 1, createdAt: "2026-10-03T00:00:00.000Z", updatedAt: "2026-10-03T00:00:00.000Z", thumbnail: null });
  const fetched = await s.call("GET", "/v2/reminders/{id}", item); assert.equal(fetched.body, created.body); assert.equal(fetched.headers?.ETag, created.headers?.ETag);
  assert.equal(fetched.headers?.["Cache-Control"], "private, no-store, no-transform");
  assert.equal((await s.call("POST", "/v2/reminders", { body: JSON.stringify(validCreate()) })).statusCode, 409);
  const missingIfMatch = await s.call("PATCH", "/v2/reminders/{id}", { ...item, body: '{"title":"changed"}' }); assert.equal(missingIfMatch.statusCode, 428);
  assert.equal((await s.call("DELETE", "/v2/reminders/{id}", item)).statusCode, 428);
  const patched = await s.call("PATCH", "/v2/reminders/{id}", { ...item, headers: { "content-type": "application/json", "if-match": created.headers?.ETag }, body: '{"title":"changed"}' });
  assert.equal(patched.statusCode, 200); assert.equal(json(patched).revision, 2); assert.equal(json(patched).title, "changed"); assert.notEqual(patched.headers?.ETag, created.headers?.ETag);
  assert.equal((await s.call("GET", "/v2/reminders/{id}", item)).body, patched.body);
  const staleUpdate = await s.call("PATCH", "/v2/reminders/{id}", { ...item, headers: { "content-type": "application/json", "if-match": created.headers?.ETag }, body: '{"title":"stale"}' }); assert.equal(staleUpdate.statusCode, 412);
  const removed = await s.call("DELETE", "/v2/reminders/{id}", { ...item, headers: { "if-match": patched.headers?.ETag } });
  assert.equal(removed.statusCode, 200); assert.deepEqual(json(removed), { id: "reminder-1", deleted: true, revision: 3 }); assert.equal(removed.headers?.ETag, undefined);
  const absent = await s.call("GET", "/v2/reminders/{id}", item); assert.equal(absent.statusCode, 404); assert.equal(json(absent).code, "REMINDER_NOT_FOUND");
  assert.equal((await s.call("POST", "/v2/reminders", { body: JSON.stringify(validCreate()) })).statusCode, 409);
  assert.equal(s.h.snapshot().storage[0]?.itemCount, 0);
});

void test("query_limit_cursor_and_empty_evaluated_page", async () => {
  const s = setup();
  const a = await s.call("POST", "/v2/reminders", { body: JSON.stringify(validCreate({ id: "a" })) });
  await s.call("POST", "/v2/reminders", { body: JSON.stringify(validCreate({ id: "b" })) });
  await s.call("DELETE", "/v2/reminders/{id}", { pathParameters: { id: "a" }, headers: { "if-match": a.headers?.ETag } });
  const first = json(await s.call("GET", "/v2/reminders", { queryStringParameters: { limit: "1" } })); assert.deepEqual(first.items, []); assert.equal(typeof first.nextCursor, "string");
  const next = json(await s.call("GET", "/v2/reminders", { queryStringParameters: { limit: "1", cursor: first.nextCursor } })); assert.deepEqual((next.items as Array<{ id: string }>).map(x => x.id), ["b"]); assert.equal(next.nextCursor, null);
  for (const query of [{ limit: "51" }, { limit: "0" }, { cursor: "forged" }, { cursor: "" }]) assert.equal((await s.call("GET", "/v2/reminders", { queryStringParameters: query })).statusCode, 422);
});

void test("owner_rate_precedes_storage", async () => {
  const s = setup(); s.advance(59_999);
  for (let i = 0; i < 120; i++) assert.equal((await s.call("POST", "/v2/reminders", { body: "{" })).statusCode, 400);
  const rateExceeded = await s.call("POST", "/v2/reminders", { body: JSON.stringify(validCreate()) });
  assert.equal(rateExceeded.statusCode, 429); assert.equal(rateExceeded.headers?.["Retry-After"], "1"); assert.equal(json(rateExceeded).code, "OWNER_RATE_LIMIT_EXCEEDED"); assert.equal(json(rateExceeded).retryAfterSeconds, 1);
  assert.deepEqual(s.h.snapshot().reminders, []); assert.deepEqual(s.h.snapshot().storage, []);
  s.advance(1); assert.equal((await s.call("POST", "/v2/reminders", { body: JSON.stringify(validCreate()) })).statusCode, 201);
  assert.deepEqual(s.h.snapshot().rates.map(r => r.count), [120, 1]);
});

void test("auth_then_rate_then_publication_then_body_and_service", async () => {
  const h = createHarness(); h.setPublication(false);
  const calls: string[] = [];
  const owners = { ...h.owners, async consumeRate(...args: Parameters<typeof h.owners.consumeRate>) { calls.push("rate"); return h.owners.consumeRate(...args); }, async gate(...args: Parameters<typeof h.owners.gate>) { calls.push("gate"); return h.owners.gate(...args); } };
  const s = setup({ service: h.service, owners, images: h.images });
  const base = event("POST", "/v2/reminders") as { requestContext: Record<string, unknown> };
  const unauthenticated = await s.call("POST", "/v2/reminders", { body: "x".repeat(2_097_153), requestContext: { ...base.requestContext, authorizer: {} } });
  assert.equal(unauthenticated.statusCode, 401); assert.deepEqual(calls, []);
  const unpublished = await s.call("POST", "/v2/reminders", { body: "{" }); assert.equal(unpublished.statusCode, 503); assert.deepEqual(calls, ["rate", "gate"]); assert.deepEqual(h.snapshot().reminders, []);
  const failing = setup({ owners: { ...h.owners, async consumeRate() { throw new Error("private-rate-secret"); } } });
  const failed = await failing.call("POST", "/v2/reminders", { body: JSON.stringify(validCreate()) }); assert.equal(failed.statusCode, 503); assert.equal(json(failed).code, "SERVICE_UNAVAILABLE"); assert.equal(failed.body?.includes("private"), false); assert.deepEqual(failing.h.snapshot().storage, []);
});

void test("image_url_is_separate_and_no_store", async () => {
  const s = setup();
  const created = await s.call("POST", "/v2/reminders", { body: JSON.stringify(validCreate({ thumbnail: syntheticPngBase64 })) }); assert.equal(created.statusCode, 201);
  const dto = json(created); assert.equal(created.body?.includes(syntheticPngBase64), false); assert.deepEqual(Object.keys(dto.thumbnail as object).sort(), ["bytes", "imageId", "mime", "sha256"]);
  const urlResponse = await s.call("GET", "/v2/reminders/{id}/thumbnail-url", item); assert.equal(urlResponse.statusCode, 200); assert.equal(urlResponse.headers?.["Cache-Control"], "no-store"); assert.equal(urlResponse.headers?.ETag, undefined);
  assert.deepEqual(Object.keys(json(urlResponse)).sort(), ["expiresAt", "imageId", "revision", "url"]); assert.equal(json(urlResponse).expiresAt, "2026-10-03T00:15:00.000Z");
  assert.equal((await s.call("GET", "/v2/reminders/{id}", item)).headers?.ETag, created.headers?.ETag);
  await s.call("POST", "/v2/reminders", { body: JSON.stringify(validCreate({ id: "no-image" })) });
  const absent = await s.call("GET", "/v2/reminders/{id}/thumbnail-url", { pathParameters: { id: "no-image" } }); assert.equal(absent.statusCode, 404); assert.equal(json(absent).code, "THUMBNAIL_NOT_FOUND");
});

void test("health_ready_and_unpublished_behavior", async () => {
  const s = setup(); s.h.setPublication(false);
  assert.equal((await s.call("GET", "/healthz")).statusCode, 200);
  const unpublishedReady = await s.call("GET", "/readyz"); assert.equal(unpublishedReady.statusCode, 503); assert.equal(json(unpublishedReady).code, "SERVICE_UNAVAILABLE");
  assert.equal((await s.call("GET", "/v2/reminders")).statusCode, 503);
  s.h.setPublication(true); assert.deepEqual(json(await s.call("GET", "/readyz")), { ready: true });
  s.h.injectFault("get", "before"); assert.equal((await s.call("GET", "/healthz")).statusCode, 200); assert.equal((await s.call("GET", "/readyz")).statusCode, 503);
  const bucketFailure = setup({ images: { ...s.h.images, async probe() { throw new Error("private-bucket"); } } }); assert.equal((await bucketFailure.call("GET", "/readyz")).statusCode, 503);
  const base = event("GET", "/healthz") as { requestContext: Record<string, unknown> };
  const invalid = await s.call("GET", "/healthz", { requestContext: { ...base.requestContext, apiId: "wrong" } }); assert.equal(invalid.statusCode, 400);
});

void test("lazy_production_import_and_config_failure_without_environment_or_aws_access", () => {
  const script = `let configReads=0; process.env=new Proxy({}, {get(_target,key){if(key==='AWS_REGION'){configReads++;throw Error('forbidden environment read');} return undefined;}}); require('./src/cleanup'); const {handler}=require('./src/api'); if(configReads!==0)process.exit(2); const e=${JSON.stringify(event("GET", "/healthz"))}; const ctx={awsRequestId:'synthetic',getRemainingTimeInMillis:()=>10000}; (async()=>{ const health=await handler(e,ctx); e.routeKey='GET /readyz'; e.rawPath='/readyz'; e.requestContext.routeKey=e.routeKey; e.requestContext.http.path='/readyz'; const ready=await handler(e,ctx); e.routeKey='GET /v2/reminders'; e.rawPath='/v2/reminders'; e.requestContext.routeKey=e.routeKey; e.requestContext.http.path='/v2/reminders'; const v2=await handler(e,ctx); console.log(JSON.stringify({health,ready,v2})); })().catch(()=>process.exit(1));`;
  const result = spawnSync(process.execPath, ["--import", "tsx", "-e", script], { cwd: process.cwd(), env: {}, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr); const value = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "") as { health: APIGatewayProxyStructuredResultV2; ready: APIGatewayProxyStructuredResultV2; v2: APIGatewayProxyStructuredResultV2 };
  assert.equal(value.health.statusCode, 200); assert.equal(value.ready.statusCode, 503); assert.equal(json(value.ready).code, "SERVICE_UNAVAILABLE"); assert.equal(value.ready.body?.includes("forbidden"), false); assert.equal(value.v2.statusCode, 503); assert.equal(json(value.v2).code, "SERVICE_UNAVAILABLE");
});

void test("legacy_api_is_gone", async () => {
  const s = setup(); s.h.setPublication(false);
  for (const method of ["POST", "PUT"]) {
    const base = event(method, "/reminders") as { requestContext: Record<string, unknown> };
    const legacy = await s.call(method, "/reminders", { body: "x".repeat(2_097_153), requestContext: { ...base.requestContext, authorizer: {} } });
    assert.equal(legacy.statusCode, 410); assert.equal(json(legacy).code, "LEGACY_API_REMOVED"); assert.equal(json(legacy).replacement, "/v2/reminders");
  }
  assert.deepEqual(s.h.snapshot(), { reminders: [], storage: [], rates: [], jobs: [], transactions: [] });
});

void test("encoded_id_is_not_double_decoded", async () => {
  const s = setup();
  for (const id of ["%2F", "%25", "雪😀", "/"]) {
    const created = await s.call("POST", "/v2/reminders", { body: JSON.stringify(validCreate({ id })) }); assert.equal(created.statusCode, 201); assert.equal(created.headers?.Location, `/v2/reminders/${encodeURIComponent(id)}`);
    const fetched = await s.call("GET", "/v2/reminders/{id}", { pathParameters: { id } }); assert.equal(fetched.statusCode, 200); assert.equal(json(fetched).id, id);
  }
  assert.equal(s.h.snapshot().reminders.length, 4);
});

void test("untrusted_origin_is_not_authentication", async () => {
  const s = setup(); const base = event("GET", "/v2/reminders") as { requestContext: Record<string, unknown> };
  for (const origin of ["https://allowed.example.test", "https://untrusted.example.test"]) {
    const rejected = await s.call("GET", "/v2/reminders", { headers: { origin }, requestContext: { ...base.requestContext, authorizer: {} } }); assert.equal(rejected.statusCode, 401);
    const accepted = await s.call("GET", "/v2/reminders", { headers: { origin } }); assert.equal(accepted.statusCode, 200); assert.ok(!Object.keys(accepted.headers ?? {}).some(k => k.toLowerCase().startsWith("access-control-")));
  }
  assert.equal(s.h.snapshot().rates[0]?.count, 2);
});

void test("unknown_routes_and_disallowed_methods", async () => {
  const s = setup();
  assert.equal((await s.call("GET", "/missing")).statusCode, 404);
  for (const [method, path, allow] of [["PUT", "/v2/reminders", "GET, POST"], ["POST", "/v2/reminders/{id}", "GET, PATCH, DELETE"], ["DELETE", "/healthz", "GET"]]) {
    const response = await s.call(method!, path!, item); assert.equal(response.statusCode, 405); assert.equal(response.headers?.Allow, allow);
  }
  const base = event("PUT", "/v2/reminders") as { requestContext: Record<string, unknown> };
  const defaultMethod = await s.call("PUT", "/v2/reminders", { routeKey: "$default", requestContext: { ...base.requestContext, routeKey: "$default" } }); assert.equal(defaultMethod.statusCode, 405);
  const defaultMissing = await s.call("GET", "/missing", { routeKey: "$default", requestContext: { ...(event("GET", "/missing") as { requestContext: object }).requestContext, routeKey: "$default" } }); assert.equal(defaultMissing.statusCode, 404);
});

void test("public_error_codes_for_payload_thumbnail_storage_and_deadline", async () => {
  const s = setup(); const tooLarge = '{"title":"' + "あ".repeat(699_051) + '"}';
  for (const isBase64Encoded of [false, true]) {
    const result = await s.call("POST", "/v2/reminders", { body: isBase64Encoded ? Buffer.from(tooLarge).toString("base64") : tooLarge, isBase64Encoded }); assert.equal(result.statusCode, 413); assert.equal(json(result).code, "PAYLOAD_TOO_LARGE");
  }
  const deadline = await s.call("POST", "/v2/reminders", { body: JSON.stringify(validCreate()) }, context(1000)); assert.equal(deadline.statusCode, 503); assert.equal(json(deadline).code, "SERVICE_UNAVAILABLE"); assert.equal(s.h.snapshot().reminders.length, 0);
  const smallImage = setup({}, { ...harnessConfig, limits: { ...harnessConfig.limits, thumbnailBytes: 11 } });
  const thumbnail = await smallImage.call("POST", "/v2/reminders", { body: JSON.stringify(validCreate({ thumbnail: syntheticPngBase64 })) }); assert.equal(thumbnail.statusCode, 413); assert.equal(json(thumbnail).code, "THUMBNAIL_TOO_LARGE"); assert.deepEqual(smallImage.h.snapshot().jobs, []);
  const capacity = setup({}, { ...harnessConfig, limits: { ...harnessConfig.limits, itemCount: 1 } });
  assert.equal((await capacity.call("POST", "/v2/reminders", { body: JSON.stringify(validCreate()) })).statusCode, 201);
  const storage = await capacity.call("POST", "/v2/reminders", { body: JSON.stringify(validCreate({ id: "second" })) }); assert.equal(storage.statusCode, 413); assert.equal(json(storage).code, "OWNER_STORAGE_LIMIT_EXCEEDED");
});

void test("existing_large_image_metadata_is_readable_after_limit_reduction", async () => {
  const s = setup({}, { ...harnessConfig, limits: { ...harnessConfig.limits, thumbnailBytes: 11 } });
  const created = await s.call("POST", "/v2/reminders", { body: JSON.stringify(validCreate()) }); assert.equal(created.statusCode, 201);
  const stored = s.h.snapshot().reminders[0]!;
  const record = activeReminder({ ownerId: String(stored.ownerId), id: "large", thumbnail: { imageId: "00000000-0000-4000-8000-000000000777", key: `images/${String(stored.ownerId)}/00000000-0000-4000-8000-000000000777`, versionId: "v1", mime: "image/png", bytes: 2_097_152, sha256: "a".repeat(64) } });
  await s.h.reminders.commit({ ownerId: record.ownerId, previous: null, next: record, itemDelta: 1, byteDelta: 2_097_152, jobs: [], clientRequestToken: "00000000-0000-4000-8000-000000000778" }, { signal: new AbortController().signal, remainingMs: () => 10_000 });
  const response = await s.call("GET", "/v2/reminders/{id}", { pathParameters: { id: "large" } }); assert.equal(response.statusCode, 200); assert.equal((json(response).thumbnail as { bytes: number }).bytes, 2_097_152);
});

void test("deadline_waits_for_abort_settlement_and_sanitizes_503", async () => {
  const h = createHarness(); let settled = false;
  const s = setup({ owners: { ...h.owners, async consumeRate(_owner, _minute, budget) { try { await delay(10_000, undefined, { signal: budget.signal }); } finally { await delay(5); settled = true; } return true; } } });
  const result = await s.call("POST", "/v2/reminders", { body: JSON.stringify(validCreate()) }, context(1050));
  assert.equal(result.statusCode, 503); assert.equal(json(result).code, "SERVICE_UNAVAILABLE"); assert.equal(settled, true); assert.deepEqual(s.h.snapshot().reminders, []);
  const failed = setup({ service: { ...h.service, async list() { throw new ApiError(503, "DEADLINE_EXCEEDED", "private-sdk-details"); } } });
  const response = await failed.call("GET", "/v2/reminders"); assert.equal(json(response).code, "SERVICE_UNAVAILABLE"); assert.equal(response.body?.includes("private"), false);
});

void test("authentication_precedes_exhausted_deadline_and_source_scope_rejections_do_not_count", async () => {
  const s = setup(); const base = event("GET", "/v2/reminders") as { requestContext: Record<string, unknown> };
  const rejected = await s.call("GET", "/v2/reminders", { requestContext: { ...base.requestContext, authorizer: {} } }, context(1000));
  assert.equal(rejected.statusCode, 401); assert.deepEqual(s.h.snapshot().rates, []);
  const authorizer = base.requestContext.authorizer as { jwt: { claims: Record<string, unknown>; scopes: string[] } };
  const wrongScope = await s.call("GET", "/v2/reminders", { requestContext: { ...base.requestContext, authorizer: { jwt: { ...authorizer.jwt, scopes: ["reminder-api/write"] } } } });
  assert.equal(wrongScope.statusCode, 401); assert.deepEqual(s.h.snapshot().rates, []);
  const restricted = setup({}, { ...harnessConfig, sourceIps: ["192.0.2.2"] });
  const source = await restricted.call("GET", "/v2/reminders"); assert.equal(source.statusCode, 403); assert.equal(json(source).code, "SOURCE_IP_FORBIDDEN"); assert.deepEqual(restricted.h.snapshot().rates, []);
});

void test("semantic_id_validation_follows_auth_rate_and_publication", async () => {
  const s = setup(); const base = event("GET", "/v2/reminders/{id}") as { requestContext: Record<string, unknown> };
  for (const id of ["", "a\n", "😀".repeat(129)]) {
    const rejected = await s.call("GET", "/v2/reminders/{id}", { pathParameters: { id }, requestContext: { ...base.requestContext, authorizer: {} } }); assert.equal(rejected.statusCode, 401);
    const invalid = await s.call("GET", "/v2/reminders/{id}", { pathParameters: { id } }); assert.equal(invalid.statusCode, 422); assert.equal(json(invalid).code, "INVALID_INPUT");
  }
  assert.equal(s.h.snapshot().rates[0]?.count, 3);
  s.h.setPublication(false);
  const unpublished = await s.call("GET", "/v2/reminders/{id}", { pathParameters: { id: "" } }); assert.equal(unpublished.statusCode, 503); assert.equal(s.h.snapshot().rates[0]?.count, 4);
});

void test("readiness_checks_budget_after_the_final_publication_read", async () => {
  const h = createHarness();
  const s = setup({ owners: { ...h.owners, async probe() {}, async gate() { await delay(80); return { published: true, runId: null }; } } });
  const result = await s.call("GET", "/readyz", {}, context(1050));
  assert.equal(result.statusCode, 503); assert.equal(json(result).code, "SERVICE_UNAVAILABLE");
});

void test("configured_production_health_enforces_boundary_without_client_construction", () => {
  const script = `const aws=require('./src/shared/aws'); let constructions=0; aws.createAwsClients=()=>{constructions++;throw Error('forbidden AWS initialization')}; const {handler}=require('./src/api'); const e=${JSON.stringify(event("GET", "/healthz"))}; const ctx={awsRequestId:'synthetic',getRemainingTimeInMillis:()=>10000}; (async()=>{const health=await handler(e,ctx); e.requestContext.apiId='wrong'; const wrong=await handler(e,ctx); console.log(JSON.stringify({health,wrong,constructions}));})().catch(()=>process.exit(1));`;
  const env = { AWS_REGION: "ap-northeast-1", REMINDERS_TABLE: "reminders", OWNER_STATE_TABLE: "owners", IMAGE_JOBS_TABLE: "jobs", IMAGES_BUCKET: "images", EXPECTED_API_ID: "api123", EXPECTED_API_STAGE: "$default", COGNITO_ISSUER: "https://cognito-idp.ap-northeast-1.amazonaws.com/test", COGNITO_CLIENT_ID: "client123" };
  const result = spawnSync(process.execPath, ["--import", "tsx", "-e", script], { cwd: process.cwd(), env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const value = JSON.parse(result.stdout.trim().split("\n").at(-1) ?? "") as { health: APIGatewayProxyStructuredResultV2; wrong: APIGatewayProxyStructuredResultV2; constructions: number };
  assert.equal(value.health.statusCode, 200); assert.equal(value.wrong.statusCode, 400); assert.equal(value.constructions, 0);
});

void test("configured_thumbnail_admission_can_exceed_the_default_one_mib", async () => {
  const s = setup({}, { ...harnessConfig, limits: { ...harnessConfig.limits, thumbnailBytes: 1_048_577 } });
  const bytes = Buffer.alloc(1_048_577); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  const created = await s.call("POST", "/v2/reminders", { body: JSON.stringify(validCreate({ thumbnail: bytes.toString("base64") })) });
  assert.equal(created.statusCode, 201); assert.equal((json(created).thumbnail as { bytes: number }).bytes, 1_048_577); assert.equal(s.h.snapshot().storage[0]?.imageBytes, 1_048_577);
});

for (const [name, id] of [["high", "\ud800"], ["low", "\udfff"]] as const) {
  void test(`lone_${name}_surrogate_id_is_422_without_storage_or_image_mutation`, async () => {
    const s = setup();
    const response = await s.call("POST", "/v2/reminders", { body: JSON.stringify(validCreate({ id, thumbnail: syntheticPngBase64 })) });
    const state = s.h.snapshot();
    assert.deepEqual({ status: response.statusCode, code: json(response).code, reminders: state.reminders, storage: state.storage, jobs: state.jobs, transactions: state.transactions }, { status: 422, code: "INVALID_INPUT", reminders: [], storage: [], jobs: [], transactions: [] });
    assert.equal(state.rates[0]?.count, 1);
  });
}

void test("well_formed_surrogate_pair_id_has_location_and_can_be_read", async () => {
  const s = setup(); const id = "\ud83d\ude00%2F/雪";
  const created = await s.call("POST", "/v2/reminders", { body: JSON.stringify(validCreate({ id })) });
  assert.equal(created.statusCode, 201); assert.equal(created.headers?.Location, "/v2/reminders/%F0%9F%98%80%252F%2F%E9%9B%AA");
  const fetched = await s.call("GET", "/v2/reminders/{id}", { pathParameters: { id } });
  assert.equal(fetched.statusCode, 200); assert.equal(json(fetched).id, id); assert.equal(fetched.body, created.body); assert.equal(s.h.snapshot().storage[0]?.itemCount, 1);
});

void test("finite ANY fallback returns Allow without reaching storage even with forged supported method", async () => {
  const s=setup();
  for(const [method,path,status] of [["PUT","/v2/reminders",405],["POST","/v2/reminders",404],["DELETE","/healthz",405]] as const) {
    const routeKey=`ANY ${path}`;
    const base=event(method!,path!) as {requestContext:Record<string,unknown>};
    const response=await s.call(method!,path!,{routeKey,requestContext:{...base.requestContext,routeKey,authorizer:{}},body:JSON.stringify(validCreate())});
    assert.equal(response.statusCode,status);
    if(status===405)assert.ok(response.headers?.Allow);
  }
  assert.equal(s.h.snapshot().transactions.length,0);
  assert.equal(s.h.snapshot().rates.length,0);
});
