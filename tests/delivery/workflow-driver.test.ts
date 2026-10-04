import assert from "node:assert/strict";
import {mkdtemp,readFile,writeFile,rm,stat} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createHash} from "node:crypto";
import {test} from "node:test";
import {artifact,baseline,applicationPlan,platformPlan} from "../fixtures/synthetic/plans/fixtures";
import type {ReleaseManifest} from "../../scripts/release/artifact";
import type {WorkflowContext,CommandRunner,ReleaseServices,WorkflowConfig} from "../../scripts/release/workflow";
async function driver(){let module:typeof import("../../scripts/release/workflow")|undefined;try{module=await import("../../scripts/release/workflow");}catch{ /* missing implementation is an assertion below */ }assert.ok(module,"protected release driver must exist");return module;}
const digest=(s:string)=>createHash("sha256").update(s).digest("hex");
const outputs={api_id:{value:baseline.apiId},api_base_url:{value:baseline.apiBaseUrl},api_alias_arn:{value:"arn:aws:lambda:us-east-1:123456789012:function:synthetic-api:production"},cleanup_alias_arn:{value:"arn:aws:lambda:us-east-1:123456789012:function:synthetic-cleanup:production"},api_version:{value:"2"},cleanup_version:{value:"3"},release_sha256_base64:{value:artifact.sha256Base64}};
const platformOutputs=Object.fromEntries(Object.entries({reminders_table:"synthetic-production-reminders",owner_state_table:"synthetic-production-owner-state",image_jobs_table:"synthetic-production-image-jobs",images_bucket:"synthetic-123456789012-us-east-1-images",api_role_arn:"arn:aws:iam::123456789012:role/synthetic-production-api",cleanup_role_arn:"arn:aws:iam::123456789012:role/synthetic-production-cleanup",api_log_group:"/aws/lambda/synthetic-production-api",cleanup_log_group:"/aws/lambda/synthetic-production-cleanup",gateway_log_group:"/aws/apigateway/synthetic-production-api",cognito_issuer:baseline.cognitoIssuer,cognito_client_id:baseline.cognitoClientId,cognito_auth_base_url:baseline.cognitoAuthBaseUrl,unused_secret:"never copy"}).map(([k,v])=>[k,{value:v}]));
async function fixture(root:"platform"|"application"="application") {
  const d=await driver(),directory=await mkdtemp(join(tmpdir(),"workflow-synthetic-"));
  const context:WorkflowContext={directory,root,commit:artifact.commit,region:"us-east-1",apply:false,expectedReviewSha256:"",published:false,schedulerEnabled:false};
  const inputs={account_id:"123456789012",region:"us-east-1",name_prefix:"synthetic",chrome_origin:"https://synthetic.example",production_api_id:baseline.apiId,cognito_domain_prefix:"synthetic",scheduler_role_arn:"arn:aws:iam::123456789012:role/synthetic-production-scheduler"};
  const config={inputs,baseline:root==="application"?baseline:{...baseline,root:"platform" as const,apiBaseUrl:null,apiId:null},stateBucket:"synthetic-123456789012-us-east-1-state"};
  const source=await mkdtemp(join(tmpdir(),"workflow-source-"));const evidence={audit:'{"metadata":{"vulnerabilities":{"high":0,"critical":0}}}',sbom:'{"bomFormat":"CycloneDX"}',tests:"synthetic passing validation"};
  const registered:ReleaseManifest={commit:artifact.commit,region:context.region,zip:"artifacts/reminder-server.zip",tools:{node:"24.21.0",npm:"11.11.1",esbuild:"0.28.2"},artifact,evidence:{audit:`sha256:${digest(evidence.audit)}`,sbom:`sha256:${digest(evidence.sbom)}`,tests:`sha256:${digest(evidence.tests)}`}};
  for(const [name,text] of Object.entries(evidence))await writeFile(join(source,`${name}.${name==="tests"?"txt":"json"}`),text);await writeFile(join(source,"registered.json"),JSON.stringify(registered));
  const plan=root==="application"?applicationPlan():platformPlan();const commands:string[][]=[];let headCount=0,verifyCount=0,smokeCount=0;
  const run:CommandRunner=async(command,args)=>{commands.push([command,...args]);if(command==="git")return artifact.commit+"\n";const mode=args[1];if(mode==="plan"){const path=args.find(a=>a.startsWith("-out="))!.slice(5);await writeFile(path,"saved immutable binary");const vars=JSON.parse(await readFile(join(directory,"inputs.json"),"utf8"));for(const [key,value] of Object.entries(vars))if(!(key in plan.variables))(plan.variables as Record<string,{value:unknown}>)[key]={value};return "private stdout must not leak";}if(mode==="show"){assert.equal(args[2],"-json");assert.equal(args[3],join(directory,"saved.tfplan"));assert.equal(await readFile(args[3],"utf8"),"saved immutable binary");return JSON.stringify(plan);}if(mode==="output")return JSON.stringify(args[0]?.includes("platform")?platformOutputs:outputs);return "";};
  const services:ReleaseServices={run,head:async(a,region)=>{assert.deepEqual(a,artifact);assert.equal(region,"us-east-1");headCount++;},verify:async(a,o,region)=>{assert.deepEqual(a,artifact);assert.deepEqual(o,outputs);assert.equal(region,"us-east-1");verifyCount++;},smoke:async(b,p)=>{assert.deepEqual(b,baseline);assert.equal(p,false);smokeCount++;}};
  // Record the outbound plan-job digest independently at the transfer boundary.
  const transferredDriver={...d,planRelease:async(c:WorkflowContext,cfg:WorkflowConfig,src:string|undefined,svc:ReleaseServices)=>{const review=await d.planRelease(c,cfg,src,svc);c.expectedCustodySha256=digest(await readFile(join(c.directory,"custody.json"),"utf8"));return review;}};
  return {d:transferredDriver,directory,context,config,source,registered,plan,commands,services,counts:()=>({headCount,verifyCount,smokeCount}),cleanup:async()=>{await rm(directory,{recursive:true,force:true});await rm(source,{recursive:true,force:true});}};
}
void test("dispatch_rejects_public_pr_nonmain_unreviewed_apply_before_aws",async()=>{
  const d=await driver();const good={privateRepository:true,event:"workflow_dispatch",ref:"refs/heads/main",commit:artifact.commit,head:artifact.commit,mainContainsCommit:true,apply:false,reviewedRun:"",expectedReviewSha256:"",root:"platform"};
  d.authorizeDispatch(good);for(const bad of [{privateRepository:false},{event:"pull_request"},{ref:"refs/heads/topic"},{head:"b".repeat(40)},{mainContainsCommit:false},{commit:"main"},{apply:true},{apply:true,reviewedRun:"12",expectedReviewSha256:"bad"},{root:"bootstrap"}])assert.throws(()=>d.authorizeDispatch({...good,...bad}));
});
void test("application_plan_derives_json_from_saved_binary_and_transfers_only_allowed_outputs",async()=>{
  const f=await fixture();try{const sha=await f.d.planRelease(f.context,f.config,f.source,f.services);assert.match(sha,/^[0-9a-f]{64}$/);assert.equal(f.counts().headCount,1);assert.equal(f.commands.filter(c=>c[2]==="plan").length,1);const input=JSON.parse(await readFile(join(f.directory,"inputs.json"),"utf8"));assert.equal(input.operator_api_seed,false);assert.equal(input.production_api_id,baseline.apiId);assert.equal(input.cognito_client_id,baseline.cognitoClientId);assert.equal(input.unused_secret,undefined);assert.equal(input.artifact.version_id,artifact.versionId);for(const p of [f.directory,join(f.directory,"inputs.json"),join(f.directory,"saved.tfplan"),join(f.directory,"review.json")])assert.equal((await stat(p)).mode&0o777,p===f.directory?0o700:0o600);}finally{await f.cleanup();}
});
void test("apply_consumes_same_saved_binary_then_checks_aliases_smoke_and_safe_ledger",async()=>{
  const f=await fixture();try{const sha=await f.d.planRelease(f.context,f.config,f.source,f.services);const ledger=await f.d.applyRelease({...f.context,apply:true,expectedReviewSha256:sha},f.services);assert.deepEqual(f.counts(),{headCount:2,verifyCount:1,smokeCount:1});assert.equal(f.commands.filter(c=>c[2]==="plan").length,1);const apply=f.commands.find(c=>c[2]==="apply")!;assert.ok(apply.includes(join(f.directory,"saved.tfplan")));assert.ok(apply.includes("-lock-timeout=5m"));assert.equal(ledger.commit,artifact.commit);assert.equal(ledger.result,"verified");assert.ok(!JSON.stringify(ledger).includes(baseline.cognitoIssuer));}finally{await f.cleanup();}
});
void test("apply_rejects_changed_binary_inputs_commit_baseline_artifact_and_forged_plan_json",async()=>{
  for(const file of ["saved.tfplan","inputs.json","baseline.json","artifact.json"]){const f=await fixture();try{const sha=await f.d.planRelease(f.context,f.config,f.source,f.services);await writeFile(join(f.directory,file),file==="saved.tfplan"?"tampered":"{}");await assert.rejects(f.d.applyRelease({...f.context,apply:true,expectedReviewSha256:sha},f.services));assert.equal(f.commands.some(c=>c[2]==="apply"),false);}finally{await f.cleanup();}}
  const f=await fixture();try{const sha=await f.d.planRelease(f.context,f.config,f.source,f.services);await writeFile(join(f.directory,"plan.json"),JSON.stringify({forged:true}));await assert.rejects(f.d.applyRelease({...f.context,commit:"b".repeat(40),apply:true,expectedReviewSha256:sha},f.services));assert.equal(f.commands.some(c=>c[2]==="apply"),false);await f.d.applyRelease({...f.context,apply:true,expectedReviewSha256:sha},f.services);assert.equal(JSON.parse(await readFile(join(f.directory,"plan.json"),"utf8")).format_version,"1.2");}finally{await f.cleanup();}
});
void test("reviewed_hash_mismatch_and_head_failure_stop_before_apply",async()=>{
  for(const failHead of [false,true]){const f=await fixture();try{const sha=await f.d.planRelease(f.context,f.config,f.source,f.services);await assert.rejects(f.d.applyRelease({...f.context,apply:true,expectedReviewSha256:failHead?sha:"f".repeat(64)},{...f.services,head:async()=>{throw Error("server artifact mismatch");}}));assert.equal(f.commands.some(c=>c[2]==="apply"),false);}finally{await f.cleanup();}}
});
void test("normal_application_rejects_seed_missing_baseline_and_artifact_evidence_changes",async()=>{
  for(const bad of ["seed","baseline","evidence","version"]){const f=await fixture();try{if(bad==="evidence")await writeFile(join(f.source,"tests.txt"),"tampered");if(bad==="version")await writeFile(join(f.source,"registered.json"),JSON.stringify({...f.registered,artifact:{...artifact,commit:"b".repeat(40)}}));await assert.rejects(f.d.planRelease(f.context,{...f.config,inputs:{...f.config.inputs,...(bad==="seed"?{operator_api_seed:true}:{})},baseline:bad==="baseline"?null:f.config.baseline},f.source,f.services));assert.equal(f.commands.some(c=>c[2]==="plan"),false);}finally{await f.cleanup();}}
});
void test("apply_run_requires_identical_preview_inputs_and_selected_version_without_registration",async()=>{
  const f=await fixture();const next=await mkdtemp(join(tmpdir(),"workflow-next-"));try{const sha=await f.d.planRelease(f.context,f.config,f.source,f.services);const nextContext={...f.context,directory:next,apply:true,expectedReviewSha256:sha};await assert.rejects(f.d.planRelease(nextContext,{...f.config,inputs:{...f.config.inputs,chrome_origin:"https://changed.example"}},f.directory,f.services));assert.equal(f.commands.filter(c=>c[2]==="plan").length,1);}finally{await rm(next,{recursive:true,force:true});await f.cleanup();}
});
void test("platform_needs_no_zip_and_checks_known_identity_after_initial_creation",async()=>{
  const f=await fixture("platform");try{for(const r of f.plan.resource_changes){r.change.actions=["create"];r.change.before=null as unknown as Record<string,unknown>;r.change.after_unknown={id:true};}for(const o of Object.values(f.plan.output_changes))o.after_unknown=true;
    const sha=await f.d.planRelease(f.context,{...f.config,baseline:null},undefined,f.services);assert.equal(f.counts().headCount,0);
    const state={values:{root_module:{resources:[{type:"aws_cognito_user_pool",name:"production",values:{id:"us-east-1_Synthetic"}},{type:"aws_cognito_user_pool_client",name:"chrome",values:{id:baseline.cognitoClientId,user_pool_id:"us-east-1_Synthetic"}},{type:"aws_cognito_user_pool_domain",name:"production",values:{domain:"synthetic",user_pool_id:"us-east-1_Synthetic"}}]}}};
    const services={...f.services,run:async(c:string,a:string[])=>a[1]==="show"&&a.length===3?JSON.stringify(state):f.services.run(c,a)};
    await f.d.applyRelease({...f.context,apply:true,expectedReviewSha256:sha},services);assert.equal(f.counts().verifyCount,0);const known=JSON.parse(await readFile(join(f.directory,"post-baseline.json"),"utf8"));assert.equal(known.root,"platform");assert.equal(known.cognitoClientId,baseline.cognitoClientId);
  }finally{await f.cleanup();}
});
void test("post_apply_identity_alias_or_smoke_failure_never_produces_success_ledger",async()=>{
  for(const failure of ["identity","alias","smoke"]){const f=await fixture();try{const sha=await f.d.planRelease(f.context,f.config,f.source,f.services);const services={...f.services,...(failure==="identity"?{run:async(c:string,a:string[])=>a[1]==="output"?JSON.stringify({...outputs,api_id:{value:"wrong"}}):f.services.run(c,a)}:failure==="alias"?{verify:async()=>{throw Error("alias mismatch");}}:{smoke:async()=>{throw Error("unavailable");}})};await assert.rejects(f.d.applyRelease({...f.context,apply:true,expectedReviewSha256:sha},services));await assert.rejects(readFile(join(f.directory,"ledger.json")));}finally{await f.cleanup();}}
});

void test("reviewed_run_metadata_rejects_foreign_public_push_nonmain_or_failed_custody",async()=>{
  const d=await driver();assert.ok("verifyReviewedRunMetadata" in d,"reviewed run validator required");const verify=(d as unknown as {verifyReviewedRunMetadata:(r:unknown,repo:string)=>void}).verifyReviewedRunMetadata;
  const good={event:"workflow_dispatch",head_branch:"main",path:".github/workflows/deploy.yml",conclusion:"success",status:"completed",head_repository:{full_name:"synthetic/reminder",private:true}};verify(good,"synthetic/reminder");
  for(const bad of [{event:"push"},{head_branch:"feature"},{path:".github/workflows/ci.yml"},{conclusion:"failure"},{status:"in_progress"},{head_repository:{full_name:"foreign/reminder",private:true}},{head_repository:{full_name:"synthetic/reminder",private:false}}])assert.throws(()=>verify({...good,...bad},"synthetic/reminder"));
});
void test("reused_preview_can_plan_and_apply_without_build_and_refuses_apply_run_as_preview",async()=>{
  const first=await fixture(),next=await fixture();try{const sha=await first.d.planRelease(first.context,first.config,first.source,first.services);const c={...next.context,apply:true,expectedReviewSha256:sha};const digest=await next.d.planRelease(c,next.config,first.directory,next.services);assert.equal(digest,sha);await next.d.applyRelease(c,next.services);assert.equal(next.commands.filter(c=>c[2]==="plan").length,1);assert.equal(next.commands.some(c=>/build|package|register/.test(c.join(" "))),false);
    const third=await fixture();try{await assert.rejects(third.d.planRelease({...third.context,apply:true,expectedReviewSha256:sha},third.config,next.directory,third.services));assert.equal(third.commands.some(c=>c[2]==="plan"),false);}finally{await third.cleanup();}
  }finally{await first.cleanup();await next.cleanup();}
});
void test("changed_transfer_digest_derived_show_and_initial_platform_output_mismatch_stop_success",async()=>{
  const f=await fixture();try{const sha=await f.d.planRelease(f.context,f.config,f.source,f.services);await assert.rejects(f.d.applyRelease({...f.context,apply:true,expectedReviewSha256:sha,expectedCustodySha256:"f".repeat(64)},f.services));assert.equal(f.commands.some(c=>c[2]==="apply"),false);
    const changed=applicationPlan();changed.output_changes.api_id.after="bad";await assert.rejects(f.d.applyRelease({...f.context,apply:true,expectedReviewSha256:sha},{...f.services,run:async(c,a)=>a[1]==="show"?JSON.stringify(changed):f.services.run(c,a)}));assert.equal(f.commands.some(c=>c[2]==="apply"),false);
  }finally{await f.cleanup();}
  const p=await fixture("platform");try{for(const r of p.plan.resource_changes){r.change.actions=["create"];r.change.before=null as unknown as Record<string,unknown>;r.change.after_unknown={id:true};}for(const o of Object.values(p.plan.output_changes))o.after_unknown=true;const sha=await p.d.planRelease(p.context,{...p.config,baseline:null},undefined,p.services);await assert.rejects(p.d.applyRelease({...p.context,apply:true,expectedReviewSha256:sha},{...p.services,run:async(c,a)=>a[1]==="show"&&a.length===3?JSON.stringify({values:{root_module:{resources:[]}}}):p.services.run(c,a)}));await assert.rejects(readFile(join(p.directory,"ledger.json")));}finally{await p.cleanup();}
});

void test("existing_zip_preview_can_review_new_scheduler_settings_without_registration",async()=>{
  const original=await fixture(),next=await fixture();try{const before=await original.d.planRelease(original.context,original.config,original.source,original.services);const after=await next.d.planRelease({...next.context,schedulerEnabled:true},next.config,original.directory,next.services);assert.notEqual(after,before);assert.equal(JSON.parse(await readFile(join(next.directory,"inputs.json"),"utf8")).scheduler_enabled,true);assert.equal(next.counts().headCount,1);assert.equal(next.commands.some(c=>/build|package|register/.test(c.join(" "))),false);}finally{await original.cleanup();await next.cleanup();}
});

void test("apply_requires_the_external_plan_job_custody_digest",async()=>{
  const f=await fixture();try{const sha=await f.d.planRelease(f.context,f.config,f.source,f.services);const c={...f.context,apply:true,expectedReviewSha256:sha};delete c.expectedCustodySha256;await assert.rejects(f.d.applyRelease(c,f.services));assert.equal(f.commands.some(c=>c[2]==="apply"),false);}finally{await f.cleanup();}
});
