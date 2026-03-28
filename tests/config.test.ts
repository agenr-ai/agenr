import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { configFileExists, readConfig, writeConfig } from "../src/config.js";

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
    });

    const raw = await readFile(configPath, "utf8");
    expect(raw).toContain('\n  "auth": "openai-api-key"');
    expect(raw).toContain('\n  "provider": "openai"');
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

async function createTempDir(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agenr-config-"));
  tempDirs.push(directory);
  return directory;
}
