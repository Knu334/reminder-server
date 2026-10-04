import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export interface ArtifactIdentity {
  sha256Hex: string;
  sha256Base64: string;
  compressedBytes: number;
  unpackedBytes: number;
}

/** Validate the exact archive layout before extracting, then load both isolated handlers. */
export async function verifyZip(path: string): Promise<ArtifactIdentity> {
  if (process.versions.node.split(".")[0] !== "24") throw new Error("ZIP verification requires Node24");
  const bytes = await readFile(path);
  if (bytes.length >= 50_000_000) throw new Error("Compressed artifact must be below 50 MB");
  const temp = await mkdtemp(join(tmpdir(), "verify-lambda-"));
  try {
    const unpackedBytes = Number(execFileSync("python3", ["-c", `
import io,sys,zipfile,stat
names=['THIRD_PARTY_NOTICES','dist/','dist/api.js','dist/api.js.map','dist/cleanup.js','dist/cleanup.js.map']
with zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as z:
    if z.namelist()!=names: raise ValueError('Unexpected ZIP entries or order')
    size=sum(i.file_size for i in z.infolist())
    if size>=250_000_000: raise ValueError('Unpacked artifact must be below 250 MB')
    for i in z.infolist():
        mode=(stat.S_IFDIR|0o755) if i.is_dir() else (stat.S_IFREG|0o644)
        if i.external_attr>>16!=mode or i.create_system!=3: raise ValueError('Invalid ZIP type or mode')
        if i.date_time!=(1980,1,1,0,0,0) or i.extra or i.comment: raise ValueError('Noncanonical ZIP metadata')
        if i.flag_bits&1: raise ValueError('Encrypted entry is forbidden')
    if z.comment or z.testzip() is not None: raise ValueError('Invalid ZIP CRC or comment')
    z.extractall(sys.argv[1])
    print(size)
`, temp], { input: bytes, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim());
    const script = `const assert=require('node:assert/strict'); for(const [name,factory] of [['api','createApiHandler'],['cleanup','createCleanupHandler']]) { const mod=require('./dist/'+name+'.js'); assert.equal(typeof mod.handler,'function'); assert.equal(typeof mod[factory],'function'); const map=JSON.parse(require('node:fs').readFileSync('./dist/'+name+'.js.map','utf8')); assert.equal(map.version,3); assert.ok(map.sources.length); assert.equal(map.sourcesContent,undefined); } assert.ok(require('node:fs').readFileSync('./THIRD_PARTY_NOTICES','utf8').trim());`;
    execFileSync(process.execPath, ["--no-addons", "-e", script], { cwd: temp, env: { NODE_PATH: "", HOME: temp }, stdio: ["ignore", "pipe", "pipe"] });
    const digest = createHash("sha256").update(bytes).digest();
    return { sha256Hex: digest.toString("hex"), sha256Base64: digest.toString("base64"), compressedBytes: bytes.length, unpackedBytes };
  } finally { await rm(temp, { recursive: true, force: true }); }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === __filename) {
  const path = process.argv[2];
  if (path === undefined) { console.error("Usage: verify-zip.ts <zip>"); process.exitCode = 1; }
  else void verifyZip(path).then(identity => console.log(JSON.stringify(identity))).catch(error => { console.error(error); process.exitCode = 1; });
}
