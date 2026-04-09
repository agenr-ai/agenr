import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  configFileExists,
  DEFAULT_API_PORT,
  DEFAULT_CLAIM_EXTRACTION_CONCURRENCY,
  DEFAULT_CLAIM_EXTRACTION_CONFIDENCE_THRESHOLD,
  DEFAULT_CLAIM_EXTRACTION_ELIGIBLE_TYPES,
  DEFAULT_SURGEON_CONTEXT_LIMIT,
  DEFAULT_SURGEON_COST_CAP,
  DEFAULT_SURGEON_DAILY_COST_CAP,
  DEFAULT_SURGEON_RETIREMENT_PROTECT_MIN_IMPORTANCE,
  DEFAULT_SURGEON_RETIREMENT_PROTECT_RECALLED_DAYS,
  DEFAULT_SURGEON_SKIP_RECENTLY_EVALUATED_DAYS,
  readConfig,
  resolveClaimExtractionConfig,
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
      surgeon: {
        costCap: DEFAULT_SURGEON_COST_CAP,
        dailyCostCap: DEFAULT_SURGEON_DAILY_COST_CAP,
        contextLimit: DEFAULT_SURGEON_CONTEXT_LIMIT,
        passes: {
          retirement: {
            protectRecalledDays: DEFAULT_SURGEON_RETIREMENT_PROTECT_RECALLED_DAYS,
            protectMinImportance: DEFAULT_SURGEON_RETIREMENT_PROTECT_MIN_IMPORTANCE,
            skipRecentlyEvaluatedDays: DEFAULT_SURGEON_SKIP_RECENTLY_EVALUATED_DAYS,
          },
        },
      },
    });

    const raw = await readFile(configPath, "utf8");
    expect(raw).toContain('\n  "auth": "openai-api-key"');
    expect(raw).toContain('\n  "provider": "openai"');
    expect(raw).not.toContain('"apiPort"');
    expect(raw).not.toContain('"claimExtraction"');
    expect(raw).not.toContain('"surgeon"');
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
