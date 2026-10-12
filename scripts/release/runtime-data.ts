import {isDeepStrictEqual} from "node:util";
import {z} from "zod";
const names = ["reminders", "owner_state", "image_jobs"] as const;
const restoredSchema = z.record(z.string(), z.string().regex(/^[A-Za-z0-9_.-]{3,64}$/));
export function selectedRuntimeData(input: Record<string, unknown>) {
  const account = z.string().regex(/^[0-9]{12}$/).parse(input.account_id);
  const region = z.string().regex(/^[a-z]{2}-[a-z]+-[1-9][0-9]*$/).parse(input.region);
  const prefix = z.string().regex(/^[a-z][a-z0-9-]{1,24}[a-z0-9]$/).parse(input.name_prefix);
  const restored = restoredSchema.parse(input.restored_tables ?? {});
  const original = Object.fromEntries(names.map(key => [key, `${prefix}-production-${key.replaceAll("_", "-")}`]));
  if (Object.keys(restored).length && (!isDeepStrictEqual(Object.keys(restored).sort(), [...names].sort()) || new Set(Object.values(restored)).size !== 3 || Object.values(restored).some(name => Object.values(original).includes(name)))) throw Error("Invalid complete restored table selection");
  const selected = {...original, ...restored};
  return {reminders_table:selected.reminders!, owner_state_table:selected.owner_state!, image_jobs_table:selected.image_jobs!, images_bucket:`${prefix}-${account}-${region}-images`, restored_tables:restored};
}
export function requireRuntimeData(input: Record<string, unknown>) {
  const selected = selectedRuntimeData(input);
  for (const key of ["reminders_table", "owner_state_table", "image_jobs_table", "images_bucket"] as const) if (input[key] !== selected[key]) throw Error("Runtime data selection mismatch");
  return selected;
}
export function runtimeDataEnvironment(data: ReturnType<typeof selectedRuntimeData>) {
  return {REMINDERS_TABLE:data.reminders_table, OWNER_STATE_TABLE:data.owner_state_table, IMAGE_JOBS_TABLE:data.image_jobs_table, IMAGES_BUCKET:data.images_bucket};
}
export function verifyRuntimeDataOutputs(outputs: Record<string, unknown>, inputs: Record<string, unknown>): void {
  const actual = z.record(z.string(),z.unknown()).parse(outputs.runtime_data).value;
  if (!isDeepStrictEqual(actual, requireRuntimeData(inputs))) throw Error("Post-apply runtime data mismatch");
}
