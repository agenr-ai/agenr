import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createDatabase, type SqlDatabase } from "../../../src/adapters/db/client.js";
import { provisionEvalProfileSnapshot } from "../../../src/adapters/db/eval-profile-snapshot-store.js";
import { closeTestDatabases, removeTestPath } from "../../helpers/temp-paths.js";

const databases: SqlDatabase[] = [];
const databasePaths: string[] = [];

describe("provisionEvalProfileSnapshot", () => {
  afterEach(async () => {
    await closeTestDatabases(databases);

    while (databasePaths.length > 0) {
      await removeTestPath(databasePaths.pop() ?? "");
    }
  });

  it("seeds a referenced dreaming run before inserting the profile snapshot", async () => {
    const database = await createTestDatabase();
    const provisionedAt = "2026-04-14T10:00:00.000Z";

    const result = await provisionEvalProfileSnapshot(
      database,
      {
        id: "profile-1",
        durableIds: ["profile-runtime"],
        directiveIds: [],
        runId: "run-1",
        asOf: provisionedAt,
        createdAt: provisionedAt,
      },
      provisionedAt,
    );

    expect(result.snapshotId).toBe("profile-1");

    const runRow = await database.execute({
      sql: `
        SELECT id, status
        FROM dream_runs
        WHERE id = ?
        LIMIT 1
      `,
      args: ["run-1"],
    });
    expect(runRow.rows[0]).toEqual({ id: "run-1", status: "completed" });

    const snapshotRow = await database.execute({
      sql: `
        SELECT id, run_id
        FROM profile_snapshots
        WHERE id = ?
        LIMIT 1
      `,
      args: ["profile-1"],
    });
    expect(snapshotRow.rows[0]).toEqual({ id: "profile-1", run_id: "run-1" });
  });
});

async function createTestDatabase(): Promise<SqlDatabase> {
  const databasePath = path.join(os.tmpdir(), `agenr-eval-profile-snapshot-${randomUUID()}.sqlite`);
  databasePaths.push(databasePath);

  const database = await createDatabase(databasePath);
  databases.push(database);
  return database;
}
