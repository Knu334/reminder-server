import {runtimeDataEnvironment} from "./runtime-data";
import {readFile} from "node:fs/promises";
import {LambdaClient,GetAliasCommand,GetFunctionCommand} from "@aws-sdk/client-lambda";
import {z} from "zod";
import type {RegisteredArtifact} from "./artifact";
import {parseReleaseFlags,validateRegisteredArtifact,type ReleaseIO} from "./plan-guard";
export interface ReleaseAliases {api:{aliasArn:string;version:string};cleanup:{aliasArn:string;version:string}}
const aliasSchema=z.strictObject({aliasArn:z.string().regex(/^arn:aws:lambda:([a-z0-9-]+):([0-9]{12}):function:([A-Za-z0-9_-]+):production$/),version:z.string().regex(/^[1-9][0-9]*$/)});
const aliasesSchema=z.strictObject({api:aliasSchema,cleanup:aliasSchema});
/** Resolve both production aliases to immutable versions and prove the same selected ZIP hash. */
export async function verifyRelease(expected:RegisteredArtifact,aliases:ReleaseAliases,client:LambdaClient,expectedData?:ReturnType<typeof runtimeDataEnvironment>):Promise<void> {
  const artifact=validateRegisteredArtifact(expected),selected=aliasesSchema.parse(aliases),region=await client.config.region();
  const apiParts=selected.api.aliasArn.split(":"),cleanupParts=selected.cleanup.aliasArn.split(":");
  if(apiParts[3]!==region||cleanupParts[3]!==region||apiParts[4]!==cleanupParts[4]||apiParts[6]===cleanupParts[6])throw new Error("Release function context mismatch");
  for(const value of [selected.api,selected.cleanup]) {
    const functionArn=value.aliasArn.slice(0,-":production".length);
    const alias=await client.send(new GetAliasCommand({FunctionName:functionArn,Name:"production"}));
    if(alias.AliasArn!==value.aliasArn||alias.FunctionVersion!==value.version||Object.keys(alias.RoutingConfig?.AdditionalVersionWeights??{}).length)throw new Error("Release alias mismatch");
    const fn=await client.send(new GetFunctionCommand({FunctionName:functionArn,Qualifier:value.version}));
    if(expectedData)for(const [key,value] of Object.entries(expectedData))if(fn.Configuration?.Environment?.Variables?.[key]!==value||fn.Configuration?.Environment?.Error)throw new Error("Release runtime data mismatch");
    if(fn.Configuration?.Version!==value.version||fn.Configuration.CodeSha256!==artifact.sha256Base64)throw new Error("Release version or ZIP mismatch");
  }
}
export type VerificationClientFactory=(region:string)=>LambdaClient;
export async function verifyMain(argv:string[],io:ReleaseIO,createClient:VerificationClientFactory=region=>new LambdaClient({region,maxAttempts:1})):Promise<number> {
  let f:Record<string,string>;try{f=parseReleaseFlags(argv,["artifact","outputs","region"],["artifact","outputs","region"]);z.string().regex(/^[a-z]{2}(?:-[a-z]+)+-[1-9][0-9]*$/).parse(f.region);}catch{io.stderr("Invalid release verification arguments\n");return 2;}
  let client:LambdaClient|undefined;
  try{
    const artifact=validateRegisteredArtifact(JSON.parse(await readFile(f.artifact!,"utf8")));
    const value=z.object({api_alias_arn:z.object({value:z.string()}),cleanup_alias_arn:z.object({value:z.string()}),api_version:z.object({value:z.string()}),cleanup_version:z.object({value:z.string()}),runtime_data:z.object({value:z.object({reminders_table:z.string().min(1),owner_state_table:z.string().min(1),image_jobs_table:z.string().min(1),images_bucket:z.string().min(1),restored_tables:z.record(z.string(),z.string())})}),release_sha256_base64:z.object({value:z.string()})}).parse(JSON.parse(await readFile(f.outputs!,"utf8")));
    if(value.release_sha256_base64.value!==artifact.sha256Base64)throw new Error("Output ZIP mismatch");
    const aliases=aliasesSchema.parse({api:{aliasArn:value.api_alias_arn.value,version:value.api_version.value},cleanup:{aliasArn:value.cleanup_alias_arn.value,version:value.cleanup_version.value}});
    client=createClient(f.region!);await verifyRelease(artifact,aliases,client,runtimeDataEnvironment(value.runtime_data.value));io.stdout("Release identity verified\n");return 0;
  }catch{io.stderr("Release identity verification failed\n");return 1;}finally{client?.destroy();}
}
if(require.main===module)void verifyMain(process.argv.slice(2),{stdout:s=>{process.stdout.write(s);},stderr:s=>{process.stderr.write(s);}}).then(code=>{process.exitCode=code;});
