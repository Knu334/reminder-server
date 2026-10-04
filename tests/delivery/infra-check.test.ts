import assert from "node:assert/strict";
import test from "node:test";
import { checkInfra, type TerraformRunner } from "../../scripts/release/infra-check";

const schema = JSON.stringify({provider_schemas:{"registry.terraform.io/hashicorp/aws":{resource_schemas:{aws_lambda_function:{block:{attributes:{code_sha256:{type:"string",computed:true}}}}}}}});
void test("bootstrap-only verification runs backendless init, validation, filtered mock tests and recursive formatting", () => {
  const calls: string[][] = [];
  const runner: TerraformRunner = (args, options) => { if (args.includes("schema")) assert.equal(options?.withoutBackend, true); calls.push(args); return args.includes("schema") ? schema : ""; };
  checkInfra(["--root=bootstrap"], runner, () => true);
  assert.deepEqual(calls, [
    ["-chdir=infra/bootstrap", "init", "-backend=false", "-lockfile=readonly", "-input=false"],
    ["-chdir=infra/bootstrap", "validate"],
    ["-chdir=infra/bootstrap", "providers", "schema", "-json"],
    ["-chdir=infra/bootstrap", "test", "-filter=tests/bootstrap.tftest.hcl"],
    ["fmt", "-check", "-recursive", "infra"],
  ]);
});
void test("all-root verification fails before claiming success for an absent production root", () => {
  assert.throws(() => checkInfra([], () => "", path => path.startsWith("infra/bootstrap/")), /Missing Terraform root: infra\/platform\/production/);
});
void test("pinned provider lacking code_sha256 fails without running mock tests", () => {
  const calls: string[][]=[];
  assert.throws(() => checkInfra(["--root=bootstrap"], args => {calls.push(args); return args.includes("schema") ? "{}" : "";}, () => true), /code_sha256/);
  assert.equal(calls.some(args => args.includes("test")), false);
});
void test("unknown arguments never run Terraform", () => {
  assert.throws(() => checkInfra(["--apply"], () => {throw new Error("must not run");}, () => true), /Usage/);
});
void test("later-root selectors use their exact production directories and owning mock filters", () => {
  for (const root of ["platform", "application"]) {
    const calls: string[][] = [];
    checkInfra([`--root=${root}`], args => { calls.push(args); return args.includes("schema") ? schema : ""; }, () => true);
    assert.equal(calls[0]?.[0], `-chdir=infra/${root}/production`);
    assert.deepEqual(calls[3], [`-chdir=infra/${root}/production`, "test", `-filter=tests/${root}.tftest.hcl`]);
  }
});
