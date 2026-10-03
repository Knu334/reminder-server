import type { APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import type { Config } from "../config";
import { parseLimit } from "../reminders/cursor";
import type { RemindersService } from "../reminders/service";
import { parseCreate, parsePatch } from "../reminders/validation";
import type { OwnerId } from "../reminders/types";
import { ApiError } from "../shared/errors";
import type { Budget } from "../shared/ports";
import { parseJsonBody, type GatewayRequest } from "./event";
import { jsonResponse } from "./responses";

export type ApiRoute = "health" | "ready" | "legacy" | "list" | "get" | "thumbnail" | "create" | "patch" | "remove";
const routes: Record<string, Partial<Record<string, ApiRoute>>> = {
  "/healthz": { GET: "health" },
  "/readyz": { GET: "ready" },
  "/reminders": { POST: "legacy", PUT: "legacy" },
  "/v2/reminders": { GET: "list", POST: "create" },
  "/v2/reminders/{id}": { GET: "get", PATCH: "patch", DELETE: "remove" },
  "/v2/reminders/{id}/thumbnail-url": { GET: "thumbnail" },
};

/** rawPath classifies only default routes; Gateway pathParameters retain ID identity. */
export function resolveRoute(request: GatewayRequest): { route: ApiRoute } | { status: 404 | 405; allow?: string } {
  let path = request.routeKey === "$default" ? request.rawPath : request.routeKey.slice(request.method.length + 1);
  if (request.routeKey === "$default") {
    if (/^\/v2\/reminders\/[^/]+\/thumbnail-url$/.test(path)) path = "/v2/reminders/{id}/thumbnail-url";
    else if (/^\/v2\/reminders\/[^/]+$/.test(path)) path = "/v2/reminders/{id}";
  }
  const methods = Object.hasOwn(routes, path) ? routes[path] : undefined;
  if (methods === undefined) return { status: 404 };
  const route = Object.hasOwn(methods, request.method) ? methods[request.method] : undefined;
  return route === undefined ? { status: 405, allow: Object.keys(methods).join(", ") } : { route };
}

export async function dispatchReminderRoute(route: ApiRoute, request: GatewayRequest, ownerId: OwnerId, service: RemindersService, config: Config, budget: Budget): Promise<APIGatewayProxyStructuredResultV2> {
  const requestId = request.requestId;
  if (route === "list") return jsonResponse(200, JSON.stringify(await service.list(ownerId, parseLimit(request.query.limit), request.query.cursor ?? null, budget)), requestId);
  if (route === "create") {
    const representation = await service.create(ownerId, parseCreate(parseJsonBody(request, config)), budget);
    return jsonResponse(201, representation.body, requestId, { ETag: representation.etag, Location: `/v2/reminders/${encodeURIComponent(representation.dto.id)}` });
  }
  const id = request.pathParameters.id;
  if (id === undefined) throw new ApiError(400, "INVALID_GATEWAY_EVENT", "Invalid gateway event");
  if (route === "thumbnail") return jsonResponse(200, JSON.stringify(await service.thumbnailUrl(ownerId, id, budget)), requestId);
  if (route === "remove") return jsonResponse(200, JSON.stringify(await service.remove(ownerId, id, request.headers["if-match"], budget)), requestId);
  const representation = route === "get" ? await service.get(ownerId, id, budget)
    : await service.patch(ownerId, id, request.headers["if-match"], parsePatch(parseJsonBody(request, config)), budget);
  return jsonResponse(200, representation.body, requestId, { ETag: representation.etag });
}
