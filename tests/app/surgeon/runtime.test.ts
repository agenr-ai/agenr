import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createDatabase } from "../../../src/adapters/db/client.js";
import { createSurgeonRun } from "../../../src/adapters/db/surgeon-run-log.js";

const { runSurgeonMock } = vi.hoisted(() => ({
  runSurgeonMock: vi.fn(),
}));

vi.mock("../../../src/app/surgeon/service.js", () => ({
  runSurgeon: runSurgeonMock,
}));

import { loadSurgeonStatusRuntime, runSurgeonRuntime } from "../../../src/app/surgeon/runtime.js";

const tempPaths: string[] = [];

afterEach(async () => {
  runSurgeonMock.mockReset();

  while (tempPaths.length > 0) {
    await rm(tempPaths.pop() ?? "", { recursive: true, force: true });
  }
});

beforeEach(() => {
  runSurgeonMock.mockResolvedValue({
    runId: "run-1",
    status: "completed",
    passType: "retirement",
    actionsTaken: 0,
    entriesRetired: 0,
    inputTokens: 0,
    outputTokens: 0,
    estimatedCostUsd: 0,
    summary: null,
  });
});

describe("surgeon runtime", () => {
  it("prefers CLI provider and model overrides and creates recall ports when embeddings are configured", async () => {
    const tempRoot = await createTempDirectory("agenr-surgeon-runtime-");
    const dbPath = path.join(tempRoot, "knowledge.db");
    const configPath = path.join(tempRoot, "config.json");

    await writeJson(configPath, {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      credentials: {
        openaiApiKey: "openai-key",
        anthropicApiKey: "anthropic-key",
      },
      surgeon: {
        model: {
          provider: "openai",
          model: "gpt-5.4",
        },
      },
    });

    await runSurgeonRuntime({
      pass: "retirement",
      budget: 0,
      apply: false,
      verbose: false,
      json: false,
      provider: "openai",
      model: "gpt-5.4-mini",
      dbPath,
      env: {
        AGENR_CONFIG_PATH: configPath,
      },
    });

    expect(runSurgeonMock).toHaveBeenCalledTimes(1);
    const [options, deps] = runSurgeonMock.mock.calls[0] as Parameters<typeof runSurgeonMock>;

    expect(options).toMatchObject({
      pass: "retirement",
      provider: "openai",
      model: "gpt-5.4-mini",
    });
    expect(deps.dbPath).toBe(dbPath);
    expect(deps.model.provider).toBe("openai");
    expect(deps.model.id).toBe("gpt-5.4-mini");
    await expect(deps.getApiKey?.("openai")).resolves.toBe("openai-key");
    expect(deps.recallPorts).toBeDefined();
  });

  it("falls back to config defaults and disables recall simulation when no embedding key is configured", async () => {
    const tempRoot = await createTempDirectory("agenr-surgeon-runtime-");
    const dbPath = path.join(tempRoot, "knowledge.db");
    const configPath = path.join(tempRoot, "config.json");

    await writeJson(configPath, {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      credentials: {
        anthropicApiKey: "anthropic-key",
      },
    });

    await runSurgeonRuntime({
      pass: "retirement",
      budget: 0,
      apply: false,
      verbose: false,
      json: false,
      dbPath,
      env: {
        AGENR_CONFIG_PATH: configPath,
      },
    });

    expect(runSurgeonMock).toHaveBeenCalledTimes(1);
    const [, deps] = runSurgeonMock.mock.calls[0] as Parameters<typeof runSurgeonMock>;

    expect(deps.model.provider).toBe("anthropic");
    expect(deps.model.id).toBe("claude-sonnet-4-6");
    await expect(deps.getApiKey?.("anthropic")).resolves.toBe("anthropic-key");
    expect(deps.recallPorts).toBeUndefined();
  });

  it("loads status from the configured database", async () => {
    const tempRoot = await createTempDirectory("agenr-surgeon-status-");
    const dbPath = path.join(tempRoot, "knowledge.db");
    const configPath = path.join(tempRoot, "config.json");

    await writeJson(configPath, {
      dbPath,
    });

    const database = await createDatabase(dbPath);
    try {
      await database.execute({
        sql: `
          INSERT INTO entries (
            id,
            type,
            subject,
            content,
            importance,
            expiry,
            tags,
            source_file,
            source_context,
            embedding,
            content_hash,
            norm_content_hash,
            minhash_sig,
            quality_score,
            recall_count,
            last_recalled_at,
            superseded_by,
            cluster_id,
            retired,
            retired_at,
            retired_reason,
            created_at,
            updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        args: [
          "entry-1",
          "todo",
          "Status candidate",
          "A session handoff that should be reviewed by surgeon.",
          3,
          "temporary",
          "[]",
          null,
          null,
          null,
          "hash-1",
          null,
          null,
          0.3,
          0,
          null,
          null,
          null,
          0,
          null,
          null,
          "2026-01-01T00:00:00.000Z",
          "2026-01-02T00:00:00.000Z",
        ],
      });
      await createSurgeonRun(database, {
        passType: "retirement",
        dryRun: true,
        startedAt: "2026-03-29T10:00:00.000Z",
      });
    } finally {
      await database.close();
    }

    const result = await loadSurgeonStatusRuntime({
      dbPath,
      env: {
        AGENR_CONFIG_PATH: configPath,
      },
    });

    expect(result.health.total).toBe(1);
    expect(result.health.retirementCandidateCount).toBe(1);
    expect(result.lastRun).toMatchObject({
      passType: "retirement",
      dryRun: true,
    });
  });
});

async function createTempDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempPaths.push(directory);
  return directory;
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
