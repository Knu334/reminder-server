import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type TerraformRunner = (args: string[], options?: { withoutBackend: boolean }) => string;
const roots = {bootstrap: "bootstrap", platform: "platform/production", application: "application/production"} as const;
const terraform: TerraformRunner = (args, options) => {
  if (options?.withoutBackend) {
    // providers schema requires an initialized backend even after init -backend=false.
    // Use only public configuration + the owning lock in an isolated local probe.
    const root = args[0]!.slice("-chdir=".length);
    const probe = mkdtempSync(join(tmpdir(), "infra-schema-"));
    try {
      for (const name of readdirSync(root)) {
        if (name.endsWith(".tf") && name !== "backend.tf" || name === ".terraform.lock.hcl") {
          copyFileSync(join(root, name), join(probe, name));
        }
      }
      terraform([`-chdir=${probe}`, "init", "-backend=false", "-lockfile=readonly", "-input=false"]);
      return terraform([`-chdir=${probe}`, ...args.slice(1)]);
    } finally { rmSync(probe, { recursive: true, force: true }); }
  }
  const result = spawnSync("terraform", args, {encoding:"utf8", maxBuffer:64 * 1024 * 1024});
  if (result.error || result.status !== 0) throw new Error(`Terraform ${args.includes("schema") ? "schema" : args[1] ?? args[0]} failed`);
  // Schema is consumed privately; state/plan/credentials are never printed.
  return result.stdout;
};

/** Static validation only: no backend initialization, account calls, plan files or apply. */
export function checkInfra(argv: string[], run: TerraformRunner = terraform, exists: (path: string) => boolean = existsSync): void {
  const requested = argv[0]?.slice("--root=".length);
  if (argv.length > 1 || argv.length === 1 && (!argv[0]?.startsWith("--root=") || !requested || !Object.hasOwn(roots, requested))) {
    throw new Error("Usage: infra:check [--root=bootstrap|platform|application]");
  }
  const selected = requested ? [requested as keyof typeof roots] : Object.keys(roots) as (keyof typeof roots)[];
  for (const root of selected) {
    if (!exists(`infra/${roots[root]}/versions.tf`)) throw new Error(`Missing Terraform root: infra/${roots[root]}; it has not been verified`);
    if (!exists(`infra/${roots[root]}/tests/${root}.tftest.hcl`)) throw new Error(`Missing mock tests for infra/${roots[root]}`);
  }
  for (const root of selected) {
    const prefix = `-chdir=infra/${roots[root]}`;
    run([prefix,"init","-backend=false","-lockfile=readonly","-input=false"]);
    run([prefix,"validate"]);
    const schema = JSON.parse(run([prefix,"providers","schema","-json"], {withoutBackend:true})) as {
      provider_schemas?: Record<string, {
        resource_schemas?: {
          aws_lambda_function?: {
            block?: { attributes?: { code_sha256?: { type?: string; computed?: boolean } } };
          };
        };
      }>;
    };
    const field = schema.provider_schemas?.["registry.terraform.io/hashicorp/aws"]?.resource_schemas?.aws_lambda_function?.block?.attributes?.code_sha256;
    if (field?.type !== "string" || !field.computed) throw new Error("Pinned AWS provider must expose computed string aws_lambda_function.code_sha256");
    run([prefix,"test",`-filter=tests/${root}.tftest.hcl`]);
  }
  run(["fmt","-check","-recursive","infra"]);
}

if (require.main === module) {
  try {
    checkInfra(process.argv.slice(2));
    process.stdout.write("Local Terraform validation and mock tests passed for selected roots\n");
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Infra validation failed"}\n`);
    process.exitCode = 1;
  }
}
