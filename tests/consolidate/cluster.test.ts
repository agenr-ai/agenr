import { createClient, type Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { buildClusters } from "../../src/consolidate/cluster.js";
import { initDb } from "../../src/db/client.js";
import { hashText, insertEntry } from "../../src/db/store.js";
import type { KnowledgeEntry } from "../../src/types.js";

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

describe("consolidate cluster tag mapping", () => {
  const clients: Client[] = [];

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
});
