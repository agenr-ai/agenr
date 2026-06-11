import { describe, expect, it } from "vitest";

import { canonicalizeAgenrConfigInput, parseAgenrConfig, toAgenrConfigInput } from "../../../src/adapters/config/parse-agenr-config.js";
import {
  DEFAULT_API_PORT,
  DEFAULT_AGENR_FEATURE_FLAGS,
  DEFAULT_CLAIM_EXTRACTION_CONCURRENCY,
  DEFAULT_CLAIM_EXTRACTION_CONFIDENCE_THRESHOLD,
  DEFAULT_CLAIM_EXTRACTION_ELIGIBLE_TYPES,
  DEFAULT_DREAMING_DAILY_COST_CAP,
  DEFAULT_DREAMING_DEEP_INTERVAL_HOURS,
  DEFAULT_DREAMING_EXTRACT_MAX_SESSIONS,
  DEFAULT_DREAMING_LIGHT_MAX_SESSIONS,
  DEFAULT_DREAMING_IMPORTANCE_THRESHOLD,
  DEFAULT_DREAMING_MAX_PROFILE_DURABLES,
  DEFAULT_DREAMING_MIN_INTERVAL_MINUTES,
  DEFAULT_DREAMING_PRUNE_PROTECT_MIN_IMPORTANCE,
  DEFAULT_DREAMING_PRUNE_PROTECT_RECALLED_DAYS,
  DEFAULT_DREAMING_WORKING_SET_RETENTION_DAYS,
} from "../../../src/config.js";

const DEFAULT_DB_PATH = "/tmp/agenr-default/knowledge.db";

describe("parseAgenrConfig", () => {
  it("resolves defaults for a valid partial config", () => {
    const result = parseAgenrConfig(
      {
        provider: "openai",
        model: "gpt-5.4-mini",
        credentials: {
          openaiApiKey: "sk-test",
        },
      },
      { defaultDbPath: DEFAULT_DB_PATH },
    );

    expect(result).toEqual({
      ok: true,
      value: {
        provider: "openai",
        model: "gpt-5.4-mini",
        credentials: {
          openaiApiKey: "sk-test",
        },
        dbPath: DEFAULT_DB_PATH,
        apiPort: DEFAULT_API_PORT,
        claimExtraction: {
          enabled: true,
          confidenceThreshold: DEFAULT_CLAIM_EXTRACTION_CONFIDENCE_THRESHOLD,
          eligibleTypes: [...DEFAULT_CLAIM_EXTRACTION_ELIGIBLE_TYPES],
          concurrency: DEFAULT_CLAIM_EXTRACTION_CONCURRENCY,
        },
        dreaming: {
          dailyCostCap: DEFAULT_DREAMING_DAILY_COST_CAP,
          tiers: {
            light: { enabled: true },
            standard: { enabled: true },
            deep: { enabled: true, intervalHours: DEFAULT_DREAMING_DEEP_INTERVAL_HOURS },
          },
          stages: {
            extract: {
              maxSessionsPerRun: DEFAULT_DREAMING_EXTRACT_MAX_SESSIONS,
              lightMaxSessionsPerRun: DEFAULT_DREAMING_LIGHT_MAX_SESSIONS,
              contextLookup: { enabled: true },
            },
            project: { maxProfileDurables: DEFAULT_DREAMING_MAX_PROFILE_DURABLES },
            prune: {
              protectRecalledDays: DEFAULT_DREAMING_PRUNE_PROTECT_RECALLED_DAYS,
              protectMinImportance: DEFAULT_DREAMING_PRUNE_PROTECT_MIN_IMPORTANCE,
            },
            reap: { workingSetRetentionDays: DEFAULT_DREAMING_WORKING_SET_RETENTION_DAYS },
          },
          triggers: {
            postSessionLightDream: true,
            importanceThreshold: DEFAULT_DREAMING_IMPORTANCE_THRESHOLD,
            minIntervalMinutes: DEFAULT_DREAMING_MIN_INTERVAL_MINUTES,
          },
        },
        features: DEFAULT_AGENR_FEATURE_FLAGS,
      },
    });
  });

  it("reports explicit issues for wrong-shaped nested fields", () => {
    const result = parseAgenrConfig(
      {
        provider: "bogus",
        credentials: "sk-test",
        claimExtraction: {
          concurrency: 0,
        },
        dreaming: {
          stages: {
            prune: {
              protectMinImportance: -1,
            },
          },
        },
        apiPort: "3000",
        features: {
          workingMemory: "yes",
          extraFlag: true,
        },
      },
      { defaultDbPath: DEFAULT_DB_PATH },
    );

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("Expected config parse to fail.");
    }

    expect(result.issues).toEqual(
      expect.arrayContaining([
        { path: "provider", message: "Expected a supported provider." },
        { path: "credentials", message: "Expected an object." },
        { path: "claimExtraction.concurrency", message: "Expected a positive integer." },
        { path: "dreaming.stages.prune.protectMinImportance", message: "Expected a non-negative integer." },
        { path: "apiPort", message: "Expected an integer from 1 to 65535." },
        { path: "features.workingMemory", message: "Expected a boolean." },
        { path: "features.extraFlag", message: "Unexpected field." },
      ]),
    );
  });

  it("parses dreaming tier, stage, and trigger overrides", () => {
    const result = parseAgenrConfig(
      {
        dreaming: {
          tiers: {
            light: { enabled: false },
            deep: { intervalHours: 48 },
          },
          stages: {
            extract: {
              maxSessionsPerRun: 3,
              lightMaxSessionsPerRun: 1,
              contextLookup: { enabled: false },
            },
            project: { maxProfileDurables: 4 },
            prune: { protectRecalledDays: 3, protectMinImportance: 8 },
            reap: { workingSetRetentionDays: 14 },
          },
          triggers: {
            postSessionLightDream: false,
            importanceThreshold: 12,
            minIntervalMinutes: 5,
          },
        },
      },
      { defaultDbPath: DEFAULT_DB_PATH },
    );

    expect(result).toEqual({
      ok: true,
      value: expect.objectContaining({
        dreaming: expect.objectContaining({
          tiers: {
            light: { enabled: false },
            standard: { enabled: true },
            deep: { enabled: true, intervalHours: 48 },
          },
          stages: {
            extract: {
              maxSessionsPerRun: 3,
              lightMaxSessionsPerRun: 1,
              contextLookup: { enabled: false },
            },
            project: { maxProfileDurables: 4 },
            prune: { protectRecalledDays: 3, protectMinImportance: 8 },
            reap: { workingSetRetentionDays: 14 },
          },
          triggers: {
            postSessionLightDream: false,
            importanceThreshold: 12,
            minIntervalMinutes: 5,
          },
        }),
      }),
    });

    if (!result.ok) {
      throw new Error("Expected config parse to succeed.");
    }
    expect(toAgenrConfigInput(result.value).dreaming).toEqual({
      tiers: {
        light: { enabled: false },
        deep: { intervalHours: 48 },
      },
      stages: {
        extract: {
          maxSessionsPerRun: 3,
          lightMaxSessionsPerRun: 1,
          contextLookup: { enabled: false },
        },
        project: { maxProfileDurables: 4 },
        prune: { protectRecalledDays: 3, protectMinImportance: 8 },
        reap: { workingSetRetentionDays: 14 },
      },
      triggers: {
        postSessionLightDream: false,
        importanceThreshold: 12,
        minIntervalMinutes: 5,
      },
    });
  });

  it("rejects dreaming config fields that the runtime no longer consumes", () => {
    const result = parseAgenrConfig(
      {
        dreaming: {
          contextLimitTokens: 1000,
          customInstructions: "Prefer cautious synthesis.",
          stages: {
            extract: {
              maxChunksPerSession: 5,
              contextLookup: {
                maxNeighborsPerCandidate: 2,
              },
            },
          },
        },
      },
      { defaultDbPath: DEFAULT_DB_PATH },
    );

    expect(result).toEqual({
      ok: false,
      issues: [
        { path: "dreaming.contextLimitTokens", message: "Unexpected field." },
        { path: "dreaming.customInstructions", message: "Unexpected field." },
        { path: "dreaming.stages.extract.maxChunksPerSession", message: "Unexpected field." },
        { path: "dreaming.stages.extract.contextLookup.maxNeighborsPerCandidate", message: "Unexpected field." },
      ],
    });
  });

  it("parses feature flags as default-off sparse rollout controls", () => {
    const result = parseAgenrConfig(
      {
        features: {
          workingMemory: true,
          sessionTreeLineage: false,
          sessionTreeCompaction: true,
          goalContinuation: false,
        },
      },
      { defaultDbPath: DEFAULT_DB_PATH },
    );

    expect(result).toEqual({
      ok: true,
      value: expect.objectContaining({
        features: {
          workingMemory: true,
          sessionTreeLineage: false,
          sessionTreeCompaction: true,
          goalContinuation: false,
        },
      }),
    });
  });

  it("rejects mismatched auth and provider combinations", () => {
    const result = parseAgenrConfig(
      {
        auth: "openai-api-key",
        provider: "anthropic",
      },
      { defaultDbPath: DEFAULT_DB_PATH },
    );

    expect(result).toEqual({
      ok: false,
      issues: [{ path: "provider", message: 'Provider "anthropic" does not match auth method "openai-api-key".' }],
    });
  });
});

describe("canonicalizeAgenrConfigInput", () => {
  it("trims persisted values and preserves only explicit fields", () => {
    const result = canonicalizeAgenrConfigInput(
      {
        provider: "  openai  ",
        model: " gpt-5.4-mini ",
        credentials: {
          openaiApiKey: " sk-test ",
        },
        claimExtraction: {
          enabled: false,
        },
        features: {
          workingMemory: true,
          sessionTreeLineage: false,
        },
      },
      { defaultDbPath: DEFAULT_DB_PATH },
    );

    expect(result).toEqual({
      ok: true,
      value: {
        provider: "openai",
        model: "gpt-5.4-mini",
        credentials: {
          openaiApiKey: "sk-test",
        },
        claimExtraction: {
          enabled: false,
        },
        features: {
          workingMemory: true,
        },
      },
    });
  });
});

describe("parseAgenrConfig legacy keys", () => {
  it("rejects the removed surgeon top-level block with a migration message", () => {
    const result = parseAgenrConfig(
      {
        surgeon: {
          model: "gpt-5.4-mini",
        },
      },
      { defaultDbPath: DEFAULT_DB_PATH },
    );

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("Expected config parse to fail.");
    }

    expect(result.issues).toEqual(
      expect.arrayContaining([
        {
          path: "surgeon",
          message: 'Removed field. Rename the top-level "surgeon" block to "dreaming", then delete surgeon.',
        },
      ]),
    );
  });
});

describe("toAgenrConfigInput", () => {
  it("strips resolved defaults back to the sparse persisted shape", () => {
    const parsed = parseAgenrConfig(
      {
        provider: "openai",
        model: "gpt-5.4-mini",
        dbPath: "/tmp/custom.db",
        claimExtraction: {
          enabled: false,
        },
        features: {
          workingMemory: true,
        },
      },
      { defaultDbPath: DEFAULT_DB_PATH },
    );

    if (!parsed.ok) {
      throw new Error("Expected config parse to succeed.");
    }

    expect(toAgenrConfigInput(parsed.value, { defaultDbPath: DEFAULT_DB_PATH })).toEqual({
      provider: "openai",
      model: "gpt-5.4-mini",
      dbPath: "/tmp/custom.db",
      claimExtraction: {
        enabled: false,
      },
      features: {
        workingMemory: true,
      },
    });
  });
});
