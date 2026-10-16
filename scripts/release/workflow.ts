import {isDeepStrictEqual} from "node:util";
import {requireRuntimeData, selectedRuntimeData, verifyRuntimeDataOutputs} from "./runtime-data";
import {runPrivateCommand,PrivateCommandError} from "./private-command";
import {tmpdir} from "node:os";
import {createHash} from "node:crypto";
import {chmod,copyFile,lstat,mkdir,mkdtemp,readFile,readdir,rm,writeFile} from "node:fs/promises";
import {dirname,join,resolve} from "node:path";
import {S3Client} from "@aws-sdk/client-s3";
import {z} from "zod";
import {createRegistrationClient,readRegisteredArtifact,type RegisteredArtifact,type ReleaseManifest} from "./artifact";
import {createPlanManifest,verifySavedPlan,verifyPostApplyBaseline,validateRegisteredArtifact,type ReleaseBaseline,type ReleaseRoot,type PrivatePlanManifest} from "./plan-guard";
import {verifyMain} from "./verify-release";
import {applicationCustodyNames,assertUsable,createS3CustodyStore,custodyNames,custodyPrefix,readCustody,readOriginalManifest,writeCustody,type CustodyLocation,type CustodyManifest,type CustodyReference,type CustodyStore} from "./custody";
import {smoke} from "./smoke";

export interface WorkflowContext {
  directory:string;root:ReleaseRoot;commit:string;region:string;apply:boolean;
  published:boolean;schedulerEnabled:boolean;
  /** custody の置き場所（private S3）。書く object の prefix は今の job の run ID と run_attempt で決まる。 */
  custodyStore:CustodyStore;runId:string;runAttempt:number;now:()=>Date;
}
export interface PlannedRelease {manifestSha256:string;manifestSha256Base64:string;planReviewSha256:string}
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
/** private なディレクトリを 0700 で用意し、symlink と通常のファイルでないものを拒否して、各ファイルを 0600 に戻す。 */
export async function secureDirectory(directory:string):Promise<void>{
  await mkdir(directory,{recursive:true,mode:0o700});const dir=await lstat(directory);if(!dir.isDirectory()||dir.isSymbolicLink())throw Error("Invalid private directory");await chmod(directory,0o700);
  for(const name of await readdir(directory)){const p=join(directory,name),s=await lstat(p);if(!s.isFile()||s.isSymbolicLink())throw Error("Only regular private release files are accepted");await chmod(p,0o600);}
}
export function authorizeDispatch(input:{event:string;ref:string;commit:string;head:string;mainContainsCommit:boolean;apply:boolean;reviewedRun:string;expectedReviewSha256:string;root:string}):void{
  commit.parse(input.commit);if(input.event!=="workflow_dispatch"||input.ref!=="refs/heads/main"||input.head!==input.commit||!input.mainContainsCommit||!["platform","application"].includes(input.root))throw Error("Main immutable-commit dispatch required");
  if(input.reviewedRun!==""&&!/^[1-9][0-9]*$/.test(input.reviewedRun))throw Error("Invalid reviewed run");
  if(input.apply&&!input.reviewedRun)throw Error("Apply requires a reviewed preview run and digest");
  if(input.reviewedRun&&!sha.safeParse(input.expectedReviewSha256).success)throw Error("Reviewed run requires the reviewed preview digest");
  if(input.reviewedRun&&!input.apply&&input.root!=="application")throw Error("Reused ZIP preview is for application only");
}
/** reviewed_run は、この repository の main で手動実行され成功した deploy.yml の run に限る。公開設定は条件にしない。 */
export function verifyReviewedRunMetadata(input:unknown,repository:string):void{
  const run=jsonObject.parse(input),head=jsonObject.parse(run.head_repository);
  if(run.event!=="workflow_dispatch"||run.head_branch!=="main"||run.path!==".github/workflows/deploy.yml"||run.conclusion!=="success"||run.status!=="completed"||head.full_name!==repository)throw Error("Reviewed run lacks main dispatch provenance");
}
const jobsResponse=z.object({jobs:z.array(z.object({name:z.string(),conclusion:z.string().nullable(),run_attempt:z.number().int().positive()}))});
/** jobs API（filter=all）の応答から、成功した plan job の最大の run_attempt を返す。deploy.yml の job に name は無いので job id の plan が name になる。 */
export function selectReviewedPlanAttempt(jobs:unknown):number{
  const attempts=jobsResponse.parse(jobs).jobs.filter(j=>j.name==="plan"&&j.conclusion==="success").map(j=>j.run_attempt);
  if(attempts.length===0)throw Error("Reviewed run has no successful plan job");return Math.max(...attempts);
}
const JOBS_PER_PAGE=100,MAX_JOBS_PAGES=10;
const jobsPage=z.object({total_count:z.number().int().nonnegative(),jobs:z.array(z.unknown())});
/**
 * jobs API（filter=all）を total_count に達するまでページ順に読み、全 job をまとめて返す。
 * 100件は1ページの上限であり全件ではないので、成功した plan job が後のページにあっても見落とさない。
 * 10ページ（1000件）を超える run と、total_count に届く前に空のページが来る応答は拒否する。
 */
export async function collectReviewedRunJobs(getPage:(page:number)=>Promise<unknown>):Promise<{jobs:unknown[]}>{
  const jobs:unknown[]=[];
  for(let page=1;;page++){
    const response=jobsPage.parse(await getPage(page));
    if(response.total_count>JOBS_PER_PAGE*MAX_JOBS_PAGES)throw Error("Reviewed run has too many jobs");
    jobs.push(...response.jobs);
    if(jobs.length>=response.total_count)return {jobs};
    if(response.jobs.length===0||page>=MAX_JOBS_PAGES)throw Error("Reviewed run jobs listing is incomplete");
  }
}
const request=(c:WorkflowContext)=>({root:c.root,commit:c.commit,region:c.region,published:c.published,schedulerEnabled:c.schedulerEnabled});
function equal(a:unknown,b:unknown):boolean{return JSON.stringify(a)===JSON.stringify(b);}
function checkedContext(c:WorkflowContext):void{
  commit.parse(c.commit);z.enum(["platform","application"]).parse(c.root);z.string().regex(/^[a-z]{2}-[a-z]+-[1-9][0-9]*$/).parse(c.region);
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
async function saveCustody(c:WorkflowContext):Promise<void>{const files:Record<string,string>={};for(const name of custodyNames)files[name]=hash(await readFile(path(c,name)));if(c.root==="application")for(const name of applicationCustodyNames)files[name]=hash(await readFile(path(c,name)));await privateJson(path(c,"custody.json"),files);}
/** custody.json（root ごとの必須のファイルの集合と hash）を directory のファイルと照合する。今の run と、取り出した元の bundle の両方に使う。 */
async function checkCustody(directory:string,root:ReleaseRoot,expectedCustodySha256?:string):Promise<void>{
  const at=(name:string)=>join(resolve(directory),name);
  const bytes=await readFile(at("custody.json"));if(expectedCustodySha256!==undefined&&hash(bytes)!==sha.parse(expectedCustodySha256))throw Error("Transferred custody digest changed");
  const files=jsonObject.parse(JSON.parse(bytes.toString()));const expected=root==="application"?[...custodyNames,...applicationCustodyNames]:[...custodyNames];
  if(!equal(Object.keys(files).sort(),[...expected].sort()))throw Error("Incomplete custody manifest");for(const name of expected)if(files[name]!==hash(await readFile(at(name))))throw Error("Private release bytes changed");
}
/**
 * 取り出した元の preview の bundle を確かめる（custody.json の照合は呼び出し側で済ませておく）。
 * 元の saved.tfplan から導いた plan と元の review.json の対応を元の bundle の値だけで確かめ（verifySavedPlan）、
 * 続けて preview であること、root、commit、artifact を今の run と比べる。
 */
async function checkOriginalPreview(c:WorkflowContext,config:WorkflowConfig,source:string,original:CustodyManifest,artifact:RegisteredArtifact|null,run:CommandRunner):Promise<void>{
  const at=(name:string)=>join(source,name);
  const review=jsonObject.parse(await parseJson(at("review.json")));
  const plan:unknown=JSON.parse(await run("terraform",[`-chdir=${rootPath(c.root)}`,"show","-json",at("saved.tfplan")]));
  verifySavedPlan(review,plan,await readFile(at("saved.tfplan")),await readFile(at("inputs.json")),await parseJson(at("artifact.json")) as RegisteredArtifact|null,commit.parse(review.commit),await parseJson(at("baseline.json")) as ReleaseBaseline|null,c.root);
  if(review.reviewSha256!==original.planReviewSha256)throw Error("Reviewed manifest and saved review differ");
  // Reused previews pin root/commit/artifact; apply runs also pin every reviewed input and expectation.
  if(jsonObject.parse(await parseJson(at("preview.json"))).preview!==true||review.root!==c.root||review.commit!==c.commit||!equal(await parseJson(at("artifact.json")),artifact))throw Error("Original preview and selected artifact required");
  if(c.apply&&(review.inputSha256!==hash(await readFile(path(c,"inputs.json")))||!equal(await parseJson(at("baseline.json")),config.baseline)||!equal(await parseJson(at("request.json")),request(c))))throw Error("Preview inputs or selected artifact changed");
}
/**
 * Finite production plan phase. No build, registration, state dump or caller-supplied plan JSON.
 * source は custody の置き場所で、同じ run の registered-release か、reviewed_run の release-review（新しい platform の preview では無し）。
 * 結果は今の job の release-review に書き、manifest の SHA-256（レビューの digest）と plan の digest を返す。
 */
export async function planRelease(c:WorkflowContext,config:WorkflowConfig,source:CustodyReference|undefined,services:ReleaseServices):Promise<PlannedRelease>{
  checkedContext(c);
  const kind=source?.location.kind;
  if(kind!==undefined&&kind!=="release-review"&&kind!=="registered-release")throw Error("Unsupported source custody");
  if(c.apply&&kind!=="release-review")throw Error("Apply run requires original preview custody");
  if(c.root==="application"&&!source)throw Error("Registered artifact evidence required");
  if(c.root==="platform"&&kind==="registered-release")throw Error("Platform has no registered artifact");
  if(kind==="release-review"&&!c.apply&&c.root!=="application")throw Error("Reused ZIP preview is for application only");
  await checkedCommit(c,services.run);await secureDirectory(c.directory);
  // 種類ごと・読むたびに新しい空のディレクトリへ取り出し、終わったら消す。
  const sourceDirectory=source?await mkdtemp(join(dirname(resolve(c.directory)),"release-source-")):undefined;
  try{return await planFromSource(c,config,source,sourceDirectory,services);}
  finally{if(sourceDirectory)await rm(sourceDirectory,{recursive:true,force:true});}
}
async function planFromSource(c:WorkflowContext,config:WorkflowConfig,source:CustodyReference|undefined,sourceDirectory:string|undefined,services:ReleaseServices):Promise<PlannedRelease>{
  const inputs=jsonObject.parse(config.inputs);if(inputs.region!==c.region||!/^[0-9]{12}$/.test(String(inputs.account_id))||!/^([a-z][a-z0-9-]{1,24}[a-z0-9])$/.test(String(inputs.name_prefix)))throw Error("Explicit account, region and prefix required");
  if(config.stateBucket!==`${inputs.name_prefix}-${inputs.account_id}-${c.region}-state`)throw Error("State bucket identity mismatch");
  if(c.root==="application"&&(config.baseline===null||config.baseline.root!=="application"||!config.baseline.apiId||inputs.production_api_id!==config.baseline.apiId||inputs.operator_api_seed===true))throw Error("Normal application needs known seeded API baseline and seed=false");
  if(c.root==="platform"&&c.schedulerEnabled)throw Error("Scheduler belongs to application");
  const reviewed=source?.location.kind==="release-review";let original:CustodyManifest|undefined,registered:ReleaseManifest|undefined;
  if(source&&sourceDirectory){
    original=await readCustody(c.custodyStore,source.location,source.manifestSha256,sourceDirectory,{root:c.root,now:c.now()});
    // manifest の照合とは独立に、元の bundle の custody.json と必須のファイルの集合を照合する。
    if(reviewed)await checkCustody(sourceDirectory,c.root,original.custodySha256);
  }
  if(c.root==="application"){registered=await readManifest(sourceDirectory!,c);await services.head(registered.artifact,c.region);await copyEvidence(sourceDirectory!,c);}
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
  await init(c,c.root,services.run);
  if(reviewed)await checkOriginalPreview(c,config,sourceDirectory!,original!,registered?.artifact??null,services.run);
  await services.run("terraform",[`-chdir=${rootPath(c.root)}`,"plan","-input=false","-lock=true","-lock-timeout=5m",`-var-file=${path(c,"inputs.json")}`,`-out=${path(c,"saved.tfplan")}`]);await chmod(path(c,"saved.tfplan"),0o600);
  const plan=await shownPlan(c,services.run),manifest=createPlanManifest(plan,await readFile(path(c,"saved.tfplan")),await readFile(path(c,"inputs.json")),registered?.artifact??null,c.commit,config.baseline,c.root);
  // apply の run は、入力の digest ではなく、照合済みの元の manifest の中の plan の digest と比べる。
  if(c.apply&&manifest.reviewSha256!==original!.planReviewSha256)throw Error("New plan differs from reviewed preview");
  await writeFile(path(c,"review.json"),JSON.stringify(manifest,null,2)+"\n",{flag:"wx",mode:0o600});await saveCustody(c);
  await privateFile(path(c,"plan.txt"),await services.run("terraform",[`-chdir=${rootPath(c.root)}`,"show","-no-color",path(c,"saved.tfplan")]));
  // apply の run は元のレビューの期限を引き継ぐ。ZIP を再利用した preview は元の manifest を記録し、新しい作成時刻から24時間とする。
  const written=await writeCustody(c.custodyStore,{kind:"release-review",runId:c.runId,runAttempt:c.runAttempt},c.directory,{
    root:c.root,planReviewSha256:manifest.reviewSha256,custodySha256:hash(await readFile(path(c,"custody.json"))),
    ...(reviewed&&c.apply?{expiresAt:original!.expiresAt}:{}),...(reviewed&&!c.apply?{sourceManifestSha256:source!.manifestSha256}:{}),
  },c.now());
  return {...written,planReviewSha256:manifest.reviewSha256};
}
function initialPlatformBaseline(outputs:unknown,state:unknown,inputs:Record<string,unknown>):ReleaseBaseline{
  const resources=z.array(z.looseObject({type:z.string(),name:z.string(),values:jsonObject})).parse(jsonObject.parse(jsonObject.parse(jsonObject.parse(state).values).root_module).resources);
  const pick=(type:string,name:string)=>{const matches=resources.filter(r=>r.type===type&&r.name===name);if(matches.length!==1)throw Error("Unknown initial platform identity");return matches[0]!.values;};
  const pool=pick("aws_cognito_user_pool","production"),client=pick("aws_cognito_user_pool_client","chrome"),domain=pick("aws_cognito_user_pool_domain","production");
  if(typeof pool.id!=="string"||!pool.id.startsWith(`${inputs.region}_`)||typeof client.id!=="string"||client.user_pool_id!==pool.id||domain.user_pool_id!==pool.id||domain.domain!==inputs.cognito_domain_prefix)throw Error("Initial platform state identity disagrees with inputs");
  const known:ReleaseBaseline={root:"platform",apiBaseUrl:null,apiId:null,cognitoIssuer:`https://cognito-idp.${inputs.region}.amazonaws.com/${pool.id}`,cognitoClientId:client.id,cognitoAuthBaseUrl:`https://${domain.domain}.auth.${inputs.region}.amazoncognito.com`};verifyPostApplyBaseline(outputs,known);return known;
}
export interface ReleaseLedger {commit:string;root:ReleaseRoot;reviewSha256:string;artifactSha256:string|null;apiVersion:string|null;cleanupVersion:string|null;url:string|null;result:"verified"}
/**
 * Apply this run's checked saved binary only; never replan, rebuild or register.
 * original は元の preview（入力の reviewed_run と expected_review_sha256）、current は同じ run の plan job の output。
 * 元の preview は manifest だけを照合し、同じ run の release-review を c.directory（空の実ディレクトリか、無いこと）へ取り出す。
 * 結果（ledger.json と、初回の platform では post-baseline.json）は今の job の release-result に書く。
 */
export async function applyRelease(c:WorkflowContext,references:{original:CustodyReference;current:CustodyReference},services:ReleaseServices):Promise<ReleaseLedger>{
  checkedContext(c);if(!c.apply)throw Error("Explicit apply required");
  const {original,current}=references;
  for(const r of [original,current]){if(r.location.kind!=="release-review")throw Error("Apply reads release reviews only");custodyPrefix(r.location);sha.parse(r.manifestSha256);}
  if(current.location.runId!==c.runId)throw Error("Apply reads this run's plan job custody");
  await checkedCommit(c,services.run);
  // 入力の digest は元の preview の manifest の bytes と照合する（plan の digest とは比べない）。
  const reviewed=await readOriginalManifest(c.custodyStore,original.location,original.manifestSha256);
  if(reviewed.root!==c.root)throw Error("Reviewed preview root mismatch");assertUsable(reviewed,c.now());const inheritedExpiresAt=z.string().parse(reviewed.expiresAt);
  // 同じ run の plan job の release-review は、元の期限を引き継いでいなければならない。
  const transferred=await readCustody(c.custodyStore,current.location,current.manifestSha256,c.directory,{root:c.root,now:c.now(),inheritedExpiresAt});
  if(transferred.sourceManifestSha256!==undefined)throw Error("Apply cannot use a reused preview bundle");
  if(transferred.planReviewSha256!==reviewed.planReviewSha256)throw Error("Plan job digest differs from reviewed preview");
  await checkCustody(c.directory,c.root,transferred.custodySha256);
  if(!equal(await parseJson(path(c,"request.json")),request(c)))throw Error("Apply request changed");
  if(jsonObject.parse(await parseJson(path(c,"preview.json"))).preview!==false)throw Error("Apply requires an apply-run plan");
  const manifest=await parseJson(path(c,"review.json")) as PrivatePlanManifest,baseline=await parseJson(path(c,"baseline.json")) as ReleaseBaseline|null;
  const a=c.root==="application"?(await readManifest(c.directory,c)).artifact:null;
  // review.json の plan の digest は、照合済みの manifest の planReviewSha256 と比べる。
  if(manifest.reviewSha256!==transferred.planReviewSha256)throw Error("Reviewed digest mismatch");if(a)await services.head(a,c.region);
  await init(c,c.root,services.run);const plan=await shownPlan(c,services.run);
  verifySavedPlan(manifest,plan,await readFile(path(c,"saved.tfplan")),await readFile(path(c,"inputs.json")),a,c.commit,baseline,c.root);
  // 承認を待つ間に期限を過ぎていないことを、apply の直前にもう一度確かめる。
  assertUsable(transferred,c.now(),inheritedExpiresAt);
  await services.run("terraform",[`-chdir=${rootPath(c.root)}`,"apply","-input=false","-lock=true","-lock-timeout=5m",path(c,"saved.tfplan")]);
  const outputs:unknown=JSON.parse(await services.run("terraform",[`-chdir=${rootPath(c.root)}`,"output","-json"]));await privateJson(path(c,"outputs.json"),outputs);
  const known=baseline??initialPlatformBaseline(outputs,JSON.parse(await services.run("terraform",[`-chdir=${rootPath(c.root)}`,"show","-json"])),jsonObject.parse(await parseJson(path(c,"inputs.json"))));verifyPostApplyBaseline(outputs,known);await privateJson(path(c,"post-baseline.json"),known);
  if(c.root==="platform"){
    const selected=selectedRuntimeData(jsonObject.parse(await parseJson(path(c,"inputs.json"))));
    for(const name of ["reminders","owner_state","image_jobs"] as const)if(output(outputs,`${name}_table`)!==selected[`${name}_table`]||output(outputs,`${name}_table_arn`)!==`arn:aws:dynamodb:${c.region}:${jsonObject.parse(await parseJson(path(c,"inputs.json"))).account_id}:table/${selected[`${name}_table`]}`)throw Error("Post-apply platform table mismatch");
    if(!isDeepStrictEqual(jsonObject.parse(jsonObject.parse(outputs).restored_tables).value,selected.restored_tables))throw Error("Post-apply restored map mismatch");
  }
  if(a){verifyRuntimeDataOutputs(jsonObject.parse(outputs),jsonObject.parse(await parseJson(path(c,"inputs.json"))));await services.verify(a,outputs,c.region);await services.smoke(known,c.published);}
  const ledger:ReleaseLedger={commit:c.commit,root:c.root,reviewSha256:manifest.reviewSha256,artifactSha256:a?.sha256Hex??null,apiVersion:a?output(outputs,"api_version"):null,cleanupVersion:a?output(outputs,"cleanup_version"):null,url:a?output(outputs,"api_base_url"):null,result:"verified"};await privateJson(path(c,"ledger.json"),ledger);
  // post-baseline.json は常に作るが、release-result に置くのは初回の platform の構築のときだけ。
  await writeCustody(c.custodyStore,{kind:"release-result",runId:c.runId,runAttempt:c.runAttempt},c.directory,{root:c.root},c.now(),{initialPlatform:c.root==="platform"&&baseline===null});
  return ledger;
}
const localRun:CommandRunner=(command,args)=>{
  const phase=command==="terraform"?(args[1]??"terraform"):command==="git"?"git":"provenance";
  return Promise.resolve(runPrivateCommand(command,args,{directory:join(process.env.RUNNER_TEMP??tmpdir(),"release-diagnostics"),phase,captureStdout:phase==="init"}));
};
function required(name:string):string {const value=process.env[name];if(!value)throw Error("Missing workflow configuration");return value;}
function optional(name:string):string {return process.env[name]??"";}
function boolean(name:string):boolean {const value=required(name);if(value!=="true"&&value!=="false")throw Error("Invalid workflow boolean");return value==="true";}
const quietIO={stdout:(_s:string)=>{},stderr:(_s:string)=>{}};
const defaultServices:ReleaseServices={run:localRun,head:async(a,r)=>{const client=createRegistrationClient(r);try{await readRegisteredArtifact(a,client);}finally{client.destroy();}},verify:async(_a,_o,r)=>{if(await verifyMain(["--artifact",join(required("RUNNER_TEMP"),"release","artifact.json"),"--outputs",join(required("RUNNER_TEMP"),"release","outputs.json"),"--region",r],quietIO)!==0)throw Error("Lambda release proof failed");},smoke:async(b,p)=>{if(!b.apiBaseUrl)throw Error("Known URL required");await smoke(b.apiBaseUrl,p);}};
export interface WorkflowIO {stdout(text:string):void;stderr(text:string):void}
/** 試験が差し替える依存。省略時は S3（CUSTODY_BUCKET、region は環境の既定）、実時刻、実コマンド、process の標準出力を使う。 */
export interface WorkflowInjection {custodyStore?:CustodyStore;now?:()=>Date;services?:ReleaseServices;io?:WorkflowIO}
const processIO:WorkflowIO={stdout:s=>{process.stdout.write(s);},stderr:s=>{process.stderr.write(s);}};
const runIdPattern=/^[1-9][0-9]{0,19}$/,runAttemptPattern=/^[1-9][0-9]{0,8}$/;
function runAttemptValue(value:string):number{if(!runAttemptPattern.test(value))throw Error("Invalid run attempt");return Number(value);}
/**
 * plan job が読む custody の置き場所を環境変数から決める。種類は入力（reviewed_run と root）で決まり、S3 と Terraform に触れる前に形式を確かめる。
 * reviewed_run があれば release-review、無い application は同じ run の registered-release、無い platform は source を持たない。
 * reviewed_run の経路では、SOURCE_MANIFEST_SHA256 が入力の EXPECTED_REVIEW_SHA256 と一致しなければならない（deploy.yml の配線に頼らない）。
 * ZIP を再利用した新しい preview（reviewed_run があり apply=false）は application だけ。読む job 自身の run_attempt で代用しない。
 */
function planSource(root:ReleaseRoot,apply:boolean,runId:string):CustodyReference|undefined{
  const reviewedRun=optional("REVIEWED_RUN"),id=optional("SOURCE_RUN_ID"),attempt=optional("SOURCE_ATTEMPT"),manifest=optional("SOURCE_MANIFEST_SHA256");
  if(reviewedRun&&!apply&&root!=="application")throw Error("Reused ZIP preview is for application only");
  if(!reviewedRun&&root==="platform"){if(id!==""||attempt!==""||manifest!=="")throw Error("Platform preview takes no source custody");return undefined;}
  if(!runIdPattern.test(id)||!runAttemptPattern.test(attempt)||!sha.safeParse(manifest).success)throw Error("Missing or malformed source custody outputs");
  if(id!==(reviewedRun||runId))throw Error("Source custody run mismatch");
  if(reviewedRun&&manifest!==sha.parse(optional("EXPECTED_REVIEW_SHA256")))throw Error("Source manifest differs from the reviewed digest");
  return {location:{kind:reviewedRun?"release-review":"registered-release",runId:id,runAttempt:runAttemptValue(attempt)},manifestSha256:manifest};
}
/**
 * apply job が読む2つの置き場所を環境変数から決め、S3 と Terraform に触れる前に形式を確かめる。
 * original は元の preview（REVIEWED_RUN、authorize の reviewed_attempt、EXPECTED_REVIEW_SHA256）、current は同じ run の plan job の output（PLAN_CUSTODY_*）。
 * どちらも、読む job 自身の run_attempt で代用しない。
 */
function applyReferences(runId:string):{original:CustodyReference;current:CustodyReference}{
  const reviewedRun=optional("REVIEWED_RUN"),reviewedAttempt=optional("REVIEWED_ATTEMPT"),expected=optional("EXPECTED_REVIEW_SHA256");
  if(!runIdPattern.test(reviewedRun)||!runAttemptPattern.test(reviewedAttempt)||!sha.safeParse(expected).success)throw Error("Missing or malformed reviewed preview reference");
  const planRun=optional("PLAN_CUSTODY_RUN_ID"),planAttempt=optional("PLAN_CUSTODY_ATTEMPT"),planManifest=optional("PLAN_CUSTODY_MANIFEST_SHA256");
  if(!runIdPattern.test(planRun)||!runAttemptPattern.test(planAttempt)||!sha.safeParse(planManifest).success)throw Error("Missing or malformed plan job custody outputs");
  if(planRun!==runId)throw Error("Plan job custody run mismatch");
  return {
    original:{location:{kind:"release-review",runId:reviewedRun,runAttempt:runAttemptValue(reviewedAttempt)},manifestSha256:expected},
    current:{location:{kind:"release-review",runId:planRun,runAttempt:runAttemptValue(planAttempt)},manifestSha256:planManifest},
  };
}
function actionCounts(plan:unknown):Record<string,number>{
  const resources=z.array(jsonObject).parse(jsonObject.parse(plan).resource_changes),counts:Record<string,number>={};
  for(const r of resources){const action=z.array(z.string()).parse(jsonObject.parse(r.change).actions).join("+");counts[action]=(counts[action]??0)+1;}
  return counts;
}
const MAX_DIAGNOSTICS=8,diagnosticSources=[["release","release-diagnostics"],["infra","infra-diagnostics"]] as const;
/**
 * 失敗した job の診断（$RUNNER_TEMP/release-diagnostics/*.json と infra-diagnostics/*.json）を failure-diagnostics/<run_id>/<run_attempt>/<GITHUB_JOB>/ に書く。
 * 名前の衝突を防ぐため、元のディレクトリに応じて release- か infra- を前に付け、1つの一時ディレクトリにまとめてから書く。
 * 合計が8個を超えるときは、release-diagnostics、次に infra-diagnostics の順に、各ディレクトリの中では新しいもの（名前の降順）から8個だけを書き、残した数だけを標準エラーに出す。
 * ファイルが無ければ何もしない。symlink など通常のファイルでないものがあれば、読まずに止まる。
 */
async function writeDiagnostics(inject:WorkflowInjection,io:WorkflowIO):Promise<void>{
  const runId=required("GITHUB_RUN_ID");if(!runIdPattern.test(runId))throw Error("Invalid run ID");
  const location:CustodyLocation={kind:"failure-diagnostics",runId,runAttempt:runAttemptValue(required("GITHUB_RUN_ATTEMPT")),job:required("GITHUB_JOB")};custodyPrefix(location);
  const temp=required("RUNNER_TEMP"),found:Array<{name:string;from:string}>=[];
  for(const [label,name] of diagnosticSources){
    const directory=join(temp,name),s=await lstat(directory).catch((e:unknown)=>{if((e as NodeJS.ErrnoException).code==="ENOENT")return undefined;throw e;});
    if(!s)continue;if(!s.isDirectory()||s.isSymbolicLink())throw Error("Invalid diagnostics directory");
    // 名前（failure-<epoch ms>-<uuid>.json）の降順は新しい順なので、ディレクトリごとに新しいものから並べる。
    for(const file of (await readdir(directory)).filter(n=>n.endsWith(".json")).sort().reverse()){
      const from=join(directory,file),f=await lstat(from);if(!f.isFile()||f.isSymbolicLink())throw Error("Invalid diagnostics file");
      found.push({name:`${label}-${file}`,from});
    }
  }
  if(found.length===0)return;
  const kept=found.slice(0,MAX_DIAGNOSTICS),staging=await mkdtemp(join(temp,"failure-diagnostics-"));
  const client=inject.custodyStore?undefined:new S3Client({});
  try{
    for(const {name,from} of kept)await writeFile(join(staging,name),await readFile(from),{mode:0o600,flag:"wx"});
    await writeCustody(inject.custodyStore??createS3CustodyStore(required("CUSTODY_BUCKET"),client!),location,staging,{root:null},(inject.now??(()=>new Date()))());
    if(kept.length<found.length)io.stderr(`Kept ${kept.length} of ${found.length} diagnostic files\n`);
  }finally{client?.destroy();await rm(staging,{recursive:true,force:true});}
}
export async function workflowMain(argv:string[],inject:WorkflowInjection={}):Promise<void>{
  if(argv.length!==1||!["authorize","register-custody","plan","apply","diagnostics"].includes(argv[0]!))throw Error("Unknown finite workflow phase");
  const phase=argv[0]!,services=inject.services??defaultServices,io=inject.io??processIO;
  // 診断は失敗した job の最後に書く。release の設定には依存しない。
  if(phase==="diagnostics"){await writeDiagnostics(inject,io);return;}
  const directory=join(required("RUNNER_TEMP"),"release");
  const base={directory,root:required("RELEASE_ROOT") as ReleaseRoot,commit:required("RELEASE_COMMIT"),region:required("AWS_REGION"),apply:boolean("RELEASE_APPLY"),published:boolean("RELEASE_PUBLISHED"),schedulerEnabled:boolean("RELEASE_SCHEDULER_ENABLED")};
  if(phase==="authorize"){
    const c=base;
    const head=(await localRun("git",["rev-parse","HEAD"])).trim();let contains=true;try{await localRun("git",["merge-base","--is-ancestor",c.commit,"origin/main"]);}catch{contains=false;}
    const reviewedRun=optional("REVIEWED_RUN");authorizeDispatch({event:required("GITHUB_EVENT_NAME"),ref:required("GITHUB_REF"),commit:c.commit,head,mainContainsCommit:contains,apply:c.apply,reviewedRun,expectedReviewSha256:optional("EXPECTED_REVIEW_SHA256"),root:c.root});
    if(reviewedRun){
      const repo=required("GITHUB_REPOSITORY");if(!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo))throw Error("Invalid repository");
      const get=async(url:string):Promise<unknown>=>{const response=await fetch(url,{headers:{Authorization:`Bearer ${required("DRIVER_GITHUB_TOKEN")}`,Accept:"application/vnd.github+json","X-GitHub-Api-Version":"2022-11-28"}});if(!response.ok)throw Error("Reviewed run inaccessible");return response.json();};
      verifyReviewedRunMetadata(await get(`https://api.github.com/repos/${repo}/actions/runs/${reviewedRun}`),repo);
      const attempt=selectReviewedPlanAttempt(await collectReviewedRunJobs(page=>get(`https://api.github.com/repos/${repo}/actions/runs/${reviewedRun}/jobs?filter=all&per_page=${JOBS_PER_PAGE}&page=${page}`)));
      await writeFile(required("GITHUB_OUTPUT"),`reviewed_attempt=${attempt}\n`,{flag:"a"});
    }
    return;
  }
  // custody を読み書きする phase は、置き場所（今の job の run ID と run_attempt）と bucket を要する。
  const runId=required("GITHUB_RUN_ID");if(!runIdPattern.test(runId))throw Error("Invalid run ID");
  const runAttempt=runAttemptValue(required("GITHUB_RUN_ATTEMPT"));
  // 読む置き場所の形式は、S3 の client を作る前に確かめる。
  const source=phase==="plan"?planSource(base.root,base.apply,runId):undefined;
  const references=phase==="apply"?applyReferences(runId):undefined;
  const client=inject.custodyStore?undefined:new S3Client({});
  try{
    const c:WorkflowContext={...base,custodyStore:inject.custodyStore??createS3CustodyStore(required("CUSTODY_BUCKET"),client!),runId,runAttempt,now:inject.now??(()=>new Date())};
    if(phase==="register-custody"){
      // register job の最後に、登録した ZIP の manifest と証拠を同じ run の plan job へ渡す。
      if(c.root!=="application")throw Error("Only an application release registers a ZIP");
      const written=await writeCustody(c.custodyStore,{kind:"registered-release",runId:c.runId,runAttempt:c.runAttempt},join(required("RUNNER_TEMP"),"registered"),{root:"application"},c.now());
      await writeFile(required("GITHUB_OUTPUT"),`custody_run_id=${c.runId}\ncustody_attempt=${c.runAttempt}\ncustody_manifest_sha256=${written.manifestSha256}\n`,{flag:"a"});return;
    }
    if(phase==="plan"){
      const result=await planRelease(c,{inputs:JSON.parse(required("RELEASE_INPUTS_JSON")),baseline:JSON.parse(required("RELEASE_BASELINE_JSON")),stateBucket:required("STATE_BUCKET")},source,services);
      // review_sha256 は release-review の manifest.json の SHA-256 である（plan の digest ではない）。
      await writeFile(required("GITHUB_OUTPUT"),`custody_run_id=${c.runId}\ncustody_attempt=${c.runAttempt}\ncustody_manifest_sha256=${result.manifestSha256}\nreview_sha256=${result.manifestSha256}\n`,{flag:"a"});
      // job summary は root、commit、action の件数、review_sha256、custody の置き場所だけ。plan や入力は S3 にだけ置く。
      const counts=actionCounts(await parseJson(path(c,"plan.json")));
      await writeFile(required("GITHUB_STEP_SUMMARY"),`Reviewed ${c.root} commit ${c.commit}\n\nreview_sha256: ${result.manifestSha256}\n\nreview_sha256 (Base64): ${result.manifestSha256Base64}\n\nCustody: run ${c.runId}, run_attempt ${c.runAttempt}\n\nAction counts: ${JSON.stringify(counts)}\n`,{flag:"a"});return;
    }
    // ledger は release-result にだけ置き、標準出力には出さない。summary は root、commit、result、release-result の置き場所だけ。
    const ledger=await applyRelease(c,references!,services);
    await writeFile(required("GITHUB_STEP_SUMMARY"),`Applied ${c.root} commit ${c.commit}\n\nresult: ${ledger.result}\n\nRelease result: run ${c.runId}, run_attempt ${c.runAttempt}\n`,{flag:"a"});
  }finally{client?.destroy();}
}
/** CLI の境界。失敗は PrivateCommandError の定型文か固定の文言だけを標準エラーに出し、終了コードを返す。 */
export async function workflowCli(argv:string[],inject:WorkflowInjection={}):Promise<number>{
  const io=inject.io??processIO;
  try{await workflowMain(argv,{...inject,io});return 0;}
  catch(error:unknown){io.stderr(error instanceof PrivateCommandError?`${error.message}\n`:"Protected release denied; no success claim. Review private inputs, evidence and plan.\n");return 1;}
}
if(require.main===module)void workflowCli(process.argv.slice(2)).then(code=>{process.exitCode=code;});
