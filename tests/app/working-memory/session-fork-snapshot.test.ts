import { describe, expect, it } from "vitest";

import { cloneForkableSnapshotFields } from "../../../src/app/working-memory/session-fork-snapshot.js";
import { FORKABLE_SNAPSHOT_FIELD_KEYS, type WorkingSnapshot } from "../../../src/app/working-memory/snapshot.js";

describe("cloneForkableSnapshotFields", () => {
  it("documents the forkable snapshot field contract", () => {
    expect(FORKABLE_SNAPSHOT_FIELD_KEYS).toEqual(["currentPlan", "nextActions", "checkpoint", "scratchpad", "files", "commands", "decisions", "assumptions"]);
  });

  it("returns an empty snapshot when the source is missing", () => {
    expect(cloneForkableSnapshotFields(undefined)).toEqual({});
  });

  it("copies forkable session fields defensively", () => {
    const source: WorkingSnapshot = {
      currentPlan: ["Step 1", "Step 2"],
      nextActions: [{ text: "Run tests", status: "pending" }],
      checkpoint: {
        summary: "Paused before handoff.",
        nextActions: ["Resume implementation"],
        blockers: ["Waiting on review"],
      },
      scratchpad: "Session scratchpad.",
      files: [{ path: "src/app/working-memory/service.ts", note: "Main service." }],
      commands: [{ command: "pnpm test", outcome: "passed" }],
      decisions: [{ decision: "Keep session and goal sets separate.", rationale: "Clearer ownership." }],
      assumptions: [{ assumption: "Session id is always present.", confidence: "high", validated: true }],
      objective: "Should not copy goal-only fields by default.",
      summary: "Should not copy summaries.",
    };

    const forked = cloneForkableSnapshotFields(source);

    expect(forked).toEqual({
      currentPlan: ["Step 1", "Step 2"],
      nextActions: [{ text: "Run tests", status: "pending" }],
      checkpoint: {
        summary: "Paused before handoff.",
        nextActions: ["Resume implementation"],
        blockers: ["Waiting on review"],
      },
      scratchpad: "Session scratchpad.",
      files: [{ path: "src/app/working-memory/service.ts", note: "Main service." }],
      commands: [{ command: "pnpm test", outcome: "passed" }],
      decisions: [{ decision: "Keep session and goal sets separate.", rationale: "Clearer ownership." }],
      assumptions: [{ assumption: "Session id is always present.", confidence: "high", validated: true }],
    });
    expect(forked).not.toHaveProperty("objective");
    expect(forked).not.toHaveProperty("summary");

    source.currentPlan?.push("Mutated");
    if (source.nextActions?.[0]) {
      source.nextActions[0].text = "Mutated";
    }
    source.checkpoint?.nextActions?.push("Mutated");
    if (source.files?.[0]) {
      source.files[0].note = "Mutated";
    }

    expect(forked.currentPlan).toEqual(["Step 1", "Step 2"]);
    expect(forked.nextActions).toEqual([{ text: "Run tests", status: "pending" }]);
    expect(forked.checkpoint?.nextActions).toEqual(["Resume implementation"]);
    expect(forked.files).toEqual([{ path: "src/app/working-memory/service.ts", note: "Main service." }]);
  });
});
