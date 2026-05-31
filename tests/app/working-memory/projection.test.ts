import { describe, expect, it } from "vitest";

import { shouldInjectWorkingContext, toWorkingContextAuditPointer, type WorkingContextProjection } from "../../../src/app/working-memory/projection.js";

describe("shouldInjectWorkingContext", () => {
  it("injects only full projections with non-empty content", () => {
    const full: WorkingContextProjection = {
      kind: "working_set",
      renderMode: "full",
      content: "<agenr_work_context>\nObjective: Ship it.\n</agenr_work_context>",
      workingSetId: "ws-1",
      revision: 2,
      sourceRef: "test:full",
      byteLength: 42,
    };
    const stub: WorkingContextProjection = {
      kind: "working_set",
      renderMode: "stub",
      content: "<agenr_work_context>\nReason: missing_active_set\n</agenr_work_context>",
      sourceRef: "test:stub",
      byteLength: 40,
    };

    expect(shouldInjectWorkingContext(full)).toBe(true);
    expect(shouldInjectWorkingContext(stub)).toBe(false);
    expect(shouldInjectWorkingContext({ ...full, content: "   " })).toBe(false);
  });
});

describe("toWorkingContextAuditPointer", () => {
  it("returns a compact audit pointer for full projections", () => {
    expect(
      toWorkingContextAuditPointer({
        kind: "working_set",
        renderMode: "full",
        content: "<agenr_work_context></agenr_work_context>",
        workingSetId: "ws-1",
        revision: 3,
        sourceRef: "skeln:before-turn:key",
        byteLength: 32,
      }),
    ).toEqual({
      source: "agenr_work",
      workingSetId: "ws-1",
      revision: 3,
      sourceRef: "skeln:before-turn:key",
      bytes: 32,
      summary: "Working set ws-1 rev 3",
    });
  });

  it("returns undefined when provenance is incomplete", () => {
    expect(
      toWorkingContextAuditPointer({
        kind: "working_set",
        renderMode: "stub",
        content: "stub",
        sourceRef: "test:stub",
        byteLength: 4,
      }),
    ).toBeUndefined();
  });
});
