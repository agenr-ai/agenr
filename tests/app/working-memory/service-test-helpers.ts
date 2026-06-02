import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { createDatabase, type SqlDatabase } from "../../../src/adapters/db/client.js";
import { createWorkingMemoryRepository } from "../../../src/adapters/db/working-memory-repository.js";
import { createWorkingMemoryService } from "../../../src/app/working-memory/service.js";
import { closeTestDatabase, removeTestPath } from "../../helpers/temp-paths.js";

/** Creates an isolated working-memory service backed by a temp database. */
export async function createWorkingMemoryTestService(): Promise<{
  database: SqlDatabase;
  dbPath: string;
  service: ReturnType<typeof createWorkingMemoryService>;
}> {
  const dbPath = path.join(os.tmpdir(), `agenr-working-memory-${randomUUID()}.sqlite`);
  const database = await createDatabase(dbPath);
  const repository = createWorkingMemoryRepository(database);
  const service = createWorkingMemoryService(
    { workingMemory: true },
    {
      repository,
      sourceLabel: "test",
      now: () => new Date("2026-05-30T12:00:00.000Z"),
    },
  );

  return { database, dbPath, service };
}

/** Closes and removes one temp working-memory database. */
export async function closeWorkingMemoryTestService(database: SqlDatabase, dbPath: string): Promise<void> {
  await closeTestDatabase(database);
  await removeTestPath(dbPath);
}
