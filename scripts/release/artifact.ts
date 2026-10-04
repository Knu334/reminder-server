import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { HeadObjectCommand, PutObjectCommand, S3Client, type HeadObjectOutput, type PutObjectOutput, type S3ClientConfig } from "@aws-sdk/client-s3";
import { z } from "zod";
import { StandardRetryStrategy } from "@smithy/core/retry";
import { verifyZip, type ArtifactIdentity } from "../build/verify-zip";

export type RegisteredArtifact = ArtifactIdentity & {bucket: string; key: string; versionId: string; commit: string};
export interface RegistrationContext { commit: string; region: string }
export interface ReleaseManifest {
  commit: string;
  region: string;
  zip: string;
  tools: {node: string; npm: string; esbuild: string};
  artifact: RegisteredArtifact;
  evidence: {audit: string; sbom: string; tests: string};
}

const commitSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const regionSchema = z.string().regex(/^[a-z]{2}(?:-[a-z]+)+-[1-9][0-9]*$/);
const bucketSchema = z.string().min(3).max(63).regex(/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/)
  .refine(value => !value.includes("..") && !/^\d+\.\d+\.\d+\.\d+$/.test(value)
    && !/^(xn--|sthree-|amzn-s3-demo-)/.test(value) && !/(-s3alias|--ol-s3|\.mrap|--x-s3|--table-s3)$/.test(value));
const contextSchema = z.strictObject({commit: commitSchema, region: regionSchema});
const versionSchema = z.string().min(1).refine(value => value !== "null" && value.trim() === value && !Array.from(value).some(char => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127));
const artifactSchema = z.strictObject({
  sha256Hex: z.string().regex(/^[0-9a-f]{64}$/),
  sha256Base64: z.string().regex(/^[A-Za-z0-9+/]{43}=$/),
  compressedBytes: z.number().int().positive().lt(50_000_000),
  unpackedBytes: z.number().int().positive().lt(250_000_000),
  bucket: bucketSchema, key: z.string(), versionId: versionSchema, commit: commitSchema,
});
const supportedClients = new WeakMap<S3Client,StandardRetryStrategy>();
/** Supported registration client: region and a known one-attempt strategy are explicit. */
export function createRegistrationClient(region: string, options: Pick<S3ClientConfig,"credentials" | "requestHandler"> = {}): S3Client {
  const retryStrategy = new StandardRetryStrategy(1);
  const client = new S3Client({...options,region:regionSchema.parse(region),maxAttempts:1,retryStrategy});
  supportedClients.set(client,retryStrategy);
  return client;
}
async function assertSupportedClient(client: S3Client): Promise<void> {
  const strategy = supportedClients.get(client);
  if (!strategy || await client.config.maxAttempts() !== 1 || await client.config.retryStrategy() !== strategy) {
    throw new Error("Use createRegistrationClient with its known one-attempt retry strategy");
  }
}
function releaseKey(identity: ArtifactIdentity): string { return `releases/${identity.sha256Hex}/reminder-server.zip`; }
function checkedArtifact(input: RegisteredArtifact): RegisteredArtifact {
  const artifact = artifactSchema.parse(input);
  if (Buffer.from(artifact.sha256Hex,"hex").toString("base64") !== artifact.sha256Base64 || artifact.key !== releaseKey(artifact)) {
    throw new Error("Artifact hash encodings or release key disagree");
  }
  return artifact;
}
function checkedServerVersion(output: PutObjectOutput, identity: ArtifactIdentity): string {
  const version = versionSchema.parse(output.VersionId);
  if (output.ChecksumSHA256 !== identity.sha256Base64 || output.ChecksumType === "COMPOSITE") {
    throw new Error("Server SHA-256 does not match the uploaded artifact");
  }
  return version;
}
function checkedHead(output: HeadObjectOutput, identity: ArtifactIdentity, versionId?: string): string {
  const actualVersion = checkedServerVersion(output,identity);
  if (output.DeleteMarker || output.ContentLength !== identity.compressedBytes || (versionId !== undefined && actualVersion !== versionId)) {
    throw new Error("Server artifact length or immutable version disagrees");
  }
  return actualVersion;
}
function status(error: unknown): number | undefined {
  return (error as {$metadata?: {httpStatusCode?: number}} | null)?.$metadata?.httpStatusCode;
}
function unknownOutcome(error: unknown): boolean {
  const code = (error as {code?: string; name?: string} | null)?.code ?? (error as {name?: string} | null)?.name;
  const http = status(error);
  return http === 408 || (http !== undefined && http >= 500)
    || ["TimeoutError","RequestTimeout","NetworkingError","AbortError","ECONNRESET","ECONNREFUSED","ETIMEDOUT","EPIPE","ENOTFOUND"].includes(code ?? "");
}
async function currentVersion(bucket: string, identity: ArtifactIdentity, client: S3Client): Promise<string> {
  const output = await client.send(new HeadObjectCommand({Bucket: bucket, Key: releaseKey(identity), ChecksumMode: "ENABLED"}));
  return checkedHead(output,identity);
}

/** Create-only registration. Never download, delete, or replace an existing release. */
export async function registerArtifact(zip: Uint8Array, bucket: string, client: S3Client, context: RegistrationContext): Promise<RegisteredArtifact> {
  // Copy before the first await: validation and upload consume this same private snapshot.
  if (!(zip instanceof Uint8Array) || zip.length === 0 || zip.length >= 50_000_000) throw new Error("Invalid ZIP bytes or compressed size");
  const snapshot = Buffer.from(zip);
  const targetBucket = bucketSchema.parse(bucket), provenance = contextSchema.parse(context);
  if (await client.config.region() !== provenance.region) throw new Error("Client region disagrees with explicit registration region");
  await assertSupportedClient(client);
  const temp = await mkdtemp(join(tmpdir(),"register-lambda-"));
  let identity: ArtifactIdentity;
  try {
    const path = join(temp,"snapshot.zip");
    await writeFile(path,snapshot,{flag:"wx",mode:0o600});
    identity = await verifyZip(path);
  } finally {await rm(temp,{recursive:true,force:true});}
  for (let attempt = 1; attempt <= 3; attempt++) {
    let output: PutObjectOutput;
    try {
      output = await client.send(new PutObjectCommand({
        Bucket: targetBucket, Key: releaseKey(identity), Body: snapshot,
        IfNoneMatch: "*", ChecksumSHA256: identity.sha256Base64, ContentType: "application/zip",
      }));
    } catch (error) {
      if (status(error) === 409) {if (attempt < 3) continue; throw new Error("Conditional upload conflict retry limit reached",{cause:error});}
      if (status(error) === 412 || unknownOutcome(error)) {
        // An uncertain response never triggers another PUT. A checksum-bearing HEAD must prove it.
        const versionId = await currentVersion(targetBucket,identity,client);
        return {...identity,bucket:targetBucket,key:releaseKey(identity),versionId,commit:provenance.commit};
      }
      throw error;
    }
    const versionId = checkedServerVersion(output,identity);
    return {...identity,bucket:targetBucket,key:releaseKey(identity),versionId,commit:provenance.commit};
  }
  throw new Error("Registration attempt budget exhausted");
}

/** Verify the manifest's pinned version, independent of the key's current version. */
export async function readRegisteredArtifact(input: RegisteredArtifact, client: S3Client): Promise<void> {
  const artifact = checkedArtifact(input);
  await assertSupportedClient(client);
  const output = await client.send(new HeadObjectCommand({Bucket: artifact.bucket,Key: artifact.key,VersionId: artifact.versionId,ChecksumMode:"ENABLED"}));
  checkedHead(output,artifact,artifact.versionId);
}

export interface RegistrationIO {stdout(line: string): void; stderr(line: string): void}
export type RegistrationClientFactory = (config: {region: string; maxAttempts: 1}) => S3Client;
const cliFields = ["zip","manifest","bucket","region","commit","npm-version","esbuild-version","audit-id","sbom-id","tests-id"] as const;
const text = z.string().min(1).refine(value => value.trim() === value && !Array.from(value).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127));
const toolVersion = z.string().regex(/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/);
const argumentSchema = z.strictObject({
  zip: text, manifest: text, bucket: bucketSchema, region: regionSchema, commit: commitSchema,
  "npm-version": toolVersion, "esbuild-version": toolVersion,
  "audit-id": text, "sbom-id": text, "tests-id": text,
}).refine(value => resolve(value.zip) !== resolve(value.manifest));
function parseArguments(argv: string[]) {
  const values: Record<string,string> = {};
  for (let index=0;index<argv.length;index++) {
    const flag=argv[index]!,field=flag.slice(2),value=argv[++index];
    if (!flag.startsWith("--") || !cliFields.some(known => known === field) || Object.hasOwn(values,field) || !value || value.startsWith("--")) {
      throw new Error("Invalid, duplicate, or missing registration argument");
    }
    values[field]=value;
  }
  return argumentSchema.parse(values);
}

/** Explicit provenance only. Factory injection lets local tests exclude all AWS transports. */
export async function registrationMain(argv: string[], io: RegistrationIO, createClient: RegistrationClientFactory = config => createRegistrationClient(config.region)): Promise<number> {
  let input: ReturnType<typeof parseArguments>;
  try {input=parseArguments(argv);} catch {
    io.stderr("Invalid registration arguments: all explicit ZIP, manifest, bucket, region, commit, tool-version and evidence-ID flags are required\n"); return 2;
  }
  let client: S3Client | undefined;
  try {
    const bytes = await readFile(input.zip);
    client=createClient({region:input.region,maxAttempts:1});
    const artifact=await registerArtifact(bytes,input.bucket,client,{commit:input.commit,region:input.region});
    const manifest: ReleaseManifest = {
      commit:input.commit,region:input.region,zip:input.zip,
      tools:{node:process.versions.node,npm:input["npm-version"],esbuild:input["esbuild-version"]},artifact,
      evidence:{audit:input["audit-id"],sbom:input["sbom-id"],tests:input["tests-id"]},
    };
    await writeFile(input.manifest,JSON.stringify(manifest,null,2)+"\n",{flag:"wx",mode:0o600});
    io.stdout(JSON.stringify(manifest)+"\n"); return 0;
  } catch {
    io.stderr("Release registration failed; no verified success manifest was produced\n"); return 1;
  } finally {client?.destroy();}
}
if (require.main === module) void registrationMain(process.argv.slice(2),{
  stdout:line=>{process.stdout.write(line);},stderr:line=>{process.stderr.write(line);},
}).then(code=>{process.exitCode=code;});
