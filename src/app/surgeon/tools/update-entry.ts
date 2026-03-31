import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type, type Static } from "@sinclair/typebox";

import { EXPIRY_LEVELS, type Expiry } from "../../../core/types.js";
import type { SurgeonToolDeps } from "./index.js";
import { toolResult } from "./shared.js";

const UPDATE_ENTRY_SCHEMA = Type.Object({
  entry_id: Type.String({ minLength: 1 }),
  importance: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
  expiry: Type.Optional(
    Type.String({
      description: "New expiry: 'core', 'permanent', or 'temporary'",
    }),
  ),
  reasoning: Type.String({ minLength: 1, description: "Why these changes are appropriate." }),
});

/** Validated parameter payload for the update tool. */
type UpdateEntryParams = Static<typeof UPDATE_ENTRY_SCHEMA>;

/**
 * Creates the entry-update tool used when demotion is better than retirement.
 *
 * @param deps - Shared run dependencies for surgeon tools.
 * @returns Agent tool that updates importance and/or expiry with reasoning.
 */
export function createUpdateEntryTool(deps: SurgeonToolDeps): AgentTool<typeof UPDATE_ENTRY_SCHEMA> {
  return {
    name: "update_entry",
    label: "Update entry",
    description: "Update entry importance and/or expiry with explicit reasoning. Respects dry-run mode.",
    parameters: UPDATE_ENTRY_SCHEMA,
    async execute(_toolCallId, params: UpdateEntryParams) {
      const reasoning = params.reasoning.trim();
      if (reasoning.length === 0) {
        return toolResult({
          success: false,
          dryRun: !deps.apply,
          entryId: params.entry_id,
          reason: "Reasoning is required.",
        });
      }

      const requestedFields = buildRequestedFields(params);
      if (requestedFields === null) {
        return toolResult({
          success: false,
          dryRun: !deps.apply,
          entryId: params.entry_id,
          reason: "Expiry must be one of: core, permanent, temporary.",
        });
      }

      if (Object.keys(requestedFields).length === 0) {
        throw new Error("update_entry requires at least one mutable field: importance or expiry.");
      }

      if (requestedFields.expiry === "core" && !hasExplicitCoreAcknowledgement(reasoning)) {
        return toolResult({
          success: false,
          dryRun: !deps.apply,
          entryId: params.entry_id,
          reason: "Changing expiry to core requires reasoning that explicitly mentions core.",
        });
      }

      const entry = await deps.port.getEntry(params.entry_id);
      if (!entry || entry.retired) {
        return toolResult({
          success: false,
          dryRun: !deps.apply,
          entryId: params.entry_id,
          reason: "Entry not found or is no longer active.",
        });
      }

      const changes = buildChanges(entry, requestedFields);
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

      const updated = await deps.port.updateEntry(entry.id, requestedFields);
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
 * Builds the requested field mutation set from validated tool params.
 *
 * @param params - Validated update-tool parameters.
 * @returns Mutable entry fields, or null when expiry is invalid.
 */
function buildRequestedFields(params: UpdateEntryParams): { importance?: number; expiry?: Expiry } | null {
  const fields: { importance?: number; expiry?: Expiry } = {};

  if (typeof params.importance === "number") {
    fields.importance = clampImportance(params.importance);
  }

  const expiry = normalizeExpiry(params.expiry);
  if (expiry === null) {
    return null;
  }

  if (expiry !== undefined) {
    fields.expiry = expiry;
  }

  return fields;
}

/**
 * Normalizes optional expiry input into a supported expiry level.
 *
 * @param value - Raw expiry input.
 * @returns Expiry value, undefined when absent, or null when invalid.
 */
function normalizeExpiry(value: string | undefined): Expiry | undefined | null {
  const normalized = value?.trim();
  if (!normalized) {
    return undefined;
  }

  if ((EXPIRY_LEVELS as readonly string[]).includes(normalized)) {
    return normalized as Expiry;
  }

  return null;
}

/**
 * Clamps importance to the supported 1-10 range.
 *
 * @param value - Raw importance input.
 * @returns Rounded importance within the supported range.
 */
function clampImportance(value: number): number {
  return Math.max(1, Math.min(10, Math.round(value)));
}

/**
 * Computes a before/after preview for the requested field changes.
 *
 * @param entry - Current persisted entry values.
 * @param fields - Requested field changes.
 * @returns Field-by-field preview of effective changes.
 */
function buildChanges(
  entry: {
    importance: number;
    expiry: Expiry;
  },
  fields: { importance?: number; expiry?: Expiry },
): Record<string, { from: number | string; to: number | string }> {
  const changes: Record<string, { from: number | string; to: number | string }> = {};

  if (typeof fields.importance === "number" && entry.importance !== fields.importance) {
    changes.importance = {
      from: entry.importance,
      to: fields.importance,
    };
  }

  if (typeof fields.expiry === "string" && entry.expiry !== fields.expiry) {
    changes.expiry = {
      from: entry.expiry,
      to: fields.expiry,
    };
  }

  return changes;
}

/**
 * Checks whether the reasoning explicitly acknowledges a core promotion.
 *
 * @param reasoning - Model-provided rationale for the update.
 * @returns True when the reasoning explicitly mentions core.
 */
function hasExplicitCoreAcknowledgement(reasoning: string): boolean {
  return /\bcore\b/i.test(reasoning);
}
