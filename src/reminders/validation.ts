import { z } from "zod";
import { ApiError } from "../shared/errors";
import type { CreateInput, PatchInput } from "./types";

function invalidInput(): never {
  throw new ApiError(422, "INVALID_INPUT", "Invalid reminder input");
}

/** Validate the written calendar date before applying its offset. Past dates are valid. */
export function normalizeInstant(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match) return invalidInput();
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (days === undefined || day < 1 || day > days || Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6]) > 59 || (match[8] !== "Z" && (Number(match[10]) > 23 || Number(match[11]) > 59))) return invalidInput();
  const instant = Date.parse(value);
  if (!Number.isFinite(instant)) return invalidInput();
  return new Date(instant).toISOString();
}

const codePoints = (value: string): number => Array.from(value).length;
const id = z.string().refine((value) => codePoints(value) >= 1 && codePoints(value) <= 128 && !/\p{Cc}/u.test(value));
const title = z.string().refine((value) => codePoints(value) <= 1024);
const url = z.string().refine((value) => {
  if (codePoints(value) > 4096) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch { return false; }
});
const fields = {
  url, title, reminderTime: z.string().transform(normalizeInstant),
  autoOpen: z.boolean(), webPush: z.boolean(), hidden: z.boolean(),
  thumbnail: z.string().nullable().transform((value) => value === "" ? null : value),
};
const create = z.strictObject({ id, ...fields, thumbnail: fields.thumbnail.default(null) });
const patch = z.strictObject(fields).partial();

export function parseCreate(value: unknown): CreateInput {
  const parsed = create.safeParse(value);
  if (!parsed.success) return invalidInput();
  return parsed.data;
}

export function parsePatch(value: unknown): PatchInput {
  const parsed = patch.safeParse(value);
  if (!parsed.success || Object.keys(parsed.data).length === 0 || Object.values(parsed.data).some((field) => field === undefined)) return invalidInput();
  // Explicit undefined is rejected above; absent fields stay absent under exactOptionalPropertyTypes.
  return parsed.data as PatchInput;
}

/** Use the same ID rules for decoded Gateway path parameters and reminder inputs. */
export function parseReminderId(value: unknown): string {
  const parsed = id.safeParse(value);
  if (!parsed.success) return invalidInput();
  return parsed.data;
}
