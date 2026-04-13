import { createHash } from "node:crypto";

import type { ProcedureDefinition } from "../types.js";

/**
 * Computes a stable hash for the raw authored procedure source.
 *
 * @param sourceText - Raw YAML source text.
 * @returns SHA-256 digest for the exact authored source.
 */
export function computeProcedureSourceHash(sourceText: string): string {
  return createHash("sha256").update(sourceText).digest("hex");
}

/**
 * Computes a stable hash for the normalized procedure body.
 *
 * @param procedure - Canonical normalized procedure definition.
 * @returns SHA-256 digest for the normalized runtime shape.
 */
export function computeProcedureRevisionHash(procedure: ProcedureDefinition): string {
  return createHash("sha256")
    .update(stringifyCanonical(procedure as unknown as CanonicalJsonValue))
    .digest("hex");
}

/**
 * Serializes one JSON-like value with lexicographically sorted object keys.
 *
 * @param value - Canonical JSON-like value to serialize.
 * @returns Stable JSON string.
 */
function stringifyCanonical(value: CanonicalJsonValue): string {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stringifyCanonical(item)).join(",")}]`;
  }

  const keys = Object.keys(value).sort((left, right) => left.localeCompare(right));
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stringifyCanonical(value[key])}`).join(",")}}`;
}

/**
 * Recursive JSON-like value space accepted by the canonical stringifier.
 */
type CanonicalJsonValue = string | number | boolean | null | CanonicalJsonValue[] | { [key: string]: CanonicalJsonValue };
