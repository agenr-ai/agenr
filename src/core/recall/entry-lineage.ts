import { isCurrentlyValidMemory } from "../temporal-validity.js";
import type { Durable } from "../types.js";

/**
 * Narrow lineage state label used when inspecting one durable.
 *
 * - `superseded`: a newer revision replaced this entry.
 * - `historical`: the entry is stale at the reference instant (closed
 *   `valid_to`) but was not superseded.
 * - `current`: the entry is the live value at the reference instant.
 *
 * This follows the current-memory gate ({@link isCurrentlyValidMemory}), which
 * ignores `valid_from` so scheduled memories stay reachable for direct retrieval
 * and trace. Excluding not-yet-valid rows is owned by as-of recall via
 * {@link isWithinValidityWindow}.
 */
export type DurableLineageState = "superseded" | "historical" | "current";

/**
 * Classifies one durable's lineage state for trace inspection.
 *
 * @param entry - Durable to classify.
 * @param nowMs - Reference instant in epoch milliseconds.
 * @returns Narrow lineage state label.
 */
export function describeDurableLineageState(entry: Durable, nowMs: number): DurableLineageState {
  if (entry.superseded_by) {
    return "superseded";
  }

  if (!isCurrentlyValidMemory(entry, nowMs)) {
    return "historical";
  }

  return "current";
}

/**
 * Formats the claim-key lifecycle label for trace lineage output.
 *
 * @param entry - Durable to describe.
 * @returns Lifecycle label used in lineage inspection.
 */
export function formatDurableClaimLifecycle(entry: Durable): string {
  if (!entry.claim_key) {
    return "no-key";
  }

  return entry.claim_key_status ?? "legacy";
}

/**
 * Builds a compact change summary from one traced claim family.
 *
 * @param entries - Claim-family members in discovery order.
 * @param nowMs - Reference instant in epoch milliseconds.
 * @returns Human-readable transition summary, or undefined when empty.
 */
export function summarizeClaimFamilyTransition(entries: Durable[], nowMs: number): string | undefined {
  const current = entries.find((entry) => isCurrentlyValidMemory(entry, nowMs));
  const prior = [...entries].reverse().find((entry) => entry.id !== current?.id && isHistoricalFamilyMember(entry, nowMs));
  if (current && prior) {
    return `${prior.id} -> ${current.id}`;
  }
  if (prior) {
    return `${prior.id} is historical with no current sibling in the traced family`;
  }
  if (current) {
    return `${current.id} is the only current sibling in the traced family`;
  }
  return undefined;
}

/** Returns whether one claim-family member is historical at the reference instant. */
function isHistoricalFamilyMember(entry: Durable, nowMs: number): boolean {
  if (entry.superseded_by) {
    return true;
  }

  return !isCurrentlyValidMemory(entry, nowMs);
}
