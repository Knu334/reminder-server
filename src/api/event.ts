import type { Config } from "../config";
import { ApiError } from "../shared/errors";
import { requireOwner } from "./identity";

export interface GatewayRequest {
  method: string;
  routeKey: string;
  rawPath: string;
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
export function parseGatewayEvent(value: unknown, config: Pick<Config, "expectedApiId" | "expectedStage">): GatewayRequest {
  const event = record(value);
  const context = record(event.requestContext);
  const http = record(context.http);
  if (event.version !== "2.0" || context.apiId !== config.expectedApiId || context.stage !== config.expectedStage ||
      typeof event.routeKey !== "string" || context.routeKey !== event.routeKey ||
      typeof event.rawPath !== "string" || !event.rawPath.startsWith("/") || /[\r\n]/.test(event.rawPath) ||
      typeof http.method !== "string" || !/^[A-Z]+$/.test(http.method) ||
      (event.routeKey !== "$default" && !event.routeKey.startsWith(`${http.method} /`)) ||
      typeof context.requestId !== "string" || !context.requestId || typeof http.sourceIp !== "string" ||
      typeof event.isBase64Encoded !== "boolean" || (event.body !== undefined && typeof event.body !== "string")) return invalidGateway();
  const headers: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [key, field] of Object.entries(strings(event.headers))) {
    const name = key.toLowerCase();
    headers[name] = headers[name] === undefined ? field : `${headers[name]},${field}`;
  }
  // Structural boundary only: semantic ID rules run after auth/rate/publication.
  const pathParameters: Record<string, string> = Object.create(null) as Record<string, string>;
  if (event.pathParameters !== undefined && event.pathParameters !== null) {
    for (const [key, field] of Object.entries(record(event.pathParameters))) {
      if (typeof field === "string") pathParameters[key] = field;
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
    method: http.method, routeKey: event.routeKey, rawPath: event.rawPath, pathParameters, query: strings(event.queryStringParameters), headers,
    body: event.body as string | undefined, isBase64Encoded: event.isBase64Encoded, requestId: context.requestId, sourceIp: http.sourceIp, jwt,
  };
}

/** Validate in constant stack space before allocating or parsing large Gateway bodies. */
function base64DecodedBytes(body: string): number {
  function invalid(): never { throw new ApiError(400, "INVALID_BODY", "Invalid request body"); }
  if (body.length % 4 !== 0) return invalid();
  const padding = body.endsWith("==") ? 2 : body.endsWith("=") ? 1 : 0;
  let last = 0;
  for (let index = 0; index < body.length - padding; index++) {
    const code = body.charCodeAt(index);
    if (code >= 65 && code <= 90) last = code - 65;
    else if (code >= 97 && code <= 122) last = code - 71;
    else if (code >= 48 && code <= 57) last = code + 4;
    else if (code === 43) last = 62;
    else if (code === 47) last = 63;
    else return invalid();
  }
  // Canonical padding requires zero unused bits, even on oversized input.
  if ((padding === 2 && (last & 15) !== 0) || (padding === 1 && (last & 3) !== 0)) return invalid();
  return body.length / 4 * 3 - padding;
}

/** Call after auth/rate/publication checks. This helper also authenticates defensively. */
export function parseJsonBody(request: GatewayRequest, config: Config): unknown {
  requireOwner(request, config, request.method === "GET" ? "read" : "write");
  const body = request.body ?? "";
  let bytes: Buffer;
  if (request.isBase64Encoded) {
    const decodedBytes = base64DecodedBytes(body);
    if (decodedBytes > config.limits.jsonBytes) throw new ApiError(413, "PAYLOAD_TOO_LARGE", "Request body is too large");
    bytes = Buffer.from(body, "base64");
    if (bytes.toString("base64") !== body) throw new ApiError(400, "INVALID_BODY", "Invalid request body");
  } else {
    if (Buffer.byteLength(body, "utf8") > config.limits.jsonBytes) throw new ApiError(413, "PAYLOAD_TOO_LARGE", "Request body is too large");
    bytes = Buffer.from(body, "utf8");
  }
  const type = request.headers["content-type"] ?? "";
  if (!/^application\/json(?:\s*;\s*charset\s*=\s*(?:utf-8|"utf-8"))?$/i.test(type) || /[\r\n]/.test(type)) {
    throw new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json");
  }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown; }
  catch { throw new ApiError(400, "INVALID_JSON", "Invalid JSON body"); }
}
