import { describe, expect, it } from "vitest";

import { isCurrentlyValidMemory, isStaleMemory, isWithinValidityWindow, validateTemporalValidityRange } from "../../src/core/temporal-validity.js";

describe("validateTemporalValidityRange", () => {
  it("accepts an open-ended lower bound", () => {
    expect(validateTemporalValidityRange(" 2026-04-01T00:00:00.000Z ", undefined)).toEqual({
      ok: true,
      value: {
        validFrom: "2026-04-01T00:00:00.000Z",
        validTo: undefined,
      },
    });
  });

  it("accepts an open-ended upper bound", () => {
    expect(validateTemporalValidityRange(undefined, " 2026-04-30T00:00:00.000Z ")).toEqual({
      ok: true,
      value: {
        validFrom: undefined,
        validTo: "2026-04-30T00:00:00.000Z",
      },
    });
  });

  it("accepts strictly ordered bounds", () => {
    expect(validateTemporalValidityRange("2026-04-01T00:00:00.000Z", "2026-04-30T00:00:00.000Z")).toEqual({
      ok: true,
      value: {
        validFrom: "2026-04-01T00:00:00.000Z",
        validTo: "2026-04-30T00:00:00.000Z",
      },
    });
  });

  it("rejects equal timestamps", () => {
    expect(validateTemporalValidityRange("2026-04-01T00:00:00.000Z", "2026-04-01T00:00:00.000Z")).toEqual({
      ok: false,
      code: "invalid_range",
      message: "valid_from must be earlier than valid_to.",
    });
  });

  it("rejects reversed ranges", () => {
    expect(validateTemporalValidityRange("2026-04-30T00:00:00.000Z", "2026-04-01T00:00:00.000Z")).toEqual({
      ok: false,
      code: "invalid_range",
      message: "valid_from must be earlier than valid_to.",
    });
  });
});

describe("isWithinValidityWindow", () => {
  const asOf = Date.parse("2026-03-15T00:00:00.000Z");

  it("treats fully open windows as always valid", () => {
    expect(isWithinValidityWindow(undefined, undefined, asOf)).toBe(true);
    expect(isWithinValidityWindow(null, null, asOf)).toBe(true);
  });

  it("keeps rows inside the window", () => {
    expect(isWithinValidityWindow("2026-03-01T00:00:00.000Z", "2026-03-31T00:00:00.000Z", asOf)).toBe(true);
  });

  it("excludes not-yet-valid rows", () => {
    expect(isWithinValidityWindow("2026-03-20T00:00:00.000Z", undefined, asOf)).toBe(false);
  });

  it("excludes expired rows", () => {
    expect(isWithinValidityWindow(undefined, "2026-03-10T00:00:00.000Z", asOf)).toBe(false);
  });

  it("treats boundaries as inclusive", () => {
    expect(isWithinValidityWindow("2026-03-15T00:00:00.000Z", undefined, asOf)).toBe(true);
    expect(isWithinValidityWindow(undefined, "2026-03-15T00:00:00.000Z", asOf)).toBe(true);
  });

  it("ignores unparseable bounds rather than excluding the row", () => {
    expect(isWithinValidityWindow("not-a-date", "also-bad", asOf)).toBe(true);
    expect(isWithinValidityWindow("   ", "", asOf)).toBe(true);
  });
});

describe("isCurrentlyValidMemory", () => {
  const now = Date.parse("2026-03-15T00:00:00.000Z");

  it("treats open, unsuperseded rows as current", () => {
    expect(isCurrentlyValidMemory({}, now)).toBe(true);
    expect(isCurrentlyValidMemory({ valid_to: null, superseded_by: null }, now)).toBe(true);
  });

  it("excludes superseded rows regardless of validity window", () => {
    expect(isCurrentlyValidMemory({ superseded_by: "newer" }, now)).toBe(false);
    expect(isCurrentlyValidMemory({ superseded_by: "newer", valid_to: "2026-12-01T00:00:00.000Z" }, now)).toBe(false);
  });

  it("excludes closed rows at and after the valid_to boundary", () => {
    expect(isCurrentlyValidMemory({ valid_to: "2026-03-15T00:00:00.000Z" }, now)).toBe(false);
    expect(isCurrentlyValidMemory({ valid_to: "2026-03-20T00:00:00.000Z" }, now)).toBe(true);
  });

  it("ignores valid_from so scheduled memories stay reachable for direct retrieval", () => {
    expect(isCurrentlyValidMemory({ valid_to: null }, now)).toBe(true);
  });

  it("ignores an unparseable valid_to rather than excluding the row", () => {
    expect(isCurrentlyValidMemory({ valid_to: "also-bad" }, now)).toBe(true);
    expect(isCurrentlyValidMemory({ valid_to: "" }, now)).toBe(true);
  });
});

describe("isStaleMemory", () => {
  const now = Date.parse("2026-03-15T00:00:00.000Z");

  it("treats open unsuperseded rows as not stale", () => {
    expect(isStaleMemory({}, now)).toBe(false);
    expect(isStaleMemory({ valid_to: "2026-03-20T00:00:00.000Z" }, now)).toBe(false);
  });

  it("treats closed rows at and after the valid_to boundary as stale", () => {
    expect(isStaleMemory({ valid_to: "2026-03-15T00:00:00.000Z" }, now)).toBe(true);
    expect(isStaleMemory({ valid_to: "2026-03-10T00:00:00.000Z" }, now)).toBe(true);
  });

  it("does not treat superseded rows as stale", () => {
    expect(isStaleMemory({ superseded_by: "newer", valid_to: "2026-03-10T00:00:00.000Z" }, now)).toBe(false);
  });

  it("ignores an unparseable valid_to rather than marking the row stale", () => {
    expect(isStaleMemory({ valid_to: "also-bad" }, now)).toBe(false);
    expect(isStaleMemory({ valid_to: "" }, now)).toBe(false);
  });
});
