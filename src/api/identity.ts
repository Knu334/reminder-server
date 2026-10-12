import { createHash } from "node:crypto";
import { isIP } from "node:net";
import type { Config } from "../config";
import type { OwnerId } from "../reminders/types";
import { ApiError } from "../shared/errors";
import type { GatewayRequest } from "./event";

export function ownerIdFor(issuer: string, sub: string): OwnerId {
  return createHash("sha256").update(JSON.stringify([issuer, sub]), "utf8").digest("hex");
}
function unauthorized(): never { throw new ApiError(401, "UNAUTHORIZED", "Valid access token is required"); }
function timestamp(value: unknown): number {
  if (typeof value === "string") {
    if (!/^[0-9]+$/.test(value) || /[\r\n]/.test(value)) return unauthorized();
    value = Number(value);
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return unauthorized();
  return value;
}

/** Gateway verifies signatures; this boundary checks the configured pool, client, access claims and scope. */
export function requireOwner(request: GatewayRequest, config: Config, scope: "read" | "write"): OwnerId {
  const jwt = request.jwt;
  if (jwt === null) return unauthorized();
  const claims = jwt.claims;
  if (claims.iss !== config.issuer || claims.client_id !== config.clientId || claims.token_use !== "access" ||
      typeof claims.sub !== "string" || !claims.sub || typeof claims.scope !== "string") return unauthorized();
  const now = Math.floor(Date.now() / 1000);
  const exp = timestamp(claims.exp); const iat = timestamp(claims.iat);
  const requiredScope = `reminder-api/${scope}`;
  if (exp <= now || iat > now || exp <= iat || !claims.scope.split(/\s+/).includes(requiredScope) ||
      !jwt.scopes.includes(requiredScope) || (request.method === "GET" ? scope !== "read" : scope !== "write")) return unauthorized();
  if (config.sourceIps.length > 0 && (isIP(request.sourceIp) === 0 || !config.sourceIps.includes(request.sourceIp))) {
    throw new ApiError(403, "SOURCE_IP_FORBIDDEN", "Source IP is not allowed");
  }
  return ownerIdFor(config.issuer, claims.sub);
}
