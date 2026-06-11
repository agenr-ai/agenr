import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createDatabase, type SqlDatabase } from "../../../src/adapters/db/client.js";
import { createWorkingMemoryRepository } from "../../../src/adapters/db/working-memory-repository.js";
import { isWorkingSetWriteFailure, type WorkingMemoryRepository } from "../../../src/app/working-memory/repository.js";
import type { WorkingSetRecord } from "../../../src/app/working-memory/records.js";
import type { WorkingSnapshot } from "../../../src/app/working-memory/snapshot.js";
import { closeTestDatabase, removeTestPath } from "../../helpers/temp-paths.js";

const NOW = "2026-06-11T12:00:00.000Z";

describe("recordCandidateConsolidation", () => {
  let database: SqlDatabase;
  let dbPath: string;
  let repository: WorkingMemoryRepository;

  beforeEach(async () => {
    dbPath = path.join(os.tmpdir(), `agenr-consolidation-repo-${randomUUID()}.sqlite`);
    database = await createDatabase(dbPath);
    repository = createWorkingMemoryRepository(database);
  });

  afterEach(async () => {
    await closeTestDatabase(database);
    await removeTestPath(dbPath);
  });

  it("flips candidate statuses and appends one consolidated audit event without advancing revision", async () => {
    const workingSet = await createClosedWorkingSet(repository);
    const nextSnapshot: WorkingSnapshot = {
      ...workingSet.snapshot,
      candidates: workingSet.snapshot.candidates?.map((candidate) => ({ ...candidate, promotionStatus: "promoted" as const })),
    };

    const result = await repository.recordCandidateConsolidation({
      workingSetId: workingSet.id,
      expectedRevision: workingSet.revision,
      snapshot: nextSnapshot,
      auditEvent: {
        payload: { outcomes: [{ kind: "semantic", result: "stored" }] },
        actor: "system",
        source: "consolidation_job",
      },
      now: NOW,
    });

    if (isWorkingSetWriteFailure(result)) {
      throw new Error(`expected success, got ${result.kind}`);
    }

    expect(result.workingSet.revision).toBe(workingSet.revision);
    expect(result.workingSet.snapshot.candidates?.[0]?.promotionStatus).toBe("promoted");
    expect(result.workingSet.status).toBe("closed");
    expect(result.event.eventType).toBe("consolidated");
    expect(result.event.actor).toBe("system");
    expect(result.event.source).toBe("consolidation_job");

    const events = await repository.listWorkingEvents(workingSet.id, 50);
    const consolidated = events.filter((event) => event.eventType === "consolidated");
    expect(consolidated).toHaveLength(1);
    expect(consolidated[0]?.payload).toEqual({ outcomes: [{ kind: "semantic", result: "stored" }] });
  });

  it("rejects writes against a stale revision", async () => {
    const workingSet = await createClosedWorkingSet(repository);

    const result = await repository.recordCandidateConsolidation({
      workingSetId: workingSet.id,
      expectedRevision: workingSet.revision + 1,
      snapshot: workingSet.snapshot,
      auditEvent: { payload: {}, actor: "system", source: "consolidation_job" },
      now: NOW,
    });

    expect(result).toEqual({ kind: "revision_conflict", actualRevision: workingSet.revision });
  });

  it("returns not_found for unknown working sets", async () => {
    const result = await repository.recordCandidateConsolidation({
      workingSetId: "missing",
      expectedRevision: 1,
      snapshot: {},
      auditEvent: { payload: {}, actor: "system", source: "consolidation_job" },
      now: NOW,
    });

    expect(result).toEqual({ kind: "not_found" });
  });
});

/** Creates one closed working set with a pending semantic candidate. */
async function createClosedWorkingSet(repository: WorkingMemoryRepository): Promise<WorkingSetRecord> {
  const snapshot: WorkingSnapshot = {
    objective: "Ship it.",
    candidates: [
      {
        kind: "semantic",
        subject: "Release cadence decision",
        content: "Releases ship monthly.",
        provenance: { evidenceEventSequences: [2] },
        promotionStatus: "pending",
      },
    ],
  };
  const created = await repository.createWorkingSet({
    scope: { scopeKey: "session:session-1", scopeKind: "session", sessionId: "session-1" },
    objective: "Ship it.",
    status: "active",
    snapshot,
    actor: "runtime",
    source: "lifecycle_hook",
    sourceLabel: "test",
    now: NOW,
  });
  if ("kind" in created) {
    throw new Error(`expected created working set, got ${created.kind}`);
  }

  const closed = await repository.updateWorkingSet({
    workingSetId: created.workingSet.id,
    expectedRevision: created.workingSet.revision,
    eventType: "closed",
    payload: { reason: "test close" },
    status: "closed",
    snapshot,
    closedAt: NOW,
    closeReason: "test close",
    actor: "runtime",
    source: "lifecycle_hook",
    now: NOW,
  });
  if (isWorkingSetWriteFailure(closed)) {
    throw new Error(`expected closed working set, got ${closed.kind}`);
  }

  return closed.workingSet;
}
