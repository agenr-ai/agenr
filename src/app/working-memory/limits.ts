const UTF8_ENCODER = new TextEncoder();

/** Snapshot note and candidate arrays keep the newest 50 unique entries, evicting older entries deterministically after deduplication. */
const WORKING_SNAPSHOT_ARRAY_LIMITS = {
  files: 50,
  commands: 50,
  decisions: 50,
  assumptions: 50,
  candidates: 50,
} as const;

/** Maximum UTF-8 byte length accepted for the freeform working-memory scratchpad. */
const WORKING_SCRATCHPAD_MAX_BYTES = 8192;

/** Maximum UTF-8 byte length injected for a rendered `<agenr_work_context>` projection. */
const WORKING_CONTEXT_PROJECTION_MAX_BYTES = 32768;

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

/** Returns the UTF-8 byte length of one string. */
export function utf8ByteLength(content: string): number {
  return UTF8_ENCODER.encode(content).length;
}

/**
 * Truncates content to a maximum UTF-8 byte length without leaving a dangling UTF-16 surrogate.
 *
 * @param content - Content to truncate.
 * @param maxBytes - Maximum encoded length to return.
 * @returns Content whose UTF-8 byte length is at most maxBytes.
 */
export function truncateUtf8ToMaxBytes(content: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return "";
  }

  if (utf8ByteLength(content) <= maxBytes) {
    return content;
  }

  let low = 0;
  let high = content.length;
  while (low < high) {
    const mid = Math.floor((low + high + 1) / 2);
    if (utf8ByteLength(content.slice(0, mid)) <= maxBytes) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }

  const truncated = content.slice(0, low);
  const last = truncated.charCodeAt(truncated.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? truncated.slice(0, -1) : truncated;
}

/**
 * Appends an entry, removes identical entries, and keeps the newest bounded tail.
 *
 * @param current - Existing snapshot entries.
 * @param next - Entry to append.
 * @param maxItems - Maximum retained array length.
 * @returns Bounded unique entries.
 */
export function appendBoundedUnique<T>(current: T[] | undefined, next: T, maxItems: number): T[] {
  return normalizeBoundedUnique([...(current ?? []), next], maxItems) ?? [];
}

/**
 * Removes duplicate entries and keeps the newest bounded tail.
 *
 * @param items - Existing snapshot entries.
 * @param maxItems - Maximum retained array length.
 * @returns Bounded unique entries.
 */
export function normalizeBoundedUnique<T>(items: T[] | undefined, maxItems: number): T[] | undefined {
  if (!items) {
    return undefined;
  }

  const seen = new Set<string>();
  const unique: T[] = [];
  for (const item of items) {
    const key = stableValueKey(item);
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(item);
    }
  }

  return unique.slice(Math.max(0, unique.length - maxItems));
}

/**
 * Maximum event history loaded when building a close snapshot.
 */
const CLOSE_EVENT_HISTORY_LIMIT = 1000;

/** Builds a stable structural key for deduplicating persisted JSON-compatible values. */
function stableValueKey(value: unknown): string {
  if (value === undefined) {
    return "undefined";
  }

  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableValueKey).join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableValueKey(entryValue)}`).join(",")}}`;
}

export { CLOSE_EVENT_HISTORY_LIMIT, WORKING_CONTEXT_PROJECTION_MAX_BYTES, WORKING_SCRATCHPAD_MAX_BYTES, WORKING_SNAPSHOT_ARRAY_LIMITS };
