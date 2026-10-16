import assert from "node:assert/strict";
import {readFileSync,existsSync,readdirSync} from "node:fs";
import {test} from "node:test";
import {Script} from "node:vm";
import {parseDocument} from "yaml";
interface Step {id?:string;uses?:string;run?:string;if?:string;with?:Record<string,unknown>;env?:Record<string,string>;"continue-on-error"?:unknown}
interface Job {permissions?:Record<string,string>;if?:string;needs?:string[]|string;environment?:string;outputs?:Record<string,string>;env?:Record<string,string>;steps:Step[]}
interface Workflow {on:Record<string,unknown>;permissions:Record<string,string>;env?:Record<string,string>;concurrency?:{group:string;"cancel-in-progress":boolean};jobs:Record<string,Job>}
function workflow(name:string):Workflow {
  const path=`.github/workflows/${name}.yml`;
  assert.ok(existsSync(path),`${name} workflow must exist`);
  const doc=parseDocument(readFileSync(path,"utf8"),{version:"1.2"});assert.deepEqual(doc.errors,[]);
  return doc.toJS({maxAliasCount:0}) as Workflow;
}
const commands=(j:Job)=>j.steps.flatMap(s=>s.run?[s.run]:[]).join("\n");
void test("pr_has_no_aws_permissions",()=>{
  const ci=workflow("ci");assert.ok(Object.hasOwn(ci.on,"pull_request"));assert.equal(Object.hasOwn(ci.on,"pull_request_target"),false);
  assert.deepEqual(ci.permissions,{contents:"read"});for(const job of Object.values(ci.jobs)){assert.equal(job.permissions?.["id-token"],undefined);assert.ok(job.steps.every(s=>!s.uses?.startsWith("aws-actions/")));}
  const steps=Object.values(ci.jobs).flatMap(j=>j.steps),runs=steps.filter(s=>s.run).map(s=>s.run!).join("\n");
  for(const command of ["npm ci","typecheck","lint","test:runtime","test:operations","test:packaging","test:delivery","infra:check","audit:runtime","audit:all","sbom"])assert.ok(runs.includes(command),`CI must run ${command}`);
  assert.equal((runs.match(/npm run build/g)??[]).length,1);assert.equal((runs.match(/npm run package/g)??[]).length,1);
  assert.ok(runs.indexOf("npm run package")<runs.indexOf("test:delivery"));
  assert.ok(steps.some(s=>s.with?.["node-version"]==="24.21.0"));assert.ok(steps.some(s=>s.with?.["python-version"]==="3.13.16"));assert.ok(steps.some(s=>s.with?.terraform_version==="1.16.5"));
});
void test("apply_consumes_reviewed_plan_and_never_rebuilds_zip",()=>{
  const d=workflow("deploy");assert.deepEqual(Object.keys(d.on),["workflow_dispatch"]);
  const dispatch=d.on.workflow_dispatch as {inputs:Record<string,{default?:unknown}>};assert.equal(dispatch.inputs.apply?.default,false);
  const apply=d.jobs.apply!;assert.ok(apply);assert.deepEqual(apply.needs,["authorize","plan"]);assert.ok(apply.if?.includes("inputs.apply"));assert.equal(apply.environment,"production");
  assert.ok(commands(apply).includes("release:workflow -- apply"));assert.ok(!/npm run (build|package|release:register)|terraform .*plan/.test(commands(apply)));
  const registration=d.jobs.register!;assert.ok(registration.if?.includes("!inputs.apply"));assert.ok(registration.if?.includes("inputs.target == 'application'"));assert.ok(registration.if?.includes("inputs.reviewed_run == ''"));assert.equal((commands(registration).match(/release:register/g)??[]).length,1);
  for(const required of ["--zip","--manifest","--bucket","--region","--commit","--npm-version","--esbuild-version","--audit-id","--sbom-id","--tests-id"])assert.ok(commands(registration).includes(required));
  assert.ok(commands(d.jobs.plan!).includes("release:workflow -- plan"));assert.ok(commands(d.jobs.authorize!).includes("release:workflow -- authorize"));
});
// Evaluate only the parsed deploy gates, including the documented implicit success()
// and transitive skipped-ancestor rule. This is a local contract model, not a live runner.
function eligible(w:Workflow,name:string,results:Record<string,string>,inputs:Record<string,string|boolean>,cancelled=false):boolean {
  const ancestors=new Set<string>();const visit=(id:string)=>{const needs=w.jobs[id]!.needs;for(const parent of typeof needs==="string"?[needs]:needs??[]){if(!ancestors.has(parent)){ancestors.add(parent);visit(parent);}}};visit(name);
  const success=!cancelled&&Array.from(ancestors).every(id=>results[id]==="success");
  let condition=(w.jobs[name]!.if??"true").replace(/^\s*\$\{\{([\s\S]*)\}\}\s*$/,"$1");
  if(!/\b(?:always|cancelled|success|failure)\s*\(/.test(condition)&&!success)return false;
  condition=condition.replace(/needs\.([a-z]+)\.result/g,(_match,id:string)=>JSON.stringify(results[id]))
    .replace(/inputs\.([a-z_]+)/g,(_match,key:string)=>JSON.stringify(inputs[key]))
    .replace(/always\(\)/g,"true").replace(/cancelled\(\)/g,String(cancelled))
    .replace(/success\(\)/g,String(success)).replace(/failure\(\)/g,String(Array.from(ancestors).some(id=>results[id]==="failure")));
  assert.match(condition,/^(?:\s|&&|\|\||!|\(|\)|==|!=|true|false|"[a-z0-9_]*"|'[a-z0-9_]*')+$/,"Only the finite documented gate syntax is evaluated");
  return new Script(`Boolean(${condition})`).runInNewContext({},{timeout:100}) as boolean;
}
void test("skipped_registration_successful_plan_still_allows_only_authorized_uncancelled_apply",()=>{
  const w=workflow("deploy"),results={authorize:"success",register:"skipped",plan:"success"};
  for(const target of ["platform","application"]){const inputs={target,apply:true,reviewed_run:"42"};
    assert.equal(eligible(w,"register",results,inputs),false);
    assert.equal(eligible(w,"plan",results,inputs),true);
    assert.equal(eligible(w,"apply",results,inputs),true,`${target} apply must survive its skipped registration ancestor`);
    assert.equal(eligible(w,"apply",results,inputs,true),false,"Cancelled runs must not start apply");
    for(const result of ["failure","skipped","cancelled"])for(const job of ["authorize","plan"])assert.equal(eligible(w,"apply",{...results,[job]:result},inputs),false);
    assert.equal(eligible(w,"apply",results,{...inputs,apply:false}),false);
  }
});
void test("all_actions_pinned_and_apply_not_cancelled",()=>{
  for(const name of ["ci","deploy","floci-e2e"]){const w=workflow(name);for(const job of Object.values(w.jobs))for(const s of job.steps)if(s.uses)assert.match(s.uses,/@[0-9a-f]{40}$/);}
  const d=workflow("deploy");assert.equal(d.concurrency?.["cancel-in-progress"],false);assert.equal(d.concurrency?.group,"reminder-production");assert.deepEqual(d.permissions,{contents:"read"});
  const roleVars:string[]=[];for(const [name,job] of Object.entries(d.jobs)){const aws=job.steps.filter(s=>s.uses?.startsWith("aws-actions/"));assert.equal(job.permissions?.["id-token"]==="write",aws.length>0);if(aws.length){assert.ok(["register","plan","apply"].includes(name));assert.equal(aws.length,1);roleVars.push(String(aws[0]!.with?.["role-to-assume"]));assert.equal(aws[0]!.with?.["aws-access-key-id"],undefined);assert.ok(job.if?.includes("needs.authorize.result == 'success'"));}}
  assert.equal(new Set(roleVars).size,3);
});
void test("private_custody_before_oidc_and_one_day_transfer",()=>{
  // custody は private S3 にだけ置く。deploy.yml の authorize は main だけを条件にし、公開設定は条件にしない。
  const d=workflow("deploy");assert.equal(d.jobs.authorize?.if?.includes("repository.private"),false);assert.ok(d.jobs.authorize?.if?.includes("github.ref == 'refs/heads/main'"));
  assert.equal(d.env?.CUSTODY_BUCKET,"${{ vars.CUSTODY_BUCKET }}");
  for(const job of Object.values(d.jobs))for(const step of job.steps)if(step.run){assert.ok(!/terraform .*show.*-json/.test(step.run));assert.ok(!/AWS_(ACCESS_KEY_ID|SECRET_ACCESS_KEY)\s*:/.test(step.run));}
  // PR の CI は AWS の認証を持たないので、診断は今のまま1日の private artifact にする。
  const ci=workflow("ci");let uploads=0;
  for(const job of Object.values(ci.jobs))for(const step of job.steps)if(step.uses?.startsWith("actions/upload-artifact@")){uploads++;assert.equal(step.with?.["retention-days"],1);assert.equal(step.with?.["if-no-files-found"],"ignore");assert.equal(step.with?.["include-hidden-files"],false);assert.ok(String(step.with?.path).startsWith("${{ runner.temp }}"));}
  assert.ok(uploads>=1);
});
void test("maintenance_or_user_admin_workflow_absent",()=>{
  assert.deepEqual(readdirSync(".github/workflows").filter(f=>/\.ya?ml$/.test(f)).sort(),["ci.yml","deploy.yml","floci-e2e.yml"]);
  for(const name of ["ci","deploy","floci-e2e"]){const w=workflow(name);assert.ok(!/Admin(Create|Delete|Initiate|Respond)|migrate:json|recovery:verify|maintenance|docker compose/i.test(JSON.stringify(w)));}
  const dep=parseDocument(readFileSync(".github/dependabot.yml","utf8")).toJS() as {updates:Array<{"package-ecosystem":string;directory:string;schedule:{interval:string}}>};assert.deepEqual(dep.updates.map(u=>u["package-ecosystem"]).sort(),["github-actions","npm","terraform","terraform","terraform"]);for(const u of dep.updates){assert.equal(u.schedule.interval,"weekly");assert.ok(!u.directory.includes(".devcontainer"));}
});

void test("failure diagnostics upload follows commands and cannot become approved preview evidence",()=>{
 // deploy.yml の AWS の job は、最後の step で失敗時だけ diagnostics phase を実行し、S3 の failure-diagnostics に書く。
 const d=workflow("deploy");
 for(const name of ["register","plan","apply"]){
  const job=d.jobs[name]!,last=job.steps.at(-1)!;
  assert.equal(last.if,"failure()");assert.equal(last.run?.trim(),"npm run release:workflow -- diagnostics");assert.equal(last["continue-on-error"],undefined);
  assert.ok(job.steps.slice(0,-1).some(s=>s.run));
  assert.ok(job.steps.slice(0,-1).every(s=>!s.if?.includes("failure()")&&!s.run?.includes("-- diagnostics")));
 }
 // authorize は role を assume しないので S3 に書けない。診断の step を置かない。
 assert.ok(d.jobs.authorize!.steps.every(s=>!s.if?.includes("failure()")&&!s.run?.includes("-- diagnostics")));
 // ci.yml は失敗時の診断だけを artifact にする（最後の step、失敗時だけ）。
 const ci=workflow("ci");
 for(const job of Object.values(ci.jobs))for(const [i,step] of job.steps.entries())if(step.uses?.startsWith("actions/upload-artifact@")){
  assert.equal(i,job.steps.length-1);assert.ok(step.if?.includes("failure()"));assert.ok(String(step.with?.name).startsWith("failure-diagnostics-"));
 }
});
void test("bootstrap fixture subjects match the actual three workflow environments",()=>{
 const d=workflow("deploy"),fixture=readFileSync("infra/bootstrap/tests/bootstrap.tftest.hcl","utf8");
 const subjects=fixture.match(/oidc_subjects\s*=\s*\{([^}]+)\}/)![1]!;
 for(const [role,job] of [["artifact","register"],["plan","plan"],["apply","apply"]] as const){
  const subject=new RegExp(`${role}\\s*=\\s*"([^"]+)"`).exec(subjects)![1];
  assert.equal(subject,`repo:synthetic/reminder-server:environment:${d.jobs[job]!.environment}`);
 }
});

void test("floci_e2e_runs_the_full_local_suite_without_aws_or_secrets",()=>{
  const w=workflow("floci-e2e");assert.deepEqual(w.on,{push:{branches:["main"]}});assert.deepEqual(w.permissions,{contents:"read"});
  assert.ok(!/secrets\.|AWS_(ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN|PROFILE)/.test(JSON.stringify(w)));
  for(const job of Object.values(w.jobs)){assert.equal(job.permissions,undefined);assert.ok(job.steps.every(s=>!s.uses?.startsWith("aws-actions/")));}
  const steps=Object.values(w.jobs).flatMap(j=>j.steps),runs=steps.filter(s=>s.run).map(s=>s.run!).join("\n");
  assert.ok(runs.includes("-f .github/floci/Dockerfile"));assert.ok(runs.includes("--build-context patch=.devcontainer/floci"));
  assert.ok(runs.indexOf("npm run package")<runs.indexOf("npm test"));
  assert.ok(steps.some(s=>s.with?.["node-version"]==="24.21.0"));assert.ok(steps.some(s=>s.with?.["python-version"]==="3.13.16"));assert.ok(steps.some(s=>s.with?.terraform_version==="1.16.5"));
});

void test("deploy_uses_no_github_artifacts_or_visibility_gate",()=>{
  const text=readFileSync(".github/workflows/deploy.yml","utf8");
  for(const banned of ["upload-artifact","download-artifact","repository.private","release:workflow -- secure"])assert.equal(text.includes(banned),false,`deploy.yml must not use ${banned}`);
});
const stepIndex=(job:Job,predicate:(s:Step)=>boolean):number=>{const i=job.steps.findIndex(predicate);assert.ok(i>=0);return i;};
void test("custody_runs_only_after_role_assumption",()=>{
  const d=workflow("deploy");
  for(const [name,phase] of [["register","register-custody"],["plan","plan"],["apply","apply"]] as const){
    const job=d.jobs[name]!,assume=stepIndex(job,s=>Boolean(s.uses?.startsWith("aws-actions/configure-aws-credentials@")));
    const custody=stepIndex(job,s=>s.run?.trim()===`npm run release:workflow -- ${phase}`);
    const diagnostics=stepIndex(job,s=>s.run?.trim()==="npm run release:workflow -- diagnostics");
    assert.ok(assume<custody,`${name} must assume its role before ${phase}`);assert.ok(custody<diagnostics);assert.equal(diagnostics,job.steps.length-1);
  }
  // register は登録の後に custody を書く。plan の手順は install → assume → plan だけ。
  const register=d.jobs.register!;assert.ok(stepIndex(register,s=>Boolean(s.run?.includes("npm run release:register")))<stepIndex(register,s=>s.run?.trim()==="npm run release:workflow -- register-custody"));
  const plan=d.jobs.plan!,install=stepIndex(plan,s=>Boolean(s.run?.includes("npm ci")));
  assert.deepEqual(plan.steps.slice(install).map(s=>s.uses?.split("@")[0]??s.run?.trim()),["npm install --global npm@11.11.1\nnpm ci","aws-actions/configure-aws-credentials","npm run release:workflow -- plan","npm run release:workflow -- diagnostics"]);
});
void test("custody_location_flows_through_job_outputs",()=>{
  const d=workflow("deploy"),step=(job:string,phase:string)=>d.jobs[job]!.steps.find(s=>s.run?.trim()===`npm run release:workflow -- ${phase}`)!;
  const envOf=(job:string,phase:string)=>({...d.env,...d.jobs[job]!.env,...step(job,phase).env});
  // authorize は reviewed_run の plan job の run_attempt を output に出す。
  const authorize=step("authorize","authorize");assert.ok(authorize.id);assert.equal(d.jobs.authorize!.outputs?.reviewed_attempt,`\${{ steps.${authorize.id}.outputs.reviewed_attempt }}`);
  const register=step("register","register-custody");assert.ok(register.id);
  for(const key of ["custody_run_id","custody_attempt","custody_manifest_sha256"])assert.equal(d.jobs.register!.outputs?.[key],`\${{ steps.${register.id}.outputs.${key} }}`);
  const plan=step("plan","plan");assert.ok(plan.id);assert.deepEqual(Object.keys(d.jobs.plan!.outputs??{}).sort(),["custody_attempt","custody_manifest_sha256","custody_run_id","review_sha256"]);
  for(const key of ["custody_run_id","custody_attempt","custody_manifest_sha256","review_sha256"])assert.equal(d.jobs.plan!.outputs?.[key],`\${{ steps.${plan.id}.outputs.${key} }}`);
  // plan は reviewed_run の有無で、元の preview の置き場所か、同じ run の register の output を読む。
  const planEnv=envOf("plan","plan");
  assert.equal(planEnv.SOURCE_RUN_ID,"${{ inputs.reviewed_run != '' && inputs.reviewed_run || needs.register.outputs.custody_run_id }}");
  assert.equal(planEnv.SOURCE_ATTEMPT,"${{ inputs.reviewed_run != '' && needs.authorize.outputs.reviewed_attempt || needs.register.outputs.custody_attempt }}");
  assert.equal(planEnv.SOURCE_MANIFEST_SHA256,"${{ inputs.reviewed_run != '' && inputs.expected_review_sha256 || needs.register.outputs.custody_manifest_sha256 }}");
  assert.equal(planEnv.RELEASE_SOURCE,undefined);
  // apply は同じ run の plan job の output と、元の preview の置き場所を読む。
  const applyEnv=envOf("apply","apply");assert.deepEqual(d.jobs.apply!.needs,["authorize","plan"]);
  assert.equal(applyEnv.PLAN_CUSTODY_RUN_ID,"${{ needs.plan.outputs.custody_run_id }}");
  assert.equal(applyEnv.PLAN_CUSTODY_ATTEMPT,"${{ needs.plan.outputs.custody_attempt }}");
  assert.equal(applyEnv.PLAN_CUSTODY_MANIFEST_SHA256,"${{ needs.plan.outputs.custody_manifest_sha256 }}");
  assert.equal(applyEnv.REVIEWED_RUN,"${{ inputs.reviewed_run }}");
  assert.equal(applyEnv.REVIEWED_ATTEMPT,"${{ needs.authorize.outputs.reviewed_attempt }}");
  assert.equal(applyEnv.EXPECTED_REVIEW_SHA256,"${{ inputs.expected_review_sha256 }}");
  assert.equal(applyEnv.EXPECTED_CUSTODY_SHA256,undefined);
  // JOB は GHA が設定する GITHUB_JOB を使い、deploy.yml では渡さない。
  const envs=[d.env,...Object.values(d.jobs).flatMap(j=>[j.env,...j.steps.map(s=>s.env)])];
  for(const env of envs){assert.equal(env?.JOB,undefined);assert.equal(env?.GITHUB_JOB,undefined);}
  assert.equal(JSON.stringify(d).includes("custody_sha256"),false);
});
void test("ci_diagnostics_remain_private_only",()=>{
  const ci=workflow("ci"),uploads=Object.values(ci.jobs).flatMap(j=>j.steps).filter(s=>s.uses?.startsWith("actions/upload-artifact@"));
  assert.ok(uploads.length>=1);for(const step of uploads)assert.ok(step.if?.includes("github.event.repository.private == true"));
});
