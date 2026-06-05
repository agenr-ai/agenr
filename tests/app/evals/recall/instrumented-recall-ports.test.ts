import { describe, expect, it, vi } from "vitest";

import { createInstrumentedRecallPorts } from "../../../../src/app/evals/recall/instrumented-recall-ports.js";
import type { RecallPorts } from "../../../../src/core/ports.js";
import type { DurableNeighborhoodRequest } from "../../../../src/core/recall/neighborhood.js";
import type { Durable } from "../../../../src/core/types.js";

describe("createInstrumentedRecallPorts", () => {
  it("observes adapter boundaries without changing recall port behavior", async () => {
    const hydratedEntry: Durable = {
      id: "entry-1",
      type: "fact",
      subject: "subject",
      content: "content",
      importance: 6,
      expiry: "permanent",
      tags: [],
      source_file: undefined,
      source_context: undefined,
      quality_score: 0.5,
      recall_count: 0,
      last_recalled_at: undefined,
      superseded_by: undefined,
      cluster_id: undefined,
      retired: false,
      retired_at: undefined,
      retired_reason: undefined,
      created_at: "2026-03-01T00:00:00.000Z",
      updated_at: "2026-03-01T00:00:00.000Z",
    };
    const vectorResults = [
      {
        entry: {
          id: "entry-1",
          subject: "subject",
          content: "content",
          importance: 6,
          expiry: "permanent" as const,
          embedding: [0.1, 0.2],
          superseded_by: undefined,
          retired: false,
          created_at: "2026-03-01T00:00:00.000Z",
        },
        vectorSim: 0.9,
      },
    ];
    const lexicalResults = [
      {
        entry: {
          id: "entry-1",
          subject: "subject",
          content: "content",
          importance: 6,
          expiry: "permanent" as const,
          embedding: [0.1, 0.2],
          superseded_by: undefined,
          retired: false,
          created_at: "2026-03-01T00:00:00.000Z",
        },
        rank: 0.1,
        tier: "exact" as const,
      },
    ];
    const neighborhoodRequest: DurableNeighborhoodRequest = {
      seedIds: ["entry-1"],
      budget: 24,
      families: ["supersession_chain"],
      includeRetired: false,
    };
    const basePorts: RecallPorts = {
      embed: vi.fn(async () => [0.1, 0.2]),
      vectorSearch: vi.fn(async () => vectorResults),
      ftsSearch: vi.fn(async () => lexicalResults),
      expandNeighborhood: vi.fn(async () => []),
      hydrateEntries: vi.fn(async () => [hydratedEntry]),
      recordRecallEvents: vi.fn(async () => undefined),
    };
    const observer = {
      recordQueryEmbedding: vi.fn(),
      recordVectorSearch: vi.fn(),
      recordLexicalSearch: vi.fn(),
      recordHydrateEntries: vi.fn(),
      recordRecallTelemetry: vi.fn(),
    };

    const instrumented = createInstrumentedRecallPorts(basePorts, observer);

    await expect(instrumented.embed("query")).resolves.toEqual([0.1, 0.2]);
    await expect(instrumented.vectorSearch({ embedding: [0.1, 0.2], limit: 8 })).resolves.toEqual(vectorResults);
    await expect(instrumented.ftsSearch({ text: "query", limit: 4 })).resolves.toEqual(lexicalResults);
    await expect(instrumented.expandNeighborhood?.(neighborhoodRequest)).resolves.toEqual([]);
    await expect(instrumented.hydrateEntries(["entry-1"])).resolves.toEqual([hydratedEntry]);
    await expect(instrumented.recordRecallEvents({ entryIds: ["entry-1"], query: "query" })).resolves.toBeUndefined();

    expect(basePorts.embed).toHaveBeenCalledWith("query");
    expect(basePorts.vectorSearch).toHaveBeenCalledWith({
      embedding: [0.1, 0.2],
      limit: 8,
    });
    expect(basePorts.ftsSearch).toHaveBeenCalledWith({
      text: "query",
      limit: 4,
    });
    expect(basePorts.expandNeighborhood).toHaveBeenCalledWith(neighborhoodRequest);
    expect(basePorts.hydrateEntries).toHaveBeenCalledWith(["entry-1"]);
    expect(basePorts.recordRecallEvents).toHaveBeenCalledWith({
      entryIds: ["entry-1"],
      query: "query",
    });

    expect(observer.recordQueryEmbedding).toHaveBeenCalledWith({
      durationMs: expect.any(Number),
      dimensions: 2,
    });
    expect(observer.recordVectorSearch).toHaveBeenCalledWith({
      durationMs: expect.any(Number),
      count: 1,
      limit: 8,
    });
    expect(observer.recordLexicalSearch).toHaveBeenCalledWith({
      durationMs: expect.any(Number),
      count: 1,
      limit: 4,
    });
    expect(observer.recordHydrateEntries).toHaveBeenCalledWith({
      durationMs: expect.any(Number),
      count: 1,
    });
    expect(observer.recordRecallTelemetry).toHaveBeenCalledWith({
      durationMs: expect.any(Number),
      entryCount: 1,
    });
  });
});
