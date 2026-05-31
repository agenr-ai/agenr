/**
 * Serializes an optional JSON payload for SQLite storage.
 *
 * @param value - Value to serialize, or undefined to store SQL NULL.
 * @returns JSON string, or null when the value is undefined.
 */
export function serializeOptionalJson(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

/**
 * Parses optional JSON read from SQLite storage.
 *
 * @param value - Stored JSON string, if any.
 * @param label - Column label included in parse failures.
 * @returns Parsed value, or undefined when storage is empty.
 */
export function parseOptionalJson(value: string | undefined, label: string): unknown {
  if (!value) {
    return undefined;
  }

  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(`Failed to parse ${label}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}
