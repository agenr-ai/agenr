import { describe, expect, it } from "vitest";

import { applyOperation } from "../../../src/app/working-memory/apply-operation.js";
import type { AgenrWorkUpdateOperation } from "../../../src/app/working-memory/mutations.js";
import type { WorkingSetRecord } from "../../../src/app/working-memory/records.js";

describe("applyOperation", () => {
  it("replaces the plan and optional next actions", () => {
    const result = applyOperation(
      createRecord(),
      {
        type: "replace_plan",
        currentPlan: ["Inspect the issue", "Patch the service"],
        nextActions: [{ text: "Run focused tests", status: "pending" }],
      },
      "Replaced plan.",
    );

    expectApplied(result);
    expect(result.snapshot).toMatchObject({
      currentPlan: ["Inspect the issue", "Patch the service"],
      nextActions: [{ text: "Run focused tests", status: "pending" }],
      lastMaterialChange: "Replaced plan.",
    });
  });

  it("sets next actions", () => {
    const result = applyOperation(
      createRecord({
        nextActions: [{ text: "Old action", status: "pending" }],
      }),
      {
        type: "set_next_actions",
        nextActions: [{ text: "New action", status: "in_progress", ref: "#15" }],
      },
      "Updated next actions.",
    );

    expectApplied(result);
    expect(result.snapshot.nextActions).toEqual([{ text: "New action", status: "in_progress", ref: "#15" }]);
  });

  it("adds candidates", () => {
    const result = applyOperation(
      createRecord(),
      {
        type: "add_candidate",
        candidate: {
          kind: "semantic",
          subject: "Working memory",
          content: "Host-only operations must be app-gated.",
          provenance: { evidenceEventSequences: [1] },
          promotionStatus: "pending",
        },
      },
      "Added candidate.",
    );

    expectApplied(result);
    expect(result.snapshot.candidates).toEqual([
      {
        kind: "semantic",
        subject: "Working memory",
        content: "Host-only operations must be app-gated.",
        provenance: { evidenceEventSequences: [1] },
        promotionStatus: "pending",
      },
    ]);
  });

  it("records assumptions", () => {
    const result = applyOperation(
      createRecord(),
      {
        type: "record_assumption",
        assumption: {
          assumption: "The caller has already loaded the current revision.",
          confidence: "medium",
          validated: false,
        },
      },
      "Recorded assumption.",
    );

    expectApplied(result);
    expect(result.snapshot.assumptions).toEqual([
      {
        assumption: "The caller has already loaded the current revision.",
        confidence: "medium",
        validated: false,
      },
    ]);
  });

  it("adds command notes", () => {
    const result = applyOperation(
      createRecord(),
      {
        type: "add_command_note",
        command: {
          command: "pnpm vitest tests/app/working-memory/apply-operation.test.ts",
          outcome: "Passed",
          observedAt: "2026-06-11T10:00:00.000Z",
        },
      },
      "Recorded command.",
    );

    expectApplied(result);
    expect(result.snapshot.commands).toEqual([
      {
        command: "pnpm vitest tests/app/working-memory/apply-operation.test.ts",
        outcome: "Passed",
        observedAt: "2026-06-11T10:00:00.000Z",
      },
    ]);
  });

  it("adds file notes", () => {
    const result = applyOperation(
      createRecord(),
      {
        type: "add_file_note",
        file: {
          path: "src/app/working-memory/apply-operation.ts",
          note: "Switch must stay exhaustive.",
          observedAt: "2026-06-11T10:00:00.000Z",
        },
      },
      "Recorded file.",
    );

    expectApplied(result);
    expect(result.snapshot.files).toEqual([
      {
        path: "src/app/working-memory/apply-operation.ts",
        note: "Switch must stay exhaustive.",
        observedAt: "2026-06-11T10:00:00.000Z",
      },
    ]);
  });

  it("rejects close-managed statuses on the update path", () => {
    for (const operation of [
      { type: "set_status", status: "closed" },
      { type: "set_status", status: "abandoned" },
    ] satisfies AgenrWorkUpdateOperation[]) {
      expect(applyOperation(createRecord(), operation, "Attempted terminal status.")).toMatchObject({
        ok: false,
        code: "invalid_request",
        message: "Use agenr_work close for closed or abandoned terminal states.",
      });
    }
  });

  it("rejects invalid budget configuration values", () => {
    for (const operation of [
      { type: "configure_budget", budget: { tokenBudget: -1 } },
      { type: "configure_budget", budget: { wallClockBudgetSeconds: Number.NaN } },
    ] satisfies AgenrWorkUpdateOperation[]) {
      expect(applyOperation(createRecord(), operation, "Configured invalid budget.")).toMatchObject({
        ok: false,
        code: "invalid_request",
      });
    }
  });

  it("rejects invalid usage accounting values", () => {
    for (const operation of [
      { type: "account_usage", usage: { tokenDelta: -1 } },
      { type: "account_usage", usage: { turnDelta: Number.NaN } },
    ] satisfies AgenrWorkUpdateOperation[]) {
      expect(applyOperation(createRecord(), operation, "Recorded invalid usage.")).toMatchObject({
        ok: false,
        code: "invalid_request",
      });
    }
  });
});

/** Narrows successful applyOperation results for test assertions. */
function expectApplied(result: ReturnType<typeof applyOperation>): asserts result is Extract<ReturnType<typeof applyOperation>, { ok: true }> {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error("Expected operation application to succeed.");
  }
}

/** Builds one working-set record for direct operation tests. */
function createRecord(snapshot: WorkingSetRecord["snapshot"] = {}): WorkingSetRecord {
  return {
    id: "ws-apply-operation",
    scopeKey: "conversation:session-1",
    scopeKind: "conversation",
    title: snapshot.objective ?? "Working memory test",
    objective: snapshot.objective ?? "Exercise applyOperation.",
    status: "active",
    snapshot,
    revision: 1,
    project: "project",
    sessionId: "session-1",
    conversationKey: "session-1",
    source: "test",
    createdAt: "2026-06-11T10:00:00.000Z",
    updatedAt: "2026-06-11T10:00:00.000Z",
    lastActiveAt: "2026-06-11T10:00:00.000Z",
  };
}
