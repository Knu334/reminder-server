import type { Config } from "../config";
import { parseReminderId } from "../reminders/validation";
import { ApiError } from "../shared/errors";
import { requireOwner } from "./identity";

export interface GatewayRequest {
  method: string;
  routeKey: string;
  pathParameters: Record<string, string>;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: string | undefined;
  isBase64Encoded: boolean;
  requestId: string;
  sourceIp: string;
  jwt: { claims: Record<string, unknown>; scopes: string[] } | null;
}

function invalidGateway(): never { throw new ApiError(400, "INVALID_GATEWAY_EVENT", "Invalid gateway event"); }
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return invalidGateway();
  return value as Record<string, unknown>;
}
function strings(value: unknown): Record<string, string> {
  if (value === undefined || value === null) return {};
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [name, field] of Object.entries(record(value))) {
    if (typeof field !== "string") return invalidGateway();
    result[name] = field;
  }
  return result;
}

/** Accept only the configured HTTP API v2 boundary; never decode pathParameters again. */
export function parseGatewayEvent(value: unknown, config: Config): GatewayRequest {
  const event = record(value);
  const context = record(event.requestContext);
  const http = record(context.http);
  if (event.version !== "2.0" || context.apiId !== config.expectedApiId || context.stage !== config.expectedStage ||
      typeof event.routeKey !== "string" || context.routeKey !== event.routeKey ||
      typeof http.method !== "string" || !/^[A-Z]+$/.test(http.method) ||
      (event.routeKey !== "$default" && !event.routeKey.startsWith(`${http.method} /`)) ||
      typeof context.requestId !== "string" || !context.requestId || typeof http.sourceIp !== "string" ||
      typeof event.isBase64Encoded !== "boolean" || (event.body !== undefined && typeof event.body !== "string")) return invalidGateway();
  const headers: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [key, field] of Object.entries(strings(event.headers))) {
    const name = key.toLowerCase();
    headers[name] = headers[name] === undefined ? field : `${headers[name]},${field}`;
  }
  // ID errors use the same R01 rules, including Unicode code-point limits.
  const pathParameters: Record<string, string> = Object.create(null) as Record<string, string>;
  if (event.pathParameters !== undefined && event.pathParameters !== null) {
    for (const [key, field] of Object.entries(record(event.pathParameters))) {
      if (key === "id") pathParameters[key] = parseReminderId(field);
      else if (typeof field === "string") pathParameters[key] = field;
      else return invalidGateway();
    }
  }
  let jwt: GatewayRequest["jwt"] = null;
  if (context.authorizer !== undefined) {
    const authorizer = record(context.authorizer);
    if (authorizer.jwt !== undefined) {
      const candidate = record(authorizer.jwt);
      const claims = record(candidate.claims);
      if (!Array.isArray(candidate.scopes) || !candidate.scopes.every((scope: unknown) => typeof scope === "string")) return invalidGateway();
      jwt = { claims, scopes: candidate.scopes as string[] };
    }
  }
  return {
    method: http.method, routeKey: event.routeKey, pathParameters, query: strings(event.queryStringParameters), headers,
    body: event.body as string | undefined, isBase64Encoded: event.isBase64Encoded, requestId: context.requestId, sourceIp: http.sourceIp, jwt,
  };
}

/** Call after auth/rate/publication checks. This helper also authenticates defensively. */
export function parseJsonBody(request: GatewayRequest, config: Config): unknown {
  requireOwner(request, config, request.method === "GET" ? "read" : "write");
  const body = request.body ?? "";
  let bytes: Buffer;
  if (request.isBase64Encoded) {
    if (body.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body)) {
      throw new ApiError(400, "INVALID_BODY", "Invalid request body");
    }
    const decodedBytes = body.length / 4 * 3 - (body.endsWith("==") ? 2 : body.endsWith("=") ? 1 : 0);
    if (decodedBytes > config.limits.jsonBytes) throw new ApiError(413, "BODY_TOO_LARGE", "Request body is too large");
    bytes = Buffer.from(body, "base64");
    if (bytes.toString("base64") !== body) throw new ApiError(400, "INVALID_BODY", "Invalid request body");
  } else {
    if (Buffer.byteLength(body, "utf8") > config.limits.jsonBytes) throw new ApiError(413, "BODY_TOO_LARGE", "Request body is too large");
    bytes = Buffer.from(body, "utf8");
  }
  const type = request.headers["content-type"] ?? "";
  if (!/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/i.test(type) || /[\r\n]/.test(type)) {
    throw new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json");
  }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown; }
  catch { throw new ApiError(400, "INVALID_JSON", "Invalid JSON body"); }
}
