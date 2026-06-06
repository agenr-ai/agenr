import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createDatabase, type SqlDatabase } from "../../../src/adapters/db/client.js";
import { createMemoryRepository } from "../../../src/adapters/db/memory-repository.js";
import { buildAgenrSkelnMemoryPromptSection } from "../../../src/adapters/skeln/format/prompt-section.js";
import { CLAIM_KEY_DESCRIPTION } from "../../../src/adapters/shared/entry-tools.js";
import { runStoreMemoryTool, STORE_TOOL_PARAMETERS } from "../../../src/adapters/shared/memory-tools.js";
import type { EmbeddingPort } from "../../../src/core/ports.js";
import { closeTestDatabases, removeTestPath } from "../../helpers/temp-paths.js";

const openDatabases: SqlDatabase[] = [];
const tempDatabasePaths: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await closeTestDatabases(openDatabases);

  while (tempDatabasePaths.length > 0) {
    await removeTestPath(tempDatabasePaths.pop() ?? "");
  }
});

describe("agenr_store shared tool flow", () => {
  it("documents the two-segment claimKey format in the shared schema", () => {
    const claimKey = STORE_TOOL_PARAMETERS.properties.claimKey as { description?: string };

    expect(claimKey.description).toBe(CLAIM_KEY_DESCRIPTION);
    expect(claimKey.description).toContain("exactly two segments");
    expect(claimKey.description).toContain("one slash only");
    expect(claimKey.description).toContain("never nested paths");
  });

  it("surfaces dropped claim-key warnings in the tool response text", async () => {
    const database = await createTestDatabase();
    const onWarning = vi.fn();
    const outcome = await runStoreMemoryTool(
      {
        type: "fact",
        subject: "Skeln codebase layout",
        content: "Skeln keeps host adapters under src/adapters and app orchestration under src/app.",
        importance: undefined,
        expiry: undefined,
        tags: [],
        sourceContext: undefined,
        supersedes: undefined,
        claimKey: "skeln/codebase/layout",
        polarity: undefined,
        trigger: undefined,
        validFrom: undefined,
        validTo: undefined,
        project: undefined,
      },
      buildServices(database),
      {
        session: {
          sessionId: "session-1",
          agentId: "main",
          channel: "webchat",
          chatType: "direct",
        },
        sourcePrefix: "skeln-session",
        defaultSourceContext: "Stored via agenr_store from Skeln.",
        onWarning,
      },
    );

    expect(outcome.failed).toBe(false);
    expect(outcome.text).toContain('Stored "Skeln codebase layout".');
    expect(outcome.text).toContain("Warnings:");
    expect(outcome.text).toContain('invalid claim key "skeln/codebase/layout"');
    expect(outcome.text).toContain("claim key must contain exactly one '/'");
    expect(outcome.details).toMatchObject({
      status: "stored",
      warnings: [expect.stringMatching(/invalid claim key/i)],
    });
    expect(onWarning).toHaveBeenCalledTimes(1);
    expect(onWarning.mock.calls[0]?.[0]).toMatch(/invalid claim key/i);
  });
});

describe("Skeln memory prompt doctrine", () => {
  it("documents the two-segment claimKey format", () => {
    const prompt = buildAgenrSkelnMemoryPromptSection().join("\n");

    expect(prompt).toContain("claimKey as exactly two segments with one slash");
    expect(prompt).toContain("skeln/codebase_layout");
  });
});

async function createTestDatabase(): Promise<SqlDatabase> {
  const dbPath = path.join(os.tmpdir(), `agenr-memory-tools-store-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
  tempDatabasePaths.push(dbPath);
  const database = await createDatabase(dbPath);
  openDatabases.push(database);
  return database;
}

function buildServices(database: SqlDatabase) {
  const embedding: EmbeddingPort = {
    async embed(texts) {
      return texts.map((text, index) => createEmbedding(index, text.length || 1));
    },
  };

  return {
    entries: database,
    embedding,
    memory: createMemoryRepository(database),
  };
}

function createEmbedding(index: number, value: number): number[] {
  const vector = Array.from({ length: 1024 }, () => 0);
  vector[index % vector.length] = value;
  return vector;
}
