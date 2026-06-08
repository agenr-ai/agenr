/** Shared helpers for parsing untyped dream action and proposal audit payloads. */

/** Reads a string array from an untyped detail payload. */
export function readStringArrayDetail(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0) : [];
}

/** Reads a number from an untyped detail payload. */
export function readNumberDetail(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Reads a nullable number from an untyped detail payload. */
export function readNullableNumberDetail(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Returns whether a value is a non-null object record. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
