import assert from "node:assert/strict";
import {readFileSync,existsSync,readdirSync} from "node:fs";
import {test} from "node:test";
import {Script} from "node:vm";
import {parseDocument} from "yaml";
interface Step {uses?:string;run?:string;if?:string;with?:Record<string,unknown>;env?:Record<string,string>}
interface Job {permissions?:Record<string,string>;if?:string;needs?:string[]|string;environment?:string;steps:Step[]}
interface Workflow {on:Record<string,unknown>;permissions:Record<string,string>;concurrency?:{group:string;"cancel-in-progress":boolean};jobs:Record<string,Job>}
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
  for(const command of ["npm ci","typecheck","lint","test:runtime","test:operations","test:packaging","test:delivery","infra:check","audit:runtime","audit:all","sbom",".devcontainer"])assert.ok(runs.includes(command),`CI must run ${command}`);
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
  for(const name of ["ci","deploy"]){const w=workflow(name);for(const job of Object.values(w.jobs))for(const s of job.steps)if(s.uses)assert.match(s.uses,/@[0-9a-f]{40}$/);}
  const d=workflow("deploy");assert.equal(d.concurrency?.["cancel-in-progress"],false);assert.equal(d.concurrency?.group,"reminder-production");assert.deepEqual(d.permissions,{contents:"read"});
  const roleVars:string[]=[];for(const [name,job] of Object.entries(d.jobs)){const aws=job.steps.filter(s=>s.uses?.startsWith("aws-actions/"));assert.equal(job.permissions?.["id-token"]==="write",aws.length>0);if(aws.length){assert.ok(["register","plan","apply"].includes(name));assert.equal(aws.length,1);roleVars.push(String(aws[0]!.with?.["role-to-assume"]));assert.equal(aws[0]!.with?.["aws-access-key-id"],undefined);assert.ok(job.if?.includes("needs.authorize.result == 'success'"));}}
  assert.equal(new Set(roleVars).size,3);
});
void test("private_custody_before_oidc_and_one_day_transfer",()=>{
  const d=workflow("deploy");assert.ok(d.jobs.authorize?.if?.includes("github.event.repository.private == true"));assert.ok(d.jobs.authorize?.if?.includes("github.ref == 'refs/heads/main'"));
  let uploads=0;for(const job of Object.values(d.jobs))for(const step of job.steps){if(step.uses?.startsWith("actions/upload-artifact@")){uploads++;assert.equal(step.with?.["retention-days"],1);assert.equal(step.with?.["if-no-files-found"],"error");assert.equal(step.with?.["include-hidden-files"],false);assert.ok(String(step.with?.path).startsWith("${{ runner.temp }}"));}if(step.run){assert.ok(!/terraform .*show.*-json/.test(step.run));assert.ok(!/AWS_(ACCESS_KEY_ID|SECRET_ACCESS_KEY)\s*:/.test(step.run));}}
  assert.ok(uploads>=2);
});
void test("maintenance_or_user_admin_workflow_absent",()=>{
  assert.deepEqual(readdirSync(".github/workflows").filter(f=>/\.ya?ml$/.test(f)).sort(),["ci.yml","deploy.yml"]);
  for(const name of ["ci","deploy"]){const w=workflow(name);assert.ok(!/Admin(Create|Delete|Initiate|Respond)|migrate:json|recovery:verify|maintenance|docker compose/i.test(JSON.stringify(w)));}
  const dep=parseDocument(readFileSync(".github/dependabot.yml","utf8")).toJS() as {updates:Array<{"package-ecosystem":string;directory:string;schedule:{interval:string}}>};assert.deepEqual(dep.updates.map(u=>u["package-ecosystem"]).sort(),["github-actions","npm","terraform","terraform","terraform"]);for(const u of dep.updates){assert.equal(u.schedule.interval,"weekly");assert.ok(!u.directory.includes(".devcontainer"));}
});
