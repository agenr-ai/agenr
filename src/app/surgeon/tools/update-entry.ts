import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type, type Static } from "@sinclair/typebox";

import { normalizeClaimKey } from "../../../core/claim-key.js";
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
  claim_key: Type.Optional(Type.String({ minLength: 3, description: "Claim key in entity/attribute format." })),
  valid_from: Type.Optional(Type.String({ description: "ISO 8601 timestamp for when this fact became true." })),
  valid_to: Type.Optional(Type.String({ description: "ISO 8601 timestamp for when this fact stopped being true." })),
  reasoning: Type.String({ minLength: 1, description: "Why these changes are appropriate." }),
});

/** Validated parameter payload for the update tool. */
type UpdateEntryParams = Static<typeof UPDATE_ENTRY_SCHEMA>;

/**
 * Creates the entry-update tool used when demotion is better than retirement.
 *
 * @param deps - Shared run dependencies for surgeon tools.
 * @returns Agent tool that updates mutable entry fields with reasoning.
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
          reason:
            "Expiry must be one of: core, permanent, temporary. Claim keys must use entity/attribute format. Validity timestamps must be ISO 8601 and ordered correctly.",
        });
      }

      if (Object.keys(requestedFields).length === 0) {
        throw new Error("update_entry requires at least one mutable field: importance, expiry, claim_key, valid_from, or valid_to.");
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
function buildRequestedFields(params: UpdateEntryParams): {
  importance?: number;
  expiry?: Expiry;
  claim_key?: string;
  valid_from?: string;
  valid_to?: string;
} | null {
  const fields: {
    importance?: number;
    expiry?: Expiry;
    claim_key?: string;
    valid_from?: string;
    valid_to?: string;
  } = {};

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

  if (params.claim_key !== undefined) {
    const claimKey = normalizeClaimKey(params.claim_key);
    if (!claimKey.ok) {
      return null;
    }

    fields.claim_key = claimKey.value.claimKey;
  }

  if (params.valid_from !== undefined) {
    const validFrom = normalizeOptionalTimestamp(params.valid_from);
    if (!validFrom) {
      return null;
    }

    fields.valid_from = validFrom;
  }

  if (params.valid_to !== undefined) {
    const validTo = normalizeOptionalTimestamp(params.valid_to);
    if (!validTo) {
      return null;
    }

    fields.valid_to = validTo;
  }

  if (fields.valid_from && fields.valid_to && Date.parse(fields.valid_from) >= Date.parse(fields.valid_to)) {
    return null;
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
    claim_key?: string;
    valid_from?: string;
    valid_to?: string;
  },
  fields: {
    importance?: number;
    expiry?: Expiry;
    claim_key?: string;
    valid_from?: string;
    valid_to?: string;
  },
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

  if (typeof fields.claim_key === "string" && entry.claim_key !== fields.claim_key) {
    changes.claim_key = {
      from: entry.claim_key ?? "",
      to: fields.claim_key,
    };
  }

  if (typeof fields.valid_from === "string" && entry.valid_from !== fields.valid_from) {
    changes.valid_from = {
      from: entry.valid_from ?? "",
      to: fields.valid_from,
    };
  }

  if (typeof fields.valid_to === "string" && entry.valid_to !== fields.valid_to) {
    changes.valid_to = {
      from: entry.valid_to ?? "",
      to: fields.valid_to,
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

/**
 * Validates and normalizes one ISO 8601 timestamp string.
 *
 * @param value - Raw timestamp input.
 * @returns Trimmed timestamp, or null when invalid.
 */
function normalizeOptionalTimestamp(value: string): string | null {
  const normalized = value.trim();
  if (normalized.length === 0 || !normalized.includes("T") || Number.isNaN(Date.parse(normalized))) {
    return null;
  }

  return normalized;
}
