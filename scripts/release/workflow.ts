import {isDeepStrictEqual} from "node:util";
import {requireRuntimeData, selectedRuntimeData, verifyRuntimeDataOutputs} from "./runtime-data";
import {runPrivateCommand,PrivateCommandError} from "./private-command";
import {tmpdir} from "node:os";
import {createHash} from "node:crypto";
import {chmod,copyFile,lstat,mkdir,readFile,readdir,writeFile} from "node:fs/promises";
import {join,resolve} from "node:path";
import {z} from "zod";
import {createRegistrationClient,readRegisteredArtifact,type RegisteredArtifact,type ReleaseManifest} from "./artifact";
import {createPlanManifest,verifySavedPlan,verifyPostApplyBaseline,validateRegisteredArtifact,type ReleaseBaseline,type ReleaseRoot,type PrivatePlanManifest} from "./plan-guard";
import {verifyMain} from "./verify-release";
import {smoke} from "./smoke";

export interface WorkflowContext {
  directory:string;root:ReleaseRoot;commit:string;region:string;apply:boolean;
  expectedReviewSha256:string;expectedCustodySha256?:string;published:boolean;schedulerEnabled:boolean;
}
export interface WorkflowConfig {inputs:unknown;baseline:ReleaseBaseline|null;stateBucket:string}
export type CommandRunner=(command:string,args:string[])=>Promise<string>;
export interface ReleaseServices {
  run:CommandRunner;
  head(artifact:RegisteredArtifact,region:string):Promise<void>;
  verify(artifact:RegisteredArtifact,outputs:unknown,region:string):Promise<void>;
  smoke(baseline:ReleaseBaseline,published:boolean):Promise<void>;
}
const sha=z.string().regex(/^[0-9a-f]{64}$/),commit=z.string().regex(/^[0-9a-f]{40}$/);
const jsonObject=z.record(z.string(),z.unknown());
const hash=(b:string|Uint8Array)=>createHash("sha256").update(b).digest("hex");
const rootPath=(root:ReleaseRoot)=>`infra/${root}/production`;
const path=(c:WorkflowContext,name:string)=>join(resolve(c.directory),name);
const parseJson=async(p:string):Promise<unknown>=>JSON.parse(await readFile(p,"utf8"));
async function privateFile(p:string,value:string|Uint8Array):Promise<void>{await writeFile(p,value,{mode:0o600});await chmod(p,0o600);}
async function privateJson(p:string,value:unknown):Promise<void>{await privateFile(p,JSON.stringify(value,null,2)+"\n");}
/** Artifact downloads lose permissions. Reject symlinks and restore private modes before reads. */
export async function secureDirectory(directory:string):Promise<void>{
  await mkdir(directory,{recursive:true,mode:0o700});const dir=await lstat(directory);if(!dir.isDirectory()||dir.isSymbolicLink())throw Error("Invalid private directory");await chmod(directory,0o700);
  for(const name of await readdir(directory)){const p=join(directory,name),s=await lstat(p);if(!s.isFile()||s.isSymbolicLink())throw Error("Only regular private release files are accepted");await chmod(p,0o600);}
}
export function authorizeDispatch(input:{privateRepository:boolean;event:string;ref:string;commit:string;head:string;mainContainsCommit:boolean;apply:boolean;reviewedRun:string;expectedReviewSha256:string;root:string}):void{
  commit.parse(input.commit);if(!input.privateRepository||input.event!=="workflow_dispatch"||input.ref!=="refs/heads/main"||input.head!==input.commit||!input.mainContainsCommit||!["platform","application"].includes(input.root))throw Error("Private main immutable-commit dispatch required");
  if(input.reviewedRun!==""&&!/^[1-9][0-9]*$/.test(input.reviewedRun))throw Error("Invalid reviewed run");
  if(input.apply&&(!input.reviewedRun||!sha.safeParse(input.expectedReviewSha256).success))throw Error("Apply requires a reviewed preview run and digest");
}
/** Cross-run artifact source must be this private repository's completed main manual workflow. */
export function verifyReviewedRunMetadata(input:unknown,repository:string):void{
  const run=jsonObject.parse(input),head=jsonObject.parse(run.head_repository);
  if(run.event!=="workflow_dispatch"||run.head_branch!=="main"||run.path!==".github/workflows/deploy.yml"||run.conclusion!=="success"||run.status!=="completed"||head.full_name!==repository||head.private!==true)throw Error("Reviewed run lacks private main dispatch provenance");
}
const request=(c:WorkflowContext)=>({root:c.root,commit:c.commit,region:c.region,published:c.published,schedulerEnabled:c.schedulerEnabled});
function equal(a:unknown,b:unknown):boolean{return JSON.stringify(a)===JSON.stringify(b);}
function checkedContext(c:WorkflowContext):void{
  commit.parse(c.commit);z.enum(["platform","application"]).parse(c.root);z.string().regex(/^[a-z]{2}-[a-z]+-[1-9][0-9]*$/).parse(c.region);
  if(c.apply)sha.parse(c.expectedReviewSha256);
}
async function checkedCommit(c:WorkflowContext,run:CommandRunner):Promise<void>{if((await run("git",["rev-parse","HEAD"])).trim()!==c.commit)throw Error("Checkout commit changed");}
function output(o:unknown,name:string):string {const values=jsonObject.parse(o),entry=jsonObject.parse(values[name]);return z.string().min(1).parse(entry.value);}
const handoffFields=["reminders_table","owner_state_table","image_jobs_table","images_bucket","api_role_arn","cleanup_role_arn","api_log_group","cleanup_log_group","gateway_log_group","cognito_issuer","cognito_client_id","cognito_auth_base_url"] as const;
async function readManifest(source:string,c:WorkflowContext):Promise<ReleaseManifest>{
  await secureDirectory(source);
  const text=z.string().min(1),tool=z.strictObject({node:z.literal("24.21.0"),npm:z.literal("11.11.1"),esbuild:z.literal("0.28.2")});
  const m=z.strictObject({commit,region:z.literal(c.region),zip:text,tools:tool,artifact:z.unknown(),evidence:z.strictObject({audit:text,sbom:text,tests:text})}).parse(await parseJson(join(source,"registered.json")));
  const a=validateRegisteredArtifact(m.artifact);if(m.commit!==c.commit||a.commit!==c.commit)throw Error("Selected artifact commit changed");
  for(const name of ["audit","sbom","tests"] as const){const bytes=await readFile(join(source,`${name}.${name==="tests"?"txt":"json"}`));if(m.evidence[name]!==`sha256:${hash(bytes)}`)throw Error("Registration evidence changed");}
  const audit=jsonObject.parse(await parseJson(join(source,"audit.json"))),counts=jsonObject.parse(jsonObject.parse(audit.metadata).vulnerabilities);
  if(counts.high!==0||counts.critical!==0)throw Error("Unresolved high or critical audit findings");
  if(jsonObject.parse(await parseJson(join(source,"sbom.json"))).bomFormat!=="CycloneDX")throw Error("Invalid SBOM evidence");
  return {...m,artifact:a};
}
async function copyEvidence(source:string,c:WorkflowContext):Promise<void>{for(const name of ["registered.json","audit.json","sbom.json","tests.txt"]){await copyFile(join(source,name),path(c,name));await chmod(path(c,name),0o600);}}
async function init(c:WorkflowContext,root:ReleaseRoot,run:CommandRunner):Promise<void>{await run("terraform",[`-chdir=${rootPath(root)}`,"init","-input=false","-lockfile=readonly",`-backend-config=${path(c,"backend.hcl")}`]);}
async function shownPlan(c:WorkflowContext,run:CommandRunner):Promise<unknown>{
  // JSON is never accepted from a caller: derive it from this exact binary in both phases.
  const text=await run("terraform",[`-chdir=${rootPath(c.root)}`,"show","-json",path(c,"saved.tfplan")]);const plan:unknown=JSON.parse(text);await privateFile(path(c,"plan.json"),text);return plan;
}
const custodyNames=["inputs.json","baseline.json","artifact.json","request.json","backend.hcl","review.json","saved.tfplan","preview.json"];
async function saveCustody(c:WorkflowContext):Promise<void>{const files:Record<string,string>={};for(const name of custodyNames)files[name]=hash(await readFile(path(c,name)));if(c.root==="application")for(const name of ["registered.json","audit.json","sbom.json","tests.txt","platform-outputs.json"])files[name]=hash(await readFile(path(c,name)));await privateJson(path(c,"custody.json"),files);}
async function checkCustody(c:WorkflowContext):Promise<void>{
  const bytes=await readFile(path(c,"custody.json"));if(c.expectedCustodySha256!==undefined&&hash(bytes)!==sha.parse(c.expectedCustodySha256))throw Error("Transferred custody digest changed");
  const files=jsonObject.parse(JSON.parse(bytes.toString()));const expected=c.root==="application"?[...custodyNames,"registered.json","audit.json","sbom.json","tests.txt","platform-outputs.json"]:custodyNames;
  if(!equal(Object.keys(files).sort(),[...expected].sort()))throw Error("Incomplete custody manifest");for(const name of expected)if(files[name]!==hash(await readFile(path(c,name))))throw Error("Private release bytes changed");
}
/** Finite production plan phase. No build, registration, state dump or caller-supplied plan JSON. */
export async function planRelease(c:WorkflowContext,config:WorkflowConfig,source:string|undefined,services:ReleaseServices):Promise<string>{
  checkedContext(c);await checkedCommit(c,services.run);await secureDirectory(c.directory);
  const inputs=jsonObject.parse(config.inputs);if(inputs.region!==c.region||!/^[0-9]{12}$/.test(String(inputs.account_id))||!/^([a-z][a-z0-9-]{1,24}[a-z0-9])$/.test(String(inputs.name_prefix)))throw Error("Explicit account, region and prefix required");
  if(config.stateBucket!==`${inputs.name_prefix}-${inputs.account_id}-${c.region}-state`)throw Error("State bucket identity mismatch");
  if(c.root==="application"&&(config.baseline===null||config.baseline.root!=="application"||!config.baseline.apiId||inputs.production_api_id!==config.baseline.apiId||inputs.operator_api_seed===true))throw Error("Normal application needs known seeded API baseline and seed=false");
  if(c.root==="platform"&&c.schedulerEnabled)throw Error("Scheduler belongs to application");
  let registered:ReleaseManifest|undefined;
  if(c.root==="application"){if(!source)throw Error("Registered artifact evidence required");registered=await readManifest(source,c);await services.head(registered.artifact,c.region);await copyEvidence(source,c);}
  await privateFile(path(c,"backend.hcl"),`bucket = ${JSON.stringify(config.stateBucket)}\nregion = ${JSON.stringify(c.region)}\nallowed_account_ids = [${JSON.stringify(inputs.account_id)}]\n`);
  if(c.root==="application"){
    await init(c,"platform",services.run);const values=JSON.parse(await services.run("terraform",[`-chdir=${rootPath("platform")}`,"output","-json"]));const selected=Object.fromEntries(handoffFields.map(name=>[name,output(values,name)]));
    for(const [name,value] of Object.entries(selected)){if(inputs[name]!==undefined&&inputs[name]!==value)throw Error("Platform input handoff changed");inputs[name]=value;}
    const restored=jsonObject.parse(jsonObject.parse(values).restored_tables).value;
    if(inputs.restored_tables!==undefined&&!isDeepStrictEqual(inputs.restored_tables,restored))throw Error("Platform restored selection changed");
    inputs.restored_tables=restored;
    const data=requireRuntimeData(inputs);
    for(const name of ["reminders","owner_state","image_jobs"] as const)if(output(values,`${name}_table_arn`)!==`arn:aws:dynamodb:${c.region}:${inputs.account_id}:table/${data[`${name}_table`]}`)throw Error("Platform table ARN mismatch");
    await privateJson(path(c,"platform-outputs.json"),{...selected,restored_tables:restored});
    for(const [name,value] of Object.entries({cognito_issuer:config.baseline!.cognitoIssuer,cognito_client_id:config.baseline!.cognitoClientId,cognito_auth_base_url:config.baseline!.cognitoAuthBaseUrl}))if(inputs[name]!==value)throw Error("Platform baseline changed");
    inputs.operator_api_seed=false;inputs.scheduler_enabled=c.schedulerEnabled;const a=registered!.artifact;inputs.artifact={bucket:a.bucket,key:a.key,version_id:a.versionId,sha256_base64:a.sha256Base64};
  }
  await privateJson(path(c,"inputs.json"),inputs);await privateJson(path(c,"baseline.json"),config.baseline);await privateJson(path(c,"artifact.json"),registered?.artifact??null);await privateJson(path(c,"request.json"),request(c));await privateJson(path(c,"preview.json"),{preview:!c.apply});
  // Reused previews pin root/commit/artifact; apply runs also pin every reviewed input and expectation.
  if(source&&await exists(join(source,"review.json"))){await secureDirectory(source);const previous=jsonObject.parse(await parseJson(join(source,"review.json")));if(jsonObject.parse(await parseJson(join(source,"preview.json"))).preview!==true||previous.root!==c.root||previous.commit!==c.commit||!equal(await parseJson(join(source,"artifact.json")),registered?.artifact??null))throw Error("Original preview and selected artifact required");if(c.apply&&(previous.inputSha256!==hash(await readFile(path(c,"inputs.json")))||!equal(await parseJson(join(source,"baseline.json")),config.baseline)||!equal(await parseJson(join(source,"request.json")),request(c))))throw Error("Preview inputs or selected artifact changed");}
  else if(c.apply)throw Error("Apply run requires original preview custody");
  await init(c,c.root,services.run);await services.run("terraform",[`-chdir=${rootPath(c.root)}`,"plan","-input=false","-lock=true","-lock-timeout=5m",`-var-file=${path(c,"inputs.json")}`,`-out=${path(c,"saved.tfplan")}`]);await chmod(path(c,"saved.tfplan"),0o600);
  const plan=await shownPlan(c,services.run),manifest=createPlanManifest(plan,await readFile(path(c,"saved.tfplan")),await readFile(path(c,"inputs.json")),registered?.artifact??null,c.commit,config.baseline,c.root);
  if(c.apply&&manifest.reviewSha256!==c.expectedReviewSha256)throw Error("New plan differs from reviewed preview");
  await writeFile(path(c,"review.json"),JSON.stringify(manifest,null,2)+"\n",{flag:"wx",mode:0o600});await saveCustody(c);
  return manifest.reviewSha256;
}
async function exists(p:string):Promise<boolean>{try{await lstat(p);return true;}catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")return false;throw e;}}
function initialPlatformBaseline(outputs:unknown,state:unknown,inputs:Record<string,unknown>):ReleaseBaseline{
  const resources=z.array(z.looseObject({type:z.string(),name:z.string(),values:jsonObject})).parse(jsonObject.parse(jsonObject.parse(jsonObject.parse(state).values).root_module).resources);
  const pick=(type:string,name:string)=>{const matches=resources.filter(r=>r.type===type&&r.name===name);if(matches.length!==1)throw Error("Unknown initial platform identity");return matches[0]!.values;};
  const pool=pick("aws_cognito_user_pool","production"),client=pick("aws_cognito_user_pool_client","chrome"),domain=pick("aws_cognito_user_pool_domain","production");
  if(typeof pool.id!=="string"||!pool.id.startsWith(`${inputs.region}_`)||typeof client.id!=="string"||client.user_pool_id!==pool.id||domain.user_pool_id!==pool.id||domain.domain!==inputs.cognito_domain_prefix)throw Error("Initial platform state identity disagrees with inputs");
  const known:ReleaseBaseline={root:"platform",apiBaseUrl:null,apiId:null,cognitoIssuer:`https://cognito-idp.${inputs.region}.amazonaws.com/${pool.id}`,cognitoClientId:client.id,cognitoAuthBaseUrl:`https://${domain.domain}.auth.${inputs.region}.amazoncognito.com`};verifyPostApplyBaseline(outputs,known);return known;
}
export interface ReleaseLedger {commit:string;root:ReleaseRoot;reviewSha256:string;artifactSha256:string|null;apiVersion:string|null;cleanupVersion:string|null;url:string|null;result:"verified"}
/** Apply this run's checked saved binary only; never replan, rebuild or register. */
export async function applyRelease(c:WorkflowContext,services:ReleaseServices):Promise<ReleaseLedger>{
  checkedContext(c);if(!c.apply||!c.expectedCustodySha256)throw Error("Explicit apply and external plan-job custody digest required");await secureDirectory(c.directory);await checkCustody(c);await checkedCommit(c,services.run);
  if(!equal(await parseJson(path(c,"request.json")),request(c)))throw Error("Apply request changed");
  const manifest=await parseJson(path(c,"review.json")) as PrivatePlanManifest,baseline=await parseJson(path(c,"baseline.json")) as ReleaseBaseline|null;
  const a=c.root==="application"?(await readManifest(c.directory,c)).artifact:null;
  if(manifest.reviewSha256!==c.expectedReviewSha256)throw Error("Reviewed digest mismatch");if(a)await services.head(a,c.region);
  await init(c,c.root,services.run);const plan=await shownPlan(c,services.run);
  verifySavedPlan(manifest,plan,await readFile(path(c,"saved.tfplan")),await readFile(path(c,"inputs.json")),a,c.commit,baseline,c.root);
  await services.run("terraform",[`-chdir=${rootPath(c.root)}`,"apply","-input=false","-lock=true","-lock-timeout=5m",path(c,"saved.tfplan")]);
  const outputs:unknown=JSON.parse(await services.run("terraform",[`-chdir=${rootPath(c.root)}`,"output","-json"]));await privateJson(path(c,"outputs.json"),outputs);
  const known=baseline??initialPlatformBaseline(outputs,JSON.parse(await services.run("terraform",[`-chdir=${rootPath(c.root)}`,"show","-json"])),jsonObject.parse(await parseJson(path(c,"inputs.json"))));verifyPostApplyBaseline(outputs,known);await privateJson(path(c,"post-baseline.json"),known);
  if(c.root==="platform"){
    const selected=selectedRuntimeData(jsonObject.parse(await parseJson(path(c,"inputs.json"))));
    for(const name of ["reminders","owner_state","image_jobs"] as const)if(output(outputs,`${name}_table`)!==selected[`${name}_table`]||output(outputs,`${name}_table_arn`)!==`arn:aws:dynamodb:${c.region}:${jsonObject.parse(await parseJson(path(c,"inputs.json"))).account_id}:table/${selected[`${name}_table`]}`)throw Error("Post-apply platform table mismatch");
    if(!isDeepStrictEqual(jsonObject.parse(jsonObject.parse(outputs).restored_tables).value,selected.restored_tables))throw Error("Post-apply restored map mismatch");
  }
  if(a){verifyRuntimeDataOutputs(jsonObject.parse(outputs),jsonObject.parse(await parseJson(path(c,"inputs.json"))));await services.verify(a,outputs,c.region);await services.smoke(known,c.published);}
  const ledger:ReleaseLedger={commit:c.commit,root:c.root,reviewSha256:manifest.reviewSha256,artifactSha256:a?.sha256Hex??null,apiVersion:a?output(outputs,"api_version"):null,cleanupVersion:a?output(outputs,"cleanup_version"):null,url:a?output(outputs,"api_base_url"):null,result:"verified"};await privateJson(path(c,"ledger.json"),ledger);return ledger;
}
const localRun:CommandRunner=(command,args)=>{
  const phase=command==="terraform"?(args[1]??"terraform"):command==="git"?"git":"provenance";
  return Promise.resolve(runPrivateCommand(command,args,{directory:join(process.env.RUNNER_TEMP??tmpdir(),"release-diagnostics"),phase,captureStdout:phase==="init"}));
};
function required(name:string):string {const value=process.env[name];if(!value)throw Error("Missing workflow configuration");return value;}
function boolean(name:string):boolean {const value=required(name);if(value!=="true"&&value!=="false")throw Error("Invalid workflow boolean");return value==="true";}
const quietIO={stdout:(_s:string)=>{},stderr:(_s:string)=>{}};
const defaultServices:ReleaseServices={run:localRun,head:async(a,r)=>{const client=createRegistrationClient(r);try{await readRegisteredArtifact(a,client);}finally{client.destroy();}},verify:async(_a,_o,r)=>{if(await verifyMain(["--artifact",join(required("RUNNER_TEMP"),"release","artifact.json"),"--outputs",join(required("RUNNER_TEMP"),"release","outputs.json"),"--region",r],quietIO)!==0)throw Error("Lambda release proof failed");},smoke:async(b,p)=>{if(!b.apiBaseUrl)throw Error("Known URL required");await smoke(b.apiBaseUrl,p);}};
export async function workflowMain(argv:string[]):Promise<void>{
  if(argv.length!==1||!["authorize","secure","plan","apply"].includes(argv[0]!))throw Error("Unknown finite workflow phase");
  const directory=join(required("RUNNER_TEMP"),"release");if(argv[0]==="secure"){await secureDirectory(directory);return;}
  const c:WorkflowContext={directory,root:required("RELEASE_ROOT") as ReleaseRoot,commit:required("RELEASE_COMMIT"),region:required("AWS_REGION"),apply:boolean("RELEASE_APPLY"),published:boolean("RELEASE_PUBLISHED"),schedulerEnabled:boolean("RELEASE_SCHEDULER_ENABLED"),expectedReviewSha256:process.env.EXPECTED_REVIEW_SHA256??"",...(process.env.EXPECTED_CUSTODY_SHA256?{expectedCustodySha256:process.env.EXPECTED_CUSTODY_SHA256}:{})};
  if(argv[0]==="authorize"){
    const head=(await localRun("git",["rev-parse","HEAD"])).trim();let contains=true;try{await localRun("git",["merge-base","--is-ancestor",c.commit,"origin/main"]);}catch{contains=false;}
    const event=jsonObject.parse(await parseJson(required("GITHUB_EVENT_PATH"))),repository=jsonObject.parse(event.repository);
    const reviewedRun=process.env.REVIEWED_RUN??"";authorizeDispatch({privateRepository:repository.private===true,event:required("GITHUB_EVENT_NAME"),ref:required("GITHUB_REF"),commit:c.commit,head,mainContainsCommit:contains,apply:c.apply,reviewedRun,expectedReviewSha256:c.expectedReviewSha256,root:c.root});
    if(reviewedRun){const repo=required("GITHUB_REPOSITORY");if(!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo))throw Error("Invalid repository");const response=await fetch(`https://api.github.com/repos/${repo}/actions/runs/${reviewedRun}`,{headers:{Authorization:`Bearer ${required("DRIVER_GITHUB_TOKEN")}`,Accept:"application/vnd.github+json","X-GitHub-Api-Version":"2022-11-28"}});if(!response.ok)throw Error("Reviewed run inaccessible");verifyReviewedRunMetadata(await response.json(),repo);}
    return;
  }
  if(argv[0]==="plan"){
    const source=process.env.RELEASE_SOURCE==="true"?join(required("RUNNER_TEMP"),"selected"):undefined;
    const review=await planRelease(c,{inputs:JSON.parse(required("RELEASE_INPUTS_JSON")),baseline:JSON.parse(required("RELEASE_BASELINE_JSON")),stateBucket:required("STATE_BUCKET")},source,defaultServices);
    const custody=hash(await readFile(path(c,"custody.json")));await writeFile(required("GITHUB_OUTPUT"),`review_sha256=${review}\ncustody_sha256=${custody}\n`,{flag:"a"});
    // Only a digest and counts are public in the run log; private JSON stays off stdout.
    const p=jsonObject.parse(await parseJson(path(c,"plan.json"))),resources=z.array(jsonObject).parse(p.resource_changes);const counts:Record<string,number>={};for(const r of resources){const action=z.array(z.string()).parse(jsonObject.parse(r.change).actions).join("+");counts[action]=(counts[action]??0)+1;}
    await writeFile(required("GITHUB_STEP_SUMMARY"),`Reviewed ${c.root} commit ${c.commit}\n\nreview_sha256: ${review}\n\nAction counts: ${JSON.stringify(counts)}\n\nDownload the private release-review artifact for the complete plan.\n`,{flag:"a"});return;
  }
  if(!c.expectedCustodySha256)throw Error("Apply requires plan-job custody digest");
  const ledger=await applyRelease(c,defaultServices);process.stdout.write(JSON.stringify(ledger)+"\n");
}
if(require.main===module)void workflowMain(process.argv.slice(2)).catch((error:unknown)=>{process.stderr.write(error instanceof PrivateCommandError?`${error.message}\n`:"Protected release denied; no success claim. Review private inputs, evidence and plan.\n");process.exitCode=1;});
