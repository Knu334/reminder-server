import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { ownerIdFor } from "../../src/api/identity";
import type { Config } from "../../src/config";
import { decodeThumbnail } from "../../src/images/validation";
import type { DecodedImage } from "../../src/images/types";
import { normalizeInstant, parseCreate, parsePatch, parseReminderId } from "../../src/reminders/validation";
import type { ActiveReminder, OwnerId } from "../../src/reminders/types";

export interface EnvironmentIdentity {
  accountId: string; region: string; remindersTable: string; ownerStateTable: string;
  imageJobsTable: string; imagesBucket: string; issuer: string;
}
export interface MigrationIdentity {
  runId: string; sourceSha256: string; mappingSha256: string; contractSha256: string;
  environment: EnvironmentIdentity; contractVersion: 1;
}
export type MigrationTarget = Config & { accountId: string };
export interface MigrationInputs {
  sourceBytes: Buffer; mappingBytes: Buffer; sourceSha256: string; mappingSha256: string;
}
export interface ValidationError { location: string; field: string; code: string }
export interface LegacyValidation {
  owners: Array<{ ownerId: OwnerId; items: ActiveReminder[]; images: Map<string, DecodedImage> }>;
  errors: ValidationError[];
}
const hash = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
export async function readMigrationInputs(sourcePath: string, mappingPath: string): Promise<MigrationInputs> {
  const [sourceBytes, mappingBytes] = await Promise.all([readFile(sourcePath), readFile(mappingPath)]);
  return { sourceBytes, mappingBytes, sourceSha256: hash(sourceBytes), mappingSha256: hash(mappingBytes) };
}

/** Canonical target plus effective admission and migration conventions; never ambient env. */
export function contractSha256For(target: MigrationTarget): string {
  function canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonical);
    if (record(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
    return value;
  }
  return hash(JSON.stringify(canonical({
    contractVersion: 1, target,
    reminder: { required: ["id", "url", "title", "reminderTime", "autoOpen", "webPush", "hidden", "createdAt"], optional: ["thumbnail"], id: "runtime-well-formed-unicode-preserved", revision: 1, updatedAt: "createdAt", deleted: false },
    jsonBytes: "per-original-reminder-object-json-stringify-utf8-including-createdAt",
    datetime: "runtime-explicit-offset-valid-calendar-utc-milliseconds",
    image: "runtime-strict-base64-signature-mime-original-bytes-png-jpeg-gif-webp",
    owner: "sha256-json-array-issuer-sub",
  })));
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
const requiredFields = ["id", "url", "title", "reminderTime", "autoOpen", "webPush", "hidden", "createdAt"];
const allowedFields = new Set([...requiredFields, "thumbnail"]);

/** All diagnostics use fixed field names and numeric locations, never source keys/content. */
export function validateLegacy(source: string, mapping: unknown, config: Config): LegacyValidation {
  const result: LegacyValidation = { owners: [], errors: [] };
  const error = (location: string, field: string, code: string): void => { result.errors.push({ location, field, code }); };
  let value: unknown;
  try { value = JSON.parse(source); }
  catch { error("source", "json", "INVALID_JSON"); return result; }
  if (!record(value)) { error("source", "owners", "INVALID_SOURCE"); return result; }
  const entries = Object.entries(value);
  const sourceKeys = new Set(entries.map(([key]) => key));
  const ownerByKey = new Map<string, OwnerId>();
  const mappingKeys = new Set<string>();
  if (!Array.isArray(mapping)) error("mapping", "entries", "INVALID_MAPPING");
  else mapping.forEach((entry: unknown, index: number) => {
    const location = `mapping[${index}]`;
    if (!record(entry)) { error(location, "entry", "INVALID_MAPPING_ENTRY"); return; }
    let valid = true;
    const fail = (field: string, code: string): void => { valid = false; error(location, field, code); };
    if (Object.keys(entry).some((key) => !["legacyKey", "issuer", "sub", "ownerId"].includes(key))) fail("fields", "UNKNOWN_FIELD");
    for (const field of ["legacyKey", "issuer", "sub"]) if (!Object.hasOwn(entry, field)) fail(field, "MISSING_FIELD");
    if (typeof entry.legacyKey !== "string") fail("legacyKey", "INVALID_LEGACY_KEY");
    else {
      if (mappingKeys.has(entry.legacyKey)) fail("legacyKey", "DUPLICATE_MAPPING");
      mappingKeys.add(entry.legacyKey);
      if (!sourceKeys.has(entry.legacyKey)) fail("legacyKey", "EXTRA_MAPPING");
    }
    if (entry.issuer !== config.issuer) fail("issuer", "ISSUER_MISMATCH");
    if (typeof entry.sub !== "string" || entry.sub.length === 0) fail("sub", "INVALID_SUB");
    const ownerId = typeof entry.issuer === "string" && typeof entry.sub === "string" ? ownerIdFor(entry.issuer, entry.sub) : null;
    if (Object.hasOwn(entry, "ownerId") && entry.ownerId !== ownerId) fail("ownerId", "OWNER_ID_MISMATCH");
    if (valid && ownerId !== null && typeof entry.legacyKey === "string") ownerByKey.set(entry.legacyKey, ownerId);
  });
  const groups = new Map<OwnerId, { owner: LegacyValidation["owners"][number]; ids: Set<string>; itemCount: number; imageBytes: bigint; location: string }>();
  entries.forEach(([key, items], ownerIndex) => {
    const location = `owners[${ownerIndex}]`;
    if (!mappingKeys.has(key)) error(location, "mapping", "MISSING_MAPPING");
    const ownerId = ownerByKey.get(key);
    let group = ownerId === undefined ? undefined : groups.get(ownerId);
    if (ownerId !== undefined && group === undefined) {
      group = { owner: { ownerId, items: [], images: new Map() }, ids: new Set(), itemCount: 0, imageBytes: 0n, location };
      groups.set(ownerId, group); result.owners.push(group.owner);
    }
    if (!Array.isArray(items)) { error(location, "items", "INVALID_OWNER_ITEMS"); return; }
    if (group) group.itemCount += items.length;
    const localIds = new Set<string>();
    let localImageBytes = 0n;
    items.forEach((item: unknown, itemIndex: number) => {
      const itemLocation = `${location}.items[${itemIndex}]`;
      if (!record(item)) { error(itemLocation, "item", "INVALID_ITEM"); return; }
      const before = result.errors.length;
      if (Buffer.byteLength(JSON.stringify(item), "utf8") > config.limits.jsonBytes) error(itemLocation, "jsonBytes", "PAYLOAD_TOO_LARGE");
      if (Object.keys(item).some((field) => !allowedFields.has(field))) error(itemLocation, "fields", "UNKNOWN_FIELD");
      for (const field of requiredFields) if (!Object.hasOwn(item, field)) error(itemLocation, field, "MISSING_FIELD");
      for (const field of requiredFields) {
        if (!Object.hasOwn(item, field)) continue;
        try {
          if (field === "id") parseReminderId(item[field]);
          else if (field === "createdAt") {
            if (typeof item[field] !== "string") throw new Error("invalid");
            normalizeInstant(item[field]);
          } else parsePatch({ [field]: item[field] });
        } catch { error(itemLocation, field, "INVALID_INPUT"); }
      }
      if (typeof item.id === "string") {
        const ids = group?.ids ?? localIds;
        if (ids.has(item.id)) error(itemLocation, "id", "DUPLICATE_ID");
        ids.add(item.id);
      }
      let image: DecodedImage | null = null;
      const thumbnail = Object.hasOwn(item, "thumbnail") ? item.thumbnail : null;
      if (thumbnail !== null && typeof thumbnail !== "string") error(itemLocation, "thumbnail", "INVALID_INPUT");
      else {
        try {
          // Decode once with no second fixed admission cap, then account even oversized bytes.
          image = decodeThumbnail(thumbnail, Number.MAX_SAFE_INTEGER);
          if (image) {
            localImageBytes += BigInt(image.bytes);
            if (group) group.imageBytes += BigInt(image.bytes);
            if (image.bytes > config.limits.thumbnailBytes) error(itemLocation, "thumbnail", "THUMBNAIL_TOO_LARGE");
          }
        } catch { error(itemLocation, "thumbnail", "INVALID_THUMBNAIL"); }
      }
      if (result.errors.length !== before || group === undefined) return;
      const input = parseCreate(Object.fromEntries(Object.entries(item).filter(([field]) => field !== "createdAt")));
      const createdAt = normalizeInstant(item.createdAt as string);
      group.owner.items.push({ ...input, ownerId: group.owner.ownerId, thumbnail: null, createdAt, updatedAt: createdAt, revision: 1, deleted: false });
      if (image) group.owner.images.set(input.id, image);
    });
    // Also report quotas for source owners whose mapping is invalid; no owner silently disappears.
    if (!group) {
      if (items.length > config.limits.itemCount) error(location, "itemCount", "OWNER_STORAGE_LIMIT_EXCEEDED");
      if (localImageBytes > BigInt(config.limits.imageBytes)) error(location, "imageBytes", "OWNER_STORAGE_LIMIT_EXCEEDED");
    }
  });
  for (const group of groups.values()) {
    if (group.itemCount > config.limits.itemCount) error(group.location, "itemCount", "OWNER_STORAGE_LIMIT_EXCEEDED");
    if (group.imageBytes > BigInt(config.limits.imageBytes)) error(group.location, "imageBytes", "OWNER_STORAGE_LIMIT_EXCEEDED");
  }
  return result;
}
