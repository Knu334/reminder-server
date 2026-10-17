import {createHash} from "node:crypto";
import {chmod,lstat,mkdir,readFile,readdir,writeFile} from "node:fs/promises";
import {join,resolve} from "node:path";
import {GetObjectCommand,PutObjectCommand,type S3Client} from "@aws-sdk/client-s3";
import {z} from "zod";
import type {ReleaseRoot} from "./plan-guard";

/**
 * release の plan・証拠を private S3 bucket（custody）で受け渡す。
 * 書く側は種類ごとに決めたファイルだけを If-None-Match と SHA-256 の checksum 付きで置き、最後に manifest.json を置く。
 * 読む側は manifest の SHA-256・置き場所・利用期限・ファイルの集合を確かめてから、各ファイルを照合して取り出す。
 */
export type CustodyKind="registered-release"|"release-review"|"release-result"|"failure-diagnostics";
export interface CustodyLocation {kind:CustodyKind;runId:string;runAttempt:number;job?:string}
export interface CustodyManifest {
  version:1;kind:CustodyKind;root:ReleaseRoot|null;runId:string;runAttempt:number;createdAt:string;expiresAt?:string;
  files:Record<string,string>;planReviewSha256?:string;custodySha256?:string;sourceManifestSha256?:string;
}
export type CustodyReference={location:CustodyLocation;manifestSha256:string};
export interface CustodyStore {put(key:string,body:Uint8Array,sha256Base64:string):Promise<void>;get(key:string):Promise<Uint8Array>}

/** release-review の custody.json が hash を持つファイル（platform）。workflow.ts と共有する。 */
export const custodyNames=["inputs.json","baseline.json","artifact.json","request.json","backend.hcl","review.json","saved.tfplan","preview.json"] as const;
/** application の release-review で custody.json に加わる登録済み ZIP の証拠と platform の出力。 */
export const applicationCustodyNames=["registered.json","audit.json","sbom.json","tests.txt","platform-outputs.json"] as const;
const registeredReleaseNames=["registered.json","audit-runtime.json","audit.json","sbom.json","tests.txt"] as const;
const MANIFEST="manifest.json",MAX_DIAGNOSTICS=8;
const DAY_MS=24*3600_000,FUTURE_SKEW_MS=5*60_000;
const kinds=["registered-release","release-review","release-result","failure-diagnostics"] as const;
const expiringKinds:ReadonlySet<CustodyKind>=new Set(["registered-release","release-review"]);

const sha=z.string().regex(/^[0-9a-f]{64}$/);
const runId=z.string().regex(/^[1-9][0-9]{0,19}$/);
const runAttempt=z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const jobName=z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/);
// パスの区切り（/ と \）、先頭の .、.. を含む名前を通さない。manifest.json は予約名。
const safeName=(name:string)=>/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name)&&!name.includes("..")&&name!==MANIFEST;
const manifestSchema=z.strictObject({
  version:z.literal(1),kind:z.enum(kinds),root:z.enum(["platform","application"]).nullable(),runId,runAttempt,
  createdAt:z.string(),expiresAt:z.string().optional(),files:z.record(z.string(),sha),
  planReviewSha256:sha.optional(),custodySha256:sha.optional(),sourceManifestSha256:sha.optional(),
});
const hex=(b:Uint8Array)=>createHash("sha256").update(b).digest("hex");
const base64=(b:Uint8Array)=>createHash("sha256").update(b).digest("base64");

export function custodyPrefix(location:CustodyLocation):string{
  const kind=z.enum(kinds).parse(location.kind),id=runId.parse(location.runId),attempt=runAttempt.parse(location.runAttempt);
  if(kind==="failure-diagnostics")return `${kind}/${id}/${attempt}/${jobName.parse(location.job)}/`;
  if(location.job!==undefined)throw Error("Only failure diagnostics are scoped to a job");
  return `${kind}/${id}/${attempt}/`;
}

export function requiredFiles(kind:CustodyKind,root:ReleaseRoot|null,options:{initialPlatform?:boolean}={}):readonly string[]{
  if(options.initialPlatform&&(kind!=="release-result"||root!=="platform"))throw Error("Initial platform files apply only to a platform release result");
  switch(kind){
    case "registered-release":return [...registeredReleaseNames];
    case "release-review":
      if(root===null)throw Error("Release review requires a root");
      return root==="application"?[...custodyNames,"custody.json","plan.txt",...applicationCustodyNames]:[...custodyNames,"custody.json","plan.txt"];
    case "release-result":
      if(root===null)throw Error("Release result requires a root");
      return options.initialPlatform?["ledger.json","post-baseline.json"]:["ledger.json"];
    case "failure-diagnostics":return [];
  }
}

/** ミリ秒付きの UTC の ISO 8601（Date.prototype.toISOString の形）だけを受け付ける。 */
function instant(value:string|undefined,label:string):number{
  if(value===undefined||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value))throw Error(`Invalid custody ${label}`);
  const ms=Date.parse(value);if(!Number.isFinite(ms)||new Date(ms).toISOString()!==value)throw Error(`Invalid custody ${label}`);
  return ms;
}

/** 利用期限の検査。継承が無ければ expiresAt===createdAt+24h、あれば expiresAt===inheritedExpiresAt を要求する。 */
export function assertUsable(manifest:CustodyManifest,now:Date,inheritedExpiresAt?:string):void{
  const current=now.getTime();if(!Number.isFinite(current))throw Error("Invalid current time");
  const created=instant(manifest.createdAt,"createdAt"),expires=instant(manifest.expiresAt,"expiresAt");
  if(created-current>=FUTURE_SKEW_MS)throw Error("Custody createdAt is in the future");
  if(inheritedExpiresAt===undefined){if(expires!==created+DAY_MS)throw Error("Custody expiresAt must be 24h after createdAt");}
  else{instant(inheritedExpiresAt,"inherited expiresAt");if(manifest.expiresAt!==inheritedExpiresAt)throw Error("Custody expiresAt differs from the inherited expiry");}
  if(current>=expires)throw Error("Custody has expired");
}

/** 種類ごとの項目の整合（置き場所の照合の後に行う）。 */
function checkKindFields(m:CustodyManifest):void{
  if(expiringKinds.has(m.kind)!==(m.expiresAt!==undefined))throw Error("Custody expiresAt does not fit its kind");
  if(m.kind==="release-review"){
    if(m.root===null||m.planReviewSha256===undefined||m.custodySha256===undefined)throw Error("Release review manifest lacks plan or custody digest");
    if(m.files["custody.json"]!==m.custodySha256)throw Error("Release review custody digest mismatch");
  }else if(m.planReviewSha256!==undefined||m.custodySha256!==undefined||m.sourceManifestSha256!==undefined)throw Error("Review digests belong only to a release review");
  if(m.kind==="release-result"&&m.root===null)throw Error("Release result requires a root");
}

function checkFileSet(m:CustodyManifest,options:{initialPlatform?:boolean}):void{
  const names=Object.keys(m.files);
  for(const name of names)if(!safeName(name))throw Error("Unsafe custody file name");
  if(m.kind==="failure-diagnostics"){if(names.length>MAX_DIAGNOSTICS||names.some(n=>!n.endsWith(".json")))throw Error("Custody manifest file set mismatch");return;}
  const expected=[...requiredFiles(m.kind,m.root,options)].sort();
  if(JSON.stringify([...names].sort())!==JSON.stringify(expected))throw Error("Custody manifest file set mismatch");
}

async function regularFile(path:string):Promise<Uint8Array>{
  const s=await lstat(path).catch(()=>undefined);if(!s)throw Error("Required custody file missing");
  if(!s.isFile()||s.isSymbolicLink())throw Error("Custody files must be regular files");
  return readFile(path);
}

async function diagnosticNames(directory:string):Promise<string[]>{
  const names=(await readdir(directory)).filter(n=>n.endsWith(".json")).sort();
  if(names.length>MAX_DIAGNOSTICS)throw Error(`At most ${MAX_DIAGNOSTICS} diagnostic files are kept`);
  for(const name of names)if(!safeName(name))throw Error("Unsafe custody file name");
  return names;
}

export async function writeCustody(store:CustodyStore,location:CustodyLocation,directory:string,fields:Pick<CustodyManifest,"root"|"planReviewSha256"|"custodySha256"|"sourceManifestSha256"|"expiresAt">,now:Date,options:{initialPlatform?:boolean}={}):Promise<{manifestSha256:string;manifestSha256Base64:string}>{
  const prefix=custodyPrefix(location),kind=location.kind,dir=resolve(directory);
  const names=kind==="failure-diagnostics"?await diagnosticNames(dir):requiredFiles(kind,fields.root,options);
  // 1つでも欠けていれば何も書かない。集合に無い作業用のファイルは読まない。
  const bodies=new Map<string,Uint8Array>();for(const name of names)bodies.set(name,await regularFile(join(dir,name)));
  const createdAt=new Date(now.getTime()).toISOString();
  if(fields.expiresAt!==undefined)instant(fields.expiresAt,"expiresAt");
  const expiresAt=fields.expiresAt??(expiringKinds.has(kind)?new Date(now.getTime()+DAY_MS).toISOString():undefined);
  const files:Record<string,string>={};for(const [name,body] of bodies)files[name]=hex(body);
  const manifest=manifestSchema.parse({
    version:1,kind,root:fields.root,runId:location.runId,runAttempt:location.runAttempt,createdAt,
    ...(expiresAt===undefined?{}:{expiresAt}),files,
    ...(fields.planReviewSha256===undefined?{}:{planReviewSha256:fields.planReviewSha256}),
    ...(fields.custodySha256===undefined?{}:{custodySha256:fields.custodySha256}),
    ...(fields.sourceManifestSha256===undefined?{}:{sourceManifestSha256:fields.sourceManifestSha256}),
  }) as CustodyManifest;
  checkKindFields(manifest);checkFileSet(manifest,options);
  for(const [name,body] of bodies)await store.put(`${prefix}${name}`,body,base64(body));
  const bytes=Buffer.from(JSON.stringify(manifest,null,2)+"\n");
  await store.put(`${prefix}${MANIFEST}`,bytes,base64(bytes));
  return {manifestSha256:hex(bytes),manifestSha256Base64:base64(bytes)};
}

/** manifest.json だけを取得し、SHA-256・形式・置き場所・種類ごとの項目を確かめる。期限は検査しない。 */
export async function readOriginalManifest(store:CustodyStore,location:CustodyLocation,expectedManifestSha256:string):Promise<CustodyManifest>{
  const prefix=custodyPrefix(location),expected=sha.parse(expectedManifestSha256);
  const bytes=await store.get(`${prefix}${MANIFEST}`);
  if(hex(bytes)!==expected)throw Error("Custody manifest digest mismatch");
  const m=manifestSchema.parse(JSON.parse(Buffer.from(bytes).toString("utf8"))) as CustodyManifest;
  if(m.kind!==location.kind||m.runId!==location.runId||m.runAttempt!==location.runAttempt)throw Error("Custody manifest does not match its location");
  checkKindFields(m);
  return m;
}

/** 取り出し先は、無いか、空の実ディレクトリでなければならない。 */
async function checkDestination(destination:string):Promise<void>{
  const s=await lstat(destination).catch((e:unknown)=>{if((e as NodeJS.ErrnoException).code==="ENOENT")return undefined;throw e;});
  if(!s)return;
  if(!s.isDirectory()||s.isSymbolicLink())throw Error("Custody destination must be a private directory");
  if((await readdir(destination)).length>0)throw Error("Custody destination must be empty");
}

export async function readCustody(store:CustodyStore,location:CustodyLocation,expectedManifestSha256:string,destination:string,expected:{root:ReleaseRoot|null;now:Date;initialPlatform?:boolean;inheritedExpiresAt?:string}):Promise<CustodyManifest>{
  const m=await readOriginalManifest(store,location,expectedManifestSha256);
  if(m.root!==expected.root)throw Error("Custody manifest root mismatch");
  if(expiringKinds.has(m.kind))assertUsable(m,expected.now,expected.inheritedExpiresAt);
  else if(expected.inheritedExpiresAt!==undefined)throw Error("Custody kind has no expiry to inherit");
  checkFileSet(m,{initialPlatform:expected.initialPlatform===true});
  const dest=resolve(destination);await checkDestination(dest);
  // manifest に載ったファイルだけを読み、すべて照合してから書き出す。
  const prefix=custodyPrefix(location),bodies=new Map<string,Uint8Array>();
  for(const [name,digest] of Object.entries(m.files)){const body=await store.get(`${prefix}${name}`);if(hex(body)!==digest)throw Error("Custody file SHA-256 changed");bodies.set(name,body);}
  await mkdir(dest,{recursive:true,mode:0o700});await checkDestination(dest);await chmod(dest,0o700);
  for(const [name,body] of bodies){const p=join(dest,name);await writeFile(p,body,{mode:0o600,flag:"wx"});await chmod(p,0o600);}
  const written=(await readdir(dest)).sort();
  if(JSON.stringify(written)!==JSON.stringify(Object.keys(m.files).sort()))throw Error("Custody destination changed during extraction");
  return m;
}

export function createS3CustodyStore(bucket:string,client:S3Client):CustodyStore{
  return {
    async put(key,body,sha256Base64){
      await client.send(new PutObjectCommand({Bucket:bucket,Key:key,Body:body,IfNoneMatch:"*",ChecksumSHA256:sha256Base64}));
    },
    async get(key){
      const response=await client.send(new GetObjectCommand({Bucket:bucket,Key:key,ChecksumMode:"ENABLED"}));
      if(!response.Body)throw Error("Custody object has no body");
      const bytes=await response.Body.transformToByteArray();
      if(response.ChecksumSHA256!==undefined&&response.ChecksumSHA256!==base64(bytes))throw Error("Custody object checksum mismatch");
      return bytes;
    },
  };
}
