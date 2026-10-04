import {createHash} from "node:crypto";
import {readFile,writeFile} from "node:fs/promises";
import {resolve} from "node:path";
import {z} from "zod";
import type {RegisteredArtifact} from "./artifact";

export type ReleaseRoot = "platform" | "application";
export interface ReleaseBaseline {
  root: ReleaseRoot;
  apiBaseUrl: string | null;
  apiId: string | null;
  cognitoIssuer: string;
  cognitoClientId: string;
  cognitoAuthBaseUrl: string;
}
export interface PlanReview {allowed:boolean;violations:Array<{address:string;code:string}>}
export interface PrivatePlanManifest {
  schemaVersion:1;root:ReleaseRoot;commit:string;binarySha256:string;reviewSha256:string;
  inputSha256:string;artifact:RegisteredArtifact|null;baseline:ReleaseBaseline|null;
}
export interface ReleaseIO {stdout(line:string):void;stderr(line:string):void}
const commitSchema=z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const text=z.string().min(1).refine(v=>v.trim()===v&&!Array.from(v).some(c=>c.charCodeAt(0)<=32||c.charCodeAt(0)===127));
const rootSchema=z.enum(["platform","application"]);
const baselineSchema=z.strictObject({root:rootSchema,apiBaseUrl:z.string().nullable(),apiId:z.string().nullable(),cognitoIssuer:z.string().regex(/^https:\/\/cognito-idp\.[a-z0-9-]+\.amazonaws\.com\/[a-z0-9-]+_[A-Za-z0-9]+$/),cognitoClientId:z.string().regex(/^[a-z0-9]{1,128}$/),cognitoAuthBaseUrl:z.string().regex(/^https:\/\/[a-z0-9-]+\.auth\.[a-z0-9-]+\.amazoncognito\.com$/)}).superRefine((b,c)=>{
  if(b.root==="application"||b.apiId!==null||b.apiBaseUrl!==null) {
    if(!b.apiId||!b.apiBaseUrl||!/^[a-z0-9]{10}$/.test(b.apiId)||!new RegExp(`^https://${b.apiId}\\.execute-api\\.[a-z0-9-]+\\.amazonaws\\.com$`).test(b.apiBaseUrl))c.addIssue({code:"custom",message:"Unknown or inconsistent API identity"});
  }
});
const artifactSchema=z.strictObject({sha256Hex:z.string().regex(/^[0-9a-f]{64}$/),sha256Base64:z.string().regex(/^[A-Za-z0-9+/]{43}=$/),compressedBytes:z.number().int().positive().lt(50_000_000),unpackedBytes:z.number().int().positive().lt(250_000_000),bucket:text,key:text,versionId:text.refine(v=>v!=="null"),commit:commitSchema});
export function validateRegisteredArtifact(input:unknown):RegisteredArtifact {
  const a=artifactSchema.parse(input);
  if(Buffer.from(a.sha256Hex,"hex").toString("base64")!==a.sha256Base64||a.key!==`releases/${a.sha256Hex}/reminder-server.zip`)throw new Error("Artifact identity mismatch");return a;
}
function canonical(value:unknown,ancestors=new Set<object>()):string {
  if(value===null||typeof value==="string"||typeof value==="boolean")return JSON.stringify(value);
  if(typeof value==="number"&&Number.isFinite(value))return JSON.stringify(value);
  if(typeof value!=="object"||ancestors.has(value))throw new Error("Invalid JSON value");
  ancestors.add(value);let result:string;
  if(Array.isArray(value)) {if(Object.keys(value).length!==value.length)throw new Error("Invalid JSON array");result=`[${value.map(v=>canonical(v,ancestors)).join(",")}]`;}
  else {if(Object.getPrototypeOf(value)!==Object.prototype&&Object.getPrototypeOf(value)!==null)throw new Error("Invalid JSON object");const obj=value as Record<string,unknown>;result=`{${Object.keys(obj).sort().map(k=>`${JSON.stringify(k)}:${canonical(obj[k],ancestors)}`).join(",")}}`;}
  ancestors.delete(value);return result;
}
const digest=(bytes:string|Uint8Array)=>createHash("sha256").update(bytes).digest("hex");
/** Only Terraform's root timestamp is excluded; arrays and every other JSON field are bound. */
export function reviewPlanSha256(plan:unknown):string {
  canonical(plan);
  if(plan!==null&&typeof plan==="object"&&!Array.isArray(plan)){const copy={...plan};delete (copy as Record<string,unknown>).timestamp;return digest(canonical(copy));}return digest(canonical(plan));
}
const object=z.record(z.string(),z.unknown());
const changeSchema=z.looseObject({actions:z.array(z.enum(["no-op","create","read","update","delete","forget"])).min(1),before:object.nullable(),after:object.nullable(),after_unknown:object});
// for_each addresses contain quoted route keys, including printable spaces.
const addressSchema=z.string().min(1).refine(v=>!Array.from(v).some(c=>c.charCodeAt(0)<32||c.charCodeAt(0)===127));
const resourceSchema=z.looseObject({address:addressSchema,type:text,mode:z.enum(["managed","data"]),change:changeSchema});
const planSchema=z.looseObject({format_version:z.string().regex(/^1\./),resource_changes:z.array(resourceSchema),output_changes:z.record(z.string(),z.looseObject({after:z.unknown().optional(),after_unknown:z.unknown().optional()})),variables:z.record(z.string(),z.looseObject({value:z.unknown()})).optional()});
const appTypes=["aws_apigatewayv2_api","aws_apigatewayv2_stage","aws_apigatewayv2_authorizer"];
const platformTypes=["aws_cognito_user_pool","aws_cognito_user_pool_client","aws_cognito_user_pool_domain"];
const protectedTypes=[...appTypes,...platformTypes,"aws_apigatewayv2_route"];
const addresses:Record<string,string>={aws_apigatewayv2_api:"aws_apigatewayv2_api.production",aws_apigatewayv2_stage:"aws_apigatewayv2_stage.production",aws_apigatewayv2_authorizer:"aws_apigatewayv2_authorizer.cognito",aws_cognito_user_pool:"aws_cognito_user_pool.production",aws_cognito_user_pool_client:"aws_cognito_user_pool_client.chrome",aws_cognito_user_pool_domain:"aws_cognito_user_pool_domain.production"};
const v2Routes=["GET /v2/reminders","POST /v2/reminders","GET /v2/reminders/{id}","PATCH /v2/reminders/{id}","DELETE /v2/reminders/{id}","GET /v2/reminders/{id}/thumbnail-url"];
const isV2=(key:unknown)=>typeof key==="string"&&/^[A-Z]+ \/v2(?:\/|$)/.test(key);
function anyUnknown(value:unknown):boolean {return value===true||(Array.isArray(value)?value.some(anyUnknown):value!==null&&typeof value==="object"&&Object.values(value).some(anyUnknown));}
function same(a:unknown,b:unknown):boolean {return canonical(a)===canonical(b);}
function exactSet(value:unknown,expected:string[]):boolean {return Array.isArray(value)&&value.length===expected.length&&value.every(v=>typeof v==="string")&&new Set(value).size===value.length&&expected.every(v=>value.includes(v));}
function block(value:unknown):Record<string,unknown>|undefined {return Array.isArray(value)&&value.length===1&&value[0]!==null&&typeof value[0]==="object"?value[0] as Record<string,unknown>:undefined;}
const outputFields=(b:ReleaseBaseline):Record<string,unknown>=>b.root==="application"?{api_base_url:b.apiBaseUrl,api_id:b.apiId}:{cognito_issuer:b.cognitoIssuer,cognito_client_id:b.cognitoClientId,cognito_auth_base_url:b.cognitoAuthBaseUrl};
/** A null baseline is operator/initial inspection, never a normal application release. */
export function inspectPlan(input:unknown,baseline:ReleaseBaseline|null):PlanReview {
  const violations:PlanReview["violations"]=[];const reject=(address:string,code:string)=>{violations.push({address,code});};
  try {
    canonical(input);const p=planSchema.parse(input),b=baseline===null?null:baselineSchema.parse(baseline);
    if(p.errored===true||(Array.isArray(p.deferred_changes)&&p.deferred_changes.length))reject("plan","INCOMPLETE_PLAN");
    for(const r of p.resource_changes) {
      const expectedType=Object.entries(addresses).find(([,address])=>r.address===address)?.[0];
      if(expectedType&&r.type!==expectedType)reject(r.address,"PROTECTED_TYPE_CHANGED");
      if(r.mode!=="managed"||!protectedTypes.includes(r.type))continue;
      const c=r.change,a=c.after,u=c.after_unknown,creating=c.actions.length===1&&c.actions[0]==="create"&&c.before===null;
      if(r.type==="aws_apigatewayv2_route"&&!isV2(a?.route_key)&&!isV2(c.before?.route_key)&&!anyUnknown(u.route_key))continue;
      if(c.actions.some(v=>v==="delete"||v==="forget")||!a) {reject(r.address,"PROTECTED_RESOURCE_REMOVED");continue;}
      if(!creating&&!c.actions.every(v=>v==="no-op"||v==="update"))reject(r.address,"PROTECTED_ACTION");
      if(b&&creating&&["aws_apigatewayv2_api",...platformTypes].includes(r.type))reject(r.address,"EXISTING_IDENTITY_REQUIRED");
      if(c.before&&!creating)for(const field of ["id",...(r.type==="aws_apigatewayv2_api"?["api_endpoint"]:r.type==="aws_cognito_user_pool_domain"?["domain","user_pool_id"]:r.type==="aws_cognito_user_pool_client"?["user_pool_id"]:r.type==="aws_apigatewayv2_stage"?["api_id","name"]:r.type==="aws_apigatewayv2_authorizer"?["api_id"]:r.type==="aws_apigatewayv2_route"?["api_id","route_key","authorizer_id"]:[])]){
        if(c.before[field]===undefined||c.before[field]===null||a[field]===undefined||anyUnknown(u[field])||!same(c.before[field],a[field]))reject(r.address,"CHANGED_OR_UNKNOWN_IDENTITY");
      }
      if(b){const poolId=b.cognitoIssuer.split("/").at(-1),domain=new URL(b.cognitoAuthBaseUrl).hostname.split(".")[0];const expected:Record<string,unknown>=r.type==="aws_apigatewayv2_api"?{id:b.apiId,api_endpoint:b.apiBaseUrl}:r.type==="aws_apigatewayv2_stage"?{api_id:b.apiId,name:"$default"}:r.type==="aws_cognito_user_pool"?{id:poolId}:r.type==="aws_cognito_user_pool_client"?{id:b.cognitoClientId,user_pool_id:poolId}:r.type==="aws_cognito_user_pool_domain"?{domain,user_pool_id:poolId}:{api_id:b.apiId};
        for(const [field,value] of Object.entries(expected))if(a[field]===undefined||anyUnknown(u[field])||!same(a[field],value))reject(r.address,"BASELINE_IDENTITY_MISMATCH");
      }
      if(r.type==="aws_apigatewayv2_authorizer") {
        const jwt=block(a.jwt_configuration),issuer=b?.cognitoIssuer??p.variables?.cognito_issuer?.value,client=b?.cognitoClientId??p.variables?.cognito_client_id?.value;
        if(anyUnknown(u.jwt_configuration)||anyUnknown(u.authorizer_type)||anyUnknown(u.identity_sources)||a.authorizer_type!=="JWT"||!exactSet(a.identity_sources,["$request.header.Authorization"])||typeof issuer!=="string"||typeof client!=="string"||jwt?.issuer!==issuer||!exactSet(jwt?.audience,[client]))reject(r.address,"JWT_IDENTITY_REOPENED");
      }
      if(r.type==="aws_apigatewayv2_route") {
        const scope=typeof a.route_key==="string"&&a.route_key.startsWith("GET ")?"reminder-api/read":"reminder-api/write";
        const authorizer=p.resource_changes.find(resource=>resource.type==="aws_apigatewayv2_authorizer")?.change;
        if(anyUnknown(u.route_key)||anyUnknown(u.authorization_type)||anyUnknown(u.authorization_scopes)||a.authorization_type!=="JWT"||!exactSet(a.authorization_scopes,[scope])||(!creating&&(anyUnknown(u.authorizer_id)||a.authorizer_id!==authorizer?.after?.id))||(!anyUnknown(u.authorizer_id)&&a.authorizer_id!==authorizer?.after?.id))reject(r.address,"ROUTE_AUTH_REOPENED");
      }
      if(r.type==="aws_cognito_user_pool"&&(anyUnknown(u.admin_create_user_config)||block(a.admin_create_user_config)?.allow_admin_create_user_only!==true))reject(r.address,"SIGNUP_REOPENED");
      if(r.type==="aws_cognito_user_pool_client") {
        const fields=["generate_secret","allowed_oauth_flows_user_pool_client","allowed_oauth_flows","allowed_oauth_scopes","explicit_auth_flows","access_token_validity","id_token_validity","refresh_token_validity","token_validity_units","refresh_token_rotation"];
        const units=block(a.token_validity_units),rotation=block(a.refresh_token_rotation);
        if(fields.some(f=>anyUnknown(u[f]))||a.generate_secret!==false||a.allowed_oauth_flows_user_pool_client!==true||!exactSet(a.allowed_oauth_flows,["code"])||!exactSet(a.allowed_oauth_scopes,["openid","reminder-api/read","reminder-api/write"])||!exactSet(a.explicit_auth_flows,["ALLOW_ADMIN_USER_PASSWORD_AUTH"])||a.access_token_validity!==5||a.id_token_validity!==5||a.refresh_token_validity!==30||units?.access_token!=="minutes"||units.id_token!=="minutes"||units.refresh_token!=="days"||rotation?.feature!=="ENABLED"||rotation.retry_grace_period_seconds!==10)reject(r.address,"CLIENT_AUTH_REOPENED");
      }
    }
    if(b){
      for(const type of b.root==="application"?appTypes:platformTypes)if(p.resource_changes.filter(r=>r.mode==="managed"&&r.type===type).length!==1)reject(addresses[type]!,"MISSING_OR_DUPLICATE_PROTECTED_RESOURCE");
      for(const [field,value] of Object.entries(outputFields(b))){const out=p.output_changes[field];if(!out||anyUnknown(out.after_unknown)||out.after===undefined||!same(out.after,value))reject(`output.${field}`,"CHANGED_OR_UNKNOWN_OUTPUT");}
      if(b.root==="application")for(const [field,value] of Object.entries({operator_api_seed:false,production_api_id:b.apiId,cognito_issuer:b.cognitoIssuer,cognito_client_id:b.cognitoClientId,cognito_auth_base_url:b.cognitoAuthBaseUrl})){const actual=p.variables?.[field]?.value;if(actual===undefined||!same(actual,value))reject(`var.${field}`,"BASELINE_INPUT_MISMATCH");}
      if(b.root==="application") {
        for(const route of v2Routes)if(p.resource_changes.filter(r=>r.type==="aws_apigatewayv2_route"&&r.change.after?.route_key===route).length!==1)reject("aws_apigatewayv2_route.api","MISSING_OR_DUPLICATE_V2_ROUTE");
        const apiFunctions=p.resource_changes.filter(r=>r.type==="aws_lambda_function"&&(r.name==="api"||r.change.before?.handler==="dist/api.handler"||r.change.after?.handler==="dist/api.handler"));
        if(apiFunctions.length!==1)reject("aws_lambda_function.api","MISSING_OR_DUPLICATE_API_FUNCTION");
        for(const api of apiFunctions){
          const env=block(api.change.after?.environment)?.variables;
          for(const [key,value] of Object.entries({COGNITO_ISSUER:b.cognitoIssuer,COGNITO_CLIENT_ID:b.cognitoClientId,EXPECTED_API_ID:b.apiId,EXPECTED_API_STAGE:"$default"}))if(!env||typeof env!=="object"||(env as Record<string,unknown>)[key]!==value||anyUnknown(api.change.after_unknown.environment))reject(api.address,"RUNTIME_AUTH_IDENTITY_MISMATCH");
        }
      }
    }
  }catch {reject("plan","INVALID_PLAN_OR_BASELINE");}
  return {allowed:violations.length===0,violations};
}
/** Verify the root-owned terraform output -json values after apply, including initial creation. */
export function verifyPostApplyBaseline(outputs:unknown,baseline:ReleaseBaseline):void {
  const b=baselineSchema.parse(baseline),values=object.parse(outputs);for(const [field,expected] of Object.entries(outputFields(b))){const actual=object.parse(values[field]).value;if(actual===undefined||!same(actual,expected))throw new Error("Post-apply baseline mismatch");}
}
/** The saved binary, input bytes, full reviewed JSON, root, commit and artifact are independent bindings. */
export function createPlanManifest(plan:unknown,binary:Uint8Array,inputs:Uint8Array,artifact:RegisteredArtifact|null,commit:string,baseline:ReleaseBaseline|null,root:ReleaseRoot):PrivatePlanManifest {
  rootSchema.parse(root);commitSchema.parse(commit);if(!binary.length||!inputs.length)throw new Error("Empty plan or inputs");
  if(baseline!==null&&baseline.root!==root)throw new Error("Root mismatch");
  if(root==="application"&&(baseline===null||artifact===null))throw new Error("Normal application requires baseline and artifact");
  if(root==="platform"&&artifact!==null)throw new Error("Platform has no release artifact");
  const b=baseline===null?null:baselineSchema.parse(baseline),a=artifact===null?null:validateRegisteredArtifact(artifact);
  if(a&&a.commit!==commit)throw new Error("Artifact commit mismatch");
  const review=inspectPlan(plan,b);if(!review.allowed)throw new Error("Plan protection failed");
  const p=planSchema.parse(plan),own=root==="application"?appTypes:platformTypes,other=root==="application"?platformTypes:appTypes;
  if(p.resource_changes.some(r=>r.mode==="managed"&&(other.includes(r.type)||(root==="platform"&&["aws_apigatewayv2_route","aws_lambda_function"].includes(r.type))))||own.some(t=>p.resource_changes.filter(r=>r.mode==="managed"&&r.type===t).length!==1))throw new Error("Wrong root protected structure");
  if(b===null&&p.resource_changes.some(r=>r.mode==="managed"&&own.includes(r.type)&&(r.change.before!==null||!same(r.change.actions,["create"]))))throw new Error("Existing platform requires a baseline");
  const variables=object.parse(JSON.parse(Buffer.from(inputs).toString("utf8")));
  for(const [key,value] of Object.entries(variables)){const planned=p.variables?.[key]?.value;if(planned===undefined||!same(planned,value))throw new Error("Plan input mismatch");}
  if(a){
    const expected={bucket:a.bucket,key:a.key,version_id:a.versionId,sha256_base64:a.sha256Base64};if(!same(p.variables?.artifact?.value??null,expected)||!same(variables.artifact??null,expected))throw new Error("Plan artifact mismatch");
    const functions=p.resource_changes.filter(r=>r.mode==="managed"&&r.type==="aws_lambda_function");if(functions.length!==2||!["dist/api.handler","dist/cleanup.handler"].every(handler=>functions.filter(r=>r.change.after?.handler===handler).length===1))throw new Error("Missing release function");
    for(const fn of functions)for(const [key,value] of Object.entries({s3_bucket:a.bucket,s3_key:a.key,s3_object_version:a.versionId,source_code_hash:a.sha256Base64}))if(fn.change.after?.[key]!==value||anyUnknown(fn.change.after_unknown[key]))throw new Error("Planned Lambda artifact mismatch");
  }
  return {schemaVersion:1,root,commit,binarySha256:digest(binary),reviewSha256:reviewPlanSha256(plan),inputSha256:digest(inputs),artifact:a,baseline:b};
}
export function verifySavedPlan(manifest:unknown,plan:unknown,binary:Uint8Array,inputs:Uint8Array,artifact:RegisteredArtifact|null,commit:string,baseline:ReleaseBaseline|null,root:ReleaseRoot):void {
  if(!same(manifest,createPlanManifest(plan,binary,inputs,artifact,commit,baseline,root)))throw new Error("Saved release review mismatch");
}
const flags=["mode","root","plan-json","plan","inputs","artifact","baseline","commit","manifest"];
export function parseReleaseFlags(argv:string[],allowed:readonly string[],required:readonly string[]):Record<string,string> {
  const result:Record<string,string>={};for(let i=0;i<argv.length;i++){const flag=argv[i]!,key=flag.slice(2),value=argv[++i];if(!flag.startsWith("--")||!allowed.includes(key)||Object.hasOwn(result,key)||!value||value.startsWith("--"))throw new Error("Invalid arguments");result[key]=value;}if(required.some(k=>!result[k]))throw new Error("Missing arguments");return result;
}
export async function planGuardMain(argv:string[],io:ReleaseIO):Promise<number> {
  let f:Record<string,string>;try{f=parseReleaseFlags(argv,flags,flags.filter(k=>k!=="artifact"));if(!["review","check"].includes(f.mode!))throw new Error("Invalid mode");rootSchema.parse(f.root);commitSchema.parse(f.commit);if(f.root==="application"&&!f.artifact)throw new Error("Missing artifact");const paths=["plan-json","plan","inputs","artifact","baseline","manifest"].filter(k=>f[k]).map(k=>resolve(f[k]!));if(new Set(paths).size!==paths.length)throw new Error("Overlapping paths");}catch{io.stderr("Invalid plan inspection arguments\n");return 2;}
  try{
    const [json,binary,inputs,baselineText,artifactText]=await Promise.all([readFile(f["plan-json"]!,"utf8"),readFile(f.plan!),readFile(f.inputs!),readFile(f.baseline!,"utf8"),f.artifact?readFile(f.artifact,"utf8"):Promise.resolve("null")]);const plan:unknown=JSON.parse(json),baseline=JSON.parse(baselineText) as ReleaseBaseline|null,artifact=JSON.parse(artifactText) as RegisteredArtifact|null;
    const review=inspectPlan(plan,baseline);if(!review.allowed){io.stdout(JSON.stringify(review)+"\n");return 1;}
    const args=[plan,binary,inputs,artifact,f.commit!,baseline,f.root as ReleaseRoot] as const;
    if(f.mode==="review")await writeFile(f.manifest!,JSON.stringify(createPlanManifest(...args))+"\n",{flag:"wx",mode:0o600});else verifySavedPlan(JSON.parse(await readFile(f.manifest!,"utf8")),...args);
    io.stdout(JSON.stringify(review)+"\n");return 0;
  }catch{io.stderr("Plan inspection or saved review binding failed\n");return 1;}
}
if(require.main===module)void planGuardMain(process.argv.slice(2),{stdout:s=>{process.stdout.write(s);},stderr:s=>{process.stderr.write(s);}}).then(code=>{process.exitCode=code;});
