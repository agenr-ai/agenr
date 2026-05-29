import { randomUUID } from "node:crypto";

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type, type Static } from "@sinclair/typebox";

import { describeSupersessionRuleFailure, validateSupersessionRules } from "../../../core/supersession.js";
import type { Entry, SupersessionKind } from "../../../core/types.js";
import type { SurgeonToolDeps } from "./index.js";
import { toolResult } from "./shared.js";

const LINK_SUPERSESSION_SCHEMA = Type.Object({
  old_entry_id: Type.String({ minLength: 1, description: "Entry being superseded." }),
  new_entry_id: Type.String({ minLength: 1, description: "Entry that supersedes." }),
  kind: Type.String({
    description: "Supersession kind: 'update', 'correction', 'refinement', or 'duplicate'.",
  }),
  reason: Type.String({ minLength: 1, description: "Explanation of why old_entry is superseded by new_entry." }),
});

const LINKABLE_SUPERSESSION_KINDS = ["update", "correction", "refinement", "duplicate"] as const;

/** Validated parameter payload for the supersession-link tool. */
type LinkSupersessionParams = Static<typeof LINK_SUPERSESSION_SCHEMA>;

/**
 * Creates the supersession-link mutation tool.
 *
 * @param deps - Shared run dependencies for surgeon tools.
 * @returns Agent tool that links an older entry to its active replacement.
 */
export function createLinkSupersessionTool(deps: SurgeonToolDeps): AgentTool<typeof LINK_SUPERSESSION_SCHEMA> {
  return {
    name: "link_supersession",
    label: "Link supersession",
    description: "Create a supersession link from an older active entry to the newer active entry that replaces it.",
    parameters: LINK_SUPERSESSION_SCHEMA,
    async execute(_toolCallId, params: LinkSupersessionParams) {
      const oldEntryId = params.old_entry_id.trim();
      const newEntryId = params.new_entry_id.trim();
      const reason = params.reason.trim();
      const kind = normalizeKind(params.kind);

      if (oldEntryId.length === 0 || newEntryId.length === 0) {
        return toolResult({
          success: false,
          dryRun: !deps.apply,
          reason: "Both entry IDs are required.",
        });
      }

      if (oldEntryId === newEntryId) {
        return toolResult({
          success: false,
          dryRun: !deps.apply,
          oldEntryId,
          newEntryId,
          reason: "An entry cannot supersede itself.",
        });
      }

      if (!kind) {
        return toolResult({
          success: false,
          dryRun: !deps.apply,
          oldEntryId,
          newEntryId,
          reason: "Supersession kind must be one of: update, correction, refinement, duplicate.",
        });
      }

      const [oldInspection, newInspection] = await Promise.all([deps.port.inspectEntry(oldEntryId), deps.port.inspectEntry(newEntryId)]);
      const oldEntry = oldInspection?.entry ?? null;
      const newEntry = newInspection?.entry ?? null;

      if (!oldEntry) {
        return toolResult({
          success: false,
          dryRun: !deps.apply,
          oldEntryId,
          newEntryId,
          reason: "Old entry not found.",
        });
      }

      if (!newEntry) {
        return toolResult({
          success: false,
          dryRun: !deps.apply,
          oldEntryId,
          newEntryId,
          reason: "New entry not found.",
        });
      }

      const activityError = validateSupersessionActivity(oldEntry, newEntry);
      if (activityError) {
        return toolResult({
          success: false,
          dryRun: !deps.apply,
          oldEntryId,
          newEntryId,
          reason: activityError,
        });
      }

      const ruleError = validateSupersessionRulesForLink(oldEntry, newEntry);
      if (ruleError) {
        return toolResult({
          success: false,
          dryRun: !deps.apply,
          oldEntryId,
          newEntryId,
          reason: ruleError,
        });
      }

      if (!deps.apply) {
        return toolResult({
          success: true,
          dryRun: true,
          oldEntryId,
          newEntryId,
          wouldSupersede: true,
          kind,
          reason,
        });
      }

      const superseded = await deps.port.supersedeEntry(oldEntryId, newEntryId, kind, reason);
      if (!superseded) {
        return toolResult({
          success: false,
          dryRun: false,
          oldEntryId,
          newEntryId,
          reason: "Supersession link could not be persisted because one of the entries is no longer active.",
        });
      }

      deps.completionGuards?.supersession.markAdjudicated([oldEntryId, newEntryId]);
      await deps.recordRunAction({
        id: randomUUID(),
        runId: deps.runId,
        actionType: "resolve_conflict",
        entryIds: [oldEntryId, newEntryId],
        reasoning: reason,
        recallDelta: null,
        createdAt: deps.now().toISOString(),
      });

      return toolResult({
        success: true,
        dryRun: false,
        oldEntryId,
        newEntryId,
        superseded: true,
        kind,
        reason,
      });
    },
  };
}

/**
 * Validates whether both entries are still eligible for an active supersession link.
 *
 * @param oldEntry - Older entry being superseded.
 * @param newEntry - Replacement entry.
 * @returns Error string when either entry is inactive, otherwise null.
 */
function validateSupersessionActivity(oldEntry: Entry, newEntry: Entry): string | null {
  if (oldEntry.superseded_by) {
    return "The old entry is already superseded.";
  }

  if (oldEntry.retired) {
    return "The old entry is retired and cannot be superseded.";
  }

  if (newEntry.retired || newEntry.superseded_by) {
    return "The new entry is no longer active.";
  }

  return null;
}

/**
 * Enforces the hard supersession rules applied by the mutation tool.
 *
 * @param oldEntry - Older entry being superseded.
 * @param newEntry - Replacement entry.
 * @returns Error string when a hard rule blocks the link, otherwise null.
 */
function validateSupersessionRulesForLink(oldEntry: Entry, newEntry: Entry): string | null {
  const result = validateSupersessionRules(oldEntry, newEntry);
  return result.ok ? null : describeSupersessionRuleFailure(result.reason);
}

/**
 * Validates and narrows the requested supersession kind.
 *
 * @param value - Raw kind input.
 * @returns Supported supersession kind, or null when invalid.
 */
function normalizeKind(value: string): Extract<SupersessionKind, (typeof LINKABLE_SUPERSESSION_KINDS)[number]> | null {
  const normalized = value.trim().toLowerCase();
  return (LINKABLE_SUPERSESSION_KINDS as readonly string[]).includes(normalized)
    ? (normalized as Extract<SupersessionKind, (typeof LINKABLE_SUPERSESSION_KINDS)[number]>)
    : null;
}
