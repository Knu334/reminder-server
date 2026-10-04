import assert from "node:assert/strict";
import {mkdtemp,readFile,rm,stat,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {test} from "node:test";
import {inspectPlan,reviewPlanSha256,createPlanManifest,verifySavedPlan,verifyPostApplyBaseline,planGuardMain} from "../../scripts/release/plan-guard";
import {applicationPlan,platformPlan,baseline,artifact} from "../fixtures/synthetic/plans/fixtures";
const platformBaseline={...baseline,root:"platform" as const};
void test("blocks_delete_replace_or_removed_protected_resource",()=>{
  for(const actions of [["delete"],["delete","create"],["create","delete"]]) for(const make of [applicationPlan,platformPlan]) {
    const plan=make();plan.resource_changes[0]!.change.actions=actions;plan.resource_changes[0]!.address="module.moved.resource";
    assert.equal(inspectPlan(plan,make===applicationPlan?baseline:platformBaseline).allowed,false);
  }
  const plan=applicationPlan();plan.resource_changes.splice(1,1);assert.equal(inspectPlan(plan,baseline).allowed,false);
});
void test("preserves_moved_import_and_noop_identity",()=>{
  for(const actions of [["no-op"],["update"]]) {const plan=applicationPlan();plan.resource_changes[0]!.address="module.moved.aws_apigatewayv2_api.production";plan.resource_changes[0]!.change.actions=actions;assert.equal(inspectPlan(plan,baseline).allowed,true);}
  const plan={...applicationPlan(),resource_changes:applicationPlan().resource_changes.map(r=>({...r,change:{...r.change,importing:{id:r.change.before.id}}}))};assert.equal(inspectPlan(plan,baseline).allowed,true);
});
void test("blocks_changed_or_unknown_existing_url_and_auth",()=>{
  const plan=applicationPlan();plan.output_changes.api_base_url.after_unknown=true;assert.equal(inspectPlan(plan,baseline).allowed,false);
  const changed=applicationPlan();changed.variables.cognito_issuer.value+="other";assert.equal(inspectPlan(changed,baseline).allowed,false);
  const p=platformPlan();p.output_changes.cognito_client_id.after="different";assert.equal(inspectPlan(p,platformBaseline).allowed,false);
  for(const mutate of [(p:ReturnType<typeof applicationPlan>)=>{p.resource_changes[0]!.change.actions=["create"];},(p:ReturnType<typeof applicationPlan>)=>{p.variables.operator_api_seed.value=true;},(p:ReturnType<typeof applicationPlan>)=>{p.variables.production_api_id.value="different";}]){const p=applicationPlan();mutate(p);assert.equal(inspectPlan(p,baseline).allowed,false);}
});
void test("allows_first_creation_but_requires_verified_post_apply_url",()=>{
  const p=applicationPlan();for(const r of p.resource_changes){r.change.actions=["create"];r.change.before=null as unknown as Record<string,unknown>;r.change.after_unknown={id:true};}
  p.output_changes.api_id.after_unknown=true;p.output_changes.api_base_url.after_unknown=true;assert.equal(inspectPlan(p,null).allowed,true);
  assert.throws(()=>verifyPostApplyBaseline({api_id:{value:null},api_base_url:{value:baseline.apiBaseUrl}},baseline));
  verifyPostApplyBaseline({api_id:{value:baseline.apiId},api_base_url:{value:baseline.apiBaseUrl}},baseline);
});
void test("blocks_signup_or_longer_access_token_and_auth_reopening",()=>{
  const mutations=[(p:ReturnType<typeof platformPlan>)=>{p.resource_changes[0]!.change.after.admin_create_user_config=[{allow_admin_create_user_only:false}];},...[
    {access_token_validity:6},{token_validity_units:[{access_token:"hours",id_token:"minutes",refresh_token:"days"}]},{explicit_auth_flows:[]},{explicit_auth_flows:["ALLOW_USER_SRP_AUTH"]},{explicit_auth_flows:undefined},{allowed_oauth_scopes:["openid","reminder-api/read"]},{allowed_oauth_scopes:["openid","reminder-api/read","reminder-api/write","aws.cognito.signin.user.admin"]},
  ].map(bad=>(p:ReturnType<typeof platformPlan>)=>Object.assign(p.resource_changes[1]!.change.after,bad)),(p:ReturnType<typeof platformPlan>)=>{p.resource_changes[1]!.change.after_unknown={allowed_oauth_scopes:true};}];
  assert.equal(inspectPlan(platformPlan(),platformBaseline).allowed,true);for(const mutate of mutations){const p=platformPlan();mutate(p);assert.equal(inspectPlan(p,platformBaseline).allowed,false);}
});
void test("review_digest_removes_only_root_timestamp_and_keeps_array_order",()=>{
  const a=applicationPlan(),b=applicationPlan();b.timestamp="other";assert.equal(reviewPlanSha256(a),reviewPlanSha256(b));
  assert.equal(reviewPlanSha256({b:2,a:1}),"43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777");
  assert.notEqual(reviewPlanSha256({nested:{timestamp:"a"}}),reviewPlanSha256({nested:{timestamp:"b"}}));assert.notEqual(reviewPlanSha256([1,2]),reviewPlanSha256([2,1]));
  assert.throws(()=>reviewPlanSha256({x:undefined}));assert.equal(inspectPlan({resource_changes:"bad"},baseline).allowed,false);
});
void test("saved_plan_binds_binary_commit_inputs_and_artifact_separately",()=>{
  const p=applicationPlan(),inputs=Buffer.from(JSON.stringify({operator_api_seed:false,production_api_id:baseline.apiId,artifact:applicationPlan().variables.artifact.value})),binary=Buffer.from("synthetic saved plan");
  const m=createPlanManifest(p,binary,inputs,artifact,artifact.commit,baseline,"application");verifySavedPlan(m,p,binary,inputs,artifact,artifact.commit,baseline,"application");
  for(const changed of [{binary:Buffer.from("changed")},{inputs:Buffer.from("{}")},{commit:"b".repeat(40)},{artifact:{...artifact,versionId:"different"}},{baseline:{...baseline,apiId:"xyz123def4"}},{plan:{...p,unknown_extra:"changed"}}]){
    assert.throws(()=>verifySavedPlan(m,changed.plan??p,changed.binary??binary,changed.inputs??inputs,changed.artifact??artifact,changed.commit??artifact.commit,changed.baseline??baseline,"application"));
  }
  const wrong=applicationPlan();wrong.variables.artifact.value.version_id="wrong";assert.throws(()=>createPlanManifest(wrong,binary,inputs,artifact,artifact.commit,baseline,"application"));
});
void test("plan_cli_writes_private_manifest_and_rechecks_without_leaking_inputs",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"guard-synthetic-"));try{
    const files={"plan-json":applicationPlan(),inputs:{operator_api_seed:false,production_api_id:baseline.apiId,artifact:applicationPlan().variables.artifact.value},artifact,baseline};for(const [name,value] of Object.entries(files))await writeFile(join(dir,name),JSON.stringify(value));await writeFile(join(dir,"plan"),"binary");
    const args=["root",...Object.keys(files),"plan","manifest","commit"].flatMap(key=>[`--${key}`,key==="root"?"application":key==="commit"?artifact.commit:join(dir,key)]);const lines:string[]=[];const io={stdout:(s:string)=>lines.push(s),stderr:(s:string)=>lines.push(s)};
    assert.equal(await planGuardMain(["--mode","review",...args],io),0);assert.equal((await stat(join(dir,"manifest"))).mode&0o777,0o600);assert.ok(JSON.parse(await readFile(join(dir,"manifest"),"utf8")).reviewSha256);
    assert.equal(await planGuardMain(["--mode","check",...args],io),0);await writeFile(join(dir,"plan"),"changed");assert.equal(await planGuardMain(["--mode","check",...args],io),1);assert.ok(!lines.join("").includes(baseline.cognitoIssuer));assert.ok(!lines.join("").includes(artifact.versionId));
  }finally{await rm(dir,{recursive:true,force:true});}
});

void test("root_context_allows_platform_before_api_or_artifact_but_closes_application",()=>{
  const platform={...platformBaseline,apiId:null,apiBaseUrl:null};assert.equal(inspectPlan(platformPlan(),platform).allowed,true);
  const inputs=Buffer.from("{}"),binary=Buffer.from("synthetic");
  const p=platformPlan();for(const r of p.resource_changes){r.change.actions=["create"];r.change.before=null as unknown as Record<string,unknown>;r.change.after_unknown={id:true};}
  for(const out of Object.values(p.output_changes))out.after_unknown=true;
  const m=createPlanManifest(p,binary,inputs,null,artifact.commit,null,"platform");verifySavedPlan(m,p,binary,inputs,null,artifact.commit,null,"platform");
  assert.throws(()=>createPlanManifest(applicationPlan(),binary,inputs,null,artifact.commit,null,"application"));
  assert.throws(()=>createPlanManifest(applicationPlan(),binary,inputs,artifact,artifact.commit,platformBaseline,"application"));
  assert.throws(()=>createPlanManifest(platformPlan(),binary,inputs,null,artifact.commit,null,"application"));
});
void test("first_normal_application_allows_stage_creation_after_api_seed",()=>{
  const p=applicationPlan();const stage=p.resource_changes[1]!;stage.change.actions=["create"];stage.change.before=null as unknown as Record<string,unknown>;stage.change.after_unknown={id:true};delete stage.change.after.id;
  assert.equal(inspectPlan(p,baseline).allowed,true);
  stage.change.after.api_id="changed";assert.equal(inspectPlan(p,baseline).allowed,false);
  stage.change.after.api_id=baseline.apiId;stage.change.after.name="different";assert.equal(inspectPlan(p,baseline).allowed,false);
  stage.change.after.name="$default";for(const actions of [["delete","create"],["create","delete"]]){stage.change.actions=actions;assert.equal(inspectPlan(p,baseline).allowed,false);}
});
void test("null_platform_review_cannot_adopt_existing_identity_without_baseline",()=>{
  assert.throws(()=>createPlanManifest(platformPlan(),Buffer.from("binary"),Buffer.from("{}"),null,artifact.commit,null,"platform"));
});
void test("review_digest_rejects_non_json_root_values",()=>{
  assert.throws(()=>reviewPlanSha256(new Date()));assert.throws(()=>reviewPlanSha256(Number.NaN));
});
void test("protects_actual_gateway_authorizer_and_v2_route_scopes",()=>{
  for(const bad of [{jwt_configuration:[{issuer:"https://evil.example",audience:[baseline.cognitoClientId]}]},{jwt_configuration:[{issuer:baseline.cognitoIssuer,audience:["wrong"]}]},{authorizer_type:"REQUEST"}]){const p=applicationPlan();Object.assign(p.resource_changes[2]!.change.after,bad);assert.equal(inspectPlan(p,baseline).allowed,false);}
  for(const bad of [{authorization_type:"NONE"},{authorization_scopes:[]},{authorization_scopes:["reminder-api/write"]},{authorizer_id:"wrong"}]){const p=applicationPlan();Object.assign(p.resource_changes[3]!.change.after,bad);assert.equal(inspectPlan(p,baseline).allowed,false);}
  const unknown=applicationPlan();unknown.resource_changes[2]!.change.after_unknown={jwt_configuration:[{issuer:true}]};assert.equal(inspectPlan(unknown,baseline).allowed,false);
  const removed=applicationPlan();removed.resource_changes.splice(3,1);assert.equal(inspectPlan(removed,baseline).allowed,false);
  const first=applicationPlan();for(const r of first.resource_changes.slice(1)){r.change.actions=["create"];r.change.before=null as unknown as Record<string,unknown>;r.change.after_unknown=r.type==="aws_apigatewayv2_route"?{id:true,authorizer_id:true}:{id:true};delete r.change.after.id;if(r.type==="aws_apigatewayv2_route")delete r.change.after.authorizer_id;}assert.equal(inspectPlan(first,baseline).allowed,true);
});
void test("protects_literal_api_runtime_auth_and_both_lambda_artifact_inputs",()=>{
  for(const field of ["COGNITO_ISSUER","COGNITO_CLIENT_ID","EXPECTED_API_ID","EXPECTED_API_STAGE"]){const p=applicationPlan();const api=p.resource_changes.find(r=>r.type==="aws_lambda_function"&&r.name==="api")!;const env=api.change.after.environment as Array<{variables:Record<string,string>}>;env[0]!.variables[field]="wrong";assert.equal(inspectPlan(p,baseline).allowed,false);}
  for(const unknown of [{environment:[{variables:{COGNITO_ISSUER:true}}]},{environment:[{variables:true}]},{environment:true}]){const p=applicationPlan();p.resource_changes.find(r=>r.type==="aws_lambda_function"&&r.name==="api")!.change.after_unknown=unknown;assert.equal(inspectPlan(p,baseline).allowed,false);}
  const binary=Buffer.from("binary"),inputs=Buffer.from(JSON.stringify({artifact:applicationPlan().variables.artifact.value}));
  for(const name of ["api","cleanup"]){const p=applicationPlan();p.resource_changes.find(r=>r.type==="aws_lambda_function"&&r.name===name)!.change.after.s3_object_version="wrong";assert.throws(()=>createPlanManifest(p,binary,inputs,artifact,artifact.commit,baseline,"application"));}
});
