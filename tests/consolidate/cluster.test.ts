import { createClient, type Client } from "@libsql/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { runSimpleStreamMock } = vi.hoisted(() => ({
  runSimpleStreamMock: vi.fn(),
}));

vi.mock("../../src/llm/stream.js", () => ({
  runSimpleStream: runSimpleStreamMock,
}));

import { buildClusters } from "../../src/consolidate/cluster.js";
import { initDb } from "../../src/db/client.js";
import { hashText, insertEntry } from "../../src/db/store.js";
import type { KnowledgeEntry, LlmClient } from "../../src/types.js";

function vectorFromAngle(degrees: number): number[] {
  const radians = (degrees * Math.PI) / 180;
  const head = [Math.cos(radians), Math.sin(radians), 0];
  return [...head, ...Array.from({ length: 1021 }, () => 0)];
}

function makeEntry(subject: string, content: string, tags: string[]): KnowledgeEntry {
  return {
    type: "fact",
    subject,
    content,
    importance: 6,
    expiry: "permanent",
    tags,
    source: {
      file: "cluster.test.jsonl",
      context: "cluster test",
    },
  };
}

function makeLlmClient(): LlmClient {
  return {
    auth: "openai-api-key",
    resolvedModel: {
      provider: "openai",
      modelId: "gpt-4o-mini",
      model: {
        api: "cluster-test-api",
        provider: "openai",
        id: "gpt-4o-mini",
        maxTokens: 4096,
        reasoning: false,
        input: ["text"],
      },
    },
    credentials: {
      apiKey: "test-key",
      source: "test",
    },
  };
}

describe("consolidate cluster tag mapping", () => {
  const clients: Client[] = [];

  beforeEach(() => {
    runSimpleStreamMock.mockReset();
    runSimpleStreamMock.mockResolvedValue({
      stopReason: "stop",
      content: [
        {
          type: "toolCall",
          name: "dedup_check",
          arguments: {
            same: false,
            reason: "default false",
          },
        },
      ],
    });
  });

  afterEach(() => {
    while (clients.length > 0) {
      clients.pop()?.close();
    }
  });

  async function makeDb(): Promise<Client> {
    const client = createClient({ url: ":memory:" });
    clients.push(client);
    await initDb(client);
    return client;
  }

  async function seed(params: { db: Client; subject: string; content: string; tags: string[]; angle: number }): Promise<string> {
    return insertEntry(
      params.db,
      makeEntry(params.subject, params.content, params.tags),
      vectorFromAngle(params.angle),
      hashText(`${params.subject}:${params.content}:${params.angle}`),
    );
  }

  it("preserves tag arrays when buildClusters maps grouped tags", async () => {
    const db = await makeDb();
    const idA = await seed({
      db,
      subject: "Tag Roundtrip",
      content: "entry-a",
      tags: ["alpha", "beta release"],
      angle: 0,
    });
    const idB = await seed({
      db,
      subject: "Tag Roundtrip",
      content: "entry-b",
      tags: ["modeling", "nlp"],
      angle: 8,
    });

    const clusters = await buildClusters(db, { minCluster: 2 });
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.entries).toHaveLength(2);

    const tagsById = new Map(clusters[0]?.entries.map((entry) => [entry.id, [...(entry.tags ?? [])].sort()]));
    expect(tagsById.get(idA)).toEqual(["alpha", "beta release"]);
    expect(tagsById.get(idB)).toEqual(["modeling", "nlp"]);
  });

  it("keeps comma-containing tags as a single token in buildClusters", async () => {
    const db = await makeDb();
    const commaTagEntryId = await seed({
      db,
      subject: "Comma Tag Regression",
      content: "entry-with-comma-tag",
      tags: ["machine learning, nlp", "retrieval"],
      angle: 0,
    });
    await seed({
      db,
      subject: "Comma Tag Regression",
      content: "entry-peer",
      tags: ["baseline"],
      angle: 8,
    });

    const clusters = await buildClusters(db, { minCluster: 2 });
    expect(clusters).toHaveLength(1);

    const commaTagEntry = clusters[0]?.entries.find((entry) => entry.id === commaTagEntryId);
    expect(commaTagEntry).toBeTruthy();
    expect(commaTagEntry?.tags).toContain("machine learning, nlp");
    expect(commaTagEntry?.tags).not.toContain("machine learning");
    expect(commaTagEntry?.tags).not.toContain("nlp");
  });

  it("auto-unions entries in loose band with same subject without LLM", async () => {
    const db = await makeDb();
    await seed({
      db,
      subject: "Jim Martin",
      content: "Jim prefers a keto diet for weekly meal planning",
      tags: ["diet"],
      angle: 0,
    });
    await seed({
      db,
      subject: "Jim Martin",
      content: "Jim Martin follows a ketogenic diet and avoids carbs",
      tags: ["diet"],
      angle: 45,
    });

    const clusters = await buildClusters(db, {
      simThreshold: 0.82,
      looseThreshold: 0.65,
      minCluster: 2,
    });

    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.entries).toHaveLength(2);
    expect(runSimpleStreamMock).not.toHaveBeenCalled();
  });

  it("calls LLM for loose band entries with different subjects", async () => {
    const db = await makeDb();
    await seed({
      db,
      subject: "Jim Martin",
      content: "Jim prefers a keto diet for weekly meal planning",
      tags: ["diet"],
      angle: 0,
    });
    await seed({
      db,
      subject: "Diet Notes",
      content: "Keto meals are used weekly in Jim's planning",
      tags: ["diet"],
      angle: 45,
    });

    runSimpleStreamMock.mockResolvedValueOnce({
      stopReason: "toolUse",
      content: [
        {
          type: "toolCall",
          name: "dedup_check",
          arguments: {
            same: true,
            reason: "same knowledge",
          },
        },
      ],
    });

    let stats = { llmDedupCalls: 0, llmDedupMatches: 0 };
    const clusters = await buildClusters(db, {
      simThreshold: 0.82,
      looseThreshold: 0.65,
      minCluster: 2,
      llmClient: makeLlmClient(),
      onStats: (value) => {
        stats = value;
      },
    });

    expect(clusters).toHaveLength(1);
    expect(runSimpleStreamMock).toHaveBeenCalled();
    expect(stats).toEqual({ llmDedupCalls: 1, llmDedupMatches: 1 });
  });

  it("does not union loose band entries when LLM says distinct", async () => {
    const db = await makeDb();
    await seed({
      db,
      subject: "Jim Martin",
      content: "Jim prefers a keto diet for weekly meal planning",
      tags: ["diet"],
      angle: 0,
    });
    await seed({
      db,
      subject: "Diet Notes",
      content: "Jim Martin uses keto shots and is likely following keto",
      tags: ["diet"],
      angle: 45,
    });

    runSimpleStreamMock.mockResolvedValueOnce({
      stopReason: "toolUse",
      content: [
        {
          type: "toolCall",
          name: "dedup_check",
          arguments: {
            same: false,
            reason: "distinct",
          },
        },
      ],
    });

    const clusters = await buildClusters(db, {
      simThreshold: 0.82,
      looseThreshold: 0.65,
      minCluster: 2,
      llmClient: makeLlmClient(),
    });

    expect(clusters).toHaveLength(0);
    expect(runSimpleStreamMock).toHaveBeenCalled();
  });

  it("skips loose band entries with no llmClient", async () => {
    const db = await makeDb();
    await seed({
      db,
      subject: "Jim Martin",
      content: "Jim prefers a keto diet for weekly meal planning",
      tags: ["diet"],
      angle: 0,
    });
    await seed({
      db,
      subject: "Diet Notes",
      content: "Keto planning note",
      tags: ["diet"],
      angle: 45,
    });

    const clusters = await buildClusters(db, {
      simThreshold: 0.82,
      looseThreshold: 0.65,
      minCluster: 2,
    });

    expect(clusters).toHaveLength(0);
    expect(runSimpleStreamMock).not.toHaveBeenCalled();
  });
});
