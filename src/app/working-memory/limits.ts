/**
 * Normalizes a positive integer limit into a bounded range.
 *
 * @param value - Caller-supplied limit.
 * @param fallback - Default when value is missing or invalid.
 * @param max - Upper bound.
 * @returns Bounded limit.
 */
export function normalizeBoundedLimit(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined || !Number.isInteger(value) || value <= 0) {
    return fallback;
  }

  return Math.min(value, max);
}

/** Normalizes event-tail limits for get responses. */
export function normalizeEventLimit(value: number | undefined): number {
  return normalizeBoundedLimit(value, 50, 200);
}

/** Normalizes list limits for list responses. */
export function normalizeListLimit(value: number | undefined): number {
  return normalizeBoundedLimit(value, 20, 100);
}

/**
 * Maximum event history loaded when building a close snapshot.
 */
const CLOSE_EVENT_HISTORY_LIMIT = 1000;

export { CLOSE_EVENT_HISTORY_LIMIT };
