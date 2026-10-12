import type { ActiveReminder, CreateInput } from "../../src/reminders/types";
import type { Budget } from "../../src/shared/ports";

export function validCreate(overrides: Partial<CreateInput> = {}): CreateInput {
  return { id: "reminder-1", url: "https://example.test/reminder", title: "Test reminder", reminderTime: "2026-10-03T00:00:00.000Z", autoOpen: false, webPush: true, hidden: false, thumbnail: null, ...overrides };
}

export function activeReminder(overrides: Partial<ActiveReminder> = {}): ActiveReminder {
  return { ...validCreate(), ownerId: "a".repeat(64), revision: 1, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", thumbnail: null, deleted: false, ...overrides };
}

export function testBudget(): Budget {
  return { signal: new AbortController().signal, remainingMs: () => 10_000 };
}

/** Synthetic HTTP API v2 event; nested overrides replace their whole value. */
export function gatewayEvent(overrides: Record<string, unknown> = {}): unknown {
  const now = Math.floor(Date.now() / 1000);
  return {
    version: "2.0", routeKey: "POST /v2/reminders", rawPath: "/v2/reminders", rawQueryString: "",
    headers: { "content-type": "application/json", authorization: "Bearer synthetic-token" },
    requestContext: {
      apiId: "api123", stage: "$default", requestId: "req-123", routeKey: "POST /v2/reminders",
      http: { method: "POST", path: "/v2/reminders", sourceIp: "192.0.2.1", protocol: "HTTP/1.1" },
      authorizer: { jwt: {
        claims: { iss: "https://cognito-idp.ap-northeast-1.amazonaws.com/test", sub: "subject-1", client_id: "client123", token_use: "access", exp: now + 3600, iat: now - 60, scope: "reminder-api/read reminder-api/write" },
        scopes: ["reminder-api/read", "reminder-api/write"],
      } },
    },
    body: "{}", isBase64Encoded: false, ...overrides,
  };
}

/** Public synthetic signature plus payload: never sourced from a user's image. */
export const syntheticPngBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
export const syntheticPngBase64 = syntheticPngBytes.toString("base64");
