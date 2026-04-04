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
      description: "Short subject line future recall can match. Name the durable takeaway, person, system, rule, relationship, or milestone directly.",
    },
    content: {
      type: "string",
      description: "What a fresh session should remember. Store the durable takeaway, not the activity log, canonical record, or transient progress snapshot.",
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
    supersedes: {
      type: "string",
      description: "ID of an entry this replaces. The old entry will be marked as superseded.",
    },
    claimKey: {
      type: "string",
      description:
        'Slot key identifying the specific knowledge slot (entity/attribute format, e.g., "project_name/deploy_strategy" or "postgres/max_connections"). Entries with the same claim key are candidates for supersession.',
    },
    validFrom: {
      type: "string",
      description: "ISO 8601 timestamp for when this fact became true in the world.",
    },
    validTo: {
      type: "string",
      description: "ISO 8601 timestamp for when this fact stopped being true.",
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
      "Store a new durable memory entry in agenr. Apply the future-session test first: will a fresh future session make a better decision because this was stored, or are you just logging that something happened?\n\nIf another system is already the canonical record - such as version control, a task or ticket tracker, a calendar, a signed document, a chat or email thread, or a database/CRM - usually do not store that record here. Store only the durable takeaway: the standing implication, rule, lesson, preference, risk, or relationship.\n\nType guide: fact = durable truth about a person, system, place, or how something works. decision = a standing rule, constraint, policy, or chosen approach future sessions should follow. preference = what someone likes, wants, values, or wants avoided. lesson = a non-obvious takeaway learned from experience that should change future behavior. milestone = a rare one-time event with durable future significance, not ordinary execution progress. relationship = a meaningful durable connection between people, groups, or systems.\n\nUsually do not store: 'I merged PR #123.', 'I filed a ticket with support.', 'We had a meeting at 3 PM.', 'I sent the contract for signature.', 'We spent two hours debugging the outage.' Do store the takeaway instead: 'Always use the structured export path because raw sync corrupts timestamps.' 'Jim prefers text-first updates and dislikes surprise calls.' 'Service restarts fail unless config Y is enabled.' 'The office Wi-Fi name is Acorn-5G.'\n\nDo not use decision as a catch-all for important activity updates. Do not store plans, checklists, speculative future state, progress snapshots, session narration, or rephrased recalled material.\n\nWhen replacing an existing fact, pass `supersedes` with the old entry's ID. When storing a slot-like fact (for example, a library version or a rollout strategy), pass `claimKey` to enable future supersession detection.\n\nDo not ask before storing - but do ask whether future-you actually needs it.",
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
        const supersedes = readStringParam(params, "supersedes");
        const claimKey = readStringParam(params, "claimKey");
        const validFrom = readStringParam(params, "validFrom");
        const validTo = readStringParam(params, "validTo");
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
            supersedes,
            claimKey,
            validFrom,
            validTo,
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
              ...(supersedes ? { supersedes } : {}),
              ...(claimKey ? { claim_key: claimKey } : {}),
              ...(validFrom ? { valid_from: validFrom } : {}),
              ...(validTo ? { valid_to: validTo } : {}),
              source_file: buildSessionSourceFile(ctx),
              source_context: sourceContext ?? "Stored via agenr_store from OpenClaw.",
            },
          ],
          services.entries,
          services.embedding,
          {
            ...(services.claimExtraction
              ? {
                  claimExtraction: {
                    llm: services.claimExtraction.llm,
                    db: services.entries,
                    config: services.claimExtraction.config,
                  },
                }
              : {}),
            onWarning: (warning) => logger.warn(`[agenr] tool=agenr_store session=${ctx.sessionId ?? "unknown"} warning: ${warning}`),
          },
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
