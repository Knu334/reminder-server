import assert from "node:assert/strict";
import {test} from "node:test";
import {mkdtemp,writeFile,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {LambdaClient,GetAliasCommand,GetFunctionCommand} from "@aws-sdk/client-lambda";
import {verifyRelease,verifyMain,type ReleaseAliases} from "../../scripts/release/verify-release";
import {smoke,smokeMain} from "../../scripts/release/smoke";
import {artifact,baseline,runtimeData,dataEnvironment} from "../fixtures/synthetic/plans/fixtures";
const aliases:ReleaseAliases={api:{aliasArn:"arn:aws:lambda:us-east-1:123456789012:function:synthetic-api:production",version:"7"},cleanup:{aliasArn:"arn:aws:lambda:us-east-1:123456789012:function:synthetic-cleanup:production",version:"9"}};
function fake(bad:Record<string,unknown>={},aliasBad:Record<string,unknown>={},cleanupBad:Record<string,unknown>={}){
  const client=new LambdaClient({region:"us-east-1",credentials:{accessKeyId:"synthetic",secretAccessKey:"synthetic"},maxAttempts:1});const calls:unknown[]=[];
  client.send=(async(command:GetAliasCommand|GetFunctionCommand)=>{calls.push(command);const expected=command.input.FunctionName!.endsWith("api")?aliases.api:aliases.cleanup;if(command instanceof GetAliasCommand){assert.equal(command.input.Name,"production");return{AliasArn:expected.aliasArn,FunctionVersion:expected.version,...aliasBad};}assert.ok(command instanceof GetFunctionCommand);assert.equal(command.input.Qualifier,expected.version);return{Configuration:{Version:expected.version,CodeSha256:artifact.sha256Base64,Environment:{Variables:dataEnvironment},...bad,...(command.input.FunctionName!.endsWith("cleanup")?cleanupBad:{})}};}) as LambdaClient["send"];return{client,calls};
}
void test("aliases_must_match_selected_zip_and_published_versions",async()=>{
  const good=fake();await verifyRelease(artifact,aliases,good.client);assert.equal(good.calls.length,4);
  for(const bad of [{CodeSha256:"different"},{CodeSha256:undefined},{Version:"$LATEST"},{Version:"99"}])await assert.rejects(verifyRelease(artifact,aliases,fake(bad).client));
  for(const bad of [{FunctionVersion:"8"},{AliasArn:"wrong"},{RoutingConfig:{AdditionalVersionWeights:{8:0.1}}}])await assert.rejects(verifyRelease(artifact,aliases,fake({},bad).client));
  await assert.rejects(verifyRelease(artifact,{...aliases,api:{...aliases.api,version:"$LATEST"}},fake().client));await assert.rejects(verifyRelease({...artifact,sha256Hex:"22".repeat(32)},aliases,fake().client));
  await assert.rejects(verifyRelease(artifact,{api:aliases.api,cleanup:aliases.api},fake().client));
  await assert.rejects(verifyRelease(artifact,{...aliases,api:{...aliases.api,aliasArn:aliases.api.aliasArn.replace(":production",":other")}},fake().client));
});
void test("smoke_does_not_write_personal_data_and_accepts_status_only_denials",async()=>{
  for(const published of [false,true]){const calls:string[]=[];const fetcher:typeof fetch=async(input,init)=>{const path=new URL(String(input)).pathname;calls.push(path);assert.equal(init?.method,"GET");assert.equal(init?.redirect,"error");assert.equal(init?.body,undefined);assert.equal(init?.headers,undefined);return new Response("private response must not be read",{status:path==="/healthz"?200:path==="/readyz"?(published?200:503):403});};await smoke(baseline.apiBaseUrl,published,fetcher);assert.deepEqual(calls,["/healthz","/readyz","/v2/reminders"]);}
  await assert.rejects(smoke(baseline.apiBaseUrl,true,async()=>new Response("",{status:200})));
  await assert.rejects(smoke("https://evil.example/path",true,async()=>new Response("",{status:200})));
});
void test("readonly_clis_require_expected_hash_and_baseline_before_any_transport",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"release-synthetic-"));try{
    await writeFile(join(dir,"artifact"),JSON.stringify(artifact));await writeFile(join(dir,"baseline"),JSON.stringify(baseline));
    const outputs={runtime_data:{value:runtimeData},api_alias_arn:{value:aliases.api.aliasArn},cleanup_alias_arn:{value:aliases.cleanup.aliasArn},api_version:{value:"7"},cleanup_version:{value:"9"},release_sha256_base64:{value:artifact.sha256Base64}};await writeFile(join(dir,"outputs"),JSON.stringify(outputs));
    const lines:string[]=[];const io={stdout:(s:string)=>lines.push(s),stderr:(s:string)=>lines.push(s)};let clients=0;
    const args=["--artifact",join(dir,"artifact"),"--outputs",join(dir,"outputs"),"--region","us-east-1"];
    assert.equal(await verifyMain(args,io,()=>{clients++;return fake().client;}),0);assert.equal(clients,1);
    await writeFile(join(dir,"outputs"),JSON.stringify({...outputs,release_sha256_base64:{value:"wrong"}}));assert.equal(await verifyMain(args,io,()=>{clients++;return fake().client;}),1);assert.equal(clients,1);
    let fetched=0;const fetcher:typeof fetch=async(input)=>{fetched++;return new Response("",{status:String(input).endsWith("v2/reminders")?401:200});};
    const smokeArgs=["--baseline",join(dir,"baseline"),"--base-url",baseline.apiBaseUrl,"--published","true"];
    assert.equal(await smokeMain(smokeArgs,io,fetcher),0);assert.equal(fetched,3);
    const bad=[...smokeArgs];bad[3]="https://other.example";assert.equal(await smokeMain(bad,io,fetcher),1);assert.equal(fetched,3);
    assert.equal(await smokeMain(["--published","maybe"],io,fetcher),2);assert.ok(!lines.join("").includes(baseline.apiBaseUrl));
  }finally{await rm(dir,{recursive:true,force:true});}
});

void test("release verifies both immutable Lambda environments against reviewed selection",async()=>{
 await verifyRelease(artifact,aliases,fake().client,dataEnvironment);
 await assert.rejects(verifyRelease(artifact,aliases,fake({Environment:{Variables:{...dataEnvironment,IMAGE_JOBS_TABLE:"other"}}}).client,dataEnvironment));
});

void test("immutable cleanup environment drift fails after the API environment passed",async()=>{
 const f=fake({},{},{Environment:{Variables:{...dataEnvironment,OWNER_STATE_TABLE:"stale-original-table"}}});
 await assert.rejects(verifyRelease(artifact,aliases,f.client,dataEnvironment));assert.equal(f.calls.length,4);
});
