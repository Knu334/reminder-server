import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { StandardRetryStrategy } from "@smithy/core/retry";
import { createRegistrationClient, registerArtifact, readRegisteredArtifact, registrationMain, type RegisteredArtifact } from "../../scripts/release/artifact";

const commit = "a".repeat(40);
const context = { commit, region: "us-east-1" };
const bucket = "synthetic-releases";
// Canonical, hermetically loadable synthetic archive, independent of generated bundles.
const bytes = execFileSync("python3", ["-c", `
import io,sys,zipfile,stat,json
out=io.BytesIO()
with zipfile.ZipFile(out,'w',compression=zipfile.ZIP_DEFLATED) as z:
    items=[('THIRD_PARTY_NOTICES','Synthetic license'),('dist/','')]
    for name in ['api','cleanup']:
        factory='createApiHandler' if name=='api' else 'createCleanupHandler'
        items += [('dist/'+name+'.js','exports.handler=()=>{};exports.'+factory+'=()=>{};'),('dist/'+name+'.js.map',json.dumps({'version':3,'sources':['synthetic.ts']}))]
    for name,value in items:
        entry=zipfile.ZipInfo(name,(1980,1,1,0,0,0));entry.create_system=3
        entry.external_attr=((stat.S_IFDIR|0o755) if name.endswith('/') else (stat.S_IFREG|0o644))<<16
        entry.compress_type=zipfile.ZIP_DEFLATED;z.writestr(entry,value)
sys.stdout.buffer.write(out.getvalue())
`]);
const digest = createHash("sha256").update(bytes).digest();
const hex = digest.toString("hex"), base64 = digest.toString("base64");
const key = `releases/${hex}/reminder-server.zip`;
type Command = PutObjectCommand | HeadObjectCommand;
function fake(run: (command: Command, index: number) => unknown, region = "us-east-1", maxAttempts = 1) {
  const calls: Command[] = [];
  const client = createRegistrationClient(region,{credentials: {accessKeyId: "synthetic", secretAccessKey: "synthetic"}});
  if (maxAttempts !== 1) client.config.maxAttempts=async()=>maxAttempts;
  // No client transport: every send is intercepted, unknown command types fail closed.
  client.send = (async (command: Command) => {
    assert.ok(command instanceof PutObjectCommand || command instanceof HeadObjectCommand);
    calls.push(command); return run(command, calls.length);
  }) as S3Client["send"];
  return {client, calls};
}
function error(status: number, name = "SyntheticError") { return Object.assign(new Error(name), {name, $metadata: {httpStatusCode: status}}); }
const putOK = { $metadata: {httpStatusCode: 200}, VersionId: "synthetic-version", ChecksumSHA256: base64 };
const headOK = { ...putOK, ContentLength: bytes.length, ChecksumType: "FULL_OBJECT" as const };

void test("puts_once_with_conditional_checksum", async () => {
  const {client,calls} = fake(() => putOK);
  const result = await registerArtifact(bytes, bucket, client, context);
  assert.equal(calls.length, 1);
  assert.ok(calls[0] instanceof PutObjectCommand);
  const put = calls[0].input;
  assert.equal(put.IfNoneMatch, "*"); assert.equal(put.ChecksumSHA256, base64);
  assert.equal(put.Bucket, bucket); assert.equal(put.Key, key);
  assert.deepEqual(put.Body, bytes);
  assert.equal(result.sha256Hex, hex); assert.equal(result.sha256Base64, base64);
  assert.equal(result.compressedBytes, bytes.length); assert.ok(result.unpackedBytes > 0);
  assert.equal(result.versionId, "synthetic-version"); assert.equal(result.commit, commit);
});

void test("existing_release_requires_server_checksum_and_version", async () => {
  const {client,calls} = fake(command => { if (command instanceof PutObjectCommand) throw error(412); return headOK; });
  const result = await registerArtifact(bytes, bucket, client, context);
  assert.equal(calls.length, 2); assert.ok(calls[1] instanceof HeadObjectCommand);
  assert.deepEqual(calls[1].input, {Bucket: bucket, Key: key, ChecksumMode: "ENABLED"});
  assert.equal(result.versionId, "synthetic-version");
  await readRegisteredArtifact(result, client);
  assert.ok(calls[2] instanceof HeadObjectCommand);
  assert.deepEqual(calls[2].input, {Bucket: bucket, Key: key, VersionId: "synthetic-version", ChecksumMode: "ENABLED"});
});

void test("mismatched_checksum_never_reused", async () => {
  for (const bad of [
    {...headOK, ChecksumSHA256: createHash("sha256").update("different bytes").digest("base64")},
    {...headOK, ChecksumSHA256: undefined, ETag: hex},
    {...headOK, VersionId: undefined}, {...headOK, VersionId: "null"},
    {...headOK, ContentLength: bytes.length + 1}, {...headOK, DeleteMarker: true},
    {...headOK, ChecksumType: "COMPOSITE"},
  ]) {
    const {client,calls} = fake(command => {if (command instanceof PutObjectCommand) throw error(412); return bad;});
    await assert.rejects(registerArtifact(bytes, bucket, client, context));
    assert.equal(calls.length, 2);
  }
});

void test("transient_conflict_retry_is_bounded", async () => {
  const succeeds = fake((_command,index) => { if (index < 3) throw error(409); return putOK; });
  await registerArtifact(bytes, bucket, succeeds.client, context);
  assert.equal(succeeds.calls.length, 3);
  for (const command of succeeds.calls) {assert.ok(command instanceof PutObjectCommand); assert.equal(command.input.IfNoneMatch, "*"); assert.deepEqual(command.input.Body, bytes);}
  const fails = fake(() => {throw error(409);});
  await assert.rejects(registerArtifact(bytes, bucket, fails.client, context));
  assert.equal(fails.calls.length, 3);
});

void test("unknown_outcome_is_confirmed_by_head_without_reupload", async () => {
  for (const failure of [error(503), Object.assign(new Error("socket interrupted"), {code: "ECONNRESET"})]) {
    const {client,calls} = fake(command => {if (command instanceof PutObjectCommand) throw failure; return headOK;});
    assert.equal((await registerArtifact(bytes,bucket,client,context)).versionId, "synthetic-version");
    assert.equal(calls.length,2); assert.ok(calls[1] instanceof HeadObjectCommand);
  }
});

void test("unproven_unknown_outcome_fails_without_reupload", async () => {
  for (const result of [error(404), {...headOK, ChecksumSHA256: "wrong"}, {...headOK, VersionId: undefined}]) {
    const {client,calls} = fake(command => {if (command instanceof PutObjectCommand) throw error(500); if (result instanceof Error) throw result; return result;});
    await assert.rejects(registerArtifact(bytes,bucket,client,context)); assert.equal(calls.length,2);
  }
  const forbidden = fake(() => {throw error(403);});
  await assert.rejects(registerArtifact(bytes,bucket,forbidden.client,context)); assert.equal(forbidden.calls.length,1);
});

void test("successful_put_requires_checksum_and_immutable_version", async () => {
  for (const result of [{...putOK, ChecksumSHA256: "wrong"}, {...putOK, ChecksumSHA256: undefined}, {...putOK, VersionId: undefined}, {...putOK, VersionId: "null"}]) {
    const {client,calls} = fake(() => result);
    await assert.rejects(registerArtifact(bytes,bucket,client,context)); assert.equal(calls.length,1);
  }
});

void test("uploaded_bytes_are_a_snapshot_and_invalid_archives_never_send", async () => {
  const supplied = Uint8Array.from(bytes);
  const {client,calls} = fake(() => putOK);
  const pending = registerArtifact(supplied,bucket,client,context);
  supplied.fill(0);
  const result = await pending;
  assert.equal(result.sha256Hex, hex); assert.ok(calls[0] instanceof PutObjectCommand); assert.deepEqual(calls[0].input.Body,bytes);
  const bad = fake(() => putOK);
  await assert.rejects(registerArtifact(Buffer.from("not a ZIP"),bucket,bad.client,context)); assert.equal(bad.calls.length,0);
});

void test("provenance_region_and_retry_budget_are_validated_before_upload", async () => {
  for (const candidate of [{commit: "",region: "us-east-1"}, {commit: "main",region: "us-east-1"}, {commit,region: ""}, {commit,region: "eu-west-1"}]) {
    const {client,calls} = fake(() => putOK);
    await assert.rejects(registerArtifact(bytes,bucket,client,candidate)); assert.equal(calls.length,0);
  }
  for (const invalidBucket of ["", "bucket/path", "UPPERCASE", "s3://synthetic"]) {
    const {client,calls} = fake(() => putOK);
    await assert.rejects(registerArtifact(bytes,invalidBucket,client,context)); assert.equal(calls.length,0);
  }
  const retrying = fake(() => putOK,"us-east-1",3);
  await assert.rejects(registerArtifact(bytes,bucket,retrying.client,context)); assert.equal(retrying.calls.length,0);
});

void test("read_rejects_inconsistent_identity_and_changed_version", async () => {
  const good = fake(() => putOK);
  const artifact = await registerArtifact(bytes,bucket,good.client,context);
  for (const change of [{sha256Hex: "b".repeat(64)}, {sha256Base64: "wrong"}, {key: "releases/other.zip"}, {commit:"main"}, {versionId:"null"}, {compressedBytes:0}, {unpackedBytes:250_000_000}]) {
    const reader = fake(() => headOK);
    await assert.rejects(readRegisteredArtifact({...artifact,...change} as RegisteredArtifact,reader.client)); assert.equal(reader.calls.length,0);
  }
  for (const change of [{VersionId: "changed"}, {ChecksumSHA256: "wrong"}, {ContentLength: bytes.length + 1}]) {
    const reader = fake(() => ({...headOK,...change}));
    await assert.rejects(readRegisteredArtifact(artifact,reader.client)); assert.equal(reader.calls.length,1);
  }
});

function args(zip: string, manifest: string): string[] {return ["--zip",zip,"--manifest",manifest,"--bucket",bucket,"--region",context.region,"--commit",commit,"--npm-version","11.11.1","--esbuild-version","0.28.2","--audit-id","synthetic-audit-sha256","--sbom-id","synthetic-sbom-sha256","--tests-id","synthetic-tests-sha256"];}
void test("cli_requires_explicit_inputs_and_strict_flags_before_client_creation", async () => {
  const valid = args("synthetic.zip","synthetic-manifest.json");
  const candidates = [[], ...Array.from({length:valid.length/2},(_,index)=>valid.filter((_,at)=>at<index*2 || at>index*2+1)), [...valid,"--unknown","value"], [...valid,"--bucket",bucket], [...valid,"--region"], valid.map(value => value===commit ? "main" : value), valid.map(value => value==="11.11.1" ? "" : value)];
  for (const argv of candidates) {
    let clients = 0; const stderr: string[] = [];
    const code = await registrationMain(argv, {stdout:()=>{},stderr:line=>{stderr.push(line);}}, () => {clients++; throw new Error("must not create client");});
    assert.equal(code,2); assert.equal(clients,0); assert.ok(stderr.length);
  }
});

void test("cli_writes_release_manifest_after_checksum_verified_registration", async () => {
  const temp = await mkdtemp(join(tmpdir(),"registration-cli-"));
  try {
    const zip = join(temp,"synthetic.zip"), manifest = join(temp,"manifest.json"); await writeFile(zip,bytes);
    const transport = fake(() => putOK); const output: string[] = [];
    const code = await registrationMain(args(zip,manifest), {stdout:line=>{output.push(line);},stderr:()=>{assert.fail("unexpected CLI error");}}, config => {
      assert.deepEqual(config,{region:"us-east-1",maxAttempts:1}); return transport.client;
    });
    assert.equal(code,0); assert.equal(transport.calls.length,1);
    const result = JSON.parse(await readFile(manifest,"utf8"));
    assert.equal(result.commit,commit); assert.equal(result.region,"us-east-1");
    assert.deepEqual(result.tools,{node:process.versions.node,npm:"11.11.1",esbuild:"0.28.2"});
    assert.deepEqual(result.evidence,{audit:"synthetic-audit-sha256",sbom:"synthetic-sbom-sha256",tests:"synthetic-tests-sha256"});
    assert.equal(result.zip,zip); assert.equal(result.artifact.key,key); assert.equal(result.artifact.versionId,"synthetic-version");
    assert.equal(result.artifact.sha256Hex,hex); assert.equal(result.artifact.commit,commit); assert.ok(output.length);
  } finally {await rm(temp,{recursive:true,force:true});}
});

void test("cli_registration_failure_does_not_write_a_success_manifest", async () => {
  const temp = await mkdtemp(join(tmpdir(),"registration-failed-"));
  try {
    const zip = join(temp,"synthetic.zip"),manifest = join(temp,"manifest.json"); await writeFile(zip,bytes);
    const transport = fake(() => {throw error(403);});
    assert.equal(await registrationMain(args(zip,manifest),{stdout:()=>{assert.fail("unexpected success");},stderr:()=>{}},()=>transport.client),1);
    await assert.rejects(readFile(manifest));
  } finally {await rm(temp,{recursive:true,force:true});}
});

void test("different_valid_archive_bytes_cannot_reuse_original_identity", async () => {
  const changed = execFileSync("python3",["-c",`
import io,sys,zipfile
source=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read()));out=io.BytesIO()
with zipfile.ZipFile(out,'w') as target:
    for info in source.infolist(): target.writestr(info,b'Changed synthetic license' if info.filename=='THIRD_PARTY_NOTICES' else source.read(info))
sys.stdout.buffer.write(out.getvalue())
`],{input:bytes});
  const changedHash=createHash("sha256").update(changed).digest("hex");
  assert.notEqual(changedHash,hex);
  const transport=fake(command=>{if(command instanceof PutObjectCommand) throw error(412);return headOK;});
  await assert.rejects(registerArtifact(changed,bucket,transport.client,context));
  assert.ok(transport.calls[0] instanceof PutObjectCommand);
  assert.equal(transport.calls[0].input.Key,`releases/${changedHash}/reminder-server.zip`);
  assert.deepEqual(transport.calls[0].input.Body,changed);
});

void test("cli_rejects_aliasing_zip_and_manifest_paths_before_creating_client", async () => {
  let clients=0;
  assert.equal(await registrationMain(args("artifacts/synthetic.zip","artifacts/../artifacts/synthetic.zip"),{stdout:()=>{},stderr:()=>{}},()=>{clients++;throw Error("must not create client");}),2);
  assert.equal(clients,0);
});

void test("arbitrary_custom_strategy_is_rejected_before_commands", async () => {
  const transport=fake(()=>putOK);
  transport.client.config.retryStrategy=async()=>new StandardRetryStrategy(3);
  await assert.rejects(registerArtifact(bytes,bucket,transport.client,context));
  assert.equal(transport.calls.length,0);
});

void test("supported_client_bounds_actual_synthetic_transport_attempts", async () => {
  let attempts=0;
  const client=createRegistrationClient("us-east-1",{
    credentials:{accessKeyId:"synthetic",secretAccessKey:"synthetic"},
    requestHandler:{handle:()=>{attempts++;return Promise.reject(error(409,"ConditionalRequestConflict"));}},
  });
  try {
    await assert.rejects(registerArtifact(bytes,bucket,client,context));
    assert.equal(attempts,3);
    assert.equal(await client.config.maxAttempts(),1);
  } finally {client.destroy();}
});

void test("unmanaged_clients_are_rejected_even_with_max_attempts_one", async () => {
  const client=new S3Client({region:"us-east-1",maxAttempts:1,credentials:{accessKeyId:"synthetic",secretAccessKey:"synthetic"}});
  let sends=0;
  client.send=(()=>{sends++;throw Error("must not send");}) as S3Client["send"];
  try {await assert.rejects(registerArtifact(bytes,bucket,client,context));assert.equal(sends,0);} finally {client.destroy();}
});

void test("sdk_unknown_outcome_transport_is_not_retried_before_checksum_head", async () => {
  const methods: string[]=[];
  const client=createRegistrationClient("us-east-1",{
    credentials:{accessKeyId:"synthetic",secretAccessKey:"synthetic"},
    requestHandler:{handle:(request: {method: string})=>{
      methods.push(request.method);
      if(request.method==="PUT") return Promise.reject(error(503,"ServiceUnavailable"));
      assert.equal(request.method,"HEAD");
      return Promise.resolve({response:{statusCode:200,headers:{
        "content-length":String(bytes.length),"x-amz-version-id":"synthetic-version",
        "x-amz-checksum-sha256":base64,"x-amz-checksum-type":"FULL_OBJECT",
      },body:Buffer.alloc(0)}});
    }},
  });
  try {
    assert.equal((await registerArtifact(bytes,bucket,client,context)).versionId,"synthetic-version");
    assert.deepEqual(methods,["PUT","HEAD"]);
  } finally {client.destroy();}
});
