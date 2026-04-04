import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { afterEach, describe, expect, it, vi } from "vitest";

const piAiMocks = vi.hoisted(() => ({
  completeSimple: vi.fn(),
  getModel: vi.fn(),
}));

vi.mock("@mariozechner/pi-ai", () => ({
  completeSimple: piAiMocks.completeSimple,
  getModel: piAiMocks.getModel,
}));

import type { Api, AssistantMessage, Model } from "@mariozechner/pi-ai";

import { createDatabase, type SqlDatabase } from "../../../src/adapters/db/client.js";
import { createOpenClawRepository } from "../../../src/adapters/db/openclaw-repository.js";
import { createOpenClawLlmClient } from "../../../src/adapters/openclaw/llm/openclaw-llm-client.js";
import {
  createAgenrRecallTool,
  createAgenrRetireTool,
  createAgenrStoreTool,
  createAgenrTraceTool,
  createAgenrUpdateTool,
} from "../../../src/adapters/openclaw/tools.js";
import type { AgenrOpenClawHost, AgenrOpenClawServices } from "../../../src/adapters/openclaw/types.js";
import type { EmbeddingPort, RecallPorts } from "../../../src/core/ports.js";
import type { Entry } from "../../../src/core/types.js";

const openDatabases: SqlDatabase[] = [];
const tempDatabasePaths: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  piAiMocks.completeSimple.mockReset();
  piAiMocks.getModel.mockReset();

  while (openDatabases.length > 0) {
    await openDatabases.pop()?.close();
  }

  while (tempDatabasePaths.length > 0) {
    await rm(tempDatabasePaths.pop() ?? "", { force: true });
  }
});

describe("agenr OpenClaw tools", () => {
  it("keeps the update tool schema flat for OpenAI-compatible registration", () => {
    const updateTool = createAgenrUpdateTool(createToolContext(), Promise.resolve({} as AgenrOpenClawServices), createLogger());
    const schema = updateTool.parameters as {
      type?: unknown;
      anyOf?: unknown;
      oneOf?: unknown;
      allOf?: unknown;
      enum?: unknown;
      not?: unknown;
      properties?: Record<string, Record<string, unknown>>;
    };
    const importance = schema.properties?.importance;
    const expiry = schema.properties?.expiry;

    expect(schema.type).toBe("object");
    expect(schema.anyOf).toBeUndefined();
    expect(schema.oneOf).toBeUndefined();
    expect(schema.allOf).toBeUndefined();
    expect(schema.enum).toBeUndefined();
    expect(schema.not).toBeUndefined();
    expect(importance).toMatchObject({
      type: "integer",
    });
    expect(importance?.minimum).toBeUndefined();
    expect(importance?.maximum).toBeUndefined();
    expect(expiry).toMatchObject({
      type: "string",
    });
    expect(expiry?.enum).toBeUndefined();
  });

  it("stores, updates, traces, and retires entries", async () => {
    const database = await createTestDatabase();
    const logger = createLogger();
    const services = createDatabaseBackedServices(database);
    const storeTool = createAgenrStoreTool(createToolContext(), Promise.resolve(services), logger);
    const updateTool = createAgenrUpdateTool(createToolContext(), Promise.resolve(services), logger);
    const traceTool = createAgenrTraceTool(createToolContext(), Promise.resolve(services), logger);
    const retireTool = createAgenrRetireTool(createToolContext(), Promise.resolve(services), logger);

    const storeResult = await storeTool.execute("tool-1", {
      type: "decision",
      subject: "feature flag policy",
      content: "Gate risky rollout work behind a feature flag until verification is complete.",
      importance: 8,
      expiry: "permanent",
      tags: ["rollout", "policy"],
    });
    const storedEntry = await createOpenClawRepository(database).findEntryBySubject("feature flag policy");

    const updateResult = await updateTool.execute("tool-2", {
      id: storedEntry?.id,
      importance: 9,
      expiry: "core",
    });
    const traceResult = await traceTool.execute("tool-3", {
      id: storedEntry?.id,
    });
    const retireResult = await retireTool.execute("tool-4", {
      subject: "feature flag policy",
      reason: "Superseded by rollout checklist v2.",
    });

    expect(storeResult.details).toMatchObject({
      status: "stored",
      subject: "feature flag policy",
    });
    expect(updateResult.details).toMatchObject({
      status: "updated",
      importance: 9,
      expiry: "core",
    });
    expect(traceResult.content[0]?.type).toBe("text");
    expect(traceResult.content[0]?.text).toContain("Trace for");
    expect(retireResult.details).toMatchObject({
      status: "retired",
    });
    expect(storedEntry).not.toBeNull();
    expect(await database.getEntry(storedEntry?.id ?? "")).toBeNull();
    expect(getMessages(logger.info)).toEqual(
      expect.arrayContaining([
        '[agenr] tool=agenr_store session=session-1 key=agent:main:webchat:test store 1 entry subject="feature flag policy" type=decision',
        expect.stringContaining("[agenr] tool=agenr_update session=session-1 key=agent:main:webchat:test target=id:"),
        expect.stringContaining("[agenr] tool=agenr_trace session=session-1 key=agent:main:webchat:test target=id:"),
        '[agenr] tool=agenr_retire session=session-1 key=agent:main:webchat:test target=subject:"feature flag policy"',
      ]),
    );
    const storeParamsMessage = getMessages(logger.info).find((message) => message.includes("tool=agenr_store") && message.includes("params="));
    expect(storeParamsMessage).toContain('"contentLength":77');
    expect(storeParamsMessage).not.toContain("Gate risky rollout work behind a feature flag until verification is complete.");
  });

  it("exposes the new recall schema without legacy temporal params", async () => {
    const recallTool = createAgenrRecallTool(createToolContext(), Promise.resolve({} as AgenrOpenClawServices), createLogger());
    const schema = recallTool.parameters as {
      properties?: Record<string, unknown>;
    };

    expect(schema.properties).toMatchObject({
      query: expect.any(Object),
      mode: expect.any(Object),
      limit: expect.any(Object),
      threshold: expect.any(Object),
      types: expect.any(Object),
      tags: expect.any(Object),
    });
    expect(schema.properties).not.toHaveProperty("since");
    expect(schema.properties).not.toHaveProperty("until");
    expect(schema.properties).not.toHaveProperty("around");
    expect(schema.properties).not.toHaveProperty("aroundRadius");
    expect(String(recallTool.description)).toContain("previous approach");
    expect(schema.properties?.query).toMatchObject({
      description: expect.stringContaining("previous approach"),
    });
    expect(schema.properties?.mode).toMatchObject({
      description: expect.stringContaining("historical-state recall"),
    });
  });

  it("runs unified entry recall through injected recall ports", async () => {
    const database = await createTestDatabase();
    const logger = createLogger();
    const entry = createEntry({
      subject: "session recall",
      content: "Prompt injection should surface relevant prior context.",
      type: "lesson",
      importance: 8,
      expiry: "permanent",
      tags: ["openclaw"],
    });
    let recordedRecallEvents = 0;
    const services = createServices(database, {
      available: true,
      recall: {
        async embed() {
          return createEmbedding(0, 1);
        },
        async vectorSearch() {
          return [];
        },
        async ftsSearch() {
          return [
            {
              entry: {
                id: entry.id,
                subject: entry.subject,
                content: entry.content,
                importance: entry.importance,
                expiry: entry.expiry,
                created_at: entry.created_at,
                embedding: createEmbedding(0, 1),
                superseded_by: entry.superseded_by,
                retired: entry.retired,
              },
              rank: 0,
              tier: "exact",
            },
          ];
        },
        async hydrateEntries(ids) {
          return ids.includes(entry.id) ? [entry] : [];
        },
        async recordRecallEvents() {
          recordedRecallEvents += 1;
        },
      },
    });
    const recallTool = createAgenrRecallTool(createToolContext(), Promise.resolve(services), logger);
    const query = "relevant prior context for the current session so the operator can verify recall isolation across multiple TUI sessions";

    const result = await recallTool.execute("tool-5", {
      query,
      limit: 3,
    });

    expect(result.details).toMatchObject({
      status: "ok",
      count: 1,
      routing: {
        requested: "auto",
        detectedIntent: "factual",
        queried: ["entries"],
      },
    });
    expect(result.content[0]?.text).toContain("Recall Route");
    expect(result.content[0]?.text).toContain("Entry Matches");
    expect(result.content[0]?.text).toContain("session recall");
    expect(recordedRecallEvents).toBe(1);
    expect(getMessages(logger.info)).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          `[agenr] tool=agenr_recall session=session-1 key=agent:main:webchat:test query=${JSON.stringify(truncateForLog(query, 80))} limit=3`,
        ),
        expect.stringContaining(
          '[agenr] tool=agenr_recall session=session-1 key=agent:main:webchat:test params={"query":"relevant prior context for the current session so the operator can verify recall isolation across multiple TUI sessions","limit":3}',
        ),
        '[agenr] tool=agenr_recall session=session-1 key=agent:main:webchat:test result: 0 episodes, 1 entry [entry subjects: "session recall"]',
      ]),
    );
    expect(logger.debug).not.toHaveBeenCalled();
  });

  it("allows mode=episodes when embeddings are unavailable", async () => {
    const database = await createTestDatabase();
    const logger = createLogger();
    await database.upsertEpisode({
      source: "openclaw",
      sourceId: "episode-session-1",
      transcriptHash: "episode-hash-1",
      startedAt: "2026-03-29T09:00:00.000Z",
      endedAt: "2026-03-29T10:00:00.000Z",
      summary: "We reviewed episodic recall and landed the OpenClaw tool contract for time-bounded recall.",
      tags: ["agenr", "openclaw"],
      activityLevel: "substantial",
    });
    const services = createServices(database, {
      available: false,
      recall: createVectorRecallPorts([]),
    });
    const recallTool = createAgenrRecallTool(createToolContext(), Promise.resolve(services), logger);

    const result = await recallTool.execute("tool-9", {
      query: "what happened on 2026-03-29",
      mode: "episodes",
      limit: 3,
    });

    expect(result.details).toMatchObject({
      status: "ok",
      count: 1,
      routing: {
        requested: "episodes",
        queried: ["episodes"],
      },
      episodes: [
        expect.objectContaining({
          sourceId: "episode-session-1",
        }),
      ],
      entries: [],
    });
    expect(result.content[0]?.text).toContain("Episode Matches");
    expect(result.content[0]?.text).toContain("episodic recall");
    expect(result.content[0]?.text).not.toContain("Entry recall was skipped");
  });

  it("routes mixed temporal narrative queries to episodes and entries", async () => {
    const database = await createTestDatabase();
    const logger = createLogger();
    await database.upsertEpisode({
      source: "openclaw",
      sourceId: "episode-session-2",
      transcriptHash: "episode-hash-2",
      startedAt: "2026-03-29T09:00:00.000Z",
      endedAt: "2026-03-29T10:00:00.000Z",
      summary: "We worked on agenr episode recall and wired the OpenClaw tool output for mixed recall results.",
      tags: ["agenr", "episode-recall"],
      activityLevel: "substantial",
    });
    const entry = createEntry({
      subject: "agenr episode recall",
      content: "Use a unified tool response with separate episode and entry sections.",
      type: "decision",
      tags: ["agenr", "episode-recall"],
    });
    const services = createServices(database, {
      available: true,
      recall: createExactRecallPorts([entry]),
    });
    const recallTool = createAgenrRecallTool(createToolContext(), Promise.resolve(services), logger);

    const result = await recallTool.execute("tool-10", {
      query: "what happened on agenr 2026-03-29",
      limit: 3,
      threshold: 0.2,
      tags: ["agenr"],
    });

    expect(result.details).toMatchObject({
      status: "ok",
      count: 2,
      routing: {
        requested: "auto",
        detectedIntent: "mixed",
        queried: ["episodes", "entries"],
      },
      timeWindow: {
        resolvedFrom: "2026-03-29",
      },
      episodes: [expect.objectContaining({ sourceId: "episode-session-2" })],
      entries: [expect.objectContaining({ subject: "agenr episode recall" })],
    });
    expect(result.content[0]?.text).toContain("Resolved Time Window");
    expect(result.content[0]?.text).toContain("Episode Matches");
    expect(result.content[0]?.text).toContain("Entry Matches");
    expect(result.content[0]?.text).toContain("Threshold, type filters, and tag filters were applied to entries only.");
  });

  it("keeps factual temporal queries entry-first", async () => {
    const database = await createTestDatabase();
    const logger = createLogger();
    const entry = createEntry({
      subject: "schema threshold decision",
      content: "We chose a 0.25 threshold for early episode-recall experiments.",
      type: "decision",
    });
    const services = createServices(database, {
      available: true,
      recall: createExactRecallPorts([entry]),
    });
    const recallTool = createAgenrRecallTool(createToolContext(), Promise.resolve(services), logger);

    const result = await recallTool.execute("tool-11", {
      query: "when did we set the schema threshold on 2026-03-29",
      limit: 2,
    });

    expect(result.details).toMatchObject({
      routing: {
        requested: "auto",
        detectedIntent: "mixed",
        queried: ["entries", "episodes"],
      },
    });
    expect(result.content[0]?.text).toContain("requested=auto detected=mixed queried=entries, episodes");
  });

  it("uses semantic episode search when mode=episodes has no time window", async () => {
    const database = await createTestDatabase();
    const logger = createLogger();
    const semanticEpisode = await database.upsertEpisode({
      source: "openclaw",
      sourceId: "semantic-episode",
      transcriptHash: "semantic-episode-hash",
      startedAt: "2026-03-29T09:00:00.000Z",
      endedAt: "2026-03-29T10:00:00.000Z",
      summary: "We added semantic episode search for recall without a time window.",
      tags: ["episodes", "semantic"],
      activityLevel: "substantial",
    });
    vi.spyOn(database, "episodeVectorSearch").mockResolvedValue([
      {
        episode: {
          ...semanticEpisode.episode,
          embedding: [1, 0],
        },
        vectorSim: 0.93,
      },
    ]);
    const services = createServices(database, {
      available: true,
      recall: createExactRecallPorts([
        createEntry({
          subject: "recent work",
          content: "This should not be returned when episode mode lacks a time window.",
        }),
      ]),
    });
    const recallTool = createAgenrRecallTool(createToolContext(), Promise.resolve(services), logger);

    const result = await recallTool.execute("tool-12", {
      query: "what did we do recently",
      mode: "episodes",
    });

    expect(result.details).toMatchObject({
      status: "ok",
      count: 1,
      routing: {
        requested: "episodes",
        queried: ["episodes"],
      },
      episodes: [
        expect.objectContaining({
          sourceId: "semantic-episode",
          whyMatched: "Semantic match to the episode summary.",
        }),
      ],
      entries: [],
      notices: [expect.stringContaining("Episodes cover consolidated prior sessions only")],
    });
    expect(result.content[0]?.text).toContain("Episode Matches");
    expect(result.content[0]?.text).toContain("We added semantic episode search for recall without a time window.");
    expect(result.content[0]?.text).toContain("Semantic match to the episode summary.");
  });

  it("renders historical-state results entry-first and logs the matched pattern at debug level", async () => {
    const database = await createTestDatabase();
    const logger = createLogger();
    const semanticEpisode = await database.upsertEpisode({
      source: "openclaw",
      sourceId: "history-episode",
      transcriptHash: "history-episode-hash",
      startedAt: "2026-03-20T09:00:00.000Z",
      endedAt: "2026-03-20T10:00:00.000Z",
      summary: "We migrated off the previous deployment path and documented the replacement.",
      tags: ["deploy", "history"],
      activityLevel: "substantial",
    });
    vi.spyOn(database, "episodeVectorSearch").mockResolvedValue([
      {
        episode: {
          ...semanticEpisode.episode,
          embedding: [1, 0],
        },
        vectorSim: 0.91,
      },
    ]);
    const entry = createEntry({
      subject: "deployment approach",
      content: "Before the migration we used the previous deployment path.",
      type: "decision",
    });
    const services = createServices(database, {
      available: true,
      recall: createExactRecallPorts([entry]),
    });
    const recallTool = createAgenrRecallTool(createToolContext(), Promise.resolve(services), logger);

    const result = await recallTool.execute("tool-history", {
      query: "what was the previous deployment approach",
      limit: 3,
    });

    expect(result.details).toMatchObject({
      status: "ok",
      routing: {
        requested: "auto",
        detectedIntent: "historical_state",
        queried: ["entries", "episodes"],
      },
    });
    const text = result.content[0]?.text ?? "";
    expect(text).toContain("requested=auto detected=historical_state queried=entries, episodes");
    expect(text.indexOf("Entry Matches")).toBeLessThan(text.indexOf("Episode Matches"));
    expect(getMessages(logger.debug)).toEqual(
      expect.arrayContaining([expect.stringContaining('unified recall matched historical-state pattern="what was the previous"')]),
    );
  });

  it("traces the most recent entry when last is true", async () => {
    const database = await createTestDatabase();
    const logger = createLogger();
    const services = createDatabaseBackedServices(database);
    const storeTool = createAgenrStoreTool(createToolContext(), Promise.resolve(services), logger);
    const traceTool = createAgenrTraceTool(createToolContext(), Promise.resolve(services), logger);

    await storeTool.execute("tool-6", {
      type: "fact",
      subject: "older memory",
      content: "This was stored first and should not be selected by last.",
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await storeTool.execute("tool-7", {
      type: "decision",
      subject: "newest memory",
      content: "This was stored most recently and should be selected by last.",
    });

    const result = await traceTool.execute("tool-8", {
      last: true,
    });

    expect(result.content[0]?.type).toBe("text");
    expect(result.content[0]?.text).toContain("newest memory");
    expect(getMessages(logger.info)).toContain("[agenr] tool=agenr_trace session=session-1 key=agent:main:webchat:test target=last");
  });

  it("stores explicit supersession metadata through agenr_store", async () => {
    const database = await createTestDatabase();
    const logger = createLogger();
    const services = createDatabaseBackedServices(database);
    const storeTool = createAgenrStoreTool(createToolContext(), Promise.resolve(services), logger);
    const traceTool = createAgenrTraceTool(createToolContext(), Promise.resolve(services), logger);

    await storeTool.execute("tool-13", {
      type: "fact",
      subject: "Jim home city",
      content: "Jim lives in Austin, Texas.",
      claimKey: "jim/home_city",
    });
    const original = await createOpenClawRepository(database).findEntryBySubject("Jim home city");

    const replacementResult = await storeTool.execute("tool-14", {
      type: "fact",
      subject: "Jim home city",
      content: "Jim lives in Denver, Colorado.",
      supersedes: original?.id,
      claimKey: "jim/home_city",
      validFrom: "2026-03-30T00:00:00.000Z",
    });
    const traceResult = await traceTool.execute("tool-15", {
      id: original?.id,
    });

    expect(replacementResult.details).toMatchObject({
      status: "stored",
      subject: "Jim home city",
    });
    expect(traceResult.content[0]?.text).toContain("superseded_by=");
    expect(traceResult.content[0]?.text).toContain("supersession_kind=update");
    expect(traceResult.content[0]?.text).toContain("claim_key=jim/home_city");

    const storeParamsMessages = getMessages(logger.info).filter((message) => message.includes("tool=agenr_store") && message.includes("params="));
    expect(storeParamsMessages.join("\n")).toContain('"hasSupersedes":true');
    expect(storeParamsMessages.join("\n")).toContain('"hasClaimKey":true');
    expect(storeParamsMessages.join("\n")).toContain('"hasValidFrom":true');
  });

  it("updates claim-key and validity metadata through agenr_update", async () => {
    const database = await createTestDatabase();
    const logger = createLogger();
    const services = createDatabaseBackedServices(database);
    const storeTool = createAgenrStoreTool(createToolContext(), Promise.resolve(services), logger);
    const updateTool = createAgenrUpdateTool(createToolContext(), Promise.resolve(services), logger);
    const traceTool = createAgenrTraceTool(createToolContext(), Promise.resolve(services), logger);

    await storeTool.execute("tool-16", {
      type: "fact",
      subject: "Jim timezone",
      content: "Jim's timezone is America/Chicago.",
    });
    const storedEntry = await createOpenClawRepository(database).findEntryBySubject("Jim timezone");

    const updateResult = await updateTool.execute("tool-17", {
      id: storedEntry?.id,
      claimKey: " Jim / Timezone ",
      validFrom: "2026-03-01T00:00:00.000Z",
      validTo: "2026-03-31T00:00:00.000Z",
    });
    const traceResult = await traceTool.execute("tool-18", {
      id: storedEntry?.id,
    });
    const updatedEntry = await database.getEntry(storedEntry?.id ?? "");

    expect(updateResult.details).toMatchObject({
      status: "updated",
      claimKey: "jim/timezone",
      validFrom: "2026-03-01T00:00:00.000Z",
      validTo: "2026-03-31T00:00:00.000Z",
    });
    expect(updatedEntry).toMatchObject({
      claim_key: "jim/timezone",
      valid_from: "2026-03-01T00:00:00.000Z",
      valid_to: "2026-03-31T00:00:00.000Z",
    });
    expect(traceResult.content[0]?.text).toContain("claim_key=jim/timezone");
    expect(traceResult.content[0]?.text).toContain("validity=2026-03-01T00:00:00.000Z -> 2026-03-31T00:00:00.000Z");

    const updateParamsMessage = getMessages(logger.info).find((message) => message.includes("tool=agenr_update") && message.includes("params="));
    expect(updateParamsMessage).toContain('"hasClaimKey":true');
    expect(updateParamsMessage).toContain('"hasValidFrom":true');
    expect(updateParamsMessage).toContain('"hasValidTo":true');
  });

  it("extracts claim keys at store time using OpenClaw auth", async () => {
    const database = await createTestDatabase();
    const logger = createLogger();
    const resolveApiKeyForProvider = vi.fn(async () => ({
      apiKey: "openclaw-claim-key",
      source: "profile:default",
      mode: "api-key" as const,
    }));
    const openClaw = createOpenClawHost({
      resolveApiKeyForProvider,
    });
    piAiMocks.getModel.mockReturnValue(
      buildModel({
        id: "claude-haiku-4-5",
        name: "Claude Haiku 4.5",
        provider: "anthropic",
        api: "anthropic-messages",
      }),
    );
    piAiMocks.completeSimple.mockResolvedValue(buildAssistantMessage('```json\n{"entity":"jim","attribute":"timezone","confidence":0.95}\n```'));

    const services = createServices(database, {
      available: true,
      recall: createExactRecallPorts([]),
      openClaw,
      claimExtraction: {
        llm: await createOpenClawLlmClient(openClaw, "anthropic/claude-haiku-4-5"),
        config: {
          enabled: true,
          confidenceThreshold: 0.8,
          eligibleTypes: ["fact"],
        },
      },
    });
    const storeTool = createAgenrStoreTool(createToolContext(), Promise.resolve(services), logger);

    const result = await storeTool.execute("tool-19", {
      type: "fact",
      subject: "Jim timezone",
      content: "Jim's timezone is America/Chicago.",
    });
    const storedEntry = await createOpenClawRepository(database).findEntryBySubject("Jim timezone");

    expect(result.details).toMatchObject({
      status: "stored",
      subject: "Jim timezone",
    });
    expect(storedEntry).toMatchObject({
      claim_key: "jim/timezone",
    });
    expect(resolveApiKeyForProvider).toHaveBeenCalledWith({
      provider: "anthropic",
      cfg: openClaw.config,
    });
    expect(piAiMocks.getModel).toHaveBeenCalledWith("anthropic", "claude-haiku-4-5");
    expect(piAiMocks.completeSimple.mock.calls[0]?.[2]).toMatchObject({
      apiKey: "openclaw-claim-key",
    });
  });
});

function createDatabaseBackedServices(database: SqlDatabase): AgenrOpenClawServices {
  return createServices(database, {
    available: true,
    recall: {
      async embed() {
        return createEmbedding(0, 1);
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
    },
  });
}

function createServices(
  database: SqlDatabase,
  options: {
    available: boolean;
    recall: RecallPorts;
    openClaw?: AgenrOpenClawHost;
    claimExtraction?: AgenrOpenClawServices["claimExtraction"];
  },
): AgenrOpenClawServices {
  const embedding: EmbeddingPort = {
    async embed(texts) {
      return texts.map((text, index) => createEmbedding(index, text.length || 1));
    },
  };
  const openClaw = options.openClaw ?? createOpenClawHost();

  return {
    openClaw,
    config: {
      dbPath: "test.db",
    },
    pluginConfig: {},
    agenrConfig: {},
    dbPath: "test.db",
    entries: database,
    episodes: database,
    memory: createOpenClawRepository(database),
    embedding,
    recall: options.recall,
    claimExtraction: options.claimExtraction,
    embeddingStatus: {
      available: options.available,
      provider: options.available ? "openai" : "unconfigured",
      requestedProvider: "openai",
      model: "text-embedding-3-small",
      ...(options.available ? {} : { error: "Embedding API key is required." }),
    },
    async close() {
      await database.close();
    },
  };
}

function createOpenClawHost(
  options: {
    model?: string;
    resolveApiKeyForProvider?: AgenrOpenClawHost["runtime"]["modelAuth"]["resolveApiKeyForProvider"];
  } = {},
): AgenrOpenClawHost {
  const workspaceDir = path.join(os.tmpdir(), "agenr-openclaw-test-workspace");
  const agentDir = path.join(os.tmpdir(), "agenr-openclaw-test-agent");
  const config = {
    defaultAgent: "main",
    agents: {
      list: [
        {
          id: "main",
          workspace: workspaceDir,
          agentDir,
          model: options.model ?? "openai/gpt-5.4-mini",
        },
      ],
    },
  } as unknown as OpenClawConfig;

  return {
    config,
    runtime: {
      agent: {
        resolveAgentDir: () => agentDir,
        resolveAgentWorkspaceDir: () => workspaceDir,
        runEmbeddedPiAgent: async () => {
          throw new Error("Embedded continuity summary runner unavailable.");
        },
      },
      modelAuth: {
        resolveApiKeyForProvider:
          options.resolveApiKeyForProvider ??
          (async () => ({
            apiKey: "openclaw-test-key",
            source: "profile:default",
            mode: "api-key",
          })),
      },
      state: {
        resolveStateDir: () => path.join(os.tmpdir(), ".openclaw"),
      },
    },
  };
}

function createVectorRecallPorts(entries: Entry[]): RecallPorts {
  return {
    async embed() {
      return createEmbedding(0, 1);
    },
    async vectorSearch() {
      return entries.map((entry, index) => ({
        entry: {
          id: entry.id,
          subject: entry.subject,
          content: entry.content,
          importance: entry.importance,
          expiry: entry.expiry,
          created_at: entry.created_at,
          embedding: createEmbedding(index, 1),
          superseded_by: entry.superseded_by,
          retired: entry.retired,
        },
        vectorSim: 0.95 - index * 0.05,
      }));
    },
    async ftsSearch() {
      return [];
    },
    async hydrateEntries(ids) {
      return entries.filter((entry) => ids.includes(entry.id));
    },
    async recordRecallEvents() {
      return;
    },
  };
}

function createExactRecallPorts(entries: Entry[]): RecallPorts {
  return {
    async embed() {
      return createEmbedding(0, 1);
    },
    async vectorSearch() {
      return [];
    },
    async ftsSearch() {
      return entries.map((entry) => ({
        entry: {
          id: entry.id,
          subject: entry.subject,
          content: entry.content,
          importance: entry.importance,
          expiry: entry.expiry,
          created_at: entry.created_at,
          embedding: createEmbedding(0, 1),
          superseded_by: entry.superseded_by,
          retired: entry.retired,
        },
        rank: 0,
        tier: "exact" as const,
      }));
    },
    async hydrateEntries(ids) {
      return entries.filter((entry) => ids.includes(entry.id));
    },
    async recordRecallEvents() {
      return;
    },
  };
}

function createToolContext() {
  return {
    agentId: "main",
    sessionId: "session-1",
    sessionKey: "agent:main:webchat:test",
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

function truncateForLog(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, maxChars - 3).trimEnd()}...`;
}

async function createTestDatabase(): Promise<SqlDatabase> {
  const databasePath = path.join(os.tmpdir(), `agenr-openclaw-tools-${randomUUID()}.sqlite`);
  tempDatabasePaths.push(databasePath);

  const database = await createDatabase(databasePath);
  openDatabases.push(database);
  return database;
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
    valid_from: overrides.valid_from,
    valid_to: overrides.valid_to,
    claim_key: overrides.claim_key,
    supersession_kind: overrides.supersession_kind,
    supersession_reason: overrides.supersession_reason,
    cluster_id: overrides.cluster_id,
    user_id: overrides.user_id,
    project: overrides.project,
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

function buildModel(overrides: Partial<Model<Api>> = {}): Model<Api> {
  return {
    id: "gpt-5.4-mini",
    name: "GPT-5.4 Mini",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    reasoning: true,
    input: ["text"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 400_000,
    maxTokens: 131_072,
    ...overrides,
  };
}

function buildAssistantMessage(text: string): AssistantMessage {
  return {
    role: "assistant",
    api: "openai-responses",
    provider: "openai",
    model: "gpt-5.4-mini",
    content: [{ type: "text", text }],
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}
