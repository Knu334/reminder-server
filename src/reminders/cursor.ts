import { z } from "zod";
import { ApiError } from "../shared/errors";
import type { OwnerId } from "./types";
import { parseReminderId } from "./validation";

const MAX_CURSOR_BYTES = 2048;
const cursor = z.strictObject({ version: z.literal(1), ownerId: z.string().min(1), lastId: z.string() });
function invalidCursor(): never { throw new ApiError(422, "INVALID_CURSOR", "Invalid pagination cursor"); }

/** The key is reconstructed from the authenticated owner; no Dynamo key is accepted from clients. */
export function encodeCursor(ownerId: OwnerId, lastId: string): string {
  const value = Buffer.from(JSON.stringify({ version: 1, ownerId, lastId: parseReminderId(lastId) }), "utf8").toString("base64url");
  if (Buffer.byteLength(value) > MAX_CURSOR_BYTES) return invalidCursor();
  return value;
}

export function decodeCursor(value: string, ownerId: OwnerId): string {
  try {
    if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value) > MAX_CURSOR_BYTES || !/^[A-Za-z0-9_-]+$/.test(value)) return invalidCursor();
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value) return invalidCursor();
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const parsed = cursor.safeParse(JSON.parse(decoded));
    if (!parsed.success || parsed.data.ownerId !== ownerId) return invalidCursor();
    return parseReminderId(parsed.data.lastId);
  } catch { return invalidCursor(); }
}

/** Public query parsing and adapter validation share the same evaluation-page bounds. */
export function parseLimit(value: unknown): number {
  if (value === undefined) return 20;
  if (typeof value === "string" && /^[0-9]+$/.test(value)) value = Number(value);
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 50) throw new ApiError(422, "INVALID_LIMIT", "Invalid page limit");
  return value;
}
