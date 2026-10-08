import { randomUUID } from "node:crypto";
import type { APIGatewayProxyStructuredResultV2, Context } from "aws-lambda";
import { loadConfig, type Config } from "./config";
import { createJobsStore } from "./images/jobs-store";
import { createImagesStore } from "./images/s3-store";
import { createRemindersStore } from "./reminders/dynamo-store";
import { createOwnerStore, checkRate } from "./reminders/owner-store";
import { createRemindersService, type RemindersService } from "./reminders/service";
import { createAwsClients } from "./shared/aws";
import { createBudget, requireBudget } from "./shared/budget";
import { ApiError } from "./shared/errors";
import { logEvent, type SafeLogEvent } from "./shared/logging";
import type { ImagesStore, OwnerStore } from "./shared/ports";
import { parseGatewayEvent, type GatewayRequest } from "./api/event";
import { requireOwner } from "./api/identity";
import { errorResponse, jsonResponse } from "./api/responses";
import { dispatchReminderRoute, resolveRoute } from "./api/routes";

export interface ApiDeps {
  config: Config;
  service: RemindersService;
  owners: OwnerStore;
  images: ImagesStore;
  clock: () => number;
}
type ApiHandler = (event: unknown, context: Context) => Promise<APIGatewayProxyStructuredResultV2>;
// These labels are fixed API vocabulary, never request paths or arbitrary error text.
const logOperations: Readonly<Record<string, string>> = {
  "GET /healthz": "health", "GET /readyz": "ready", "POST /reminders": "legacy", "PUT /reminders": "legacy",
  "GET /v2/reminders": "list", "POST /v2/reminders": "create", "GET /v2/reminders/{id}": "get",
  "GET /v2/reminders/{id}/thumbnail-url": "thumbnail", "PATCH /v2/reminders/{id}": "patch", "DELETE /v2/reminders/{id}": "remove",
};
const logCodes = new Set([
  "INVALID_GATEWAY_EVENT", "INVALID_BODY", "INVALID_JSON", "UNAUTHORIZED", "SOURCE_IP_FORBIDDEN",
  "ROUTE_NOT_FOUND", "METHOD_NOT_ALLOWED", "LEGACY_API_REMOVED", "REMINDER_NOT_FOUND", "THUMBNAIL_NOT_FOUND",
  "ALREADY_EXISTS", "PRECONDITION_FAILED", "PAYLOAD_TOO_LARGE", "THUMBNAIL_TOO_LARGE", "OWNER_STORAGE_LIMIT_EXCEEDED",
  "UNSUPPORTED_MEDIA_TYPE", "INVALID_INPUT", "INVALID_THUMBNAIL", "INVALID_CURSOR", "INVALID_LIMIT", "INVALID_IF_MATCH",
  "PRECONDITION_REQUIRED", "OWNER_RATE_LIMIT_EXCEEDED", "SERVICE_UNAVAILABLE",
]);
function safeLogId(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : undefined;
}
function logOperation(event: unknown): string {
  if (typeof event !== "object" || event === null || Array.isArray(event)) return "unknown";
  const routeKey: unknown = Reflect.get(event, "routeKey");
  return typeof routeKey === "string" && Object.hasOwn(logOperations, routeKey) ? logOperations[routeKey]! : "unknown";
}

/** One best-effort result at the outer boundary, including lazy initialization failures. */
export function withApiResultLogging(delegate: ApiHandler): ApiHandler {
  return async (event, context) => {
    const started = performance.now();
    let response: APIGatewayProxyStructuredResultV2 | undefined;
    try {
      response = await delegate(event, context);
      return response;
    } finally {
      try {
        const result: SafeLogEvent = {
          operation: logOperation(event), status: response?.statusCode ?? 503,
          durationMs: Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.round(performance.now() - started))),
        };
        const requestId = safeLogId(response === undefined ? context.awsRequestId : response.headers?.["X-Request-Id"]);
        const lambdaRequestId = safeLogId(context.awsRequestId);
        if (requestId !== undefined) result.requestId = requestId;
        if (lambdaRequestId !== undefined) result.lambdaRequestId = lambdaRequestId;
        if (response === undefined) result.code = "SERVICE_UNAVAILABLE";
        else if ((response.statusCode ?? 0) >= 400 && response.body !== undefined) {
          try {
            const body: unknown = JSON.parse(response.body);
            if (typeof body === "object" && body !== null && !Array.isArray(body)) {
              const code: unknown = Reflect.get(body, "code");
              if (typeof code === "string" && logCodes.has(code)) result.code = code;
            }
          } catch { /* A result logger never changes the delegate's response. */ }
        }
        logEvent(result);
      } catch { /* Logging failures must preserve both HTTP responses and thrown errors. */ }
    }
  };
}

function unavailable(): ApiError { return new ApiError(503, "SERVICE_UNAVAILABLE", "Service temporarily unavailable"); }

function immediateResponse(request: GatewayRequest): APIGatewayProxyStructuredResultV2 | undefined {
  const result = resolveRoute(request);
  if ("status" in result) {
    return jsonResponse(result.status, JSON.stringify({ code: result.status === 405 ? "METHOD_NOT_ALLOWED" : "ROUTE_NOT_FOUND", message: result.status === 405 ? "Method not allowed" : "Not found", requestId: request.requestId }), request.requestId, result.allow === undefined ? {} : { Allow: result.allow });
  }
  if (result.route === "health") return jsonResponse(200, '{"healthy":true}', request.requestId);
  if (result.route === "legacy") return jsonResponse(410, JSON.stringify({ code: "LEGACY_API_REMOVED", message: "Use the item-based API", requestId: request.requestId, replacement: "/v2/reminders" }), request.requestId);
  return undefined;
}

export function createApiHandler(deps: ApiDeps): ApiHandler {
  return async (event, context) => {
    let requestId = context.awsRequestId;
    try {
      const request = parseGatewayEvent(event, deps.config); requestId = request.requestId;
      const immediate = immediateResponse(request); if (immediate !== undefined) return immediate;
      const result = resolveRoute(request);
      if ("status" in result) throw unavailable();
      const budget = createBudget(() => context.getRemainingTimeInMillis(), 1000);
      if (result.route === "ready") {
        requireBudget(budget);
        await deps.owners.probe(budget);
        await deps.images.probe(budget);
        requireBudget(budget);
        if (!(await deps.owners.gate(budget)).published) throw unavailable();
        requireBudget(budget);
        return jsonResponse(200, '{"ready":true}', requestId);
      }
      const ownerId = requireOwner(request, deps.config, request.method === "GET" ? "read" : "write");
      await checkRate(deps.owners, ownerId, deps.clock(), budget);
      requireBudget(budget);
      if (!(await deps.owners.gate(budget)).published) throw unavailable();
      requireBudget(budget);
      return await dispatchReminderRoute(result.route, request, ownerId, deps.service, deps.config, budget);
    } catch (error) { return errorResponse(error, requestId); }
  };
}

let production: ApiHandler | undefined;
/** Import performs no config loads, client construction, I/O or server startup. */
async function invokeProduction(event: unknown, context: Context): Promise<APIGatewayProxyStructuredResultV2> {
  if (production !== undefined) return production(event, context);
  let requestId = context.awsRequestId;
  let config: Config;
  try { config = loadConfig(process.env); }
  catch {
    // Without valid configuration only structural liveness is available. Never initialize stores.
    try {
      if (typeof event !== "object" || event === null || Array.isArray(event)) throw unavailable();
      const ctx: unknown = Reflect.get(event, "requestContext");
      if (typeof ctx !== "object" || ctx === null || Array.isArray(ctx)) throw unavailable();
      const apiId: unknown = Reflect.get(ctx, "apiId"); const stage: unknown = Reflect.get(ctx, "stage");
      if (typeof apiId !== "string" || !apiId || typeof stage !== "string" || !stage) throw unavailable();
      const request = parseGatewayEvent(event, { expectedApiId: apiId, expectedStage: stage }); requestId = request.requestId;
      const route = resolveRoute(request);
      if ("route" in route && route.route === "health") return jsonResponse(200, '{"healthy":true}', requestId);
    } catch { /* Configuration failure remains a safe 503. */ }
    return errorResponse(unavailable(), requestId);
  }
  try {
    const request = parseGatewayEvent(event, config); requestId = request.requestId;
    const immediate = immediateResponse(request); if (immediate !== undefined) return immediate;
    const clients = createAwsClients(config);
    const reminders = createRemindersStore(clients.dynamo, config);
    const owners = createOwnerStore(clients.dynamo, config);
    const jobs = createJobsStore(clients.dynamo, config);
    const images = createImagesStore(clients.s3, config);
    production = createApiHandler({ config, owners, images, clock: Date.now, service: createRemindersService({ config, reminders, owners, jobs, images, clock: Date.now, uuid: randomUUID }) });
    return await production(event, context);
  } catch (error) { return errorResponse(error, requestId); }
}

export const handler: ApiHandler = withApiResultLogging(invokeProduction);
