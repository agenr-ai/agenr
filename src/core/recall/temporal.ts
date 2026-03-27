const DAY_IN_MILLISECONDS = 1000 * 60 * 60 * 24;
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
 * Infer an around-date from explicit temporal language in a recall query.
 *
 * @param text - Raw query text.
 * @param now - Reference time for relative calculations.
 * @returns Inferred around-date, or null when no supported phrase is found.
 */
export function inferAroundDate(text: string, now: Date = new Date()): Date | null {
  const normalized = text.trim().toLowerCase();
  const referenceNow = asValidDate(now);

  if (normalized.length === 0 || !referenceNow) {
    return null;
  }

  let inferred: Date | null = null;

  if (/\byesterday\b/.test(normalized)) {
    inferred = offsetDays(referenceNow, 1);
  } else if (/\blast week\b/.test(normalized)) {
    inferred = offsetDays(referenceNow, 7);
  } else if (/\blast month\b/.test(normalized)) {
    inferred = offsetDays(referenceNow, 30);
  } else if (/\blast year\b/.test(normalized)) {
    inferred = offsetDays(referenceNow, 365);
  } else if (/\bthis week\b/.test(normalized)) {
    inferred = offsetDays(referenceNow, 3);
  } else if (/\bthis month\b/.test(normalized)) {
    inferred = offsetDays(referenceNow, 15);
  } else {
    const relativeMatch = normalized.match(/\b(\d+)\s+(day|days|week|weeks|month|months)\s+ago\b/);
    if (relativeMatch) {
      const amount = Number(relativeMatch[1]);
      const unit = relativeMatch[2];
      const multiplier = unit?.startsWith("week") ? 7 : unit?.startsWith("month") ? 30 : 1;
      inferred = Number.isFinite(amount) ? offsetDays(referenceNow, amount * multiplier) : null;
    } else {
      const monthMatch = normalized.match(/\bin\s+(january|february|march|april|may|june|july|august|september|october|november|december)\b/);
      if (monthMatch?.[1]) {
        inferred = inferMonthAnchor(monthMatch[1], referenceNow);
      }
    }
  }

  if (!inferred) {
    return null;
  }

  return inferred.getTime() > referenceNow.getTime() ? new Date(referenceNow.getTime()) : inferred;
}

/**
 * Parse supported relative date strings used by recall filters.
 *
 * @param input - ISO date string or relative day shorthand such as "7d".
 * @param now - Reference time for relative calculations.
 * @returns Parsed date, or null when the input is unsupported.
 */
export function parseRelativeDate(input: string, now: Date = new Date()): Date | null {
  const trimmed = input.trim();
  const referenceNow = asValidDate(now);

  if (trimmed.length === 0 || !referenceNow) {
    return null;
  }

  const durationMatch = trimmed.match(/^(\d+)d$/i);
  if (durationMatch?.[1]) {
    const days = Number(durationMatch[1]);
    return Number.isFinite(days) ? offsetDays(referenceNow, days) : null;
  }

  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Convert a possibly invalid date input into a validated Date instance. */
const asValidDate = (value: Date): Date | null => {
  const date = new Date(value.getTime());
  return Number.isNaN(date.getTime()) ? null : date;
};

/** Subtract a whole-day offset from a reference time. */
const offsetDays = (date: Date, days: number): Date => new Date(date.getTime() - days * DAY_IN_MILLISECONDS);

/** Infer the most recent anchored month occurrence for "in <month>" queries. */
const inferMonthAnchor = (monthName: string, now: Date): Date | null => {
  const monthIndex = MONTH_INDEX.get(monthName);
  if (monthIndex === undefined) {
    return null;
  }

  const year = monthIndex <= now.getUTCMonth() ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  return new Date(Date.UTC(year, monthIndex, 15));
};
