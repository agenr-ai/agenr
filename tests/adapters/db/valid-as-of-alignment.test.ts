import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createDatabase, type SqlDatabase } from "../../../src/adapters/db/client.js";
import { buildValidAsOfClause } from "../../../src/adapters/db/row-mapping.js";
import { isWithinValidityWindow } from "../../../src/core/temporal-validity.js";
import type { Durable } from "../../../src/core/types.js";
import { closeTestDatabases, removeTestPath } from "../../helpers/temp-paths.js";

const databases: SqlDatabase[] = [];
const databasePaths: string[] = [];

const AS_OF_ISO = "2026-03-15T12:00:00.000Z";
const AS_OF_MS = Date.parse(AS_OF_ISO);

const CASES = [
  { id: "open", valid_from: null, valid_to: null, expected: true },
  { id: "inside", valid_from: "2026-03-01T00:00:00.000Z", valid_to: "2026-03-31T00:00:00.000Z", expected: true },
  { id: "expired", valid_from: "2026-01-01T00:00:00.000Z", valid_to: "2026-03-10T00:00:00.000Z", expected: false },
  { id: "future", valid_from: "2026-03-20T00:00:00.000Z", valid_to: null, expected: false },
  { id: "boundary-to", valid_from: null, valid_to: AS_OF_ISO, expected: true },
  { id: "boundary-from", valid_from: AS_OF_ISO, valid_to: null, expected: true },
] as const;

describe("buildValidAsOfClause alignment with isWithinValidityWindow", () => {
  afterEach(async () => {
    await closeTestDatabases(databases);

    while (databasePaths.length > 0) {
      await removeTestPath(databasePaths.pop() ?? "");
    }
  });

  it("agrees with the core predicate across representative timestamp shapes", async () => {
    const database = await createTestDatabase();

    for (const testCase of CASES) {
      await database.insertDurable(
        createEntry({
          id: testCase.id,
          subject: testCase.id,
          valid_from: testCase.valid_from ?? undefined,
          valid_to: testCase.valid_to ?? undefined,
        }),
        [],
        `${testCase.id}-hash`,
      );
    }

    const result = await database.execute({
      sql: `
        SELECT id
        FROM durables
        WHERE ${buildValidAsOfClause()}
      `,
      args: [AS_OF_ISO, AS_OF_ISO],
    });
    const sqlMatches = new Set(result.rows.map((row) => String(row.id)));

    for (const testCase of CASES) {
      const coreMatches = isWithinValidityWindow(testCase.valid_from, testCase.valid_to, AS_OF_MS);
      expect(coreMatches, `core predicate for ${testCase.id}`).toBe(testCase.expected);
      expect(sqlMatches.has(testCase.id), `sql predicate for ${testCase.id}`).toBe(testCase.expected);
      expect(sqlMatches.has(testCase.id), `sql/core agreement for ${testCase.id}`).toBe(coreMatches);
    }
  });
});

async function createTestDatabase(): Promise<SqlDatabase> {
  const databasePath = path.join(os.tmpdir(), `agenr-valid-as-of-${randomUUID()}.sqlite`);
  databasePaths.push(databasePath);

  const database = await createDatabase(databasePath);
  databases.push(database);
  return database;
}

function createEntry(overrides: Partial<Durable> & Pick<Durable, "id">): Durable {
  return {
    type: "fact",
    subject: overrides.subject ?? overrides.id,
    content: overrides.content ?? "content",
    importance: 5,
    expiry: "permanent",
    tags: [],
    quality_score: 0.5,
    recall_count: 0,
    retired: false,
    created_at: AS_OF_ISO,
    updated_at: AS_OF_ISO,
    ...overrides,
  };
}
