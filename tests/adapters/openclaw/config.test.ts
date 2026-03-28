import { describe, expect, it } from "vitest";

import {
  coerceAgenrOpenClawPluginConfig,
  createAgenrOpenClawPluginConfigSchema,
  normalizeAgenrOpenClawPluginConfig,
} from "../../../src/adapters/openclaw/config.js";

describe("agenr OpenClaw plugin config", () => {
  it("accepts a dbPath-only config", () => {
    const parsed = normalizeAgenrOpenClawPluginConfig({
      dbPath: "/tmp/knowledge.db",
    });

    expect(parsed).toEqual({
      ok: true,
      value: {
        dbPath: "/tmp/knowledge.db",
      },
    });
  });

  it("accepts an optional configPath override", () => {
    expect(
      coerceAgenrOpenClawPluginConfig({
        dbPath: "/tmp/knowledge.db",
        configPath: "/tmp/config.json",
      }),
    ).toEqual({
      dbPath: "/tmp/knowledge.db",
      configPath: "/tmp/config.json",
    });
  });

  it("rejects legacy credential fields", () => {
    const parsed = normalizeAgenrOpenClawPluginConfig({
      dbPath: "/tmp/knowledge.db",
      embeddingApiKey: "test-key",
    });

    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? [] : parsed.errors).toContain("unknown config field: embeddingApiKey");
  });

  it("requires dbPath during schema validation", () => {
    const schema = createAgenrOpenClawPluginConfigSchema();

    expect(schema.validate({})).toEqual({
      ok: false,
      errors: ["dbPath must be a non-empty string"],
    });
  });
});
