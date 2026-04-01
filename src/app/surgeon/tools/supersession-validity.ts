import { randomUUID } from "node:crypto";

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type, type Static } from "@sinclair/typebox";

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
      const validFrom = normalizeOptionalTimestamp(params.valid_from);
      const validTo = normalizeOptionalTimestamp(params.valid_to);

      if (reasoning.length === 0) {
        return toolResult({
          success: false,
          dryRun: !deps.apply,
          entryId,
          reason: "Reasoning is required.",
        });
      }

      if (validFrom === undefined && validTo === undefined) {
        return toolResult({
          success: false,
          dryRun: !deps.apply,
          entryId,
          reason: "At least one of valid_from or valid_to must be provided.",
        });
      }

      if (params.valid_from !== undefined && validFrom === null) {
        return toolResult({
          success: false,
          dryRun: !deps.apply,
          entryId,
          reason: "valid_from must be a valid ISO 8601 timestamp.",
        });
      }

      if (params.valid_to !== undefined && validTo === null) {
        return toolResult({
          success: false,
          dryRun: !deps.apply,
          entryId,
          reason: "valid_to must be a valid ISO 8601 timestamp.",
        });
      }

      if (validFrom && validTo && Date.parse(validFrom) >= Date.parse(validTo)) {
        return toolResult({
          success: false,
          dryRun: !deps.apply,
          entryId,
          reason: "valid_from must be earlier than valid_to.",
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

      const changes = buildValidityChanges(entry, {
        valid_from: validFrom ?? undefined,
        valid_to: validTo ?? undefined,
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
        ...(validFrom !== undefined ? { valid_from: validFrom ?? undefined } : {}),
        ...(validTo !== undefined ? { valid_to: validTo ?? undefined } : {}),
      });

      if (updated) {
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
 * Validates and normalizes one optional ISO 8601 timestamp.
 *
 * @param value - Raw timestamp input.
 * @returns Trimmed timestamp, null when invalid, or undefined when absent.
 */
function normalizeOptionalTimestamp(value: string | undefined): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }

  const normalized = value.trim();
  if (normalized.length === 0 || !normalized.includes("T") || Number.isNaN(Date.parse(normalized))) {
    return null;
  }

  return normalized;
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
