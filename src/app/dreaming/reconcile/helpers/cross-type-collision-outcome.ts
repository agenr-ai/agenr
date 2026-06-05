import type { Durable } from "../../../../core/types.js";
import type { ReconcilePassContext } from "../pass-context.js";
import { findActiveClaimKeyOccupants } from "./durable.js";
import { expandCrossTypeCollisionDurableIds, persistCrossTypeCollisionProposal, type PersistReconcileProposalCallInput } from "./reconcile-proposal.js";

/**
 * Returns active sibling durables that occupy the same claim key with a different type.
 *
 * @param projectedDurables - Projected working-set durables.
 * @param targetClaimKey - Candidate claim key under review.
 * @param durable - Durable requesting the key assignment.
 * @returns Active siblings whose type differs from the requesting durable.
 */
function findCrossTypeActiveSiblings(projectedDurables: Durable[], targetClaimKey: string, durable: Pick<Durable, "id" | "type">): Durable[] {
  return findActiveClaimKeyOccupants(projectedDurables, targetClaimKey, durable.id).filter((sibling) => sibling.type !== durable.type);
}

/**
 * Returns active cross-type sibling ids occupying the same claim key slot.
 *
 * @param projectedDurables - Projected working-set durables.
 * @param targetClaimKey - Candidate claim key under review.
 * @param durable - Durable requesting the key assignment.
 * @returns Cross-type sibling durable ids.
 */
export function resolveCrossTypeCollisionSiblingIds(projectedDurables: Durable[], targetClaimKey: string, durable: Pick<Durable, "id" | "type">): string[] {
  return findCrossTypeActiveSiblings(projectedDurables, targetClaimKey, durable).map((sibling) => sibling.id);
}

/**
 * Persists a cross-type collision proposal when siblings occupy the target slot.
 *
 * @param ctx - Mutable reconcile pass context.
 * @param targetClaimKey - Candidate claim key under review.
 * @param durable - Durable requesting the key assignment.
 * @param buildInput - Builder that receives expanded collision sibling ids.
 * @returns Whether a collision proposal was persisted.
 */
export async function persistProposalWhenCrossTypeCollision(
  ctx: ReconcilePassContext,
  targetClaimKey: string,
  durable: Pick<Durable, "id" | "type">,
  buildInput: (activeSiblingIds: string[]) => PersistReconcileProposalCallInput,
): Promise<boolean> {
  const activeSiblingIds = resolveCrossTypeCollisionSiblingIds(ctx.workingSet.projectedDurables, targetClaimKey, durable);
  if (activeSiblingIds.length === 0) {
    return false;
  }

  const input = buildInput(activeSiblingIds);
  await persistCrossTypeCollisionProposal(ctx, {
    ...input,
    durableIds: expandCrossTypeCollisionDurableIds(input.durableIds, activeSiblingIds),
  });
  return true;
}
