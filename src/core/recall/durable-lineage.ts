import { resolveKeyedDurableLifecycleStatus } from "../keyed-durable-lifecycle.js";
import { isCurrentlyValidMemory } from "../temporal-validity.js";
import type { Durable } from "../types.js";

/**
 * Narrow lineage state label used when inspecting one durable.
 *
 * - `superseded`: a newer revision replaced this durable.
 * - `historical`: the durable is stale at the reference instant (closed
 *   `valid_to`) but was not superseded.
 * - `current`: the durable is the live value at the reference instant.
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
 * @param durable - Durable to classify.
 * @param nowMs - Reference instant in epoch milliseconds.
 * @returns Narrow lineage state label.
 */
export function describeDurableLineageState(durable: Durable, nowMs: number): DurableLineageState {
  if (durable.superseded_by) {
    return "superseded";
  }

  if (!isCurrentlyValidMemory(durable, nowMs)) {
    return "historical";
  }

  return "current";
}

/**
 * Formats the claim-key lifecycle label for trace lineage output.
 *
 * @param durable - Durable to describe.
 * @returns Lifecycle label used in lineage inspection.
 */
export function formatDurableClaimLifecycle(durable: Durable): string {
  const status = resolveKeyedDurableLifecycleStatus(durable);
  return status === "no_key" ? "no-key" : status;
}

/**
 * Builds a compact change summary from one traced claim family.
 *
 * @param durables - Claim-family members in discovery order.
 * @param nowMs - Reference instant in epoch milliseconds.
 * @returns Human-readable transition summary, or undefined when empty.
 */
export function summarizeClaimFamilyTransition(durables: Durable[], nowMs: number): string | undefined {
  const current = durables.find((durable) => isCurrentlyValidMemory(durable, nowMs));
  const prior = [...durables].reverse().find((durable) => durable.id !== current?.id && isHistoricalFamilyMember(durable, nowMs));
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
function isHistoricalFamilyMember(durable: Durable, nowMs: number): boolean {
  if (durable.superseded_by) {
    return true;
  }

  return !isCurrentlyValidMemory(durable, nowMs);
}
