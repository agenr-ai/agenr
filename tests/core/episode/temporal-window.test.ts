import { describe, expect, it } from "vitest";

import { getSystemTimeZone, parseTemporalWindow } from "../../../src/core/episode/temporal-window.js";

const NOW = new Date(2026, 2, 30, 15, 45, 0, 0);

describe("parseTemporalWindow", () => {
  it("parses yesterday as a local day interval", () => {
    const resolved = parseTemporalWindow("what happened yesterday", NOW);

    expect(resolved?.resolvedFrom).toBe("yesterday");
    expect(resolved?.timezone).toBe(getSystemTimeZone());
    expect(formatLocalDate(resolved?.bounds.start)).toBe("2026-03-29");
    expect(formatLocalDate(resolved?.bounds.end)).toBe("2026-03-29");
  });

  it("parses last week as the previous calendar week", () => {
    const resolved = parseTemporalWindow("summarize last week", NOW);
    const expectedStart = expectedLastWeekStart(NOW);
    const expectedEnd = new Date(expectedStart.getFullYear(), expectedStart.getMonth(), expectedStart.getDate() + 6, 23, 59, 59, 999);

    expect(resolved?.resolvedFrom).toBe("last week");
    expect(formatLocalDate(resolved?.bounds.start)).toBe(formatLocalDate(expectedStart));
    expect(formatLocalDate(resolved?.bounds.end)).toBe(formatLocalDate(expectedEnd));
  });

  it("parses last month as the previous calendar month", () => {
    const resolved = parseTemporalWindow("what were we doing last month", NOW);

    expect(formatLocalDate(resolved?.bounds.start)).toBe("2026-02-01");
    expect(formatLocalDate(resolved?.bounds.end)).toBe("2026-02-28");
  });

  it("parses relative weeks ago into a fixed anchor window", () => {
    const resolved = parseTemporalWindow("what happened 2 weeks ago", NOW);

    expect(resolved?.resolvedFrom).toBe("2 weeks ago");
    expect(formatLocalDate(resolved?.bounds.start)).toBe("2026-03-13");
    expect(formatLocalDate(resolved?.bounds.end)).toBe("2026-03-19");
  });

  it("parses month-name queries into the most recent month interval", () => {
    const resolved = parseTemporalWindow("what happened in March", NOW);

    expect(formatLocalDate(resolved?.bounds.start)).toBe("2026-03-01");
    expect(formatLocalDate(resolved?.bounds.end)).toBe("2026-03-31");
  });

  it("parses ISO dates embedded in the query", () => {
    const resolved = parseTemporalWindow("what happened on 2026-03-15 for the release", NOW);

    expect(resolved?.resolvedFrom).toBe("2026-03-15");
    expect(formatLocalDate(resolved?.bounds.start)).toBe("2026-03-15");
    expect(formatLocalDate(resolved?.bounds.end)).toBe("2026-03-15");
  });

  it("returns null when the query has no supported time expression", () => {
    expect(parseTemporalWindow("what did we do recently", NOW)).toBeNull();
  });
});

function expectedLastWeekStart(now: Date): Date {
  const currentWeekStart = startOfWeek(now);
  return new Date(currentWeekStart.getFullYear(), currentWeekStart.getMonth(), currentWeekStart.getDate() - 7, 0, 0, 0, 0);
}

function startOfWeek(date: Date): Date {
  const currentDay = date.getDay();
  const offset = (currentDay - resolveWeekStartDay() + 7) % 7;
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() - offset, 0, 0, 0, 0);
}

function resolveWeekStartDay(): number {
  try {
    const locale = Intl.DateTimeFormat().resolvedOptions().locale;
    const info = (
      new Intl.Locale(locale) as Intl.Locale & {
        weekInfo?: {
          firstDay?: number;
        };
      }
    ).weekInfo;
    const firstDay = info?.firstDay;
    if (typeof firstDay === "number" && firstDay >= 1 && firstDay <= 7) {
      return firstDay % 7;
    }
  } catch {
    // Fall back below.
  }

  return 1;
}

function formatLocalDate(value: Date | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
