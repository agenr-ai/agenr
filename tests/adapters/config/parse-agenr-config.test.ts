import { describe, expect, it } from "vitest";

import { canonicalizeAgenrConfigInput, parseAgenrConfig, toAgenrConfigInput } from "../../../src/adapters/config/parse-agenr-config.js";
import {
  DEFAULT_API_PORT,
  DEFAULT_AGENR_FEATURE_FLAGS,
  DEFAULT_CLAIM_EXTRACTION_CONCURRENCY,
  DEFAULT_CLAIM_EXTRACTION_CONFIDENCE_THRESHOLD,
  DEFAULT_CLAIM_EXTRACTION_ELIGIBLE_TYPES,
  DEFAULT_DREAMING_CONTEXT_LIMIT_TOKENS,
  DEFAULT_DREAMING_CONTEXT_LOOKUP_MAX_NEIGHBORS,
  DEFAULT_DREAMING_DAILY_COST_CAP,
  DEFAULT_DREAMING_DEEP_INTERVAL_HOURS,
  DEFAULT_DREAMING_EXTRACT_MAX_CHUNKS,
  DEFAULT_DREAMING_EXTRACT_MAX_SESSIONS,
  DEFAULT_DREAMING_IMPORTANCE_THRESHOLD,
  DEFAULT_DREAMING_MAX_PROFILE_DURABLES,
  DEFAULT_DREAMING_MIN_INTERVAL_MINUTES,
  DEFAULT_DREAMING_PRUNE_PROTECT_MIN_IMPORTANCE,
  DEFAULT_DREAMING_PRUNE_PROTECT_RECALLED_DAYS,
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
          contextLimitTokens: DEFAULT_DREAMING_CONTEXT_LIMIT_TOKENS,
          tiers: {
            light: { enabled: true },
            standard: { enabled: true },
            deep: { enabled: true, intervalHours: DEFAULT_DREAMING_DEEP_INTERVAL_HOURS },
          },
          stages: {
            extract: {
              maxSessionsPerRun: DEFAULT_DREAMING_EXTRACT_MAX_SESSIONS,
              maxChunksPerSession: DEFAULT_DREAMING_EXTRACT_MAX_CHUNKS,
              contextLookup: {
                enabled: true,
                maxNeighborsPerCandidate: DEFAULT_DREAMING_CONTEXT_LOOKUP_MAX_NEIGHBORS,
              },
            },
            project: { maxProfileDurables: DEFAULT_DREAMING_MAX_PROFILE_DURABLES },
            prune: {
              protectRecalledDays: DEFAULT_DREAMING_PRUNE_PROTECT_RECALLED_DAYS,
              protectMinImportance: DEFAULT_DREAMING_PRUNE_PROTECT_MIN_IMPORTANCE,
            },
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
