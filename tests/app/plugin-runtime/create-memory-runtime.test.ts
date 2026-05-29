import path from "node:path";

import { describe, expect, it, vi } from "vitest";
import { createPluginMemoryRuntime } from "../../../src/app/plugin-runtime/create-memory-runtime.js";
import { resolvePluginPaths } from "../../../src/app/plugin-runtime/resolve-paths.js";
import { createTempRoot, usePluginRuntimeEnv, writeJson } from "./helpers.js";

describe("createPluginMemoryRuntime", () => {
  usePluginRuntimeEnv();

  it("falls back to agenr config defaults when plugin config is empty", async () => {
    const root = await createTempRoot("agenr-plugin-runtime-");
    const dbPath = path.join(root, "custom", "knowledge.db");
    process.env.AGENR_CONFIG_DIR = root;
    await writeJson(path.join(root, "config.json"), {
      dbPath,
      credentials: {
        openaiApiKey: "fallback-config-key",
      },
      embeddingModel: "text-embedding-fallback",
    });

    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          data: [{ index: 0, embedding: [7, 8, 9] }],
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const { resolvedConfig, agenrConfig } = resolvePluginPaths({});
    const services = await createPluginMemoryRuntime({
      dbPath: resolvedConfig.dbPath,
      agenrConfig: { ...agenrConfig, dbPath: resolvedConfig.dbPath },
    });

    expect(resolvedConfig).toMatchObject({
      configPath: path.join(root, "config.json"),
      dbPath,
    });
    await expect(services.embedding.embed(["plugin install fallback"])).resolves.toEqual([[7, 8, 9]]);
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: "Bearer fallback-config-key",
    });

    await services.close();
  });

  it("loads embedding credentials from agenr config next to dbPath", async () => {
    const root = await createTempRoot("agenr-plugin-runtime-");
    const dbPath = path.join(root, "knowledge.db");
    await writeJson(path.join(root, "config.json"), {
      auth: "openai-api-key",
      credentials: {
        openaiApiKey: "config-key",
      },
      embeddingModel: "text-embedding-from-config",
    });

    const requestBodies: Array<{ model: string; input: string[] }> = [];
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      requestBodies.push(JSON.parse(String(init?.body)) as { model: string; input: string[] });

      return new Response(
        JSON.stringify({
          data: [{ index: 0, embedding: [1, 2, 3] }],
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const { resolvedConfig, agenrConfig } = resolvePluginPaths({ dbPath });
    const services = await createPluginMemoryRuntime({
      dbPath: resolvedConfig.dbPath,
      agenrConfig: { ...agenrConfig, dbPath: resolvedConfig.dbPath },
    });

    expect(services.embeddingStatus).toMatchObject({
      available: true,
      provider: "openai",
      model: "text-embedding-from-config",
    });
    expect(resolvedConfig).toMatchObject({
      configPath: path.join(root, "config.json"),
      dbPath,
    });
    await expect(services.embedding.embed(["remember this"])).resolves.toEqual([[1, 2, 3]]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requestBodies).toMatchObject([
      {
        input: ["remember this"],
        model: "text-embedding-from-config",
      },
    ]);

    await services.close();
  });

  it("preserves recall port methods when cross-encoder wiring is enabled", async () => {
    const root = await createTempRoot("agenr-plugin-runtime-");
    const dbPath = path.join(root, "knowledge.db");
    await writeJson(path.join(root, "config.json"), {
      credentials: {
        openaiApiKey: "config-key",
      },
    });

    const { resolvedConfig, agenrConfig } = resolvePluginPaths({ dbPath });
    const services = await createPluginMemoryRuntime({
      dbPath: resolvedConfig.dbPath,
      agenrConfig: { ...agenrConfig, dbPath: resolvedConfig.dbPath },
    });

    expect(services.recall.crossEncoder).toBeDefined();
    await expect(services.recall.ftsSearch({ text: "remember this", limit: 3 })).resolves.toEqual([]);

    await services.close();
  });

  it("uses configPath when the config file is not adjacent to dbPath", async () => {
    const root = await createTempRoot("agenr-plugin-runtime-");
    const dbPath = path.join(root, "data", "knowledge.db");
    const configPath = path.join(root, "settings", "agenr.json");
    await writeJson(configPath, {
      credentials: {
        openaiApiKey: "explicit-config-key",
      },
      embeddingModel: "text-embedding-explicit",
    });

    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          data: [{ index: 0, embedding: [4, 5, 6] }],
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const { resolvedConfig, agenrConfig } = resolvePluginPaths({ dbPath, configPath });
    const services = await createPluginMemoryRuntime({
      dbPath: resolvedConfig.dbPath,
      agenrConfig: { ...agenrConfig, dbPath: resolvedConfig.dbPath },
    });

    expect(services.embeddingStatus).toMatchObject({
      available: true,
      model: "text-embedding-explicit",
    });
    await expect(services.embedding.embed(["override path"])).resolves.toEqual([[4, 5, 6]]);

    await services.close();
  });

  it("reports unavailable embeddings and omits before-turn embedQuery when credentials are missing", async () => {
    const root = await createTempRoot("agenr-plugin-runtime-");
    const dbPath = path.join(root, "knowledge.db");
    await writeJson(path.join(root, "config.json"), {});

    const { resolvedConfig, agenrConfig } = resolvePluginPaths({ dbPath });
    const services = await createPluginMemoryRuntime({
      dbPath: resolvedConfig.dbPath,
      agenrConfig: { ...agenrConfig, dbPath: resolvedConfig.dbPath },
    });

    expect(services.embeddingStatus).toMatchObject({
      available: false,
      provider: "unconfigured",
    });
    expect(services.embeddingStatus.error).toBeDefined();
    expect(services.beforeTurn.embedQuery).toBeUndefined();
    await expect(services.embedding.embed(["remember this"])).rejects.toThrow();

    await services.close();
  });

  it("threads slot-policy overrides through memory, session-start, and before-turn deps", async () => {
    const root = await createTempRoot("agenr-plugin-runtime-");
    const dbPath = path.join(root, "knowledge.db");
    await writeJson(path.join(root, "config.json"), {
      credentials: {
        openaiApiKey: "config-key",
      },
    });
    const slotPolicies = {
      attributeHeads: {
        "project.name": "exclusive" as const,
      },
    };

    const { resolvedConfig, agenrConfig } = resolvePluginPaths({ dbPath });
    const services = await createPluginMemoryRuntime({
      dbPath: resolvedConfig.dbPath,
      agenrConfig: { ...agenrConfig, dbPath: resolvedConfig.dbPath },
      slotPolicies,
    });

    expect(services.sessionStart.slotPolicyConfig).toEqual(slotPolicies);
    expect(services.beforeTurn.slotPolicyConfig).toEqual(slotPolicies);
    expect(services.sessionStart.repository).toBeDefined();
    expect(services.beforeTurn.recall).toBe(services.recall);

    await services.close();
  });

  it("closes the database exactly once", async () => {
    const root = await createTempRoot("agenr-plugin-runtime-");
    const dbPath = path.join(root, "knowledge.db");
    await writeJson(path.join(root, "config.json"), {
      credentials: {
        openaiApiKey: "config-key",
      },
    });

    const { resolvedConfig, agenrConfig } = resolvePluginPaths({ dbPath });
    const services = await createPluginMemoryRuntime({
      dbPath: resolvedConfig.dbPath,
      agenrConfig: { ...agenrConfig, dbPath: resolvedConfig.dbPath },
    });
    const closeSpy = vi.spyOn(services.entries, "close");

    await services.close();
    await services.close();

    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it("runs onBeforeClose before closing the database", async () => {
    const root = await createTempRoot("agenr-plugin-runtime-");
    const dbPath = path.join(root, "knowledge.db");
    await writeJson(path.join(root, "config.json"), {
      credentials: {
        openaiApiKey: "config-key",
      },
    });
    const events: string[] = [];

    const { resolvedConfig, agenrConfig } = resolvePluginPaths({ dbPath });
    const services = await createPluginMemoryRuntime({
      dbPath: resolvedConfig.dbPath,
      agenrConfig: { ...agenrConfig, dbPath: resolvedConfig.dbPath },
      onBeforeClose: async () => {
        events.push("before-close");
      },
    });
    const closeSpy = vi.spyOn(services.entries, "close").mockImplementation(async () => {
      events.push("database-close");
    });

    await services.close();

    expect(events).toEqual(["before-close", "database-close"]);
    expect(closeSpy).toHaveBeenCalledTimes(1);

    await services.close();
  });
});

describe("resolvePluginPaths", () => {
  usePluginRuntimeEnv();

  it("applies an optional host path resolver", async () => {
    const root = await createTempRoot("agenr-plugin-runtime-");
    await writeJson(path.join(root, "config.json"), {
      credentials: {
        openaiApiKey: "config-key",
      },
    });

    const { resolvedConfig } = resolvePluginPaths({ dbPath: "relative/knowledge.db" }, (input) => path.join(root, input));

    expect(resolvedConfig.dbPath).toBe(path.join(root, "relative/knowledge.db"));
  });
});
