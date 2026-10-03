import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { loadConfig } from "../../src/config";
import { decodeThumbnail } from "../../src/images/validation";
import { represent, parseIfMatch } from "../../src/reminders/representation";
import { normalizeInstant, parseCreate, parsePatch } from "../../src/reminders/validation";
import { ApiError } from "../../src/shared/errors";
import { keys } from "../../src/shared/ports";
import { activeReminder, validCreate } from "../support/fixtures";

function rejects422(action: () => unknown): void {
  assert.throws(action, (error: unknown) => error instanceof ApiError && error.status === 422);
}
const signatures = [
  { mime: "image/png", data: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]) },
  { mime: "image/jpeg", data: Buffer.from([255, 216, 255, 224]) },
  { mime: "image/gif", data: Buffer.from("GIF89a", "ascii") },
  { mime: "image/webp", data: Buffer.from("RIFF\x04\x00\x00\x00WEBP", "binary") },
];

void test("normalizes_real_offset_dates", () => {
  assert.equal(normalizeInstant("2026-10-03T09:00:00+09:00"), "2026-10-03T00:00:00.000Z");
  assert.equal(normalizeInstant("2000-02-29T23:59:59.123456-01:00"), "2000-03-01T00:59:59.123Z");
  assert.equal(normalizeInstant("1999-12-31T23:00:00-01:00"), "2000-01-01T00:00:00.000Z");
  assert.equal(parseCreate(validCreate({ reminderTime: "2000-01-01T00:00:00Z" })).reminderTime, "2000-01-01T00:00:00.000Z");
  assert.equal(parsePatch({ reminderTime: "2026-10-03T09:00:00+09:00" }).reminderTime, "2026-10-03T00:00:00.000Z");
  for (const value of ["2026-02-30T09:00:00Z", "1900-02-29T09:00:00+09:00", "2026-04-31T00:00:00-03:00", "2026-00-01T00:00:00Z", "2026-13-01T00:00:00Z", "2026-01-00T00:00:00Z", "2026-10-03T00:00:00", "2026-10-03T24:00:00Z", "2026-10-03T00:60:00Z", "2026-10-03T00:00:60Z", "2026-10-03T00:00:00+24:00", "2026-10-03T00:00:00+09:60", "2026-10-03"]) rejects422(() => normalizeInstant(value));
});

void test("rejects_readonly_unknown_and_coercion", () => {
  for (const name of ["hidden", "autoOpen", "webPush"]) for (const value of ["false", 0, null]) rejects422(() => parseCreate({ ...validCreate(), [name]: value }));
  for (const name of ["revision", "createdAt", "updatedAt", "ownerId", "deleted", "migrationRunId", "unknown"]) {
    rejects422(() => parseCreate({ ...validCreate(), [name]: "private" }));
    rejects422(() => parsePatch({ [name]: "private" }));
  }
  rejects422(() => parsePatch({ id: "different" }));
  rejects422(() => parsePatch({}));
  rejects422(() => parsePatch({ title: undefined }));
  rejects422(() => parseCreate(null));
  rejects422(() => parseCreate([]));
  rejects422(() => parseCreate({ ...validCreate(), title: 123 }));
  const { thumbnail: _thumbnail, ...withoutThumbnail } = validCreate();
  assert.equal(parseCreate(withoutThumbnail).thumbnail, null);
  assert.deepEqual(parsePatch({ hidden: false }), { hidden: false });
  assert.deepEqual(parsePatch({ thumbnail: "" }), { thumbnail: null });
  assert.deepEqual(parsePatch({ thumbnail: null }), { thumbnail: null });
});

void test("enforces_unicode_id_and_title_boundaries", () => {
  for (const id of ["a", "😀".repeat(128)]) assert.equal(parseCreate(validCreate({ id })).id, id);
  for (const id of ["", "😀".repeat(129), "a\u0000b", "a\nb", "a\u007fb", "a\u0085b"]) rejects422(() => parseCreate(validCreate({ id })));
  assert.equal(parseCreate(validCreate({ title: "😀".repeat(1024) })).title, "😀".repeat(1024));
  rejects422(() => parseCreate(validCreate({ title: "😀".repeat(1025) })));
  rejects422(() => parsePatch({ title: "x".repeat(1025) }));
});

void test("enforces_http_url_and_length_boundaries", () => {
  for (const url of ["http://example.test/path", "https://example.test/path", "https://example.test/" + "a".repeat(4075)]) assert.equal(parseCreate(validCreate({ url })).url, url);
  for (const url of ["ftp://example.test", "javascript:alert(1)", "/relative", "https://", "https://example.test/" + "a".repeat(4076)]) rejects422(() => parseCreate(validCreate({ url })));
});

void test("validates_original_image_bytes", () => {
  for (const { mime, data } of signatures) for (const value of [data.toString("base64"), `data:${mime};base64,${data.toString("base64")}`]) {
    const decoded = decodeThumbnail(value); assert.ok(decoded);
    assert.equal(decoded.mime, mime);
    assert.equal(decoded.bytes, data.byteLength);
    assert.deepEqual(Buffer.from(decoded.data), data);
    assert.equal(decoded.sha256, createHash("sha256").update(data).digest("hex"));
  }
  assert.equal(decodeThumbnail(""), null);
  assert.equal(decodeThumbnail(null), null);
  assert.equal(decodeThumbnail(Buffer.from("GIF87a").toString("base64"))?.mime, "image/gif");
});

void test("rejects_noncanonical_base64_and_mime_mismatch", () => {
  const png = signatures[0]; assert.ok(png); const base64 = png.data.toString("base64");
  for (const value of [base64.slice(0, -1), base64 + "=", base64 + "\n", base64.replace("=", "!"), base64.replace("o=", "p="), "%%%", `data:image/jpeg;base64,${base64}`, `data:image/png,${base64}`, "data:image/png;base64,", Buffer.from("<svg></svg>").toString("base64"), Buffer.from("<html></html>").toString("base64"), Buffer.from("BMbitmap").toString("base64")]) rejects422(() => decodeThumbnail(value));
});

void test("enforces_original_image_byte_limit", () => {
  const png = signatures[0]; assert.ok(png); const exact = Buffer.alloc(1_048_576); png.data.copy(exact);
  assert.equal(decodeThumbnail(exact.toString("base64"))?.bytes, 1_048_576);
  rejects422(() => decodeThumbnail(Buffer.concat([exact, Buffer.from([0])]).toString("base64")));
  rejects422(() => decodeThumbnail("A".repeat(1_398_108)));
});

void test("etag_depends_on_exact_representation", () => {
  const result = represent(activeReminder());
  const body = '{"id":"reminder-1","url":"https://example.test/reminder","title":"Test reminder","reminderTime":"2026-10-03T00:00:00.000Z","autoOpen":false,"webPush":true,"hidden":false,"revision":1,"createdAt":"2026-10-01T00:00:00.000Z","updatedAt":"2026-10-01T00:00:00.000Z","thumbnail":null}';
  assert.equal(result.body, body);
  assert.equal(result.etag, `"r1-${createHash("sha256").update(body, "utf8").digest("hex")}"`);
  assert.equal(result.body, represent(activeReminder()).body);
  assert.notEqual(result.etag, represent(activeReminder({ title: "changed" })).etag);
  assert.notEqual(result.etag, represent(activeReminder({ title: "😀" })).etag);
  assert.notEqual(result.etag, represent(activeReminder({ revision: 2 })).etag);
  assert.deepEqual(JSON.parse(result.body), result.dto);
  assert.equal("ownerId" in result.dto, false); assert.equal("deleted" in result.dto, false);
});

void test("representation_exposes_only_public_image_fields", () => {
  const thumbnail = { imageId: "image-1", key: "private-key", versionId: "private-version", mime: "image/png", bytes: 8, sha256: "b".repeat(64) };
  const result = represent(activeReminder({ thumbnail, migrationRunId: "private-run" }));
  assert.deepEqual(result.dto.thumbnail, { imageId: "image-1", mime: "image/png", bytes: 8, sha256: "b".repeat(64) });
  assert.equal(result.body.includes("private"), false);
  assert.equal(result.etag, represent(activeReminder({ thumbnail: { ...thumbnail, key: "other-key", versionId: "other-version" } })).etag);
  assert.notEqual(result.etag, represent(activeReminder({ thumbnail: { ...thumbnail, bytes: 9 } })).etag);
});

void test("requires_single_strong_if_match", () => {
  assert.throws(() => parseIfMatch(undefined), (error: unknown) => error instanceof ApiError && error.status === 428);
  for (const value of ['"r1-hash"', '"other"', '""', '"a,b"']) assert.equal(parseIfMatch(value), value);
  for (const value of ['W/"r1-hash"', '*', '"a", "b"', '', 'unquoted', '"unterminated', '"bad"quote"', '"line\nbreak"', '"space here"']) rejects422(() => parseIfMatch(value));
});

const configEnv: NodeJS.ProcessEnv = { AWS_REGION: "ap-northeast-1", REMINDERS_TABLE: "reminders", OWNER_STATE_TABLE: "owners", IMAGE_JOBS_TABLE: "jobs", IMAGES_BUCKET: "images", EXPECTED_API_ID: "api123", EXPECTED_API_STAGE: "$default", COGNITO_ISSUER: "https://cognito-idp.ap-northeast-1.amazonaws.com/test", COGNITO_CLIENT_ID: "client123" };

void test("loads_configuration_defaults_and_integer_overrides", () => {
  const defaults = loadConfig(configEnv);
  assert.equal(defaults.region, "ap-northeast-1"); assert.equal(defaults.expectedStage, "$default"); assert.deepEqual(defaults.sourceIps, []);
  assert.deepEqual(defaults.limits, { jsonBytes: 2_097_152, thumbnailBytes: 1_048_576, itemCount: 1000, imageBytes: 134_217_728, ownerRequestsPerMinute: 120 });
  const config = loadConfig({ ...configEnv, MAX_JSON_BYTES: "20", MAX_THUMBNAIL_BYTES: "10", MAX_OWNER_ITEMS: "2", MAX_OWNER_IMAGE_BYTES: "100", OWNER_REQUESTS_PER_MINUTE: "3", ALLOWED_SOURCE_IPS: '["127.0.0.1","2001:db8::1"]' });
  assert.deepEqual(config.sourceIps, ["127.0.0.1", "2001:db8::1"]);
  assert.deepEqual(config.limits, { jsonBytes: 20, thumbnailBytes: 10, itemCount: 2, imageBytes: 100, ownerRequestsPerMinute: 3 });
});

void test("rejects_invalid_configuration_without_leaking_values", () => {
  for (const value of ["1.5", "1e3", "-1", "0", " 1", "1 ", "Infinity", "9007199254740992", ""]) assert.throws(() => loadConfig({ ...configEnv, MAX_OWNER_ITEMS: value }));
  for (const value of ['["example.test"]', '["127.0.0.1/32"]', '[123]', '{}', 'not-json']) assert.throws(() => loadConfig({ ...configEnv, ALLOWED_SOURCE_IPS: value }));
  for (const name of Object.keys(configEnv)) assert.throws(() => loadConfig({ ...configEnv, [name]: "" }));
  assert.throws(() => loadConfig({ ...configEnv, ALLOWED_SOURCE_IPS: "private-invalid-value" }), (error: unknown) => error instanceof Error && !error.message.includes("private-invalid-value"));
});

void test("fixes_storage_key_formats", () => {
  assert.deepEqual(keys.storage("owner"), { pk: "OWNER#owner", sk: "STORAGE" });
  assert.deepEqual(keys.rate("owner", 123), { pk: "OWNER#owner", sk: "RATE#123" });
  assert.deepEqual(keys.publication, { pk: "GLOBAL", sk: "PUBLICATION" });
  assert.deepEqual(keys.migration("run"), { pk: "GLOBAL", sk: "MIGRATION#run" });
  assert.equal(keys.cleanupCheckpoint, "CHECKPOINT#cleanup");
  assert.equal(keys.image("owner", "00000000-0000-4000-8000-000000000000"), "images/owner/00000000-0000-4000-8000-000000000000");
  assert.equal(keys.rateExpiresAt(123), 180_180);
});


void test("rejects_trailing_line_breaks_in_dates_and_entity_tags", () => {
  rejects422(() => normalizeInstant("2026-10-03T00:00:00Z\n"));
  rejects422(() => parseIfMatch('"valid"\n'));
});

void test("requires_exact_gif_and_webp_signature_bytes", () => {
  for (const data of [Buffer.from("GIF89a"), Buffer.from("RIFF\x04\x00\x00\x00WEBP", "binary")]) {
    data[0] = (data[0] ?? 0) | 128;
    rejects422(() => decodeThumbnail(data.toString("base64")));
  }
});
