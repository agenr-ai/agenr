import { describe, expect, it, vi } from "vitest";

import { scheduleWorkingSetConsolidation } from "../../../src/adapters/shared/working-set-consolidation.js";
import {
  ConsolidationMockDatabase,
  createCapturingWorkingMemoryRepository,
  createInMemoryProposalRepository,
  createStubEmbedding,
  proceduralCandidate,
  semanticCandidate,
} from "../../app/working-memory/consolidation-test-doubles.js";
import { createTestWorkingSet } from "../../app/working-memory/service-test-helpers.js";

describe("scheduleWorkingSetConsolidation", () => {
  it("does nothing when no durable candidate is pending", () => {
    const logger = createCapturingLogger();
    const harness = createHarness("active");

    scheduleWorkingSetConsolidation({
      services: harness.services,
      workingSetId: "ws-1",
      candidates: [
        semanticCandidate({ promotionStatus: "promoted" }),
        proceduralCandidate({ promotionStatus: "dismissed" }),
        { kind: "episodic", summary: "Did things.", provenance: { evidenceEventSequences: [1] }, promotionStatus: "pending" },
      ],
      logger,
    });

    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(harness.workingMemory.consolidationWrites).toHaveLength(0);
  });

  it("skips with a log line when runtime ports are missing", () => {
    const logger = createCapturingLogger();
    const harness = createHarness("closed");

    scheduleWorkingSetConsolidation({
      services: { durables: harness.services.durables, embedding: harness.services.embedding },
      workingSetId: "ws-1",
      candidates: [semanticCandidate()],
      logger,
    });

    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("reason=missing_runtime_ports"));
  });

  it("runs consolidation for pending durable candidates and logs the outcome", async () => {
    const logger = createCapturingLogger();
    const harness = createHarness("closed");

    scheduleWorkingSetConsolidation({
      services: harness.services,
      workingSetId: "ws-1",
      candidates: [semanticCandidate()],
      logger,
    });

    await vi.waitFor(() => {
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("consolidation finished for workingSet=ws-1"));
    });
    expect(harness.workingMemory.consolidationWrites).toHaveLength(1);
    expect(harness.workingMemory.consolidationWrites[0]?.auditEvent.source).toBe("consolidation_job");
    expect(harness.db.insertions).toHaveLength(1);
  });

  it("logs a warning when the consolidation pass reports a stable failure", async () => {
    const logger = createCapturingLogger();
    const harness = createHarness("active");

    scheduleWorkingSetConsolidation({
      services: harness.services,
      workingSetId: "ws-1",
      candidates: [semanticCandidate()],
      logger,
    });

    await vi.waitFor(() => {
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("reason=not_closed"));
    });
    expect(harness.workingMemory.consolidationWrites).toHaveLength(0);
  });
});

/** Builds spy-backed info/warn logger doubles. */
function createCapturingLogger() {
  return { info: vi.fn(), warn: vi.fn() };
}

/** Builds runtime services around one in-memory working set. */
function createHarness(status: "closed" | "active") {
  const workingSet = createTestWorkingSet({
    id: "ws-1",
    scopeKind: "session",
    scopeKey: "session:session-1",
    status,
    revision: 4,
    snapshot: { objective: "Ship it.", candidates: [semanticCandidate()] },
  });
  const workingMemory = createCapturingWorkingMemoryRepository(workingSet);
  const db = new ConsolidationMockDatabase();
  const proposals = createInMemoryProposalRepository();

  return {
    workingMemory,
    db,
    proposals,
    services: {
      durables: db,
      embedding: createStubEmbedding(),
      workingMemoryRepository: workingMemory.repository,
      procedureProposals: proposals.repository,
    },
  };
}
