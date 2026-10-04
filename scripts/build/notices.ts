import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Metafile } from "esbuild";

interface LockedPackage { version?: string; license?: string }
interface InstalledPackage { name: string; version: string; license: string; repository?: { url?: string } }
const sdkRepository = "https://github.com/aws/aws-sdk-js-v3.git";
const sdkLicenseFallback = new Set(["@aws-sdk/credential-provider-http", "@aws-sdk/credential-provider-login", "@aws-sdk/nested-clients"]);

/** Include the license texts of every package whose source entered either bundle. */
export async function writeNotices(metafilePath: string, lockPath: string, destination: string): Promise<void> {
  const meta = JSON.parse(await readFile(metafilePath, "utf8")) as Metafile;
  const lock = JSON.parse(await readFile(lockPath, "utf8")) as { packages: Record<string, LockedPackage> };
  const root = dirname(resolve(lockPath));
  const packagePaths = new Set<string>();
  for (const input of Object.keys(meta.inputs)) {
    const match = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(input);
    if (match !== null) packagePaths.add(match[1]!);
  }
  const sections: string[] = ["Third-party licenses for the bundled Lambda handlers.\n"];
  for (const key of [...packagePaths].sort()) {
    const locked = lock.packages[key];
    if (!locked?.version || !locked.license) throw new Error(`Missing locked license/version: ${key}`);
    const packageRoot = resolve(root, key);
    const installed = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as InstalledPackage;
    const expectedName = key.slice(key.lastIndexOf("node_modules/") + 13);
    if (installed.name !== expectedName || installed.version !== locked.version || installed.license !== locked.license) throw new Error(`Installed package differs from lock: ${key}`);
    const licenseFiles = (await readdir(packageRoot)).filter(name => /^(licen[cs]e|copying)([._-].*)?$/i.test(name)).sort();
    sections.push(`===== ${installed.name}@${locked.version} =====\nLicense: ${locked.license}\n`);
    if (licenseFiles.length === 0) {
      // These upstream internal packages omit LICENSE from their published tarballs.
      // Their declared repository and SPDX ID identify the same SDK repository license.
      if (!sdkLicenseFallback.has(installed.name) || locked.license !== "Apache-2.0" || installed.repository?.url !== sdkRepository) {
        throw new Error(`Missing license text: ${key}`);
      }
      const sourceKey = "node_modules/@aws-sdk/client-s3";
      const sourceLock = lock.packages[sourceKey];
      const sourcePackage = JSON.parse(await readFile(resolve(root, sourceKey, "package.json"), "utf8")) as InstalledPackage;
      if (sourcePackage.name !== "@aws-sdk/client-s3" || !sourceLock?.version || sourceLock.license !== "Apache-2.0" ||
          sourcePackage.version !== sourceLock.version || sourcePackage.license !== "Apache-2.0" || sourcePackage.repository?.url !== sdkRepository) {
        throw new Error("SDK repository license source differs from the pinned lock or provenance");
      }
      const source = `${sourceKey}/LICENSE`;
      sections.push(`SDK repository license (source: ${source})\n${await readFile(resolve(root, source), "utf8")}\n`);
    }
    for (const name of licenseFiles) sections.push(`${name}\n${await readFile(join(packageRoot, name), "utf8")}\n`);
  }
  await writeFile(destination, sections.join("\n"));
}
