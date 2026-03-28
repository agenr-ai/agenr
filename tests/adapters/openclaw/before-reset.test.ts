import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createDatabase, type SqlDatabase } from "../../../src/adapters/db/client.js";
import { handleAgenrBeforeReset } from "../../../src/adapters/openclaw/hooks/before-reset.js";
import { createSessionStartTracker } from "../../../src/adapters/openclaw/session/state.js";
import type { AgenrOpenClawServices, AgenrOpenClawSummaryClient } from "../../../src/adapters/openclaw/types.js";
import type { EmbeddingPort, RecallPorts } from "../../../src/core/ports.js";

const openDatabases: SqlDatabase[] = [];
const tempPaths: string[] = [];

afterEach(async () => {
  while (openDatabases.length > 0) {
    await openDatabases.pop()?.close();
  }

  while (tempPaths.length > 0) {
    await rm(tempPaths.pop() ?? "", { force: true, recursive: true });
  }
});

describe("handleAgenrBeforeReset", () => {
  it("writes a sidecar summary file next to the outgoing session transcript", async () => {
    const database = await createTestDatabase();
    const logger = createLogger();
    const sessionFile = await writeSessionFile("reset-session", [
      {
        type: "session",
        id: "reset-session",
      },
      {
        type: "message",
        message: {
          role: "human",
          content: "We should replace handoff brain entries with summary files.",
        },
      },
      {
        type: "message",
        message: {
          role: "assistant",
          content: "That keeps the brain reserved for semantic knowledge.",
        },
      },
      {
        type: "message",
        message: {
          role: "human",
          content: "Keep the transcript tail too as a fallback.",
        },
      },
      {
        type: "message",
        message: {
          role: "assistant",
          content: "Agreed. I will write a concise previous-session summary.",
        },
      },
    ]);

    const summaryLlm = createSummaryLlm(
      "The session agreed to store continuity in sidecar summary files, keep transcript-tail fallback, and avoid brain handoff entries.",
    );
    const tracker = createSessionStartTracker();
    await handleAgenrBeforeReset(
      {
        sessionFile,
        messages: [{}, {}, {}, {}],
        reason: "reset",
      },
      {
        sessionId: "reset-session",
        sessionKey: "agent:main:webchat:continuity",
      },
      {
        logger,
        servicesPromise: Promise.resolve(createServices(database, summaryLlm)),
        tracker,
      },
    );

    const summaryPath = path.join(path.dirname(sessionFile), "reset-session.summary.md");
    await expect(readFile(summaryPath, "utf8")).resolves.toContain("sidecar summary files");
    expect(tracker.getLatestReset("agent:main:webchat:continuity")).toMatchObject({
      sessionId: "reset-session",
      sessionFile,
    });
    expect(getMessages(logger.info)).toEqual(
      expect.arrayContaining([
        "[agenr] before_reset: summary generation started for session=reset-session key=agent:main:webchat:continuity reason=reset rawMessages=4",
        `[agenr] before_reset: summary file written for session=reset-session key=agent:main:webchat:continuity path=${summaryPath} bytes=${Buffer.byteLength("The session agreed to store continuity in sidecar summary files, keep transcript-tail fallback, and avoid brain handoff entries.\n", "utf8")}`,
      ]),
    );
  });

  it("skips short sessions without writing a summary file", async () => {
    const database = await createTestDatabase();
    const logger = createLogger();
    const sessionFile = await writeSessionFile("short-session", [
      {
        type: "session",
        id: "short-session",
      },
      {
        type: "message",
        message: {
          role: "human",
          content: "Hi",
        },
      },
      {
        type: "message",
        message: {
          role: "assistant",
          content: "Hello",
        },
      },
      {
        type: "message",
        message: {
          role: "human",
          content: "Reset please",
        },
      },
    ]);

    await handleAgenrBeforeReset(
      {
        sessionFile,
        messages: [{}, {}, {}],
        reason: "new",
      },
      {
        sessionId: "short-session",
        sessionKey: "agent:main:webchat:short",
      },
      {
        logger,
        servicesPromise: Promise.resolve(createServices(database, createSummaryLlm("unused"))),
        tracker: createSessionStartTracker(),
      },
    );

    const summaryPath = path.join(path.dirname(sessionFile), "short-session.summary.md");
    await expect(readFile(summaryPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(getMessages(logger.info)).toEqual(
      expect.arrayContaining([
        "[agenr] before_reset: summary generation skipped for session=short-session key=agent:main:webchat:short reason=too_short cleanedMessages=3",
      ]),
    );
  });
});

function createServices(database: SqlDatabase, summaryLlm: AgenrOpenClawSummaryClient | undefined): AgenrOpenClawServices {
  const embedding: EmbeddingPort = {
    async embed(): Promise<number[][]> {
      throw new Error("Embeddings unavailable in this test.");
    },
  };
  const recall: RecallPorts = {
    async embed(): Promise<number[]> {
      throw new Error("Recall is unused in this test.");
    },
    async vectorSearch() {
      return [];
    },
    async ftsSearch() {
      return [];
    },
    async hydrateEntries() {
      return [];
    },
    async recordRecallEvents() {
      return;
    },
  };

  return {
    config: {
      dbPath: "test.db",
    },
    agenrConfig: {},
    dbPath: "test.db",
    database,
    embedding,
    recall,
    embeddingStatus: {
      available: false,
      provider: "unconfigured",
      requestedProvider: "openai",
      model: "text-embedding-3-small",
      error: "Embedding API key is required.",
    },
    summaryStatus: {
      available: Boolean(summaryLlm),
      provider: "openai",
      model: "gpt-5.4-mini",
      ...(summaryLlm ? {} : { error: "Summary LLM unavailable." }),
    },
    ...(summaryLlm ? { summaryLlm } : {}),
    async close() {
      await database.close();
    },
  };
}

function createSummaryLlm(response: string): AgenrOpenClawSummaryClient {
  return {
    metadata: {
      model: {
        id: "gpt-5.4-mini",
      } as AgenrOpenClawSummaryClient["metadata"]["model"],
      contextWindowTokens: 200_000,
      maxOutputTokens: 8_000,
      supportsReasoning: true,
      usage: {
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 0,
        totalCost: 0,
      },
    },
    async complete(): Promise<string> {
      return response;
    },
    async completeJson<T>(): Promise<T> {
      throw new Error("completeJson is unused in this test.");
    },
  };
}

function createLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function getMessages(logFn: ReturnType<typeof vi.fn>): string[] {
  return logFn.mock.calls.map(([message]) => message as string);
}

async function createTestDatabase(): Promise<SqlDatabase> {
  const databasePath = path.join(os.tmpdir(), `agenr-openclaw-reset-${randomUUID()}.sqlite`);
  tempPaths.push(databasePath);

  const database = await createDatabase(databasePath);
  openDatabases.push(database);
  return database;
}

async function writeSessionFile(sessionId: string, lines: object[]): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agenr-openclaw-reset-session-"));
  tempPaths.push(directory);
  const filePath = path.join(directory, `${sessionId}.jsonl`);
  await writeFile(filePath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
  return filePath;
}
