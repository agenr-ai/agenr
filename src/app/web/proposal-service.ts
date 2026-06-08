import { createDreamPort } from "../../adapters/db/dreaming-port.js";
import type { Durable } from "../../core/types.js";
import type { DreamRunProposal } from "../../core/dreaming/types.js";
import { loadDreamBacklogRuntime, reviewDreamProposalRuntime, type DreamProposalReviewResult } from "../dreaming/runtime.js";
import type { DreamProposalBacklogItem, DreamProposalBacklogQuery } from "../dreaming/ports.js";
import { withInstanceDatabase, type WebInstanceContext } from "./instance-context.js";

/** Backlog query accepted by the web proposal service. */
export type WebProposalBacklogQuery = DreamProposalBacklogQuery;

/**
 * Detail view for one proposal with its affected durables hydrated.
 */
export interface WebProposalDetail {
  /** The proposal record. */
  proposal: DreamRunProposal;
  /** Currently active durables referenced by the proposal. */
  activeDurables: Durable[];
  /** Referenced durable ids that are missing or no longer active. */
  inactiveDurableIds: string[];
  /** Audit details from the flag_review action that staged this proposal. */
  stagingDetails: Record<string, unknown> | null;
}

/**
 * Loads the proposal backlog for the selected instance.
 *
 * @param input - Backlog query, instance context, and environment.
 * @returns Backlog rows matching every requested filter.
 */
export async function loadWebProposalBacklog(
  input: WebProposalBacklogQuery & { context: WebInstanceContext; env?: NodeJS.ProcessEnv },
): Promise<DreamProposalBacklogItem[]> {
  return loadDreamBacklogRuntime({ ...input, state: input.state ?? "open", dbPath: input.context.dbPath });
}

/**
 * Loads a single proposal with its affected durables for the detail panel.
 *
 * @param input - Proposal id, instance context, and environment.
 * @returns Proposal detail, or null when the proposal is unknown.
 */
export async function loadWebProposalDetail(input: { proposalId: string; context: WebInstanceContext; env?: NodeJS.ProcessEnv }): Promise<WebProposalDetail | null> {
  return withInstanceDatabase(input.context, async (database) => {
    const port = createDreamPort(database);
    const proposal = await port.getProposal(input.proposalId);
    if (!proposal) {
      return null;
    }

    const durables = await port.getDurables(proposal.durableIds);
    const foundIds = new Set(durables.map((durable) => durable.id));
    const inactiveDurableIds = proposal.durableIds.filter((id) => !foundIds.has(id));
    const stagingDetails = await port.getProposalStagingActionDetails(proposal.id);

    return { proposal, activeDurables: durables, inactiveDurableIds, stagingDetails };
  });
}

/**
 * Applies or rejects one open proposal through the shared review runtime.
 *
 * Applying creates a database backup first and reuses the claim-key mutation
 * path; a non-empty reason is required for either decision.
 *
 * @param input - Proposal id, decision, reason, and instance binding.
 * @returns Final proposal state plus affected durables and backup path.
 * @throws Error When the reason is empty.
 */
export async function reviewWebProposal(input: {
  proposalId: string;
  decision: "apply" | "reject";
  reason: string;
  context: WebInstanceContext;
  env?: NodeJS.ProcessEnv;
}): Promise<DreamProposalReviewResult> {
  const reason = input.reason.trim();
  if (reason.length === 0) {
    throw new Error("A non-empty review reason is required.");
  }

  return reviewDreamProposalRuntime({ ...input, dbPath: input.context.dbPath, reason });
}
