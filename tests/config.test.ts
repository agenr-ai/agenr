import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  configFileExists,
  DEFAULT_API_PORT,
  DEFAULT_AGENR_FEATURE_FLAGS,
  DEFAULT_CLAIM_EXTRACTION_CONCURRENCY,
  DEFAULT_CLAIM_EXTRACTION_CONFIDENCE_THRESHOLD,
  DEFAULT_CLAIM_EXTRACTION_ELIGIBLE_TYPES,
  DEFAULT_DREAMING_CONTEXT_LIMIT_TOKENS,
  DEFAULT_DREAMING_DAILY_COST_CAP,
  DEFAULT_DREAMING_PRUNE_PROTECT_MIN_IMPORTANCE,
  DEFAULT_DREAMING_PRUNE_PROTECT_RECALLED_DAYS,
  readConfig,
  resolveClaimExtractionConfig,
  resolveConfigPath,
  writeConfig,
} from "../src/config.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

describe("writeConfig", () => {
  it("creates the config directory and writes pretty JSON", async () => {
    const directory = await createTempDir();
    const configPath = path.join(directory, ".agenr", "config.json");

    writeConfig(
      {
        auth: "openai-api-key",
        provider: "openai",
        model: "gpt-5.4-mini",
        credentials: {
          openaiApiKey: "sk-test",
        },
        dbPath: path.join(directory, "knowledge.db"),
      },
      { configPath },
    );

    expect(configFileExists({ configPath })).toBe(true);
    expect(readConfig({ configPath })).toEqual({
      auth: "openai-api-key",
      provider: "openai",
      model: "gpt-5.4-mini",
      credentials: {
        openaiApiKey: "sk-test",
      },
      dbPath: path.join(directory, "knowledge.db"),
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
          deep: { enabled: true, intervalHours: 168 },
        },
        stages: {
          extract: {
            maxSessionsPerRun: 8,
            maxChunksPerSession: 12,
            contextLookup: { enabled: true, maxNeighborsPerCandidate: 5 },
          },
          project: { maxProfileDurables: 8 },
          prune: {
            protectRecalledDays: DEFAULT_DREAMING_PRUNE_PROTECT_RECALLED_DAYS,
            protectMinImportance: DEFAULT_DREAMING_PRUNE_PROTECT_MIN_IMPORTANCE,
          },
        },
        triggers: {
          postSessionLightDream: true,
          importanceThreshold: 25,
          minIntervalMinutes: 30,
        },
      },
      features: DEFAULT_AGENR_FEATURE_FLAGS,
    });

    const raw = await readFile(configPath, "utf8");
    expect(raw).toContain('\n  "auth": "openai-api-key"');
    expect(raw).toContain('\n  "provider": "openai"');
    expect(raw).not.toContain('"apiPort"');
    expect(raw).not.toContain('"claimExtraction"');
    expect(raw).not.toContain('"dreaming"');
    expect(raw.endsWith("\n")).toBe(true);
  });

  it("locks the file down to 0600 when the platform supports chmod modes", async () => {
    const directory = await createTempDir();
    const configPath = path.join(directory, ".agenr", "config.json");

    writeConfig(
      {
        auth: "openai-api-key",
        provider: "openai",
        model: "gpt-5.4-mini",
        credentials: {
          openaiApiKey: "sk-test",
        },
      },
      { configPath },
    );

    if (process.platform !== "win32") {
      const configStat = await stat(configPath);
      expect(configStat.mode & 0o777).toBe(0o600);
    }
  });

  it("writes through file URL config paths", async () => {
    const directory = await createTempDir();
    const configPath = path.join(directory, "config with spaces", "config.json");
    const configUrl = pathToFileURL(configPath).href;

    writeConfig(
      {
        auth: "openai-api-key",
        provider: "openai",
        model: "gpt-5.4-mini",
        credentials: {
          openaiApiKey: "sk-test",
        },
      },
      { configPath: configUrl },
    );

    expect(configFileExists({ configPath: configUrl })).toBe(true);
    expect(readConfig({ configPath: configUrl })).toMatchObject({
      credentials: {
        openaiApiKey: "sk-test",
      },
    });
  });
});

describe("resolveConfigPath", () => {
  it("places adjacent config next to relative file URL database paths", () => {
    expect(resolveConfigPath({ dbPath: "file:relative%20db/knowledge.db" })).toBe(path.resolve("relative db", "config.json"));
  });
});

describe("readConfig", () => {
  it("rejects legacy auth fields with migration guidance", async () => {
    const directory = await createTempDir();
    const configPath = path.join(directory, ".agenr", "config.json");

    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({
        auth: "openai-api-key",
        apiKey: "legacy-key",
      }),
    );

    expect(() => readConfig({ configPath })).toThrow(/invalid agenr config/i);
    expect(() => readConfig({ configPath })).toThrow(/apiKey/);
    expect(() => readConfig({ configPath })).toThrow(/credentials\.openaiApiKey|credentials\.anthropicApiKey/i);
  });

  it("fails loudly on malformed JSON", async () => {
    const directory = await createTempDir();
    const configPath = path.join(directory, ".agenr", "config.json");

    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, '{"provider":"openai"', "utf8");

    expect(() => readConfig({ configPath })).toThrow(/json parse failed/i);
  });
});

describe("resolveClaimExtractionConfig", () => {
  it("defaults claim extraction concurrency to 10", () => {
    expect(resolveClaimExtractionConfig()).toMatchObject({
      concurrency: 10,
    });
  });

  it("normalizes invalid claim extraction concurrency back to 10", () => {
    expect(
      resolveClaimExtractionConfig({
        claimExtraction: {
          concurrency: 0,
        },
      }),
    ).toMatchObject({
      concurrency: 10,
    });
  });

  it("keeps explicit positive claim extraction concurrency", () => {
    expect(
      resolveClaimExtractionConfig({
        claimExtraction: {
          concurrency: 24,
        },
      }),
    ).toMatchObject({
      concurrency: 24,
    });
  });
});

async function createTempDir(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agenr-config-"));
  tempDirs.push(directory);
  return directory;
}
