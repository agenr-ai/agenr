import { describe, expect, it } from "vitest";

import {
  coerceAgenrOpenClawPluginConfig,
  createAgenrOpenClawPluginConfigSchema,
  normalizeAgenrOpenClawPluginConfig,
  resolveStoreNudgeConfig,
} from "../../../src/adapters/openclaw/config.js";

describe("agenr OpenClaw plugin config", () => {
  it("accepts an empty config so OpenClaw can install the plugin before setup", () => {
    expect(normalizeAgenrOpenClawPluginConfig(undefined)).toEqual({
      ok: true,
      value: {},
    });
  });

  it("resolves default store-nudge settings when the nested config is omitted", () => {
    expect(resolveStoreNudgeConfig(undefined)).toEqual({
      enabled: true,
      threshold: 8,
      maxPerSession: 5,
    });
  });

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
        continuityModel: "openai/gpt-5.4-mini",
        episodeModel: "openai/gpt-5.4-mini",
        claimExtractionModel: "openai/gpt-5.4-nano",
        storeNudge: {
          threshold: 10,
        },
        memoryPolicy: {
          slotPolicies: {
            attributeHeads: {
              integration: "exclusive",
              preference: "multivalued",
            },
          },
        },
      }),
    ).toEqual({
      dbPath: "/tmp/knowledge.db",
      configPath: "/tmp/config.json",
      continuityModel: "openai/gpt-5.4-mini",
      episodeModel: "openai/gpt-5.4-mini",
      claimExtractionModel: "openai/gpt-5.4-nano",
      storeNudge: {
        enabled: true,
        threshold: 10,
        maxPerSession: 5,
      },
      memoryPolicy: {
        slotPolicies: {
          attributeHeads: {
            integration: "exclusive",
            preference: "multivalued",
          },
        },
      },
    });
  });

  it("rejects model overrides that do not use provider/model format", () => {
    const parsed = normalizeAgenrOpenClawPluginConfig({
      continuityModel: "gpt-5.4-mini",
      episodeModel: "gpt-5.4-mini",
      claimExtractionModel: "gpt-5.4-nano",
    });

    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? [] : parsed.errors).toEqual(
      expect.arrayContaining([
        "continuityModel must use provider/model format when provided",
        "episodeModel must use provider/model format when provided",
        "claimExtractionModel must use provider/model format when provided",
      ]),
    );
  });

  it("rejects legacy credential fields", () => {
    const parsed = normalizeAgenrOpenClawPluginConfig({
      dbPath: "/tmp/knowledge.db",
      embeddingApiKey: "test-key",
    });

    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? [] : parsed.errors).toContain("unknown config field: embeddingApiKey");
  });

  it("rejects invalid nested store-nudge settings", () => {
    const parsed = normalizeAgenrOpenClawPluginConfig({
      storeNudge: {
        enabled: "yes",
        threshold: 0,
        maxPerSession: -1,
        extra: true,
      },
    });

    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? [] : parsed.errors).toEqual(
      expect.arrayContaining([
        "storeNudge.enabled must be a boolean when provided",
        "storeNudge.threshold must be a positive integer when provided",
        "storeNudge.maxPerSession must be a positive integer when provided",
        "unknown config field: storeNudge.extra",
      ]),
    );
  });

  it("rejects invalid nested memory-policy settings", () => {
    const parsed = normalizeAgenrOpenClawPluginConfig({
      memoryPolicy: {
        slotPolicies: {
          attributeHeads: {
            "bad key!": "exclusive",
            support: "sometimes",
          },
          extra: true,
        },
        surprise: true,
      },
    });

    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? [] : parsed.errors).toEqual(
      expect.arrayContaining([
        "memoryPolicy.slotPolicies.attributeHeads.bad key! must use a canonical attribute-head label",
        'memoryPolicy.slotPolicies.attributeHeads.support must be "exclusive" or "multivalued"',
        "unknown config field: memoryPolicy.slotPolicies.extra",
        "unknown config field: memoryPolicy.surprise",
      ]),
    );
  });

  it("accepts an empty object during schema validation", () => {
    const schema = createAgenrOpenClawPluginConfigSchema();

    expect(schema.validate({})).toEqual({
      ok: true,
      value: {},
    });
  });
});
