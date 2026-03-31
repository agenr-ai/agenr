import type { AnyAgentTool } from "openclaw/plugin-sdk/agent-runtime";
import { failedTextResult, readNumberParam, readStringArrayParam, readStringParam, textResult } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawPluginToolContext, PluginLogger } from "openclaw/plugin-sdk/core";

import { storeEntriesDetailed } from "../../../core/store/pipeline.js";
import { ENTRY_TYPES } from "../../../core/types.js";
import type { AgenrOpenClawServices } from "../types.js";
import {
  ENTRY_TYPE_DESCRIPTION,
  EXPIRY_DESCRIPTION,
  asRecord,
  buildSessionSourceFile,
  logToolCall,
  logToolFailure,
  normalizeStringArray,
  parseEntryType,
  parseExpiry,
  sanitizeStoreToolParams,
  toolFailureResult,
} from "./shared.js";

const STORE_TOOL_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {
    type: {
      type: "string",
      enum: [...ENTRY_TYPES],
      description: ENTRY_TYPE_DESCRIPTION,
    },
    subject: {
      type: "string",
      description: "Short subject line future recall can match. Name the decision, preference, person, system, or risk directly.",
    },
    content: {
      type: "string",
      description: "What a fresh session should remember. Store the durable takeaway, not a transient progress snapshot.",
    },
    importance: {
      type: "integer",
      minimum: 1,
      maximum: 10,
      description: "Importance from 1 to 10. Use 7 for normal durable memory, 9 for critical constraints, and 10 only rarely.",
    },
    expiry: {
      type: "string",
      enum: ["core", "permanent", "temporary"],
      description: EXPIRY_DESCRIPTION,
    },
    tags: {
      type: "array",
      items: { type: "string" },
      description: "Optional tags for entities, systems, teams, or themes that should improve later recall.",
    },
    sourceContext: {
      type: "string",
      description: "Optional provenance note explaining why this memory was stored or what situation produced it.",
    },
  },
  required: ["type", "subject", "content"],
} as const;

/**
 * Creates the agenr store tool bound to one OpenClaw session context.
 *
 * @param ctx - Trusted OpenClaw tool context.
 * @param servicesPromise - Shared agenr adapters reused for the process lifetime.
 * @param logger - Host logger supplied by the OpenClaw plugin runtime.
 * @returns Agent tool definition for `agenr_store`.
 */
export function createAgenrStoreTool(ctx: OpenClawPluginToolContext, servicesPromise: Promise<AgenrOpenClawServices>, logger: PluginLogger): AnyAgentTool {
  return {
    name: "agenr_store",
    label: "Agenr Store",
    description:
      "Store a new knowledge entry in agenr long-term memory. Call immediately after decisions, preferences, lessons, and durable facts - but apply the future-session test first: will a fresh session need this to make a better decision, or are you just logging what happened?\n\nStore: architecture decisions, workflow constraints, recurring problems, user preferences, durable technical facts, operational lessons, important open risks.\n\nDo not store: version shipping events (changelogs are the record), issue/PR filing records (the tracker is the record), phase plans or release sequencing (stale within a session), progress snapshots (stale within minutes), prompt file locations or build logistics.\n\nDo not ask before storing - but do ask whether future-you actually needs it.",
    parameters: STORE_TOOL_PARAMETERS,
    async execute(_toolCallId, rawParams) {
      try {
        const params = asRecord(rawParams);
        const type = parseEntryType(readStringParam(params, "type", { required: true, label: "type" }));
        const subject = readStringParam(params, "subject", { required: true, label: "subject" });
        const content = readStringParam(params, "content", { required: true, label: "content" });
        const importance = readNumberParam(params, "importance", { integer: true, strict: true });
        const expiry = parseExpiry(readStringParam(params, "expiry"));
        const tags = normalizeStringArray(readStringArrayParam(params, "tags"));
        const sourceContext = readStringParam(params, "sourceContext");
        logToolCall(
          logger,
          "agenr_store",
          ctx,
          `store 1 entry subject=${JSON.stringify(subject)} type=${type}`,
          sanitizeStoreToolParams({
            type,
            subject,
            content,
            importance,
            expiry,
            tags,
            sourceContext,
          }),
        );

        const services = await servicesPromise;
        const result = await storeEntriesDetailed(
          [
            {
              type,
              subject,
              content,
              ...(importance !== undefined ? { importance } : {}),
              ...(expiry !== undefined ? { expiry } : {}),
              ...(tags.length > 0 ? { tags } : {}),
              source_file: buildSessionSourceFile(ctx),
              source_context: sourceContext ?? "Stored via agenr_store from OpenClaw.",
            },
          ],
          services.entries,
          services.embedding,
        );
        const storedEntry = await services.memory.findEntryBySubject(subject);

        if (result.stored > 0) {
          return textResult(`Stored "${subject}".`, {
            status: "stored",
            subject,
            entryId: storedEntry?.id,
            result,
          });
        }

        if (result.skipped > 0) {
          return textResult(`Skipped "${subject}" because an active duplicate already exists.`, {
            status: "skipped",
            subject,
            entryId: storedEntry?.id,
            result,
          });
        }

        return failedTextResult(`Rejected "${subject}". Check the supplied type, content, and metadata.`, {
          status: "failed",
          subject,
          result,
        });
      } catch (error) {
        logToolFailure(logger, "agenr_store", ctx, error);
        return toolFailureResult(error);
      }
    },
  };
}
