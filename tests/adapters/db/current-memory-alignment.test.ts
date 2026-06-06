import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createDatabase, type SqlDatabase } from "../../../src/adapters/db/client.js";
import { buildActiveDurableClause, buildStaleMemoryClause, DURABLE_SELECT_COLUMNS, mapDurableRow } from "../../../src/adapters/db/row-mapping.js";
import { isCurrentlyValidMemory, isStaleMemory } from "../../../src/core/temporal-validity.js";
import type { Durable } from "../../../src/core/types.js";
import { closeTestDatabases, removeTestPath } from "../../helpers/temp-paths.js";

const databases: SqlDatabase[] = [];
const databasePaths: string[] = [];

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW_MS = Date.now();
const PAST_ISO = new Date(NOW_MS - DAY_MS).toISOString();
const FUTURE_ISO = new Date(NOW_MS + DAY_MS).toISOString();

// "successor" is inserted first so the superseded case can satisfy the
// superseded_by foreign key. Each case stays a full day away from the live
// clock so second-level datetime('now') resolution never flips a boundary.
// A future valid_from stays current by design: the active gate only closes on
// supersession or a passed valid_to, so scheduled memories remain reachable.
const CASES = [
  { id: "successor", expected: true },
  { id: "open", expected: true },
  { id: "past-from", valid_from: PAST_ISO, expected: true },
  { id: "open-to", valid_to: FUTURE_ISO, expected: true },
  { id: "future-from", valid_from: FUTURE_ISO, expected: true },
  { id: "expired", valid_to: PAST_ISO, expected: false },
  { id: "superseded", superseded_by: "successor", expected: false },
] as const;

const STALE_CASES = [
  { id: "successor", expected: false },
  { id: "open", expected: false },
  { id: "past-from", expected: false },
  { id: "open-to", expected: false },
  { id: "future-from", expected: false },
  { id: "expired", expected: true },
  { id: "superseded", expected: false },
] as const;

describe("buildActiveDurableClause alignment with isCurrentlyValidMemory", () => {
  afterEach(async () => {
    await closeTestDatabases(databases);

    while (databasePaths.length > 0) {
      await removeTestPath(databasePaths.pop() ?? "");
    }
  });

  it("agrees with the core current-memory predicate across representative rows", async () => {
    const database = await createTestDatabase();

    for (const testCase of CASES) {
      await database.insertDurable(
        createEntry({
          id: testCase.id,
          valid_from: "valid_from" in testCase ? testCase.valid_from : undefined,
          valid_to: "valid_to" in testCase ? testCase.valid_to : undefined,
          superseded_by: "superseded_by" in testCase ? testCase.superseded_by : undefined,
        }),
        [],
        `${testCase.id}-hash`,
      );
    }

    const activeResult = await database.execute({
      sql: `SELECT id FROM durables WHERE ${buildActiveDurableClause()}`,
    });
    const sqlActiveIds = new Set(activeResult.rows.map((row) => String(row.id)));

    const allRows = await database.execute({ sql: `SELECT ${DURABLE_SELECT_COLUMNS} FROM durables` });
    const coreActiveById = new Map(allRows.rows.map((row) => mapDurableRow(row)).map((entry) => [entry.id, isCurrentlyValidMemory(entry, NOW_MS)]));

    for (const testCase of CASES) {
      expect(coreActiveById.get(testCase.id), `core predicate for ${testCase.id}`).toBe(testCase.expected);
      expect(sqlActiveIds.has(testCase.id), `sql predicate for ${testCase.id}`).toBe(testCase.expected);
      expect(sqlActiveIds.has(testCase.id), `sql/core agreement for ${testCase.id}`).toBe(coreActiveById.get(testCase.id));
    }

    const staleResult = await database.execute({
      sql: `SELECT id FROM durables WHERE ${buildStaleMemoryClause()}`,
    });
    const sqlStaleIds = new Set(staleResult.rows.map((row) => String(row.id)));
    const coreStaleById = new Map(allRows.rows.map((row) => mapDurableRow(row)).map((entry) => [entry.id, isStaleMemory(entry, NOW_MS)]));

    for (const testCase of STALE_CASES) {
      expect(coreStaleById.get(testCase.id), `core stale predicate for ${testCase.id}`).toBe(testCase.expected);
      expect(sqlStaleIds.has(testCase.id), `sql stale predicate for ${testCase.id}`).toBe(testCase.expected);
      expect(sqlStaleIds.has(testCase.id), `sql/core stale agreement for ${testCase.id}`).toBe(coreStaleById.get(testCase.id));
    }
  });
});

async function createTestDatabase(): Promise<SqlDatabase> {
  const databasePath = path.join(os.tmpdir(), `agenr-current-memory-${randomUUID()}.sqlite`);
  databasePaths.push(databasePath);

  const database = await createDatabase(databasePath);
  databases.push(database);
  return database;
}

function createEntry(overrides: Partial<Durable> & Pick<Durable, "id">): Durable {
  return {
    type: "fact",
    subject: overrides.id,
    content: overrides.content ?? "content",
    importance: 5,
    expiry: "permanent",
    tags: [],
    quality_score: 0.5,
    recall_count: 0,
    created_at: PAST_ISO,
    updated_at: PAST_ISO,
    ...overrides,
  };
}
