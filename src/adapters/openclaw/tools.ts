import type { AnyAgentTool } from "openclaw/plugin-sdk/agent-runtime";
import { failedTextResult, readNumberParam, readStringArrayParam, readStringParam, textResult } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawPluginToolContext, PluginLogger } from "openclaw/plugin-sdk/core";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

import { runUnifiedRecall, type UnifiedRecallMode, type UnifiedRecallResult } from "../../app/recall/index.js";
import { storeEntriesDetailed } from "../../core/store/pipeline.js";
import { ENTRY_TYPES, EXPIRY_LEVELS, type Entry, type EntryType, type Expiry } from "../../core/types.js";
import { findOpenClawEntryBySubject, findOpenClawMostRecentEntry, getOpenClawEntryTrace } from "../db/openclaw-plugin-queries.js";
import type { AgenrOpenClawServices } from "./types.js";

const ENTRY_TYPE_DESCRIPTION =
  "Knowledge type to store. Use fact for durable information about people, places, systems, or how things work. Use decision for standing rules, constraints, or chosen approaches. Use preference for stated wants, values, or opinions. Use lesson for non-obvious insights learned from specific experience. Use milestone for notable one-time events worth remembering (a move, a launch, a life change, a hire, a trip). Use relationship for meaningful connections between people, groups, or systems.";

const EXPIRY_DESCRIPTION =
  "Lifetime bucket: core (always injected at session start, use sparingly), permanent (durable and recalled on demand), or temporary (short-horizon).";
const UPDATE_EXPIRY_DESCRIPTION = `${EXPIRY_DESCRIPTION} Accepted values: ${EXPIRY_LEVELS.join(", ")}.`;

const DEFAULT_RECALL_LIMIT = 10;
const RESULT_SUBJECT_LOG_LIMIT = 5;
const RECALL_MODES = ["auto", "entries", "episodes"] as const;

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
      enum: [...EXPIRY_LEVELS],
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

const RECALL_TOOL_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {
    query: {
      type: "string",
      description: "What you need to remember. Use a focused natural-language query rather than a broad 'everything' search.",
    },
    mode: {
      type: "string",
      enum: [...RECALL_MODES],
      description: "Recall mode: auto routes between entries and episodes, entries forces semantic recall, and episodes forces temporal session recall.",
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

const RETIRE_TOOL_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: {
      type: "string",
      description: "Entry id to retire. Provide exactly one of id or subject.",
    },
    subject: {
      type: "string",
      description: "Subject text to resolve when the id is unknown. The most recent exact or substring match wins. Provide exactly one of id or subject.",
    },
    reason: {
      type: "string",
      description: "Optional retirement reason so later trace output explains why this memory was removed.",
    },
  },
} as const;

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
  },
} as const;

const TRACE_TOOL_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: {
      type: "string",
      description: "Entry id to trace. Provide exactly one of id, subject, or last.",
    },
    subject: {
      type: "string",
      description:
        "Subject text to resolve when the id is unknown. The most recent exact or substring match wins. Provide exactly one of id, subject, or last.",
    },
    last: {
      type: "boolean",
      description: "Set true to trace the most recently created agenr entry. Provide exactly one of id, subject, or last.",
    },
  },
} as const;

/**
 * Registers the five Phase 1 agenr tools with the OpenClaw plugin API.
 *
 * @param api - OpenClaw plugin registration API.
 * @param servicesPromise - Shared agenr adapters reused for the process lifetime.
 * @param logger - Host logger supplied by the OpenClaw plugin runtime.
 * @returns Nothing.
 */
export function registerAgenrOpenClawTools(api: OpenClawPluginApi, servicesPromise: Promise<AgenrOpenClawServices>, logger: PluginLogger): void {
  api.registerTool((ctx) => createAgenrStoreTool(ctx, servicesPromise, logger), { names: ["agenr_store"] });
  api.registerTool((ctx) => createAgenrRecallTool(ctx, servicesPromise, logger), { names: ["agenr_recall"] });
  api.registerTool((ctx) => createAgenrRetireTool(ctx, servicesPromise, logger), { names: ["agenr_retire"] });
  api.registerTool((ctx) => createAgenrUpdateTool(ctx, servicesPromise, logger), { names: ["agenr_update"] });
  api.registerTool((ctx) => createAgenrTraceTool(ctx, servicesPromise, logger), { names: ["agenr_trace"] });
}

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
          services.database,
          services.embedding,
        );
        const storedEntry = await findOpenClawEntryBySubject(services.database, subject);

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
      "Retrieve knowledge from agenr long-term memory. Use mode=auto for the normal path, mode=entries for exact facts and decisions, and mode=episodes for time-bounded 'what happened' questions. Time periods are parsed from the query text. Session-start recall is already handled automatically.",
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
          database: services.database,
          recall: services.recall,
          embeddingAvailable: services.embeddingStatus.available,
          embeddingError: services.embeddingStatus.error,
          embedQuery: services.embeddingStatus.available
            ? async (text: string) => {
                const vectors = await services.embedding.embed([text]);
                return vectors[0] ?? [];
              }
            : undefined,
        });
        logger.info(`[agenr] tool=agenr_recall ${formatToolSessionContext(ctx)} result: ${formatUnifiedRecallLogSummary(result)}`);

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
            whyMatched: describeEpisodeMatch(episode),
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

/**
 * Creates the agenr retire tool bound to one OpenClaw session context.
 *
 * @param ctx - Trusted OpenClaw tool context.
 * @param servicesPromise - Shared agenr adapters reused for the process lifetime.
 * @param logger - Host logger supplied by the OpenClaw plugin runtime.
 * @returns Agent tool definition for `agenr_retire`.
 */
export function createAgenrRetireTool(ctx: OpenClawPluginToolContext, servicesPromise: Promise<AgenrOpenClawServices>, logger: PluginLogger): AnyAgentTool {
  return {
    name: "agenr_retire",
    label: "Agenr Retire",
    description: "Mark a memory entry as retired (soft delete). Retired entries are excluded from all recall.",
    parameters: RETIRE_TOOL_PARAMETERS,
    async execute(_toolCallId, rawParams) {
      try {
        const params = asRecord(rawParams);
        const id = readStringParam(params, "id");
        const subject = readStringParam(params, "subject");
        const reason = readStringParam(params, "reason");
        logToolCall(logger, "agenr_retire", ctx, `target=${formatTargetSelector(id, subject)}`, sanitizeRetireToolParams({ id, subject, reason }));
        const services = await servicesPromise;
        const entry = await resolveTargetEntry(services, params);
        const retired = await services.database.retireEntry(entry.id, reason);

        if (!retired) {
          return failedTextResult(`Entry ${entry.id} is not active, so it could not be retired.`, {
            status: "failed",
            entryId: entry.id,
          });
        }

        return textResult(`Retired "${entry.subject}".`, {
          status: "retired",
          entryId: entry.id,
          subject: entry.subject,
          sessionKey: ctx.sessionKey,
        });
      } catch (error) {
        logToolFailure(logger, "agenr_retire", ctx, error);
        return toolFailureResult(error);
      }
    },
  };
}

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
    description: "Update an existing memory entry in place. Currently supports importance and expiry.",
    parameters: UPDATE_TOOL_PARAMETERS,
    async execute(_toolCallId, rawParams) {
      try {
        const params = asRecord(rawParams);
        const id = readStringParam(params, "id");
        const subject = readStringParam(params, "subject");
        const importance = readNumberParam(params, "importance", { integer: true, strict: true });
        const expiry = parseExpiry(readStringParam(params, "expiry"));
        logToolCall(
          logger,
          "agenr_update",
          ctx,
          `target=${formatTargetSelector(id, subject)}${importance !== undefined ? ` importance=${importance}` : ""}${
            expiry !== undefined ? ` expiry=${expiry}` : ""
          }`,
          sanitizeUpdateToolParams({ id, subject, importance, expiry }),
        );
        const services = await servicesPromise;
        const entry = await resolveTargetEntry(services, params);

        if (importance === undefined && expiry === undefined) {
          throw new Error("Provide at least one update field: importance or expiry.");
        }

        const updated = await services.database.updateEntry(entry.id, {
          ...(importance !== undefined ? { importance } : {}),
          ...(expiry !== undefined ? { expiry } : {}),
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
        });
      } catch (error) {
        logToolFailure(logger, "agenr_update", ctx, error);
        return toolFailureResult(error);
      }
    },
  };
}

/**
 * Creates the agenr trace tool bound to one OpenClaw session context.
 *
 * @param ctx - Trusted OpenClaw tool context.
 * @param servicesPromise - Shared agenr adapters reused for the process lifetime.
 * @param logger - Host logger supplied by the OpenClaw plugin runtime.
 * @returns Agent tool definition for `agenr_trace`.
 */
export function createAgenrTraceTool(ctx: OpenClawPluginToolContext, servicesPromise: Promise<AgenrOpenClawServices>, logger: PluginLogger): AnyAgentTool {
  return {
    name: "agenr_trace",
    label: "Agenr Trace",
    description:
      "Trace the provenance of a knowledge entry. The current v1 trace view shows the entry itself, supersession links, and recent recall history. Accepts id, subject, or last for lookup.",
    parameters: TRACE_TOOL_PARAMETERS,
    async execute(_toolCallId, rawParams) {
      try {
        const params = asRecord(rawParams);
        const id = readStringParam(params, "id");
        const subject = readStringParam(params, "subject");
        const last = readBooleanParam(params, "last");
        logToolCall(logger, "agenr_trace", ctx, `target=${formatTargetSelector(id, subject, last)}`, sanitizeTraceToolParams({ id, subject, last }));
        const services = await servicesPromise;
        const entry = await resolveTargetEntry(services, params, { allowLast: true });
        const trace = await getOpenClawEntryTrace(services.database, entry.id);

        if (!trace) {
          return failedTextResult(`Entry ${entry.id} was not found for tracing.`, {
            status: "failed",
            entryId: entry.id,
          });
        }

        return textResult(formatTrace(trace.entry, trace.supersededBy, trace.supersedes, trace.recallEvents), {
          status: "ok",
          sessionKey: ctx.sessionKey,
          trace: {
            entry: trace.entry,
            supersededBy: trace.supersededBy,
            supersedes: trace.supersedes,
            recallEvents: trace.recallEvents,
          },
        });
      } catch (error) {
        logToolFailure(logger, "agenr_trace", ctx, error);
        return toolFailureResult(error);
      }
    },
  };
}

/** Resolves exactly one tool target selector into a concrete agenr entry. */
async function resolveTargetEntry(
  services: AgenrOpenClawServices,
  params: Record<string, unknown>,
  options: {
    allowLast?: boolean;
  } = {},
): Promise<Entry> {
  const id = readStringParam(params, "id");
  const subject = readStringParam(params, "subject");
  const last = options.allowLast ? readBooleanParam(params, "last") : undefined;
  const selectorCount = (id ? 1 : 0) + (subject ? 1 : 0) + (last === true ? 1 : 0);
  const selectorDescription = options.allowLast ? "id, subject, or last" : "id or subject";

  if (selectorCount !== 1) {
    throw new Error(`Provide exactly one target selector: ${selectorDescription}.`);
  }

  if (last) {
    const entry = await findOpenClawMostRecentEntry(services.database);
    if (!entry) {
      throw new Error("No agenr entries exist yet.");
    }
    return entry;
  }

  if (id) {
    const entry = (await services.database.getEntry(id)) ?? (await getOpenClawEntryTrace(services.database, id))?.entry;
    if (!entry) {
      throw new Error(`No agenr entry found for id ${id}.`);
    }
    return entry;
  }

  const entry = await findOpenClawEntryBySubject(services.database, subject ?? "");
  if (!entry) {
    throw new Error(`No agenr entry found for subject "${subject}".`);
  }

  return entry;
}

/** Parses an optional boolean field from tool params. */
function readBooleanParam(params: Record<string, unknown>, key: string): boolean | undefined {
  const value = params[key];
  if (value === undefined) {
    return undefined;
  }

  if (typeof value === "boolean") {
    return value;
  }

  throw new Error(`${key} must be a boolean.`);
}

/** Parses optional recall/store type filters into validated agenr entry types. */
function parseEntryTypes(values: string[] | undefined): EntryType[] {
  return normalizeStringArray(values).map((value) => parseEntryType(value));
}

/** Parses the optional unified recall mode parameter. */
function parseRecallMode(value: string | undefined): UnifiedRecallMode | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === "auto" || value === "entries" || value === "episodes") {
    return value;
  }

  throw new Error(`Unsupported recall mode "${value}".`);
}

/** Parses one entry type string into the agenr domain union. */
function parseEntryType(value: string): EntryType {
  if (ENTRY_TYPES.includes(value as EntryType)) {
    return value as EntryType;
  }

  throw new Error(`Unsupported entry type "${value}".`);
}

/** Parses an optional expiry string into the agenr domain union. */
function parseExpiry(value: string | undefined): Expiry | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (EXPIRY_LEVELS.includes(value as Expiry)) {
    return value as Expiry;
  }

  throw new Error(`Unsupported expiry "${value}".`);
}

/** Normalizes optional string arrays by trimming, deduplicating, and dropping empties. */
function normalizeStringArray(values: string[] | undefined): string[] {
  if (!values) {
    return [];
  }

  return Array.from(new Set(values.map((value) => value.trim()).filter((value) => value.length > 0)));
}

/** Builds a stable source-file provenance label from the OpenClaw session context. */
function buildSessionSourceFile(ctx: OpenClawPluginToolContext): string {
  const target = ctx.sessionKey ?? ctx.sessionId ?? ctx.agentId ?? "unknown";
  return `openclaw-session:${target}`;
}

/** Logs one tool call summary plus sanitized parameters at info level. */
function logToolCall(logger: PluginLogger, toolName: string, ctx: OpenClawPluginToolContext, summary: string, sanitizedParams: Record<string, unknown>): void {
  logger.info(`[agenr] tool=${toolName} ${formatToolSessionContext(ctx)} ${summary}`);
  logger.info(`[agenr] tool=${toolName} ${formatToolSessionContext(ctx)} params=${JSON.stringify(sanitizedParams)}`);
}

/** Logs a warning when one OpenClaw tool call fails. */
function logToolFailure(logger: PluginLogger, toolName: string, ctx: OpenClawPluginToolContext, error: unknown): void {
  logger.warn(`[agenr] tool=${toolName} ${formatToolSessionContext(ctx)} failed: ${formatErrorMessage(error)}`);
}

/** Formats stable session identifiers for tool-level OpenClaw logs. */
function formatToolSessionContext(ctx: OpenClawPluginToolContext): string {
  const normalizedSessionId = ctx.sessionId?.trim();
  const normalizedSessionKey = ctx.sessionKey?.trim();

  if (normalizedSessionId && normalizedSessionKey) {
    return `session=${normalizedSessionId} key=${normalizedSessionKey}`;
  }

  if (normalizedSessionId) {
    return `session=${normalizedSessionId}`;
  }

  if (normalizedSessionKey) {
    return `key=${normalizedSessionKey}`;
  }

  return "session=unknown";
}

/** Formats a compact id-or-subject selector summary for tool call logs. */
function formatTargetSelector(id?: string, subject?: string, last?: boolean): string {
  if (last === true) {
    return "last";
  }

  if (id) {
    return `id:${JSON.stringify(id)}`;
  }

  if (subject) {
    return `subject:${JSON.stringify(subject)}`;
  }

  return "unknown";
}

/** Sanitizes store parameters before debug logging. */
function sanitizeStoreToolParams(params: {
  type: EntryType;
  subject: string;
  content: string;
  importance: number | undefined;
  expiry: Expiry | undefined;
  tags: string[];
  sourceContext: string | undefined;
}): Record<string, unknown> {
  return {
    type: params.type,
    subject: params.subject,
    ...(params.importance !== undefined ? { importance: params.importance } : {}),
    ...(params.expiry !== undefined ? { expiry: params.expiry } : {}),
    ...(params.tags.length > 0 ? { tags: params.tags } : {}),
    contentLength: params.content.length,
    ...(params.sourceContext !== undefined ? { sourceContextLength: params.sourceContext.length } : {}),
  };
}

/** Formats the visible recall call summary for tool logging. */
function formatRecallToolSummary(params: {
  query: string;
  mode: UnifiedRecallMode | undefined;
  limit: number | undefined;
  types: EntryType[];
  tags: string[];
}): string {
  const parts = [`query=${JSON.stringify(truncate(params.query, 80))}`];

  if (params.mode) {
    parts.push(`mode=${params.mode}`);
  }

  if (params.limit !== undefined && params.limit !== DEFAULT_RECALL_LIMIT) {
    parts.push(`limit=${params.limit}`);
  }

  if (params.types.length > 0) {
    parts.push(`types=${JSON.stringify(params.types)}`);
  }

  if (params.tags.length > 0) {
    parts.push(`tags=${JSON.stringify(params.tags)}`);
  }

  return parts.join(" ");
}

/** Sanitizes recall parameters before info logging. */
function sanitizeRecallToolParams(params: {
  query: string;
  mode: UnifiedRecallMode | undefined;
  limit: number | undefined;
  threshold: number | undefined;
  types: EntryType[];
  tags: string[];
}): Record<string, unknown> {
  return {
    query: params.query,
    ...(params.mode ? { mode: params.mode } : {}),
    ...(params.limit !== undefined ? { limit: params.limit } : {}),
    ...(params.threshold !== undefined ? { threshold: params.threshold } : {}),
    ...(params.types.length > 0 ? { types: params.types } : {}),
    ...(params.tags.length > 0 ? { tags: params.tags } : {}),
  };
}

/** Sanitizes retire parameters before debug logging. */
function sanitizeRetireToolParams(params: { id: string | undefined; subject: string | undefined; reason: string | undefined }): Record<string, unknown> {
  return {
    ...(params.id ? { id: params.id } : {}),
    ...(params.subject ? { subject: params.subject } : {}),
    ...(params.reason !== undefined ? { reasonLength: params.reason.length } : {}),
  };
}

/** Sanitizes update parameters before debug logging. */
function sanitizeUpdateToolParams(params: {
  id: string | undefined;
  subject: string | undefined;
  importance: number | undefined;
  expiry: Expiry | undefined;
}): Record<string, unknown> {
  return {
    ...(params.id ? { id: params.id } : {}),
    ...(params.subject ? { subject: params.subject } : {}),
    ...(params.importance !== undefined ? { importance: params.importance } : {}),
    ...(params.expiry !== undefined ? { expiry: params.expiry } : {}),
  };
}

/** Sanitizes trace parameters before debug logging. */
function sanitizeTraceToolParams(params: { id: string | undefined; subject: string | undefined; last: boolean | undefined }): Record<string, unknown> {
  return {
    ...(params.id ? { id: params.id } : {}),
    ...(params.subject ? { subject: params.subject } : {}),
    ...(params.last !== undefined ? { last: params.last } : {}),
  };
}

/** Formats unified recall results into sectioned tool-readable text. */
function formatUnifiedRecallResults(result: UnifiedRecallResult): string {
  const lines = [
    "Recall Route",
    `requested=${result.routing.requested} detected=${result.routing.detectedIntent} queried=${result.routing.queried.join(", ") || "none"}`,
    result.routing.reason,
    "",
  ];

  if (result.timeWindow) {
    lines.push("Resolved Time Window");
    lines.push(`${result.timeWindow.start} -> ${result.timeWindow.end} (${result.timeWindow.timezone}) from ${JSON.stringify(result.timeWindow.resolvedFrom)}`);
    lines.push("");
  }

  lines.push("Episode Matches");
  if (result.episodes.length === 0) {
    lines.push("None.");
  } else {
    for (const [index, episode] of result.episodes.entries()) {
      lines.push(
        `${index + 1}. ${episode.episode.id} | ${episode.episode.source} | ${episode.episode.startedAt} -> ${episode.episode.endedAt ?? episode.episode.startedAt} | score ${episode.score.toFixed(2)}`,
      );
      lines.push(`   ${index < 3 ? episode.episode.summary.trim() : truncate(episode.episode.summary.trim(), 220)}`);
      lines.push(`   why_matched=${describeEpisodeMatch(episode)}`);
    }
  }
  lines.push("");

  lines.push("Entry Matches");
  if (result.entries.length === 0) {
    lines.push("None.");
  } else {
    for (const [index, entry] of result.entries.entries()) {
      lines.push(
        `${index + 1}. ${entry.entry.id} | ${entry.entry.type} | ${entry.entry.subject} | score ${entry.score.toFixed(2)} | importance ${entry.entry.importance}`,
      );
      lines.push(`   ${truncate(entry.entry.content, 220)}`);
    }
  }

  if (result.notices.length > 0) {
    lines.push("");
    lines.push("Notices");
    for (const notice of result.notices) {
      lines.push(`- ${notice}`);
    }
  }

  return lines.join("\n");
}

/** Formats a concise unified recall summary for info-level logging. */
function formatUnifiedRecallLogSummary(result: UnifiedRecallResult): string {
  const entrySubjects = result.entries.map((entry) => entry.entry.subject.trim()).filter((subject) => subject.length > 0);
  const displayed = entrySubjects.slice(0, RESULT_SUBJECT_LOG_LIMIT).map((subject) => JSON.stringify(truncate(subject, 80)));
  const remaining = entrySubjects.length - RESULT_SUBJECT_LOG_LIMIT;
  const suffix = displayed.length === 0 ? "" : ` [entry subjects: ${displayed.join(", ")}${remaining > 0 ? `, ... and ${remaining} more` : ""}]`;
  return `${result.episodes.length} episode${result.episodes.length === 1 ? "" : "s"}, ${result.entries.length} entr${
    result.entries.length === 1 ? "y" : "ies"
  }${suffix}`;
}

/** Formats a short explanation for why an episode matched recall. */
function describeEpisodeMatch(result: UnifiedRecallResult["episodes"][number]): string {
  if (result.scores.semantic > 0 && result.scores.temporal > 0) {
    return "Semantic match within the resolved time window.";
  }

  if (result.scores.semantic > 0) {
    return "Semantic match to the episode summary.";
  }

  if (result.scores.temporal > 0) {
    return "Session overlaps the resolved time window.";
  }

  return "Matched episodic recall ranking.";
}

/** Formats the limited Phase 1 provenance view returned by `agenr_trace`. */
function formatTrace(
  entry: Entry,
  supersededBy: Entry | undefined,
  supersedes: Entry[],
  recallEvents: Array<{ query?: string; sessionKey?: string; recalledAt: string }>,
): string {
  const lines = [
    `Trace for ${entry.id} | ${entry.subject}`,
    `type=${entry.type} expiry=${entry.expiry} importance=${entry.importance} retired=${entry.retired}`,
    `content=${truncate(entry.content, 220)}`,
  ];

  if (supersededBy) {
    lines.push(`superseded_by=${supersededBy.id} | ${supersededBy.subject}`);
  }

  if (supersedes.length > 0) {
    lines.push(`supersedes=${supersedes.map((item) => `${item.id} (${item.subject})`).join(", ")}`);
  }

  if (recallEvents.length > 0) {
    lines.push(
      `recent_recalls=${recallEvents
        .map((event) => `${event.recalledAt}${event.query ? ` query=${event.query}` : ""}${event.sessionKey ? ` session=${event.sessionKey}` : ""}`)
        .join(" ; ")}`,
    );
  }

  return lines.join("\n");
}

/** Truncates tool text output to avoid oversized results. */
function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, maxChars - 3).trimEnd()}...`;
}

/** Wraps unexpected tool failures in the standard failed result payload. */
function toolFailureResult(error: unknown) {
  return failedTextResult(formatErrorMessage(error), {
    status: "failed" as const,
  });
}

/** Normalizes unknown tool failures into human-readable messages. */
function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

/** Guards untrusted tool parameters and narrows them to a string-keyed object. */
function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  throw new Error("Tool parameters must be an object.");
}
