import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createDatabase, type SqlDatabase } from "../../../src/adapters/db/client.js";
import { createMemoryRepository } from "../../../src/adapters/db/memory-repository.js";
import { createDreamRun, logDreamAction } from "../../../src/adapters/db/dreaming-run-log.js";
import { closeTestDatabases, removeTestPath } from "../../helpers/temp-paths.js";

const databases: SqlDatabase[] = [];
const databasePaths: string[] = [];

describe("memory repository entry trace", () => {
  afterEach(async () => {
    await closeTestDatabases(databases);

    while (databasePaths.length > 0) {
      await removeTestPath(databasePaths.pop() ?? "");
    }
  });

  it("loads provenance, dream actions, recall summary, and timeline for one durable", async () => {
    const database = await createTestDatabase();
    const repository = createMemoryRepository(database);
    const durableId = randomUUID();
    const now = "2026-06-06T03:30:00.000Z";

    await database.execute({
      sql: `
        INSERT INTO durables (
          id, type, subject, content, importance, expiry, tags, quality_score,
          recall_count, source_file, claim_key, claim_key_status, valid_to,
          supersession_kind, supersession_reason, created_at, updated_at
        )
        VALUES (?, 'fact', 'duke dog details', 'Jim dog Duke is 12.', 4, 'permanent', '[]', 0.5, 2, 'episode:abc', NULL, NULL, ?, 'stale', 'Dream prune staled a low-signal durable after synthesis.', ?, ?)
      `,
      args: [durableId, now, "2026-06-06T02:00:00.000Z", now],
    });

    const runId = await createDreamRun(database, {
      tier: "standard",
      startedAt: now,
      dryRun: false,
      config: null,
    });

    await logDreamAction(database, {
      id: randomUUID(),
      runId,
      actionType: "stale",
      durableIds: [durableId],
      reasoning: "Dream prune staled a low-signal durable after synthesis.",
      recallDelta: null,
      details: { stage: "prune" },
      createdAt: now,
    });

    await database.execute({
      sql: `
        INSERT INTO recall_events (id, durable_id, query, session_key, recalled_at)
        VALUES (?, ?, 'duke dog', 'session-1', '2026-06-06T04:00:00.000Z')
      `,
      args: [randomUUID(), durableId],
    });

    await database.execute({
      sql: `
        INSERT INTO profile_snapshots (id, durable_ids, directive_ids, as_of, content_hash, run_id, created_at)
        VALUES (?, ?, '[]', ?, 'hash', ?, ?)
      `,
      args: [randomUUID(), JSON.stringify([durableId]), now, runId, now],
    });

    const trace = await repository.getEntryTrace(durableId);

    expect(trace).not.toBeNull();
    expect(trace?.provenance.sourceFile).toBe("episode:abc");
    expect(trace?.recall.totalCount).toBe(1);
    expect(trace?.dreamActions).toHaveLength(1);
    expect(trace?.profileSnapshots).toHaveLength(1);
    expect(trace?.timeline.some((event) => event.kind === "dream" && event.actionType === "stale")).toBe(true);
  });
});

async function createTestDatabase(): Promise<SqlDatabase> {
  const databasePath = path.join(os.tmpdir(), `agenr-trace-${randomUUID()}.sqlite`);
  databasePaths.push(databasePath);

  const database = await createDatabase(databasePath);
  databases.push(database);
  return database;
}
