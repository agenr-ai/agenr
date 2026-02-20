import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeConfig, readConfig, resolveConfigPath, writeConfig } from "../src/config.js";
import type { AgenrConfig } from "../src/types.js";

const tempDirs: string[] = [];

function makeEnv(configPath: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    AGENR_CONFIG_PATH: configPath,
  };
}

async function makeTempConfigPath(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agenr-config-test-"));
  tempDirs.push(dir);
  return path.join(dir, "nested", "config.json");
}

afterEach(async () => {
  for (const dir of tempDirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }
  tempDirs.length = 0;
});

describe("config", () => {
  it("writes and reads config roundtrip", async () => {
    const configPath = await makeTempConfigPath();
    const env = makeEnv(configPath);

    const config: AgenrConfig = {
      auth: "anthropic-token",
      provider: "anthropic",
      model: "claude-opus-4-6",
      credentials: {
        anthropicOauthToken: "token-123",
        anthropicApiKey: "sk-ant",
      },
    };

    writeConfig(config, env);
    const loaded = readConfig(env);

    expect(loaded).toMatchObject(config);
    expect(loaded?.embedding).toEqual({
      provider: "openai",
      model: "text-embedding-3-small",
      dimensions: 1024,
    });
    expect(loaded?.db?.path).toBe(path.join(os.homedir(), ".agenr", "knowledge.db"));
    expect(loaded?.forgetting).toEqual({
      protect: [],
      scoreThreshold: 0.05,
      maxAgeDays: 60,
      enabled: true,
    });
  });

  it("returns null when config does not exist", async () => {
    const configPath = await makeTempConfigPath();
    const env = makeEnv(configPath);

    const loaded = readConfig(env);
    expect(loaded).toBeNull();
  });

  it("sets secure file and directory permissions", async () => {
    const configPath = await makeTempConfigPath();
    const env = makeEnv(configPath);

    writeConfig(
      {
        auth: "openai-api-key",
        provider: "openai",
        model: "gpt-5.2-codex",
      },
      env,
    );

    const configStat = await fs.stat(resolveConfigPath(env));
    const dirStat = await fs.stat(path.dirname(resolveConfigPath(env)));

    expect(configStat.mode & 0o777).toBe(0o600);
    expect(dirStat.mode & 0o777).toBe(0o700);
  });

  it("normalizes partial config files without crashing", async () => {
    const configPath = await makeTempConfigPath();
    const env = makeEnv(configPath);
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(
      configPath,
      JSON.stringify({
        provider: "anthropic",
        credentials: {
          anthropicApiKey: "sk-ant-test",
          ignoredField: "x",
        },
      }),
      "utf8",
    );

    const loaded = readConfig(env);
    expect(loaded).toEqual({
      embedding: {
        provider: "openai",
        model: "text-embedding-3-small",
        dimensions: 1024,
      },
      db: {
        path: path.join(os.homedir(), ".agenr", "knowledge.db"),
      },
      forgetting: {
        protect: [],
        scoreThreshold: 0.05,
        maxAgeDays: 60,
        enabled: true,
      },
      provider: "anthropic",
      credentials: {
        anthropicApiKey: "sk-ant-test",
      },
    });
  });

  it("preserves forgetting config through normalizeConfig", () => {
    const normalized = normalizeConfig({
      forgetting: {
        protect: ["EJA identity", "project-*"],
        scoreThreshold: 0.04,
        maxAgeDays: 45,
        enabled: true,
      },
    });

    expect(normalized.forgetting).toEqual({
      protect: ["EJA identity", "project-*"],
      scoreThreshold: 0.04,
      maxAgeDays: 45,
      enabled: true,
    });
  });

  it("applies forgetting defaults when missing", () => {
    const normalized = normalizeConfig({});
    expect(normalized.forgetting).toEqual({
      protect: [],
      scoreThreshold: 0.05,
      maxAgeDays: 60,
      enabled: true,
    });
  });

  it("preserves labelProjectMap through normalizeConfig", () => {
    const normalized = normalizeConfig({
      labelProjectMap: {
        agenr: "agenr",
      },
    });

    expect(normalized.labelProjectMap).toEqual({
      agenr: "agenr",
    });
  });

  it("drops non-object labelProjectMap values", () => {
    expect(normalizeConfig({ labelProjectMap: null }).labelProjectMap).toBeUndefined();
    expect(normalizeConfig({ labelProjectMap: "agenr" }).labelProjectMap).toBeUndefined();
    expect(normalizeConfig({ labelProjectMap: ["agenr"] }).labelProjectMap).toBeUndefined();
  });

  it("keeps only string-valued entries in labelProjectMap", () => {
    const normalized = normalizeConfig({
      labelProjectMap: {
        " Agenr_dev ": "agenr",
        openclaw: " openclaw ",
        badNumber: 123,
        badObject: { project: "agenr" },
      },
    });

    expect(normalized.labelProjectMap).toEqual({
      "agenr-dev": "agenr",
      openclaw: "openclaw",
    });
  });

  it("drops empty labelProjectMap objects", () => {
    expect(normalizeConfig({ labelProjectMap: {} }).labelProjectMap).toBeUndefined();
  });

  it("preserves dedup config through normalizeConfig", () => {
    const normalized = normalizeConfig({
      dedup: {
        aggressive: true,
        threshold: 0.72,
      },
    });

    expect(normalized.dedup).toEqual({
      aggressive: true,
      threshold: 0.72,
    });
  });

  it("drops invalid dedup config values", () => {
    expect(normalizeConfig({ dedup: "yes" }).dedup).toBeUndefined();
    expect(normalizeConfig({ dedup: { aggressive: "yes", threshold: 2 } }).dedup).toBeUndefined();
  });
});

describe("normalizeConfig dedup", () => {
  it("normalizeConfig ignores missing dedup key", () => {
    const config = normalizeConfig({ signalMinImportance: 8 });
    expect(config.dedup).toBeUndefined();
  });

  it("normalizeConfig accepts aggressive: true with no threshold", () => {
    const config = normalizeConfig({ dedup: { aggressive: true } });
    expect(config.dedup).toEqual({ aggressive: true });
    expect(config.dedup?.threshold).toBeUndefined();
  });

  it("normalizeConfig accepts threshold in range 0-1", () => {
    const config = normalizeConfig({ dedup: { threshold: 0.65 } });
    expect(config.dedup?.threshold).toBe(0.65);
  });

  it("normalizeConfig rejects threshold out of range", () => {
    const config = normalizeConfig({ dedup: { threshold: 1.5 } });
    expect(config.dedup?.threshold).toBeUndefined();
  });

  it("normalizeConfig rejects non-boolean aggressive", () => {
    const config = normalizeConfig({ dedup: { aggressive: "yes" } });
    expect(config.dedup?.aggressive).toBeUndefined();
  });

  it("normalizeConfig returns undefined dedup for empty object", () => {
    const config = normalizeConfig({ dedup: {} });
    expect(config.dedup).toBeUndefined();
  });
});
