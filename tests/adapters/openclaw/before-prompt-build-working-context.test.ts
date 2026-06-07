import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

const openClawBeforePromptBuildLlmMocks = vi.hoisted(() => ({
  createOpenClawLlmClient: vi.fn(),
}));

vi.mock("../../../src/adapters/openclaw/llm/openclaw-llm-client.js", () => ({
  createOpenClawLlmClient: openClawBeforePromptBuildLlmMocks.createOpenClawLlmClient,
}));

import { createOpenClawBeforePromptBuildDatabasePath, createOpenClawBeforePromptBuildServices } from "../../helpers/openclaw-before-prompt-build-services.js";

import { createDatabase, type SqlDatabase } from "../../../src/adapters/db/client.js";
import { handleAgenrBeforePromptBuild } from "../../../src/adapters/openclaw/hooks/before-prompt-build.js";
import { createSessionStartTracker } from "../../../src/app/plugin-runtime/session-tracking.js";
import type { RecallPorts } from "../../../src/core/ports.js";
import type { RecallCandidateDurable } from "../../../src/core/recall/types.js";
import type { Durable } from "../../../src/core/types.js";
import { closeTestDatabases, removeTestPath } from "../../helpers/temp-paths.js";

const openDatabases: SqlDatabase[] = [];
const tempPaths: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.clearAllTimers();
  vi.useRealTimers();
  openClawBeforePromptBuildLlmMocks.createOpenClawLlmClient.mockReset();

  await closeTestDatabases(openDatabases);

  while (tempPaths.length > 0) {
    await removeTestPath(tempPaths.pop() ?? "");
  }
});

describe("handleAgenrBeforePromptBuild working context", () => {
  it("injects working context alongside session-start recall on the first turn", async () => {
    const database = await createTestDatabase();
    const logger = createLogger();
    const recall = createObservedRecallPorts();
    await database.insertDurable(
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

    const services = createOpenClawBeforePromptBuildServices(database, openClawBeforePromptBuildLlmMocks, {
      recall,
      workingProjection: "<agenr_work_context>\nObjective: Keep active task state.\n</agenr_work_context>",
    });
    const tracker = createSessionStartTracker();

    const result = await handleAgenrBeforePromptBuild(
      { prompt: "What should I do next?", messages: [] },
      { sessionId: "session-1", sessionKey: "agent:main:webchat:test" },
      {
        logger,
        servicesPromise: Promise.resolve(services),
        tracker,
      },
    );

    expect(result?.prependContext).toContain("master branch workflow");
    expect(result?.prependContext).toContain("<agenr_work_context>");
    expect(result?.prependContext).toContain("Objective: Keep active task state.");
    expect(result?.workingContextAudit).toMatchObject({
      source: "agenr_work",
      workingSetId: "ws-test",
      revision: 1,
    });
  });

  it("still injects working context when session-start recall fails", async () => {
    const database = await createTestDatabase();
    const logger = createLogger();
    const services = createOpenClawBeforePromptBuildServices(database, openClawBeforePromptBuildLlmMocks, {
      workingProjection: "<agenr_work_context>\nObjective: Survive recall failure.\n</agenr_work_context>",
    });
    services.sessionStart.repository.listCoreDurables = vi.fn(async () => {
      throw new Error("session-start recall exploded");
    });
    const tracker = createSessionStartTracker();

    const result = await handleAgenrBeforePromptBuild(
      { prompt: "What should I do next?", messages: [] },
      { sessionId: "session-fail", sessionKey: "agent:main:webchat:fail" },
      {
        logger,
        servicesPromise: Promise.resolve(services),
        tracker,
      },
    );

    expect(result?.prependContext).toContain("<agenr_work_context>");
    expect(result?.prependContext).toContain("Objective: Survive recall failure.");
    expect(result?.workingContextAudit).toMatchObject({
      source: "agenr_work",
      workingSetId: "ws-test",
      revision: 1,
    });
    expect(getMessages(logger.warn)).toEqual(expect.arrayContaining([expect.stringContaining("session-start recall failed for session=session-fail")]));
  });

  it("preserves workingContextAudit when session-start recall is disabled and before-turn recall injects", async () => {
    const database = await createTestDatabase();
    const logger = createLogger();
    const durableEntry = createEntry({
      id: "entry-disabled-session-start",
      type: "lesson",
      subject: "before-turn patch pattern",
      content: "Inject a bounded patch through prependContext rather than rebuilding a large persistent prompt block.",
      importance: 9,
    });
    const recall = createObservedRecallPorts({
      ftsCandidates: [toRecallCandidateDurable(durableEntry)],
      hydratedDurables: [durableEntry],
    });
    const services = createOpenClawBeforePromptBuildServices(database, openClawBeforePromptBuildLlmMocks, {
      available: true,
      recall,
      pluginConfig: {
        memoryPolicy: {
          sessionStart: { enabled: false },
          beforeTurn: { recallThreshold: 0 },
        },
      },
      workingProjection: "<agenr_work_context>\nObjective: Deploy safely.\n</agenr_work_context>",
    });
    const tracker = createSessionStartTracker();

    const result = await handleAgenrBeforePromptBuild(
      { prompt: "How do I implement the before turn memory patch?", messages: [] },
      { sessionId: "session-disabled-start", sessionKey: "agent:main:webchat:disabled-start", trigger: "user" },
      {
        logger,
        servicesPromise: Promise.resolve(services),
        tracker,
      },
    );

    expect(result?.prependContext).toContain("before-turn patch pattern");
    expect(result?.prependContext).toContain("<agenr_work_context>");
    expect(result?.workingContextAudit).toMatchObject({
      source: "agenr_work",
      workingSetId: "ws-test",
      revision: 1,
    });
  });

  it("injects working context on later turns without rerunning session-start recall", async () => {
    const database = await createTestDatabase();
    const logger = createLogger();
    const recall = createObservedRecallPorts();
    await database.insertDurable(
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
    const services = createOpenClawBeforePromptBuildServices(database, openClawBeforePromptBuildLlmMocks, {
      recall,
      available: true,
      workingProjection: "<agenr_work_context>\nObjective: Continue later turn.\n</agenr_work_context>",
    });
    const tracker = createSessionStartTracker();

    await handleAgenrBeforePromptBuild(
      { prompt: "Start", messages: [] },
      { sessionId: "session-later", sessionKey: "agent:main:webchat:later" },
      {
        logger,
        servicesPromise: Promise.resolve(services),
        tracker,
      },
    );

    const result = await handleAgenrBeforePromptBuild(
      { prompt: "Continue with the task", messages: [{ role: "user", content: "Start" }] },
      { sessionId: "session-later", sessionKey: "agent:main:webchat:later" },
      {
        logger,
        servicesPromise: Promise.resolve(services),
        tracker,
      },
    );

    expect(result?.prependContext).toContain("<agenr_work_context>");
    expect(result?.prependContext).toContain("Objective: Continue later turn.");
    expect(result?.workingContextAudit).toMatchObject({
      source: "agenr_work",
      workingSetId: "ws-test",
      revision: 1,
    });
  });

  it("skips working context when working memory is disabled", async () => {
    const database = await createTestDatabase();
    const logger = createLogger();
    const services = createOpenClawBeforePromptBuildServices(database, openClawBeforePromptBuildLlmMocks, {
      workingMemoryEnabled: false,
    });
    const tracker = createSessionStartTracker();

    const result = await handleAgenrBeforePromptBuild(
      { prompt: "Anything to remember?", messages: [] },
      { sessionId: "session-no-working", sessionKey: "agent:main:webchat:no-working" },
      {
        logger,
        servicesPromise: Promise.resolve(services),
        tracker,
      },
    );

    expect(result).toBeUndefined();
  });
});

function createObservedRecallPorts(
  options: {
    ftsCandidates?: RecallCandidateDurable[];
    hydratedDurables?: Durable[];
  } = {},
) {
  const hydratedDurablesById = new Map((options.hydratedDurables ?? []).map((durable) => [durable.id, durable]));
  return {
    embed: vi.fn(async (): Promise<number[]> => createEmbedding(0, 1)),
    vectorSearch: vi.fn(async () => []),
    ftsSearch: vi.fn(async () =>
      (options.ftsCandidates ?? []).map((durable) => ({
        durable,
        rank: -1,
        tier: "all_tokens" as const,
      })),
    ),
    hydrateDurables: vi.fn(async (ids: string[]) => ids.flatMap((id) => hydratedDurablesById.get(id) ?? [])),
    recordRecallEvents: vi.fn(async () => undefined),
  } satisfies RecallPorts;
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
  const databasePath = createOpenClawBeforePromptBuildDatabasePath();
  tempPaths.push(databasePath);

  const database = await createDatabase(databasePath);
  openDatabases.push(database);
  return database;
}

function createEntry(overrides: Partial<Durable> = {}): Durable {
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
    created_at: overrides.created_at ?? now,
    updated_at: overrides.updated_at ?? now,
  };
}

function toRecallCandidateDurable(entry: Durable): RecallCandidateDurable {
  return {
    id: entry.id,
    subject: entry.subject,
    content: entry.content,
    importance: entry.importance,
    expiry: entry.expiry,
    created_at: entry.created_at,
    embedding: entry.embedding,
    superseded_by: entry.superseded_by,
    claim_key: entry.claim_key,
    claim_key_status: entry.claim_key_status,
    claim_support_observed_at: entry.claim_support_observed_at,
    valid_from: entry.valid_from,
    valid_to: entry.valid_to,
  };
}

function createEmbedding(index: number, value: number): number[] {
  const vector = Array.from({ length: 1024 }, () => 0);
  vector[index] = value;
  return vector;
}
