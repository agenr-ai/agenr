import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { afterEach, describe, expect, it, vi } from "vitest";

const piAiMocks = vi.hoisted(() => ({
  completeSimple: vi.fn(),
  getModel: vi.fn(),
}));

vi.mock("@earendil-works/pi-ai", () => ({
  completeSimple: piAiMocks.completeSimple,
  getModel: piAiMocks.getModel,
}));

import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";

import { createDatabase, type SqlDatabase } from "../../../src/adapters/db/client.js";
import { createDreamPort } from "../../../src/adapters/db/dreaming-port.js";
import { createMemoryRepository } from "../../../src/adapters/db/memory-repository.js";
import { createSessionStartRepository } from "../../../src/adapters/db/session-start-repository.js";
import { createOpenClawLlmClient } from "../../../src/adapters/openclaw/llm/openclaw-llm-client.js";
import { computeProcedureRevisionHash, computeProcedureSourceHash } from "../../../src/core/procedures/hashing.js";
import { composeProcedureRecallText } from "../../../src/core/procedures/recall-text.js";
import { createAgenrFetchTool, createAgenrRecallTool, createAgenrStoreTool, createAgenrUpdateTool } from "../../../src/adapters/openclaw/tools.js";
import { createNoopAgenrDebugSink } from "../../../src/adapters/openclaw/debug/index.js";
import { createStubAgenrHostMemorySurface } from "../../helpers/host-memory-stubs.js";
import type { AgenrOpenClawHost, AgenrOpenClawServices } from "../../../src/adapters/openclaw/types.js";
import type { EmbeddingPort, RecallPorts } from "../../../src/core/ports.js";
import type { Durable, Procedure } from "../../../src/core/types.js";
import { finalizeTestDurable } from "../../helpers/durable-fixtures.js";
import { closeTestDatabases, removeTestPath } from "../../helpers/temp-paths.js";

const openDatabases: SqlDatabase[] = [];
const tempDatabasePaths: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  piAiMocks.completeSimple.mockReset();
  piAiMocks.getModel.mockReset();

  await closeTestDatabases(openDatabases);

  while (tempDatabasePaths.length > 0) {
    await removeTestPath(tempDatabasePaths.pop() ?? "");
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

  it("describes metadata-only boundaries for agenr_update", () => {
    const updateTool = createAgenrUpdateTool(createToolContext(), Promise.resolve({} as AgenrOpenClawServices), createLogger());

    expect(String(updateTool.description)).toContain("Supports metadata corrections");
    expect(String(updateTool.description)).toContain("Provide exactly one target selector");
    expect(String(updateTool.description)).toContain("Use agenr_store with supersedes for substantive content replacement");
  });

  it("describes durable-memory boundaries for agenr_store", () => {
    const storeTool = createAgenrStoreTool(createToolContext(), Promise.resolve({} as AgenrOpenClawServices), createLogger());
    const schema = storeTool.parameters as {
      properties?: Record<string, { description?: string }>;
    };

    expect(String(storeTool.description)).toContain("future-session test");
    expect(String(storeTool.description)).toContain("Do not store progress logs");
    expect(String(storeTool.description)).toContain("Store the durable takeaway");
    expect(String(storeTool.description)).toContain("canonical record");
    expect(String(storeTool.description)).toContain("version control");
    expect(String(storeTool.description)).toContain("Do not use decision as a catch-all");
    expect(String(storeTool.description)).toContain("I filed a support ticket.");
    expect(String(storeTool.description)).toContain("Jim prefers text-first updates");
    expect(String(storeTool.description)).toContain("Use claimKey for slot-like facts");
    expect(String(storeTool.description)).toContain("Format claimKey for slot-like durables");
    expect(schema.properties?.type?.description).toContain("not a progress update or completed action");
    expect(schema.properties?.type?.description).toContain("not ordinary execution progress");
    expect(schema.properties?.content?.description).toContain("not the activity log, canonical record, or transient progress snapshot");
  });

  it("returns the full durable body from agenr_fetch", async () => {
    const database = await createTestDatabase();
    const logger = createLogger();
    const services = createDatabaseBackedServices(database);
    const storeTool = createAgenrStoreTool(createToolContext(), Promise.resolve(services), logger);
    const fetchTool = createAgenrFetchTool(createToolContext(), Promise.resolve(services), logger);
    const longContent = "Long durable body for fetch verification. ".repeat(12);

    await storeTool.execute("tool-store-fetch", {
      type: "fact",
      subject: "long recall body",
      content: longContent,
    });
    const stored = await createMemoryRepository(database).findDurableBySubject("long recall body");
    expect(stored).not.toBeNull();

    const result = await fetchTool.execute("tool-fetch", { id: stored?.id });
    const storedDurable = await database.getDurable(stored?.id ?? "");
    const expectedContent = storedDurable?.content ?? longContent.trim();

    expect(result.details).toMatchObject({
      status: "ok",
      durableId: stored?.id,
      content: expectedContent,
    });
    expect(expectTextContent(result.content[0])).toContain(expectedContent);
    expect(getMessages(logger.info)).toEqual(
      expect.arrayContaining([expect.stringContaining("[agenr] tool=agenr_fetch session=session-1 key=agent:main:webchat:test target=id:")]),
    );
  });

  it("stores, updates, and closes validity via valid_to", async () => {
    const database = await createTestDatabase();
    const logger = createLogger();
    const services = createDatabaseBackedServices(database);
    const storeTool = createAgenrStoreTool(createToolContext(), Promise.resolve(services), logger);
    const updateTool = createAgenrUpdateTool(createToolContext(), Promise.resolve(services), logger);

    const storeResult = await storeTool.execute("tool-1", {
      type: "decision",
      subject: "feature flag policy",
      content: "Gate risky rollout work behind a feature flag until verification is complete.",
      importance: 8,
      expiry: "permanent",
      tags: ["rollout", "policy"],
    });
    const storedDurable = await createMemoryRepository(database).findDurableBySubject("feature flag policy");

    const updateResult = await updateTool.execute("tool-2", {
      id: storedDurable?.id,
      importance: 9,
      expiry: "core",
    });
    const staleResult = await updateTool.execute("tool-4", {
      subject: "feature flag policy",
      validTo: "2026-01-01T00:00:00.000Z",
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
    expect(staleResult.details).toMatchObject({
      status: "updated",
      validTo: "2026-01-01T00:00:00.000Z",
    });
    expect(storedDurable).not.toBeNull();
    expect(await database.getDurable(storedDurable?.id ?? "")).toBeNull();
    expect(getMessages(logger.info)).toEqual(
      expect.arrayContaining([
        '[agenr] tool=agenr_store session=session-1 key=agent:main:webchat:test store 1 durable subject="feature flag policy" type=decision',
        expect.stringContaining("[agenr] tool=agenr_update session=session-1 key=agent:main:webchat:test target=id:"),
        expect.stringContaining('[agenr] tool=agenr_update session=session-1 key=agent:main:webchat:test target=subject:"feature flag policy"'),
      ]),
    );
    const storeParamsMessage = getMessages(logger.info).find((message) => message.includes("tool=agenr_store") && message.includes("params="));
    expect(storeParamsMessage).toContain('"contentLength":77');
    expect(storeParamsMessage).not.toContain("Gate risky rollout work behind a feature flag until verification is complete.");
  });

  it("logs non-fatal store warnings without marking the OpenClaw tool call as warned", async () => {
    const database = await createTestDatabase();
    const logger = createLogger();
    const services = createDatabaseBackedServices(database);
    const storeTool = createAgenrStoreTool(createToolContext(), Promise.resolve(services), logger);

    const result = await storeTool.execute("tool-store-warning", {
      type: "fact",
      subject: "warning log level",
      content: "Successful stores with non-fatal warnings should not look failed in verbose OpenClaw output.",
      claimKey: "invalid",
    });

    expect(result.details).toMatchObject({
      status: "stored",
      subject: "warning log level",
    });
    expect(logger.warn).not.toHaveBeenCalled();
    expect(getMessages(logger.info)).toEqual(expect.arrayContaining([expect.stringContaining("[agenr] tool=agenr_store session=session-1 note:")]));
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
      budget: expect.any(Object),
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

  it("runs unified durable recall through injected recall ports", async () => {
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
              durable: {
                id: entry.id,
                subject: entry.subject,
                content: entry.content,
                importance: entry.importance,
                expiry: entry.expiry,
                created_at: entry.created_at,
                embedding: createEmbedding(0, 1),
                superseded_by: entry.superseded_by,
              },
              rank: 0,
              tier: "exact",
            },
          ];
        },
        async hydrateDurables(ids) {
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
        queried: ["durables"],
      },
      projectedDurables: [
        expect.objectContaining({
          id: entry.id,
          memoryState: "current",
        }),
      ],
    });
    expect(expectTextContent(result.content[0])).toContain("Recall Route");
    expect(expectTextContent(result.content[0])).toContain("Durable Matches");
    expect(expectTextContent(result.content[0])).toContain("session recall");
    expect(expectTextContent(result.content[0])).toContain("state=current");
    expect(expectTextContent(result.content[0])).toContain("why_surfaced=");
    expect(expectTextContent(result.content[0])).toContain("preview_truncated=");
    expect(expectTextContent(result.content[0])).not.toContain("Structured Details");
    const recallDetails = result.details as { entries?: Array<Record<string, unknown>> };
    expect(recallDetails.durables).toEqual([
      expect.objectContaining({
        id: entry.id,
        previewTruncated: expect.any(Boolean),
        contentPreview: expect.any(String),
        contentChars: entry.content.length,
      }),
    ]);
    expect((recallDetails.durables as Array<Record<string, unknown>>)[0]).not.toHaveProperty("content");
    expect(recordedRecallEvents).toBe(1);
    expect(getMessages(logger.info)).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          `[agenr] tool=agenr_recall session=session-1 key=agent:main:webchat:test query=${JSON.stringify(truncateForLog(query, 80))} limit=3`,
        ),
        expect.stringContaining(
          '[agenr] tool=agenr_recall session=session-1 key=agent:main:webchat:test params={"query":"relevant prior context for the current session so the operator can verify recall isolation across multiple TUI sessions","limit":3}',
        ),
        '[agenr] tool=agenr_recall session=session-1 key=agent:main:webchat:test result: 0 episodes, 1 durable [durable subjects: "session recall"]',
      ]),
    );
    expect(logger.debug).not.toHaveBeenCalled();
  });

  it("keeps narrow entity-attribute recall precise and logs the detected shape at debug level", async () => {
    const database = await createTestDatabase();
    const logger = createLogger();
    const locationEntry = createEntry({
      subject: "Jim Martin dad location",
      content: "Jim Martin's dad lives in Austin, Texas.",
      type: "fact",
      importance: 8,
      expiry: "permanent",
    });
    const distractorEntry = createEntry({
      subject: "Jim Martin work email",
      content: "Jim Martin uses jim@example.com for work.",
      type: "fact",
      importance: 8,
      expiry: "permanent",
    });
    const services = createServices(database, {
      available: true,
      recall: {
        async embed() {
          return createEmbedding(0, 1);
        },
        async vectorSearch() {
          return [
            {
              durable: {
                id: distractorEntry.id,
                subject: distractorEntry.subject,
                content: distractorEntry.content,
                importance: distractorEntry.importance,
                expiry: distractorEntry.expiry,
                created_at: distractorEntry.created_at,
                embedding: createEmbedding(0, 1),
                superseded_by: distractorEntry.superseded_by,
                valid_to: distractorEntry.valid_to,
              },
              vectorSim: 0.87,
            },
            {
              durable: {
                id: locationEntry.id,
                subject: locationEntry.subject,
                content: locationEntry.content,
                importance: locationEntry.importance,
                expiry: locationEntry.expiry,
                created_at: locationEntry.created_at,
                embedding: createEmbedding(1, 1),
                superseded_by: locationEntry.superseded_by,
                valid_to: locationEntry.valid_to,
              },
              vectorSim: 0.81,
            },
          ];
        },
        async ftsSearch() {
          return [
            {
              durable: {
                id: distractorEntry.id,
                subject: distractorEntry.subject,
                content: distractorEntry.content,
                importance: distractorEntry.importance,
                expiry: distractorEntry.expiry,
                created_at: distractorEntry.created_at,
                embedding: createEmbedding(0, 1),
                superseded_by: distractorEntry.superseded_by,
                valid_to: distractorEntry.valid_to,
              },
              rank: 0,
              tier: "any_tokens",
            },
            {
              durable: {
                id: locationEntry.id,
                subject: locationEntry.subject,
                content: locationEntry.content,
                importance: locationEntry.importance,
                expiry: locationEntry.expiry,
                created_at: locationEntry.created_at,
                embedding: createEmbedding(1, 1),
                superseded_by: locationEntry.superseded_by,
                valid_to: locationEntry.valid_to,
              },
              rank: 1,
              tier: "all_tokens",
            },
          ];
        },
        async hydrateDurables(ids) {
          return [locationEntry, distractorEntry].filter((entry) => ids.includes(entry.id));
        },
        async recordRecallEvents() {
          return;
        },
      },
    });
    const recallTool = createAgenrRecallTool(createToolContext(), Promise.resolve(services), logger);

    const result = await recallTool.execute("tool-entity-attribute", {
      query: "Where does Jim Martin's dad live?",
      mode: "durables",
      limit: 6,
      threshold: 0.2,
    });

    expect(result.details).toMatchObject({
      status: "ok",
      count: 1,
      routing: {
        requested: "durables",
        detectedIntent: "entity_attribute",
        queried: ["durables"],
      },
      durables: [expect.objectContaining({ subject: "Jim Martin dad location" })],
    });
    expect(expectTextContent(result.content[0])).toContain("Jim Martin dad location");
    expect(expectTextContent(result.content[0])).not.toContain("Jim Martin work email");
    expect(getMessages(logger.debug)).toEqual(
      expect.arrayContaining([expect.stringContaining('unified recall matched entity-attribute kind="location" entity="Jim Martin\'s dad"')]),
    );
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
      durables: [],
    });
    expect(expectTextContent(result.content[0])).toContain("Episode Matches");
    expect(expectTextContent(result.content[0])).toContain("episodic recall");
    expect(expectTextContent(result.content[0])).not.toContain("Durable recall was skipped");
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
        queried: ["episodes", "durables"],
      },
      timeWindow: {
        resolvedFrom: "2026-03-29",
      },
      episodes: [expect.objectContaining({ sourceId: "episode-session-2" })],
      durables: [expect.objectContaining({ subject: "agenr episode recall" })],
    });
    expect(expectTextContent(result.content[0])).toContain("Resolved Time Window");
    expect(expectTextContent(result.content[0])).toContain("Episode Matches");
    expect(expectTextContent(result.content[0])).toContain("Durable Matches");
    expect(expectTextContent(result.content[0])).toContain("Type and tag filters were applied to durables only.");
  });

  it("renders a structured canonical procedure block for procedural recall", async () => {
    const database = await createTestDatabase();
    const logger = createLogger();
    await database.upsertProcedure(createProcedure());
    const services = createServices(database, {
      available: false,
      recall: createExactRecallPorts([]),
    });
    const recallTool = createAgenrRecallTool(createToolContext(), Promise.resolve(services), logger);

    const result = await recallTool.execute("tool-procedure", {
      query: "how do I rotate the production signing key safely",
      mode: "procedures",
      limit: 3,
    });

    expect(result.details).toMatchObject({
      status: "ok",
      count: 1,
      routing: {
        requested: "procedures",
        detectedIntent: "procedural",
        queried: ["procedures"],
      },
      procedure: {
        procedureKey: "security/signing-key-rotation",
        title: "Rotate the production signing key",
      },
      procedures: [
        expect.objectContaining({
          procedureKey: "security/signing-key-rotation",
          title: "Rotate the production signing key",
        }),
      ],
      procedureNotices: [expect.stringContaining("lexical-only procedure ranking")],
    });
    expect(expectTextContent(result.content[0])).toContain("Procedure Matches");
    expect(expectTextContent(result.content[0])).toContain("Canonical Procedure. security/signing-key-rotation | Rotate the production signing key");
    expect(expectTextContent(result.content[0])).toContain("goal=Rotate the production signing key safely.");
    expect(expectTextContent(result.content[0])).toContain("steps");
    expect(expectTextContent(result.content[0])).toContain("[inspect_state] Inspect the current signing key state before rotating it.");
    expect(getMessages(logger.info)).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          '[agenr] tool=agenr_recall session=session-1 key=agent:main:webchat:test result: 1 procedure candidate, 0 episodes, 0 durables [procedure: "Rotate the production signing key"]',
        ),
      ]),
    );
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
        queried: ["durables", "episodes"],
      },
    });
    expect(expectTextContent(result.content[0])).toContain("requested=auto detected=mixed queried=durables, episodes");
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
      durables: [],
      notices: [expect.stringContaining("Episodes cover consolidated prior sessions only")],
    });
    expect(expectTextContent(result.content[0])).toContain("Episode Matches");
    expect(expectTextContent(result.content[0])).toContain("We added semantic episode search for recall without a time window.");
    expect(expectTextContent(result.content[0])).toContain("Semantic match to the episode summary.");
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
      claim_key: "deployment/approach",
      claim_key_status: "trusted",
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
        queried: ["durables", "episodes"],
      },
      claimTransitions: [
        expect.objectContaining({
          claimKey: "deployment/approach",
          slotPolicy: "exclusive",
        }),
      ],
    });
    const text = expectTextContent(result.content[0]);
    expect(text).toContain("requested=auto detected=historical_state queried=durables, episodes");
    expect(text.indexOf("Durable Matches")).toBeLessThan(text.indexOf("Episode Matches"));
    expect(text).toContain("Claim Transitions");
    expect(text).toContain("slot_policy=exclusive");
    expect(getMessages(logger.debug)).toEqual(
      expect.arrayContaining([expect.stringContaining('unified recall matched historical-state pattern="what was the previous"')]),
    );
  });

  it("stores explicit supersession metadata through agenr_store", async () => {
    const database = await createTestDatabase();
    const logger = createLogger();
    const services = createDatabaseBackedServices(database);
    const storeTool = createAgenrStoreTool(createToolContext(), Promise.resolve(services), logger);

    await storeTool.execute("tool-13", {
      type: "fact",
      subject: "Jim home city",
      content: "Jim lives in Austin, Texas.",
      claimKey: "jim/home_city",
    });
    const original = await createMemoryRepository(database).findDurableBySubject("Jim home city");

    const replacementResult = await storeTool.execute("tool-14", {
      type: "fact",
      subject: "Jim home city",
      content: "Jim lives in Denver, Colorado.",
      supersedes: original?.id,
      claimKey: "jim/home_city",
      validFrom: "2026-03-30T00:00:00.000Z",
    });
    const replacementEntryId = (replacementResult.details as { durableId?: string }).durableId ?? "";
    const replacementEntry = await database.getDurable(replacementEntryId);

    expect(replacementResult.details).toMatchObject({
      status: "stored",
      subject: "Jim home city",
    });
    expect(replacementEntry).toMatchObject({
      claim_key: "jim/home_city",
      claim_key_status: "trusted",
      claim_key_source: "manual",
      claim_key_confidence: 1,
      claim_key_rationale: "manual claim key supplied by caller",
      claim_support_source_kind: "tool_call",
      claim_support_mode: "explicit",
    });
    expect(replacementEntry?.claim_support_locator).toContain("#agenr_store");
    expect(replacementEntry?.claim_support_observed_at).toMatch(/^20\d\d-/);
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

    await storeTool.execute("tool-16", {
      type: "fact",
      subject: "Jim timezone",
      content: "Jim's timezone is America/Chicago.",
    });
    const storedDurable = await createMemoryRepository(database).findDurableBySubject("Jim timezone");

    const updateResult = await updateTool.execute("tool-17", {
      id: storedDurable?.id,
      claimKey: " Jim / Timezone ",
      validFrom: "2027-03-01T00:00:00.000Z",
      validTo: "2027-03-31T00:00:00.000Z",
      project: "agenr",
    });
    const updatedEntry = await database.getDurable(storedDurable?.id ?? "");

    expect(updateResult.details).toMatchObject({
      status: "updated",
      claimKey: "jim/timezone",
      validFrom: "2027-03-01T00:00:00.000Z",
      validTo: "2027-03-31T00:00:00.000Z",
      project: "agenr",
    });
    expect(updatedEntry).toMatchObject({
      claim_key: "jim/timezone",
      claim_key_raw: "Jim / Timezone",
      claim_key_status: "trusted",
      claim_key_source: "manual",
      claim_key_confidence: 1,
      claim_key_rationale: "manual claim key supplied by caller",
      claim_support_source_kind: "tool_call",
      claim_support_mode: "explicit",
      valid_from: "2027-03-01T00:00:00.000Z",
      valid_to: "2027-03-31T00:00:00.000Z",
      project: "agenr",
    });
    expect(updatedEntry?.claim_support_locator).toContain("#agenr_update");
    expect(updatedEntry?.claim_support_observed_at).toMatch(/^20\d\d-/);
    const updateParamsMessage = getMessages(logger.info).find((message) => message.includes("tool=agenr_update") && message.includes("params="));
    expect(updateParamsMessage).toContain('"hasClaimKey":true');
    expect(updateParamsMessage).toContain('"hasValidFrom":true');
    expect(updateParamsMessage).toContain('"hasValidTo":true');
    expect(updateParamsMessage).toContain('"hasProject":true');
  });

  it("rejects invalid claimKey input through agenr_update", async () => {
    const database = await createTestDatabase();
    const logger = createLogger();
    const services = createDatabaseBackedServices(database);
    const storeTool = createAgenrStoreTool(createToolContext(), Promise.resolve(services), logger);
    const updateTool = createAgenrUpdateTool(createToolContext(), Promise.resolve(services), logger);

    await storeTool.execute("tool-17-invalid-store", {
      type: "fact",
      subject: "Jim timezone",
      content: "Jim's timezone is America/Chicago.",
    });
    const storedDurable = await createMemoryRepository(database).findDurableBySubject("Jim timezone");

    const updateResult = await updateTool.execute("tool-17-invalid-update", {
      id: storedDurable?.id,
      claimKey: "invalid",
    });

    expect(updateResult.content[0]?.type).toBe("text");
    expect(expectTextContent(updateResult.content[0])).toContain("claimKey must use canonical entity/attribute format.");
    expect(updateResult.details).toMatchObject({
      status: "failed",
    });
  });

  it("rejects agenr_update validity changes that conflict with an existing bound", async () => {
    const database = await createTestDatabase();
    const logger = createLogger();
    const services = createDatabaseBackedServices(database);
    const storeTool = createAgenrStoreTool(createToolContext(), Promise.resolve(services), logger);
    const updateTool = createAgenrUpdateTool(createToolContext(), Promise.resolve(services), logger);

    await storeTool.execute("tool-17a", {
      type: "fact",
      subject: "Jim timezone",
      content: "Jim's timezone is America/Chicago.",
      validTo: "2027-03-31T00:00:00.000Z",
    });
    const storedDurable = await createMemoryRepository(database).findDurableBySubject("Jim timezone");

    const updateResult = await updateTool.execute("tool-17b", {
      id: storedDurable?.id,
      validFrom: "2027-04-01T00:00:00.000Z",
    });

    expect(updateResult.content[0]?.type).toBe("text");
    expect(expectTextContent(updateResult.content[0])).toContain("valid_from must be earlier than valid_to.");
    expect(updateResult.details).toMatchObject({
      status: "failed",
    });
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
    const storedDurable = await createMemoryRepository(database).findDurableBySubject("Jim timezone");

    expect(result.details).toMatchObject({
      status: "stored",
      subject: "Jim timezone",
    });
    expect(storedDurable).toMatchObject({
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
      async hydrateDurables() {
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
    debugSink?: AgenrOpenClawServices["debugSink"];
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
      configPath: "test-config.json",
    },
    pluginConfig: {},
    agenrConfig: {},
    durables: database,
    episodes: database,
    procedures: database,
    memory: createMemoryRepository(database),
    dreaming: createDreamPort(database),
    sessionStart: {
      repository: createSessionStartRepository(database),
      recall: options.recall,
    },
    beforeTurn: {
      recall: options.recall,
      procedures: database,
      ...(options.available
        ? {
            embedQuery: async (text: string) => {
              const vectors = await embedding.embed([text]);
              return vectors[0] ?? [];
            },
          }
        : {}),
    },
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
    debugSink: options.debugSink ?? createNoopAgenrDebugSink(),
    ...createStubAgenrHostMemorySurface(),
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

function createVectorRecallPorts(entries: Durable[]): RecallPorts {
  return {
    async embed() {
      return createEmbedding(0, 1);
    },
    async vectorSearch() {
      return entries.map((entry, index) => ({
        durable: {
          id: entry.id,
          subject: entry.subject,
          content: entry.content,
          importance: entry.importance,
          expiry: entry.expiry,
          created_at: entry.created_at,
          embedding: createEmbedding(index, 1),
          superseded_by: entry.superseded_by,
        },
        vectorSim: 0.95 - index * 0.05,
      }));
    },
    async ftsSearch() {
      return [];
    },
    async hydrateDurables(ids) {
      return entries.filter((entry) => ids.includes(entry.id));
    },
    async recordRecallEvents() {
      return;
    },
  };
}

function createExactRecallPorts(entries: Durable[]): RecallPorts {
  return {
    async embed() {
      return createEmbedding(0, 1);
    },
    async vectorSearch() {
      return [];
    },
    async ftsSearch() {
      return entries.map((entry) => ({
        durable: {
          id: entry.id,
          subject: entry.subject,
          content: entry.content,
          importance: entry.importance,
          expiry: entry.expiry,
          created_at: entry.created_at,
          embedding: createEmbedding(0, 1),
          superseded_by: entry.superseded_by,
        },
        rank: 0,
        tier: "exact" as const,
      }));
    },
    async hydrateDurables(ids) {
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

/** Asserts a tool result content block is text and returns its body. */
function expectTextContent(content: { type: string; text?: string } | undefined): string {
  if (!content || content.type !== "text" || content.text === undefined) {
    throw new Error("Expected a text content block.");
  }

  return content.text;
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

function createEntry(overrides: Partial<Durable> = {}): Durable {
  const now = new Date("2026-03-27T12:00:00.000Z").toISOString();
  return finalizeTestDurable({
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
    user_id: overrides.user_id,
    project: overrides.project,
    created_at: overrides.created_at ?? now,
    updated_at: overrides.updated_at ?? now,
  });
}

function createProcedure(overrides: Partial<Procedure> = {}): Procedure {
  const now = overrides.created_at ?? new Date("2026-03-27T12:00:00.000Z").toISOString();
  const body = {
    procedure_key: overrides.procedure_key ?? "security/signing-key-rotation",
    title: overrides.title ?? "Rotate the production signing key",
    goal: overrides.goal ?? "Rotate the production signing key safely.",
    when_to_use: overrides.when_to_use ?? ["Use this when the production signing key must be rotated."],
    when_not_to_use: overrides.when_not_to_use ?? ["Do not use this for a read-only audit."],
    prerequisites: overrides.prerequisites ?? ["Access to the production key vault."],
    steps: overrides.steps ?? [
      {
        id: "inspect-state",
        kind: "inspect_state" as const,
        instruction: "Inspect the current signing key state before rotating it.",
        target: "signing key state",
      },
    ],
    verification: overrides.verification ?? ["Downstream verification succeeds after rotation."],
    failure_modes: overrides.failure_modes ?? ["Rotation fails before verification completes."],
    sources: overrides.sources ?? [{ kind: "manual" as const, label: "fixture" }],
  };

  return {
    id: overrides.id ?? randomUUID(),
    ...body,
    recall_text: overrides.recall_text ?? composeProcedureRecallText(body),
    revision_hash: overrides.revision_hash ?? computeProcedureRevisionHash(body),
    source_hash: overrides.source_hash ?? computeProcedureSourceHash(JSON.stringify(body)),
    source_file: overrides.source_file,
    embedding: overrides.embedding,
    superseded_by: overrides.superseded_by,
    created_at: now,
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
