import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { GetObjectCommand, PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import {
  assertUsable,
  createS3CustodyStore,
  custodyPrefix,
  readCustody,
  readOriginalManifest,
  requiredFiles,
  writeCustody,
  type CustodyLocation,
  type CustodyManifest,
  type CustodyStore,
} from "../../scripts/release/custody";

// 合成の fixture だけを使う。fake の store は既存 key への put を PreconditionFailed 相当で拒否する。
class FakeStore implements CustodyStore {
  readonly objects = new Map<string, Uint8Array>();
  readonly order: string[] = [];
  readonly checksums: string[] = [];
  readonly gets: string[] = [];
  put(key: string, body: Uint8Array, sha256Base64: string): Promise<void> {
    if (this.objects.has(key)) {
      const e = new Error("At least one of the pre-conditions you specified did not hold");
      e.name = "PreconditionFailed";
      return Promise.reject(e);
    }
    this.objects.set(key, Uint8Array.from(body));
    this.order.push(key);
    this.checksums.push(sha256Base64);
    return Promise.resolve();
  }
  get(key: string): Promise<Uint8Array> {
    this.gets.push(key);
    const v = this.objects.get(key);
    if (!v) {
      const e = new Error("The specified key does not exist.");
      e.name = "NoSuchKey";
      return Promise.reject(e);
    }
    return Promise.resolve(Uint8Array.from(v));
  }
}
const hex = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const b64 = (b: Uint8Array | string) => createHash("sha256").update(b).digest("base64");
const sha = (c: string) => c.repeat(64);
const created = new Date("2026-10-12T00:00:00.000Z");
const later = (ms: number) => new Date(created.getTime() + ms);
const H = 3600_000,
  M = 60_000;
const platformReview = [
  "inputs.json",
  "baseline.json",
  "artifact.json",
  "request.json",
  "backend.hcl",
  "review.json",
  "saved.tfplan",
  "preview.json",
  "custody.json",
  "plan.txt",
];
const applicationReview = [
  ...platformReview,
  "registered.json",
  "audit.json",
  "sbom.json",
  "tests.txt",
  "platform-outputs.json",
];
const reviewLocation: CustodyLocation = { kind: "release-review", runId: "1234", runAttempt: 2 };
const temps: string[] = [];
after(async () => {
  for (const d of temps) await rm(d, { recursive: true, force: true });
});
async function temp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "custody-test-"));
  temps.push(d);
  return d;
}
async function source(names: readonly string[], extra: readonly string[] = []): Promise<string> {
  const d = await temp();
  for (const n of [...names, ...extra]) await writeFile(join(d, n), `synthetic ${n}\n`);
  return d;
}
async function reviewFields(d: string) {
  return {
    root: "platform" as const,
    planReviewSha256: sha("a"),
    custodySha256: hex(await readFile(join(d, "custody.json"))),
  };
}
async function writtenReview(store = new FakeStore(), location = reviewLocation) {
  const d = await source(platformReview);
  const r = await writeCustody(store, location, d, await reviewFields(d), created);
  return { store, d, ...r };
}
const expected = (
  now = later(H),
  extra: Partial<{
    root: "platform" | "application" | null;
    initialPlatform: boolean;
    inheritedExpiresAt: string;
  }> = {},
) => ({ root: "platform" as const, now, ...extra });
/** manifest を差し替えて store に置き、その SHA-256 を返す（改ざんの再現用）。 */
function replaceManifest(
  store: FakeStore,
  location: CustodyLocation,
  mutate: (m: Record<string, unknown>) => void,
): string {
  const key = `${custodyPrefix(location)}manifest.json`;
  const m = JSON.parse(Buffer.from(store.objects.get(key)!).toString()) as Record<string, unknown>;
  mutate(m);
  const bytes = Buffer.from(JSON.stringify(m, null, 2) + "\n");
  store.objects.set(key, bytes);
  return hex(bytes);
}
function manifest(over: Partial<CustodyManifest> = {}): CustodyManifest {
  return {
    version: 1,
    kind: "release-review",
    root: "platform",
    runId: "1",
    runAttempt: 1,
    createdAt: created.toISOString(),
    expiresAt: later(24 * H).toISOString(),
    files: {},
    planReviewSha256: sha("a"),
    custodySha256: sha("b"),
    ...over,
  };
}

void test("write_puts_every_file_with_checksum_then_manifest_last", async () => {
  const { store, manifestSha256, manifestSha256Base64 } = await writtenReview();
  assert.equal(custodyPrefix(reviewLocation), "release-review/1234/2/");
  assert.equal(
    custodyPrefix({ kind: "failure-diagnostics", runId: "9", runAttempt: 1, job: "plan" }),
    "failure-diagnostics/9/1/plan/",
  );
  assert.equal(store.order.length, platformReview.length + 1);
  assert.equal(store.order.at(-1), "release-review/1234/2/manifest.json");
  assert.deepEqual(
    new Set(store.order.slice(0, -1)),
    new Set(platformReview.map((n) => `release-review/1234/2/${n}`)),
  );
  store.order.forEach((key, i) => assert.equal(store.checksums[i], b64(store.objects.get(key)!)));
  const bytes = store.objects.get("release-review/1234/2/manifest.json")!;
  assert.equal(manifestSha256, hex(bytes));
  assert.equal(manifestSha256Base64, b64(bytes));
  const m = JSON.parse(Buffer.from(bytes).toString()) as CustodyManifest;
  assert.equal(Buffer.from(bytes).toString(), JSON.stringify(m, null, 2) + "\n");
  assert.equal(m.version, 1);
  assert.equal(m.kind, "release-review");
  assert.equal(m.root, "platform");
  assert.equal(m.runId, "1234");
  assert.equal(m.runAttempt, 2);
  assert.equal(m.createdAt, created.toISOString());
  assert.equal(m.expiresAt, later(24 * H).toISOString());
  assert.equal(m.planReviewSha256, sha("a"));
  for (const n of platformReview)
    assert.equal(m.files[n], hex(store.objects.get(`release-review/1234/2/${n}`)!));
  assert.deepEqual(requiredFiles("release-review", "application"), applicationReview);
});

void test("write_rejects_existing_key", async () => {
  const { store, d } = await writtenReview();
  await assert.rejects(
    writeCustody(store, reviewLocation, d, await reviewFields(d), later(M)),
    /pre-conditions|PreconditionFailed/,
  );
});

void test("read_rejects_missing_or_mismatched_manifest", async () => {
  const { store, manifestSha256 } = await writtenReview();
  const dest = await temp();
  await assert.rejects(
    readCustody(new FakeStore(), reviewLocation, manifestSha256, join(dest, "a"), expected()),
  );
  await assert.rejects(
    readCustody(store, reviewLocation, sha("c"), join(dest, "b"), expected()),
    /manifest/i,
  );
  await assert.rejects(
    readCustody(store, reviewLocation, "not-a-digest", join(dest, "c"), expected()),
  );
  const m = await readCustody(store, reviewLocation, manifestSha256, join(dest, "d"), expected());
  assert.equal(m.runId, "1234");
});

void test("read_rejects_location_kind_root_or_attempt_mismatch", async () => {
  const { store, manifestSha256 } = await writtenReview();
  const dest = await temp();
  let i = 0;
  const next = () => join(dest, String(i++));
  for (const location of [
    { ...reviewLocation, runAttempt: 1 },
    { ...reviewLocation, runId: "1235" },
    { ...reviewLocation, kind: "registered-release" as const },
  ])
    await assert.rejects(readCustody(store, location, manifestSha256, next(), expected()));
  await assert.rejects(
    readCustody(
      store,
      reviewLocation,
      manifestSha256,
      next(),
      expected(later(H), { root: "application" }),
    ),
    /root/i,
  );
  // 置き場所は正しくても、manifest の中の種類・run・attempt が違えば止まる。
  for (const mutate of [
    (m: Record<string, unknown>) => {
      m.runAttempt = 1;
    },
    (m: Record<string, unknown>) => {
      m.runId = "1235";
    },
    (m: Record<string, unknown>) => {
      m.kind = "registered-release";
    },
  ]) {
    const s = new FakeStore();
    for (const [k, v] of store.objects) s.objects.set(k, v);
    const digest = replaceManifest(s, reviewLocation, mutate);
    await assert.rejects(readCustody(s, reviewLocation, digest, next(), expected()), /location/i);
  }
});

void test("read_rejects_missing_required_and_extra_manifest_entries", async () => {
  const { store } = await writtenReview();
  const dest = await temp();
  let i = 0;
  const next = () => join(dest, String(i++));
  const missing = new FakeStore();
  for (const [k, v] of store.objects) missing.objects.set(k, v);
  const d1 = replaceManifest(missing, reviewLocation, (m) => {
    delete (m.files as Record<string, string>)["plan.txt"];
  });
  await assert.rejects(readCustody(missing, reviewLocation, d1, next(), expected()), /file set/i);
  const extra = new FakeStore();
  for (const [k, v] of store.objects) extra.objects.set(k, v);
  extra.objects.set("release-review/1234/2/plan.json", Buffer.from("x"));
  const d2 = replaceManifest(extra, reviewLocation, (m) => {
    (m.files as Record<string, string>)["plan.json"] = hex("x");
  });
  await assert.rejects(readCustody(extra, reviewLocation, d2, next(), expected()), /file set/i);
  assert.ok(
    !extra.gets.includes("release-review/1234/2/plan.json"),
    "manifest の検査より前に余分な object を読まない",
  );
  // manifest に無い object は読まない。
  const stray = new FakeStore();
  for (const [k, v] of store.objects) stray.objects.set(k, v);
  stray.objects.set("release-review/1234/2/stray.json", Buffer.from("x"));
  const digest = hex(stray.objects.get("release-review/1234/2/manifest.json")!);
  await readCustody(stray, reviewLocation, digest, next(), expected());
  assert.ok(!stray.gets.includes("release-review/1234/2/stray.json"));
});

void test("read_rejects_extra_file_in_destination_and_unsafe_names", async () => {
  const { store, manifestSha256 } = await writtenReview();
  const dest = await temp();
  const withExtra = join(dest, "extra");
  await mkdir(withExtra);
  await writeFile(join(withExtra, "other.json"), "{}");
  await assert.rejects(
    readCustody(store, reviewLocation, manifestSha256, withExtra, expected()),
    /destination/i,
  );
  const withLink = join(dest, "link");
  await mkdir(withLink);
  await symlink("/etc/hostname", join(withLink, "inputs.json"));
  await assert.rejects(
    readCustody(store, reviewLocation, manifestSha256, withLink, expected()),
    /destination/i,
  );
  const real = join(dest, "real");
  await mkdir(real);
  const linkedDir = join(dest, "linked-dir");
  await symlink(real, linkedDir);
  await assert.rejects(
    readCustody(store, reviewLocation, manifestSha256, linkedDir, expected()),
    /destination/i,
  );
  assert.deepEqual(await readdir(real), []);
  // failure-diagnostics は名前の集合が可変なので、名前そのものの安全性を検査する。
  const diag: CustodyLocation = {
    kind: "failure-diagnostics",
    runId: "1234",
    runAttempt: 1,
    job: "plan",
  };
  const d = await source(["error.json"]);
  const ds = new FakeStore();
  await writeCustody(ds, diag, d, { root: null }, created);
  for (const bad of ["../x.json", "a/b.json", "..", "manifest.json", ".hidden.json", "a\\b.json"]) {
    const s = new FakeStore();
    for (const [k, v] of ds.objects) s.objects.set(k, v);
    const digest = replaceManifest(s, diag, (m) => {
      m.files = { [bad]: hex("synthetic error.json\n") };
    });
    await assert.rejects(
      readCustody(
        s,
        diag,
        digest,
        join(dest, `diag-${s.objects.size}-${bad.length}-${bad.charCodeAt(0)}`),
        { root: null, now: later(H) },
      ),
      /name|file set/i,
    );
  }
  assert.throws(() =>
    custodyPrefix({ kind: "failure-diagnostics", runId: "1", runAttempt: 1, job: "../plan" }),
  );
  assert.throws(() => custodyPrefix({ kind: "failure-diagnostics", runId: "1", runAttempt: 1 }));
  assert.throws(() =>
    custodyPrefix({ kind: "release-review", runId: "1", runAttempt: 1, job: "plan" }),
  );
  for (const bad of [
    { runId: "0", runAttempt: 1 },
    { runId: "1/2", runAttempt: 1 },
    { runId: "1", runAttempt: 0 },
    { runId: "1", runAttempt: 1.5 },
  ])
    assert.throws(() => custodyPrefix({ kind: "release-review", ...bad }));
});

void test("read_writes_0700_directory_and_0600_files", async () => {
  const { store, manifestSha256 } = await writtenReview();
  const dest = join(await temp(), "out");
  const m = await readCustody(store, reviewLocation, manifestSha256, dest, expected());
  assert.equal((await stat(dest)).mode & 0o777, 0o700);
  assert.deepEqual((await readdir(dest)).sort(), [...platformReview].sort());
  for (const n of platformReview) assert.equal((await stat(join(dest, n))).mode & 0o777, 0o600);
  assert.deepEqual(Object.keys(m.files).sort(), [...platformReview].sort());
  // 空の既存ディレクトリも 0700 にする。
  const existing = join(await temp(), "existing");
  await mkdir(existing, { mode: 0o755 });
  await readCustody(store, reviewLocation, manifestSha256, existing, expected());
  assert.equal((await stat(existing)).mode & 0o777, 0o700);
});

void test("read_rejects_file_hash_mismatch", async () => {
  const { store, manifestSha256 } = await writtenReview();
  store.objects.set("release-review/1234/2/saved.tfplan", Buffer.from("changed"));
  const dest = join(await temp(), "out");
  await assert.rejects(
    readCustody(store, reviewLocation, manifestSha256, dest, expected()),
    /changed|SHA-256/i,
  );
  await assert.rejects(stat(dest), "照合に失敗したら何も取り出さない");
});

void test("expiry_boundaries", () => {
  const m = manifest();
  assert.throws(() => assertUsable(m, later(24 * H)), /expired/i);
  assertUsable(m, later(24 * H - 1000));
  assertUsable(
    manifest({
      createdAt: later(4 * M + 59_000).toISOString(),
      expiresAt: later(24 * H + 4 * M + 59_000).toISOString(),
    }),
    created,
  );
  assert.throws(
    () =>
      assertUsable(
        manifest({
          createdAt: later(5 * M).toISOString(),
          expiresAt: later(24 * H + 5 * M).toISOString(),
        }),
        created,
      ),
    /future/i,
  );
  for (const bad of [
    "2026-10-12",
    "2026-10-12T00:00:00Z",
    "2026-13-12T00:00:00.000Z",
    "not a date",
    "",
  ]) {
    assert.throws(() => assertUsable(manifest({ createdAt: bad }), later(H)));
    assert.throws(() => assertUsable(manifest({ expiresAt: bad }), later(H)));
  }
  const { expiresAt: _expiresAt, ...noExpiry } = m;
  assert.throws(() => assertUsable(noExpiry, later(H)));
  assert.throws(
    () => assertUsable(manifest({ expiresAt: later(24 * H + 1000).toISOString() }), later(H)),
    /24/,
  );
  assert.throws(
    () => assertUsable(manifest({ expiresAt: later(23 * H).toISOString() }), later(H)),
    /24/,
  );
  assert.throws(() => assertUsable(m, new Date(Number.NaN)));
});

void test("inherited_expiry_must_match_original", async () => {
  const original = later(24 * H).toISOString();
  const applyRun = manifest({ createdAt: later(3 * H).toISOString(), expiresAt: original });
  assertUsable(applyRun, later(4 * H), original);
  assert.throws(
    () => assertUsable(applyRun, later(4 * H), later(24 * H + 1000).toISOString()),
    /inherited/i,
  );
  assert.throws(
    () => assertUsable(applyRun, later(4 * H), later(24 * H - 1000).toISOString()),
    /inherited/i,
  );
  assert.throws(() => assertUsable(applyRun, later(24 * H), original), /expired/i);
  assert.throws(() => assertUsable(applyRun, later(4 * H), "bad"));
  // writeCustody は継承した期限をそのまま書き、readCustody はそれを継承値で検査する。
  const store = new FakeStore();
  const d = await source(platformReview);
  const { manifestSha256 } = await writeCustody(
    store,
    reviewLocation,
    d,
    { ...(await reviewFields(d)), expiresAt: original },
    later(3 * H),
  );
  const dest = await temp();
  const m = await readCustody(
    store,
    reviewLocation,
    manifestSha256,
    join(dest, "ok"),
    expected(later(4 * H), { inheritedExpiresAt: original }),
  );
  assert.equal(m.expiresAt, original);
  await assert.rejects(
    readCustody(
      store,
      reviewLocation,
      manifestSha256,
      join(dest, "no-inherit"),
      expected(later(4 * H)),
    ),
    /24/,
  );
  await assert.rejects(
    readCustody(
      store,
      reviewLocation,
      manifestSha256,
      join(dest, "late"),
      expected(later(24 * H), { inheritedExpiresAt: original }),
    ),
    /expired/i,
  );
});

void test("write_requires_initial_platform_file_set", async () => {
  const result: CustodyLocation = { kind: "release-result", runId: "77", runAttempt: 1 };
  assert.deepEqual(requiredFiles("release-result", "platform", { initialPlatform: true }), [
    "ledger.json",
    "post-baseline.json",
  ]);
  assert.deepEqual(requiredFiles("release-result", "platform"), ["ledger.json"]);
  assert.deepEqual(requiredFiles("registered-release", "application"), [
    "registered.json",
    "audit-runtime.json",
    "audit.json",
    "sbom.json",
    "tests.txt",
  ]);
  assert.deepEqual(requiredFiles("failure-diagnostics", null), []);
  const initial = new FakeStore();
  const d1 = await source(["ledger.json", "post-baseline.json"], ["plan.json", "outputs.json"]);
  await writeCustody(initial, result, d1, { root: "platform" }, created, { initialPlatform: true });
  assert.deepEqual(initial.order, [
    "release-result/77/1/ledger.json",
    "release-result/77/1/post-baseline.json",
    "release-result/77/1/manifest.json",
  ]);
  const normal = new FakeStore();
  const d2 = await source(["ledger.json", "post-baseline.json", "plan.json"]);
  await writeCustody(normal, result, d2, { root: "platform" }, created);
  assert.deepEqual(normal.order, [
    "release-result/77/1/ledger.json",
    "release-result/77/1/manifest.json",
  ]);
  const m = JSON.parse(
    Buffer.from(normal.objects.get("release-result/77/1/manifest.json")!).toString(),
  ) as CustodyManifest;
  assert.deepEqual(Object.keys(m.files), ["ledger.json"]);
  const missing = new FakeStore();
  const d3 = await source(["ledger.json"]);
  await assert.rejects(
    writeCustody(missing, result, d3, { root: "platform" }, created, { initialPlatform: true }),
    /missing/i,
  );
  assert.equal(missing.order.length, 0);
  const reviewMissing = new FakeStore();
  const d4 = await source(platformReview.filter((n) => n !== "plan.txt"));
  await assert.rejects(
    writeCustody(reviewMissing, reviewLocation, d4, await reviewFields(d4), created),
    /missing/i,
  );
  assert.equal(reviewMissing.order.length, 0);
  await assert.rejects(
    writeCustody(new FakeStore(), result, d1, { root: "application" }, created, {
      initialPlatform: true,
    }),
  );
  const diag: CustodyLocation = {
    kind: "failure-diagnostics",
    runId: "77",
    runAttempt: 1,
    job: "apply",
  };
  const nine = await source(Array.from({ length: 9 }, (_, i) => `d${i}.json`));
  const s9 = new FakeStore();
  await assert.rejects(writeCustody(s9, diag, nine, { root: null }, created), /8/);
  assert.equal(s9.order.length, 0);
  const eight = await source(
    Array.from({ length: 8 }, (_, i) => `d${i}.json`),
    ["notes.txt"],
  );
  const s8 = new FakeStore();
  await writeCustody(s8, diag, eight, { root: null }, created);
  assert.equal(s8.order.length, 9);
  assert.ok(!s8.order.some((k) => k.endsWith("notes.txt")));
  const linked = await source(["a.json"]);
  await symlink("/etc/hostname", join(linked, "b.json"));
  await assert.rejects(
    writeCustody(new FakeStore(), diag, linked, { root: null }, created),
    /regular/i,
  );
});

void test("read_original_manifest_checks_digest_without_extracting", async () => {
  const { store, manifestSha256 } = await writtenReview();
  const m = await readOriginalManifest(store, reviewLocation, manifestSha256);
  assert.equal(m.expiresAt, later(24 * H).toISOString());
  assert.deepEqual(store.gets, ["release-review/1234/2/manifest.json"]);
  await assert.rejects(readOriginalManifest(store, reviewLocation, sha("c")), /manifest/i);
  await assert.rejects(
    readOriginalManifest(store, { ...reviewLocation, runAttempt: 1 }, manifestSha256),
  );
  const s = new FakeStore();
  for (const [k, v] of store.objects) s.objects.set(k, v);
  const digest = replaceManifest(s, reviewLocation, (m) => {
    m.runAttempt = 3;
  });
  await assert.rejects(readOriginalManifest(s, reviewLocation, digest), /location/i);
  const bad = new FakeStore();
  for (const [k, v] of store.objects) bad.objects.set(k, v);
  const badDigest = replaceManifest(bad, reviewLocation, (m) => {
    m.version = 2;
  });
  await assert.rejects(readOriginalManifest(bad, reviewLocation, badDigest));
});

void test("recreated_identical_manifest_after_expiry_is_rejected", async () => {
  const { store, manifestSha256 } = await writtenReview();
  // lifecycle の失効の後、同じ bytes を同じ key に置き直した状態を新しい store で再現する。
  const recreated = new FakeStore();
  for (const [k, v] of store.objects) recreated.objects.set(k, Uint8Array.from(v));
  await assert.rejects(
    readCustody(
      recreated,
      reviewLocation,
      manifestSha256,
      join(await temp(), "out"),
      expected(later(25 * H)),
    ),
    /expired/i,
  );
  await assert.rejects(
    readOriginalManifest(recreated, reviewLocation, manifestSha256).then((m) =>
      assertUsable(m, later(25 * H)),
    ),
    /expired/i,
  );
});

void test("result_and_diagnostics_have_no_expiry", async () => {
  const result: CustodyLocation = { kind: "release-result", runId: "5", runAttempt: 1 };
  const store = new FakeStore();
  const d = await source(["ledger.json"]);
  const { manifestSha256 } = await writeCustody(store, result, d, { root: "application" }, created);
  const m = JSON.parse(
    Buffer.from(store.objects.get("release-result/5/1/manifest.json")!).toString(),
  ) as CustodyManifest;
  assert.equal("expiresAt" in m, false);
  const read = await readCustody(store, result, manifestSha256, join(await temp(), "out"), {
    root: "application",
    now: later(29 * 24 * H),
  });
  assert.equal(read.expiresAt, undefined);
  const diag: CustodyLocation = {
    kind: "failure-diagnostics",
    runId: "5",
    runAttempt: 1,
    job: "plan",
  };
  const ds = new FakeStore();
  const dd = await source(["e.json"]);
  const r = await writeCustody(ds, diag, dd, { root: null }, created);
  const dm = await readCustody(ds, diag, r.manifestSha256, join(await temp(), "out"), {
    root: null,
    now: later(48 * H),
  });
  assert.equal(dm.expiresAt, undefined);
  await assert.rejects(
    writeCustody(
      new FakeStore(),
      result,
      d,
      { root: "application", expiresAt: later(24 * H).toISOString() },
      created,
    ),
  );
  // 期限の無い種類に expiresAt を足した manifest は拒否する。
  const s = new FakeStore();
  for (const [k, v] of store.objects) s.objects.set(k, v);
  const digest = replaceManifest(s, result, (m) => {
    m.expiresAt = later(24 * H).toISOString();
  });
  await assert.rejects(
    readCustody(s, result, digest, join(await temp(), "out"), {
      root: "application",
      now: later(H),
    }),
  );
});

void test("s3_store_sends_if_none_match_and_checksum", async () => {
  const sent: unknown[] = [];
  const body = Buffer.from("synthetic bytes");
  const client = {
    send: (command: unknown) => {
      sent.push(command);
      if (command instanceof GetObjectCommand)
        return Promise.resolve({
          Body: { transformToByteArray: () => Promise.resolve(Uint8Array.from(body)) },
          ChecksumSHA256: b64(body),
        });
      return Promise.resolve({});
    },
  } as unknown as S3Client;
  const store = createS3CustodyStore("synthetic-custody", client);
  await store.put("release-review/1/1/plan.txt", body, b64(body));
  const put = sent[0];
  assert.ok(put instanceof PutObjectCommand);
  assert.equal(put.input.Bucket, "synthetic-custody");
  assert.equal(put.input.Key, "release-review/1/1/plan.txt");
  assert.equal(put.input.IfNoneMatch, "*");
  assert.equal(put.input.ChecksumSHA256, b64(body));
  assert.deepEqual(Buffer.from(await store.get("release-review/1/1/plan.txt")), body);
  const get = sent[1];
  assert.ok(get instanceof GetObjectCommand);
  assert.equal(get.input.ChecksumMode, "ENABLED");
  assert.equal(get.input.Key, "release-review/1/1/plan.txt");
  const wrong = createS3CustodyStore("synthetic-custody", {
    send: () =>
      Promise.resolve({
        Body: { transformToByteArray: () => Promise.resolve(Uint8Array.from(body)) },
        ChecksumSHA256: b64("other"),
      }),
  } as unknown as S3Client);
  await assert.rejects(wrong.get("k"), /checksum/i);
  const empty = createS3CustodyStore("synthetic-custody", {
    send: () => Promise.resolve({}),
  } as unknown as S3Client);
  await assert.rejects(empty.get("k"));
});
