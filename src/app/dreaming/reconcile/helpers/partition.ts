import type { Durable } from "../../../../core/types.js";
import { createEmptyClaimKeyInspectionTally, tallyExistingClaimKeyInspection } from "./claim-key-health-tally.js";
import { inspectExistingClaimKey, type ExistingClaimKeyInspection } from "./claim-key-inspection.js";

/**
 * One durable paired with its reconcile inspection outcome.
 */
export interface InspectedDurable {
  durable: Durable;
  inspection: ExistingClaimKeyInspection;
}

/**
 * Durables grouped by reconcile inspection outcome for staged processing.
 */
export interface ReconcileDurablePartitions {
  invalidOrNoncanonical: InspectedDurable[];
  missing: InspectedDurable[];
  suspect: InspectedDurable[];
}

/**
 * Partition output plus inspection counts from the same single pass.
 */
export interface PartitionReconcileDurablesResult {
  partitions: ReconcileDurablePartitions;
  inspectionTally: ReturnType<typeof createEmptyClaimKeyInspectionTally>;
  inspectionById: Map<string, ExistingClaimKeyInspection>;
}

/**
 * Partitions the working set into reconcile stage buckets with one inspection per durable.
 *
 * @param durables - Projected durables under review.
 * @param eligibleTypes - Durable types eligible for missing-key backfill.
 * @returns Stage buckets and inspection counts from one pass.
 */
export function partitionReconcileDurables(durables: Durable[], eligibleTypes: readonly string[]): PartitionReconcileDurablesResult {
  const invalidOrNoncanonical: InspectedDurable[] = [];
  const missing: InspectedDurable[] = [];
  const suspect: InspectedDurable[] = [];
  const inspectionTally = createEmptyClaimKeyInspectionTally();
  const inspectionById = new Map<string, ExistingClaimKeyInspection>();

  for (const durable of durables) {
    const inspection = inspectExistingClaimKey(durable);
    inspectionById.set(durable.id, inspection);
    tallyExistingClaimKeyInspection(inspection, durable.type, eligibleTypes, inspectionTally);
    const item = { durable, inspection };

    switch (inspection.kind) {
      case "malformed":
      case "noncanonical":
        invalidOrNoncanonical.push(item);
        break;
      case "missing":
        if (eligibleTypes.includes(durable.type)) {
          missing.push(item);
        }
        break;
      case "suspect":
        suspect.push(item);
        break;
      default:
        break;
    }
  }

  return {
    partitions: { invalidOrNoncanonical, missing, suspect },
    inspectionTally,
    inspectionById,
  };
}
