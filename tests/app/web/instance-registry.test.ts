import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ensureUniqueInstanceId,
  normalizeOptionalPath,
  normalizeRegistryDocument,
  readInstanceRegistry,
  registerInstance,
  removeInstance,
  selectInstance,
  slugifyInstanceName,
  type InstanceRegistryOptions,
} from "../../../src/app/web/instance-registry.js";
import { removeTestPath } from "../../helpers/temp-paths.js";

const tempRoots: string[] = [];

/** Builds isolated registry options backed by a fresh temp directory. */
async function makeOptions(): Promise<{ options: InstanceRegistryOptions; root: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "agenr-registry-"));
  tempRoots.push(root);
  const env: NodeJS.ProcessEnv = { ...process.env, AGENR_CONFIG_DIR: root };
  delete env.AGENR_DB_PATH;
  delete env.AGENR_CONFIG_PATH;
  return { options: { registryPath: path.join(root, "web-instances.json"), env }, root };
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    await removeTestPath(tempRoots.pop()!);
  }
});

describe("slugifyInstanceName", () => {
  it("lowercases and hyphenates free-form names", () => {
    expect(slugifyInstanceName("My Prod DB!")).toBe("my-prod-db");
    expect(slugifyInstanceName("  Trailing  ")).toBe("trailing");
  });

  it("falls back to instance for empty slugs", () => {
    expect(slugifyInstanceName("   ")).toBe("instance");
    expect(slugifyInstanceName("***")).toBe("instance");
  });
});

describe("ensureUniqueInstanceId", () => {
  it("returns the base when unused", () => {
    expect(ensureUniqueInstanceId("prod", new Set())).toBe("prod");
  });

  it("appends an incrementing suffix when taken", () => {
    expect(ensureUniqueInstanceId("prod", new Set(["prod"]))).toBe("prod-2");
    expect(ensureUniqueInstanceId("prod", new Set(["prod", "prod-2"]))).toBe("prod-3");
  });
});

describe("normalizeOptionalPath", () => {
  it("preserves the in-memory sentinel", () => {
    expect(normalizeOptionalPath(":memory:")).toBe(":memory:");
  });

  it("resolves relative paths to absolute", () => {
    expect(normalizeOptionalPath("rel/dir")).toBe(path.resolve("rel/dir"));
  });

  it("returns undefined for blank input", () => {
    expect(normalizeOptionalPath(undefined)).toBeUndefined();
    expect(normalizeOptionalPath("   ")).toBeUndefined();
  });
});

describe("normalizeRegistryDocument", () => {
  it("returns an empty document for non-registry shapes", () => {
    expect(normalizeRegistryDocument(null)).toEqual({ version: 1, instances: [] });
    expect(normalizeRegistryDocument({ instances: "nope" })).toEqual({ version: 1, instances: [] });
  });

  it("drops malformed and duplicate entries while keeping valid ones", () => {
    const result = normalizeRegistryDocument({
      version: 1,
      instances: [
        { id: "prod", name: "Prod", createdAt: "2026-01-01T00:00:00.000Z" },
        { id: "prod", name: "Duplicate" },
        { id: "", name: "Empty id" },
        { name: "No id" },
      ],
      selectedId: "prod",
    });

    expect(result.instances).toHaveLength(1);
    expect(result.instances[0]).toMatchObject({ id: "prod", name: "Prod" });
    expect(result.selectedId).toBe("prod");
  });

  it("ignores a selectedId that does not match a kept instance", () => {
    const result = normalizeRegistryDocument({
      version: 1,
      instances: [{ id: "prod", name: "Prod" }],
      selectedId: "ghost",
    });
    expect(result.selectedId).toBeUndefined();
  });
});

describe("registry persistence round trip", () => {
  it("registers, selects, and removes instances against a temp registry", async () => {
    const { options, root } = await makeOptions();

    const afterFirst = await registerInstance({ name: "Alpha", dbPath: path.join(root, "alpha.db") }, options);
    expect(afterFirst.instances).toHaveLength(1);
    expect(afterFirst.selectedId).toBe("alpha");

    const afterSecond = await registerInstance({ name: "Beta", dbPath: path.join(root, "beta.db") }, options);
    expect(afterSecond.instances.map((entry) => entry.id)).toEqual(["alpha", "beta"]);
    expect(afterSecond.selectedId).toBe("beta");

    const reread = await readInstanceRegistry(options);
    expect(reread.instances).toHaveLength(2);
    expect(reread.selectedId).toBe("beta");

    const selected = await selectInstance("alpha", options);
    expect(selected.record.id).toBe("alpha");
    expect((await readInstanceRegistry(options)).selectedId).toBe("alpha");

    const afterRemove = await removeInstance("alpha", options);
    expect(afterRemove.instances.map((entry) => entry.id)).toEqual(["beta"]);
    expect(afterRemove.selectedId).toBe("beta");
  });

  it("rejects an empty instance name", async () => {
    const { options } = await makeOptions();
    await expect(registerInstance({ name: "   " }, options)).rejects.toThrow(/must not be empty/u);
  });

  it("marks a resolved instance as missing its database file", async () => {
    const { options, root } = await makeOptions();
    await registerInstance({ name: "Gamma", dbPath: path.join(root, "missing.db") }, options);
    const resolved = await selectInstance("gamma", options);
    expect(resolved.dbExists).toBe(false);
  });
});
