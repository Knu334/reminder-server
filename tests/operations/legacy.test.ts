import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { ownerIdFor } from "../../src/api/identity";
import { loadConfig } from "../../src/config";
import { contractSha256For, readMigrationInputs, validateLegacy } from "../../scripts/operations/legacy";
import { migrationMain, parseMigrationTarget } from "../../scripts/operations/migrate-json";

const config = loadConfig({ AWS_REGION: "us-east-1", REMINDERS_TABLE: "synthetic-reminders", OWNER_STATE_TABLE: "synthetic-owners", IMAGE_JOBS_TABLE: "synthetic-jobs", IMAGES_BUCKET: "synthetic-images", EXPECTED_API_ID: "synthetic-api", EXPECTED_API_STAGE: "synthetic", COGNITO_ISSUER: "https://synthetic.invalid/pool", COGNITO_CLIENT_ID: "synthetic-client" });
const png = "iVBORw0KGgo=";
const legacy = (changes: Record<string, unknown> = {}) => ({ id: "id/%/🌱", url: "https://synthetic.invalid/canary-url", title: "canary-title", reminderTime: "2026-10-03T09:00:00+09:00", autoOpen: false, webPush: true, hidden: false, thumbnail: png, createdAt: "2026-10-03T09:00:00+09:00", ...changes });
const mapping = (legacyKey = "canary-owner", sub = "non-uuid-sub") => ({ legacyKey, issuer: config.issuer, sub });
const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

// Catches first-error-only validation and unsafe diagnostic paths/fields.
void test("legacy_validates_all_errors_before_writes", () => {
  const source = JSON.stringify({ "canary-owner": [legacy({ id: "duplicate" }), legacy({ id: "duplicate" }), legacy({ id: "\ud800", reminderTime: "2026-10-03T00:00:00", createdAt: "2026-02-30T00:00:00Z", title: undefined, "canary-unknown": true, thumbnail: "canary-base64" }), legacy({ thumbnail: `data:image/jpeg;base64,${png}` }), legacy({ id: "over-size" })], "canary-other": "not-array" });
  const report = validateLegacy(source, [mapping(), mapping("canary-other")], { ...config, limits: { ...config.limits, thumbnailBytes: 7, itemCount: 1, imageBytes: 7 } });
  for (const [location, field, code] of [
    ["owners[0].items[1]", "id", "DUPLICATE_ID"],
    ["owners[0].items[2]", "id", "INVALID_INPUT"],
    ["owners[0].items[2]", "reminderTime", "INVALID_INPUT"],
    ["owners[0].items[2]", "createdAt", "INVALID_INPUT"],
    ["owners[0].items[2]", "title", "MISSING_FIELD"],
    ["owners[0].items[2]", "fields", "UNKNOWN_FIELD"],
    ["owners[0].items[2]", "thumbnail", "INVALID_THUMBNAIL"],
    ["owners[0].items[3]", "thumbnail", "INVALID_THUMBNAIL"],
    ["owners[0].items[4]", "thumbnail", "THUMBNAIL_TOO_LARGE"],
    ["owners[0]", "itemCount", "OWNER_STORAGE_LIMIT_EXCEEDED"],
    ["owners[0]", "imageBytes", "OWNER_STORAGE_LIMIT_EXCEEDED"],
    ["owners[1]", "items", "INVALID_OWNER_ITEMS"],
  ]) assert.ok(report.errors.some((error) => error.location === location && error.field === field && error.code === code), `${location}/${field}/${code}`);
  assert.equal(report.owners.length, 1); // Invalid source owner still contributes diagnostics; no writes occur.
  assert.doesNotMatch(JSON.stringify(report.errors), /canary|synthetic\.invalid|iVBOR/);
  assert.deepEqual(validateLegacy("{broken", [], config).errors, [{ location: "source", field: "json", code: "INVALID_JSON" }]);
  assert.ok(validateLegacy("[]", [], config).errors.some((error) => error.code === "INVALID_SOURCE"));
});

void test("own_properties_and_empty_owners_are_preserved", () => {
  const syntheticSpecialKeyMap = [mapping("__proto__", "first"), mapping("constructor", "second")];
  const report = validateLegacy('{"__proto__":[],"constructor":[]}', syntheticSpecialKeyMap, config);
  assert.equal(report.errors.length, 0);
  assert.equal(report.owners.length, 2);
  assert.equal(report.owners[0]?.items.length, 0);
  assert.notEqual(report.owners[0]?.ownerId, report.owners[1]?.ownerId);
});

void test("owner_mapping_must_match_issuer_sub", () => {
  const source = JSON.stringify({ first: [legacy()], second: [legacy()] });
  const valid = validateLegacy(source, [mapping("first"), mapping("second")], config);
  assert.equal(valid.owners.length, 1);
  assert.ok(valid.errors.some((error) => error.location === "owners[1].items[0]" && error.code === "DUPLICATE_ID"));
  const bad = validateLegacy(source, [mapping("first"), { ...mapping("first"), issuer: "wrong", sub: "", ownerId: "wrong", extra: true }, mapping("extra")], config);
  for (const code of ["DUPLICATE_MAPPING", "ISSUER_MISMATCH", "INVALID_SUB", "OWNER_ID_MISMATCH", "UNKNOWN_FIELD", "EXTRA_MAPPING", "MISSING_MAPPING"]) assert.ok(bad.errors.some((error) => error.code === code), code);
  assert.ok(validateLegacy(source, {}, config).errors.some((error) => error.code === "INVALID_MAPPING"));
  assert.ok(validateLegacy(source, [{ ...mapping("first"), ownerId: ownerIdFor(config.issuer, "non-uuid-sub") }, mapping("second", "second-sub")], config).errors.length === 0);
});

void test("normalizes_instants_without_changing_original_file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "o01-synthetic-"));
  try {
    const sourcePath = join(directory, "source.json"); const mappingPath = join(directory, "mapping.json");
    const original = Buffer.from(JSON.stringify({ "canary-owner": [legacy()] }));
    await writeFile(sourcePath, original); await writeFile(mappingPath, JSON.stringify([mapping()]));
    const inputs = await readMigrationInputs(sourcePath, mappingPath);
    assert.equal(inputs.sourceSha256, sha(original)); assert.equal(inputs.mappingSha256, sha(inputs.mappingBytes));
    const report = validateLegacy(inputs.sourceBytes.toString("utf8"), JSON.parse(inputs.mappingBytes.toString("utf8")), config);
    assert.equal(report.errors.length, 0);
    const normalized = report.owners[0]?.items[0]; assert.ok(normalized);
    assert.equal(normalized.id, "id/%/🌱"); assert.equal(normalized.reminderTime, "2026-10-03T00:00:00.000Z");
    assert.equal(normalized.createdAt, "2026-10-03T00:00:00.000Z"); assert.equal(normalized.updatedAt, normalized.createdAt); assert.equal(normalized.revision, 1);
    assert.equal(normalized.thumbnail, null); assert.equal(normalized.deleted, false);
    assert.deepEqual(Buffer.from(report.owners[0]!.images.get(normalized.id)!.data), Buffer.from(png, "base64"));
    assert.equal(sha(await readFile(sourcePath)), sha(original));
    assert.equal(sha(await readFile(mappingPath)), inputs.mappingSha256);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

// Catches a whole-file body cap and missing per-item admission checks.
void test("json_body_limit_is_per_original_reminder_not_aggregate_file", () => {
  const target = { ...config, limits: { ...config.limits, jsonBytes: 400 } };
  const source = JSON.stringify({ first: [legacy({ id: "first" })], second: [legacy({ id: "second" })] });
  assert.ok(Buffer.byteLength(source, "utf8") > target.limits.jsonBytes);
  assert.equal(validateLegacy(source, [mapping("first"), mapping("second", "other-sub")], target).errors.length, 0);
  const oversized = validateLegacy(JSON.stringify({ first: [legacy({ title: "🌱".repeat(200) })] }), [mapping("first")], target);
  assert.deepEqual(oversized.errors, [{ location: "owners[0].items[0]", field: "jsonBytes", code: "PAYLOAD_TOO_LARGE" }]);
});

void test("private_target_limits_apply_to_all_records_and_merged_owners", () => {
  const large = Buffer.alloc(1_048_577); Buffer.from(png, "base64").copy(large);
  const source = JSON.stringify({ first: [legacy({ thumbnail: large.toString("base64") })] });
  assert.equal(validateLegacy(source, [mapping("first")], { ...config, limits: { ...config.limits, jsonBytes: 3_000_000, thumbnailBytes: large.length } }).errors.length, 0);
  assert.ok(validateLegacy(source, [mapping("first")], config).errors.some((error) => error.code === "THUMBNAIL_TOO_LARGE"));
  const merged = validateLegacy(JSON.stringify({ first: [legacy({ id: "a" })], second: [legacy({ id: "b" })] }), [mapping("first"), mapping("second")], { ...config, limits: { ...config.limits, itemCount: 1, imageBytes: 15, jsonBytes: 1 } });
  for (const field of ["jsonBytes", "itemCount", "imageBytes"]) assert.ok(merged.errors.some((error) => error.field === field), field);
  const target = { ...config, accountId: "123456789012" };
  assert.equal(contractSha256For(target), contractSha256For({ ...target, limits: { ...target.limits } }));
  assert.notEqual(contractSha256For(target), contractSha256For({ ...target, limits: { ...target.limits, itemCount: 2 } }));
  assert.notEqual(contractSha256For(target), contractSha256For({ ...target, accountId: "234567890123" }));
});

// Catches coercion, ambient defaults, unknown override fields, and line-break account IDs.
void test("private_target_defaults_and_overrides_are_strict", () => {
  const { limits: _limits, ...base } = config;
  const defaults = parseMigrationTarget({ ...base, accountId: "123456789012" });
  assert.deepEqual(defaults.limits, { jsonBytes: 2_097_152, thumbnailBytes: 1_048_576, itemCount: 1000, imageBytes: 134_217_728, ownerRequestsPerMinute: 120 });
  const override = parseMigrationTarget({ ...base, accountId: "123456789012", limits: { thumbnailBytes: 2_000_000, itemCount: 2 } });
  assert.equal(override.limits.thumbnailBytes, 2_000_000); assert.equal(override.limits.itemCount, 2); assert.equal(override.limits.jsonBytes, 2_097_152);
  for (const changes of [ { accountId: "123456789012\n" }, { limits: { thumbnailBytes: "2000000" } }, { limits: { thumbnailBytes: 0 } }, { limits: { thumbnailBytes: 1.5 } }, { limits: { thumbnailBytes: Number.MAX_SAFE_INTEGER + 1 } }, { limits: { unknown: 1 } }, { unexpected: true }, { sourceIps: ["invalid"] } ]) {
    assert.throws(() => parseMigrationTarget({ ...base, accountId: "123456789012", ...changes }));
  }
});

void test("dry_run_reports_safe_counts_errors_and_never_loads_aws", async () => {
  const directory = await mkdtemp(join(tmpdir(), "o01-cli-synthetic-"));
  try {
    const sourcePath = join(directory, "source.json"); const mappingPath = join(directory, "mapping.json"); const targetPath = join(directory, "target.json");
    await writeFile(sourcePath, JSON.stringify({ "canary-owner": [legacy({ "canary-secret": true, title: undefined })] }));
    await writeFile(mappingPath, JSON.stringify([mapping()])); await writeFile(targetPath, JSON.stringify({ ...config, accountId: "123456789012" }));
    const out: string[] = []; const err: string[] = []; const io = { stdout: (line: string) => out.push(line), stderr: (line: string) => err.push(line) };
    const argv = ["--mode", "dry-run", "--source", sourcePath, "--mapping", mappingPath, "--config", targetPath];
    assert.equal(await migrationMain(argv, io), 2); assert.equal(err.length, 0);
    const report = JSON.parse(out.join("")); assert.equal(report.valid, false); assert.equal(report.items, 1); assert.equal(report.errors.length, 2);
    assert.doesNotMatch(out.join("") + err.join(""), /canary|synthetic\.invalid|iVBOR/);
    await writeFile(sourcePath, JSON.stringify({ "canary-owner": [legacy()] }));
    await writeFile(targetPath, JSON.stringify({ ...config, limits: undefined, accountId: "123456789012" }));
    assert.equal(await migrationMain(argv, io), 0);
    await writeFile(targetPath, JSON.stringify({ ...config, accountId: "123456789012", limits: { ...config.limits, thumbnailBytes: 7 } }));
    assert.equal(await migrationMain(argv, io), 2);
    await writeFile(mappingPath, "{canary-broken"); assert.equal(await migrationMain(argv, io), 2);
    await writeFile(targetPath, JSON.stringify({ ...config, accountId: "123456789012", limits: { ...config.limits, itemCount: 0 } })); assert.equal(await migrationMain(argv, io), 2);
    assert.equal(await migrationMain(["--mode", "execute"], io), 2);
    assert.equal(await migrationMain([...argv, "--source", sourcePath], io), 2);
    assert.doesNotMatch(out.join("") + err.join(""), /canary|synthetic\.invalid|iVBOR/);
    const preload = join(directory, "deny-aws.cjs");
    await writeFile(preload, 'const Module = require("node:module"); const original = Module._load; Module._load = function (id, ...args) { if (id.startsWith("@aws-sdk/")) throw new Error("AWS_CLIENT_FORBIDDEN"); return original.call(this, id, ...args); };');
    const child = spawnSync(process.execPath, ["--require", preload, "--import", "tsx", "scripts/operations/migrate-json.ts", "--mode", "dry-run", "--source", "tests/fixtures/synthetic/legacy-valid.json", "--mapping", "tests/fixtures/synthetic/owner-map.json", "--config", "tests/fixtures/synthetic/target.json"], { encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr); assert.equal(JSON.parse(child.stdout).valid, true);
    await writeFile(sourcePath, JSON.stringify({ "canary-owner": [legacy({ title: undefined, "canary-secret": true })] }));
    await writeFile(mappingPath, JSON.stringify([mapping()])); await writeFile(targetPath, JSON.stringify({ ...config, accountId: "123456789012" }));
    const invalidChild = spawnSync(process.execPath, ["--require", preload, "--import", "tsx", "scripts/operations/migrate-json.ts", ...argv], { encoding: "utf8" });
    assert.equal(invalidChild.status, 2, invalidChild.stderr);
    assert.equal(JSON.parse(invalidChild.stdout).errors.length, 2);
    assert.doesNotMatch(invalidChild.stdout + invalidChild.stderr, /canary|AWS_CLIENT_FORBIDDEN/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
