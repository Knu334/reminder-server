import {spawnSync} from "node:child_process";
import {chmodSync,lstatSync,mkdirSync,readdirSync,rmSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {randomUUID} from "node:crypto";
export class PrivateCommandError extends Error {}
const limit=128*1024;
function diagnostic(text:string):string {
  // eslint-disable-next-line no-control-regex -- Strip terminal color escapes from private diagnostics.
  return Buffer.from(text).subarray(-limit).toString("utf8").replace(/\u001b\[[0-9;]*m/g,"")
    .replace(/((?:AWS_[A-Z_]*(?:KEY|TOKEN)|authorization|password|secret(?:_access_key)?|session_token)\s*[:=]\s*)\S+/gi,"$1[REDACTED]")
    .replace(/(?:AKIA|ASIA)[A-Z0-9]{16}/g,"[REDACTED]");
}
/** Private bounded failure files only; no command arguments, environment or successful output. */
export function runPrivateCommand(command:string,args:string[],options:{directory:string;phase:string;captureStdout?:boolean}):string {
  if(!/^[a-z][a-z0-9-]{0,40}$/.test(options.phase))throw Error("Invalid command phase");
  const result=spawnSync(command,args,{encoding:"utf8",maxBuffer:128*1024*1024});
  if(!result.error&&result.status===0)return result.stdout;
  mkdirSync(options.directory,{recursive:true,mode:0o700});
  const dir=lstatSync(options.directory);if(!dir.isDirectory()||dir.isSymbolicLink())throw Error("Invalid diagnostics directory");chmodSync(options.directory,0o700);
  const existing=readdirSync(options.directory).filter(name=>/^failure-[0-9]+-[0-9a-f-]+\.json$/.test(name)).sort();
  for(const name of existing){const p=join(options.directory,name),s=lstatSync(p);if(!s.isFile()||s.isSymbolicLink())throw Error("Invalid diagnostics file");if(Date.now()-s.mtimeMs>86400000)rmSync(p);}
  const retained=readdirSync(options.directory).filter(name=>/^failure-[0-9]+-[0-9a-f-]+\.json$/.test(name)).sort();
  for(const name of retained.slice(0,Math.max(0,retained.length-7)))rmSync(join(options.directory,name));
  const file=join(options.directory,`failure-${Date.now()}-${randomUUID()}.json`);
  writeFileSync(file,JSON.stringify({phase:options.phase,exitStatus:result.status,signal:result.signal,errorCode:result.error?(result.error as NodeJS.ErrnoException).code:null,stderr:diagnostic(result.stderr??""),stdout:options.captureStdout?diagnostic(result.stdout??""):"[omitted: may contain private plan/state/input]"})+"\n",{flag:"wx",mode:0o600});
  throw new PrivateCommandError(`Private command ${options.phase} failed (exit ${result.status??"unavailable"}); retrieve private diagnostics from ${options.directory}`);
}
