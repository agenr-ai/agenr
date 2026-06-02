import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import type { ExtensionContext } from "../../../src/adapters/skeln/skeln-types.js";
import { describe, expect, it } from "vitest";

import { createDatabase, type SqlDatabase } from "../../../src/adapters/db/client.js";
import { createWorkingMemoryRepository } from "../../../src/adapters/db/working-memory-repository.js";
import type { createAgenrSkelnServices } from "../../../src/adapters/skeln/runtime.js";
import type { AgenrSkelnSessionScope } from "../../../src/adapters/skeln/types.js";
import { executeAgenrSkelnWorkCommand, toAgenrWorkParams } from "../../../src/adapters/skeln/work-command.js";
import { createWorkingMemoryService } from "../../../src/app/working-memory/service.js";

describe("toAgenrWorkParams", () => {
  it("maps trusted update commands without scope fields or expectedRevision", () => {
    expect(
      toAgenrWorkParams({
        action: "update",
        source: "goal_command",
        updateReason: "Host update.",
        operation: {
          type: "set_status",
          status: "blocked",
        },
      }),
    ).toEqual({
      action: "update",
      source: "goal_command",
      updateReason: "Host update.",
      operation: {
        type: "set_status",
        status: "blocked",
      },
    });
  });
});

describe("executeAgenrSkelnWorkCommand", () => {
  it("merges host scope and returns a formatted working-memory outcome", async () => {
    const { database, dbPath, servicesPromise } = await createServices();
    const context = {} as ExtensionContext;
    const scope: AgenrSkelnSessionScope = {
      sessionId: "session-1",
      sessionKey: "skeln:session:1",
      conversationKey: "session-1",
      cwd: "/tmp/project",
    };

    try {
      const created = await executeAgenrSkelnWorkCommand(servicesPromise, async () => scope, context, {
        action: "create",
        source: "goal_command",
        updateReason: "Started goal from trusted host command.",
        continuationPolicy: "on_idle",
        operation: {
          type: "set_objective",
          objective: "Ship trusted work commands.",
        },
      });
      expect(created.failed).toBe(false);
      expect(created.details).toMatchObject({
        action: "create",
        workingSetId: expect.any(String),
      });

      const read = await executeAgenrSkelnWorkCommand(servicesPromise, async () => scope, context, {
        action: "get",
      });
      expect(read.failed).toBe(false);
      expect(read.text).toContain("Ship trusted work commands.");
      expect(read.details).toMatchObject({
        continuation: {
          policy: "on_idle",
        },
      });

      const prepared = await executeAgenrSkelnWorkCommand(servicesPromise, async () => scope, context, {
        action: "prepare_external_goal_mutation",
        mutationKind: "pause",
        source: "goal_command",
        actor: "runtime",
        requireCheckpoint: true,
        checkpoint: {
          summary: "Prepared before pausing.",
          recordedAt: "2026-05-30T12:00:00.000Z",
        },
        usage: {
          tokenDelta: 10,
        },
      });
      expect(prepared.failed).toBe(false);
      expect(prepared.details).toMatchObject({
        action: "prepare_external_goal_mutation",
        prepared: true,
        eventsReturned: 1,
      });

      const closed = await executeAgenrSkelnWorkCommand(servicesPromise, async () => scope, context, {
        action: "close",
        source: "goal_command",
        closeReason: "Cleared goal from trusted host command.",
      });
      expect(closed.failed).toBe(false);
      expect(closed.details).toMatchObject({
        action: "close",
      });
    } finally {
      const services = await servicesPromise;
      await services.close();
      await database.close();
      await fs.rm(dbPath, { force: true });
    }
  });
});

async function createServices(): Promise<{
  database: SqlDatabase;
  dbPath: string;
  servicesPromise: ReturnType<typeof createAgenrSkelnServices>;
}> {
  const dbPath = path.join(os.tmpdir(), `agenr-work-command-${randomUUID()}.sqlite`);
  const database = await createDatabase(dbPath);
  const repository = createWorkingMemoryRepository(database);
  const workingMemory = createWorkingMemoryService(
    { workingMemory: true },
    {
      repository,
      sourceLabel: "test",
      now: () => new Date("2026-05-30T12:00:00.000Z"),
    },
  );

  return {
    database,
    dbPath,
    servicesPromise: Promise.resolve({
      workingMemory,
      close: async () => {
        await database.close();
      },
    }) as ReturnType<typeof createAgenrSkelnServices>,
  };
}
