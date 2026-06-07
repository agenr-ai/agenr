import { describe, expect, it } from "vitest";

import {
  coerceAgenrOpenClawPluginConfig,
  createAgenrOpenClawPluginConfigSchema,
  normalizeAgenrOpenClawPluginConfig,
  resolveDebugConfig,
} from "../../../src/adapters/openclaw/config.js";

describe("agenr OpenClaw plugin config", () => {
  it("accepts an empty config so OpenClaw can install the plugin before setup", () => {
    expect(normalizeAgenrOpenClawPluginConfig(undefined)).toEqual({
      ok: true,
      value: {},
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
        episodeModel: "openai/gpt-5.4-mini",
        claimExtractionModel: "openai/gpt-5.4-nano",
        memoryPolicy: {
          beforeTurn: {
            enabled: true,
            procedureSuggestion: false,
            maxDurables: 1,
            recallThreshold: 0.6,
            highConfidenceRecallThreshold: 0.85,
            procedureThreshold: 0.72,
          },
          sessionStart: {
            relevantDurableMemory: false,
          },
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
      episodeModel: "openai/gpt-5.4-mini",
      claimExtractionModel: "openai/gpt-5.4-nano",
      memoryPolicy: {
        beforeTurn: {
          enabled: true,
          procedureSuggestion: false,
          maxDurables: 1,
          recallThreshold: 0.6,
          highConfidenceRecallThreshold: 0.85,
          procedureThreshold: 0.72,
        },
        sessionStart: {
          relevantDurableMemory: false,
        },
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
      episodeModel: "gpt-5.4-mini",
      claimExtractionModel: "gpt-5.4-nano",
    });

    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? [] : parsed.errors).toEqual(
      expect.arrayContaining([
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

  it("rejects invalid nested memory-policy settings", () => {
    const parsed = normalizeAgenrOpenClawPluginConfig({
      memoryPolicy: {
        sessionStart: {
          relevantDurableMemory: "no",
          extra: true,
        },
        beforeTurn: {
          enabled: "yes",
          procedureSuggestion: "sometimes",
          maxDurables: 0,
          recallThreshold: 2,
          highConfidenceRecallThreshold: -1,
          procedureThreshold: "strict",
          extra: true,
        },
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
        "memoryPolicy.sessionStart.relevantDurableMemory must be a boolean when provided",
        "unknown config field: memoryPolicy.sessionStart.extra",
        "memoryPolicy.beforeTurn.enabled must be a boolean when provided",
        "memoryPolicy.beforeTurn.procedureSuggestion must be a boolean when provided",
        "memoryPolicy.beforeTurn.maxDurables must be a positive integer when provided",
        "memoryPolicy.beforeTurn.recallThreshold must be a number between 0 and 1 when provided",
        "memoryPolicy.beforeTurn.highConfidenceRecallThreshold must be a number between 0 and 1 when provided",
        "memoryPolicy.beforeTurn.procedureThreshold must be a number between 0 and 1 when provided",
        "unknown config field: memoryPolicy.beforeTurn.extra",
        "memoryPolicy.slotPolicies.attributeHeads.bad key! must use a canonical attribute-head label",
        'memoryPolicy.slotPolicies.attributeHeads.support must be "exclusive" or "multivalued"',
        "unknown config field: memoryPolicy.slotPolicies.extra",
        "unknown config field: memoryPolicy.surprise",
      ]),
    );
  });

  it("accepts an empty object during schema validation", () => {
    const schema = createAgenrOpenClawPluginConfigSchema();

    expect(schema.validate?.({})).toEqual({
      ok: true,
      value: {},
    });
  });

  it("accepts a fully specified debug block", () => {
    const parsed = normalizeAgenrOpenClawPluginConfig({
      debug: {
        enabled: true,
        logPath: "/tmp/agenr-debug.jsonl",
        eventLevel: "detailed",
        perSessionFiles: true,
        maxTopCandidates: 15,
      },
    });

    expect(parsed).toEqual({
      ok: true,
      value: {
        debug: {
          enabled: true,
          logPath: "/tmp/agenr-debug.jsonl",
          eventLevel: "detailed",
          perSessionFiles: true,
          maxTopCandidates: 15,
        },
      },
    });
  });

  it("rejects invalid debug config fields", () => {
    const parsed = normalizeAgenrOpenClawPluginConfig({
      debug: {
        enabled: "yes",
        logPath: "   ",
        eventLevel: "verbose",
        perSessionFiles: 1,
        maxTopCandidates: 0,
        extra: true,
      },
    });

    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? [] : parsed.errors).toEqual(
      expect.arrayContaining([
        "debug.enabled must be a boolean when provided",
        "debug.logPath must be a non-empty string when provided",
        'debug.eventLevel must be "basic" or "detailed" when provided',
        "debug.perSessionFiles must be a boolean when provided",
        "debug.maxTopCandidates must be an integer between 1 and 25 when provided",
        "unknown config field: debug.extra",
      ]),
    );
  });

  it("resolves default debug-sink settings with safe fall-backs", () => {
    expect(resolveDebugConfig(undefined)).toEqual({
      enabled: false,
      eventLevel: "basic",
      perSessionFiles: false,
      maxTopCandidates: 10,
    });
  });

  it("applies explicit debug-sink settings when provided", () => {
    expect(
      resolveDebugConfig({
        enabled: true,
        logPath: "  /tmp/agenr.jsonl  ",
        eventLevel: "detailed",
        perSessionFiles: true,
        maxTopCandidates: 7,
      }),
    ).toEqual({
      enabled: true,
      logPath: "/tmp/agenr.jsonl",
      eventLevel: "detailed",
      perSessionFiles: true,
      maxTopCandidates: 7,
    });
  });
});
