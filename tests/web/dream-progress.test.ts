import { describe, expect, it } from "vitest";

import type { DreamJobEvent } from "../../web/src/api/types.js";
import { describeEvent } from "../../web/src/lib/dream-progress.js";

type ReconcileProgress = Extract<NonNullable<DreamJobEvent["progress"]>, { kind: "reconcile_progress" }>;

describe("dream progress log formatting", () => {
  it("explains backup completion with the saved path", () => {
    const line = describeEvent({
      seq: 1,
      at: "2026-06-08T16:00:00.000Z",
      kind: "progress",
      progress: {
        kind: "phase",
        phase: "backup_complete",
        tier: "light",
        apply: true,
        backupPath: "/tmp/knowledge.db.backup",
      },
    });

    expect(line).toEqual({
      stage: "backup",
      message: "Backup complete. Saved database copy to /tmp/knowledge.db.backup.",
    });
  });

  it("summarizes loaded candidates and eligible proposals", () => {
    const line = describeEvent({
      seq: 2,
      at: "2026-06-08T16:00:01.000Z",
      kind: "progress",
      progress: {
        kind: "phase",
        phase: "load_working_set_complete",
        tier: "standard",
        apply: false,
        workingSetSize: 42,
        eligibleProposalBacklogCount: 3,
      },
    });

    expect(line).toEqual({
      stage: "load",
      message: "Loaded 42 candidate memories; 3 eligible proposals ready for resolution.",
    });
  });

  it("renders reconcile counters and preview details", () => {
    const line = describeEvent({
      seq: 3,
      at: "2026-06-08T16:00:02.000Z",
      kind: "progress",
      progress: {
        kind: "reconcile_progress",
        tier: "standard",
        apply: true,
        stage: "missing",
        status: "preview_progress",
        completed: 7,
        total: 12,
        unitLabel: "durables",
        previewQueued: 4,
        previewCompleted: 2,
        previewTotal: 4,
        previewConcurrency: 2,
        processedDurables: 7,
        totalDurables: 12,
        elapsedMs: 1200,
        counts: buildCounts({
          appliedBackfills: 1,
          proposalsEmitted: 2,
          flaggedAmbiguousProposals: 1,
          skippedLowConfidence: 3,
        }),
      },
    });

    expect(line).toEqual({
      stage: "reconcile",
      message: "Missing claim keys: Previewing 7/12 durables; 4 queued for LLM preview; 2/4 previews completed; 1 applied, 3 proposed, 3 skipped.",
    });
  });

  it("renders alias convergence stage and counters", () => {
    const line = describeEvent({
      seq: 6,
      at: "2026-06-08T16:00:05.000Z",
      kind: "progress",
      progress: {
        kind: "reconcile_progress",
        tier: "deep",
        apply: true,
        stage: "claim_key_alias_convergence",
        status: "applied",
        completed: 2,
        total: 2,
        unitLabel: "groups",
        previewQueued: 0,
        previewCompleted: 0,
        previewTotal: 0,
        previewConcurrency: 1,
        processedDurables: 2,
        totalDurables: 2,
        elapsedMs: 800,
        counts: buildCounts({
          appliedAliasConvergences: 1,
          proposalsEmitted: 1,
        }),
      },
    });

    expect(line).toEqual({
      stage: "reconcile",
      message: "Claim-key alias convergence: Applied 2/2 groups; 1 applied, 1 proposed, 0 skipped.",
    });
  });

  it("renders alias proposal resolution issue labels", () => {
    const line = describeEvent({
      seq: 7,
      at: "2026-06-08T16:00:06.000Z",
      kind: "progress",
      progress: {
        kind: "proposal_resolution_progress",
        tier: "proposal_resolution",
        apply: true,
        status: "proposal_processed",
        totalProposals: 1,
        processedProposals: 1,
        appliedCount: 0,
        rejectedInactiveCount: 0,
        rejectedInvalidCount: 0,
        noChangeCount: 1,
        targetedEntryCount: 1,
        issueKind: "claim_key_alias_convergence",
        outcome: "no_change",
      },
    });

    expect(line.message).toContain("current issue Claim-Key Alias Convergence");
  });

  it("renders proposal resolution outcomes", () => {
    const line = describeEvent({
      seq: 4,
      at: "2026-06-08T16:00:03.000Z",
      kind: "progress",
      progress: {
        kind: "proposal_resolution_progress",
        tier: "proposal_resolution",
        apply: true,
        status: "proposal_processed",
        totalProposals: 5,
        processedProposals: 4,
        appliedCount: 2,
        rejectedInactiveCount: 1,
        rejectedInvalidCount: 1,
        noChangeCount: 0,
        targetedEntryCount: 5,
        issueKind: "missing_claim_key",
        outcome: "applied",
      },
    });

    expect(line).toEqual({
      stage: "proposals",
      message: "Processed 4/5 proposals; 2 applied; 1 inactive; 1 invalid; 0 unchanged; current issue Missing Claim Key; last outcome Applied.",
    });
  });

  it("renders terminal status events", () => {
    const line = describeEvent({
      seq: 5,
      at: "2026-06-08T16:00:04.000Z",
      kind: "status",
      status: "completed",
      message: "Run run-1 completed.",
    });

    expect(line).toEqual({
      stage: "complete",
      message: "Run run-1 completed.",
    });
  });
});

function buildCounts(overrides: Partial<ReconcileProgress["counts"]> = {}): ReconcileProgress["counts"] {
  return {
    identifiedNormalizations: 0,
    appliedNormalizations: 0,
    identifiedBackfills: 0,
    appliedBackfills: 0,
    identifiedMetadataRewrites: 0,
    appliedMetadataRewrites: 0,
    identifiedEntityFamilyConvergences: 0,
    appliedEntityFamilyConvergences: 0,
    identifiedAliasConvergences: 0,
    appliedAliasConvergences: 0,
    proposalsEmitted: 0,
    skippedNoClaim: 0,
    skippedLowConfidence: 0,
    skippedCollision: 0,
    flaggedAmbiguousProposals: 0,
    ...overrides,
  };
}
