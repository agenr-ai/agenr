import { describe, expect, it } from "vitest";

import { computeCandidateFingerprint, runWorkingSetConsolidation } from "../../../src/app/working-memory/consolidation.js";
import type { WorkingCandidate } from "../../../src/app/working-memory/snapshot.js";
import { computeContentHash } from "../../../src/core/store/hashing.js";
import {
  ConsolidationMockDatabase,
  createCapturingWorkingMemoryRepository,
  createInMemoryProposalRepository,
  createStubEmbedding,
  proceduralCandidate,
  semanticCandidate,
} from "./consolidation-test-doubles.js";
import { createTestWorkingSet } from "./service-test-helpers.js";

const NOW = "2026-06-11T12:00:00.000Z";

describe("runWorkingSetConsolidation", () => {
  it("promotes a pending semantic candidate through the claim-key store pipeline", async () => {
    const candidate = semanticCandidate({ suggestedClaimKey: "agenr.release/cadence", suggestedKind: "decision" });
    const harness = createHarness([candidate], { status: "closed", project: "agenr" });

    const result = await runWorkingSetConsolidation(harness.deps, { workingSetId: "ws-1", now: NOW });

    expect(result).toMatchObject({ ok: true, changed: true });
    if (!result.ok) {
      throw new Error("expected success");
    }

    expect(result.outcomes).toEqual([
      {
        kind: "semantic",
        subject: candidate.subject,
        promotionStatus: "promoted",
        result: "stored",
        durableId: harness.db.insertions[0]?.id,
      },
    ]);

    const stored = harness.db.insertions[0];
    expect(stored?.type).toBe("decision");
    // The store pipeline normalizes manual claim keys (dots become underscores).
    expect(stored?.claim_key).toBe("agenr_release/cadence");
    expect(stored?.source_file).toBe("working_set:ws-1");
    expect(stored?.source_context).toContain("working set ws-1");
    expect(stored?.source_context).toContain("3, 5");
    expect(stored?.project).toBe("agenr");

    const write = harness.workingMemory.consolidationWrites[0];
    expect(write?.auditEvent.actor).toBe("system");
    expect(write?.auditEvent.source).toBe("consolidation_job");
    expect(write?.snapshot.candidates?.[0]?.promotionStatus).toBe("promoted");
  });

  it("treats duplicate semantic content as promoted without a new durable", async () => {
    const candidate = semanticCandidate();
    const harness = createHarness([candidate], { status: "closed" });
    harness.db.existingHashes.add(computeContentHash(candidate.content, "working_set:ws-1"));

    const result = await runWorkingSetConsolidation(harness.deps, { workingSetId: "ws-1", now: NOW });

    expect(result).toMatchObject({ ok: true, changed: true });
    if (!result.ok) {
      throw new Error("expected success");
    }

    expect(result.outcomes).toEqual([{ kind: "semantic", subject: candidate.subject, promotionStatus: "promoted", result: "duplicate" }]);
    expect(harness.db.insertions).toHaveLength(0);
  });

  it("marks semantic candidates the store pipeline rejects as rejected", async () => {
    const candidate = semanticCandidate({ content: "" });
    const harness = createHarness([candidate], { status: "closed" });

    const result = await runWorkingSetConsolidation(harness.deps, { workingSetId: "ws-1", now: NOW });

    expect(result).toMatchObject({ ok: true, changed: true });
    if (!result.ok) {
      throw new Error("expected success");
    }

    expect(result.outcomes).toEqual([{ kind: "semantic", subject: candidate.subject, promotionStatus: "rejected", result: "rejected" }]);
    expect(harness.db.insertions).toHaveLength(0);
    const write = harness.workingMemory.consolidationWrites[0];
    expect(write?.snapshot.candidates?.[0]?.promotionStatus).toBe("rejected");
  });

  it("creates a reviewable proposal for a pending procedural candidate", async () => {
    const candidate = proceduralCandidate();
    const harness = createHarness([candidate], { status: "closed" });

    const result = await runWorkingSetConsolidation(harness.deps, { workingSetId: "ws-1", now: NOW });

    expect(result).toMatchObject({ ok: true, changed: true });
    if (!result.ok) {
      throw new Error("expected success");
    }

    expect(result.outcomes).toEqual([
      {
        kind: "procedural",
        subject: candidate.subject,
        promotionStatus: "promoted",
        result: "proposal_created",
        proposalId: harness.proposals.records[0]?.id,
      },
    ]);

    const proposal = harness.proposals.records[0];
    expect(proposal?.workingSetId).toBe("ws-1");
    expect(proposal?.candidateFingerprint).toBe(computeCandidateFingerprint(candidate));
    expect(proposal?.evidenceEventSequences).toEqual([3, 5]);
    expect(proposal?.status).toBe("open");
  });

  it("reuses an existing proposal instead of creating a duplicate", async () => {
    const candidate = proceduralCandidate();
    const harness = createHarness([candidate], { status: "closed" });
    const existing = await harness.deps.procedureProposals.createProposal({
      workingSetId: "ws-1",
      candidateFingerprint: computeCandidateFingerprint(candidate),
      subject: candidate.subject,
      content: candidate.content,
      evidenceEventSequences: [3, 5],
      now: NOW,
    });

    const result = await runWorkingSetConsolidation(harness.deps, { workingSetId: "ws-1", now: NOW });

    expect(result).toMatchObject({ ok: true, changed: true });
    if (!result.ok) {
      throw new Error("expected success");
    }

    expect(result.outcomes).toEqual([
      { kind: "procedural", subject: candidate.subject, promotionStatus: "promoted", result: "proposal_exists", proposalId: existing.id },
    ]);
    expect(harness.proposals.records).toHaveLength(1);
  });

  it("is a no-op when every durable candidate is already settled", async () => {
    const settled: WorkingCandidate[] = [
      { ...semanticCandidate(), promotionStatus: "promoted" },
      { ...proceduralCandidate(), promotionStatus: "dismissed" },
      { kind: "episodic", summary: "Did things.", provenance: { evidenceEventSequences: [1] }, promotionStatus: "pending" },
    ];
    const harness = createHarness(settled, { status: "closed" });

    const result = await runWorkingSetConsolidation(harness.deps, { workingSetId: "ws-1", now: NOW });

    expect(result).toMatchObject({ ok: true, changed: false, outcomes: [] });
    expect(harness.db.insertions).toHaveLength(0);
    expect(harness.proposals.records).toHaveLength(0);
    expect(harness.workingMemory.consolidationWrites).toHaveLength(0);
  });

  it("leaves pending episodic candidates untouched", async () => {
    const candidates: WorkingCandidate[] = [
      { kind: "episodic", summary: "Did things.", provenance: { evidenceEventSequences: [1] }, promotionStatus: "pending" },
      semanticCandidate(),
    ];
    const harness = createHarness(candidates, { status: "closed" });

    const result = await runWorkingSetConsolidation(harness.deps, { workingSetId: "ws-1", now: NOW });

    expect(result).toMatchObject({ ok: true, changed: true });
    const write = harness.workingMemory.consolidationWrites[0];
    expect(write?.snapshot.candidates?.[0]?.promotionStatus).toBe("pending");
    expect(write?.snapshot.candidates?.[1]?.promotionStatus).toBe("promoted");
  });

  it("fails with not_closed for open working sets", async () => {
    const harness = createHarness([semanticCandidate()], { status: "active" });

    await expect(runWorkingSetConsolidation(harness.deps, { workingSetId: "ws-1", now: NOW })).resolves.toEqual({ ok: false, reason: "not_closed" });
  });

  it("fails with not_found for unknown working sets", async () => {
    const harness = createHarness([], { status: "closed" });

    await expect(runWorkingSetConsolidation(harness.deps, { workingSetId: "missing", now: NOW })).resolves.toEqual({ ok: false, reason: "not_found" });
  });

  it("surfaces bookkeeping revision conflicts", async () => {
    const harness = createHarness([semanticCandidate()], { status: "closed" });
    harness.workingMemory.failWith = { kind: "revision_conflict", actualRevision: 9 };

    await expect(runWorkingSetConsolidation(harness.deps, { workingSetId: "ws-1", now: NOW })).resolves.toEqual({
      ok: false,
      reason: "revision_conflict",
    });
  });
});

/** Test harness bundling consolidation deps and capture state. */
function createHarness(candidates: WorkingCandidate[], options: { status: "closed" | "active"; project?: string }) {
  const workingSet = createTestWorkingSet({
    id: "ws-1",
    scopeKind: "session",
    scopeKey: "session:session-1",
    status: options.status,
    revision: 4,
    snapshot: { objective: "Ship it.", candidates },
    ...(options.project ? { project: options.project } : {}),
  });
  const workingMemory = createCapturingWorkingMemoryRepository(workingSet);
  const db = new ConsolidationMockDatabase();
  const proposals = createInMemoryProposalRepository();

  return {
    workingMemory,
    db,
    proposals,
    deps: {
      workingMemory: workingMemory.repository,
      db,
      embedding: createStubEmbedding(),
      procedureProposals: proposals.repository,
    },
  };
}
