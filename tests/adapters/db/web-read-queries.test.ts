import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createDatabase, type SqlDatabase } from "../../../src/adapters/db/client.js";
import { listRecentEpisodes, updateEpisodeMetadata } from "../../../src/adapters/db/web-read-queries.js";
import { closeTestDatabases, removeTestPath } from "../../helpers/temp-paths.js";

describe("web read queries", () => {
  const databases: SqlDatabase[] = [];
  const databasePaths: string[] = [];

  afterEach(async () => {
    await closeTestDatabases(databases);

    while (databasePaths.length > 0) {
      await removeTestPath(databasePaths.pop() ?? "");
    }
  });

  it("updates episode metadata while preserving the episode summary", async () => {
    const database = await createTestDatabase(databases, databasePaths);
    await database.execute({
      sql: `
        INSERT INTO episodes (
          id,
          source,
          source_ref,
          started_at,
          ended_at,
          summary,
          tags,
          activity_level,
          user_id,
          project,
          valid_to,
          created_at,
          updated_at
        )
        VALUES (?, 'openclaw', 'old.jsonl', ?, ?, ?, ?, 'minimal', 'jim', 'old-project', ?, ?, ?)
      `,
      args: [
        "episode-1",
        "2026-06-01T12:00:00.000Z",
        "2026-06-01T12:30:00.000Z",
        "Original episode summary.",
        JSON.stringify(["old"]),
        "2026-07-01T00:00:00.000Z",
        "2026-06-01T12:31:00.000Z",
        "2026-06-01T12:31:00.000Z",
      ],
    });

    await expect(
      updateEpisodeMetadata(database, "episode-1", {
        sourceRef: "new.jsonl",
        project: "new-project",
        activityLevel: "substantial",
        tags: ["web", "console"],
        validTo: "",
      }),
    ).resolves.toBe(true);

    const result = await listRecentEpisodes(database, { limit: 10 });
    expect(result.episodes).toHaveLength(1);
    expect(result.episodes[0]).toMatchObject({
      id: "episode-1",
      sourceRef: "new.jsonl",
      summary: "Original episode summary.",
      project: "new-project",
      activityLevel: "substantial",
      tags: ["web", "console"],
      validTo: undefined,
    });
  });

  it("rejects invalid episode validity ranges", async () => {
    const database = await createTestDatabase(databases, databasePaths);
    await database.execute({
      sql: `
        INSERT INTO episodes (id, source, started_at, ended_at, summary, created_at, updated_at)
        VALUES ('episode-2', 'skeln', '2026-06-01T12:00:00.000Z', NULL, 'Summary.', '2026-06-01T12:00:00.000Z', '2026-06-01T12:00:00.000Z')
      `,
    });

    await expect(
      updateEpisodeMetadata(database, "episode-2", {
        validFrom: "2026-06-02T00:00:00.000Z",
        validTo: "2026-06-01T00:00:00.000Z",
      }),
    ).rejects.toThrow("valid_from must be earlier than valid_to");
  });
});

/** Creates a file-backed temporary test database. */
async function createTestDatabase(databases: SqlDatabase[], databasePaths: string[]): Promise<SqlDatabase> {
  const root = path.join(os.tmpdir(), `agenr-web-read-${randomUUID()}`);
  const databasePath = path.join(root, "knowledge.db");
  databasePaths.push(root);
  const database = await createDatabase(databasePath);
  databases.push(database);
  return database;
}
