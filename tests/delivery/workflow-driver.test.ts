import assert from "node:assert/strict";
import {lstat,mkdir,mkdtemp,readFile,readdir,writeFile,rm,stat,symlink} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createHash} from "node:crypto";
import {test} from "node:test";
import {artifact,baseline,applicationPlan,platformPlan,runtimeData} from "../fixtures/synthetic/plans/fixtures";
import type {ReleaseManifest} from "../../scripts/release/artifact";
import type {WorkflowContext,CommandRunner,ReleaseServices,WorkflowConfig} from "../../scripts/release/workflow";
import {custodyPrefix,requiredFiles,writeCustody,type CustodyManifest,type CustodyReference,type CustodyStore} from "../../scripts/release/custody";
async function driver(){let module:typeof import("../../scripts/release/workflow")|undefined;try{module=await import("../../scripts/release/workflow");}catch{ /* missing implementation is an assertion below */ }assert.ok(module,"protected release driver must exist");return module;}
const digest=(s:string|Uint8Array)=>createHash("sha256").update(s).digest("hex");
const b64=(s:string|Uint8Array)=>createHash("sha256").update(s).digest("base64");
const outputs={runtime_data:{value:runtimeData},api_id:{value:baseline.apiId},api_base_url:{value:baseline.apiBaseUrl},api_alias_arn:{value:"arn:aws:lambda:us-east-1:123456789012:function:synthetic-api:production"},cleanup_alias_arn:{value:"arn:aws:lambda:us-east-1:123456789012:function:synthetic-cleanup:production"},api_version:{value:"2"},cleanup_version:{value:"3"},release_sha256_base64:{value:artifact.sha256Base64}};
const platformOutputs=Object.fromEntries(Object.entries({reminders_table:"synthetic-production-reminders",owner_state_table:"synthetic-production-owner-state",image_jobs_table:"synthetic-production-image-jobs",images_bucket:"synthetic-123456789012-us-east-1-images",api_role_arn:"arn:aws:iam::123456789012:role/synthetic-production-api",cleanup_role_arn:"arn:aws:iam::123456789012:role/synthetic-production-cleanup",api_log_group:"/aws/lambda/synthetic-production-api",cleanup_log_group:"/aws/lambda/synthetic-production-cleanup",gateway_log_group:"/aws/apigateway/synthetic-production-api",cognito_issuer:baseline.cognitoIssuer,cognito_client_id:baseline.cognitoClientId,cognito_auth_base_url:baseline.cognitoAuthBaseUrl,restored_tables:{},reminders_table_arn:"arn:aws:dynamodb:us-east-1:123456789012:table/synthetic-production-reminders",owner_state_table_arn:"arn:aws:dynamodb:us-east-1:123456789012:table/synthetic-production-owner-state",image_jobs_table_arn:"arn:aws:dynamodb:us-east-1:123456789012:table/synthetic-production-image-jobs",unused_secret:"never copy"}).map(([k,v])=>[k,{value:v}]));

// S3 の代わりの fake。既存 key への put は拒否し、get した key を記録する。
class FakeStore implements CustodyStore {
  readonly objects=new Map<string,Uint8Array>();readonly order:string[]=[];readonly gets:string[]=[];
  put(key:string,body:Uint8Array):Promise<void>{if(this.objects.has(key))return Promise.reject(Error("PreconditionFailed"));this.objects.set(key,Uint8Array.from(body));this.order.push(key);return Promise.resolve();}
  get(key:string):Promise<Uint8Array>{this.gets.push(key);const v=this.objects.get(key);return v?Promise.resolve(Uint8Array.from(v)):Promise.reject(Error("NoSuchKey"));}
}
// terraform の fake：plan ごとに別の binary を作り、show -json は binary の中身から plan の JSON を引く。
const shownPlans=new Map<string,string>();let binaries=0,runs=1000;
const start=new Date("2026-10-12T00:00:00.000Z"),H=3600_000;
const at=(ms:number)=>new Date(start.getTime()+ms);
async function fixture(root:"platform"|"application"="application",options:{store?:FakeStore}={}) {
  const d=await driver(),runnerTemp=await mkdtemp(join(tmpdir(),"workflow-synthetic-")),directory=join(runnerTemp,"release");
  const store=options.store??new FakeStore();let clock=start;const runId=String(++runs);
  const context:WorkflowContext={directory,root,commit:artifact.commit,region:"us-east-1",apply:false,published:false,schedulerEnabled:false,custodyStore:store,runId,runAttempt:1,now:()=>clock};
  const inputs={account_id:"123456789012",region:"us-east-1",name_prefix:"synthetic",chrome_origin:"https://synthetic.example",production_api_id:baseline.apiId,cognito_domain_prefix:"synthetic",scheduler_role_arn:"arn:aws:iam::123456789012:role/synthetic-production-scheduler"};
  const config={inputs,baseline:root==="application"?baseline:{...baseline,root:"platform" as const,apiBaseUrl:null,apiId:null},stateBucket:"synthetic-123456789012-us-east-1-state"};
  const source=join(runnerTemp,"registered");await mkdir(source,{mode:0o700});const evidence={audit:'{"metadata":{"vulnerabilities":{"high":0,"critical":0}}}',sbom:'{"bomFormat":"CycloneDX"}',tests:"synthetic passing validation"};
  const registered:ReleaseManifest={commit:artifact.commit,region:context.region,zip:"artifacts/reminder-server.zip",tools:{node:"24.21.0",npm:"11.11.1",esbuild:"0.28.2"},artifact,evidence:{audit:`sha256:${digest(evidence.audit)}`,sbom:`sha256:${digest(evidence.sbom)}`,tests:`sha256:${digest(evidence.tests)}`}};
  for(const [name,text] of Object.entries(evidence))await writeFile(join(source,`${name}.${name==="tests"?"txt":"json"}`),text);await writeFile(join(source,"registered.json"),JSON.stringify(registered));await writeFile(join(source,"audit-runtime.json"),'{"metadata":{"vulnerabilities":{}}}');
  const plan=root==="application"?applicationPlan():platformPlan();const commands:string[][]=[];let headCount=0,verifyCount=0,smokeCount=0;
  const run:CommandRunner=async(command,args)=>{commands.push([command,...args]);if(command==="git")return artifact.commit+"\n";const mode=args[1];
    if(mode==="plan"){const out=args.find(a=>a.startsWith("-out="))!.slice(5);const vars=JSON.parse(await readFile(join(directory,"inputs.json"),"utf8"));for(const [key,value] of Object.entries(vars))if(!(key in plan.variables))(plan.variables as Record<string,{value:unknown}>)[key]={value};const binary=`saved binary ${++binaries}`;shownPlans.set(binary,JSON.stringify(plan));await writeFile(out,binary);return "private stdout must not leak";}
    if(mode==="show"&&args[2]==="-no-color"){await readFile(args[3]!);return "synthetic human-readable plan\n";}
    if(mode==="show"&&args[2]==="-json"&&args[3]){const text=shownPlans.get(await readFile(args[3],"utf8"));if(text===undefined)throw Error("unknown saved plan");return text;}
    if(mode==="output")return JSON.stringify(args[0]?.includes("platform")?platformOutputs:outputs);return "";};
  const services:ReleaseServices={run,head:async(a,region)=>{assert.deepEqual(a,artifact);assert.equal(region,"us-east-1");headCount++;},verify:async(a,o,region)=>{assert.deepEqual(a,artifact);assert.deepEqual(o,outputs);assert.equal(region,"us-east-1");verifyCount++;},smoke:async(b,p)=>{assert.deepEqual(b,baseline);assert.equal(p,false);smokeCount++;}};
  // 同じ run の register job が registered-release を書いたものとして扱う（初回の呼び出しで書く）。
  let reference:CustodyReference|undefined;
  const src=async()=>{if(!reference){const location={kind:"registered-release" as const,runId,runAttempt:1};reference={location,manifestSha256:(await writeCustody(store,location,source,{root:"application"},clock)).manifestSha256};}return reference;};
  return {d,runnerTemp,directory,context,config,source,registered,plan,commands,services,store,src,setNow:(t:Date)=>{clock=t;},counts:()=>({headCount,verifyCount,smokeCount}),cleanup:async()=>{await rm(runnerTemp,{recursive:true,force:true});}};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
const reviewRef=(f:Fixture,r:{manifestSha256:string},runAttempt=f.context.runAttempt):CustodyReference=>({location:{kind:"release-review",runId:f.context.runId,runAttempt},manifestSha256:r.manifestSha256});
function manifestAt(store:FakeStore,ref:CustodyReference):CustodyManifest{return JSON.parse(Buffer.from(store.objects.get(`${custodyPrefix(ref.location)}manifest.json`)!).toString()) as CustodyManifest;}
const planned=(f:Fixture)=>f.commands.filter(c=>c[0]==="terraform"&&c[2]==="plan").length;
/** 取り出した bundle を書き換え、manifest と各ファイルの hash を整合させたまま別の run ID に置く。 */
async function forge(store:FakeStore,from:CustodyReference,runId:string,mutate:(files:Map<string,Buffer>)=>void):Promise<CustodyReference>{
  const prefix=custodyPrefix(from.location),m=manifestAt(store,from);const files=new Map(Object.keys(m.files).map(n=>[n,Buffer.from(store.objects.get(prefix+n)!)]));mutate(files);
  const location={...from.location,runId},to=custodyPrefix(location),hashes:Record<string,string>={};for(const [n,b] of files){store.objects.set(to+n,b);hashes[n]=digest(b);}
  const bytes=Buffer.from(JSON.stringify({...m,runId,files:hashes,custodySha256:hashes["custody.json"]},null,2)+"\n");store.objects.set(to+"manifest.json",bytes);return {location,manifestSha256:digest(bytes)};
}
/** CLI 境界：環境変数を与えて workflowCli を呼び、標準出力・標準エラー・GITHUB_OUTPUT・summary を集める。 */
async function cli(f:Fixture,phase:string,env:Record<string,string>,services:ReleaseServices=f.services){
  const values:Record<string,string>={RUNNER_TEMP:f.runnerTemp,RELEASE_ROOT:f.context.root,RELEASE_COMMIT:artifact.commit,AWS_REGION:"us-east-1",RELEASE_APPLY:"false",RELEASE_PUBLISHED:"false",RELEASE_SCHEDULER_ENABLED:"false",RELEASE_INPUTS_JSON:JSON.stringify(f.config.inputs),RELEASE_BASELINE_JSON:JSON.stringify(f.config.baseline),STATE_BUCKET:f.config.stateBucket,GITHUB_OUTPUT:join(f.runnerTemp,"github-output"),GITHUB_STEP_SUMMARY:join(f.runnerTemp,"github-summary"),GITHUB_RUN_ID:f.context.runId,GITHUB_RUN_ATTEMPT:"1",CUSTODY_BUCKET:"synthetic-custody",GITHUB_JOB:"",REVIEWED_RUN:"",REVIEWED_ATTEMPT:"",EXPECTED_REVIEW_SHA256:"",SOURCE_RUN_ID:"",SOURCE_ATTEMPT:"",SOURCE_MANIFEST_SHA256:"",PLAN_CUSTODY_RUN_ID:"",PLAN_CUSTODY_ATTEMPT:"",PLAN_CUSTODY_MANIFEST_SHA256:"",EXPECTED_CUSTODY_SHA256:"",...env};
  const previous=Object.fromEntries(Object.keys(values).map(k=>[k,process.env[k]]));let stdout="",stderr="";
  await rm(values.GITHUB_OUTPUT!,{force:true});await rm(values.GITHUB_STEP_SUMMARY!,{force:true});
  Object.assign(process.env,values);
  try{
    const code=await f.d.workflowCli([phase],{custodyStore:f.store,now:f.context.now,services,io:{stdout:s=>{stdout+=s;},stderr:s=>{stderr+=s;}}});
    const read=async(p:string)=>readFile(p,"utf8").catch(()=>"");
    return {code,stdout,stderr,output:await read(values.GITHUB_OUTPUT!),summary:await read(values.GITHUB_STEP_SUMMARY!)};
  }finally{for(const [k,v] of Object.entries(previous)){if(v===undefined)delete process.env[k];else process.env[k]=v;}}
}
function leaves(value:unknown):string[]{if(typeof value==="string")return [value];if(value&&typeof value==="object")return Object.values(value).flatMap(leaves);return [];}
const fixtureSecrets=(f:Fixture)=>[...leaves(f.config.inputs),...leaves(f.config.baseline),...leaves(platformOutputs),...leaves(outputs),"private stdout must not leak"].filter(v=>v.length>=8&&v!==artifact.commit&&v!=="application"&&v!=="platform");
type Preparation={prepare?:(f:Fixture)=>void;config?:(f:Fixture)=>WorkflowConfig;services?:(f:Fixture)=>ReleaseServices};
/**
 * 元の preview（first、作成は start）→ 同じ設定の apply の run の plan job（next、作成は start+1h）を作り、
 * apply job は新しい空のディレクトリで始まるので next の作業ディレクトリを消しておく。
 */
async function approved(root:"platform"|"application"="application",p:Preparation={}){
  const first=await fixture(root),next=await fixture(root,{store:first.store});for(const f of [first,next])p.prepare?.(f);
  const config=(f:Fixture)=>p.config?.(f)??f.config,services=(f:Fixture)=>p.services?.(f)??f.services;
  const preview=await first.d.planRelease(first.context,config(first),root==="application"?await first.src():undefined,services(first));
  next.setNow(at(H));const c={...next.context,apply:true};
  const applied=await next.d.planRelease(c,config(next),reviewRef(first,preview),services(next));
  await rm(next.directory,{recursive:true,force:true});
  const refs={original:reviewRef(first,preview),current:reviewRef(next,applied)};
  return {first,next,preview,applied,c,refs,services:services(next),fresh:async()=>{await rm(next.directory,{recursive:true,force:true});},cleanup:async()=>{await first.cleanup();await next.cleanup();}};
}
/** 同じ run ID の別の run_attempt に、manifest を patch して（各ファイルの hash は整合させたまま）置き直す。 */
function forgeAttempt(store:FakeStore,from:CustodyReference,runAttempt:number,patch:(m:CustodyManifest)=>CustodyManifest=m=>m):CustodyReference{
  const prefix=custodyPrefix(from.location),m=manifestAt(store,from),location={...from.location,runAttempt},to=custodyPrefix(location);
  for(const name of Object.keys(m.files))store.objects.set(to+name,Buffer.from(store.objects.get(prefix+name)!));
  const bytes=Buffer.from(JSON.stringify({...patch(m),runAttempt},null,2)+"\n");store.objects.set(to+"manifest.json",bytes);return {location,manifestSha256:digest(bytes)};
}
const ranApply=(f:Fixture)=>f.commands.some(c=>c[0]==="terraform"&&c[2]==="apply");
const terraformCount=(f:Fixture)=>f.commands.filter(c=>c[0]==="terraform").length;
/** apply phase の CLI の正しい入力（元の preview と、同じ run の plan job の output）。 */
const applyEnv=(a:Awaited<ReturnType<typeof approved>>)=>({RELEASE_APPLY:"true",REVIEWED_RUN:a.first.context.runId,REVIEWED_ATTEMPT:"1",EXPECTED_REVIEW_SHA256:a.preview.manifestSha256,PLAN_CUSTODY_RUN_ID:a.next.context.runId,PLAN_CUSTODY_ATTEMPT:"1",PLAN_CUSTODY_MANIFEST_SHA256:a.applied.manifestSha256});
const resultKeys=(f:Fixture)=>[...f.store.objects.keys()].filter(k=>k.startsWith(`release-result/${f.context.runId}/`)).sort();

void test("dispatch_accepts_public_or_private_main_dispatch",async()=>{
  const d=await driver();const good={event:"workflow_dispatch",ref:"refs/heads/main",commit:artifact.commit,head:artifact.commit,mainContainsCommit:true,apply:false,reviewedRun:"",expectedReviewSha256:"",root:"platform"};
  d.authorizeDispatch(good);d.authorizeDispatch({...good,privateRepository:false} as typeof good);for(const bad of [{event:"pull_request"},{ref:"refs/heads/topic"},{head:"b".repeat(40)},{mainContainsCommit:false},{commit:"main"},{apply:true},{apply:true,reviewedRun:"12",expectedReviewSha256:"bad"},{root:"bootstrap"}])assert.throws(()=>d.authorizeDispatch({...good,...bad}));
});
void test("reused_preview_requires_reviewed_digest",async()=>{
  const d=await driver();const good={event:"workflow_dispatch",ref:"refs/heads/main",commit:artifact.commit,head:artifact.commit,mainContainsCommit:true,apply:false,reviewedRun:"12",expectedReviewSha256:"a".repeat(64),root:"application"};
  d.authorizeDispatch(good);for(const bad of ["","bad"])assert.throws(()=>d.authorizeDispatch({...good,expectedReviewSha256:bad}));
});
void test("platform_reviewed_preview_is_rejected_before_s3_or_terraform",async()=>{
  // ZIP を再利用した新しい preview は application だけ。platform で reviewed_run があり apply=false の組み合わせは拒否する。
  const d=await driver();const good={event:"workflow_dispatch",ref:"refs/heads/main",commit:artifact.commit,head:artifact.commit,mainContainsCommit:true,apply:true,reviewedRun:"12",expectedReviewSha256:"a".repeat(64),root:"platform"};
  d.authorizeDispatch(good);assert.throws(()=>d.authorizeDispatch({...good,apply:false}),/application/);
  const first=await fixture("platform"),next=await fixture("platform",{store:first.store});try{
    const preview=await first.d.planRelease(first.context,first.config,undefined,first.services);const gets=next.store.gets.length;
    await assert.rejects(next.d.planRelease(next.context,next.config,reviewRef(first,preview),next.services),/application/);
    const result=await cli(next,"plan",{REVIEWED_RUN:first.context.runId,EXPECTED_REVIEW_SHA256:preview.manifestSha256,SOURCE_RUN_ID:first.context.runId,SOURCE_ATTEMPT:"1",SOURCE_MANIFEST_SHA256:preview.manifestSha256});
    assert.equal(result.code,1);assert.equal(result.output,"");assert.equal(next.store.gets.length,gets);assert.equal(next.commands.some(c=>c[0]==="terraform"),false);
  }finally{await first.cleanup();await next.cleanup();}
});
void test("plan_rejects_source_manifest_differing_from_expected_review_before_s3",async()=>{
  const first=await fixture(),next=await fixture("application",{store:first.store});try{
    const preview=await first.d.planRelease(first.context,first.config,await first.src(),first.services);const ref=reviewRef(first,preview);
    const env={REVIEWED_RUN:first.context.runId,SOURCE_RUN_ID:first.context.runId,SOURCE_ATTEMPT:"1",SOURCE_MANIFEST_SHA256:preview.manifestSha256,RELEASE_SCHEDULER_ENABLED:"true"};
    for(const expected of ["a".repeat(64),"","bad"]){const gets=next.store.gets.length;const result=await cli(next,"plan",{...env,EXPECTED_REVIEW_SHA256:expected});
      assert.equal(result.code,1);assert.equal(result.output,"");assert.equal(next.store.gets.length,gets);assert.equal(next.commands.some(c=>c[0]==="terraform"),false);}
    const result=await cli(next,"plan",{...env,EXPECTED_REVIEW_SHA256:ref.manifestSha256});assert.equal(result.code,0,result.stderr);
    assert.equal(manifestAt(next.store,{location:{kind:"release-review",runId:next.context.runId,runAttempt:1},manifestSha256:""}).sourceManifestSha256,preview.manifestSha256);
  }finally{await first.cleanup();await next.cleanup();}
});
void test("application_plan_derives_json_from_saved_binary_and_transfers_only_allowed_outputs",async()=>{
  const f=await fixture();try{const r=await f.d.planRelease(f.context,f.config,await f.src(),f.services);assert.match(r.planReviewSha256,/^[0-9a-f]{64}$/);assert.equal(f.counts().headCount,1);assert.equal(planned(f),1);const input=JSON.parse(await readFile(join(f.directory,"inputs.json"),"utf8"));assert.equal(input.operator_api_seed,false);assert.equal(input.production_api_id,baseline.apiId);assert.equal(input.cognito_client_id,baseline.cognitoClientId);assert.equal(input.unused_secret,undefined);assert.equal(input.artifact.version_id,artifact.versionId);for(const p of [f.directory,join(f.directory,"inputs.json"),join(f.directory,"saved.tfplan"),join(f.directory,"review.json"),join(f.directory,"plan.txt")])assert.equal((await stat(p)).mode&0o777,p===f.directory?0o700:0o600);}finally{await f.cleanup();}
});
void test("preview_writes_release_review_with_plan_text_and_returns_manifest_digest",async()=>{
  const f=await fixture();try{
    const r=await f.d.planRelease(f.context,f.config,await f.src(),f.services);const ref=reviewRef(f,r),prefix=custodyPrefix(ref.location),bytes=f.store.objects.get(`${prefix}manifest.json`)!;
    assert.equal(prefix,`release-review/${f.context.runId}/1/`);assert.equal(f.store.order.at(-1),`${prefix}manifest.json`);
    assert.equal(r.manifestSha256,digest(bytes));assert.equal(r.manifestSha256Base64,b64(bytes));assert.notEqual(r.manifestSha256,r.planReviewSha256);
    const m=manifestAt(f.store,ref);assert.equal(m.kind,"release-review");assert.equal(m.root,"application");assert.equal(m.planReviewSha256,r.planReviewSha256);
    assert.equal(JSON.parse(await readFile(join(f.directory,"review.json"),"utf8")).reviewSha256,r.planReviewSha256);
    assert.equal(m.custodySha256,digest(await readFile(join(f.directory,"custody.json"))));assert.equal(m.sourceManifestSha256,undefined);
    assert.equal(m.createdAt,start.toISOString());assert.equal(m.expiresAt,at(24*H).toISOString());
    const text=await readFile(join(f.directory,"plan.txt"),"utf8");assert.equal(text,"synthetic human-readable plan\n");assert.equal(Buffer.from(f.store.objects.get(`${prefix}plan.txt`)!).toString(),text);
    assert.ok(f.commands.some(c=>c[2]==="show"&&c[3]==="-no-color"&&c[4]===join(f.directory,"saved.tfplan")));
    assert.ok(f.store.gets.includes(`registered-release/${f.context.runId}/1/manifest.json`));
  }finally{await f.cleanup();}
});
void test("release_review_contains_only_required_files_not_plan_json",async()=>{
  for(const root of ["application","platform"] as const){const f=await fixture(root);try{
    const r=await f.d.planRelease(f.context,f.config,root==="application"?await f.src():undefined,f.services);const ref=reviewRef(f,r),prefix=custodyPrefix(ref.location);
    assert.deepEqual(Object.keys(manifestAt(f.store,ref).files).sort(),[...requiredFiles("release-review",root)].sort());
    assert.ok((await readdir(f.directory)).includes("plan.json"));assert.equal([...f.store.objects.keys()].some(k=>k.startsWith(prefix)&&k.endsWith("plan.json")),false);
  }finally{await f.cleanup();}}
});
void test("apply_consumes_same_saved_binary_then_checks_aliases_smoke_and_safe_ledger",async()=>{
  const a=await approved();try{const f=a.next;const ledger=await f.d.applyRelease(a.c,a.refs,a.services);assert.deepEqual(f.counts(),{headCount:2,verifyCount:1,smokeCount:1});assert.equal(planned(f),1);const apply=f.commands.find(c=>c[2]==="apply")!;assert.ok(apply.includes(join(f.directory,"saved.tfplan")));assert.ok(apply.includes("-lock-timeout=5m"));assert.equal(ledger.commit,artifact.commit);assert.equal(ledger.result,"verified");assert.equal(ledger.reviewSha256,a.applied.planReviewSha256);assert.ok(!JSON.stringify(ledger).includes(baseline.cognitoIssuer));}finally{await a.cleanup();}
});
void test("apply_rejects_changed_binary_inputs_commit_baseline_artifact_and_forged_plan_json",async()=>{
  // S3 の object を書き換えると manifest の hash と合わずに止まる。
  for(const file of ["saved.tfplan","inputs.json","baseline.json","artifact.json"]){const a=await approved();try{a.next.store.objects.set(custodyPrefix(a.refs.current.location)+file,Buffer.from(file==="saved.tfplan"?"tampered":"{}"));await assert.rejects(a.next.d.applyRelease(a.c,a.refs,a.services),/SHA-256 changed/);assert.equal(ranApply(a.next),false);}finally{await a.cleanup();}}
  const a=await approved();try{const f=a.next;
    await assert.rejects(f.d.applyRelease({...a.c,commit:"b".repeat(40)},a.refs,a.services));assert.equal(ranApply(f),false);
    // 取り出し先に置いた plan.json は使わず、空でない取り出し先として拒否する。
    await mkdir(f.directory,{recursive:true});await writeFile(join(f.directory,"plan.json"),JSON.stringify({forged:true}));await assert.rejects(f.d.applyRelease(a.c,a.refs,a.services),/destination/);assert.equal(ranApply(f),false);
    await a.fresh();await f.d.applyRelease(a.c,a.refs,a.services);assert.equal(JSON.parse(await readFile(join(f.directory,"plan.json"),"utf8")).format_version,"1.2");
  }finally{await a.cleanup();}
});
void test("reviewed_hash_mismatch_and_head_failure_stop_before_apply",async()=>{
  for(const failHead of [false,true]){const a=await approved();try{const refs=failHead?a.refs:{...a.refs,original:{...a.refs.original,manifestSha256:"f".repeat(64)}};await assert.rejects(a.next.d.applyRelease(a.c,refs,{...a.services,head:async()=>{throw Error("server artifact mismatch");}}));assert.equal(ranApply(a.next),false);}finally{await a.cleanup();}}
});
void test("normal_application_rejects_seed_missing_baseline_and_artifact_evidence_changes",async()=>{
  for(const bad of ["seed","baseline","evidence","version","source"]){const f=await fixture();try{if(bad==="evidence")await writeFile(join(f.source,"tests.txt"),"tampered");if(bad==="version")await writeFile(join(f.source,"registered.json"),JSON.stringify({...f.registered,artifact:{...artifact,commit:"b".repeat(40)}}));await assert.rejects(f.d.planRelease(f.context,{...f.config,inputs:{...f.config.inputs,...(bad==="seed"?{operator_api_seed:true}:{})},baseline:bad==="baseline"?null:f.config.baseline},bad==="source"?undefined:await f.src(),f.services));assert.equal(planned(f),0);}finally{await f.cleanup();}}
});
void test("apply_run_requires_identical_preview_inputs_and_selected_version_without_registration",async()=>{
  const f=await fixture(),next=await fixture("application",{store:f.store});try{const r=await f.d.planRelease(f.context,f.config,await f.src(),f.services);await assert.rejects(next.d.planRelease({...next.context,apply:true},{...next.config,inputs:{...next.config.inputs,chrome_origin:"https://changed.example"}},reviewRef(f,r),next.services));assert.equal(planned(next),0);
    // apply の run は release-review を必須とし、registered-release や source 無しでは plan しない。
    for(const source of [undefined,await next.src()])await assert.rejects(next.d.planRelease({...next.context,apply:true},next.config,source,next.services));assert.equal(planned(next),0);
  }finally{await next.cleanup();await f.cleanup();}
});
void test("apply_run_compares_inner_plan_digest_and_inherits_expiry",async()=>{
  const first=await fixture(),next=await fixture("application",{store:first.store});try{
    const preview=await first.d.planRelease(first.context,first.config,await first.src(),first.services);next.setNow(at(H));
    const c={...next.context,apply:true};const applied=await next.d.planRelease(c,next.config,reviewRef(first,preview),next.services);
    assert.equal(applied.planReviewSha256,preview.planReviewSha256);assert.notEqual(applied.manifestSha256,preview.manifestSha256);
    const original=manifestAt(first.store,reviewRef(first,preview)),m=manifestAt(next.store,reviewRef(next,applied));
    assert.equal(m.expiresAt,original.expiresAt);assert.equal(m.createdAt,at(H).toISOString());assert.equal(m.sourceManifestSha256,undefined);assert.equal(m.planReviewSha256,original.planReviewSha256);
    assert.equal(JSON.parse(await readFile(join(next.directory,"preview.json"),"utf8")).preview,false);
    assert.equal(next.store.objects.has(`registered-release/${next.context.runId}/1/manifest.json`),false);assert.equal(next.commands.some(x=>/build|package|register/.test(x.join(" "))),false);
    await rm(next.directory,{recursive:true,force:true});await next.d.applyRelease(c,{original:reviewRef(first,preview),current:reviewRef(next,applied)},next.services);assert.equal(next.counts().headCount,2);
  }finally{await first.cleanup();await next.cleanup();}
});
void test("apply_run_rejects_reviewed_manifest_digest_mismatch",async()=>{
  const first=await fixture(),next=await fixture("application",{store:first.store});try{
    const preview=await first.d.planRelease(first.context,first.config,await first.src(),first.services);
    const wrong={...reviewRef(first,preview),manifestSha256:"f".repeat(64)};const reads=next.store.gets.length;
    await assert.rejects(next.d.planRelease({...next.context,apply:true},next.config,wrong,next.services),/manifest digest/);assert.equal(planned(next),0);
    assert.deepEqual(next.store.gets.slice(reads),[`release-review/${first.context.runId}/1/manifest.json`]);
    // manifest は一致しても、作り直した plan の digest が manifest の planReviewSha256 と違えば止まり、何も書かない。
    (next.plan as Record<string,unknown>).terraform_version="synthetic-changed";
    await assert.rejects(next.d.planRelease({...next.context,apply:true},next.config,reviewRef(first,preview),next.services),/differs from reviewed preview/);
    assert.equal([...next.store.objects.keys()].some(k=>k.startsWith(`release-review/${next.context.runId}/`)),false);
  }finally{await first.cleanup();await next.cleanup();}
});
void test("reused_preview_records_source_manifest_and_gets_new_expiry",async()=>{
  const first=await fixture(),next=await fixture("application",{store:first.store});try{
    const preview=await first.d.planRelease(first.context,first.config,await first.src(),first.services);next.setNow(at(2*H));
    const reused=await next.d.planRelease({...next.context,schedulerEnabled:true},next.config,reviewRef(first,preview),next.services);
    assert.notEqual(reused.planReviewSha256,preview.planReviewSha256);assert.equal(JSON.parse(await readFile(join(next.directory,"inputs.json"),"utf8")).scheduler_enabled,true);
    const m=manifestAt(next.store,reviewRef(next,reused));assert.equal(m.sourceManifestSha256,preview.manifestSha256);assert.equal(m.createdAt,at(2*H).toISOString());assert.equal(m.expiresAt,at(26*H).toISOString());
    assert.equal(next.counts().headCount,1);assert.equal(next.commands.some(x=>/build|package|register/.test(x.join(" "))),false);assert.equal(next.store.objects.has(`registered-release/${next.context.runId}/1/manifest.json`),false);
  }finally{await first.cleanup();await next.cleanup();}
});
void test("reused_preview_can_plan_and_apply_without_build_and_refuses_apply_run_as_preview",async()=>{
  const first=await fixture(),next=await fixture("application",{store:first.store}),third=await fixture("application",{store:first.store});try{
    const preview=await first.d.planRelease(first.context,first.config,await first.src(),first.services);const c={...next.context,apply:true};const applied=await next.d.planRelease(c,next.config,reviewRef(first,preview),next.services);assert.equal(applied.planReviewSha256,preview.planReviewSha256);await rm(next.directory,{recursive:true,force:true});await next.d.applyRelease(c,{original:reviewRef(first,preview),current:reviewRef(next,applied)},next.services);assert.equal(planned(next),1);assert.equal(next.commands.some(x=>/build|package|register/.test(x.join(" "))),false);
    for(const apply of [true,false])await assert.rejects(third.d.planRelease({...third.context,apply},third.config,reviewRef(next,applied),third.services),/Original preview/);assert.equal(planned(third),0);
  }finally{await first.cleanup();await next.cleanup();await third.cleanup();}
});
void test("expired_reviewed_bundle_is_rejected_for_apply_and_reuse",async()=>{
  const first=await fixture();const preview=await first.d.planRelease(first.context,first.config,await first.src(),first.services);
  try{for(const apply of [true,false]){const next=await fixture("application",{store:first.store});try{next.setNow(at(24*H));
    await assert.rejects(next.d.planRelease({...next.context,apply,schedulerEnabled:!apply},next.config,reviewRef(first,preview),next.services),/expired/);assert.equal(planned(next),0);
    next.setNow(at(24*H-1));await next.d.planRelease({...next.context,apply,schedulerEnabled:!apply},next.config,reviewRef(first,preview),next.services);
  }finally{await next.cleanup();}}}finally{await first.cleanup();}
});
void test("original_bundle_with_valid_manifest_but_bad_inner_custody_is_rejected",async()=>{
  const first=await fixture();const preview=await first.d.planRelease(first.context,first.config,await first.src(),first.services);const original=reviewRef(first,preview);
  try{
    // 対照：書き換えずに置き直した bundle は通る（拒否の理由が inner custody であることを示す）。
    const control=await fixture("application",{store:first.store});try{await control.d.planRelease({...control.context,apply:true},control.config,await forge(first.store,original,String(++runs),()=>{}),control.services);}finally{await control.cleanup();}
    const mutations:Array<(files:Map<string,Buffer>)=>void>=[
      files=>{const c=JSON.parse(files.get("custody.json")!.toString());c["inputs.json"]="0".repeat(64);files.set("custody.json",Buffer.from(JSON.stringify(c)));},
      files=>{const c=JSON.parse(files.get("custody.json")!.toString());delete c["platform-outputs.json"];files.set("custody.json",Buffer.from(JSON.stringify(c)));},
    ];
    for(const mutate of mutations)for(const apply of [true,false]){const next=await fixture("application",{store:first.store});try{
      const forged=await forge(first.store,original,String(++runs),mutate);
      await assert.rejects(next.d.planRelease({...next.context,apply,schedulerEnabled:!apply},next.config,forged,next.services),/custody|Private release bytes/);assert.equal(planned(next),0);
    }finally{await next.cleanup();}}
  }finally{await first.cleanup();}
});
void test("original_bundle_with_saved_plan_not_matching_review_is_rejected",async()=>{
  const first=await fixture();const preview=await first.d.planRelease(first.context,first.config,await first.src(),first.services);const original=reviewRef(first,preview);
  try{
    const savedJson=JSON.parse(shownPlans.get(await readFile(join(first.directory,"saved.tfplan"),"utf8"))!) as Record<string,unknown>;
    shownPlans.set("forged saved binary",JSON.stringify({...savedJson,terraform_version:"synthetic-forged"}));
    for(const apply of [true,false]){const next=await fixture("application",{store:first.store});try{
      const forged=await forge(first.store,original,String(++runs),files=>{files.set("saved.tfplan",Buffer.from("forged saved binary"));const c=JSON.parse(files.get("custody.json")!.toString());c["saved.tfplan"]=digest("forged saved binary");files.set("custody.json",Buffer.from(JSON.stringify(c)));});
      await assert.rejects(next.d.planRelease({...next.context,apply,schedulerEnabled:!apply},next.config,forged,next.services),/Saved release review mismatch/);assert.equal(planned(next),0);
    }finally{await next.cleanup();}}
  }finally{await first.cleanup();}
});
void test("plan_rejects_missing_or_malformed_source_outputs_before_s3_or_terraform",async()=>{
  const f=await fixture();try{
    const ref=await f.src(),good={SOURCE_RUN_ID:ref.location.runId,SOURCE_ATTEMPT:"1",SOURCE_MANIFEST_SHA256:ref.manifestSha256};
    const bad:Array<Record<string,string>>=[{SOURCE_RUN_ID:"",SOURCE_ATTEMPT:"",SOURCE_MANIFEST_SHA256:""},{SOURCE_RUN_ID:""},{SOURCE_ATTEMPT:""},{SOURCE_MANIFEST_SHA256:""},{SOURCE_RUN_ID:"run-1"},{SOURCE_RUN_ID:"0"},{SOURCE_RUN_ID:String(Number(ref.location.runId)+1)},{SOURCE_ATTEMPT:"0"},{SOURCE_ATTEMPT:"1.5"},{SOURCE_ATTEMPT:"-1"},{SOURCE_ATTEMPT:"01"},{SOURCE_MANIFEST_SHA256:"bad"},{SOURCE_MANIFEST_SHA256:ref.manifestSha256.toUpperCase()}];
    for(const reviewed of [false,true])for(const env of bad){
      const gets=f.store.gets.length;const result=await cli(f,"plan",{...good,...(reviewed?{REVIEWED_RUN:"12",EXPECTED_REVIEW_SHA256:ref.manifestSha256,SOURCE_RUN_ID:"12"}:{}),...env});
      assert.equal(result.code,1,JSON.stringify(env));assert.equal(f.store.gets.length,gets);assert.equal(f.commands.some(c=>c[0]==="terraform"),false);assert.equal(result.output,"");
    }
    // register が attempt 1、plan が attempt 2（一部の job の再実行）。自分の attempt では読まない。
    const result=await cli(f,"plan",{...good,GITHUB_RUN_ATTEMPT:"2"});assert.equal(result.code,0,result.stderr);
    assert.ok(f.store.gets.includes(`registered-release/${f.context.runId}/1/manifest.json`));assert.equal(f.store.gets.some(k=>k.startsWith(`registered-release/${f.context.runId}/2/`)),false);
    assert.match(result.output,new RegExp(`^custody_run_id=${f.context.runId}$`,"m"));assert.match(result.output,/^custody_attempt=2$/m);assert.ok(f.store.objects.has(`release-review/${f.context.runId}/2/manifest.json`));
  }finally{await f.cleanup();}
});
void test("new_platform_preview_runs_without_source_at_cli_boundary",async()=>{
  const f=await fixture("platform");try{
    for(const env of [{SOURCE_RUN_ID:f.context.runId},{SOURCE_ATTEMPT:"1"},{SOURCE_MANIFEST_SHA256:"a".repeat(64)}]){const result=await cli(f,"plan",env);assert.equal(result.code,1);assert.equal(f.store.gets.length,0);assert.equal(f.commands.some(c=>c[0]==="terraform"),false);}
    const result=await cli(f,"plan",{});assert.equal(result.code,0,result.stderr);assert.equal(f.store.gets.length,0);
    const sha=/^custody_manifest_sha256=([0-9a-f]{64})$/m.exec(result.output)![1]!;const m=manifestAt(f.store,{location:{kind:"release-review",runId:f.context.runId,runAttempt:1},manifestSha256:sha});
    assert.equal(m.root,"platform");assert.equal(digest(f.store.objects.get(`release-review/${f.context.runId}/1/manifest.json`)!),sha);
  }finally{await f.cleanup();}
});
void test("register_custody_outputs_location_and_manifest_digest",async()=>{
  const f=await fixture();try{
    const result=await cli(f,"register-custody",{GITHUB_RUN_ATTEMPT:"3"});assert.equal(result.code,0,result.stderr);assert.equal(result.stdout,"");
    const key=`registered-release/${f.context.runId}/3/manifest.json`,bytes=f.store.objects.get(key)!;assert.equal(f.store.order.at(-1),key);
    assert.equal(result.output,`custody_run_id=${f.context.runId}\ncustody_attempt=3\ncustody_manifest_sha256=${digest(bytes)}\n`);
    const m=JSON.parse(Buffer.from(bytes).toString()) as CustodyManifest;assert.equal(m.kind,"registered-release");assert.equal(m.root,"application");assert.deepEqual(Object.keys(m.files).sort(),[...requiredFiles("registered-release","application")].sort());
    // 登録した run の plan job がそのまま読める。
    const planResult=await cli(f,"plan",{SOURCE_RUN_ID:f.context.runId,SOURCE_ATTEMPT:"3",SOURCE_MANIFEST_SHA256:digest(bytes)});assert.equal(planResult.code,0,planResult.stderr);
  }finally{await f.cleanup();}
  const p=await fixture("platform");try{await mkdir(join(p.runnerTemp,"registered"),{recursive:true});const result=await cli(p,"register-custody",{});assert.equal(result.code,1);assert.equal(p.store.order.length,0);}finally{await p.cleanup();}
});
void test("plan_summary_lists_only_allowed_fields",async()=>{
  const f=await fixture();try{
    const ref=await f.src();const result=await cli(f,"plan",{SOURCE_RUN_ID:ref.location.runId,SOURCE_ATTEMPT:"1",SOURCE_MANIFEST_SHA256:ref.manifestSha256});assert.equal(result.code,0,result.stderr);
    const sha=/^custody_manifest_sha256=([0-9a-f]{64})$/m.exec(result.output)![1]!;assert.match(result.output,new RegExp(`^review_sha256=${sha}$`,"m"));
    const bytes=f.store.objects.get(`release-review/${f.context.runId}/1/manifest.json`)!;assert.equal(digest(bytes),sha);
    for(const expected of ["application",artifact.commit,sha,b64(bytes),`run ${f.context.runId}`,"run_attempt 1"])assert.ok(result.summary.includes(expected),expected);
    assert.match(result.summary,/Action counts: \{.*\}/);assert.doesNotMatch(result.summary,/download|artifact|https?:|arn:/i);
    for(const secret of fixtureSecrets(f))assert.equal(result.summary.includes(secret),false,secret);
    const planReview=JSON.parse(await readFile(join(f.directory,"review.json"),"utf8")).reviewSha256 as string;assert.equal(result.summary.includes(planReview),false);
    assert.equal(result.stdout,"");assert.equal(result.stderr,"");
  }finally{await f.cleanup();}
});
void test("plan_failure_leaks_no_fixture_values_at_cli_boundary",async()=>{
  const f=await fixture();try{
    const ref=await f.src(),secrets=fixtureSecrets(f);const failing:ReleaseServices={...f.services,run:async(c,a)=>{if(a[1]==="plan")throw Error(`terraform failed for ${secrets.join(" ")}`);return f.services.run(c,a);}};
    const result=await cli(f,"plan",{SOURCE_RUN_ID:ref.location.runId,SOURCE_ATTEMPT:"1",SOURCE_MANIFEST_SHA256:ref.manifestSha256},failing);
    assert.equal(result.code,1);assert.equal(result.stdout,"");assert.ok(result.stderr.length>0);
    for(const text of [result.stdout,result.stderr,result.summary,result.output])for(const secret of secrets)assert.equal(text.includes(secret),false,secret);
    assert.equal([...f.store.objects.keys()].some(k=>k.startsWith("release-review/")),false);
  }finally{await f.cleanup();}
});
/** 初回の platform の構築：すべての resource を create にし、output を未知にする。 */
function initialPlatformPlan(f:Fixture):void{for(const r of f.plan.resource_changes){r.change.actions=["create"];r.change.before=null as unknown as Record<string,unknown>;r.change.after_unknown={id:true};}for(const o of Object.values(f.plan.output_changes))o.after_unknown=true;}
const initialState={values:{root_module:{resources:[{type:"aws_cognito_user_pool",name:"production",values:{id:"us-east-1_Synthetic"}},{type:"aws_cognito_user_pool_client",name:"chrome",values:{id:baseline.cognitoClientId,user_pool_id:"us-east-1_Synthetic"}},{type:"aws_cognito_user_pool_domain",name:"production",values:{domain:"synthetic",user_pool_id:"us-east-1_Synthetic"}}]}}};
const withState=(f:Fixture,state:unknown):ReleaseServices=>({...f.services,run:async(c:string,a:string[])=>a[1]==="show"&&a.length===3?JSON.stringify(state):f.services.run(c,a)});
const initialPlatform:Preparation={prepare:initialPlatformPlan,config:f=>({...f.config,baseline:null})};
void test("platform_needs_no_zip_and_checks_known_identity_after_initial_creation",async()=>{
  const a=await approved("platform",initialPlatform);try{const f=a.next;assert.equal(f.counts().headCount,0);
    await f.d.applyRelease(a.c,a.refs,withState(f,initialState));assert.equal(f.counts().verifyCount,0);const known=JSON.parse(await readFile(join(f.directory,"post-baseline.json"),"utf8"));assert.equal(known.root,"platform");assert.equal(known.cognitoClientId,baseline.cognitoClientId);
  }finally{await a.cleanup();}
});
void test("post_apply_identity_alias_or_smoke_failure_never_produces_success_ledger",async()=>{
  for(const failure of ["identity","alias","smoke"]){const a=await approved();try{const f=a.next;const services={...a.services,...(failure==="identity"?{run:async(c:string,x:string[])=>x[1]==="output"?JSON.stringify({...outputs,api_id:{value:"wrong"}}):a.services.run(c,x)}:failure==="alias"?{verify:async()=>{throw Error("alias mismatch");}}:{smoke:async()=>{throw Error("unavailable");}})};await assert.rejects(f.d.applyRelease(a.c,a.refs,services));await assert.rejects(readFile(join(f.directory,"ledger.json")));assert.deepEqual(resultKeys(f),[]);}finally{await a.cleanup();}}
});

void test("reviewed_run_metadata_accepts_public_repository",async()=>{
  const d=await driver();const verify=d.verifyReviewedRunMetadata;
  const good={event:"workflow_dispatch",head_branch:"main",path:".github/workflows/deploy.yml",conclusion:"success",status:"completed",head_repository:{full_name:"synthetic/reminder",private:false}};verify(good,"synthetic/reminder");verify({...good,head_repository:{full_name:"synthetic/reminder",private:true}},"synthetic/reminder");
  for(const bad of [{event:"push"},{head_branch:"feature"},{path:".github/workflows/ci.yml"},{conclusion:"failure"},{status:"in_progress"},{head_repository:{full_name:"foreign/reminder",private:false}}])assert.throws(()=>verify({...good,...bad},"synthetic/reminder"));
});
void test("reviewed_plan_attempt_uses_successful_plan_job_attempt",async()=>{
  const d=await driver();const job=(name:string,conclusion:string,run_attempt:number)=>({name,conclusion,run_attempt});
  assert.equal(d.selectReviewedPlanAttempt({jobs:[job("plan","failure",1),job("plan","success",2)]}),2);
  assert.equal(d.selectReviewedPlanAttempt({jobs:[job("plan","success",1),job("plan","success",2),job("register","success",3)]}),2);
  assert.throws(()=>d.selectReviewedPlanAttempt({jobs:[job("plan","failure",1),job("register","success",2)]}));
  assert.throws(()=>d.selectReviewedPlanAttempt({jobs:[]}));assert.throws(()=>d.selectReviewedPlanAttempt({}));assert.throws(()=>d.selectReviewedPlanAttempt({jobs:[{name:"plan",conclusion:"success",run_attempt:0}]}));
});
void test("reviewed_plan_attempt_reads_every_jobs_page",async()=>{
  const d=await driver();const job=(name:string,conclusion:string,run_attempt:number)=>({name,conclusion,run_attempt});
  const filler=(n:number,attempt:number)=>Array.from({length:n},(_,i)=>job(["authorize","register","apply"][i%3]!,"success",attempt));
  /** jobs API の応答を per_page 件ずつ返す合成のページ。呼ばれたページ番号を記録する。 */
  const pages=(all:unknown[],perPage=100)=>{const calls:number[]=[];return {calls,get:async(page:number)=>{calls.push(page);return {total_count:all.length,jobs:all.slice((page-1)*perPage,page*perPage)};}};};
  // 成功した plan が2ページ目にだけある。
  const second=pages([...filler(100,1),job("plan","success",2)]);
  assert.equal(d.selectReviewedPlanAttempt(await d.collectReviewedRunJobs(second.get)),2);assert.deepEqual(second.calls,[1,2]);
  // ページをまたいで成功した試行が複数あれば、最大の試行を選ぶ。
  const across=pages([job("plan","success",1),...filler(99,1),...filler(50,2),job("plan","success",3),job("plan","failure",4)]);
  assert.equal(d.selectReviewedPlanAttempt(await d.collectReviewedRunJobs(across.get)),3);assert.deepEqual(across.calls,[1,2]);
  // 1ページで足りれば次を読まない。
  const one=pages([job("plan","success",1)]);await d.collectReviewedRunJobs(one.get);assert.deepEqual(one.calls,[1]);
  // 件数の上限（10ページ）を超える run、途中で空のページ、壊れた応答は拒否する。
  await assert.rejects(d.collectReviewedRunJobs(pages(filler(1001,1)).get),/too many jobs/);
  await assert.rejects(d.collectReviewedRunJobs(async(page:number)=>({total_count:150,jobs:page===1?filler(100,1):[]})),/incomplete/);
  await assert.rejects(d.collectReviewedRunJobs(async()=>({jobs:[]})));
});
void test("changed_transfer_digest_derived_show_and_initial_platform_output_mismatch_stop_success",async()=>{
  const a=await approved();try{const f=a.next;
    await assert.rejects(f.d.applyRelease(a.c,{...a.refs,current:{...a.refs.current,manifestSha256:"f".repeat(64)}},a.services),/manifest digest/);assert.equal(ranApply(f),false);
    const changed=applicationPlan();changed.output_changes.api_id.after="bad";await a.fresh();await assert.rejects(f.d.applyRelease(a.c,a.refs,{...a.services,run:async(c,x)=>x[1]==="show"?JSON.stringify(changed):a.services.run(c,x)}));assert.equal(ranApply(f),false);
  }finally{await a.cleanup();}
  const p=await approved("platform",initialPlatform);try{await assert.rejects(p.next.d.applyRelease(p.c,p.refs,withState(p.next,{values:{root_module:{resources:[]}}})));await assert.rejects(readFile(join(p.next.directory,"ledger.json")));assert.deepEqual(resultKeys(p.next),[]);}finally{await p.cleanup();}
});

void test("apply_requires_the_external_plan_job_custody_digest",async()=>{
  const a=await approved();try{const f=a.next,gets=f.store.gets.length;
    // 同じ run の plan job 以外の場所、release-review 以外の種類、apply=false は S3 を読む前に止まる。
    for(const refs of [{...a.refs,current:{...a.refs.current,location:{...a.refs.current.location,runId:a.first.context.runId}}},{...a.refs,current:{...a.refs.current,location:{...a.refs.current.location,kind:"registered-release" as const}}},{...a.refs,original:{...a.refs.original,location:{...a.refs.original.location,kind:"registered-release" as const}}},{...a.refs,current:{...a.refs.current,manifestSha256:"bad"}}])await assert.rejects(f.d.applyRelease(a.c,refs,a.services));
    await assert.rejects(f.d.applyRelease({...a.c,apply:false},a.refs,a.services));
    assert.equal(f.store.gets.length,gets);assert.equal(ranApply(f),false);
  }finally{await a.cleanup();}
});

void test("restored platform handoff survives complete preview/apply custody and rejects ARN disagreement",async()=>{
  const selected={reminders:"recovered-reminders",owner_state:"recovered-owners",image_jobs:"recovered-jobs"};
  const data={reminders_table:selected.reminders,owner_state_table:selected.owner_state,image_jobs_table:selected.image_jobs,images_bucket:"synthetic-123456789012-us-east-1-images",restored_tables:selected};
  const platformFor=(badArn:boolean)=>{const platform={...platformOutputs,restored_tables:{value:selected}};for(const [key,name] of Object.entries(selected))Object.assign(platform,{[`${key}_table`]:{value:name},[`${key}_table_arn`]:{value:`arn:aws:dynamodb:us-east-1:${badArn?"999999999999":"123456789012"}:table/${name}`}});return platform;};
  const prepare=(f:Fixture)=>{
    Object.assign(f.plan.variables,Object.fromEntries(Object.entries(data).map(([key,value])=>[key,{value}])));
    Object.assign(f.plan.output_changes,{runtime_data:{after:data,after_unknown:false,actions:["no-op"]}});
    for(const fn of f.plan.resource_changes.filter(r=>r.type==="aws_lambda_function"))Object.assign((fn.change.after.environment as Array<{variables:Record<string,string>}>)[0]!.variables,{REMINDERS_TABLE:selected.reminders,OWNER_STATE_TABLE:selected.owner_state,IMAGE_JOBS_TABLE:selected.image_jobs});
  };
  const appliedOutputs={...outputs,runtime_data:{value:data}};
  const servicesFor=(badArn:boolean)=>(f:Fixture):ReleaseServices=>({...f.services,run:async(c:string,a:string[])=>a[1]==="output"?JSON.stringify(a[0]?.includes("platform")?platformFor(badArn):appliedOutputs):f.services.run(c,a),verify:async(a:unknown,o:unknown)=>{assert.deepEqual(a,artifact);assert.deepEqual(o,appliedOutputs);}});
  const f=await fixture();try{prepare(f);await assert.rejects(f.d.planRelease(f.context,f.config,await f.src(),servicesFor(true)(f)));assert.equal(planned(f),0);}finally{await f.cleanup();}
  const a=await approved("application",{prepare,services:servicesFor(false)});try{
    const input=JSON.parse(await readFile(join(a.first.directory,"inputs.json"),"utf8"));assert.deepEqual(input.restored_tables,selected);assert.equal(input.owner_state_table,"recovered-owners");
    const handoff=JSON.parse(await readFile(join(a.first.directory,"platform-outputs.json"),"utf8"));assert.deepEqual(handoff.restored_tables,selected);
    const result=await a.next.d.applyRelease(a.c,a.refs,a.services);assert.equal(result.result,"verified");
  }finally{await a.cleanup();}
});

void test("apply_reads_plan_job_location_and_rejects_missing_outputs",async()=>{
  const a=await approved();try{const f=a.next,good=applyEnv(a);
    const bad:Array<Record<string,string>>=[
      {PLAN_CUSTODY_RUN_ID:"",PLAN_CUSTODY_ATTEMPT:"",PLAN_CUSTODY_MANIFEST_SHA256:""},{PLAN_CUSTODY_RUN_ID:""},{PLAN_CUSTODY_ATTEMPT:""},{PLAN_CUSTODY_MANIFEST_SHA256:""},
      // 旧い EXPECTED_CUSTODY_SHA256 は plan job の output の代わりにならない。
      {PLAN_CUSTODY_MANIFEST_SHA256:"",EXPECTED_CUSTODY_SHA256:digest("custody")},
      {PLAN_CUSTODY_RUN_ID:"0"},{PLAN_CUSTODY_RUN_ID:"run-1"},{PLAN_CUSTODY_RUN_ID:a.first.context.runId},{PLAN_CUSTODY_ATTEMPT:"0"},{PLAN_CUSTODY_ATTEMPT:"01"},{PLAN_CUSTODY_ATTEMPT:"1.5"},{PLAN_CUSTODY_MANIFEST_SHA256:"bad"},{PLAN_CUSTODY_MANIFEST_SHA256:a.applied.manifestSha256.toUpperCase()},
      {REVIEWED_RUN:""},{REVIEWED_ATTEMPT:""},{EXPECTED_REVIEW_SHA256:""},{REVIEWED_RUN:"0"},{REVIEWED_ATTEMPT:"0"},{REVIEWED_ATTEMPT:"-1"},{EXPECTED_REVIEW_SHA256:"bad"},{EXPECTED_REVIEW_SHA256:a.preview.manifestSha256.toUpperCase()},
      {RELEASE_APPLY:"false"},
    ];
    for(const env of bad){const gets=f.store.gets.length,tf=terraformCount(f);const result=await cli(f,"apply",{...good,...env});
      assert.equal(result.code,1,JSON.stringify(env));assert.equal(f.store.gets.length,gets,JSON.stringify(env));assert.equal(terraformCount(f),tf);assert.deepEqual(resultKeys(f),[]);
      assert.equal(await stat(f.directory).then(()=>true,()=>false),false);}
    // plan job は attempt 1、apply job は attempt 2（一部の job の再実行）。読むのは plan job の attempt、書くのは自分の attempt。
    const before=f.store.gets.length;const result=await cli(f,"apply",{...good,GITHUB_RUN_ATTEMPT:"2"});const gets=f.store.gets.slice(before);assert.equal(result.code,0,result.stderr);
    assert.ok(gets.includes(`release-review/${f.context.runId}/1/manifest.json`));assert.ok(gets.includes(`release-review/${a.first.context.runId}/1/manifest.json`));
    assert.equal(gets.some(k=>k.startsWith(`release-review/${f.context.runId}/2/`)),false);
    // 元の preview は manifest だけを読み、ファイルは取り出さない。
    assert.deepEqual(gets.filter(k=>k.startsWith(`release-review/${a.first.context.runId}/`)),[`release-review/${a.first.context.runId}/1/manifest.json`]);
    assert.deepEqual(resultKeys(f),[`release-result/${f.context.runId}/2/ledger.json`,`release-result/${f.context.runId}/2/manifest.json`]);
  }finally{await a.cleanup();}
});
void test("apply_rechecks_expiry_immediately_before_terraform_apply",async()=>{
  const a=await approved();try{const f=a.next;
    // 取り出しの後、保存した plan を show した時点で時刻を進める。apply の直前の検査で止まること。
    const advance=(t:Date):ReleaseServices=>({...a.services,run:async(c,x)=>{if(x[1]==="show"&&x[2]==="-json"&&x[3])f.setNow(t);return a.services.run(c,x);}});
    await assert.rejects(f.d.applyRelease(a.c,a.refs,advance(at(24*H))),/expired/);assert.equal(ranApply(f),false);
    assert.ok(f.commands.some(c=>c[2]==="show"&&c[3]==="-json"));assert.deepEqual(resultKeys(f),[]);
    await a.fresh();f.setNow(at(H));await f.d.applyRelease(a.c,a.refs,advance(new Date(at(24*H).getTime()-1)));assert.equal(ranApply(f),true);
  }finally{await a.cleanup();}
});
void test("apply_accepts_three_distinct_digests",async()=>{
  const a=await approved();try{
    const values=[a.preview.manifestSha256,a.applied.manifestSha256,a.preview.planReviewSha256];assert.equal(new Set(values).size,3);
    assert.equal(a.applied.planReviewSha256,a.preview.planReviewSha256);
    const ledger=await a.next.d.applyRelease(a.c,a.refs,a.services);assert.equal(ledger.result,"verified");assert.equal(ledger.reviewSha256,a.preview.planReviewSha256);
  }finally{await a.cleanup();}
});
void test("apply_rejects_inherited_expiry_changed_or_reuse_bundle",async()=>{
  const a=await approved();try{const f=a.next,shift=(iso:string|undefined,ms:number)=>new Date(Date.parse(iso!)+ms).toISOString();let attempt=1;
    const patches:Array<[(m:CustodyManifest)=>CustodyManifest,RegExp]>=[
      [m=>({...m,expiresAt:shift(m.expiresAt,1000)}),/inherited/],[m=>({...m,expiresAt:shift(m.expiresAt,-1000)}),/inherited/],
      [m=>({...m,sourceManifestSha256:a.preview.manifestSha256}),/reused preview/],
    ];
    for(const [patch,message] of patches){const current=forgeAttempt(f.store,a.refs.current,++attempt,patch);await a.fresh();const tf=terraformCount(f);
      await assert.rejects(f.d.applyRelease(a.c,{...a.refs,current},a.services),message);assert.equal(ranApply(f),false);assert.equal(terraformCount(f),tf);}
    // 対照：同じ内容を別の attempt に置いただけなら通る（拒否の理由が patch であることを示す）。
    await a.fresh();await f.d.applyRelease(a.c,{...a.refs,current:forgeAttempt(f.store,a.refs.current,++attempt)},a.services);assert.equal(ranApply(f),true);
  }finally{await a.cleanup();}
});
void test("apply_rejects_plan_digest_differing_from_original_manifest",async()=>{
  const a=await approved();try{const f=a.next,tf=terraformCount(f);
    // 元の manifest の plan の digest だけが違う（manifest の SHA-256 は入力として正しく照合される）。
    const original=forgeAttempt(f.store,a.refs.original,2,m=>({...m,planReviewSha256:"0".repeat(64)}));
    await assert.rejects(f.d.applyRelease(a.c,{...a.refs,original},a.services),/differs from reviewed preview/);
    assert.equal(terraformCount(f),tf);assert.equal(ranApply(f),false);
    // 対照：同じ内容を別の attempt に置いただけの元の manifest なら通る。
    await a.fresh();await f.d.applyRelease(a.c,{...a.refs,original:forgeAttempt(f.store,a.refs.original,3)},a.services);assert.equal(ranApply(f),true);
  }finally{await a.cleanup();}
});
void test("apply_writes_ledger_and_initial_platform_baseline_to_release_result",async()=>{
  const cases:Array<[string,"platform"|"application",Preparation,(f:Fixture)=>ReleaseServices|undefined,string[]]>=[
    ["initial platform","platform",initialPlatform,f=>withState(f,initialState),["ledger.json","manifest.json","post-baseline.json"]],
    ["existing platform","platform",{},()=>undefined,["ledger.json","manifest.json"]],
    ["application","application",{},()=>undefined,["ledger.json","manifest.json"]],
  ];
  for(const [label,root,preparation,services,files] of cases){const a=await approved(root,preparation);try{const f=a.next;
    const ledger=await f.d.applyRelease(a.c,a.refs,services(f)??a.services);const prefix=`release-result/${f.context.runId}/1/`;
    assert.deepEqual(resultKeys(f),files.map(n=>prefix+n),label);
    const m=manifestAt(f.store,{location:{kind:"release-result",runId:f.context.runId,runAttempt:1},manifestSha256:""});
    assert.equal(m.kind,"release-result");assert.equal(m.root,root);assert.equal(m.expiresAt,undefined);assert.equal(m.createdAt,at(H).toISOString());
    assert.deepEqual(JSON.parse(Buffer.from(f.store.objects.get(prefix+"ledger.json")!).toString()),ledger);
    assert.equal(digest(f.store.objects.get(prefix+"ledger.json")!),m.files["ledger.json"]);
    if(files.includes("post-baseline.json"))assert.equal(JSON.parse(Buffer.from(f.store.objects.get(prefix+"post-baseline.json")!).toString()).root,"platform");
    // post-baseline.json は今のとおり作業ディレクトリには常に作る。
    assert.ok((await readdir(f.directory)).includes("post-baseline.json"));
  }finally{await a.cleanup();}}
});
void test("apply_never_writes_ledger_or_fixture_values_to_stdout_or_stderr",async()=>{
  const a=await approved();try{const f=a.next,env=applyEnv(a),secrets=fixtureSecrets(f);
    const check=(r:{stdout:string;stderr:string;summary:string;output:string})=>{for(const text of [r.stdout,r.stderr,r.summary])for(const value of [...secrets,"reviewSha256","api_base_url","apiVersion",a.preview.planReviewSha256])assert.equal(text.includes(value),false,value);
      for(const text of [r.stdout,r.stderr,r.summary])assert.doesNotMatch(text,/https?:|arn:|[{}]/);assert.equal(r.stdout,"");};
    const failures:ReleaseServices[]=[
      {...a.services,run:async(c,x)=>{if(x[1]==="apply")throw Error(`terraform apply failed for ${secrets.join(" ")}`);return a.services.run(c,x);}},
      {...a.services,verify:async()=>{throw Error(`verify failed for ${secrets.join(" ")}`);}},
    ];
    for(const services of failures){await a.fresh();const r=await cli(f,"apply",env,services);assert.equal(r.code,1);assert.ok(r.stderr.length>0);check(r);assert.equal(r.summary,"");assert.deepEqual(resultKeys(f),[]);}
    await a.fresh();const r=await cli(f,"apply",env);assert.equal(r.code,0,r.stderr);check(r);assert.equal(r.stderr,"");
    for(const expected of ["application",artifact.commit,"verified",`run ${f.context.runId}`,"run_attempt 1"])assert.ok(r.summary.includes(expected),expected);
    assert.equal(r.output,"");assert.equal(resultKeys(f).length,2);
  }finally{await a.cleanup();}
});
/** RUNNER_TEMP の下の診断ディレクトリに合成のファイルを置く。 */
async function diagnostics(f:Fixture,directory:"release-diagnostics"|"infra-diagnostics",files:Record<string,string>):Promise<void>{const dir=join(f.runnerTemp,directory);await mkdir(dir,{recursive:true,mode:0o700});for(const [name,text] of Object.entries(files))await writeFile(join(dir,name),text,{mode:0o600});}
const diagnosticKeys=(f:Fixture,prefix=`failure-diagnostics/${f.context.runId}/`)=>[...f.store.objects.keys()].filter(k=>k.startsWith(prefix)).sort();
void test("diagnostics_phase_uses_github_job_and_requires_it",async()=>{
  const f=await fixture();try{await diagnostics(f,"release-diagnostics",{"failure-1-a.json":'{"phase":"plan"}\n'});
    // release の設定（root、commit など）は要らない。job の名前は GITHUB_JOB から読み、無ければ止まる。
    const env={RELEASE_ROOT:"",RELEASE_COMMIT:"",RELEASE_APPLY:"",GITHUB_RUN_ATTEMPT:"2"};
    for(const job of ["","../plan","Plan"]){const r=await cli(f,"diagnostics",{...env,GITHUB_JOB:job});assert.equal(r.code,1,job);assert.equal(f.store.order.length,0);}
    const r=await cli(f,"diagnostics",{...env,GITHUB_JOB:"apply"});assert.equal(r.code,0,r.stderr);assert.equal(r.stdout,"");
    const prefix=`failure-diagnostics/${f.context.runId}/2/apply/`;assert.deepEqual(diagnosticKeys(f),[`${prefix}manifest.json`,`${prefix}release-failure-1-a.json`]);
    const m=JSON.parse(Buffer.from(f.store.objects.get(`${prefix}manifest.json`)!).toString()) as CustodyManifest;assert.equal(m.kind,"failure-diagnostics");assert.equal(m.root,null);assert.equal(m.expiresAt,undefined);assert.equal(m.runAttempt,2);
    assert.equal(Buffer.from(f.store.objects.get(`${prefix}release-failure-1-a.json`)!).toString(),'{"phase":"plan"}\n');
  }finally{await f.cleanup();}
});
void test("diagnostics_phase_writes_only_bounded_json_files",async()=>{
  // ファイルが無ければ何も書かずに成功する。
  const empty=await fixture();try{const r=await cli(empty,"diagnostics",{GITHUB_JOB:"plan"});assert.equal(r.code,0,r.stderr);assert.equal(empty.store.order.length,0);}finally{await empty.cleanup();}
  const f=await fixture();try{
    const release=Object.fromEntries(Array.from({length:6},(_,i)=>[`failure-${i}-r.json`,`{"n":${i}}`]));
    await diagnostics(f,"release-diagnostics",{...release,"notes.txt":"not json","same.json":'{"from":"release"}'});
    await diagnostics(f,"infra-diagnostics",{"same.json":'{"from":"infra"}',"failure-9-i.json":"{}","failure-8-i.json":"{}"});
    const r=await cli(f,"diagnostics",{GITHUB_JOB:"plan"});assert.equal(r.code,0,r.stderr);assert.equal(r.stdout,"");assert.match(r.stderr,/^Kept 8 of 10 diagnostic files\n$/);
    const prefix=`failure-diagnostics/${f.context.runId}/1/plan/`,m=JSON.parse(Buffer.from(f.store.objects.get(`${prefix}manifest.json`)!).toString()) as CustodyManifest;
    // release-diagnostics を先に、各ディレクトリの中では名前の新しい順（名前の降順）に8個。名前の衝突は接頭辞で防ぐ。
    assert.deepEqual(Object.keys(m.files).sort(),[...Object.keys(release).map(n=>`release-${n}`),"release-same.json","infra-same.json"].sort());
    assert.equal(Buffer.from(f.store.objects.get(`${prefix}release-same.json`)!).toString(),'{"from":"release"}');
    assert.equal(diagnosticKeys(f).some(k=>k.endsWith(".txt")),false);assert.equal(diagnosticKeys(f).length,9);
  }finally{await f.cleanup();}
  // symlink は読まずに止まり、何も書かない。
  const s=await fixture();try{await diagnostics(s,"infra-diagnostics",{"ok.json":"{}"});await symlink(join(s.runnerTemp,"github-output"),join(s.runnerTemp,"infra-diagnostics","link.json"));
    const r=await cli(s,"diagnostics",{GITHUB_JOB:"plan"});assert.equal(r.code,1);assert.equal(s.store.order.length,0);}finally{await s.cleanup();}
});
void test("workflow_cli_accepts_only_phases_deploy_uses",async()=>{
  // secure phase は GitHub の artifact を使っていたときの名残で、deploy.yml は使わない。受け付けず、何も作らない。
  const f=await fixture();try{
    for(const phase of ["secure","register","","plan "]){const r=await cli(f,phase,{});assert.equal(r.code,1,phase);assert.equal(r.stdout,"");assert.equal(f.store.order.length,0);}
    await assert.rejects(lstat(join(f.runnerTemp,"release")));
  }finally{await f.cleanup();}
});
void test("diagnostics_phase_keeps_the_newest_files_in_each_directory",async()=>{
  // runPrivateCommand の名前は failure-<epoch ms>-<uuid>.json なので、名前の順が時刻の順になる。8個を超えるときは新しいものを残す。
  const name=(ms:number,id:string)=>`failure-${1700000000000+ms}-${id.repeat(8)}-0000-4000-8000-000000000000.json`;
  const f=await fixture();try{
    const release=Array.from({length:9},(_,i)=>name(i*1000,String(i)));
    await diagnostics(f,"release-diagnostics",Object.fromEntries(release.map(n=>[n,"{}"])));
    const r=await cli(f,"diagnostics",{GITHUB_JOB:"apply"});assert.equal(r.code,0,r.stderr);assert.match(r.stderr,/^Kept 8 of 9 diagnostic files\n$/);
    const m=JSON.parse(Buffer.from(f.store.objects.get(`failure-diagnostics/${f.context.runId}/1/apply/manifest.json`)!).toString()) as CustodyManifest;
    assert.deepEqual(Object.keys(m.files).sort(),release.slice(1).map(n=>`release-${n}`).sort(),"the oldest release file is the one dropped");
  }finally{await f.cleanup();}
  const g=await fixture();try{
    const release=Array.from({length:6},(_,i)=>name(i*1000,"a")),infra=Array.from({length:4},(_,i)=>name(i*1000+500,"b"));
    await diagnostics(g,"release-diagnostics",Object.fromEntries(release.map(n=>[n,"{}"])));await diagnostics(g,"infra-diagnostics",Object.fromEntries(infra.map(n=>[n,"{}"])));
    const r=await cli(g,"diagnostics",{GITHUB_JOB:"plan"});assert.equal(r.code,0,r.stderr);assert.match(r.stderr,/^Kept 8 of 10 diagnostic files\n$/);
    const m=JSON.parse(Buffer.from(g.store.objects.get(`failure-diagnostics/${g.context.runId}/1/plan/manifest.json`)!).toString()) as CustodyManifest;
    assert.deepEqual(Object.keys(m.files).sort(),[...release.map(n=>`release-${n}`),...infra.slice(2).map(n=>`infra-${n}`)].sort(),"the newest infra files are kept");
  }finally{await g.cleanup();}
});
