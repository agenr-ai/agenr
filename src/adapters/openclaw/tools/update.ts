import type { AnyAgentTool } from "openclaw/plugin-sdk/agent-runtime";
import { failedTextResult, readNumberParam, readStringParam, textResult } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawPluginToolContext, PluginLogger } from "openclaw/plugin-sdk/core";

import { normalizeManualClaimKeyUpdate } from "../../../core/claim-key-lifecycle.js";
import { validateTemporalValidityRange } from "../../../core/temporal-validity.js";
import type { AgenrOpenClawServices } from "../types.js";
import {
  UPDATE_EXPIRY_DESCRIPTION,
  asRecord,
  buildToolCallClaimSupport,
  formatTargetSelector,
  logToolCall,
  logToolFailure,
  parseExpiry,
  resolveTargetEntry,
  sanitizeUpdateToolParams,
  toolFailureResult,
} from "./shared.js";

// Keep this schema intentionally flat and unconstrained.
// Runtime validation remains the source of truth for update semantics and allowed values.
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
 * Creates the agenr update tool bound to one OpenClaw session context.
 *
 * @param ctx - Trusted OpenClaw tool context.
 * @param servicesPromise - Shared agenr adapters reused for the process lifetime.
 * @param logger - Host logger supplied by the OpenClaw plugin runtime.
 * @returns Agent tool definition for `agenr_update`.
 */
export function createAgenrUpdateTool(ctx: OpenClawPluginToolContext, servicesPromise: Promise<AgenrOpenClawServices>, logger: PluginLogger): AnyAgentTool {
  return {
    name: "agenr_update",
    label: "Agenr Update",
    description: "Update an existing memory entry in place. Currently supports importance, expiry, claim_key, valid_from, and valid_to.",
    parameters: UPDATE_TOOL_PARAMETERS,
    async execute(_toolCallId, rawParams) {
      try {
        const params = asRecord(rawParams);
        const id = readStringParam(params, "id");
        const subject = readStringParam(params, "subject");
        const importance = readNumberParam(params, "importance", { integer: true, strict: true });
        const expiry = parseExpiry(readStringParam(params, "expiry"));
        const claimKeyInput = readStringParam(params, "claimKey", { trim: false });
        const validFrom = readStringParam(params, "validFrom");
        const validTo = readStringParam(params, "validTo");
        const claimSupportObservedAt = new Date().toISOString();
        const claimSupport = claimKeyInput === undefined ? undefined : buildToolCallClaimSupport(ctx, "agenr_update", claimSupportObservedAt);
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
        logToolCall(
          logger,
          "agenr_update",
          ctx,
          `target=${formatTargetSelector(id, subject)}${importance !== undefined ? ` importance=${importance}` : ""}${expiry !== undefined ? ` expiry=${expiry}` : ""}`,
          sanitizeUpdateToolParams({ id, subject, importance, expiry, claimKey: normalizedClaimKeyUpdate?.claimKey, validFrom, validTo }),
        );
        const services = await servicesPromise;
        const entry = await resolveTargetEntry(services, params);

        if (importance === undefined && expiry === undefined && normalizedClaimKeyUpdate === undefined && validFrom === undefined && validTo === undefined) {
          throw new Error("Provide at least one update field: importance, expiry, claimKey, validFrom, or validTo.");
        }

        const mergedValidity = validateTemporalValidityRange(validFrom ?? entry.valid_from, validTo ?? entry.valid_to);
        if (!mergedValidity.ok) {
          throw new Error(mergedValidity.message);
        }

        const normalizedValidFrom = validFrom !== undefined ? mergedValidity.value.validFrom : undefined;
        const normalizedValidTo = validTo !== undefined ? mergedValidity.value.validTo : undefined;

        const updated = await services.entries.updateEntry(entry.id, {
          ...(importance !== undefined ? { importance } : {}),
          ...(expiry !== undefined ? { expiry } : {}),
          ...(normalizedClaimKeyUpdate?.updateFields ?? {}),
          ...(validFrom !== undefined ? { valid_from: normalizedValidFrom } : {}),
          ...(validTo !== undefined ? { valid_to: normalizedValidTo } : {}),
        });

        if (!updated) {
          return failedTextResult(`Entry ${entry.id} is not active, so it could not be updated.`, {
            status: "failed",
            entryId: entry.id,
          });
        }

        return textResult(`Updated "${entry.subject}".`, {
          status: "updated",
          entryId: entry.id,
          subject: entry.subject,
          sessionKey: ctx.sessionKey,
          ...(importance !== undefined ? { importance } : {}),
          ...(expiry !== undefined ? { expiry } : {}),
          ...(normalizedClaimKeyUpdate !== undefined ? { claimKey: normalizedClaimKeyUpdate.claimKey } : {}),
          ...(validFrom !== undefined ? { validFrom: normalizedValidFrom } : {}),
          ...(validTo !== undefined ? { validTo: normalizedValidTo } : {}),
        });
      } catch (error) {
        logToolFailure(logger, "agenr_update", ctx, error);
        return toolFailureResult(error);
      }
    },
  };
}
