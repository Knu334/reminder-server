import { readFile } from "node:fs/promises";
import { z } from "zod";
import { environmentIdentityFor, type MigrationTarget } from "./legacy";
import { parseMigrationTarget, type OperationIO } from "./migrate-json";
import { assertRecoveryInput, verifyRecovery, publishRecovery, preserveRecoveryImages, remapRecoveryOwners, type RecoveryInput, type RecoveryOwnerMap, type RecoveryDeps } from "./recovery";
export interface RecoveryRuntime { createDeps(source: MigrationTarget, restored: MigrationTarget, input: RecoveryInput): Promise<RecoveryDeps> }
const identities = z.array(z.strictObject({ ownerId: z.string().regex(/^[0-9a-f]{64}$/), issuer: z.string().min(1), sub: z.string().min(1) }));
const mappings = z.array(z.strictObject({ oldIssuer: z.string().min(1), oldSub: z.string().min(1), newIssuer: z.string().min(1), newSub: z.string().min(1) })).min(1);
/** No account search, legacy input or Cognito mutation. Only named private inputs are read. */
export async function recoveryMain(argv: string[], io: OperationIO, runtime?: RecoveryRuntime): Promise<number> {
  const values = new Map<string, string>(); const flags = new Set<string>();
  const invalid = (location: string, code: string): number => { io.stderr(JSON.stringify({ errors: [{ location, field: "operation", code }] }) + "\n"); return 2; };
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index]!;
    if (["--prepare-restored", "--preserve-images", "--publish-restored"].includes(name)) { if (flags.has(name)) return invalid("arguments", "INVALID_ARGUMENTS"); flags.add(name); }
    else {
      if (!["--source-config", "--restored-config", "--owner-identities", "--run-id", "--owner-map"].includes(name) || values.has(name)) return invalid("arguments", "INVALID_ARGUMENTS");
      const value = argv[++index]; if (!value || value.startsWith("--")) return invalid("arguments", "INVALID_ARGUMENTS"); values.set(name, value);
    }
  }
  if (!["--source-config", "--restored-config", "--owner-identities", "--run-id"].every(name => values.has(name))) return invalid("arguments", "PRIVATE_INPUTS_REQUIRED");
  if (flags.has("--publish-restored") && (flags.size !== 1 || values.has("--owner-map"))) return invalid("arguments", "EXCLUSIVE_PUBLICATION_REQUIRED");
  let source: MigrationTarget; let restored: MigrationTarget; let input: RecoveryInput; let mapping: RecoveryOwnerMap[] = [];
  try {
    source = parseMigrationTarget(JSON.parse(await readFile(values.get("--source-config")!, "utf8")));
    restored = parseMigrationTarget(JSON.parse(await readFile(values.get("--restored-config")!, "utf8")));
    const ownerIdentities = identities.parse(JSON.parse(await readFile(values.get("--owner-identities")!, "utf8")));
    input = { source: environmentIdentityFor(source), restored: environmentIdentityFor(restored), runId: values.get("--run-id")!, ownerIdentities };
    assertRecoveryInput(input);
    if (values.has("--owner-map")) mapping = mappings.parse(JSON.parse(await readFile(values.get("--owner-map")!, "utf8")));
  } catch { return invalid("inputs", "INVALID_PRIVATE_INPUTS"); }
  try {
    const deps = runtime ? await runtime.createDeps(source, restored, input) : await (await import("./recovery")).createRecoveryDeps(source, restored, input);
    if (flags.has("--prepare-restored")) { await deps.restored.prepareUnpublished(input.runId, deps.budget); await deps.restored.bindRun(input, [], deps.budget); }
    if (mapping.length) await remapRecoveryOwners(input, mapping, deps);
    if (flags.has("--preserve-images")) await preserveRecoveryImages(input, deps);
    const report = flags.has("--publish-restored") ? await publishRecovery(input, deps) : await verifyRecovery(input, deps);
    io.stdout(JSON.stringify(report) + "\n"); return report.readyToSwitch ? 0 : 2;
  } catch { return invalid("recovery", "RECOVERY_FAILED"); }
}
if (require.main === module) void recoveryMain(process.argv.slice(2), { stdout: line => { process.stdout.write(line); }, stderr: line => { process.stderr.write(line); } }).then(code => { process.exitCode = code; });
