import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import {
  definitions,
  caseActions,
  caseMeasurements,
  measurementUnsupportedReasons,
} from "./support/cases.ts";
import {
  classifyConditionalWrite,
  custodyBucket,
  custodyDefinitions,
  probeConditionalWrite,
} from "./support/custody-cases.ts";
import {
  createEvidence,
  evidenceContext,
  finalizeResults,
  flushPendingLogs,
  ownedBucketNames,
} from "./support/evidence.ts";
import { fixtureStates } from "./support/fixture.ts";
import type { CaseDefinition, OutputResult, SuiteFixture } from "./support/types.ts";
import { executeSuites, runSuiteCase } from "../../../scripts/e2e/run.ts";

const root = process.cwd();
const ROUNDTRIP = "REL-01/custody-roundtrip";
const CONDITIONAL = "REL-01/custody-conditional-write";
const PREFIX = "e2e-0123abcd";
const ACCOUNT = "000000000000";
const REGION = "ap-northeast-1";
const CUSTODY = `${PREFIX}-${ACCOUNT}-${REGION}-custody`;
const sha64 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("base64");
const failure = (name: string, status?: number): Error =>
  Object.assign(new Error("synthetic"), {
    name,
    ...(status === undefined ? {} : { $metadata: { httpStatusCode: status } }),
  });

/**
 * 合成の S3。custody の bucket policy と同じく、If-None-Match の無い PutObject を拒み、SHA-256 の checksum を照合する。
 * mode で、Floci の応答の種類（条件不成立・受理・認証エラー・通信失敗など）を作る。
 */
type Mode =
  | "enforce-412"
  | "conflict-409"
  | "accept"
  | "second-403"
  | "second-transport"
  | "second-500"
  | "first-fails"
  | "put-403"
  | "put-transport"
  | "get-403"
  | "overwrite-412";
type Version = { key: string; versionId: string; body: Buffer; marker: boolean };
function fakeS3(mode: Mode = "enforce-412") {
  const versions: Version[] = [];
  const buckets = new Set<string>();
  let puts = 0;
  let sequence = 0;
  const current = (key: string): Version | undefined =>
    versions.filter((item) => item.key === key).at(-1);
  const client = {
    async send(command: unknown): Promise<unknown> {
      if (command instanceof PutObjectCommand) {
        const { Bucket, Key, Body, IfNoneMatch, ChecksumSHA256 } = command.input;
        buckets.add(Bucket!);
        puts++;
        if (IfNoneMatch !== "*") throw failure("AccessDenied", 403);
        const body = Buffer.from(Body as Uint8Array);
        if (ChecksumSHA256 !== sha64(body)) throw failure("BadDigest", 400);
        if (mode === "put-403" || (mode === "first-fails" && puts === 1))
          throw failure("AccessDenied", 403);
        if (mode === "put-transport") throw failure("TimeoutError");
        const existing = current(Key!);
        if (existing && !existing.marker) {
          if (mode === "enforce-412") throw failure("PreconditionFailed", 412);
          if (mode === "overwrite-412") {
            versions.push({ key: Key!, versionId: `v${++sequence}`, body, marker: false });
            throw failure("PreconditionFailed", 412);
          }
          if (mode === "conflict-409") throw failure("ConditionalRequestConflict", 409);
          if (mode === "second-403") throw failure("AccessDenied", 403);
          if (mode === "second-transport") throw failure("TimeoutError");
          if (mode === "second-500") throw failure("InternalError", 500);
        }
        versions.push({ key: Key!, versionId: `v${++sequence}`, body, marker: false });
        return { $metadata: { httpStatusCode: 200 } };
      }
      if (command instanceof GetObjectCommand) {
        const { Bucket, Key, ChecksumMode } = command.input;
        buckets.add(Bucket!);
        if (mode === "get-403") throw failure("AccessDenied", 403);
        const found = current(Key!);
        if (!found || found.marker) throw failure("NoSuchKey", 404);
        return {
          Body: { transformToByteArray: async () => new Uint8Array(found.body) },
          ...(ChecksumMode === "ENABLED" ? { ChecksumSHA256: sha64(found.body) } : {}),
        };
      }
      if (command instanceof ListObjectVersionsCommand) {
        const { Bucket, Prefix } = command.input;
        buckets.add(Bucket!);
        const within = versions.filter((item) => item.key.startsWith(Prefix ?? ""));
        return {
          IsTruncated: false,
          Versions: within
            .filter((item) => !item.marker)
            .map((item) => ({ Key: item.key, VersionId: item.versionId, Size: item.body.length })),
          DeleteMarkers: within
            .filter((item) => item.marker)
            .map((item) => ({ Key: item.key, VersionId: item.versionId })),
        };
      }
      if (command instanceof DeleteObjectsCommand) {
        const { Bucket, Delete } = command.input;
        buckets.add(Bucket!);
        for (const target of Delete?.Objects ?? []) {
          const index = versions.findIndex(
            (item) => item.key === target.Key && item.versionId === target.VersionId,
          );
          if (index >= 0) versions.splice(index, 1);
        }
        return { Deleted: Delete?.Objects ?? [] };
      }
      throw new Error("UNEXPECTED_S3_COMMAND");
    },
  };
  return { client, versions, buckets };
}
function fakeFixture(mode: Mode = "enforce-412"): {
  fixture: SuiteFixture;
  s3: ReturnType<typeof fakeS3>;
} {
  const s3 = fakeS3(mode);
  const fixture = {
    prefix: PREFIX,
    target: { endpoint: "http://floci:4566", region: REGION, addresses: new Map() },
    clients: { s3: s3.client },
  } as unknown as SuiteFixture;
  fixtureStates.set(fixture, {
    stack: { bindings: { prefix: PREFIX, account_id: ACCOUNT } },
  } as never);
  return { fixture, s3 };
}
type Saved = {
  id: string;
  status: string;
  reason?: string;
  httpStatus?: number;
  outputs?: OutputResult[];
};
const wiring = {
  createAuth: async () => ({}) as never,
  bind(view: SuiteFixture, source: SuiteFixture) {
    fixtureStates.set(view, fixtureStates.get(source)!);
  },
};
/** run.ts の executeSuites と runSuiteCase で custody の suite を通し、results.json の結果を返す。 */
async function runCustody(
  mode: Mode,
  selected: CaseDefinition[] = custodyDefinitions,
): Promise<{ results: Map<string, Saved>; s3: ReturnType<typeof fakeS3>; errors: number }> {
  const directory = await mkdtemp(join(tmpdir(), "custody-suite-"));
  const { fixture, s3 } = fakeFixture(mode);
  try {
    const evidence = await createEvidence(selected, join(directory, "run"));
    const outcome = await executeSuites(selected, {
      create: async () => fixture,
      action: (def, suite) => runSuiteCase(evidence, def, suite, wiring),
      flush: () => flushPendingLogs(evidence, async () => []),
      reset: async () => ({ errors: 0, leaks: 0 }),
      blocked: (def) =>
        evidence.record({
          id: def.id,
          status: "not-run",
          phase: "provision",
          durationMs: 0,
          reason: "prerequisite-failed",
        }),
    });
    await finalizeResults(evidence);
    const saved = JSON.parse(
      await readFile(join(evidenceContext(evidence).directory, "results.json"), "utf8"),
    ) as { cases: { id: string; result: Saved }[] };
    return {
      results: new Map(saved.cases.map((item) => [item.id, item.result])),
      s3,
      errors: outcome.errors,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
const byId = (id: string): CaseDefinition => custodyDefinitions.find((def) => def.id === id)!;

void test("roundtrip_case_fails_on_transport_or_auth_errors_not_unsupported", async () => {
  const control = await runCustody("enforce-412", [byId(ROUNDTRIP)]);
  assert.equal(control.results.get(ROUNDTRIP)?.status, "pass");
  assert.ok(
    control.results
      .get(ROUNDTRIP)
      ?.outputs?.find(
        (output) =>
          output.kind === "s3" && output.status === "pass" && output.assertions.length === 3,
      ),
  );
  for (const mode of ["put-403", "put-transport", "get-403"] as const) {
    const { results } = await runCustody(mode, [byId(ROUNDTRIP)]);
    const result = results.get(ROUNDTRIP)!;
    assert.equal(result.status, "fail", mode);
    assert.equal(result.reason, "action-failed", mode);
  }
  assert.equal(
    caseMeasurements.has(ROUNDTRIP),
    false,
    "the required roundtrip is never a measurement that may end unsupported",
  );
});

void test("conditional_write_outcomes_are_classified", async () => {
  assert.equal(classifyConditionalWrite({ first: "failed" }), "fail");
  assert.equal(
    classifyConditionalWrite({
      first: "stored",
      second: { accepted: false, status: 412, name: "PreconditionFailed" },
      kept: true,
    }),
    "pass",
  );
  assert.equal(
    classifyConditionalWrite({
      first: "stored",
      second: { accepted: false, status: 409, name: "ConditionalRequestConflict" },
      kept: true,
    }),
    "pass",
  );
  assert.equal(
    classifyConditionalWrite({
      first: "stored",
      second: { accepted: false, status: 412, name: "PreconditionFailed" },
      kept: false,
    }),
    "fail",
    "a refusal that still replaced the object",
  );
  assert.equal(
    classifyConditionalWrite({ first: "stored", second: { accepted: true }, kept: false }),
    "unsupported",
  );
  for (const second of [
    { accepted: false as const, status: 403, name: "AccessDenied" },
    { accepted: false as const, name: "TimeoutError" },
    { accepted: false as const, status: 500, name: "InternalError" },
    { accepted: false as const, status: 409, name: "OperationAborted" },
    { accepted: false as const, status: 400, name: "BadDigest" },
  ]) {
    assert.equal(
      classifyConditionalWrite({ first: "stored", second, kept: true }),
      "fail",
      JSON.stringify(second),
    );
  }
  const expected: [Mode, string, number | undefined][] = [
    ["enforce-412", "pass", 412],
    ["conflict-409", "pass", 409],
    ["accept", "unsupported", 200],
    ["second-403", "fail", 403],
    ["second-transport", "fail", undefined],
    ["second-500", "fail", 500],
    ["first-fails", "fail", undefined],
    ["overwrite-412", "fail", 412],
  ];
  for (const [mode, outcome, status] of expected) {
    const { fixture, s3 } = fakeFixture(mode);
    const measured = await probeConditionalWrite(fixture);
    const observed =
      typeof measured === "string" ? { outcome: measured, httpStatus: undefined } : measured;
    assert.equal(observed.outcome, outcome, mode);
    assert.equal(observed.httpStatus, status, mode);
    assert.deepEqual([...s3.buckets], [CUSTODY], `${mode}: only the custody bucket is touched`);
  }
});

void test("conditional_write_case_records_only_registered_reason", async () => {
  assert.equal(measurementUnsupportedReasons.get(CONDITIONAL), "conditional-write-unsupported");
  assert.equal(caseMeasurements.has(CONDITIONAL), true);
  const measured = await runCustody("accept", [byId(CONDITIONAL)]);
  assert.equal(measured.results.get(CONDITIONAL)?.status, "unsupported");
  assert.equal(measured.results.get(CONDITIONAL)?.reason, "conditional-write-unsupported");
  assert.equal(measured.results.get(CONDITIONAL)?.httpStatus, 200);
  // 結果の記録の規則: この case の unsupported は登録の理由だけを通し、登録の理由は他の case に使わせない。既定の理由の扱いは変えない。
  const image = definitions.find((def) => def.id === "IMG-09/signature-enforcement")!;
  const complete = (def: CaseDefinition): OutputResult[] =>
    def.outputs.map((output) =>
      output.assertions.length
        ? {
            kind: output.kind,
            status: "pass",
            assertions: output.assertions.map((name) => ({ name, status: "pass" })),
          }
        : {
            kind: output.kind,
            status: "not-applicable",
            assertions: [],
            reason: output.notApplicableReason!,
          },
    );
  const attempts: [CaseDefinition, string, string][] = [
    [byId(CONDITIONAL), "conditional-write-unsupported", "unsupported"],
    [byId(CONDITIONAL), "signature-enforcement-unsupported", "fail"],
    [byId(CONDITIONAL), "scheduler-trigger-unsupported", "fail"],
    [image, "conditional-write-unsupported", "fail"],
    [image, "signature-enforcement-unsupported", "unsupported"],
  ];
  for (const [def, reason, status] of attempts) {
    const directory = await mkdtemp(join(tmpdir(), "custody-reason-"));
    try {
      const evidence = await createEvidence([def], join(directory, "run"));
      await evidence.record({
        id: def.id,
        status: "unsupported",
        phase: "outputs",
        durationMs: 0,
        reason,
        outputs: complete(def),
      });
      await finalizeResults(evidence);
      const saved = JSON.parse(
        await readFile(join(evidenceContext(evidence).directory, "results.json"), "utf8"),
      ) as { cases: { id: string; result: Saved }[] };
      assert.equal(saved.cases[0]!.result.status, status, `${def.id} ${reason}`);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  // 登録の無い unsupported は今までどおり fail（required の behavior case）。
  const roundtrip = await (async () => {
    const directory = await mkdtemp(join(tmpdir(), "custody-reason-"));
    try {
      const evidence = await createEvidence([byId(ROUNDTRIP)], join(directory, "run"));
      await evidence.record({
        id: ROUNDTRIP,
        status: "unsupported",
        phase: "outputs",
        durationMs: 0,
        reason: "conditional-write-unsupported",
        outputs: complete(byId(ROUNDTRIP)),
      });
      await finalizeResults(evidence);
      return (
        JSON.parse(
          await readFile(join(evidenceContext(evidence).directory, "results.json"), "utf8"),
        ) as { cases: { result: Saved }[] }
      ).cases[0]!.result.status;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  })();
  assert.equal(roundtrip, "fail");
});

void test("custody_cases_are_registered_with_requirements", () => {
  assert.deepEqual(
    custodyDefinitions.map((def) => def.id),
    [ROUNDTRIP, CONDITIONAL],
  );
  assert.deepEqual(
    definitions.filter((def) => def.suite === "custody").map((def) => def.id),
    [ROUNDTRIP, CONDITIONAL],
  );
  for (const def of custodyDefinitions) {
    assert.equal(def.requirementId, "REL-01");
    assert.equal(def.source, "formal-e2e-coverage/REL-01");
    assert.equal(def.required, true);
    assert.equal(def.layer, "L");
    assert.equal(caseActions.has(def.id), true, def.id);
    assert.deepEqual(
      def.outputs.map((output) => output.kind),
      ["http", "dynamodb", "s3", "logs"],
    );
    assert.ok(
      def.outputs.find((output) => output.kind === "s3")!.assertions.length > 0,
      `${def.id} asserts S3`,
    );
  }
  assert.equal(byId(ROUNDTRIP).acceptance, "behavior");
  assert.equal(byId(CONDITIONAL).acceptance, "compatibility");
});

void test("custody_cases_are_executed_by_the_runner", async () => {
  const { results, s3, errors } = await runCustody("enforce-412");
  assert.equal(errors, 0);
  for (const id of [ROUNDTRIP, CONDITIONAL]) {
    assert.notEqual(results.get(id)?.status, "not-run", id);
    assert.equal(results.get(id)?.status, "pass", id);
  }
  assert.equal(results.get(CONDITIONAL)?.httpStatus, 412);
  // 書いた object はすべて custody bucket にあり、各 key は1版だけ（条件付き書き込みの拒否で版は増えない）。
  assert.deepEqual([...s3.buckets], [CUSTODY]);
  assert.ok(s3.versions.length > 0);
  for (const key of new Set(s3.versions.map((item) => item.key)))
    assert.equal(s3.versions.filter((item) => item.key === key).length, 1, key);
  assert.ok(
    s3.versions.every((item) =>
      /^(release-review|failure-diagnostics)\/[1-9][0-9]*\/1\//.test(item.key),
    ),
  );
});

void test("custody_objects_fall_under_the_owned_bucket_cleanup", async () => {
  const { fixture } = fakeFixture();
  // case が書く bucket は、run が所有する4つの bucket の1つで、run の prefix で始まる（run 末尾の清掃が選ぶ条件）。
  assert.equal(custodyBucket(fixture), CUSTODY);
  assert.ok(ownedBucketNames(PREFIX, ACCOUNT, REGION).includes(custodyBucket(fixture)));
  assert.ok(custodyBucket(fixture).startsWith(`${PREFIX}-`));
  const unowned = fakeFixture().fixture;
  fixtureStates.set(unowned, {
    stack: { bindings: { prefix: PREFIX, account_id: "not-an-account" } },
  } as never);
  assert.throws(() => custodyBucket(unowned), /CUSTODY_BUCKET_REJECTED/);
  // run 末尾の清掃（scripts/e2e/terraform.ts）は、prefix 付きの bucket ごとに policy を消してから、key の絞り込み無しで全 version と delete marker を消す。
  const source = await readFile(join(root, "scripts/e2e/terraform.ts"), "utf8");
  const start = source.search(
    /resource\.type\s*===\s*["']aws_s3_bucket["']\s*&&\s*typeof\s+a\.bucket\s*===\s*["']string["']\s*&&\s*a\.bucket\.startsWith\(`\$\{prefix\}-`\)/,
  );
  assert.ok(start > 0, "the owned bucket cleanup selects every bucket of the run prefix");
  const block = source.slice(start, source.indexOf("client.destroy();", start));
  const order = [
    "DeleteBucketPolicyCommand",
    "ListObjectVersionsCommand",
    "DeleteMarkers",
    "DeleteObjectsCommand",
  ].map((name) => block.indexOf(name));
  assert.ok(
    order.every((index) => index > 0) &&
      order.every((index, i) => i === 0 || index > order[i - 1]!),
    "policy removal precedes version and marker deletion",
  );
  assert.doesNotMatch(block, /Prefix\s*:/, "the version listing is not narrowed to a key prefix");
});
