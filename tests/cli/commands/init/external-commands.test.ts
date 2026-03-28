import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { writeOpenClawPluginConfig } from "../../../../src/cli/commands/init/external-commands.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

describe("writeOpenClawPluginConfig", () => {
  it("enables agenr as the active memory plugin and stores db/config paths", async () => {
    const stateDir = await createTempDir();
    const openclawConfigPath = path.join(stateDir, "openclaw.json");
    await writeFile(openclawConfigPath, JSON.stringify({ plugins: { allow: ["other"] } }, null, 2), "utf8");

    const writtenPath = await writeOpenClawPluginConfig(stateDir, {
      dbPath: "/tmp/agenr/knowledge.db",
      configPath: "/tmp/other/config.json",
    });

    expect(writtenPath).toBe(openclawConfigPath);

    const parsed = JSON.parse(await readFile(openclawConfigPath, "utf8")) as {
      plugins: {
        allow: string[];
        slots: {
          memory: string;
        };
        entries: {
          agenr: {
            enabled: boolean;
            config: {
              dbPath: string;
              configPath: string;
            };
          };
        };
      };
    };

    expect(parsed.plugins.allow).toEqual(["other", "agenr"]);
    expect(parsed.plugins.slots.memory).toBe("agenr");
    expect(parsed.plugins.entries.agenr.enabled).toBe(true);
    expect(parsed.plugins.entries.agenr.config).toEqual({
      dbPath: "/tmp/agenr/knowledge.db",
      configPath: "/tmp/other/config.json",
    });
  });

  it("omits configPath when the config file is adjacent to the database", async () => {
    const stateDir = await createTempDir();

    await writeOpenClawPluginConfig(stateDir, {
      dbPath: "/tmp/agenr/knowledge.db",
      configPath: "/tmp/agenr/config.json",
    });

    const parsed = JSON.parse(await readFile(path.join(stateDir, "openclaw.json"), "utf8")) as {
      plugins: {
        entries: {
          agenr: {
            config: {
              dbPath: string;
              configPath?: string;
            };
          };
        };
      };
    };

    expect(parsed.plugins.entries.agenr.config).toEqual({
      dbPath: "/tmp/agenr/knowledge.db",
    });
  });
});

async function createTempDir(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agenr-openclaw-config-"));
  tempDirs.push(directory);
  return directory;
}
