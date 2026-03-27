import { describe, expect, it } from "vitest";

import { inferAroundDate, parseRelativeDate } from "./temporal.js";

const NOW = new Date("2026-03-26T00:00:00.000Z");
const toIsoDate = (value: Date | null): string | null => value?.toISOString().slice(0, 10) ?? null;

describe("inferAroundDate", () => {
  it('returns now minus 1 day for "yesterday"', () => {
    expect(toIsoDate(inferAroundDate("yesterday", NOW))).toBe("2026-03-25");
  });

  it('returns now minus 7 days for "last week"', () => {
    expect(toIsoDate(inferAroundDate("last week", NOW))).toBe("2026-03-19");
  });

  it('returns now minus 30 days for "last month"', () => {
    expect(toIsoDate(inferAroundDate("last month", NOW))).toBe("2026-02-24");
  });

  it('returns now minus 3 days for "3 days ago"', () => {
    expect(toIsoDate(inferAroundDate("3 days ago", NOW))).toBe("2026-03-23");
  });

  it('returns now minus 14 days for "2 weeks ago"', () => {
    expect(toIsoDate(inferAroundDate("2 weeks ago", NOW))).toBe("2026-03-12");
  });

  it('anchors "in February" to the most recent February midpoint', () => {
    expect(toIsoDate(inferAroundDate("what happened in February", NOW))).toBe("2026-02-15");
  });

  it('anchors "in December" to the previous year when that month has not happened yet', () => {
    expect(toIsoDate(inferAroundDate("what happened in December", NOW))).toBe("2025-12-15");
  });

  it("does not infer a date from ambiguous use of last", () => {
    expect(inferAroundDate("last decision about X", NOW)).toBeNull();
  });

  it("does not infer a date from non-temporal ordinal language", () => {
    expect(inferAroundDate("the first entry", NOW)).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(inferAroundDate("", NOW)).toBeNull();
  });

  it("clamps future inferred dates back to now", () => {
    const earlyMonthNow = new Date("2026-03-10T00:00:00.000Z");
    expect(toIsoDate(inferAroundDate("in March", earlyMonthNow))).toBe("2026-03-10");
  });
});

describe("parseRelativeDate", () => {
  it('parses "7d" as now minus 7 days', () => {
    expect(toIsoDate(parseRelativeDate("7d", NOW))).toBe("2026-03-19");
  });

  it('parses "30d" as now minus 30 days', () => {
    expect(toIsoDate(parseRelativeDate("30d", NOW))).toBe("2026-02-24");
  });

  it("parses ISO date strings directly", () => {
    expect(parseRelativeDate("2026-02-01T12:00:00.000Z", NOW)?.toISOString()).toBe("2026-02-01T12:00:00.000Z");
  });

  it("returns null for invalid date strings", () => {
    expect(parseRelativeDate("tomorrow-ish", NOW)).toBeNull();
  });
});
