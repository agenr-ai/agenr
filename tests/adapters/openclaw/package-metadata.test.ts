import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

type OpenClawPackageJson = {
  openclaw?: {
    extensions?: string[];
  };
};

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const publishedPackageJsonPath = path.join(repoRoot, "package.json");
const publishedPluginManifestPath = path.join(repoRoot, "openclaw.plugin.json");
const adapterPluginManifestPath = path.join(repoRoot, "src", "adapters", "openclaw", "openclaw.plugin.json");

describe("published OpenClaw package metadata", () => {
  it("declares the built plugin entry at the npm package root", async () => {
    const packageJson = await readJsonFile<OpenClawPackageJson>(publishedPackageJsonPath);

    expect(packageJson.openclaw?.extensions).toEqual(["./dist/adapters/openclaw/index.js"]);
  });

  it("keeps the published plugin manifest aligned with the adapter manifest", async () => {
    const [publishedManifest, adapterManifest] = await Promise.all([
      readJsonFile<Record<string, unknown>>(publishedPluginManifestPath),
      readJsonFile<Record<string, unknown>>(adapterPluginManifestPath),
    ]);

    expect(publishedManifest).toEqual(adapterManifest);
  });
});

async function readJsonFile<TValue>(filePath: string): Promise<TValue> {
  return JSON.parse(await readFile(filePath, "utf8")) as TValue;
}
