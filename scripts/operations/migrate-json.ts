import { readFile } from "node:fs/promises";
import { loadConfig } from "../../src/config";
import { readMigrationInputs, validateLegacy } from "./legacy";
import type { MigrationTarget } from "./legacy";

export interface OperationIO { stdout: (line: string) => void; stderr: (line: string) => void }

export function parseMigrationTarget(value: unknown): MigrationTarget {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("target");
  const target = value as Record<string, unknown>;
  const names: Record<string, string> = { region: "AWS_REGION", remindersTable: "REMINDERS_TABLE", ownerStateTable: "OWNER_STATE_TABLE", imageJobsTable: "IMAGE_JOBS_TABLE", imagesBucket: "IMAGES_BUCKET", expectedApiId: "EXPECTED_API_ID", expectedStage: "EXPECTED_API_STAGE", issuer: "COGNITO_ISSUER", clientId: "COGNITO_CLIENT_ID" };
  if (Object.keys(target).some((key) => !Object.hasOwn(names, key) && !["accountId", "sourceIps", "limits"].includes(key))) throw new Error("target");
  if (typeof target.accountId !== "string" || !/^\d{12}$/.test(target.accountId)) throw new Error("target");
  const env: NodeJS.ProcessEnv = {};
  for (const [field, name] of Object.entries(names)) {
    if (typeof target[field] !== "string") throw new Error("target");
    env[name] = target[field];
  }
  if (Object.hasOwn(target, "sourceIps")) env.ALLOWED_SOURCE_IPS = JSON.stringify(target.sourceIps);
  if (Object.hasOwn(target, "limits")) {
    if (typeof target.limits !== "object" || target.limits === null || Array.isArray(target.limits)) throw new Error("target");
    const limits = target.limits as Record<string, unknown>;
    const limitNames: Record<string, string> = { jsonBytes: "MAX_JSON_BYTES", thumbnailBytes: "MAX_THUMBNAIL_BYTES", itemCount: "MAX_OWNER_ITEMS", imageBytes: "MAX_OWNER_IMAGE_BYTES", ownerRequestsPerMinute: "OWNER_REQUESTS_PER_MINUTE" };
    for (const [field, limit] of Object.entries(limits)) {
      if (!Object.hasOwn(limitNames, field) || typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1) throw new Error("target");
      env[limitNames[field]!] = String(limit);
    }
  }
  return { ...loadConfig(env), accountId: target.accountId };
}

/** O01 admits dry-run only; intentionally imports no AWS adapters or SDK clients. */
export async function migrationMain(argv: string[], io: OperationIO): Promise<number> {
  const options = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]; const value = argv[index + 1];
    if (name === undefined || value === undefined || !["--mode", "--source", "--mapping", "--config"].includes(name) || options.has(name) || value.startsWith("--")) {
      io.stderr(JSON.stringify({ errors: [{ location: "arguments", field: "options", code: "INVALID_ARGUMENTS" }] }) + "\n"); return 2;
    }
    options.set(name, value);
  }
  if (options.size !== 4 || options.get("--mode") !== "dry-run") {
    io.stderr(JSON.stringify({ errors: [{ location: "arguments", field: "mode", code: "DRY_RUN_REQUIRED" }] }) + "\n"); return 2;
  }
  let target: MigrationTarget;
  try { target = parseMigrationTarget(JSON.parse(await readFile(options.get("--config")!, "utf8"))); }
  catch { io.stderr(JSON.stringify({ errors: [{ location: "config", field: "target", code: "INVALID_CONFIG" }] }) + "\n"); return 2; }
  let inputs;
  try { inputs = await readMigrationInputs(options.get("--source")!, options.get("--mapping")!); }
  catch { io.stderr(JSON.stringify({ errors: [{ location: "inputs", field: "files", code: "INPUT_READ_FAILED" }] }) + "\n"); return 2; }
  let source: string; let mapping: unknown; let invalidMapping = false;
  try { source = new TextDecoder("utf-8", { fatal: true }).decode(inputs.sourceBytes); }
  catch { io.stderr(JSON.stringify({ errors: [{ location: "source", field: "json", code: "INVALID_UTF8" }] }) + "\n"); return 2; }
  try { mapping = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(inputs.mappingBytes)); }
  catch { invalidMapping = true; }
  const validation = validateLegacy(source, mapping, target);
  if (invalidMapping) validation.errors.unshift({ location: "mapping", field: "json", code: "INVALID_JSON" });
  // Input counts include invalid records, so a failed check cannot look like a partial success.
  let owners = 0; let items = 0;
  try {
    const value: unknown = JSON.parse(source);
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const entries = Object.values(value); owners = entries.length;
      items = entries.reduce<number>((count, entry: unknown) => count + (Array.isArray(entry) ? entry.length : 0), 0);
    }
  } catch { /* Validation already holds the safe diagnostic. */ }
  io.stdout(JSON.stringify({ mode: "dry-run", valid: validation.errors.length === 0, owners, items,
    sourceBytes: inputs.sourceBytes.length, mappingBytes: inputs.mappingBytes.length,
    errors: validation.errors }) + "\n");
  return validation.errors.length === 0 ? 0 : 2;
}
if (require.main === module) {
  void migrationMain(process.argv.slice(2), { stdout: (line) => { process.stdout.write(line); }, stderr: (line) => { process.stderr.write(line); } })
    .then((code) => { process.exitCode = code; });
}
