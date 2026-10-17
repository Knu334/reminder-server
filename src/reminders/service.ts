import { decodeThumbnail } from "../images/validation";
import { stageThumbnail } from "../images/upload";
import type { ImageRef } from "../images/types";
import type { Config } from "../config";
import type { Budget, ImagesStore, JobsStore, OwnerStore, RemindersStore } from "../shared/ports";
import type { ActiveReminder, ChangeSet, CreateInput, OwnerId, PatchInput, ReminderDto, Representation } from "./types";
import { ApiError } from "../shared/errors";
import { requireBudget } from "../shared/budget";
import { decodeCursor, encodeCursor, parseLimit } from "./cursor";
import { parseIfMatch, represent } from "./representation";
import { parseCreate, parsePatch, parseReminderId } from "./validation";

export interface ReminderDeps {
  reminders: RemindersStore; owners: OwnerStore; jobs: JobsStore; images: ImagesStore;
  clock: () => number; uuid: () => string; config: Config;
}
export interface RemindersService {
  list(ownerId: OwnerId, limit: number, cursor: string | null, budget: Budget): Promise<{ items: ReminderDto[]; nextCursor: string | null }>;
  get(ownerId: OwnerId, id: string, budget: Budget): Promise<Representation>;
  thumbnailUrl(ownerId: OwnerId, id: string, budget: Budget): Promise<{ url: string; expiresAt: string; imageId: string; revision: number }>;
  create(ownerId: OwnerId, input: CreateInput, budget: Budget): Promise<Representation>;
  patch(ownerId: OwnerId, id: string, etag: string | undefined, input: PatchInput, budget: Budget): Promise<Representation>;
  remove(ownerId: OwnerId, id: string, etag: string | undefined, budget: Budget): Promise<{ id: string; deleted: true; revision: number }>;
}
export function createRemindersService(deps: ReminderDeps): RemindersService {
  async function current(ownerId: OwnerId, id: string, budget: Budget): Promise<ActiveReminder> {
    requireBudget(budget);
    const record = await deps.reminders.get(ownerId, parseReminderId(id), budget);
    if (record === null || record.deleted) throw new ApiError(404, "REMINDER_NOT_FOUND", "Reminder not found");
    return record;
  }
  function timestamp(): string { return new Date(deps.clock()).toISOString(); }
  function precondition(previous: ActiveReminder, etag: string): void {
    if (represent(previous).etag !== etag) throw new ApiError(412, "PRECONDITION_FAILED", "Reminder has changed");
    if (previous.revision === Number.MAX_SAFE_INTEGER) throw new ApiError(503, "SERVICE_UNAVAILABLE", "Service temporarily unavailable");
  }
  function retire(previous: ActiveReminder, atMs: number): ChangeSet["jobs"] {
    return previous.thumbnail === null ? [] : [{ jobId: previous.thumbnail.imageId, from: "committed", to: "retired", atMs, expectedVersionId: previous.thumbnail.versionId }];
  }
  function commitImage(ref: ImageRef | null, atMs: number): ChangeSet["jobs"] {
    return ref === null ? [] : [{ jobId: ref.imageId, from: "pending", to: "committed", atMs, expectedVersionId: ref.versionId }];
  }
  return {
    async list(ownerId, limit, cursor, budget) {
      requireBudget(budget);
      const page = await deps.reminders.query(ownerId, parseLimit(limit), cursor === null ? null : decodeCursor(cursor, ownerId), budget);
      return { items: page.records.flatMap(record => record.deleted ? [] : [represent(record).dto]), nextCursor: page.lastId === null ? null : encodeCursor(ownerId, page.lastId) };
    },
    async get(ownerId, id, budget) { return represent(await current(ownerId, id, budget)); },
    async thumbnailUrl(ownerId, id, budget) {
      const record = await current(ownerId, id, budget);
      if (record.thumbnail === null) throw new ApiError(404, "THUMBNAIL_NOT_FOUND", "Thumbnail not found");
      const expiresAt = new Date(deps.clock() + 900_000).toISOString();
      const url = await deps.images.signGet(record.thumbnail, 900, budget);
      return { url, expiresAt, imageId: record.thumbnail.imageId, revision: record.revision };
    },
    async create(ownerId, input, budget) {
      requireBudget(budget);
      const parsed = parseCreate(input); const decoded = decodeThumbnail(parsed.thumbnail, deps.config.limits.thumbnailBytes);
      const thumbnail = decoded === null ? null : await stageThumbnail(ownerId, decoded, deps, budget);
      const at = timestamp();
      const next: ActiveReminder = { ...parsed, ownerId, revision: 1, createdAt: at, updatedAt: at, thumbnail, deleted: false };
      await deps.reminders.commit({ ownerId, previous: null, next, itemDelta: 1, byteDelta: thumbnail?.bytes ?? 0, jobs: commitImage(thumbnail, Date.parse(at)), clientRequestToken: deps.uuid() }, budget);
      return represent(next);
    },
    async patch(ownerId, id, etag, input, budget) {
      const expected = parseIfMatch(etag); const parsed = parsePatch(input);
      const decoded = parsed.thumbnail === undefined ? undefined : decodeThumbnail(parsed.thumbnail, deps.config.limits.thumbnailBytes);
      const previous = await current(ownerId, id, budget); precondition(previous, expected);
      const uploaded = decoded === undefined || decoded === null ? null : await stageThumbnail(ownerId, decoded, deps, budget);
      const at = timestamp(); const { thumbnail, ...fields } = parsed;
      const next: ActiveReminder = { ...previous, ...fields, revision: previous.revision + 1, updatedAt: at, thumbnail: thumbnail === undefined ? previous.thumbnail : uploaded };
      const changedImage = thumbnail !== undefined;
      await deps.reminders.commit({ ownerId, previous, next, itemDelta: 0, byteDelta: (next.thumbnail?.bytes ?? 0) - (previous.thumbnail?.bytes ?? 0),
        jobs: changedImage ? [...commitImage(uploaded, Date.parse(at)), ...retire(previous, Date.parse(at))] : [], clientRequestToken: deps.uuid() }, budget);
      return represent(next);
    },
    async remove(ownerId, id, etag, budget) {
      const expected = parseIfMatch(etag); const previous = await current(ownerId, id, budget); precondition(previous, expected);
      const at = timestamp(); const next = { ownerId, id: previous.id, deleted: true as const, revision: previous.revision + 1, deletedAt: at };
      await deps.reminders.commit({ ownerId, previous, next, itemDelta: -1, byteDelta: -(previous.thumbnail?.bytes ?? 0), jobs: retire(previous, Date.parse(at)), clientRequestToken: deps.uuid() }, budget);
      return { id: next.id, deleted: true, revision: next.revision };
    },
  };
}
