import { createClient, type Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import { initDb } from "../../src/db/client.js";
import { createRelation, getRelations } from "../../src/db/relations.js";

describe("db relations", () => {
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

  async function seedEntry(client: Client, id: string, subject: string): Promise<void> {
    const now = new Date().toISOString();
    await client.execute({
      sql: `
        INSERT INTO entries (
          id, type, subject, content, confidence, expiry, source_file, source_context, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      args: [
        id,
        "fact",
        subject,
        `${subject} content`,
        "high",
        "permanent",
        "seed.jsonl",
        "seed",
        now,
        now,
      ],
    });
  }

  it("creates relations and queries them for an entry", async () => {
    const client = makeClient();
    await initDb(client);
    await seedEntry(client, "entry-a", "A");
    await seedEntry(client, "entry-b", "B");
    await seedEntry(client, "entry-c", "C");

    const relationOne = await createRelation(client, "entry-a", "entry-b", "related");
    const relationTwo = await createRelation(client, "entry-c", "entry-a", "elaborates");

    expect(relationOne).toBeTruthy();
    expect(relationTwo).toBeTruthy();

    const relations = await getRelations(client, "entry-a");
    expect(relations).toHaveLength(2);
    expect(relations.map((item) => item.relation_type).sort()).toEqual(["elaborates", "related"]);
    expect(relations.some((item) => item.source_id === "entry-a" && item.target_id === "entry-b")).toBe(true);
    expect(relations.some((item) => item.source_id === "entry-c" && item.target_id === "entry-a")).toBe(true);
  });
});
