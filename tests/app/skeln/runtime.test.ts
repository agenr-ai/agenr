import path from "node:path";

import { describe, expect, it } from "vitest";

import { createAgenrSkelnServices } from "../../../src/adapters/skeln/runtime.js";
import { createTempRoot, usePluginRuntimeEnv, writeJson } from "../../app/plugin-runtime/helpers.js";

describe("createAgenrSkelnServices", () => {
  usePluginRuntimeEnv();

  it("creates claim extraction from agenr config credentials", async () => {
    const root = await createTempRoot("agenr-skeln-runtime-");
    const dbPath = path.join(root, "knowledge.db");
    await writeJson(path.join(root, "config.json"), {
      auth: "openai-api-key",
      credentials: {
        openaiApiKey: "agenr-claim-key",
      },
      claimExtraction: {
        enabled: true,
      },
    });

    const services = await createAgenrSkelnServices({ dbPath });

    expect(services.claimExtraction).toBeDefined();
    expect(services.claimExtraction?.config.enabled).toBe(true);

    await services.close();
  });

  it("skips claim extraction when disabled in agenr config", async () => {
    const root = await createTempRoot("agenr-skeln-runtime-");
    const dbPath = path.join(root, "knowledge.db");
    await writeJson(path.join(root, "config.json"), {
      auth: "openai-api-key",
      credentials: {
        openaiApiKey: "agenr-claim-key",
      },
      claimExtraction: {
        enabled: false,
      },
    });

    const services = await createAgenrSkelnServices({ dbPath });

    expect(services.claimExtraction).toBeUndefined();

    await services.close();
  });

  it("disables claim extraction when agenr credential resolution fails", async () => {
    const root = await createTempRoot("agenr-skeln-runtime-");
    const dbPath = path.join(root, "knowledge.db");
    await writeJson(path.join(root, "config.json"), {
      claimExtraction: {
        enabled: true,
      },
    });

    const services = await createAgenrSkelnServices({ dbPath });

    expect(services.claimExtraction).toBeUndefined();

    await services.close();
  });

  it("returns host wrapper metadata alongside shared memory services", async () => {
    const root = await createTempRoot("agenr-skeln-runtime-");
    const dbPath = path.join(root, "knowledge.db");
    await writeJson(path.join(root, "config.json"), {
      credentials: {
        openaiApiKey: "config-key",
      },
    });

    const services = await createAgenrSkelnServices({ dbPath });

    expect(services.skelnConfig).toEqual({ dbPath });
    expect(services.sessionStart.repository).toBeDefined();
    expect(services.beforeTurn.recall).toBe(services.recall);

    await services.close();
  });
});
