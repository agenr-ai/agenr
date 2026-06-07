import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { syncPackageVersions } from "../../scripts/sync-package-versions.mjs";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("syncPackageVersions", () => {
  it("aligns plugin package and manifest versions to the root package", async () => {
    const root = await mkdtemp(join(tmpdir(), "agenr-sync-versions-"));
    tempRoots.push(root);

    await writeFile(join(root, "package.json"), `${JSON.stringify({ name: "agenr", version: "2026.6.2" }, null, 2)}\n`);
    await mkdir(join(root, "packages/openclaw-plugin"), { recursive: true });
    await mkdir(join(root, "packages/skeln-plugin"), { recursive: true });
    await mkdir(join(root, "src/adapters/openclaw"), { recursive: true });
    await writeFile(
      join(root, "packages/openclaw-plugin/package.json"),
      `${JSON.stringify({ name: "@agenr/openclaw-plugin", version: "2026.6.1" }, null, 2)}\n`,
    );
    await writeFile(join(root, "packages/skeln-plugin/package.json"), `${JSON.stringify({ name: "@agenr/skeln-plugin", version: "2026.6.1" }, null, 2)}\n`);
    await writeFile(join(root, "packages/openclaw-plugin/openclaw.plugin.json"), `${JSON.stringify({ id: "agenr", version: "2026.6.1" }, null, 2)}\n`);
    await writeFile(join(root, "src/adapters/openclaw/openclaw.plugin.json"), `${JSON.stringify({ id: "agenr", version: "2026.6.1" }, null, 2)}\n`);

    const summary = syncPackageVersions(root, { write: true });

    expect(summary).toEqual({
      targetVersion: "2026.6.2",
      updated: [
        "packages/openclaw-plugin/package.json",
        "packages/skeln-plugin/package.json",
        "packages/openclaw-plugin/openclaw.plugin.json",
        "src/adapters/openclaw/openclaw.plugin.json",
      ],
      skipped: [],
    });

    const pluginPackage = JSON.parse(await readFile(join(root, "packages/openclaw-plugin/package.json"), "utf8")) as { version?: string };
    const adapterManifest = JSON.parse(await readFile(join(root, "src/adapters/openclaw/openclaw.plugin.json"), "utf8")) as { version?: string };

    expect(pluginPackage.version).toBe("2026.6.2");
    expect(adapterManifest.version).toBe("2026.6.2");
  });
});
