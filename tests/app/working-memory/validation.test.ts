import { describe, expect, it } from "vitest";

import { canDefaultExpectedRevision, resolveExpectedRevision } from "../../../src/app/working-memory/validation.js";

describe("resolveExpectedRevision", () => {
  it("requires explicit revision for model tool updates", () => {
    expect(resolveExpectedRevision(4, undefined, "tool")).toMatchObject({
      ok: false,
      code: "invalid_request",
      message: "expectedRevision must be a non-negative integer.",
    });
  });

  it("defaults revision for trusted goal_command updates", () => {
    expect(resolveExpectedRevision(4, undefined, "goal_command")).toEqual({
      ok: true,
      value: 4,
    });
  });

  it("defaults revision for trusted lifecycle and consolidation updates", () => {
    expect(resolveExpectedRevision(2, undefined, "lifecycle_hook")).toEqual({ ok: true, value: 2 });
    expect(resolveExpectedRevision(2, undefined, "consolidation_job")).toEqual({ ok: true, value: 2 });
  });

  it("rejects missing revision when source is omitted", () => {
    expect(resolveExpectedRevision(4, undefined)).toMatchObject({
      ok: false,
      code: "invalid_request",
    });
  });

  it("normalizes an explicit revision", () => {
    expect(resolveExpectedRevision(4, 3, "tool")).toEqual({ ok: true, value: 3 });
  });
});

describe("canDefaultExpectedRevision", () => {
  it("returns true only for trusted host sources", () => {
    expect(canDefaultExpectedRevision("goal_command")).toBe(true);
    expect(canDefaultExpectedRevision("lifecycle_hook")).toBe(true);
    expect(canDefaultExpectedRevision("consolidation_job")).toBe(true);
    expect(canDefaultExpectedRevision("tool")).toBe(false);
    expect(canDefaultExpectedRevision(undefined)).toBe(false);
  });
});
