import { createHash } from "node:crypto";
import { ApiError } from "../shared/errors";
import type { ActiveReminder, ReminderDto, Representation } from "./types";

/** This insertion order is the canonical public representation used for HTTP and ETags. */
export function represent(item: ActiveReminder): Representation {
  const dto: ReminderDto = {
    id: item.id, url: item.url, title: item.title, reminderTime: item.reminderTime,
    autoOpen: item.autoOpen, webPush: item.webPush, hidden: item.hidden,
    revision: item.revision, createdAt: item.createdAt, updatedAt: item.updatedAt,
    thumbnail: item.thumbnail === null ? null : {
      imageId: item.thumbnail.imageId, mime: item.thumbnail.mime,
      bytes: item.thumbnail.bytes, sha256: item.thumbnail.sha256,
    },
  };
  const body = JSON.stringify(dto);
  const hash = createHash("sha256").update(body, "utf8").digest("hex");
  return { dto, body, etag: `"r${item.revision}-${hash}"` };
}

export function parseIfMatch(value: string | undefined): string {
  if (value === undefined) throw new ApiError(428, "PRECONDITION_REQUIRED", "If-Match is required");
  // HTTP etagc: !, # through ~, or obs-text. A comma inside the quotes is opaque data.
  if (!/^"[\x21\x23-\x7e\x80-\xff]*"$/.test(value)) {
    throw new ApiError(422, "INVALID_IF_MATCH", "If-Match must contain one strong entity-tag");
  }
  return value;
}
