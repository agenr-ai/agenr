import { describe, expect, it } from "vitest";

import { validateTemporalValidityRange } from "../../src/core/temporal-validity.js";

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
