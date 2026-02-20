import { createClient, type Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import type { KnowledgeEntry } from "../types.js";
import { initDb } from "./client.js";
import { storeEntries } from "./store.js";

const clients: Client[] = [];

function makeClient(): Client {
  const client = createClient({ url: ":memory:" });
  clients.push(client);
  return client;
}

function makeEntry(params: {
  subject: string;
  type: KnowledgeEntry["type"];
  content: string;
  sourceFile: string;
}): KnowledgeEntry {
  return {
    subject: params.subject,
    type: params.type,
    content: params.content,
    importance: 7,
    expiry: "temporary",
    tags: [],
    source: {
      file: params.sourceFile,
      context: "store-test",
    },
  };
}

const embedStub = async (texts: string[], _apiKey: string): Promise<number[][]> =>
  texts.map(() => new Array(1024).fill(0));

afterEach(() => {
  while (clients.length > 0) {
    clients.pop()?.close();
  }
});

describe("db store", () => {
  it("within-batch dedup: two entries with same subject+type yield 1 added + 1 skipped", async () => {
    const client = makeClient();
    await initDb(client);

    const result = await storeEntries(
      client,
      [
        makeEntry({
          subject: "version 0.7.1 release",
          type: "event",
          content: "Initial release summary",
          sourceFile: "/tmp/session.jsonl",
        }),
        makeEntry({
          subject: "version 0.7.1 release",
          type: "event",
          content: "Refined release summary",
          sourceFile: "/tmp/session.jsonl",
        }),
      ],
      "test-api-key",
      { embedFn: embedStub },
    );

    expect(result.added).toBe(1);
    expect(result.skipped).toBe(1);
  });

  it("within-batch dedup: same subject but different type are both kept", async () => {
    const client = makeClient();
    await initDb(client);

    const result = await storeEntries(
      client,
      [
        makeEntry({
          subject: "foo",
          type: "fact",
          content: "Foo is true",
          sourceFile: "/tmp/session-a.jsonl",
        }),
        makeEntry({
          subject: "foo",
          type: "decision",
          content: "Decided foo policy",
          sourceFile: "/tmp/session-a.jsonl",
        }),
      ],
      "test-api-key",
      { embedFn: embedStub },
    );

    expect(result.added).toBe(2);
    expect(result.skipped).toBe(0);
  });

  it("source-file recency guard: same subject+type+source within 24h increments confirmations", async () => {
    const client = makeClient();
    await initDb(client);

    await storeEntries(
      client,
      [
        makeEntry({
          subject: "bar",
          type: "fact",
          content: "Initial bar content",
          sourceFile: "/tmp/session.jsonl",
        }),
      ],
      "test-api-key",
      { embedFn: embedStub },
    );

    const result = await storeEntries(
      client,
      [
        makeEntry({
          subject: "bar",
          type: "fact",
          content: "Updated bar content with different wording",
          sourceFile: "/tmp/session.jsonl",
        }),
      ],
      "test-api-key",
      { embedFn: embedStub },
    );

    expect(result.updated).toBe(1);
    expect(result.added).toBe(0);
  });

  it("source-file recency guard: same subject+type but different source_file adds new entry", async () => {
    const client = makeClient();
    await initDb(client);

    await storeEntries(
      client,
      [
        makeEntry({
          subject: "bar",
          type: "fact",
          content: "Initial bar content",
          sourceFile: "/tmp/session-a.jsonl",
        }),
      ],
      "test-api-key",
      { embedFn: embedStub },
    );

    const result = await storeEntries(
      client,
      [
        makeEntry({
          subject: "bar",
          type: "fact",
          content: "Updated bar content with different wording",
          sourceFile: "/tmp/session-b.jsonl",
        }),
      ],
      "test-api-key",
      { embedFn: embedStub },
    );

    expect(result.added).toBe(1);
    expect(result.updated).toBe(0);
  });
});
