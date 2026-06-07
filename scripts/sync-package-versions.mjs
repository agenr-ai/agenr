import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_PATHS = ["packages/openclaw-plugin/package.json", "packages/skeln-plugin/package.json"];

const MANIFEST_PATHS = ["packages/openclaw-plugin/openclaw.plugin.json", "src/adapters/openclaw/openclaw.plugin.json"];

/**
 * @param {string} rootDir
 * @param {{ write?: boolean }} [options]
 */
export function syncPackageVersions(rootDir = resolve("."), options = {}) {
  const write = options.write ?? true;
  const rootPackagePath = join(rootDir, "package.json");
  const rootPackage = JSON.parse(readFileSync(rootPackagePath, "utf8"));
  const targetVersion = rootPackage.version;
  if (!targetVersion) {
    throw new Error("Root package.json missing version.");
  }

  const updated = [];
  const skipped = [];

  for (const relativePath of [...PACKAGE_PATHS, ...MANIFEST_PATHS]) {
    const filePath = join(rootDir, relativePath);
    if (!existsSync(filePath)) {
      skipped.push(relativePath);
      continue;
    }

    const parsed = JSON.parse(readFileSync(filePath, "utf8"));
    if (parsed.version === targetVersion) {
      skipped.push(relativePath);
      continue;
    }

    parsed.version = targetVersion;
    if (write) {
      writeFileSync(filePath, `${JSON.stringify(parsed, null, 2)}\n`);
    }
    updated.push(relativePath);
  }

  return {
    targetVersion,
    updated,
    skipped,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes("--check");
  const summary = syncPackageVersions(resolve("."), { write: !check });
  console.log(`Synced package versions to ${summary.targetVersion}. Updated: ${summary.updated.length}. Skipped: ${summary.skipped.length}.`);
  if (check && summary.updated.length > 0) {
    for (const relativePath of summary.updated) {
      console.error(`  update required: ${relativePath}`);
    }
    console.error("Run `pnpm packages:sync` and commit the package version alignment.");
    process.exit(1);
  }
}
