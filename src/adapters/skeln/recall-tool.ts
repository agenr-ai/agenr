import { runUnifiedRecall } from "../../app/recall/index.js";
import type { UnifiedRecallMode, UnifiedRecallResult } from "../../app/recall/index.js";
import { formatUnifiedRecallResults } from "../shared/recall-format.js";
import { ENTRY_TYPES, type EntryType } from "../../core/types.js";
import type { AgenrSkelnServices, SkelnApprovalTargetLike, SkelnToolContextLike, SkelnToolLike, SkelnToolResultLike } from "./types.js";

const RECALL_MODES = ["auto", "entries", "episodes", "procedures"] as const;
const RECALL_TOOL_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {
    query: {
      type: "string",
      description: "What you need to remember. Use a focused natural-language query for facts, decisions, procedures, prior states, or past episodes.",
    },
    mode: {
      type: "string",
      enum: [...RECALL_MODES],
      description: "Recall mode. Use auto normally, entries for facts and decisions, episodes for past activity, and procedures for methods or checklists.",
    },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: 10,
      description: "Maximum results to return.",
    },
    threshold: {
      type: "number",
      minimum: 0,
      maximum: 1,
      description: "Minimum final score from 0 to 1.",
    },
    types: {
      type: "array",
      items: {
        type: "string",
        enum: [...ENTRY_TYPES],
      },
      description: "Optional durable entry types to filter by.",
    },
    tags: {
      type: "array",
      items: { type: "string" },
      description: "Optional tags to filter by.",
    },
    asOf: {
      type: "string",
      description: "Optional reference time for current-vs-prior resolution.",
    },
  },
  required: ["query"],
} as const;

/**
 * Structured success details returned by `agenr_recall`.
 */
export interface AgenrSkelnRecallDetails {
  /** Result status. */
  status: "ok";
  /** Total result count. */
  count: number;
  /** Unified recall routing details. */
  routing: {
    /** Requested route. */
    requested: string;
    /** Detected recall intent. */
    detectedIntent: string;
    /** Queried recall branches. */
    queried: string[];
    /** Optional routing explanation. */
    reason?: string;
  };
  /** User-facing notices from unified recall. */
  notices: string[];
  /** Matched durable entries. */
  entries: Array<Record<string, unknown>>;
  /** Matched episodes. */
  episodes: Array<Record<string, unknown>>;
  /** Matched procedure candidates. */
  procedures: Array<Record<string, unknown>>;
  /** Procedure-specific notices. */
  procedureNotices: string[];
  /** Optional selected canonical procedure. */
  procedure?: Record<string, unknown>;
  /** Optional resolved as-of value. */
  asOf?: string;
  /** Optional resolved time window. */
  timeWindow?: unknown;
}

/**
 * Structured failure details returned by `agenr_recall`.
 */
export interface AgenrSkelnRecallFailureDetails {
  /** Failure message. */
  error: string;
}

/**
 * Creates the read-only agenr recall tool for a Skeln tool context.
 *
 * @param context - Skeln-like tool context.
 * @param services - Lazily resolves agenr services.
 * @returns Skeln-compatible recall tool.
 */
export function createAgenrRecallTool(
  context: SkelnToolContextLike,
  services: () => Promise<AgenrSkelnServices>,
): SkelnToolLike<AgenrSkelnRecallDetails | AgenrSkelnRecallFailureDetails> {
  return {
    name: "agenr_recall",
    label: "Agenr Recall",
    category: "memory",
    risk: "read",
    /**
     * Compatibility default only. Skeln should override this from its config.
     */
    approval: "never",
    approvalTarget: recallApprovalTarget,
    description:
      "Recall facts, decisions, procedures, prior states, and episodes from agenr memory. Use mode=auto normally, entries for facts and decisions, episodes for past activity, and procedures for methods or checklists.",
    parameters: RECALL_TOOL_PARAMETERS,
    async execute(_toolCallId: string, rawParams: unknown): Promise<SkelnToolResultLike<AgenrSkelnRecallDetails | AgenrSkelnRecallFailureDetails>> {
      try {
        const params = asRecord(rawParams);
        const query = readRequiredString(params, "query");
        const mode = parseRecallMode(readOptionalString(params, "mode"));
        const limit = readOptionalIntegerInRange(params, "limit", 1, 10);
        const threshold = readOptionalNumberInRange(params, "threshold", 0, 1);
        const types = parseEntryTypes(readOptionalStringArray(params, "types"));
        const tags = normalizeStringArray(readOptionalStringArray(params, "tags"));
        const asOf = readOptionalString(params, "asOf");
        const resolvedServices = await services();
        const request = {
          text: query,
          ...(mode ? { mode } : {}),
          ...(limit !== undefined ? { limit } : {}),
          ...(threshold !== undefined ? { threshold } : {}),
          ...(types.length > 0 ? { types } : {}),
          ...(tags.length > 0 ? { tags } : {}),
          ...(asOf ? { asOf } : {}),
          sessionKey: context.sessionKey ?? context.sessionId,
        };
        const result = await runUnifiedRecall(request, {
          database: resolvedServices.episodes,
          procedures: resolvedServices.procedures,
          recall: resolvedServices.recall,
          embeddingAvailable: resolvedServices.embeddingStatus.available,
          embeddingError: resolvedServices.embeddingStatus.error,
          embedQuery: resolvedServices.embedQuery,
        });

        return textResult(formatUnifiedRecallResults(result), buildRecallDetails(result));
      } catch (error) {
        const message = formatErrorMessage(error);
        return {
          content: [{ type: "text", text: `agenr_recall failed: ${message}` }],
          details: { error: message },
          isError: true,
        };
      }
    },
  };
}

/**
 * Converts unified recall output into stable structured tool details.
 */
function buildRecallDetails(result: UnifiedRecallResult): AgenrSkelnRecallDetails {
  return {
    status: "ok",
    count: result.count,
    routing: {
      requested: result.routing.requested,
      detectedIntent: result.routing.detectedIntent,
      queried: result.routing.queried,
      reason: result.routing.reason,
    },
    ...(result.asOf ? { asOf: result.asOf } : {}),
    ...(result.timeWindow ? { timeWindow: result.timeWindow } : {}),
    ...(result.procedure
      ? {
          procedure: {
            id: result.procedure.id,
            procedureKey: result.procedure.procedure_key,
            title: result.procedure.title,
            goal: result.procedure.goal,
          },
        }
      : {}),
    procedures: result.procedureCandidates.map((candidate) => ({
      id: candidate.procedure.id,
      procedureKey: candidate.procedure.procedure_key,
      title: candidate.procedure.title,
      goal: candidate.procedure.goal,
      score: candidate.score,
      lexicalScore: candidate.scores.lexical,
      vectorScore: candidate.scores.vector,
    })),
    procedureNotices: result.procedureNotices,
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
  };
}

/**
 * Extracts the recall query Skeln can use as the approval target.
 */
function recallApprovalTarget(args: unknown): SkelnApprovalTargetLike {
  try {
    const params = asRecord(args);
    const query = readRequiredString(params, "query");
    return { target: query };
  } catch {
    return { target: "agenr memory recall" };
  }
}

/**
 * Creates a text tool result.
 */
function textResult<TDetails>(text: string, details: TDetails): SkelnToolResultLike<TDetails> {
  return {
    content: [{ type: "text", text }],
    details,
    isError: false,
  };
}

/**
 * Guards untrusted tool parameters and narrows them to a string-keyed object.
 */
function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  throw new Error("Tool parameters must be an object.");
}

/**
 * Reads one required string parameter.
 */
function readRequiredString(params: Record<string, unknown>, key: string): string {
  const value = readOptionalString(params, key);
  if (!value) {
    throw new Error(`Parameter "${key}" is required.`);
  }
  return value;
}

/**
 * Reads one optional string parameter.
 */
function readOptionalString(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`Parameter "${key}" must be a string.`);
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

/**
 * Reads one optional string-array parameter.
 */
function readOptionalStringArray(params: Record<string, unknown>, key: string): string[] {
  const value = params[key];
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`Parameter "${key}" must be an array of strings.`);
  }
  return value.map((item, index) => {
    if (typeof item !== "string") {
      throw new Error(`Parameter "${key}" item ${index + 1} must be a string.`);
    }
    return item;
  });
}

/**
 * Reads one optional bounded integer parameter.
 */
function readOptionalIntegerInRange(params: Record<string, unknown>, key: string, minimum: number, maximum: number): number | undefined {
  const value = params[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`Parameter "${key}" must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

/**
 * Reads one optional bounded number parameter.
 */
function readOptionalNumberInRange(params: Record<string, unknown>, key: string, minimum: number, maximum: number): number | undefined {
  const value = params[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`Parameter "${key}" must be a number from ${minimum} to ${maximum}.`);
  }
  return value;
}

/**
 * Parses an optional recall mode.
 */
function parseRecallMode(value: string | undefined): UnifiedRecallMode | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (RECALL_MODES.includes(value as (typeof RECALL_MODES)[number])) {
    return value as UnifiedRecallMode;
  }
  throw new Error(`Unsupported recall mode "${value}".`);
}

/**
 * Parses and validates optional entry type filters.
 */
function parseEntryTypes(values: string[]): EntryType[] {
  const allowed = new Set<string>(ENTRY_TYPES);
  const normalized = normalizeStringArray(values);
  for (const value of normalized) {
    if (!allowed.has(value)) {
      throw new Error(`Unsupported entry type "${value}".`);
    }
  }
  return normalized as EntryType[];
}

/**
 * Normalizes string array parameters and removes duplicates.
 */
function normalizeStringArray(values: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of values) {
    const item = value.trim();
    if (item.length > 0 && !seen.has(item)) {
      seen.add(item);
      normalized.push(item);
    }
  }
  return normalized;
}

/**
 * Normalizes unknown failures into human-readable messages.
 */
function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
