import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createDatabase, type SqlDatabase } from "../../../src/adapters/db/client.js";
import { handleAgenrBeforePromptBuild } from "../../../src/adapters/openclaw/hooks/before-prompt-build.js";
import { createSessionStartTracker } from "../../../src/adapters/openclaw/session/state.js";
import type { AgenrOpenClawServices, AgenrOpenClawSummaryClient } from "../../../src/adapters/openclaw/types.js";
import type { EmbeddingPort, RecallPorts } from "../../../src/core/ports.js";
import type { Entry } from "../../../src/core/types.js";

const openDatabases: SqlDatabase[] = [];
const tempPaths: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();

  while (openDatabases.length > 0) {
    await openDatabases.pop()?.close();
  }

  while (tempPaths.length > 0) {
    await rm(tempPaths.pop() ?? "", { force: true, recursive: true });
  }
});

describe("handleAgenrBeforePromptBuild", () => {
  it("injects only core session-start memory once per session and skips speculative recall", async () => {
    const database = await createTestDatabase();
    const executeSpy = vi.spyOn(database, "execute");
    const logger = createLogger();
    const recall = createObservedRecallPorts();
    await database.insertEntry(
      createEntry({
        type: "decision",
        subject: "master branch workflow",
        content: "Branch from local master, commit, then fast-forward merge back to master.",
        expiry: "core",
        importance: 10,
      }),
      createEmbedding(0, 1),
      "core-workflow",
    );
    await database.insertEntry(
      createEntry({
        type: "event",
        subject: "latest plugin work",
        content: "Phase 1 of the agenr OpenClaw memory plugin is in progress.",
        expiry: "temporary",
        importance: 8,
      }),
      createEmbedding(1, 1),
      "recent-work",
    );

    const tracker = createSessionStartTracker();
    const result = await handleAgenrBeforePromptBuild(
      {
        prompt: "What should I work on next?",
        messages: [],
      },
      {
        sessionId: "session-1",
        sessionKey: "agent:main:webchat:test",
      },
      {
        logger,
        servicesPromise: Promise.resolve(
          createServices(database, {
            available: true,
            recall,
          }),
        ),
        tracker,
      },
    );
    const secondResult = await handleAgenrBeforePromptBuild(
      {
        prompt: "And after that?",
        messages: [],
      },
      {
        sessionId: "session-1",
        sessionKey: "agent:main:webchat:test",
      },
      {
        logger,
        servicesPromise: Promise.resolve(
          createServices(database, {
            available: true,
            recall,
          }),
        ),
        tracker,
      },
    );

    expect(result?.prependContext).toContain("Agenr Session Recall");
    expect(result?.prependContext).toContain("Core Memory");
    expect(result?.prependContext).toContain("master branch workflow");
    expect(result?.prependContext).not.toContain("latest plugin work");
    expect(result?.prependContext).not.toContain("Relevant Recall");
    expect(result?.prependContext).not.toContain("Recent Context");
    expect(result?.prependContext).not.toContain("## Previous session summary");
    expect(result?.prependContext).not.toContain("## Recent session");
    expect(result?.prependContext).not.toContain("Recent Handoffs");
    expect(secondResult).toBeUndefined();
    expectRecallPortsUnused(recall);
    expect(listExecutedSql(executeSpy.mock.calls).some((sql) => sql.includes("expiry != 'core'"))).toBe(false);
    expect(getMessages(logger.info)).toEqual(
      expect.arrayContaining([
        "[agenr] session-start recall for session=session-1 key=agent:main:webchat:test",
        "[agenr] session-start predecessor summary not found for session=session-1 key=agent:main:webchat:test reason=no_predecessor",
        "[agenr] session-start recall: 1 core entries for session=session-1 key=agent:main:webchat:test",
        "[agenr] session-start recall skipped (already ran) for session=session-1 key=agent:main:webchat:test",
      ]),
    );
    expect(getMessages(logger.debug)).toEqual(
      expect.arrayContaining([
        "[agenr] before_prompt_build: session tracker first start for session=session-1 key=agent:main:webchat:test",
        "[agenr] before_prompt_build: session tracker duplicate blocked for session=session-1 key=agent:main:webchat:test",
        expect.stringContaining(
          "[agenr] before_prompt_build: session-start core entries for session=session-1 key=agent:main:webchat:test: master branch workflow",
        ),
      ]),
    );
    expect(
      getMessages(logger.debug).some((message) => message.includes("session-start relevant entries") || message.includes("session-start recent entries")),
    ).toBe(false);
  });

  it("injects predecessor summary and transcript tail alongside core memory only", async () => {
    const database = await createTestDatabase();
    const executeSpy = vi.spyOn(database, "execute");
    const logger = createLogger();
    const recall = createObservedRecallPorts();
    const coreEntry = createEntry({
      type: "decision",
      subject: "session isolation rule",
      content: "Keep each TUI session pinned to its own session key and continuity chain.",
      expiry: "core",
      importance: 10,
    });
    const relevantEntry = createEntry({
      type: "lesson",
      subject: "multi-session drift check",
      content: "Operators grep gateway.err.log by session key to verify recall stayed isolated.",
      expiry: "permanent",
      importance: 8,
      tags: ["openclaw", "debugging"],
    });
    const recentEntry = createEntry({
      type: "event",
      subject: "latest plugin work",
      content: "Structured OpenClaw logging is being wired into session-start recall.",
      expiry: "temporary",
      importance: 8,
    });

    await database.insertEntry(coreEntry, createEmbedding(0, 1), "core-workflow");
    await database.insertEntry(relevantEntry, createEmbedding(1, 1), "relevant-workflow");
    await database.insertEntry(recentEntry, createEmbedding(2, 1), "recent-workflow");

    const predecessorFile = await writeSessionFile("predecessor-session", [
      {
        type: "session",
        id: "predecessor-session",
      },
      {
        type: "message",
        timestamp: "2026-03-28T10:00:00.000Z",
        message: {
          role: "human",
          content: "We need file-based continuity instead of handoff brain entries.",
        },
      },
      {
        type: "message",
        timestamp: "2026-03-28T10:01:00.000Z",
        message: {
          role: "assistant",
          content: "Agreed. We will write a summary.md sidecar next to the session transcript.",
        },
      },
      {
        type: "message",
        timestamp: "2026-03-28T10:02:00.000Z",
        message: {
          role: "human",
          content: "Keep the transcript tail too so tone and last exchanges survive when the LLM summary is missing.",
        },
      },
      {
        type: "message",
        timestamp: "2026-03-28T10:03:00.000Z",
        message: {
          role: "assistant",
          content: "Understood. No handoff entries will be stored in the brain.",
        },
      },
    ]);
    await writeFile(
      path.join(path.dirname(predecessorFile), "predecessor-session.summary.md"),
      "The session settled on file-based continuity. Summary files live next to transcript JSONL, transcript tails remain as fallback, and no handoff entries go into the brain.\n",
      "utf8",
    );

    const tracker = createSessionStartTracker();
    tracker.rememberReset("agent:main:webchat:isolated", {
      sessionId: "predecessor-session",
      sessionFile: predecessorFile,
      recordedAt: "2026-03-28T10:05:00.000Z",
    });
    tracker.rememberSessionStart("session-2", "agent:main:webchat:isolated", "predecessor-session");

    const result = await handleAgenrBeforePromptBuild(
      {
        prompt: "Verify each TUI session stays isolated and continuity is file-based.",
        messages: [],
      },
      {
        sessionId: "session-2",
        sessionKey: "agent:main:webchat:isolated",
      },
      {
        logger,
        servicesPromise: Promise.resolve(
          createServices(database, {
            available: true,
            recall,
          }),
        ),
        tracker,
      },
    );

    expect(result?.prependContext).toContain("## Previous session summary");
    expect(result?.prependContext).toContain("file-based continuity");
    expect(result?.prependContext).toContain("## Recent session");
    expect(result?.prependContext).toContain("U: Keep the transcript tail too");
    expect(result?.prependContext).toContain("Agenr Session Recall");
    expect(result?.prependContext).toContain("Core Memory");
    expect(result?.prependContext).toContain("session isolation rule");
    expect(result?.prependContext).not.toContain("multi-session drift check");
    expect(result?.prependContext).not.toContain("latest plugin work");
    expect(result?.prependContext).not.toContain("Relevant Recall");
    expect(result?.prependContext).not.toContain("Recent Context");
    expect(result?.prependContext).not.toContain("Recent Handoffs");
    expectRecallPortsUnused(recall);
    expect(listExecutedSql(executeSpy.mock.calls).some((sql) => sql.includes("expiry != 'core'"))).toBe(false);
    expect(getMessages(logger.info)).toEqual(
      expect.arrayContaining([
        "[agenr] session-start predecessor summary found for session=session-2 key=agent:main:webchat:isolated path=" +
          path.join(path.dirname(predecessorFile), "predecessor-session.summary.md"),
        "[agenr] session-start recall: 1 core entries for session=session-2 key=agent:main:webchat:isolated",
      ]),
    );
  });

  it("injects only predecessor continuity when no core entries exist", async () => {
    const database = await createTestDatabase();
    const logger = createLogger();

    const predecessorFile = await writeSessionFile("predecessor-session", [
      {
        type: "session",
        id: "predecessor-session",
      },
      {
        type: "message",
        timestamp: "2026-03-28T10:00:00.000Z",
        message: {
          role: "human",
          content: "Summaries should survive session rollover even when brain recall is empty.",
        },
      },
      {
        type: "message",
        timestamp: "2026-03-28T10:01:00.000Z",
        message: {
          role: "assistant",
          content: "We will inject the summary and the transcript tail without speculative database recall.",
        },
      },
    ]);
    await writeFile(
      path.join(path.dirname(predecessorFile), "predecessor-session.summary.md"),
      "The previous session decided continuity should come from the sidecar summary and transcript tail when needed.\n",
      "utf8",
    );

    const tracker = createSessionStartTracker();
    tracker.rememberReset("agent:main:webchat:continuity", {
      sessionId: "predecessor-session",
      sessionFile: predecessorFile,
      recordedAt: "2026-03-28T10:05:00.000Z",
    });
    tracker.rememberSessionStart("session-3", "agent:main:webchat:continuity", "predecessor-session");

    const result = await handleAgenrBeforePromptBuild(
      {
        prompt: "Continue from the previous session.",
        messages: [],
      },
      {
        sessionId: "session-3",
        sessionKey: "agent:main:webchat:continuity",
      },
      {
        logger,
        servicesPromise: Promise.resolve(createServices(database)),
        tracker,
      },
    );

    expect(result?.prependContext).toContain("## Previous session summary");
    expect(result?.prependContext).toContain("## Recent session");
    expect(result?.prependContext).not.toContain("Agenr Session Recall");
    expect(result?.prependContext).not.toContain("Core Memory");
    expect(getMessages(logger.info)).toEqual(
      expect.arrayContaining([
        "[agenr] session-start predecessor summary found for session=session-3 key=agent:main:webchat:continuity path=" +
          path.join(path.dirname(predecessorFile), "predecessor-session.summary.md"),
        "[agenr] session-start recall: 0 core entries for session=session-3 key=agent:main:webchat:continuity",
      ]),
    );
  });

  it("logs when session-start recall has nothing to inject", async () => {
    const database = await createTestDatabase();
    const logger = createLogger();

    const result = await handleAgenrBeforePromptBuild(
      {
        prompt: "Anything to remember?",
        messages: [],
      },
      {
        sessionId: "session-empty",
        sessionKey: "agent:main:webchat:empty",
      },
      {
        logger,
        servicesPromise: Promise.resolve(createServices(database)),
        tracker: createSessionStartTracker(),
      },
    );

    expect(result).toBeUndefined();
    expect(getMessages(logger.info)).toEqual(
      expect.arrayContaining([
        "[agenr] session-start predecessor summary not found for session=session-empty key=agent:main:webchat:empty reason=no_predecessor",
        "[agenr] session-start recall: 0 core entries for session=session-empty key=agent:main:webchat:empty",
        "[agenr] session-start recall: nothing to inject for session=session-empty key=agent:main:webchat:empty",
      ]),
    );
  });
});

function createServices(
  database: SqlDatabase,
  options: {
    available?: boolean;
    recall?: RecallPorts;
    summaryLlm?: AgenrOpenClawSummaryClient;
  } = {},
): AgenrOpenClawServices {
  const available = options.available ?? false;
  const embedding: EmbeddingPort = {
    async embed(): Promise<number[][]> {
      throw new Error("Embeddings unavailable in this test.");
    },
  };
  const recall =
    options.recall ??
    ({
      async embed(): Promise<number[]> {
        throw new Error("Recall should not run when embeddings are unavailable.");
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
    } satisfies RecallPorts);

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
      available,
      provider: available ? "openai" : "unconfigured",
      requestedProvider: "openai",
      model: "text-embedding-3-small",
      ...(available ? {} : { error: "Embedding API key is required." }),
    },
    summaryStatus: {
      available: Boolean(options.summaryLlm),
      provider: "openai",
      model: "gpt-5.4-mini",
      ...(options.summaryLlm ? {} : { error: "Summary LLM unavailable." }),
    },
    ...(options.summaryLlm ? { summaryLlm: options.summaryLlm } : {}),
    async close() {
      await database.close();
    },
  };
}

function createObservedRecallPorts() {
  return {
    embed: vi.fn(async (): Promise<number[]> => createEmbedding(0, 1)),
    vectorSearch: vi.fn(async () => []),
    ftsSearch: vi.fn(async () => []),
    hydrateEntries: vi.fn(async () => []),
    recordRecallEvents: vi.fn(async () => undefined),
  } satisfies RecallPorts;
}

function expectRecallPortsUnused(recall: ReturnType<typeof createObservedRecallPorts>): void {
  expect(recall.embed).not.toHaveBeenCalled();
  expect(recall.vectorSearch).not.toHaveBeenCalled();
  expect(recall.ftsSearch).not.toHaveBeenCalled();
  expect(recall.hydrateEntries).not.toHaveBeenCalled();
  expect(recall.recordRecallEvents).not.toHaveBeenCalled();
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

function listExecutedSql(executeCalls: unknown[][]): string[] {
  return executeCalls.flatMap(([statementOrSql]) => {
    if (typeof statementOrSql === "string") {
      return [statementOrSql];
    }

    if (hasSqlText(statementOrSql)) {
      return [statementOrSql.sql];
    }

    return [];
  });
}

function hasSqlText(value: unknown): value is { sql: string } {
  return typeof value === "object" && value !== null && "sql" in value && typeof value.sql === "string";
}

async function createTestDatabase(): Promise<SqlDatabase> {
  const databasePath = path.join(os.tmpdir(), `agenr-openclaw-${randomUUID()}.sqlite`);
  tempPaths.push(databasePath);

  const database = await createDatabase(databasePath);
  openDatabases.push(database);
  return database;
}

async function writeSessionFile(sessionId: string, lines: object[]): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agenr-openclaw-session-"));
  tempPaths.push(directory);
  const filePath = path.join(directory, `${sessionId}.jsonl`);
  await writeFile(filePath, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
  return filePath;
}

function createEntry(overrides: Partial<Entry> = {}): Entry {
  const now = new Date("2026-03-27T12:00:00.000Z").toISOString();
  return {
    id: overrides.id ?? randomUUID(),
    type: overrides.type ?? "fact",
    subject: overrides.subject ?? "test subject",
    content: overrides.content ?? "test content",
    importance: overrides.importance ?? 7,
    expiry: overrides.expiry ?? "permanent",
    tags: overrides.tags ?? [],
    source_file: overrides.source_file,
    source_context: overrides.source_context,
    embedding: overrides.embedding,
    content_hash: overrides.content_hash,
    norm_content_hash: overrides.norm_content_hash,
    quality_score: overrides.quality_score ?? 0.5,
    recall_count: overrides.recall_count ?? 0,
    last_recalled_at: overrides.last_recalled_at,
    superseded_by: overrides.superseded_by,
    cluster_id: overrides.cluster_id,
    retired: overrides.retired ?? false,
    retired_at: overrides.retired_at,
    retired_reason: overrides.retired_reason,
    created_at: overrides.created_at ?? now,
    updated_at: overrides.updated_at ?? now,
  };
}

function createEmbedding(index: number, value: number): number[] {
  const vector = Array.from({ length: 1024 }, () => 0);
  vector[index] = value;
  return vector;
}
