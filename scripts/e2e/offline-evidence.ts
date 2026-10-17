import { spawn } from "node:child_process";
import { resolve } from "node:path";
import type {
  CaseDefinition,
  Evidence,
  OutputResult,
} from "../../tests/e2e/floci/support/types.ts";
import { offlineEvidence } from "../../tests/e2e/floci/support/cases.ts";
import type { OfflineLink } from "../../tests/e2e/floci/support/cases.ts";

/**
 * Layer-I cases are judged from the real results of the offline test files named in `offlineEvidence`.
 * The test files run in a child process with Node's JUnit reporter; the report is parsed in memory and never persisted or printed.
 * Only fixed-vocabulary outcomes reach the evidence: pass, or fail with offline-test-missing / offline-test-failed / offline-run-failed.
 */
export type TestOutcome = { name: string; status: "pass" | "fail" | "not-pass" };
/** `run-failed`: the child timed out, was aborted, crashed without a test failure, overflowed, or produced no parsable report. */
export type FileOutcome = { kind: "tests"; tests: TestOutcome[] } | { kind: "run-failed" };
export type FileRunner = (
  file: string,
  options: { timeoutMs: number; signal?: AbortSignal },
) => Promise<FileOutcome>;
export const offlineReasons = [
  "offline-test-missing",
  "offline-test-failed",
  "offline-run-failed",
] as const;
export const offlineFileTimeoutMs = 5 * 60_000;
const maxReportBytes = 16 * 1024 * 1024;
const repoRoot = resolve(__dirname, "../..");

/**
 * A mapped title matches an executed test when the names are identical, or when the title is a prefix of the test name that ends on
 * a word boundary (the family notation of STORE-03/STORE-04/STORE-06, e.g. `STORE-06/items-1000-boundary-i:` or
 * `STORE-03/both-read-old-i: PATCH and PATCH` for a longer test name). The character after the prefix must not continue an identifier
 * ([A-Za-z0-9_]), so `a_b` never matches `a_b_c`. Substrings that do not start the name never match.
 */
export function titleMatches(title: string, testName: string): boolean {
  if (!title) return false;
  if (testName === title) return true;
  if (!testName.startsWith(title)) return false;
  return /[^A-Za-z0-9_]$/.test(title) || !/[A-Za-z0-9_]/.test(testName[title.length]!);
}
function decode(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (_, entity: string) => {
    if (entity === "amp") return "&";
    if (entity === "lt") return "<";
    if (entity === "gt") return ">";
    if (entity === "quot") return '"';
    if (entity === "apos") return "'";
    const code = entity.startsWith("#x")
      ? parseInt(entity.slice(2), 16)
      : parseInt(entity.slice(1), 10);
    return Number.isSafeInteger(code) && code >= 0 && code <= 0x10ffff
      ? String.fromCodePoint(code)
      : "";
  });
}
/**
 * Parse Node's JUnit report. A skipped, todo, failed or cancelled test is `not-pass` or `fail`. Anything the parser cannot read exactly
 * (a missing closing tag, no test, a malformed or nameless testcase, a testcase count that differs from what was parsed) is unparsable (undefined).
 * `spawnedPath` is the file argument given to the child: Node names a file-level failure (load error, abnormal exit, uncaught error after the tests)
 * as one failing case named after that path, which is a crashed run and not a test failure.
 */
export function parseJunit(xml: string, spawnedPath?: string): TestOutcome[] | undefined {
  if (!xml.includes("<testsuites>") || !xml.trimEnd().endsWith("</testsuites>")) return undefined;
  const tests: TestOutcome[] = [];
  // Attribute values are quoted and never contain a raw quote, so a '>' inside a value cannot end the tag early.
  const pattern = /<testcase((?:\s+[A-Za-z_:][\w:.-]*="[^"]*")*)\s*(\/>|>([\s\S]*?)<\/testcase>)/g;
  for (let match = pattern.exec(xml); match; match = pattern.exec(xml)) {
    const attributes = new Map<string, string>();
    for (const attribute of match[1]!.matchAll(/\s+([A-Za-z_:][\w:.-]*)="([^"]*)"/g))
      attributes.set(attribute[1]!, attribute[2]!);
    const name = attributes.get("name");
    if (name === undefined) return undefined;
    const decoded = decode(name);
    const file = attributes.get("file");
    if (
      decoded === (file === undefined ? undefined : decode(file)) ||
      (spawnedPath !== undefined && decoded === spawnedPath)
    )
      return undefined;
    const body = match[3] ?? "";
    const failed = attributes.has("failure") || /<(failure|error)[\s>/]/.test(body);
    const status = failed ? "fail" : /<skipped[\s>/]/.test(body) ? "not-pass" : "pass";
    tests.push({ name: decoded, status });
  }
  if ((xml.match(/<testcase[\s>/]/g) ?? []).length !== tests.length) return undefined;
  return tests.length ? tests : undefined;
}

/** A non-zero exit is acceptable only when a test FAILED in the report (skipped/todo tests do not make Node exit non-zero); otherwise the run failed for another reason. */
export function outcomeOfExit(code: number | null, tests: TestOutcome[] | undefined): FileOutcome {
  if (!tests || (code !== 0 && !tests.some((test) => test.status === "fail")))
    return { kind: "run-failed" };
  return { kind: "tests", tests };
}

/** Run one test file in a child process (synthetic environment, own process group, timeout and cancellation) and reduce its report to outcomes. */
export const runOfflineFile: FileRunner = (file, options) =>
  new Promise<FileOutcome>((resolveOutcome) => {
    void import("./run.ts").then(
      ({ childEnvironment }) => {
        let stdout = "";
        let overflow = false;
        let timedOut = false;
        let settled = false;
        // The offline tests build their own fakes and SDK clients: the synthetic Floci endpoint of the live child environment must not reach them.
        const spawned = resolve(repoRoot, file);
        const env: NodeJS.ProcessEnv = { ...childEnvironment(), E2E_OFFLINE_CHILD: "1" };
        delete env.AWS_ENDPOINT_URL;
        const child = spawn(
          "node",
          ["--import", "tsx", "--test", "--test-reporter=junit", spawned],
          { cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"], shell: false, detached: true },
        );
        const kill = () => {
          timedOut = true;
          if (child.pid) {
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch {
              child.kill("SIGKILL");
            }
          }
        };
        const timer = setTimeout(kill, options.timeoutMs);
        options.signal?.addEventListener("abort", kill, { once: true });
        if (options.signal?.aborted) kill();
        child.stdout!.setEncoding("utf8");
        child.stdout!.on("data", (chunk: string) => {
          if (overflow) return;
          if (stdout.length + chunk.length > maxReportBytes) {
            overflow = true;
            stdout = "";
          } else stdout += chunk;
        });
        child.stderr!.resume(); // discarded: raw child output is never kept
        const finish = (code: number | null) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          options.signal?.removeEventListener("abort", kill);
          const tests = timedOut || overflow ? undefined : parseJunit(stdout, spawned);
          stdout = "";
          resolveOutcome(outcomeOfExit(code, tests));
        };
        child.on("error", () => finish(null));
        child.on("close", finish);
      },
      () => resolveOutcome({ kind: "run-failed" }),
    );
  });

export type CaseJudgement =
  | { status: "pass" }
  | { status: "fail"; reason: (typeof offlineReasons)[number] }
  | { status: "not-run" };
/** Pure judgement of one case from its links and the per-file outcomes (a file absent from the map was never started). */
export function judgeCase(links: OfflineLink[], outcomes: Map<string, FileOutcome>): CaseJudgement {
  // A case with no mapped file or title has no evidence: it never passes vacuously.
  if (!links.length || links.some((link) => !link.titles.length))
    return { status: "fail", reason: "offline-test-missing" };
  let reason: (typeof offlineReasons)[number] | undefined;
  let started = true;
  const rank = (value: (typeof offlineReasons)[number]) => offlineReasons.indexOf(value);
  const note = (value: (typeof offlineReasons)[number]) => {
    if (reason === undefined || rank(value) > rank(reason)) reason = value;
  };
  for (const link of links) {
    const outcome = outcomes.get(link.file);
    if (!outcome) {
      started = false;
      continue;
    }
    if (outcome.kind === "run-failed") {
      note("offline-run-failed");
      continue;
    }
    for (const title of link.titles) {
      const matched = outcome.tests.filter((test) => titleMatches(title, test.name));
      if (!matched.length) note("offline-test-missing");
      else if (matched.some((test) => test.status !== "pass")) note("offline-test-failed");
    }
  }
  // A recorded failure stands even when a later file was never started; otherwise an unstarted file leaves the case not-run.
  if (reason) return { status: "fail", reason };
  return started ? { status: "pass" } : { status: "not-run" };
}

function outputsFor(def: CaseDefinition, status: "pass" | "fail"): OutputResult[] {
  return def.outputs.map((output) =>
    output.assertions.length
      ? {
          kind: output.kind,
          status,
          assertions: output.assertions.map((name) => ({ name, status })),
        }
      : {
          kind: output.kind,
          status: "not-applicable" as const,
          assertions: [],
          reason: output.notApplicableReason!,
        },
  );
}
export type OfflineOptions = {
  signal?: AbortSignal;
  /** Returns the time allowed for the next test file, or 0 when the run budget is spent. */
  allow?: () => number;
  runner?: FileRunner;
  record?: (file: string, outcome: FileOutcome, durationMs: number) => Promise<void>;
};
/** Execute the offline files behind the selected layer-I cases once each and record every selected I case. Independent of the Floci gate. */
export async function runOfflineEvidence(
  evidence: Evidence,
  selected: CaseDefinition[],
  options: OfflineOptions = {},
): Promise<void> {
  // The offline child must never start another E2E run of its own.
  if (process.env.E2E_OFFLINE_CHILD === "1") throw new Error("OFFLINE_RECURSION");
  const cases = selected.filter((def) => def.layer === "I");
  const runner = options.runner ?? runOfflineFile;
  const outcomes = new Map<string, FileOutcome>();
  const durations = new Map<string, number>();
  const files = [
    ...new Set(cases.flatMap((def) => (offlineEvidence[def.id] ?? []).map((link) => link.file))),
  ];
  for (const file of files) {
    const allowed = options.allow ? options.allow() : offlineFileTimeoutMs;
    if (allowed <= 0 || options.signal?.aborted) continue;
    const started = performance.now();
    const outcome = await runner(file, {
      timeoutMs: Math.min(allowed, offlineFileTimeoutMs),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const duration = Math.round(performance.now() - started);
    outcomes.set(file, outcome);
    durations.set(file, duration);
    await options.record?.(file, outcome, duration);
  }
  for (const def of cases) {
    const links = offlineEvidence[def.id] ?? [];
    const judgement = links.length
      ? judgeCase(links, outcomes)
      : { status: "fail" as const, reason: "offline-test-missing" as const };
    const durationMs = links.reduce((sum, link) => sum + (durations.get(link.file) ?? 0), 0);
    if (judgement.status === "not-run")
      await evidence.record({
        id: def.id,
        status: "not-run",
        phase: "offline",
        durationMs: 0,
        reason: "budget-exhausted",
      });
    else if (judgement.status === "pass")
      await evidence.record({
        id: def.id,
        status: "pass",
        phase: "offline",
        durationMs,
        outputs: outputsFor(def, "pass"),
      });
    else
      await evidence.record({
        id: def.id,
        status: "fail",
        phase: "offline",
        durationMs,
        reason: judgement.reason,
        outputs: outputsFor(def, "fail"),
      });
  }
}
