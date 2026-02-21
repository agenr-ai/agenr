import { describe, expect, it } from "vitest";
import { parseSince, parseSinceToIso } from "../../src/utils/time.js";

describe("utils time", () => {
  it("parses h, d, m, and y durations", () => {
    const now = new Date("2026-02-15T00:00:00.000Z");

    expect(parseSince("1h", now)?.toISOString()).toBe("2026-02-14T23:00:00.000Z");
    expect(parseSince("2d", now)?.toISOString()).toBe("2026-02-13T00:00:00.000Z");
    expect(parseSince("1m", now)?.toISOString()).toBe("2026-01-16T00:00:00.000Z");
    expect(parseSince("1y", now)?.toISOString()).toBe("2025-02-15T00:00:00.000Z");
  });

  it("returns undefined for empty since values", () => {
    const now = new Date("2026-02-15T00:00:00.000Z");
    expect(parseSince(undefined, now)).toBeUndefined();
    expect(parseSince("   ", now)).toBeUndefined();
  });

  it("rejects invalid since values", () => {
    const now = new Date("2026-02-15T00:00:00.000Z");
    expect(() => parseSince("1w", now)).toThrow("Invalid since value");
    expect(() => parseSince("0d", now)).toThrow("Invalid since value");
    expect(() => parseSince("abc", now)).toThrow("Invalid since value");
  });

  it("converts parsed since values to ISO", () => {
    const now = new Date("2026-02-15T00:00:00.000Z");
    expect(parseSinceToIso(undefined, now)).toBeUndefined();
    expect(parseSinceToIso("7d", now)).toBe("2026-02-08T00:00:00.000Z");
    expect(parseSinceToIso("2026-02-10T00:00:00.000Z", now)).toBe("2026-02-10T00:00:00.000Z");
  });

  it("throws configured invalid parse messages for parseSinceToIso", () => {
    const now = new Date("2026-02-15T00:00:00.000Z");
    expect(() => parseSinceToIso("oops", now)).toThrow("Invalid date value");
    expect(() => parseSinceToIso("oops", now, "Invalid --until value. Use 1h, 7d, 1m, 1y, or an ISO date.")).toThrow(
      "Invalid --until value. Use 1h, 7d, 1m, 1y, or an ISO date.",
    );
  });
});
