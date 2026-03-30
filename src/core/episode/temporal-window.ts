import type { ResolvedTemporalWindow, TemporalWindow, TemporalWindowBounds } from "./types.js";

const DAY_IN_MILLISECONDS = 24 * 60 * 60 * 1000;
const DEFAULT_ANCHOR_RADIUS_DAYS = 3;
const MONTH_INDEX = new Map<string, number>([
  ["january", 0],
  ["february", 1],
  ["march", 2],
  ["april", 3],
  ["may", 4],
  ["june", 5],
  ["july", 6],
  ["august", 7],
  ["september", 8],
  ["october", 9],
  ["november", 10],
  ["december", 11],
]);

/**
 * Parses supported temporal language from a recall query into a calendar-aware
 * episode window.
 *
 * @param text - Raw recall query text.
 * @param now - Reference clock used for relative calculations.
 * @returns Resolved time window, or null when the query has no supported time phrase.
 */
export function parseTemporalWindow(text: string, now: Date = new Date()): ResolvedTemporalWindow | null {
  const normalizedText = text.trim();
  const referenceNow = asValidDate(now);
  if (normalizedText.length === 0 || !referenceNow) {
    return null;
  }

  const timezone = getSystemTimeZone();
  const lower = normalizedText.toLowerCase();

  if (/\btoday\b/.test(lower)) {
    return buildResolvedWindow({
      window: {
        kind: "interval",
        start: startOfDayLocal(referenceNow),
        end: referenceNow,
        source: "inferred",
      },
      resolvedFrom: "today",
      timezone,
      now: referenceNow,
    });
  }

  if (/\byesterday\b/.test(lower)) {
    const target = addDaysLocal(referenceNow, -1);
    return buildResolvedWindow({
      window: {
        kind: "interval",
        start: startOfDayLocal(target),
        end: endOfDayLocal(target),
        source: "inferred",
      },
      resolvedFrom: "yesterday",
      timezone,
      now: referenceNow,
    });
  }

  if (/\bthis week\b/.test(lower)) {
    return buildResolvedWindow({
      window: {
        kind: "interval",
        start: startOfWeekLocal(referenceNow),
        end: referenceNow,
        source: "inferred",
      },
      resolvedFrom: "this week",
      timezone,
      now: referenceNow,
    });
  }

  if (/\blast week\b/.test(lower)) {
    const previousWeekDate = addDaysLocal(startOfWeekLocal(referenceNow), -1);
    const start = startOfWeekLocal(previousWeekDate);
    return buildResolvedWindow({
      window: {
        kind: "interval",
        start,
        end: endOfWeekLocal(previousWeekDate),
        source: "inferred",
      },
      resolvedFrom: "last week",
      timezone,
      now: referenceNow,
    });
  }

  if (/\bthis month\b/.test(lower)) {
    return buildResolvedWindow({
      window: {
        kind: "interval",
        start: startOfMonthLocal(referenceNow),
        end: referenceNow,
        source: "inferred",
      },
      resolvedFrom: "this month",
      timezone,
      now: referenceNow,
    });
  }

  if (/\blast month\b/.test(lower)) {
    const previousMonthDate = new Date(referenceNow.getFullYear(), referenceNow.getMonth() - 1, 1, 12);
    return buildResolvedWindow({
      window: {
        kind: "interval",
        start: startOfMonthLocal(previousMonthDate),
        end: endOfMonthLocal(previousMonthDate),
        source: "inferred",
      },
      resolvedFrom: "last month",
      timezone,
      now: referenceNow,
    });
  }

  const relativeMatch = lower.match(/\b(\d+)\s+(day|days|week|weeks|month|months)\s+ago\b/);
  if (relativeMatch?.[1] && relativeMatch[2]) {
    const amount = Number(relativeMatch[1]);
    if (Number.isFinite(amount) && amount > 0) {
      const unit = relativeMatch[2];
      if (unit.startsWith("day")) {
        const target = addDaysLocal(referenceNow, -amount);
        return buildResolvedWindow({
          window: {
            kind: "interval",
            start: startOfDayLocal(target),
            end: endOfDayLocal(target),
            source: "inferred",
          },
          resolvedFrom: relativeMatch[0],
          timezone,
          now: referenceNow,
        });
      }

      if (unit.startsWith("week")) {
        return buildResolvedWindow({
          window: {
            kind: "anchor",
            anchor: addDaysLocal(referenceNow, -amount * 7),
            radiusDays: DEFAULT_ANCHOR_RADIUS_DAYS,
            source: "inferred",
          },
          resolvedFrom: relativeMatch[0],
          timezone,
          now: referenceNow,
        });
      }

      if (unit.startsWith("month")) {
        return buildResolvedWindow({
          window: {
            kind: "anchor",
            anchor: subtractCalendarMonths(referenceNow, amount),
            radiusDays: DEFAULT_ANCHOR_RADIUS_DAYS,
            source: "inferred",
          },
          resolvedFrom: relativeMatch[0],
          timezone,
          now: referenceNow,
        });
      }
    }
  }

  const monthMatch = lower.match(/\bin\s+(january|february|march|april|may|june|july|august|september|october|november|december)\b/);
  if (monthMatch?.[1]) {
    const targetMonth = resolveMostRecentMonth(monthMatch[1], referenceNow);
    if (targetMonth) {
      return buildResolvedWindow({
        window: {
          kind: "interval",
          start: startOfMonthLocal(targetMonth),
          end: endOfMonthLocal(targetMonth),
          source: "inferred",
        },
        resolvedFrom: monthMatch[0],
        timezone,
        now: referenceNow,
      });
    }
  }

  const isoDateMatch = normalizedText.match(/\b(\d{4}-\d{2}-\d{2})(?:[tT][0-9:.+-Zz]+)?\b/);
  if (isoDateMatch?.[1]) {
    const targetDate = parseIsoDateLocal(isoDateMatch[1]);
    if (targetDate) {
      return buildResolvedWindow({
        window: {
          kind: "interval",
          start: startOfDayLocal(targetDate),
          end: endOfDayLocal(targetDate),
          source: "inferred",
        },
        resolvedFrom: isoDateMatch[1],
        timezone,
        now: referenceNow,
      });
    }
  }

  return null;
}

/**
 * Resolves a temporal window into concrete interval bounds for search and output.
 *
 * @param window - Temporal window definition to materialize.
 * @param now - Reference clock used when the window is open-ended.
 * @returns Concrete interval bounds, or null when the window is incomplete.
 */
export function resolveTemporalWindowBounds(window: TemporalWindow, now: Date = new Date()): TemporalWindowBounds | null {
  switch (window.kind) {
    case "interval":
      return window.start && window.end ? { start: window.start, end: window.end } : null;
    case "anchor":
      if (!window.anchor || window.radiusDays === undefined || window.radiusDays < 0) {
        return null;
      }

      return {
        start: new Date(window.anchor.getTime() - Math.trunc(window.radiusDays) * DAY_IN_MILLISECONDS),
        end: new Date(window.anchor.getTime() + Math.trunc(window.radiusDays) * DAY_IN_MILLISECONDS),
      };
    case "open_end":
      return window.start ? { start: window.start, end: asValidDate(now) ?? new Date() } : null;
    case "open_start":
      return null;
    default:
      return null;
  }
}

/**
 * Returns the runtime system timezone used for local calendar interpretation.
 *
 * @returns IANA timezone identifier when available, otherwise `UTC`.
 */
export function getSystemTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

/**
 * Builds a stable resolved-window payload after bounds are materialized.
 *
 * @param params - Window, matched text, timezone, and reference clock.
 * @returns Resolved temporal window, or null when bounds cannot be computed.
 */
function buildResolvedWindow(params: { window: TemporalWindow; resolvedFrom: string; timezone: string; now: Date }): ResolvedTemporalWindow | null {
  const bounds = resolveTemporalWindowBounds(params.window, params.now);
  if (!bounds) {
    return null;
  }

  return {
    window: params.window,
    bounds,
    timezone: params.timezone,
    resolvedFrom: params.resolvedFrom,
  };
}

/**
 * Returns a validated copy of a Date input.
 *
 * @param value - Candidate date instance.
 * @returns Equivalent date when valid, otherwise null.
 */
function asValidDate(value: Date): Date | null {
  const normalized = new Date(value.getTime());
  return Number.isNaN(normalized.getTime()) ? null : normalized;
}

/**
 * Adds whole local-calendar days to a reference date.
 *
 * @param date - Reference date.
 * @param days - Signed day offset.
 * @returns Offset date in local time.
 */
function addDaysLocal(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days, date.getHours(), date.getMinutes(), date.getSeconds(), date.getMilliseconds());
}

/**
 * Returns the start of the local calendar day for a reference date.
 *
 * @param date - Reference date.
 * @returns Day start in local time.
 */
function startOfDayLocal(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
}

/**
 * Returns the end of the local calendar day for a reference date.
 *
 * @param date - Reference date.
 * @returns Day end in local time.
 */
function endOfDayLocal(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 59, 999);
}

/**
 * Returns the local start of week for a reference date using the host locale.
 *
 * @param date - Reference date.
 * @returns Week start in local time.
 */
function startOfWeekLocal(date: Date): Date {
  const weekStart = resolveWeekStartDay();
  const currentDay = date.getDay();
  const offset = (currentDay - weekStart + 7) % 7;
  return startOfDayLocal(addDaysLocal(date, -offset));
}

/**
 * Returns the local end of week for a reference date using the host locale.
 *
 * @param date - Reference date.
 * @returns Week end in local time.
 */
function endOfWeekLocal(date: Date): Date {
  return endOfDayLocal(addDaysLocal(startOfWeekLocal(date), 6));
}

/**
 * Returns the start of the local calendar month for a reference date.
 *
 * @param date - Reference date.
 * @returns Month start in local time.
 */
function startOfMonthLocal(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), 1, 0, 0, 0, 0);
}

/**
 * Returns the end of the local calendar month for a reference date.
 *
 * @param date - Reference date.
 * @returns Month end in local time.
 */
function endOfMonthLocal(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0, 23, 59, 59, 999);
}

/**
 * Resolves the most recent past-or-current occurrence of a named month.
 *
 * @param monthName - Lowercase English month name.
 * @param now - Reference clock used to pick the year.
 * @returns Local date inside the target month, or null when the name is unsupported.
 */
function resolveMostRecentMonth(monthName: string, now: Date): Date | null {
  const monthIndex = MONTH_INDEX.get(monthName);
  if (monthIndex === undefined) {
    return null;
  }

  const year = monthIndex <= now.getMonth() ? now.getFullYear() : now.getFullYear() - 1;
  return new Date(year, monthIndex, 15, 12, 0, 0, 0);
}

/**
 * Parses a YYYY-MM-DD string as a local calendar date.
 *
 * @param value - ISO calendar date string.
 * @returns Local date at noon, or null when the input is invalid.
 */
function parseIsoDateLocal(value: string): Date | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match?.[1] || !match[2] || !match[3]) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const parsed = new Date(year, month, day, 12, 0, 0, 0);
  if (parsed.getFullYear() !== year || parsed.getMonth() !== month || parsed.getDate() !== day) {
    return null;
  }

  return parsed;
}

/**
 * Subtracts whole calendar months while clamping to the last day of the target month.
 *
 * @param date - Reference date.
 * @param months - Positive month count to subtract.
 * @returns Shifted local date.
 */
function subtractCalendarMonths(date: Date, months: number): Date {
  const targetMonthIndex = date.getMonth() - months;
  const targetYear = date.getFullYear() + Math.floor(targetMonthIndex / 12);
  const normalizedMonth = ((targetMonthIndex % 12) + 12) % 12;
  const targetLastDay = new Date(targetYear, normalizedMonth + 1, 0).getDate();
  const day = Math.min(date.getDate(), targetLastDay);
  return new Date(targetYear, normalizedMonth, day, date.getHours(), date.getMinutes(), date.getSeconds(), date.getMilliseconds());
}

/**
 * Resolves the host locale week-start day as a JavaScript weekday index.
 *
 * @returns Sunday-based weekday index used by `Date#getDay`.
 */
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
    // Fall back below when locale week metadata is unavailable.
  }

  return 1;
}
