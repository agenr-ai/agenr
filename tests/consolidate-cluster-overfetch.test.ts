import type { Client } from "@libsql/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const { findSimilarMock } = vi.hoisted(() => ({
  findSimilarMock: vi.fn(),
}));

vi.mock("../src/db/store.js", async () => {
  const actual = await vi.importActual<typeof import("../src/db/store.js")>("../src/db/store.js");
  return {
    ...actual,
    findSimilar: findSimilarMock,
  };
});

import { buildClusters } from "../src/consolidate/cluster.js";

function makeEmbedding(seed: number): Float32Array {
  const vector = new Float32Array(1024);
  vector[0] = seed;
  return vector;
}

function makeDbRows() {
  return [
    {
      id: "fact-1",
      type: "fact",
      subject: "Diet",
      content: "keto a",
      project: "agenr",
      importance: 5,
      embedding: makeEmbedding(1),
      confirmations: 0,
      recall_count: 0,
      created_at: "2026-02-26T00:00:00.000Z",
      merged_from: 0,
      consolidated_at: null,
      tags_csv: "",
    },
    {
      id: "fact-2",
      type: "fact",
      subject: "Diet",
      content: "keto b",
      project: "agenr",
      importance: 5,
      embedding: makeEmbedding(2),
      confirmations: 0,
      recall_count: 0,
      created_at: "2026-02-26T00:00:00.000Z",
      merged_from: 0,
      consolidated_at: null,
      tags_csv: "",
    },
    {
      id: "preference-1",
      type: "preference",
      subject: "Diet",
      content: "keto pref",
      project: "agenr",
      importance: 5,
      embedding: makeEmbedding(3),
      confirmations: 0,
      recall_count: 0,
      created_at: "2026-02-26T00:00:00.000Z",
      merged_from: 0,
      consolidated_at: null,
      tags_csv: "",
    },
  ];
}

describe("consolidate cluster neighbor over-fetch", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("over-fetches neighbors by 3x when type filter is set", async () => {
    findSimilarMock.mockResolvedValue([]);
    const db = {
      execute: vi.fn(async () => ({ rows: makeDbRows() })),
    } as unknown as Client;

    await buildClusters(db, { typeFilter: "fact", minCluster: 2, neighborLimit: 5 });

    expect(findSimilarMock).toHaveBeenCalledTimes(2);
    for (const call of findSimilarMock.mock.calls) {
      expect(call[2]).toBe(15);
    }
  });

  it("uses raw neighbor limit when type filter is not set", async () => {
    findSimilarMock.mockResolvedValue([]);
    const db = {
      execute: vi.fn(async () => ({ rows: makeDbRows() })),
    } as unknown as Client;

    await buildClusters(db, { minCluster: 2, neighborLimit: 5 });

    expect(findSimilarMock).toHaveBeenCalledTimes(3);
    for (const call of findSimilarMock.mock.calls) {
      expect(call[2]).toBe(5);
    }
  });
});
