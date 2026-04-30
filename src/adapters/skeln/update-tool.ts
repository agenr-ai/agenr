import { normalizeManualClaimKeyUpdate } from "../../core/claim-key-lifecycle.js";
import { validateTemporalValidityRange } from "../../core/temporal-validity.js";
import type { EntryUpdateInput } from "../../core/types.js";
import { buildToolCallClaimSupport } from "../shared/claim-support.js";
import { UPDATE_EXPIRY_DESCRIPTION, asRecord, formatErrorMessage, parseExpiry } from "../shared/entry-tools.js";
import { resolveTargetEntry } from "../shared/resolve-target.js";
import type { AgenrSkelnServices, SkelnApprovalTargetLike, SkelnToolContextLike, SkelnToolLike, SkelnToolResultLike } from "./types.js";

const UPDATE_TOOL_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: {
      type: "string",
      description: "Entry id to update. Provide exactly one of id or subject.",
    },
    subject: {
      type: "string",
      description: "Subject text to resolve when the id is unknown. The most recent exact or substring match wins. Provide exactly one of id or subject.",
    },
    importance: {
      type: "integer",
      description: "New importance from 1 to 10. Use 7 for normal durable memory and reserve 9 to 10 for rare critical entries.",
    },
    expiry: {
      type: "string",
      description: UPDATE_EXPIRY_DESCRIPTION,
    },
    claimKey: {
      type: "string",
      description:
        'Slot key identifying the specific knowledge slot (entity/attribute format, e.g., "project_name/deploy_strategy" or "postgres/max_connections"). Entries with the same claim key are candidates for supersession.',
    },
    validFrom: {
      type: "string",
      description: "ISO 8601 timestamp for when this fact became true.",
    },
    validTo: {
      type: "string",
      description: "ISO 8601 timestamp for when this fact stopped being true.",
    },
  },
} as const;

/**
 * Structured success details returned by `agenr_update`.
 */
export interface AgenrSkelnUpdateDetails {
  /** Result status. */
  status: "updated";
  /** Updated entry id. */
  entryId: string;
  /** Updated entry subject. */
  subject: string;
  /** Stable Skeln memory session key when present. */
  sessionKey?: string;
  /** Updated importance value when provided. */
  importance?: number;
  /** Updated expiry bucket when provided. */
  expiry?: string;
  /** Updated canonical claim key when provided. */
  claimKey?: string;
  /** Updated lower temporal bound when provided. */
  validFrom?: string;
  /** Updated upper temporal bound when provided. */
  validTo?: string;
}

/**
 * Structured failure details returned by `agenr_update`.
 */
export type AgenrSkelnUpdateFailureDetails =
  | {
      /** Failed update status. */
      status: "failed";
      /** Entry id that could not be updated. */
      entryId: string;
    }
  | {
      /** Failure message. */
      error: string;
    };

/**
 * Creates the write-capable agenr update tool for a Skeln tool context.
 *
 * @param context - Skeln-like tool context.
 * @param services - Lazily resolves agenr services.
 * @returns Skeln-compatible update tool.
 */
export function createAgenrUpdateTool(
  context: SkelnToolContextLike,
  services: () => Promise<AgenrSkelnServices>,
): SkelnToolLike<AgenrSkelnUpdateDetails | AgenrSkelnUpdateFailureDetails> {
  return {
    name: "agenr_update",
    label: "Agenr Update",
    category: "memory",
    risk: "write",
    /**
     * Compatibility default only. Skeln should override this from its config.
     */
    approval: "manual",
    approvalTarget: updateApprovalTarget,
    description: "Update an existing memory entry in place. Currently supports importance, expiry, claim_key, valid_from, and valid_to.",
    parameters: UPDATE_TOOL_PARAMETERS,
    async execute(_toolCallId: string, rawParams: unknown): Promise<SkelnToolResultLike<AgenrSkelnUpdateDetails | AgenrSkelnUpdateFailureDetails>> {
      try {
        const params = asRecord(rawParams);
        const importance = readOptionalInteger(params, "importance");
        const expiry = parseExpiry(readOptionalString(params, "expiry"));
        const claimKeyInput = readOptionalString(params, "claimKey", { trim: false });
        const validFrom = readOptionalString(params, "validFrom");
        const validTo = readOptionalString(params, "validTo");
        const now = new Date().toISOString();
        const claimSupport = claimKeyInput === undefined ? undefined : buildToolCallClaimSupport(context, "skeln-session", "agenr_update", now);
        const normalizedClaimKeyUpdate =
          claimKeyInput === undefined
            ? undefined
            : (() => {
                try {
                  return normalizeManualClaimKeyUpdate({
                    claimKey: claimKeyInput,
                    rawClaimKey: claimKeyInput,
                    supportSourceKind: claimSupport?.claim_support_source_kind,
                    supportLocator: claimSupport?.claim_support_locator,
                    supportObservedAt: claimSupport?.claim_support_observed_at,
                    supportMode: claimSupport?.claim_support_mode,
                  });
                } catch {
                  throw new Error("claimKey must use canonical entity/attribute format.");
                }
              })();

        if (importance === undefined && expiry === undefined && normalizedClaimKeyUpdate === undefined && validFrom === undefined && validTo === undefined) {
          throw new Error("Provide at least one update field: importance, expiry, claimKey, validFrom, or validTo.");
        }

        const resolvedServices = await services();
        const entry = await resolveTargetEntry(
          {
            getEntryById: async (entryId) =>
              (await resolvedServices.entries.getEntry(entryId)) ?? (await resolvedServices.memory.getEntryTrace(entryId))?.entry ?? null,
            findEntryBySubject: async (entrySubject) => resolvedServices.memory.findEntryBySubject(entrySubject),
            findMostRecentEntry: async () => resolvedServices.memory.findMostRecentEntry(),
          },
          params,
        );
        const mergedValidity = validateTemporalValidityRange(validFrom ?? entry.valid_from, validTo ?? entry.valid_to);
        if (!mergedValidity.ok) {
          throw new Error(mergedValidity.message);
        }

        const normalizedValidFrom = validFrom !== undefined ? mergedValidity.value.validFrom : undefined;
        const normalizedValidTo = validTo !== undefined ? mergedValidity.value.validTo : undefined;
        const fields: EntryUpdateInput = {
          ...(importance !== undefined ? { importance } : {}),
          ...(expiry !== undefined ? { expiry } : {}),
          ...(normalizedClaimKeyUpdate?.updateFields ?? {}),
          ...(validFrom !== undefined ? { valid_from: normalizedValidFrom } : {}),
          ...(validTo !== undefined ? { valid_to: normalizedValidTo } : {}),
        };
        const updated = await resolvedServices.entries.updateEntry(entry.id, fields);

        if (!updated) {
          return {
            content: [{ type: "text", text: `Entry ${entry.id} is not active, so it could not be updated.` }],
            details: { status: "failed", entryId: entry.id },
            isError: true,
          };
        }

        return {
          content: [{ type: "text", text: `Updated "${entry.subject}".` }],
          details: {
            status: "updated",
            entryId: entry.id,
            subject: entry.subject,
            ...(context.sessionKey ? { sessionKey: context.sessionKey } : {}),
            ...(importance !== undefined ? { importance } : {}),
            ...(expiry !== undefined ? { expiry } : {}),
            ...(normalizedClaimKeyUpdate !== undefined ? { claimKey: normalizedClaimKeyUpdate.claimKey } : {}),
            ...(validFrom !== undefined ? { validFrom: normalizedValidFrom } : {}),
            ...(validTo !== undefined ? { validTo: normalizedValidTo } : {}),
          },
          isError: false,
        };
      } catch (error) {
        const message = formatErrorMessage(error);
        return {
          content: [{ type: "text", text: `agenr_update failed: ${message}` }],
          details: { error: message },
          isError: true,
        };
      }
    },
  };
}

/**
 * Extracts the update target Skeln can display for approval.
 */
function updateApprovalTarget(args: unknown): SkelnApprovalTargetLike {
  try {
    const params = asRecord(args);
    return { target: readOptionalString(params, "id") ?? readOptionalString(params, "subject") ?? "agenr update" };
  } catch {
    return { target: "agenr update" };
  }
}

/**
 * Reads one optional string parameter.
 */
function readOptionalString(params: Record<string, unknown>, key: string, options: { trim?: boolean } = {}): string | undefined {
  const value = params[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`Parameter "${key}" must be a string.`);
  }
  const normalized = options.trim === false ? value : value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

/**
 * Reads one optional integer parameter.
 */
function readOptionalInteger(params: Record<string, unknown>, key: string): number | undefined {
  const value = params[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`Parameter "${key}" must be an integer.`);
  }
  return value;
}
