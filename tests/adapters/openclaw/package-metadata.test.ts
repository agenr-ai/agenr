import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

type PackageJson = {
  name?: string;
  version?: string;
  bin?: Record<string, string> | string;
  dependencies?: Record<string, string>;
  files?: string[];
  openclaw?: {
    extensions?: string[];
  };
};

type PluginManifest = {
  id?: string;
  version?: string;
};

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const rootPackageJsonPath = path.join(repoRoot, "package.json");
const pluginPackageRoot = path.join(repoRoot, "packages", "openclaw-plugin");
const pluginPackageJsonPath = path.join(pluginPackageRoot, "package.json");
const pluginPackageManifestPath = path.join(pluginPackageRoot, "openclaw.plugin.json");
const adapterPluginManifestPath = path.join(repoRoot, "src", "adapters", "openclaw", "openclaw.plugin.json");
const pluginPackageEntryPath = path.join(pluginPackageRoot, "src", "index.ts");

describe("published OpenClaw plugin package metadata", () => {
  it("keeps the root package publish surface focused on install-time artifacts", async () => {
    const packageJson = await readJsonFile<PackageJson>(rootPackageJsonPath);

    expect(packageJson.files).toEqual(["dist", "README.md", "LICENSE", "CHANGELOG.md"]);
  });

  it("publishes the plugin from the dedicated package entry", async () => {
    const packageJson = await readJsonFile<PackageJson>(pluginPackageJsonPath);

    expect(packageJson.name).toBe("@agenr/openclaw-plugin");
    expect(packageJson.openclaw?.extensions).toEqual(["./dist/index.js"]);
  });

  it("keeps the plugin package publish allowlist narrow", async () => {
    const packageJson = await readJsonFile<PackageJson>(pluginPackageJsonPath);

    expect(packageJson.files).toEqual(["dist", "openclaw.plugin.json", "README.md"]);
  });

  it("keeps the plugin manifest aligned with the shared adapter manifest", async () => {
    const [pluginManifest, adapterManifest] = await Promise.all([
      readJsonFile<Record<string, unknown>>(pluginPackageManifestPath),
      readJsonFile<Record<string, unknown>>(adapterPluginManifestPath),
    ]);

    expect(pluginManifest).toEqual(adapterManifest);
  });

  it("keeps the plugin manifest id and release version stable", async () => {
    const [rootPackageJson, pluginPackageJson, pluginManifest] = await Promise.all([
      readJsonFile<PackageJson>(rootPackageJsonPath),
      readJsonFile<PackageJson>(pluginPackageJsonPath),
      readJsonFile<PluginManifest>(pluginPackageManifestPath),
    ]);

    expect(pluginManifest.id).toBe("agenr");
    expect(pluginManifest.version).toBe(pluginPackageJson.version);
    expect(pluginPackageJson.version).toBe(rootPackageJson.version);
  });

  it("does not expose a CLI or CLI-only dependencies from the plugin package", async () => {
    const packageJson = await readJsonFile<PackageJson>(pluginPackageJsonPath);

    expect(packageJson.bin).toBeUndefined();
    expect(packageJson.dependencies).not.toHaveProperty("@clack/prompts");
    expect(packageJson.dependencies).not.toHaveProperty("chalk");
    expect(packageJson.dependencies).not.toHaveProperty("commander");
  });

  it("keeps the root CLI package out of OpenClaw plugin discovery", async () => {
    const packageJson = await readJsonFile<PackageJson>(rootPackageJsonPath);

    expect(packageJson.openclaw?.extensions).toBeUndefined();
  });

  it("does not pull CLI or child_process code into the plugin entry graph", async () => {
    const graph = await collectLocalModuleGraph(pluginPackageEntryPath);

    const cliImports = graph.files.filter((filePath) => hasPathSegment(filePath, "src", "cli"));
    expect(cliImports).toEqual([]);

    expect(graph.childProcessImports).toEqual([]);
  });
});

async function readJsonFile<TValue>(filePath: string): Promise<TValue> {
  return JSON.parse(await readFile(filePath, "utf8")) as TValue;
}

async function collectLocalModuleGraph(entryPath: string): Promise<{
  files: string[];
  childProcessImports: Array<{ importer: string; specifier: string }>;
}> {
  const pending = [entryPath];
  const visited = new Set<string>();
  const childProcessImports: Array<{ importer: string; specifier: string }> = [];

  while (pending.length > 0) {
    const currentPath = pending.pop();
    if (!currentPath || visited.has(currentPath)) {
      continue;
    }

    visited.add(currentPath);
    if (currentPath.endsWith(".json")) {
      continue;
    }

    const source = await readFile(currentPath, "utf8");
    for (const specifier of extractImportSpecifiers(source)) {
      if (specifier === "node:child_process") {
        childProcessImports.push({
          importer: currentPath,
          specifier,
        });
        continue;
      }

      if (!specifier.startsWith(".")) {
        continue;
      }

      pending.push(resolveRelativeModulePath(currentPath, specifier));
    }
  }

  return {
    files: [...visited].sort(),
    childProcessImports,
  };
}

function extractImportSpecifiers(source: string): string[] {
  const matches = source.matchAll(/(?:import|export)\s+(?:[^"'`]+?\s+from\s+)?["']([^"']+)["']/gu);
  return [...matches].map((match) => match[1]).filter((value): value is string => value !== undefined);
}

function resolveRelativeModulePath(importerPath: string, specifier: string): string {
  const resolvedBasePath = path.resolve(path.dirname(importerPath), specifier);
  const candidates = [
    resolvedBasePath,
    `${resolvedBasePath}.ts`,
    `${resolvedBasePath}.json`,
    replaceJsExtension(resolvedBasePath, ".ts"),
    replaceJsExtension(resolvedBasePath, ".json"),
    path.join(resolvedBasePath, "index.ts"),
    path.join(resolvedBasePath, "index.json"),
  ];

  const resolvedPath = candidates.find((candidatePath) => pathMatches(candidatePath));
  if (!resolvedPath) {
    throw new Error(`Unable to resolve ${specifier} from ${importerPath}.`);
  }

  return resolvedPath;
}

function replaceJsExtension(filePath: string, extension: ".ts" | ".json"): string {
  return filePath.replace(/\.js$/u, extension);
}

function pathMatches(filePath: string): boolean {
  return existsSync(filePath);
}

function hasPathSegment(filePath: string, ...segments: string[]): boolean {
  const normalizedPath = path.normalize(filePath);
  const needle = path.join(...segments);
  return normalizedPath.includes(`${path.sep}${needle}${path.sep}`);
}
