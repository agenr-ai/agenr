import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDatabase, type SqlDatabase } from "../../../src/adapters/db/client.js";
import { createWorkingMemoryRepository } from "../../../src/adapters/db/working-memory-repository.js";
import { isWorkingSetCreateFailure, isWorkingSetWriteFailure, type WorkingMemoryRepository } from "../../../src/app/working-memory/repository.js";
import type { ResolvedWorkingScope } from "../../../src/app/working-memory/scope.js";
import type { WorkingSetRecord } from "../../../src/app/working-memory/records.js";
import { closeTestDatabase, removeTestPath } from "../../helpers/temp-paths.js";

const CREATED_AT = "2026-04-01T12:00:00.000Z";

describe("working-memory retention repository", () => {
  let database: SqlDatabase;
  let dbPath: string;
  let repository: WorkingMemoryRepository;

  beforeEach(async () => {
    dbPath = path.join(os.tmpdir(), `agenr-working-memory-retention-${randomUUID()}.sqlite`);
    database = await createDatabase(dbPath);
    repository = createWorkingMemoryRepository(database);
  });

  afterEach(async () => {
    await closeTestDatabase(database);
    await removeTestPath(dbPath);
  });

  it("lists only terminal sets closed before the cutoff", async () => {
    const oldClosed = await createTerminalWorkingSet("old", "2026-04-02T12:00:00.000Z");
    await createTerminalWorkingSet("recent", "2026-06-01T12:00:00.000Z");
    await createActiveWorkingSet("active");

    const reapable = await repository.listReapableWorkingSets({ closedBefore: "2026-05-01T00:00:00.000Z" });

    expect(reapable.map((workingSet) => workingSet.id)).toEqual([oldClosed.id]);
  });

  it("deletes terminal sets together with their event ledgers", async () => {
    const closed = await createTerminalWorkingSet("old", "2026-04-02T12:00:00.000Z");
    const kept = await createTerminalWorkingSet("recent", "2026-06-01T12:00:00.000Z");

    const deleted = await repository.deleteWorkingSets([closed.id]);

    expect(deleted).toEqual({ workingSetsDeleted: 1, workingEventsDeleted: 2 });
    await expect(repository.getWorkingSet(closed.id)).resolves.toBeNull();
    await expect(repository.listWorkingEvents(closed.id)).resolves.toEqual([]);
    await expect(repository.getWorkingSet(kept.id)).resolves.not.toBeNull();
    await expect(repository.listWorkingEvents(kept.id)).resolves.toHaveLength(2);
  });

  it("never deletes a non-terminal set even when its id is requested", async () => {
    const active = await createActiveWorkingSet("active");

    const deleted = await repository.deleteWorkingSets([active.id]);

    expect(deleted).toEqual({ workingSetsDeleted: 0, workingEventsDeleted: 0 });
    await expect(repository.getWorkingSet(active.id)).resolves.not.toBeNull();
  });

  it("treats repeated deletes as idempotent no-ops", async () => {
    const closed = await createTerminalWorkingSet("old", "2026-04-02T12:00:00.000Z");

    await repository.deleteWorkingSets([closed.id]);
    const second = await repository.deleteWorkingSets([closed.id]);

    expect(second).toEqual({ workingSetsDeleted: 0, workingEventsDeleted: 0 });
  });

  /** Creates one active working set in its own session scope. */
  async function createActiveWorkingSet(label: string): Promise<WorkingSetRecord> {
    const created = await repository.createWorkingSet({
      scope: buildScope(label),
      status: "active",
      snapshot: { objective: `Objective ${label}` },
      now: CREATED_AT,
    });
    if (isWorkingSetCreateFailure(created)) {
      throw new Error(`Could not create working set for scope ${label}.`);
    }

    return created.workingSet;
  }

  /** Creates one working set and closes it at the requested timestamp. */
  async function createTerminalWorkingSet(label: string, closedAt: string): Promise<WorkingSetRecord> {
    const workingSet = await createActiveWorkingSet(label);
    const closed = await repository.updateWorkingSet({
      workingSetId: workingSet.id,
      expectedRevision: workingSet.revision,
      eventType: "closed",
      payload: { reason: "done" },
      status: "closed",
      snapshot: workingSet.snapshot,
      closedAt,
      closeReason: "done",
      now: closedAt,
    });
    if (isWorkingSetWriteFailure(closed)) {
      throw new Error(`Could not close working set for scope ${label}.`);
    }

    return closed.workingSet;
  }
});

/** Builds one isolated session scope per label. */
function buildScope(label: string): ResolvedWorkingScope {
  return {
    scopeKey: `session:${label}`,
    scopeKind: "session",
    sessionId: label,
  };
}
