import type { AnyAgentTool } from "openclaw/plugin-sdk/agent-runtime";
import { readNumberParam, readStringArrayParam, readStringParam, textResult } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawPluginToolContext, PluginLogger } from "openclaw/plugin-sdk/core";

import { runUnifiedRecall } from "../../../app/recall/index.js";
import { ENTRY_TYPES } from "../../../core/types.js";
import type { AgenrOpenClawServices } from "../types.js";
import {
  RECALL_MODES,
  asRecord,
  formatRecallToolSummary,
  formatUnifiedRecallLogSummary,
  formatUnifiedRecallResults,
  logToolCall,
  logToolFailure,
  normalizeStringArray,
  parseEntryTypes,
  parseRecallMode,
  sanitizeRecallToolParams,
  toolFailureResult,
} from "./shared.js";

const RECALL_TOOL_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {
    query: {
      type: "string",
      description:
        "What you need to remember. Use a focused natural-language query rather than a broad 'everything' search. Phrase prior-state asks directly, for example 'what was the previous approach' or 'what changed from X to Y'.",
    },
    mode: {
      type: "string",
      enum: [...RECALL_MODES],
      description:
        "Recall mode: auto routes between exact entry recall, historical-state recall, and episodes; entries forces semantic recall; episodes forces temporal or semantic session recall.",
    },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: 10,
      description: "Maximum results to return. Lower this when you want a tighter shortlist.",
    },
    threshold: {
      type: "number",
      minimum: 0,
      maximum: 1,
      description: "Minimum final score from 0 to 1. Raise this when you want fewer, higher-confidence matches.",
    },
    types: {
      type: "array",
      items: {
        type: "string",
        enum: [...ENTRY_TYPES],
      },
      description: "Optional knowledge types to filter by, such as decision, preference, lesson, fact, milestone, or relationship.",
    },
    tags: {
      type: "array",
      items: { type: "string" },
      description: "Optional tags to filter by once you already know the relevant entity, system, or theme.",
    },
  },
  required: ["query"],
} as const;

/**
 * Creates the agenr recall tool bound to one OpenClaw session context.
 *
 * @param ctx - Trusted OpenClaw tool context.
 * @param servicesPromise - Shared agenr adapters reused for the process lifetime.
 * @param logger - Host logger supplied by the OpenClaw plugin runtime.
 * @returns Agent tool definition for `agenr_recall`.
 */
export function createAgenrRecallTool(ctx: OpenClawPluginToolContext, servicesPromise: Promise<AgenrOpenClawServices>, logger: PluginLogger): AnyAgentTool {
  return {
    name: "agenr_recall",
    label: "Agenr Recall",
    description:
      "Retrieve knowledge from agenr long-term memory. Use mode=auto for the normal path, including historical-state questions like what was the previous approach or what changed from X to Y; use mode=entries for exact facts and decisions; use mode=episodes for time-bounded 'what happened' questions. Time periods are parsed from the query text. Session-start recall is already handled automatically.",
    parameters: RECALL_TOOL_PARAMETERS,
    async execute(_toolCallId, rawParams) {
      try {
        const params = asRecord(rawParams);
        const query = readStringParam(params, "query", { required: true, label: "query" });
        const mode = parseRecallMode(readStringParam(params, "mode"));
        const limit = readNumberParam(params, "limit", { integer: true, strict: true });
        const threshold = readNumberParam(params, "threshold", { strict: true });
        const services = await servicesPromise;
        const types = parseEntryTypes(readStringArrayParam(params, "types"));
        const tags = normalizeStringArray(readStringArrayParam(params, "tags"));
        const request = {
          text: query,
          ...(mode ? { mode } : {}),
          ...(limit !== undefined ? { limit } : {}),
          ...(threshold !== undefined ? { threshold } : {}),
          ...(types.length > 0 ? { types } : {}),
          ...(tags.length > 0 ? { tags } : {}),
          sessionKey: ctx.sessionKey,
        };

        logToolCall(
          logger,
          "agenr_recall",
          ctx,
          formatRecallToolSummary({
            query,
            mode,
            limit,
            types,
            tags,
          }),
          sanitizeRecallToolParams({
            query,
            mode,
            limit,
            threshold,
            types,
            tags,
          }),
        );
        const result = await runUnifiedRecall(request, {
          database: services.episodes,
          recall: services.recall,
          embeddingAvailable: services.embeddingStatus.available,
          embeddingError: services.embeddingStatus.error,
          debugLog: (message: string) => {
            logger.debug?.(message);
          },
          embedQuery: services.embeddingStatus.available
            ? async (text: string) => {
                const vectors = await services.embedding.embed([text]);
                return vectors[0] ?? [];
              }
            : undefined,
        });
        logger.info(
          `[agenr] tool=agenr_recall session=${ctx.sessionId ?? "unknown"} key=${ctx.sessionKey ?? "unknown"} result: ${formatUnifiedRecallLogSummary(result)}`,
        );

        return textResult(formatUnifiedRecallResults(result), {
          status: "ok",
          count: result.count,
          routing: {
            requested: result.routing.requested,
            detectedIntent: result.routing.detectedIntent,
            queried: result.routing.queried,
            reason: result.routing.reason,
          },
          ...(result.timeWindow ? { timeWindow: result.timeWindow } : {}),
          episodes: result.episodes.map((episode) => ({
            id: episode.episode.id,
            source: episode.episode.source,
            sourceId: episode.episode.sourceId,
            startedAt: episode.episode.startedAt,
            endedAt: episode.episode.endedAt,
            tags: episode.episode.tags,
            score: episode.score,
            activityLevel: episode.episode.activityLevel,
            summary: episode.episode.summary,
            whyMatched:
              episode.scores.semantic > 0 && episode.scores.temporal > 0
                ? "Semantic match within the resolved time window."
                : episode.scores.semantic > 0
                  ? "Semantic match to the episode summary."
                  : episode.scores.temporal > 0
                    ? "Session overlaps the resolved time window."
                    : "Matched episodic recall ranking.",
          })),
          entries: result.entries.map((entry) => ({
            id: entry.entry.id,
            subject: entry.entry.subject,
            type: entry.entry.type,
            expiry: entry.entry.expiry,
            importance: entry.entry.importance,
            score: entry.score,
            tags: entry.entry.tags,
            content: entry.entry.content,
          })),
          notices: result.notices,
        });
      } catch (error) {
        logToolFailure(logger, "agenr_recall", ctx, error);
        return toolFailureResult(error);
      }
    },
  };
}
