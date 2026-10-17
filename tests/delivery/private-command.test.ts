import assert from "node:assert/strict";
import {test} from "node:test";
import {mkdtemp,readFile,readdir,rm,stat} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
void test("real failed runner retains bounded private phase diagnostics without ordinary output",async()=>{
 const directory=await mkdtemp(join(tmpdir(),"private-diagnostics-test-"));
 try {
  const modulePath="../../scripts/release/private-command";
  let runner: {runPrivateCommand:(command:string,args:string[],options:{directory:string;phase:string;captureStdout?:boolean})=>string}|undefined;
  try {runner=await import(modulePath);}catch{/* asserted below */}
  assert.ok(runner,"private failure runner required");
  for(let i=0;i<10;i++)assert.throws(()=>runner.runPrivateCommand(process.execPath,["-e","process.stdout.write('private plan bytes');process.stderr.write('x'.repeat(300000)+' synthetic diagnostic AWS_SECRET_ACCESS_KEY=synthetic-secret');process.exitCode=7"],{directory,phase:"plan"}),/plan.*7/);
  assert.equal((await stat(directory)).mode&0o777,0o700);
  const files=await readdir(directory);assert.equal(files.length,8);
  const diagnostic=JSON.parse(await readFile(join(directory,files.at(-1)!),"utf8"));
  assert.equal(diagnostic.phase,"plan");assert.equal(diagnostic.exitStatus,7);
  assert.match(diagnostic.stderr,/synthetic diagnostic/);assert.ok(!diagnostic.stderr.includes("synthetic-secret"));
  assert.ok(!JSON.stringify(diagnostic).includes("private plan bytes"));
  for(const file of files){const s=await stat(join(directory,file));assert.equal(s.mode&0o777,0o600);assert.ok(s.size<270000);}
  assert.equal(runner.runPrivateCommand(process.execPath,["-e","process.stdout.write('success')"],{directory,phase:"show"}),"success");
 } finally {await rm(directory,{recursive:true,force:true});}
});

void test("actual release and infrastructure CLIs fail closed and expose only private diagnostic location",async()=>{
 const {writeFile,mkdir}=await import("node:fs/promises");const {spawnSync}=await import("node:child_process");
 const directory=await mkdtemp(join(tmpdir(),"private-cli-test-"));
 try {
  const bin=join(directory,"bin");await mkdir(bin);
  for(const command of ["git","terraform"])await writeFile(join(bin,command),"#!/bin/sh\nprintf 'synthetic private command detail' >&2\nexit 7\n",{mode:0o700});
  for(const [script,arg,phase,folder] of [["workflow.ts","authorize","git","release-diagnostics"],["infra-check.ts","--root=bootstrap","init","infra-diagnostics"]]){
   const result=spawnSync(process.execPath,["--import","tsx",`scripts/release/${script}`,arg!],{encoding:"utf8",env:{PATH:bin,RUNNER_TEMP:directory,RELEASE_ROOT:"application",RELEASE_COMMIT:"a".repeat(40),AWS_REGION:"us-east-1",RELEASE_APPLY:"false",RELEASE_PUBLISHED:"false",RELEASE_SCHEDULER_ENABLED:"false"}});
   assert.equal(result.status,1);assert.equal(result.stdout.includes("synthetic private"),false);assert.equal(result.stderr.includes("synthetic private"),false);assert.match(result.stderr,new RegExp(`${phase}.*7`));assert.ok(result.stderr.includes(folder!));
   const files=await readdir(join(directory,folder!));assert.equal(files.length,1);const detail=JSON.parse(await readFile(join(directory,folder!,files[0]!),"utf8"));assert.equal(detail.phase,phase);assert.equal(detail.exitStatus,7);assert.match(detail.stderr,/synthetic private command detail/);
  }
 }finally{await rm(directory,{recursive:true,force:true});}
});
