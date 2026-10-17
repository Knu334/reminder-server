import type { ImageRef, JobTransition } from "../images/types";

/** Lowercase SHA-256 hex produced by the owner-identity boundary. */
export type OwnerId = string;
export interface ReminderFields {
  id: string;
  url: string;
  title: string;
  reminderTime: string;
  autoOpen: boolean;
  webPush: boolean;
  hidden: boolean;
}
export interface ActiveReminder extends ReminderFields {
  ownerId: OwnerId;
  revision: number;
  createdAt: string;
  updatedAt: string;
  thumbnail: ImageRef | null;
  deleted: false;
  migrationRunId?: string;
}
export interface Tombstone {
  ownerId: OwnerId;
  id: string;
  revision: number;
  deletedAt: string;
  deleted: true;
  migrationRunId?: string;
}
export type StoredReminder = ActiveReminder | Tombstone;
export interface ReminderDto extends ReminderFields {
  revision: number;
  createdAt: string;
  updatedAt: string;
  thumbnail: Pick<ImageRef, "imageId" | "mime" | "bytes" | "sha256"> | null;
}
export interface CreateInput extends ReminderFields { thumbnail: string | null }
export type PatchInput = Partial<Omit<CreateInput, "id">>;
export interface Representation { dto: ReminderDto; body: string; etag: string }
export interface ChangeSet {
  ownerId: OwnerId;
  previous: ActiveReminder | null;
  next: StoredReminder;
  itemDelta: number;
  byteDelta: number;
  jobs: JobTransition[];
  clientRequestToken: string;
}
export interface QueryPage { records: StoredReminder[]; lastId: string | null }
