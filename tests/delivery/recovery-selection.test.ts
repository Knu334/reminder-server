import assert from "node:assert/strict";
import {test} from "node:test";
import {createPlanManifest} from "../../scripts/release/plan-guard";
import {applicationPlan,artifact,baseline} from "../fixtures/synthetic/plans/fixtures";

void test("saved plan refuses cleanup table drift even when API and artifact remain exact",()=>{
 const plan = applicationPlan();
 const input = {account_id:"123456789012",region:"us-east-1",name_prefix:"synthetic",restored_tables:{},reminders_table:"synthetic-production-reminders",owner_state_table:"synthetic-production-owner-state",image_jobs_table:"synthetic-production-image-jobs",images_bucket:"synthetic-123456789012-us-east-1-images",artifact:plan.variables.artifact.value};
 Object.assign(plan.variables,Object.fromEntries(Object.entries(input).map(([k,v])=>[k,{value:v}])));
 for(const fn of plan.resource_changes.filter(r=>r.type==="aws_lambda_function"))Object.assign((fn.change.after.environment as Array<{variables:Record<string,string>}>)[0]!.variables,{REMINDERS_TABLE:input.reminders_table,OWNER_STATE_TABLE:input.owner_state_table,IMAGE_JOBS_TABLE:input.image_jobs_table,IMAGES_BUCKET:input.images_bucket});
 createPlanManifest(plan,Buffer.from("binary"),Buffer.from(JSON.stringify(input)),artifact,artifact.commit,baseline,"application");
 const cleanup=plan.resource_changes.find(r=>r.name==="cleanup")!;
 (cleanup.change.after.environment as Array<{variables:Record<string,string>}>)[0]!.variables.OWNER_STATE_TABLE="foreign-table";
 assert.throws(()=>createPlanManifest(plan,Buffer.from("binary"),Buffer.from(JSON.stringify(input)),artifact,artifact.commit,baseline,"application"));
});

void test("restored selection accepts one complete finite set and rejects partial, original aliases and foreign bucket",async()=>{
 const {requireRuntimeData}=await import("../../scripts/release/runtime-data");
 const input={account_id:"123456789012",region:"us-east-1",name_prefix:"synthetic",restored_tables:{reminders:"recovered-reminders",owner_state:"recovered-owners",image_jobs:"recovered-jobs"},reminders_table:"recovered-reminders",owner_state_table:"recovered-owners",image_jobs_table:"recovered-jobs",images_bucket:"synthetic-123456789012-us-east-1-images"};
 assert.equal(requireRuntimeData(input).owner_state_table,"recovered-owners");
 for(const bad of [{restored_tables:{reminders:"recovered-reminders"}},{restored_tables:{...input.restored_tables,owner_state:"synthetic-production-reminders"}},{restored_tables:{...input.restored_tables,image_jobs:"recovered-owners"}},{images_bucket:"foreign-bucket"},{owner_state_table:"foreign-table"}])assert.throws(()=>requireRuntimeData({...input,...bad}));
});

void test("restored platform manifest retains originals and binds every selected name and ARN",async()=>{
 const {platformPlan,resource}=await import("../fixtures/synthetic/plans/fixtures");
 const selected={reminders:"recovered-reminders",owner_state:"recovered-owners",image_jobs:"recovered-jobs"};
 const inputs={account_id:"123456789012",region:"us-east-1",name_prefix:"synthetic",restored_tables:selected};
 const p=platformPlan();Object.assign(p.variables,Object.fromEntries(Object.entries(inputs).map(([k,v])=>[k,{value:v}])));
 for(const [key,name] of Object.entries(selected)){
  p.resource_changes.push(resource("aws_dynamodb_table",`runtime["${key}"]`,{name:`synthetic-production-${key.replaceAll("_","-")}`,deletion_protection_enabled:true}));
  Object.assign(p.output_changes,{[`${key}_table`]:{after:name,after_unknown:false},[`${key}_table_arn`]:{after:`arn:aws:dynamodb:us-east-1:123456789012:table/${name}`,after_unknown:false}});
 }
 Object.assign(p.output_changes,{restored_tables:{after:selected,after_unknown:false}});
 const check=()=>createPlanManifest(p,Buffer.from("binary"),Buffer.from(JSON.stringify(inputs)),null,artifact.commit,{...baseline,root:"platform"},"platform");
 check();p.resource_changes.at(-1)!.change.actions=["delete","create"];assert.throws(check);
});
