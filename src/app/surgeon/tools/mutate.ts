import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type, type Static } from "@sinclair/typebox";

import type { SurgeonRunAction } from "../../../core/surgeon/domain/action-types.js";
import { isProtectedFromRetirement } from "../../../core/surgeon/domain/protection-rules.js";
import type { SurgeonToolDeps } from "./index.js";
import { toolResult } from "./shared.js";

const RETIRE_ENTRY_SCHEMA = Type.Object({
  entry_id: Type.String({ minLength: 1 }),
  reason: Type.String({ minLength: 1 }),
});

/** Validated parameter payload for the retire tool. */
type RetireEntryParams = Static<typeof RETIRE_ENTRY_SCHEMA>;

/** Same-run actions that suppress a later contradictory retirement decision. */
type RetirementSuppressionAction = SurgeonRunAction & {
  actionType: "skip" | "retire" | "update_entry";
};

/**
 * Creates the retirement mutation tool.
 *
 * @param deps - Shared run dependencies for surgeon tools.
 * @returns Agent tool that retires one entry after hard protection checks.
 */
export function createRetireEntryTool(deps: SurgeonToolDeps): AgentTool<typeof RETIRE_ENTRY_SCHEMA> {
  return {
    name: "retire_entry",
    label: "Retire entry",
    description: "Retire a single entry after checking hard retirement protections. Respects dry-run mode.",
    parameters: RETIRE_ENTRY_SCHEMA,
    async execute(_toolCallId, params: RetireEntryParams) {
      const priorRunAction = await findPriorSameRunRetirementSuppression(deps, params.entry_id);
      if (priorRunAction) {
        return toolResult({
          success: false,
          dryRun: !deps.apply,
          entryId: params.entry_id.trim(),
          reason: describePriorSameRunRetirementSuppression(priorRunAction),
        });
      }

      const entry = await deps.port.getEntry(params.entry_id);
      if (!entry) {
        return toolResult({
          success: false,
          dryRun: !deps.apply,
          entryId: params.entry_id,
          reason: "Entry not found.",
        });
      }

      const protection = isProtectedFromRetirement(
        {
          expiry: entry.expiry,
          importance: entry.importance,
          lastRecalledAt: entry.last_recalled_at,
        },
        {
          now: deps.now(),
          protectRecalledDays: deps.protection.protectRecalledDays,
          protectMinImportance: deps.protection.protectMinImportance,
        },
      );

      if (protection.protected) {
        return toolResult({
          success: false,
          dryRun: !deps.apply,
          entryId: entry.id,
          protected: true,
          reason: protection.reason,
        });
      }

      if (!deps.apply) {
        return toolResult({
          success: true,
          dryRun: true,
          entryId: entry.id,
          wouldRetire: true,
          reason: params.reason.trim(),
        });
      }

      const retired = await deps.port.retireEntry(entry.id, params.reason.trim());
      return toolResult({
        success: retired,
        dryRun: false,
        entryId: entry.id,
        retired,
        retiredCount: retired ? 1 : 0,
        reason: params.reason.trim(),
      });
    },
  };
}

/**
 * Resolves whether the current run has already adjudicated the entry in a way
 * that should suppress a later retirement attempt.
 *
 * @param deps - Shared run dependencies for surgeon tools.
 * @param entryId - Candidate entry identifier.
 * @returns Prior same-run action when retirement should be blocked, otherwise null.
 */
async function findPriorSameRunRetirementSuppression(deps: SurgeonToolDeps, entryId: string): Promise<RetirementSuppressionAction | null> {
  const normalizedEntryId = entryId.trim();
  if (normalizedEntryId.length === 0) {
    return null;
  }

  const actions = await deps.port.getRunActions(deps.runId);
  return (
    actions.find(
      (action): action is RetirementSuppressionAction =>
        (action.actionType === "skip" || action.actionType === "retire" || action.actionType === "update_entry") && action.entryIds.includes(normalizedEntryId),
    ) ?? null
  );
}

/**
 * Formats the same-run suppression reason returned by `retire_entry`.
 *
 * @param action - Prior same-run action touching the entry.
 * @returns User-facing rejection reason.
 */
function describePriorSameRunRetirementSuppression(action: RetirementSuppressionAction): string {
  if (action.actionType === "skip") {
    return "Entry was already skipped earlier in this run and cannot be retired in the same run.";
  }

  if (action.actionType === "retire") {
    return "Entry was already retired earlier in this run.";
  }

  return "Entry was already updated earlier in this run and cannot be retired in the same run.";
}
