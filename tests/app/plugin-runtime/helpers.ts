import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, vi } from "vitest";

const tempRoots: string[] = [];

const originalEnv = {
  openAiApiKey: process.env.OPENAI_API_KEY,
  agenrConfigDir: process.env.AGENR_CONFIG_DIR,
  agenrConfigPath: process.env.AGENR_CONFIG_PATH,
  agenrDbPath: process.env.AGENR_DB_PATH,
};

/**
 * Clears agenr path env vars before each plugin-runtime test.
 */
export function usePluginRuntimeEnv(): void {
  beforeEach(() => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.AGENR_CONFIG_DIR;
    delete process.env.AGENR_CONFIG_PATH;
    delete process.env.AGENR_DB_PATH;
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();

    while (tempRoots.length > 0) {
      await rm(tempRoots.pop() ?? "", { force: true, recursive: true });
    }

    restoreEnvVar("OPENAI_API_KEY", originalEnv.openAiApiKey);
    restoreEnvVar("AGENR_CONFIG_DIR", originalEnv.agenrConfigDir);
    restoreEnvVar("AGENR_CONFIG_PATH", originalEnv.agenrConfigPath);
    restoreEnvVar("AGENR_DB_PATH", originalEnv.agenrDbPath);
  });
}

/**
 * Creates an isolated temp directory tracked for cleanup.
 *
 * @param prefix - Temp directory prefix.
 * @returns Absolute temp directory path.
 */
export async function createTempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

/**
 * Writes JSON to a temp file, creating parent directories as needed.
 *
 * @param filePath - Destination file path.
 * @param value - JSON-serializable value.
 */
export async function writeJson(filePath: string, value: object): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(value, null, 2));
}

function restoreEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}
