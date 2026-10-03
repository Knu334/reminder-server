import { readFile } from "node:fs/promises";
import { loadConfig } from "../../src/config";
import { contractSha256For, environmentIdentityFor, readMigrationInputs, validateLegacy } from "./legacy";
import type { LegacyValidation, MigrationIdentity, MigrationTarget } from "./legacy";
import type { MigrationDeps } from "./migration";

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

export interface MigrationRuntime {
  createDeps(target: MigrationTarget, identity: MigrationIdentity, validation: LegacyValidation): Promise<MigrationDeps>;
}
/** Dry-run performs no AWS imports. Explicit modes load the runtime only after full O01 validation. */
export async function migrationMain(argv: string[], io: OperationIO, runtime?: MigrationRuntime): Promise<number> {
  const options = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]; const value = argv[index + 1];
    if (name === undefined || value === undefined || !["--mode", "--source", "--mapping", "--config", "--run-id"].includes(name) || options.has(name) || value.startsWith("--")) {
      io.stderr(JSON.stringify({ errors: [{ location: "arguments", field: "options", code: "INVALID_ARGUMENTS" }] }) + "\n"); return 2;
    }
    options.set(name, value);
  }
  const mode = options.get("--mode");
  const explicit = mode === "import" || mode === "verify" || mode === "publish";
  if ((!explicit && mode !== "dry-run") || !["--source", "--mapping", "--config"].every(name => options.has(name))
    || (explicit ? options.size !== 5 || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(options.get("--run-id") ?? "") : options.size !== 4)) {
    io.stderr(JSON.stringify({ errors: [{ location: "arguments", field: "mode", code: "MODE_OR_RUN_ID_REQUIRED" }] }) + "\n"); return 2;
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
  if (explicit && validation.errors.length === 0) {
    const identity: MigrationIdentity = { runId: options.get("--run-id")!, sourceSha256: inputs.sourceSha256, mappingSha256: inputs.mappingSha256,
      contractSha256: contractSha256For(target), contractVersion: 1, environment: environmentIdentityFor(target) };
    try {
      const deps = runtime ? await runtime.createDeps(target, identity, validation)
        : await (await import("./migration-store")).createMigrationDeps(target, identity, validation);
      const migration = await import("./migration");
      if (mode === "import") io.stdout(JSON.stringify({ mode, ...await migration.importMigration(identity, validation, deps) }) + "\n");
      else {
        const verification = await migration.verifyMigration(identity, validation, deps);
        if (mode === "publish") await migration.publishMigration(identity, verification, deps);
        io.stdout(JSON.stringify({ mode, exactMatch: verification.exactMatch, mismatches: verification.mismatches }) + "\n");
        if (!verification.exactMatch) return 2;
      }
      return 0;
    } catch {
      io.stderr(JSON.stringify({ errors: [{ location: "migration", field: "operation", code: "MIGRATION_FAILED" }] }) + "\n"); return 2;
    }
  }
  io.stdout(JSON.stringify({ mode, valid: validation.errors.length === 0, owners, items,
    sourceBytes: inputs.sourceBytes.length, mappingBytes: inputs.mappingBytes.length,
    errors: validation.errors }) + "\n");
  return validation.errors.length === 0 ? 0 : 2;
}
if (require.main === module) {
  void migrationMain(process.argv.slice(2), { stdout: (line) => { process.stdout.write(line); }, stderr: (line) => { process.stderr.write(line); } })
    .then((code) => { process.exitCode = code; });
}
