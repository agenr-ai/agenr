import { describe, expect, it } from "vitest";

import { renderWorkingSnapshotDistillation, WORKING_CLOSE_DISTILLATION_MAX_BYTES } from "../../../src/app/working-memory/close-distillation.js";
import { utf8ByteLength } from "../../../src/app/working-memory/limits.js";

describe("renderWorkingSnapshotDistillation", () => {
  it("renders all material snapshot sections", () => {
    const rendered = renderWorkingSnapshotDistillation({
      objective: "Ship the recall eval seam.",
      summary: "Transport route and validation are in.",
      checkpoint: {
        summary: "Done. Route validated end to end.",
        recordedAt: "2026-05-31T00:00:00.000Z",
      },
      currentPlan: ["Wire the route", "Validate the contract"],
      completedSteps: ["Wire the route"],
      nextActions: [{ text: "Announce the seam", status: "pending" }, { text: "Delete the spike branch" }],
      decisions: [{ decision: "Use one internal HTTP route.", rationale: "Keeps the eval surface narrow." }, { decision: "No eval-only CLI commands." }],
      assumptions: [{ assumption: "agenr-evals owns scoring.", confidence: "high", validated: true }, { assumption: "No second transport is needed." }],
      blockers: ["Waiting on fixture refresh"],
    });

    expect(rendered).toBe(
      [
        "Objective: Ship the recall eval seam.",
        "Status summary: Transport route and validation are in.",
        "Final checkpoint: Done. Route validated end to end.",
        "Plan:",
        "- Wire the route",
        "- Validate the contract",
        "Completed steps:",
        "- Wire the route",
        "Next actions:",
        "- Announce the seam (pending)",
        "- Delete the spike branch",
        "Decisions:",
        "- Use one internal HTTP route. (rationale: Keeps the eval surface narrow.)",
        "- No eval-only CLI commands.",
        "Assumptions:",
        "- agenr-evals owns scoring. (confidence: high, validated)",
        "- No second transport is needed.",
        "Blockers:",
        "- Waiting on fixture refresh",
      ].join("\n"),
    );
  });

  it("omits empty sections and blank items", () => {
    const rendered = renderWorkingSnapshotDistillation({
      objective: "Ship it.",
      currentPlan: [],
      completedSteps: ["  "],
      blockers: undefined,
    });

    expect(rendered).toBe("Objective: Ship it.");
  });

  it("returns undefined for snapshots with no material content", () => {
    expect(renderWorkingSnapshotDistillation({})).toBeUndefined();
    expect(renderWorkingSnapshotDistillation({ objective: "  ", scratchpad: "transient notes" })).toBeUndefined();
  });

  it("bounds the rendered distillation to the configured byte budget", () => {
    const rendered = renderWorkingSnapshotDistillation({
      objective: "x".repeat(2 * WORKING_CLOSE_DISTILLATION_MAX_BYTES),
    });

    expect(rendered).toBeDefined();
    expect(utf8ByteLength(rendered!)).toBeLessThanOrEqual(WORKING_CLOSE_DISTILLATION_MAX_BYTES);
  });
});
