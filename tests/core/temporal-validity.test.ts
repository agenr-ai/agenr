import { describe, expect, it } from "vitest";

import { isWithinValidityWindow, validateTemporalValidityRange } from "../../src/core/temporal-validity.js";

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
