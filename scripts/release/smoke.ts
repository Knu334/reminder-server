import {readFile} from "node:fs/promises";
import {parseReleaseFlags,verifyPostApplyBaseline,type ReleaseBaseline,type ReleaseIO} from "./plan-guard";
function checkedUrl(baseUrl:string):string {
  if(!/^https:\/\/[a-z0-9]{10}\.execute-api\.[a-z0-9-]+\.amazonaws\.com$/.test(baseUrl))throw new Error("Invalid API base URL");return baseUrl;
}
/** Status-only unauthenticated GET probes. No tokens, CRUD writes, images or private bodies. */
export async function smoke(baseUrl:string,published:boolean,fetcher:typeof fetch=fetch):Promise<void> {
  const url=checkedUrl(baseUrl);if(typeof published!=="boolean")throw new Error("Invalid publication state");
  for(const [path,statuses] of [["/healthz",[200]],["/readyz",[published?200:503]],["/v2/reminders",[401,403]]] as const){
    const response=await fetcher(`${url}${path}`,{method:"GET",redirect:"error",signal:AbortSignal.timeout(15_000)});
    await response.body?.cancel();if(!(statuses as readonly number[]).includes(response.status))throw new Error("Read-only smoke status mismatch");
  }
}
export async function smokeMain(argv:string[],io:ReleaseIO,fetcher:typeof fetch=fetch):Promise<number> {
  let f:Record<string,string>;try{f=parseReleaseFlags(argv,["baseline","base-url","published"],["baseline","base-url","published"]);if(!["true","false"].includes(f.published!))throw new Error("Invalid publication state");}catch{io.stderr("Invalid read-only smoke arguments\n");return 2;}
  try{
    const baseline=JSON.parse(await readFile(f.baseline!,"utf8")) as ReleaseBaseline;
    if(baseline?.root!=="application"||baseline.apiBaseUrl!==f["base-url"])throw new Error("Baseline URL mismatch");
    verifyPostApplyBaseline({api_id:{value:baseline.apiId},api_base_url:{value:f["base-url"]}},baseline);
    await smoke(f["base-url"]!,f.published==="true",fetcher);io.stdout("Read-only smoke verified\n");return 0;
  }catch{io.stderr("Read-only smoke failed\n");return 1;}
}
if(require.main===module)void smokeMain(process.argv.slice(2),{stdout:s=>{process.stdout.write(s);},stderr:s=>{process.stderr.write(s);}}).then(code=>{process.exitCode=code;});
