import { describe, expect, it } from "vitest";

import { applyOperation } from "../../../src/app/working-memory/apply-operation.js";
import { INITIAL_GOAL_GENERATION, nextGoalGenerationAfterObjectiveChange, readGoalGeneration } from "../../../src/app/working-memory/goal-generation.js";
import type { WorkingSetRecord } from "../../../src/app/working-memory/records.js";

describe("goalGeneration", () => {
  it("returns the current generation when the objective is unchanged", () => {
    const snapshot = { objective: "First objective", goalGeneration: INITIAL_GOAL_GENERATION };
    expect(nextGoalGenerationAfterObjectiveChange(snapshot, "First objective")).toBe(1);
  });

  it("increments generation when the objective changes", () => {
    const snapshot = { objective: "First objective", goalGeneration: INITIAL_GOAL_GENERATION };
    expect(nextGoalGenerationAfterObjectiveChange(snapshot, "Second objective")).toBe(2);
  });

  it("starts at one on create and bumps only when the objective changes", () => {
    const record = createRecord({ objective: "First objective", goalGeneration: INITIAL_GOAL_GENERATION });

    const unchanged = applyOperation(record, { type: "set_objective", objective: "First objective" }, "No-op objective write.");
    expect(unchanged.ok).toBe(true);
    if (!unchanged.ok) {
      throw new Error("Expected objective update to succeed.");
    }
    expect(readGoalGeneration(unchanged.snapshot)).toBe(1);

    const replaced = applyOperation(record, { type: "set_objective", objective: "Second objective" }, "Replaced objective.");
    expect(replaced.ok).toBe(true);
    if (!replaced.ok) {
      throw new Error("Expected objective replace to succeed.");
    }
    expect(readGoalGeneration(replaced.snapshot)).toBe(2);
  });

  it("does not bump on semantic non-objective operations", () => {
    const record = createRecord({ objective: "Hold steady", goalGeneration: 2 });

    const checkpoint = applyOperation(
      record,
      {
        type: "merge_checkpoint",
        checkpoint: { summary: "Compacted.", recordedAt: "2026-05-31T00:00:00.000Z" },
      },
      "Merged checkpoint.",
    );
    expect(checkpoint.ok).toBe(true);
    if (!checkpoint.ok) {
      throw new Error("Expected checkpoint merge to succeed.");
    }
    expect(readGoalGeneration(checkpoint.snapshot)).toBe(2);
  });
});

/** Builds one working-set record for goal-generation tests. */
function createRecord(snapshot: WorkingSetRecord["snapshot"]): WorkingSetRecord {
  return {
    id: "ws-generation",
    scopeKey: "conversation:session-1",
    scopeKind: "conversation",
    title: snapshot.objective ?? "Goal",
    objective: snapshot.objective ?? "",
    status: "active",
    snapshot,
    revision: 3,
    project: "project",
    sessionId: "session-1",
    conversationKey: "session-1",
    source: "test",
    createdAt: "2026-05-31T00:00:00.000Z",
    updatedAt: "2026-05-31T00:00:00.000Z",
    lastActiveAt: "2026-05-31T00:00:00.000Z",
  };
}
