import { randomUUID } from "node:crypto";

import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type, type Static } from "@sinclair/typebox";

import { validateTemporalValidityRange } from "../../../core/temporal-validity.js";
import type { SurgeonToolDeps } from "./index.js";
import { toolResult } from "./shared.js";

const SET_VALIDITY_SCHEMA = Type.Object({
  entry_id: Type.String({ minLength: 1 }),
  valid_from: Type.Optional(Type.String({ description: "ISO 8601 UTC timestamp for when this fact became true." })),
  valid_to: Type.Optional(Type.String({ description: "ISO 8601 UTC timestamp for when this fact stopped being true." })),
  reasoning: Type.String({ minLength: 1, description: "Why these temporal bounds apply." }),
});

/** Validated parameter payload for the validity-update tool. */
type SetValidityParams = Static<typeof SET_VALIDITY_SCHEMA>;

/**
 * Creates the temporal-validity update tool used by the supersession pass.
 *
 * @param deps - Shared run dependencies for surgeon tools.
 * @returns Agent tool that updates valid_from and valid_to on active entries.
 */
export function createSetValidityTool(deps: SurgeonToolDeps): AgentTool<typeof SET_VALIDITY_SCHEMA> {
  return {
    name: "set_validity",
    label: "Set validity",
    description: "Assign temporal validity bounds to an active entry using ISO 8601 timestamps.",
    parameters: SET_VALIDITY_SCHEMA,
    async execute(_toolCallId, params: SetValidityParams) {
      const entryId = params.entry_id.trim();
      const reasoning = params.reasoning.trim();

      if (reasoning.length === 0) {
        return toolResult({
          success: false,
          dryRun: !deps.apply,
          entryId,
          reason: "Reasoning is required.",
        });
      }

      if (params.valid_from === undefined && params.valid_to === undefined) {
        return toolResult({
          success: false,
          dryRun: !deps.apply,
          entryId,
          reason: "At least one of valid_from or valid_to must be provided.",
        });
      }

      const requestedValidity = validateTemporalValidityRange(params.valid_from, params.valid_to);
      if (!requestedValidity.ok && requestedValidity.code === "invalid_valid_from") {
        return toolResult({
          success: false,
          dryRun: !deps.apply,
          entryId,
          reason: requestedValidity.message,
        });
      }

      if (!requestedValidity.ok && requestedValidity.code === "invalid_valid_to") {
        return toolResult({
          success: false,
          dryRun: !deps.apply,
          entryId,
          reason: requestedValidity.message,
        });
      }

      if (!requestedValidity.ok) {
        return toolResult({
          success: false,
          dryRun: !deps.apply,
          entryId,
          reason: requestedValidity.message,
        });
      }

      const entry = await deps.port.getEntry(entryId);
      if (!entry || entry.retired) {
        return toolResult({
          success: false,
          dryRun: !deps.apply,
          entryId,
          reason: "Entry not found or is no longer active.",
        });
      }

      const mergedValidity = validateTemporalValidityRange(
        params.valid_from !== undefined ? requestedValidity.value.validFrom : entry.valid_from,
        params.valid_to !== undefined ? requestedValidity.value.validTo : entry.valid_to,
      );
      if (!mergedValidity.ok) {
        return toolResult({
          success: false,
          dryRun: !deps.apply,
          entryId: entry.id,
          reason: mergedValidity.message,
        });
      }

      const changes = buildValidityChanges(entry, {
        valid_from: params.valid_from !== undefined ? requestedValidity.value.validFrom : undefined,
        valid_to: params.valid_to !== undefined ? requestedValidity.value.validTo : undefined,
      });

      if (Object.keys(changes).length === 0) {
        return toolResult({
          success: true,
          dryRun: !deps.apply,
          entryId: entry.id,
          updated: false,
          changes,
        });
      }

      if (!deps.apply) {
        return toolResult({
          success: true,
          dryRun: true,
          entryId: entry.id,
          updated: false,
          wouldUpdate: true,
          changes,
        });
      }

      const updated = await deps.port.updateEntry(entry.id, {
        ...(params.valid_from !== undefined ? { valid_from: requestedValidity.value.validFrom } : {}),
        ...(params.valid_to !== undefined ? { valid_to: requestedValidity.value.validTo } : {}),
      });

      if (updated) {
        deps.completionGuards?.supersession.markAdjudicated([entry.id]);
        await deps.recordRunAction({
          id: randomUUID(),
          runId: deps.runId,
          actionType: "update_entry",
          entryIds: [entry.id],
          reasoning,
          recallDelta: null,
          createdAt: deps.now().toISOString(),
        });
      }

      return toolResult({
        success: updated,
        dryRun: false,
        entryId: entry.id,
        updated,
        changes,
      });
    },
  };
}

/**
 * Builds a before/after preview for requested temporal validity changes.
 *
 * @param entry - Current persisted entry values.
 * @param fields - Requested validity updates.
 * @returns Field-by-field preview of effective changes.
 */
function buildValidityChanges(
  entry: {
    valid_from?: string;
    valid_to?: string;
  },
  fields: {
    valid_from?: string;
    valid_to?: string;
  },
): Record<string, { from: string | null; to: string | null }> {
  const changes: Record<string, { from: string | null; to: string | null }> = {};

  if (fields.valid_from !== undefined && entry.valid_from !== fields.valid_from) {
    changes.valid_from = {
      from: entry.valid_from ?? null,
      to: fields.valid_from ?? null,
    };
  }

  if (fields.valid_to !== undefined && entry.valid_to !== fields.valid_to) {
    changes.valid_to = {
      from: entry.valid_to ?? null,
      to: fields.valid_to ?? null,
    };
  }

  return changes;
}
