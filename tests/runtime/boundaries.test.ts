import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { loadConfig } from "../../src/config";
import { parseGatewayEvent, parseJsonBody } from "../../src/api/event";
import { ownerIdFor, requireOwner } from "../../src/api/identity";
import { errorResponse, jsonResponse } from "../../src/api/responses";
import { createBudget, requireBudget } from "../../src/shared/budget";
import { logEvent } from "../../src/shared/logging";
import { ApiError } from "../../src/shared/errors";
import { parseIfMatch } from "../../src/reminders/representation";
import { gatewayEvent } from "../support/fixtures";

const config = loadConfig({ AWS_REGION: "ap-northeast-1", REMINDERS_TABLE: "reminders", OWNER_STATE_TABLE: "owners", IMAGE_JOBS_TABLE: "jobs", IMAGES_BUCKET: "images", EXPECTED_API_ID: "api123", EXPECTED_API_STAGE: "$default", COGNITO_ISSUER: "https://cognito-idp.ap-northeast-1.amazonaws.com/test", COGNITO_CLIENT_ID: "client123" });
function raw(): Record<string, unknown> { return gatewayEvent() as Record<string, unknown>; }
function context(): Record<string, unknown> { return raw().requestContext as Record<string, unknown>; }
function claimsEvent(overrides: Record<string, unknown>): unknown {
  const ctx = context();
  const jwt = (ctx.authorizer as { jwt: { claims: Record<string, unknown>; scopes: string[] } }).jwt;
  return gatewayEvent({ requestContext: { ...ctx, authorizer: { jwt: { ...jwt, claims: { ...jwt.claims, ...overrides } } } } });
}
function rejectsStatus(status: number, action: () => unknown): void {
  assert.throws(action, (error: unknown) => error instanceof ApiError && error.status === status);
}
function authenticate(value: unknown): string { return requireOwner(parseGatewayEvent(value, config), config, "write"); }

void test("owner_is_issuer_sub_not_client_or_email", () => {
  assert.equal(ownerIdFor("issuer-a", "sub"), createHash("sha256").update(JSON.stringify(["issuer-a", "sub"]), "utf8").digest("hex"));
  assert.notEqual(ownerIdFor("issuer-a", "sub"), ownerIdFor("issuer-b", "sub"));
  assert.notEqual(ownerIdFor("a", "bc"), ownerIdFor("ab", "c"));
  assert.equal(authenticate(claimsEvent({ email: "first@example.test", username: "first" })), authenticate(claimsEvent({ email: "other@example.test", username: "other" })));
  assert.notEqual(authenticate(claimsEvent({ sub: "subject-2" })), authenticate(gatewayEvent()));
});

void test("rejects_non_gateway_or_missing_access_claims", () => {
  for (const event of [null, [], {}, { version: "2.0" }, gatewayEvent({ version: "1.0" }), gatewayEvent({ requestContext: { ...context(), apiId: "other" } }), gatewayEvent({ requestContext: { ...context(), stage: "other" } }), gatewayEvent({ requestContext: { ...context(), authorizer: {} } })]) {
    assert.throws(() => authenticate(event), ApiError);
  }
  for (const overrides of [{ iss: "other" }, { client_id: "other" }, { token_use: "id" }, { sub: "" }, { sub: 1 }, { scope: "openid" }, { scope: undefined }, { exp: undefined }, { iat: undefined }, { exp: "1e12" }, { iat: " 1" }, { exp: Infinity }, { exp: 0 }, { iat: Math.floor(Date.now() / 1000) + 3600 }]) rejectsStatus(401, () => authenticate(claimsEvent(overrides)));
  const now = Math.floor(Date.now() / 1000);
  assert.equal(authenticate(claimsEvent({ iat: String(now - 1), exp: String(now + 3600) })), authenticate(gatewayEvent()));
  rejectsStatus(401, () => authenticate(claimsEvent({ scope: "reminder-api/read" })));
  rejectsStatus(401, () => requireOwner(parseGatewayEvent(gatewayEvent(), config), config, "read"));
});

void test("uses_only_gateway_source_ip_and_exact_scopes", () => {
  const restricted = { ...config, sourceIps: ["192.0.2.1"] };
  assert.ok(requireOwner(parseGatewayEvent(gatewayEvent(), restricted), restricted, "write"));
  const value = gatewayEvent({ headers: { "x-forwarded-for": "192.0.2.1" }, requestContext: { ...context(), http: { method: "POST", sourceIp: "192.0.2.2" } } });
  rejectsStatus(403, () => requireOwner(parseGatewayEvent(value, restricted), restricted, "write"));
  assert.ok(authenticate(value));
  rejectsStatus(401, () => authenticate(claimsEvent({ scope: "reminder-api/write-extra" })));
});

void test("normalizes_headers_and_preserves_path_parameter_identity", () => {
  const request = parseGatewayEvent(gatewayEvent({ pathParameters: { id: "%252F😀" }, headers: { "If-Match": '"first"', "if-match": '"second"', "Content-Type": "application/json" }, queryStringParameters: { limit: "2" } }), config);
  assert.equal(request.pathParameters.id, "%252F😀");
  assert.equal(request.headers["content-type"], "application/json");
  assert.equal(request.query.limit, "2");
  rejectsStatus(422, () => parseIfMatch(request.headers["if-match"]));
  for (const id of ["", "a\n", "😀".repeat(129), 123]) rejectsStatus(422, () => parseGatewayEvent(gatewayEvent({ pathParameters: { id } }), config));
});

void test("checks_bytes_before_json_parse", () => {
  const prefix = '{"title":"'; const suffix = '"}';
  const exact = prefix + "あ".repeat(699_046) + "a".repeat(2) + suffix;
  assert.equal(Buffer.byteLength(exact), 2_097_152);
  for (const isBase64Encoded of [false, true]) {
    const body = isBase64Encoded ? Buffer.from(exact).toString("base64") : exact;
    assert.equal((parseJsonBody(parseGatewayEvent(gatewayEvent({ body, isBase64Encoded }), config), config) as { title: string }).title.length, 699_048);
    const over = exact + " ";
    rejectsStatus(413, () => parseJsonBody(parseGatewayEvent(gatewayEvent({ body: isBase64Encoded ? Buffer.from(over).toString("base64") : over, isBase64Encoded, headers: { "content-type": "text/plain" } }), config), config));
  }
  rejectsStatus(413, () => parseJsonBody(parseGatewayEvent(gatewayEvent({ body: "{au".repeat(700_000) }), config), config));
  const unauthorized = claimsEvent({ token_use: "id" }) as Record<string, unknown>;
  rejectsStatus(401, () => parseJsonBody(parseGatewayEvent({ ...unauthorized, body: "x".repeat(2_097_153) }, config), config));
});

void test("distinguishes_base64_json_and_media_errors", () => {
  for (const body of ["%%%", "e30", "e31=", "e30=\n", "e30==", "e30="]) {
    const request = parseGatewayEvent(gatewayEvent({ body, isBase64Encoded: true }), config);
    if (body === "e30=") assert.deepEqual(parseJsonBody(request, config), {});
    else rejectsStatus(400, () => parseJsonBody(request, config));
  }
  for (const body of ["{", "", Buffer.from([0xff]).toString("base64")]) rejectsStatus(400, () => parseJsonBody(parseGatewayEvent(gatewayEvent({ body, isBase64Encoded: body.endsWith("=") }), config), config));
  for (const contentType of ["text/plain", "application/jsonp", "application/json; charset=latin1", "application/json,application/json"]) rejectsStatus(415, () => parseJsonBody(parseGatewayEvent(gatewayEvent({ headers: { "content-type": contentType } }), config), config));
  assert.deepEqual(parseJsonBody(parseGatewayEvent(gatewayEvent({ headers: { "Content-Type": "Application/JSON; charset=utf-8" } }), config), config), {});
});

void test("safe_json_responses_preserve_representation_and_delegate_cors", () => {
  const body = '{"id":"1","title":"😀"}';
  const response = jsonResponse(200, body, "req", { ETag: '"r1-hash"' });
  assert.equal(response.body, body);
  assert.equal(response.headers?.["Content-Type"], "application/json; charset=utf-8");
  assert.equal(response.headers?.["X-Request-Id"], "req");
  assert.equal(response.headers?.["X-Content-Type-Options"], "nosniff");
  assert.equal(response.headers?.["Cache-Control"], "private, no-store, no-transform");
  assert.equal(response.headers?.ETag, '"r1-hash"');
  assert.equal(jsonResponse(200, "{}", "req").headers?.["Cache-Control"], "no-store");
  assert.ok(!Object.keys(response.headers ?? {}).some((name) => name.toLowerCase().startsWith("access-control-")));
});

void test("never_logs_secrets", (t) => {
  const canary = "Bearer secret-url?signature=private-body";
  const lines: string[] = [];
  t.mock.method(console, "log", (line: string) => { lines.push(line); });
  logEvent({ requestId: "req", lambdaRequestId: "lambda", operation: "create", status: 503, code: "UNAVAILABLE", durationMs: 2, evaluated: 3, deletes: 1, incomplete: true, authorization: canary, body: canary, url: canary, error: new Error(canary) } as Parameters<typeof logEvent>[0]);
  assert.equal(lines.length, 1);
  assert.equal(lines.join("").includes(canary), false);
  assert.deepEqual(JSON.parse(lines[0] ?? ""), { requestId: "req", lambdaRequestId: "lambda", operation: "create", status: 503, code: "UNAVAILABLE", durationMs: 2, evaluated: 3, deletes: 1, incomplete: true });
  for (const error of [new Error(canary), { message: canary }, new ApiError(422, "INVALID_INPUT", canary)]) assert.equal(errorResponse(error, "req").body?.includes(canary), false);
  assert.equal(errorResponse(new Error(canary), "req").statusCode, 503);
  assert.equal(errorResponse(new ApiError(429, "RATE_LIMITED", "Rate limit reached", 60), "req").headers?.["Retry-After"], "60");
});

void test("deadline_aborts_awaited_operations", async () => {
  const started = Date.now();
  const budget = createBudget(() => 50 - (Date.now() - started), 10);
  let settled = false;
  const operation = async (): Promise<void> => {
    requireBudget(budget);
    try { await delay(1000, undefined, { signal: budget.signal }); }
    finally { await delay(5); settled = true; }
  };
  await assert.rejects(operation(), { name: "AbortError" });
  assert.equal(budget.signal.aborted, true);
  assert.equal(settled, true);
  assert.equal(budget.remainingMs(), 0);
  let calls = 0;
  const expired = createBudget(() => 9, 10);
  await assert.rejects(async () => { requireBudget(expired); calls++; await delay(1); }, ApiError);
  assert.equal(calls, 0);
});

void test("budget_rechecks_remaining_time_before_new_operations", () => {
  let remaining = 1000;
  const budget = createBudget(() => remaining, 100);
  assert.ok(budget.remainingMs() > 800 && budget.remainingMs() <= 900);
  remaining = 50;
  assert.equal(budget.remainingMs(), 0);
  assert.equal(budget.signal.aborted, true);
  rejectsStatus(503, () => requireBudget(budget));
});

void test("rejects_method_route_mismatch_and_accepts_read_route", () => {
  rejectsStatus(400, () => parseGatewayEvent(gatewayEvent({ requestContext: { ...context(), http: { method: "GET", sourceIp: "192.0.2.1" } } }), config));
  const request = parseGatewayEvent(gatewayEvent({ routeKey: "GET /v2/reminders", requestContext: { ...context(), routeKey: "GET /v2/reminders", http: { method: "GET", sourceIp: "192.0.2.1" } } }), config);
  assert.equal(requireOwner(request, config, "read"), ownerIdFor(config.issuer, "subject-1"));
});

void test("requires_gateway_scope_list_and_rejects_aborted_budget", () => {
  const ctx = context();
  const jwt = (ctx.authorizer as { jwt: { claims: Record<string, unknown>; scopes: string[] } }).jwt;
  rejectsStatus(401, () => authenticate(gatewayEvent({ requestContext: { ...ctx, authorizer: { jwt: { ...jwt, scopes: ["reminder-api/read"] } } } })));
  const controller = new AbortController();
  controller.abort(new ApiError(503, "DEADLINE_EXCEEDED", "Unavailable"));
  rejectsStatus(503, () => requireBudget({ signal: controller.signal, remainingMs: () => 1000 }));
});

void test("error_response_uses_common_code_message_request_id_contract", () => {
  const unavailable = errorResponse(new Error("private-aws-detail"), "req");
  assert.deepEqual(JSON.parse(unavailable.body ?? ""), { code: "SERVICE_UNAVAILABLE", message: "Service temporarily unavailable", requestId: "req" });
  const limited = errorResponse(new ApiError(429, "RATE_LIMITED", "private-detail", 60), "req");
  assert.deepEqual(JSON.parse(limited.body ?? ""), { code: "RATE_LIMITED", message: "Rate limit exceeded", requestId: "req", retryAfterSeconds: 60 });
  assert.equal(limited.headers?.["Retry-After"], "60");
});
