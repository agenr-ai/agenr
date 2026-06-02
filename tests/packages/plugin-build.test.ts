import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

describe("plugin package build scripts", () => {
  it("builds Skeln plugin dist artifacts when the repository path contains spaces", async () => {
    const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "agenr plugin build "));
    tempDirs.push(fixtureRoot);
    await seedRootDist(fixtureRoot);
    await copyBuildScript("skeln-plugin", fixtureRoot);

    await execFileAsync(process.execPath, [path.join(fixtureRoot, "packages", "skeln-plugin", "build.mjs")]);

    const skelnEntry = await readFile(path.join(fixtureRoot, "packages", "skeln-plugin", "dist", "index.js"), "utf8");
    const skelnTypes = await readFile(path.join(fixtureRoot, "packages", "skeln-plugin", "dist", "index.d.ts"), "utf8");

    expect(skelnEntry).toContain('"./chunk-alpha.js"');
    expect(skelnTypes).toContain('"./ports-test.d.ts"');
    await expect(readFile(path.join(fixtureRoot, "packages", "skeln-plugin", "dist", "ports-test.d.ts"), "utf8")).resolves.toContain("RootType");
  });
});

describe("plugin package manifests", () => {
  it("keeps OpenClaw out of the root package runtime dependencies", async () => {
    const rootPackage = await readPackageJson(path.join(process.cwd(), "package.json"));

    expect(rootPackage.dependencies?.openclaw).toBeUndefined();
  });

  it("keeps the OpenClaw SDK dependency owned by the OpenClaw plugin package", async () => {
    const openClawPackage = await readPackageJson(path.join(process.cwd(), "packages", "openclaw-plugin", "package.json"));

    expect(openClawPackage.dependencies).toMatchObject({
      "@earendil-works/pi-ai": expect.any(String),
      "@libsql/client": expect.any(String),
      openclaw: expect.any(String),
      yaml: expect.any(String),
    });
  });

  it("does not publish the OpenClaw plugin entry from the root tsup build", async () => {
    const rootTsupConfig = await readFile(path.join(process.cwd(), "tsup.config.ts"), "utf8");

    expect(rootTsupConfig).not.toContain('"adapters/openclaw/index"');
  });

  it("does not require a sibling Skeln checkout for source installs", async () => {
    const rootPackage = await readPackageJson(path.join(process.cwd(), "package.json"));
    const skelnPackage = await readPackageJson(path.join(process.cwd(), "packages", "skeln-plugin", "package.json"));

    expect(rootPackage.devDependencies?.skeln).toBeUndefined();
    expect(skelnPackage.devDependencies?.skeln).toBeUndefined();
    expect(skelnPackage.peerDependencies?.skeln).toBeUndefined();
  });
});

async function seedRootDist(root: string): Promise<void> {
  await mkdir(path.join(root, "dist", "adapters", "skeln"), { recursive: true });
  await writeFile(path.join(root, "dist", "chunk-alpha.js"), "export const alpha = 1;\n", "utf8");
  await writeFile(path.join(root, "dist", "ports-test.d.ts"), "export interface RootType {}\n", "utf8");
  await writeFile(path.join(root, "dist", "adapters", "skeln", "index.js"), 'import "../../chunk-alpha.js";\nexport default "skeln";\n', "utf8");
  await writeFile(path.join(root, "dist", "adapters", "skeln", "index.d.ts"), 'export type { RootType } from "../../ports-test.d.ts";\n', "utf8");
}

async function copyBuildScript(packageName: string, root: string): Promise<void> {
  const packageDir = path.join(root, "packages", packageName);
  await mkdir(packageDir, { recursive: true });
  await copyFile(path.join(process.cwd(), "packages", packageName, "build.mjs"), path.join(packageDir, "build.mjs"));
}

async function readPackageJson(packagePath: string): Promise<{
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}> {
  return JSON.parse(await readFile(packagePath, "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };
}
