import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const llmMocks = vi.hoisted(() => ({
  createLlmClient: vi.fn(),
  resolveLlmCredentials: vi.fn(),
}));

vi.mock("../../../src/adapters/llm.js", async (importActual) => {
  const actual = await importActual<typeof import("../../../src/adapters/llm.js")>();
  return {
    ...actual,
    createLlmClient: llmMocks.createLlmClient,
    resolveLlmCredentials: llmMocks.resolveLlmCredentials,
  };
});

import { createDatabase } from "../../../src/adapters/db/client.js";
import { loadDreamStatusRuntime, runDreamRuntime } from "../../../src/app/dreaming/runtime.js";
import type { LlmPort } from "../../../src/core/ports.js";

class RuntimeExtractLlm implements LlmPort {
  public readonly metadata = { usage: { inputTokens: 0, outputTokens: 0, totalCost: 0 } };

  public constructor(
    private readonly durables: Array<Record<string, unknown>>,
    private readonly costPerCall = 0,
  ) {}

  public async complete(): Promise<string> {
    throw new Error("complete() is not used by the runtime extract stage.");
  }

  public async completeJson<T>(): Promise<T> {
    this.metadata.usage.inputTokens += 1;
    this.metadata.usage.totalCost += this.costPerCall;
    return { durables: this.durables } as T;
  }
}

const tempDirs: string[] = [];
const originalConfigPath = process.env.AGENR_CONFIG_PATH;
const originalDbPath = process.env.AGENR_DB_PATH;

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.AGENR_CONFIG_PATH;
  delete process.env.AGENR_DB_PATH;
});

afterEach(async () => {
  restoreEnv("AGENR_CONFIG_PATH", originalConfigPath);
  restoreEnv("AGENR_DB_PATH", originalDbPath);
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

describe("runDreamRuntime", () => {
  it("wires the extract LLM from the dreaming model config", async () => {
    const { configPath, dbPath } = await createRuntimeFixture({
      config: {
        provider: "openai",
        model: "gpt-5.4-mini",
        dreaming: {
          dailyCostCap: 5,
          model: {
            provider: "anthropic",
            model: "claude-dream",
          },
        },
      },
    });
    await insertEpisode(dbPath, "ep-1", "Session recording a durable runtime wiring preference.");

    const llm = new RuntimeExtractLlm(
      [{ type: "fact", subject: "Runtime wiring", content: "Dreaming runtime uses the configured model.", claim_key: "agenr/runtime_wiring" }],
      0.12,
    );
    const env = { AGENR_CONFIG_PATH: configPath, ANTHROPIC_API_KEY: "env-anthropic-key" };
    llmMocks.resolveLlmCredentials.mockReturnValue({ apiKey: "resolved-anthropic-key", source: "test-env" });
    llmMocks.createLlmClient.mockReturnValue(llm);

    const result = await runDreamRuntime({ tier: "standard", apply: false, verbose: false, json: false, env });

    expect(result.status).toBe("completed");
    expect(result.completionSummary?.extract?.candidatesEmitted).toBe(1);
    expect(result.estimatedCostUsd).toBe(0.12);
    expect(llmMocks.resolveLlmCredentials).toHaveBeenCalledWith(expect.objectContaining({ dbPath }), "anthropic", env);
    expect(llmMocks.createLlmClient).toHaveBeenCalledWith("anthropic", "claude-dream", { apiKey: "resolved-anthropic-key" });
  });
});

describe("loadDreamStatusRuntime", () => {
  it("uses the supplied env config path without mutating env state", async () => {
    const { configPath, dbPath, directory } = await createRuntimeFixture({
      config: {
        provider: "openai",
        model: "gpt-5.4-mini",
      },
    });
    await initializeDatabase(dbPath);
    const invalidConfigPath = path.join(directory, "invalid-config.json");
    await writeFile(invalidConfigPath, "{not valid json", "utf8");
    process.env.AGENR_CONFIG_PATH = invalidConfigPath;

    const env = { AGENR_CONFIG_PATH: configPath };
    const envBefore = { ...env };

    const status = await loadDreamStatusRuntime({ env });

    expect(status.health.total).toBe(0);
    expect(env).toEqual(envBefore);
    expect(process.env.AGENR_CONFIG_PATH).toBe(invalidConfigPath);
  });
});

async function createRuntimeFixture(input: { config: Record<string, unknown> }): Promise<{ directory: string; configPath: string; dbPath: string }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agenr-dream-runtime-"));
  tempDirs.push(directory);
  const dbPath = path.join(directory, "knowledge.db");
  const configPath = path.join(directory, "config.json");
  await writeRuntimeConfig(configPath, { ...input.config, dbPath });
  return { directory, configPath, dbPath };
}

async function writeRuntimeConfig(configPath: string, config: Record<string, unknown>): Promise<void> {
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

async function initializeDatabase(dbPath: string): Promise<void> {
  const database = await createDatabase(dbPath);
  await database.close();
}

async function insertEpisode(dbPath: string, id: string, summary: string): Promise<void> {
  const database = await createDatabase(dbPath);
  try {
    await database.execute({
      sql: `
        INSERT INTO episodes (id, source, source_id, started_at, ended_at, summary, created_at, updated_at)
        VALUES (?, 'openclaw', ?, '2026-04-04T10:00:00.000Z', '2026-04-04T11:00:00.000Z', ?, '2026-04-04T11:00:00.000Z', '2026-04-04T11:00:00.000Z')
      `,
      args: [id, `session-${id}`, summary],
    });
  } finally {
    await database.close();
  }
}

function restoreEnv(key: "AGENR_CONFIG_PATH" | "AGENR_DB_PATH", value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }

  process.env[key] = value;
}
