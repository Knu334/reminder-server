import assert from "node:assert/strict";
import fsPromises from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import type { Metafile } from "esbuild";
import { writeNotices } from "../../scripts/build/notices";

const zip = resolve("artifacts/reminder-server.zip");
const names = ["THIRD_PARTY_NOTICES", "dist/", "dist/api.js", "dist/api.js.map", "dist/cleanup.js", "dist/cleanup.js.map"];

void test("unpacked_handlers_run_without_node_modules", () => {
  assert.equal(process.versions.node.split(".")[0], "24", "packaging smoke tests require Node24");
  assert.ok(existsSync(zip), "build and package artifacts before running delivery tests");
  const temp = mkdtempSync(join(tmpdir(), "lambda-hermetic-"));
  try {
    const unpack = spawnSync("python3", ["-c", "import sys,zipfile; z=zipfile.ZipFile(sys.argv[1]); z.extractall(sys.argv[2]); print(z.namelist())", zip, temp], { encoding: "utf8" });
    assert.equal(unpack.status, 0, unpack.stderr);
    assert.equal(existsSync(join(temp, "node_modules")), false);
    const script = `
      const assert = require('node:assert/strict');
      let sdkCalls = 0, gates = 0, probes = 0;
      const blocked = () => { sdkCalls++; throw Error('forbidden SDK/network call'); };
      require('node:http').request = blocked; require('node:https').request = blocked;
      require('node:net').connect = blocked; require('node:net').createConnection = blocked;
      require('node:tls').connect = blocked; globalThis.fetch = blocked;
      const api = require('./dist/api.js'), cleanup = require('./dist/cleanup.js');
      assert.equal(typeof api.handler, 'function'); assert.equal(typeof cleanup.handler, 'function');
      const forbidden = new Proxy({}, {get: () => blocked});
      const owners = {probe: async () => {probes++;}, gate: async () => {gates++; return {published: false, runId: null};}};
      const images = {probe: async () => {probes++;}};
      const config = {expectedApiId:'synthetic-api', expectedStage:'$default', sourceIps:[]};
      const clock = () => 1800000000000;
      const ctx = {awsRequestId:'synthetic-request', getRemainingTimeInMillis:() => 660000};
      const event = path => ({version:'2.0',routeKey:'GET '+path,rawPath:path,rawQueryString:'',headers:{},isBase64Encoded:false,
        requestContext:{apiId:'synthetic-api',stage:'$default',requestId:'synthetic-request',routeKey:'GET '+path,http:{method:'GET',path,sourceIp:'192.0.2.1'}}});
      (async () => {
        const handler = api.createApiHandler({config, owners, images, clock, service:forbidden});
        const health = await handler(event('/healthz'), ctx);
        assert.equal(health.statusCode, 200); assert.deepEqual(JSON.parse(health.body), {healthy:true});
        const ready = await handler(event('/readyz'), ctx);
        assert.equal(ready.statusCode, 503); assert.equal(JSON.parse(ready.body).code, 'SERVICE_UNAVAILABLE');
        const logs = []; console.log = value => logs.push(value);
        const result = await cleanup.createCleanupHandler({config, owners, images:forbidden, jobs:forbidden, clock,
          uuid:() => 'synthetic-run', metrics:{send:blocked}})({source:'aws.scheduler',detail:{}}, ctx);
        assert.deepEqual(result, {evaluated:0,deletes:0,incomplete:false,skippedUnpublished:true});
        assert.equal(gates, 2); assert.equal(probes, 2); assert.equal(sdkCalls, 0);
        assert.ok(logs.some(line => JSON.parse(line).operation === 'cleanup_start'));
        process.stdout.write(JSON.stringify({sdkCalls,gates,probes}));
      })().catch(error => {console.error(error); process.exitCode=1;});`;
    const child = spawnSync(process.execPath, ["--no-addons", "-e", script], { cwd: temp, env: { NODE_PATH: "", HOME: temp }, encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout), { sdkCalls: 0, gates: 2, probes: 2 });
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

void test("bundled_dependencies_have_notices_maps_and_no_external_packages", () => {
  assert.ok(existsSync(zip), "build and package artifacts before running delivery tests");
  const meta = JSON.parse(readFileSync("dist/meta.json", "utf8")) as Metafile;
  const notices = readFileSync("artifacts/staging/THIRD_PARTY_NOTICES", "utf8");
  const lock = JSON.parse(readFileSync("package-lock.json", "utf8")) as {packages: Record<string, {version?: string; license?: string}>};
  const bundled = new Set<string>();
  for (const input of Object.keys(meta.inputs)) {
    const match = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(input);
    if (match) bundled.add(match[1]!);
  }
  assert.ok(bundled.size > 0);
  for (const key of bundled) {
    const dependency = lock.packages[key]; assert.ok(dependency, key);
    const name = key.slice(key.lastIndexOf("node_modules/") + 13);
    assert.ok(notices.includes(`${name}@${dependency.version}`), name);
    const section = notices.split(`===== ${name}@${dependency.version} =====`)[1]?.split("=====")[0];
    assert.ok(section, name);
    assert.ok(section.includes(`License: ${dependency.license}`), name);
    assert.ok(section.length > 500, `full license text is required for ${name}`);
  }
  for (const output of Object.values(meta.outputs)) {
    for (const dependency of output.imports) if (dependency.external) assert.ok(isBuiltin(dependency.path), dependency.path);
  }
  for (const entry of ["api", "cleanup"]) {
    const map = JSON.parse(readFileSync(`artifacts/staging/dist/${entry}.js.map`, "utf8")) as {sources: string[]; sourcesContent?: unknown};
    assert.ok(map.sources.some(source => source.endsWith(`src/${entry}.ts`)));
    assert.equal(map.sourcesContent, undefined);
  }
  const sbom = JSON.parse(readFileSync("artifacts/sbom.json", "utf8")) as {bomFormat: string; components: {name: string; version: string}[]};
  assert.equal(sbom.bomFormat, "CycloneDX");
  for (const key of bundled) {
    const name = key.slice(key.lastIndexOf("node_modules/") + 13);
    assert.ok(sbom.components.some(component => component.name === name && component.version === lock.packages[key]!.version), name);
  }
});

void test("verified_zip_identity_matches_manifest_and_rejects_extra_entries", async () => {
  assert.ok(existsSync(zip), "build and package artifacts before running delivery tests");
  const { verifyZip } = await import("../../scripts/build/verify-zip");
  const bytes = readFileSync(zip);
  const manifest = JSON.parse(readFileSync("artifacts/zip-manifest.json", "utf8"));
  const identity = await verifyZip(zip);
  assert.deepEqual(identity, manifest);
  assert.equal(identity.sha256Hex, createHash("sha256").update(bytes).digest("hex"));
  assert.equal(identity.sha256Base64, createHash("sha256").update(bytes).digest("base64"));
  const temp = mkdtempSync(join(tmpdir(), "lambda-invalid-"));
  try {
    const bad = join(temp, "bad.zip");
    const result = spawnSync("python3", ["-c", "import sys,zipfile; src=zipfile.ZipFile(sys.argv[1]); dst=zipfile.ZipFile(sys.argv[2],'w'); [dst.writestr(i,src.read(i)) for i in src.infolist()]; dst.writestr('../escape.js','synthetic'); dst.close()", zip, bad], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    await assert.rejects(verifyZip(bad));
    assert.equal(existsSync(join(temp, "escape.js")), false);
    const list = spawnSync("python3", ["-c", "import sys,zipfile,json; print(json.dumps(zipfile.ZipFile(sys.argv[1]).namelist()))", zip], { encoding: "utf8" });
    assert.deepEqual(JSON.parse(list.stdout), names);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

void test("notices_accept_known_locked_sdk_provenance_and_reject_unknown_or_changed_source", async () => {
  const temp = mkdtempSync(join(tmpdir(), "lambda-notices-"));
  try {
    for (const scenario of ["known", "unknown-repository", "unknown-package", "changed-source"] as const) {
      const root = join(temp, scenario);
      const name = scenario === "unknown-package" ? "@aws-sdk/unknown" : "@aws-sdk/credential-provider-http";
      const key = `node_modules/${name}`;
      mkdirSync(join(root, key), { recursive: true });
      mkdirSync(join(root, "node_modules/@aws-sdk/client-s3"), { recursive: true });
      const repository = { url: scenario === "unknown-repository" ? "https://example.test/unknown.git" : "https://github.com/aws/aws-sdk-js-v3.git" };
      writeFileSync(join(root, key, "package.json"), JSON.stringify({ name, version: "3.972.74", license: "Apache-2.0", repository }));
      writeFileSync(join(root, "node_modules/@aws-sdk/client-s3/package.json"), JSON.stringify({ name: "@aws-sdk/client-s3", version: scenario === "changed-source" ? "0.0.0" : "3.1146.0", license: "Apache-2.0", repository: { url: "https://github.com/aws/aws-sdk-js-v3.git" } }));
      writeFileSync(join(root, "node_modules/@aws-sdk/client-s3/LICENSE"), "Synthetic SDK repository license text");
      const meta = join(root, "meta.json"), lock = join(root, "package-lock.json"), notices = join(root, "THIRD_PARTY_NOTICES");
      writeFileSync(meta, JSON.stringify({ inputs: { [`${key}/dist-cjs/index.js`]: {} } }));
      writeFileSync(lock, JSON.stringify({ packages: { [key]: {version: "3.972.74", license: "Apache-2.0"}, "node_modules/@aws-sdk/client-s3": {version: "3.1146.0", license: "Apache-2.0"} } }));
      if (scenario === "known") {
        await writeNotices(meta, lock, notices);
        const first = readFileSync(notices, "utf8");
        assert.ok(first.includes("@aws-sdk/credential-provider-http@3.972.74"));
        assert.ok(first.includes("source: node_modules/@aws-sdk/client-s3/LICENSE"));
        assert.ok(first.includes("Synthetic SDK repository license text"));
        await writeNotices(meta, lock, notices);
        assert.equal(readFileSync(notices, "utf8"), first);
      } else {
        await assert.rejects(writeNotices(meta, lock, notices), Error, scenario);
        assert.equal(existsSync(notices), false);
      }
    }
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

void test("zip_verification_hashes_the_same_snapshot_it_loads", async context => {
  const { verifyZip } = await import("../../scripts/build/verify-zip");
  const temp = mkdtempSync(join(tmpdir(), "lambda-snapshot-"));
  const changing = join(temp, "changing.zip");
  const original = readFileSync(zip);
  writeFileSync(changing, original);
  const read = fsPromises.readFile;
  context.mock.method(fsPromises, "readFile", async (path: Parameters<typeof read>[0]) => {
    const bytes = await read(path);
    if (path === changing) writeFileSync(changing, "changed after reading the ZIP bytes");
    return bytes;
  });
  try {
    const identity = await verifyZip(changing);
    assert.equal(identity.sha256Hex, createHash("sha256").update(original).digest("hex"));
    assert.equal(identity.compressedBytes, original.length);
  } finally {
    context.mock.restoreAll();
    rmSync(temp, { recursive: true, force: true });
  }
});
