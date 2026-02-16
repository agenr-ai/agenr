import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readConfig, resolveConfigPath, writeConfig } from "../src/config.js";
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
      provider: "anthropic",
      credentials: {
        anthropicApiKey: "sk-ant-test",
      },
    });
  });
});
