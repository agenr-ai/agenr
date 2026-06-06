import { randomUUID } from "node:crypto";

import {
  buildReconcileProposalClaimKeyLifecycle as buildProposalClaimKeyLifecycle,
  buildReconcileProposalLifecycleRationale as buildProposalLifecycleRationale,
} from "../../../../core/claim-key-lifecycle.js";
import type { ReconcilePassContext } from "../pass-context.js";
import type { PersistReconcileProposalInput } from "../types/mutation-types.js";
import { resolveFlagAmbiguousProposal } from "./ambiguous-proposal.js";
import { buildProposalClaimKeyActionDetails } from "./audit.js";
import { createProposal } from "./proposal.js";
import { normalizeStringArray } from "./utils.js";

/**
 * Persist call input with optional post-persist telemetry hooks.
 */
export interface PersistReconcileProposalCallInput extends PersistReconcileProposalInput {
  onPersisted?: (ctx: ReconcilePassContext) => void;
}

/**
 * Persists one reconcile proposal, bumps shared counters, and runs optional post-persist hooks.
 *
 * @param ctx - Mutable reconcile pass context.
 * @param input - Proposal payload and lifecycle metadata.
 */
export async function persistReconcileProposal(ctx: ReconcilePassContext, input: PersistReconcileProposalCallInput): Promise<void> {
  const proposalLifecycle = buildProposalClaimKeyLifecycle(input.lifecycle);
  const proposal = createProposal({
    runId: ctx.options.runId,
    groupId: input.groupId,
    issueKind: input.issueKind,
    scope: input.scope,
    durableIds: input.durableIds,
    currentClaimKeys: input.currentClaimKeys,
    proposedClaimKeys: input.proposedClaimKeys,
    rationale: buildProposalLifecycleRationale(input.rationale, proposalLifecycle),
    confidence: input.confidence,
    source: input.source,
    eligibleForApply: input.eligibleForApply,
    createdAt: ctx.options.now().toISOString(),
  });

  await ctx.deps.port.logRunProposal(proposal);
  await ctx.deps.port.logRunAction({
    id: randomUUID(),
    runId: ctx.options.runId,
    actionType: "flag_review",
    durableIds: proposal.durableIds,
    reasoning: proposal.rationale,
    details: buildProposalClaimKeyActionDetails(proposal, {
      proposalLifecycle,
      ...input.audit,
    }),
    createdAt: proposal.createdAt,
  });
  ctx.telemetry.actionsTaken += 1;
  ctx.telemetry.counts.proposalsEmitted += 1;
  if (resolveFlagAmbiguousProposal(input.issueKind, input.flagAmbiguousProposal)) {
    ctx.telemetry.counts.flaggedAmbiguousProposals += 1;
  }
  input.onPersisted?.(ctx);
}

/**
 * Persists one cross-type collision proposal with shared collision audit metadata.
 *
 * @param ctx - Mutable reconcile pass context.
 * @param input - Proposal payload plus collision-specific durable expansion.
 */
export async function persistCrossTypeCollisionProposal(ctx: ReconcilePassContext, input: PersistReconcileProposalCallInput): Promise<void> {
  await persistReconcileProposal(ctx, {
    ...input,
    durableIds: normalizeStringArray(input.durableIds),
    audit: {
      autoApplyBlocker: "cross_type_collision",
      ...input.audit,
    },
  });
}

/**
 * Expands durable ids for one cross-type collision proposal.
 *
 * @param durableIds - Primary durable ids implicated in the proposal.
 * @param activeSiblingIds - Cross-type sibling ids occupying the same slot.
 * @returns Normalized durable id list including collision siblings.
 */
export function expandCrossTypeCollisionDurableIds(durableIds: string[], activeSiblingIds: string[]): string[] {
  return normalizeStringArray([...durableIds, ...activeSiblingIds]);
}

/**
 * Appends the standard cross-type collision suffix to a proposal rationale.
 *
 * @param rationale - Base rationale before collision context.
 * @param targetClaimKey - Claim key that collides across durable types.
 * @returns Rationale including collision explanation.
 */
export function appendCrossTypeCollisionRationaleSuffix(rationale: string, targetClaimKey: string): string {
  return `${rationale} The same slot key is already used by a different durable type in the matched working set at "${targetClaimKey}".`;
}
