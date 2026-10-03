import type { APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import { ApiError } from "../shared/errors";

export function jsonResponse(status: number, body: string, requestId: string, headers: Record<string, string> = {}): APIGatewayProxyStructuredResultV2 {
  const extra: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (!["content-type", "x-request-id", "x-content-type-options", "cache-control"].includes(lower) && !lower.startsWith("access-control-")) extra[name] = value;
  }
  const item = Object.keys(extra).some((name) => name.toLowerCase() === "etag");
  return {
    statusCode: status, body, isBase64Encoded: false,
    headers: { ...extra, "Content-Type": "application/json; charset=utf-8", "X-Request-Id": requestId, "X-Content-Type-Options": "nosniff", "Cache-Control": item ? "private, no-store, no-transform" : "no-store" },
  };
}

const messages: Record<number, string> = {
  400: "Invalid request", 401: "Valid access token is required", 403: "Request is forbidden", 404: "Not found",
  409: "Request conflicts with current state", 412: "Precondition failed", 413: "Request body is too large",
  415: "Unsupported media type", 422: "Invalid input", 428: "Precondition is required", 429: "Rate limit exceeded",
  503: "Service temporarily unavailable",
};

/** Raw error messages are never serialized, including accidentally unsafe ApiError messages. */
export function errorResponse(error: unknown, requestId: string): APIGatewayProxyStructuredResultV2 {
  const known = error instanceof ApiError && messages[error.status] !== undefined;
  const status = known ? error.status : 503;
  const code = known && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) && !/[\r\n]/.test(error.code) ? error.code : "SERVICE_UNAVAILABLE";
  const headers: Record<string, string> = {};
  if (known && error.retryAfterSeconds !== undefined && Number.isSafeInteger(error.retryAfterSeconds) && error.retryAfterSeconds > 0) headers["Retry-After"] = String(error.retryAfterSeconds);
  const body = { code, message: messages[status], requestId, ...(status === 429 && headers["Retry-After"] !== undefined ? { retryAfterSeconds: Number(headers["Retry-After"]) } : {}) };
  return jsonResponse(status, JSON.stringify(body), requestId, headers);
}
