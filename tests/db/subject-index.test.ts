import { createClient, type Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { initSchema } from "../../src/db/schema.js";
import { SubjectIndex } from "../../src/db/subject-index.js";

interface SeedEntryOptions {
  subjectKey?: string;
  retired?: number;
  supersededBy?: string;
}

describe("SubjectIndex", () => {
  const clients: Client[] = [];

  afterEach(() => {
    while (clients.length > 0) {
      clients.pop()?.close();
    }
  });

  function makeClient(): Client {
    const client = createClient({ url: ":memory:" });
    clients.push(client);
    return client;
  }

  async function seedEntry(client: Client, id: string, options: SeedEntryOptions = {}): Promise<void> {
    await client.execute({
      sql: `
        INSERT INTO entries (
          id, type, subject, content, importance, expiry, scope, source_file, source_context, created_at, updated_at,
          subject_key, retired, superseded_by
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      args: [
        id,
        "fact",
        `subject-${id}`,
        `content-${id}`,
        7,
        "temporary",
        "private",
        "subject-index.test.ts",
        "unit-test",
        "2026-02-26T00:00:00.000Z",
        "2026-02-26T00:00:00.000Z",
        options.subjectKey ?? null,
        options.retired ?? 0,
        options.supersededBy ?? null,
      ],
    });
  }

  it("rebuild populates the index from DB and lookup returns matching ids", async () => {
    const client = makeClient();
    await initSchema(client);
    await seedEntry(client, "entry-1", { subjectKey: "person:alice|attr:role" });
    await seedEntry(client, "entry-2", { subjectKey: "person:alice|attr:role" });
    await seedEntry(client, "entry-3", { subjectKey: "person:bob|attr:role" });
    await seedEntry(client, "entry-4");

    const index = new SubjectIndex();
    await index.rebuild(client);

    expect(index.lookup("person:alice|attr:role").sort()).toEqual(["entry-1", "entry-2"]);
    expect(index.lookup("person:bob|attr:role")).toEqual(["entry-3"]);
  });

  it("lookup returns empty array for unknown keys", () => {
    const index = new SubjectIndex();
    expect(index.lookup("missing:key")).toEqual([]);
  });

  it("add inserts entries and deduplicates per key", () => {
    const index = new SubjectIndex();
    index.add("person:alice|attr:role", "entry-1");
    index.add("person:alice|attr:role", "entry-1");
    index.add("person:alice|attr:role", "entry-2");

    expect(index.lookup("person:alice|attr:role").sort()).toEqual(["entry-1", "entry-2"]);
  });

  it("remove deletes entries and cleans up empty keys", () => {
    const index = new SubjectIndex();
    index.add("person:alice|attr:role", "entry-1");
    index.add("person:alice|attr:role", "entry-2");

    index.remove("person:alice|attr:role", "entry-1");
    expect(index.lookup("person:alice|attr:role")).toEqual(["entry-2"]);

    index.remove("person:alice|attr:role", "entry-2");
    expect(index.lookup("person:alice|attr:role")).toEqual([]);
  });

  it("stats returns total key and entry counts", () => {
    const index = new SubjectIndex();
    index.add("a", "1");
    index.add("a", "2");
    index.add("b", "3");

    expect(index.stats()).toEqual({ keys: 2, entries: 3 });
  });

  it("clear resets index and initialized flag", async () => {
    const client = makeClient();
    await initSchema(client);
    await seedEntry(client, "entry-1", { subjectKey: "person:alice|attr:role" });

    const index = new SubjectIndex();
    await index.rebuild(client);
    expect(index.isInitialized()).toBe(true);

    index.clear();
    expect(index.isInitialized()).toBe(false);
    expect(index.lookup("person:alice|attr:role")).toEqual([]);
    expect(index.stats()).toEqual({ keys: 0, entries: 0 });
  });

  it("ensureInitialized rebuilds on first use and no-ops after initialization", async () => {
    const client = makeClient();
    await initSchema(client);
    await seedEntry(client, "entry-1", { subjectKey: "person:alice|attr:role" });

    const index = new SubjectIndex();
    expect(index.isInitialized()).toBe(false);

    await index.ensureInitialized(client);
    expect(index.isInitialized()).toBe(true);
    expect(index.lookup("person:alice|attr:role")).toEqual(["entry-1"]);

    await seedEntry(client, "entry-2", { subjectKey: "person:alice|attr:role" });
    await index.ensureInitialized(client);
    expect(index.lookup("person:alice|attr:role")).toEqual(["entry-1"]);
  });

  it("rebuild filters out retired entries", async () => {
    const client = makeClient();
    await initSchema(client);
    await seedEntry(client, "entry-1", { subjectKey: "person:alice|attr:role", retired: 0 });
    await seedEntry(client, "entry-2", { subjectKey: "person:alice|attr:role", retired: 1 });

    const index = new SubjectIndex();
    await index.rebuild(client);

    expect(index.lookup("person:alice|attr:role")).toEqual(["entry-1"]);
  });

  it("rebuild filters out superseded entries", async () => {
    const client = makeClient();
    await initSchema(client);
    await seedEntry(client, "entry-1", { subjectKey: "person:alice|attr:role", supersededBy: null });
    await seedEntry(client, "entry-2", { subjectKey: "person:alice|attr:role", supersededBy: "entry-1" });

    const index = new SubjectIndex();
    await index.rebuild(client);

    expect(index.lookup("person:alice|attr:role")).toEqual(["entry-1"]);
  });
});
