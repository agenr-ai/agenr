import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createDatabase, type SqlDatabase } from "../../../src/adapters/db/client.js";
import { createMemoryRepository } from "../../../src/adapters/db/memory-repository.js";
import { buildAgenrMemoryPromptSection } from "../../../src/adapters/openclaw/format/prompt-section.js";
import { buildAgenrSkelnMemoryPromptSection } from "../../../src/adapters/skeln/format/prompt-section.js";
import { CLAIM_KEY_DESCRIPTION, MEMORY_DOCTRINE } from "../../../src/adapters/shared/memory-prompt-doctrine.js";
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

describe("claimKey doctrine", () => {
  it("uses one canonical source across schema and host prompt surfaces", () => {
    const claimKey = STORE_TOOL_PARAMETERS.properties.claimKey as { description?: string };
    const skelnPrompt = buildAgenrSkelnMemoryPromptSection().join("\n");
    const openClawPrompt = buildAgenrMemoryPromptSection({
      availableTools: new Set(["agenr_recall", "agenr_store"]),
      citationsMode: "off",
    }).join("\n");
    const promptLine = MEMORY_DOCTRINE.store.claimKeyPromptLine;
    const storeGuideline = MEMORY_DOCTRINE.store.claimKeyStoreGuideline;

    expect(claimKey.description).toBe(CLAIM_KEY_DESCRIPTION);
    expect(CLAIM_KEY_DESCRIPTION).toContain("Slot-like durables use");
    expect(CLAIM_KEY_DESCRIPTION).toContain("type=directive");
    expect(CLAIM_KEY_DESCRIPTION).toContain("user/memory_directive/<name>");
    expect(skelnPrompt).toContain(promptLine);
    expect(openClawPrompt).toContain(promptLine);
    expect(storeGuideline).toContain("skeln/codebase_layout");
  });
});

describe("agenr_store shared tool flow", () => {
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

  it("omits warning text when the store pipeline emits no warnings", async () => {
    const database = await createTestDatabase();
    const outcome = await runStoreMemoryTool(
      {
        type: "fact",
        subject: "Office Wi-Fi name",
        content: "The office Wi-Fi network name is Acorn-5G.",
        importance: undefined,
        expiry: undefined,
        tags: [],
        sourceContext: undefined,
        supersedes: undefined,
        claimKey: "office/wifi_name",
        polarity: undefined,
        trigger: undefined,
        validFrom: undefined,
        validTo: undefined,
        project: undefined,
      },
      buildServices(database),
      {
        session: {
          sessionId: "session-2",
          agentId: "main",
        },
        sourcePrefix: "skeln-session",
        defaultSourceContext: "Stored via agenr_store from Skeln.",
      },
    );

    expect(outcome.failed).toBe(false);
    expect(outcome.text).toBe('Stored "Office Wi-Fi name".');
    expect(outcome.details.warnings).toBeUndefined();
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
    durables: database,
    embedding,
    memory: createMemoryRepository(database),
  };
}

function createEmbedding(index: number, value: number): number[] {
  const vector = Array.from({ length: 1024 }, () => 0);
  vector[index % vector.length] = value;
  return vector;
}
