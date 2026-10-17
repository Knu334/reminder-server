import { execFileSync } from "node:child_process";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { resolve } from "node:path";
import { build } from "esbuild";
import { writeNotices } from "./notices";

/** Build both lazy Lambda entrypoints and stage only their JS/maps and notices. */
export async function bundle(): Promise<void> {
  if (process.versions.node.split(".")[0] !== "24") throw new Error("Build requires Node24");
  await rm("dist", { recursive: true, force: true });
  await rm("artifacts/staging", { recursive: true, force: true });
  await mkdir("artifacts/staging/dist", { recursive: true });
  const result = await build({
    entryPoints: ["src/api.ts", "src/cleanup.ts"], outdir: "dist",
    bundle: true, platform: "node", format: "cjs", target: "node24",
    sourcemap: "external", sourcesContent: false, minify: false, metafile: true,
  });
  for (const output of Object.values(result.metafile.outputs)) {
    for (const dependency of output.imports) {
      if (dependency.external && !isBuiltin(dependency.path)) throw new Error(`Unbundled dependency: ${dependency.path}`);
    }
  }
  await writeFile("dist/meta.json", JSON.stringify(result.metafile, null, 2) + "\n");
  for (const name of ["api.js", "api.js.map", "cleanup.js", "cleanup.js.map"]) {
    await copyFile(`dist/${name}`, `artifacts/staging/dist/${name}`);
  }
  await writeNotices("dist/meta.json", "package-lock.json", "artifacts/staging/THIRD_PARTY_NOTICES");
  const sbom = execFileSync("npm", ["sbom", "--sbom-format", "cyclonedx"], { encoding: "utf8", maxBuffer: 20_000_000 });
  await writeFile("artifacts/sbom.json", sbom);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === __filename) {
  void bundle().catch(error => { console.error(error); process.exitCode = 1; });
}
