import type { ClaimSlotPolicyConfig } from "../../core/claim-slot-policy.js";
import { normalizeManualClaimKeyUpdate } from "../../core/claim-key-lifecycle.js";
import { parseDirectiveTrigger } from "../../core/directives/model.js";
import type { DatabasePort, EmbeddingPort, EpisodeDatabasePort, ProcedureDatabasePort, RecallPorts } from "../../core/ports.js";
import { storeDurablesDetailed } from "../../core/store/pipeline.js";
import { validateTemporalValidityRange } from "../../core/temporal-validity.js";
import { DURABLE_KINDS, type DirectiveTrigger, type DurableKind, type Expiry } from "../../core/types.js";
import type { MemoryRepository } from "../../app/memory/ports.js";
import type { PluginClaimExtractionRuntime, PluginEmbeddingStatus, PluginMemoryRuntimeServices } from "../../app/plugin-runtime/types.js";
import { runUnifiedRecall, type UnifiedRecallMode, type UnifiedRecallResult } from "../../app/recall/index.js";
import { buildSessionSourceFile, buildToolCallClaimSupport, type SessionSourcePrefix, type ToolSessionLike } from "./claim-support.js";
import {
  ENTRY_TYPE_DESCRIPTION,
  EXPIRY_DESCRIPTION,
  RECALL_MODES,
  UPDATE_EXPIRY_DESCRIPTION,
  asRecord,
  normalizeStringArray,
  parseDurableKind,
  parseDurableKinds,
  parseExpiry,
  parseRecallMode,
} from "./entry-tools.js";
import { buildEntryMemoryResolverPorts, resolveTargetDurable } from "./resolve-target.js";
import { assertEntryFetchableContentLength, buildFetchToolDetails, formatFetchedEntryText } from "./memory-tool-format.js";

export {
  buildRecallToolDetails,
  formatRecallToolSummary,
  formatUnifiedRecallLogSummary,
  sanitizeRecallToolParams,
  sanitizeStoreToolParams,
  truncate,
} from "./memory-tool-format.js";

/** Host-provided primitive readers used to preserve each adapter's input boundary semantics. */
export interface MemoryToolParamReader {
  readString(params: Record<string, unknown>, key: string, options?: { required?: boolean; label?: string; trim?: boolean }): string | undefined;
  readNumber(params: Record<string, unknown>, key: string, options?: { integer?: boolean; strict?: boolean }): number | undefined;
  readStringArray(params: Record<string, unknown>, key: string): string[] | undefined;
}

/** Parsed agenr_store parameters. */
export interface StoreToolParams {
  type: DurableKind;
  subject: string;
  content: string;
  importance: number | undefined;
  expiry: Expiry | undefined;
  tags: string[];
  sourceContext: string | undefined;
  supersedes: string | undefined;
  claimKey: string | undefined;
  polarity: "abstain" | "proactive" | undefined;
  trigger: DirectiveTrigger | undefined;
  validFrom: string | undefined;
  validTo: string | undefined;
}

/** Parsed agenr_recall parameters. */
export interface RecallToolParams {
  query: string;
  mode: UnifiedRecallMode | undefined;
  limit: number | undefined;
  threshold: number | undefined;
  budget: number | undefined;
  types: DurableKind[];
  tags: string[];
  asOf: string | undefined;
}

/** Parsed agenr_update parameters. */
export interface UpdateToolParams {
  id: string | undefined;
  subject: string | undefined;
  importance: number | undefined;
  expiry: Expiry | undefined;
  claimKeyInput: string | undefined;
  validFrom: string | undefined;
  validTo: string | undefined;
}

/** Parsed agenr_fetch parameters. */
export interface FetchToolParams {
  id: string | undefined;
  subject: string | undefined;
}

/** Host-neutral text result returned by shared tool execution cores. */
export interface MemoryToolOutcome {
  text: string;
  details: Record<string, unknown>;
  failed: boolean;
}

/** Runtime services needed by the store/update tools. */
export interface EntryMemoryToolServices {
  entries: DatabasePort;
  embedding: EmbeddingPort;
  memory: Pick<MemoryRepository, "findEntryBySubject" | "findMostRecentEntry" | "getEntryTrace">;
  claimExtraction?: PluginClaimExtractionRuntime;
}

/** Runtime services needed by the recall tool. */
export interface RecallMemoryToolServices {
  episodes: EpisodeDatabasePort;
  procedures: ProcedureDatabasePort;
  recall: RecallPorts;
  embeddingStatus: PluginEmbeddingStatus;
  embedQuery?: (text: string) => Promise<number[]>;
}

/**
 * Builds recall-tool services from shared plugin runtime services.
 *
 * @param services - Shared plugin runtime services from a host adapter.
 * @returns Recall-tool service bundle with canonical embedQuery wiring.
 */
export function buildRecallToolServices(services: PluginMemoryRuntimeServices): RecallMemoryToolServices {
  return {
    episodes: services.episodes,
    procedures: services.procedures,
    recall: services.recall,
    embeddingStatus: services.embeddingStatus,
    embedQuery: services.beforeTurn.embedQuery,
  };
}

/** Shared agenr_store parameter schema. */
const STORE_TOOL_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {
    type: {
      type: "string",
      enum: [...DURABLE_KINDS],
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
        'Slot key identifying the specific knowledge slot (entity/attribute format, e.g., "project_name/deploy_strategy" or "postgres/max_connections"). Directive rows must use user/memory_directive/<name>. Entries with the same claim key are candidates for supersession.',
    },
    polarity: {
      type: "string",
      enum: ["abstain", "proactive"],
      description:
        "Required when type is directive. Use abstain to suppress a topic or behavior; use proactive to surface the directive when its trigger fires.",
    },
    trigger: {
      type: "string",
      description:
        "Optional when type is directive. Use session_start, always, or topic:<term>. Defaults to session_start for proactive directives and always for abstain directives.",
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

/** Shared agenr_recall parameter schema. */
const RECALL_TOOL_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {
    query: {
      type: "string",
      description:
        "What you need to remember. Use a focused natural-language query rather than a broad 'everything' search. Phrase prior-state asks directly, for example 'what was the previous approach' or 'what changed from X to Y'. Phrase procedural asks directly, for example 'how do I rotate credentials' or 'what steps should I follow'.",
    },
    mode: {
      type: "string",
      enum: [...RECALL_MODES],
      description:
        "Recall mode: auto routes between exact durable recall, historical-state recall, procedural recall, and episodes; entries forces semantic recall; episodes forces temporal or semantic session recall; procedures forces procedural recall.",
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
    budget: {
      type: "integer",
      minimum: 1,
      description: "Approximate token budget applied after entry scoring. Omit when you do not want a budget cap.",
    },
    types: {
      type: "array",
      items: {
        type: "string",
        enum: [...DURABLE_KINDS],
      },
      description: "Optional knowledge types to filter by, such as decision, preference, lesson, fact, milestone, or relationship.",
    },
    tags: {
      type: "array",
      items: { type: "string" },
      description: "Optional tags to filter by once you already know the relevant entity, system, or theme.",
    },
    asOf: {
      type: "string",
      description: "Optional reference time for current-vs-prior resolution. Supports ISO timestamps and natural-language date phrases.",
    },
  },
  required: ["query"],
} as const;

/** Shared agenr_update parameter schema. */
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

/** Shared agenr_fetch parameter schema. */
const FETCH_TOOL_PARAMETERS = {
  type: "object",
  additionalProperties: false,
  properties: {
    id: {
      type: "string",
      description: "Entry id to fetch. Provide exactly one of id or subject.",
    },
    subject: {
      type: "string",
      description: "Subject text to resolve when the id is unknown. The most recent exact or substring match wins. Provide exactly one of id or subject.",
    },
  },
} as const;

/** Parses raw agenr_store parameters through the host's reader boundary. */
export function parseStoreToolParams(rawParams: unknown, reader: MemoryToolParamReader): StoreToolParams {
  const params = asRecord(rawParams);
  const type = parseDurableKind(reader.readString(params, "type", { required: true, label: "type" }) ?? "");
  return {
    type,
    subject: reader.readString(params, "subject", { required: true, label: "subject" }) ?? "",
    content: reader.readString(params, "content", { required: true, label: "content" }) ?? "",
    importance: reader.readNumber(params, "importance", { integer: true, strict: true }),
    expiry: parseExpiry(reader.readString(params, "expiry")),
    tags: normalizeStringArray(reader.readStringArray(params, "tags")),
    sourceContext: reader.readString(params, "sourceContext"),
    supersedes: reader.readString(params, "supersedes"),
    claimKey: reader.readString(params, "claimKey", { trim: false }),
    polarity: parseDirectivePolarityParam(reader.readString(params, "polarity")),
    trigger: parseDirectiveTriggerParam(reader.readString(params, "trigger")),
    validFrom: reader.readString(params, "validFrom"),
    validTo: reader.readString(params, "validTo"),
  };
}

/** Parses raw agenr_recall parameters through the host's reader boundary. */
export function parseRecallToolParams(rawParams: unknown, reader: MemoryToolParamReader): RecallToolParams {
  const params = asRecord(rawParams);
  const budget = reader.readNumber(params, "budget", { integer: true, strict: true });
  if (budget !== undefined && budget <= 0) {
    throw new Error("budget must be a positive integer.");
  }

  return {
    query: reader.readString(params, "query", { required: true, label: "query" }) ?? "",
    mode: parseRecallMode(reader.readString(params, "mode")),
    limit: reader.readNumber(params, "limit", { integer: true, strict: true }),
    threshold: reader.readNumber(params, "threshold", { strict: true }),
    budget,
    types: parseDurableKinds(reader.readStringArray(params, "types")),
    tags: normalizeStringArray(reader.readStringArray(params, "tags")),
    asOf: reader.readString(params, "asOf"),
  };
}

/** Parses raw agenr_update parameters through the host's reader boundary. */
export function parseUpdateToolParams(rawParams: unknown, reader: MemoryToolParamReader): UpdateToolParams {
  const params = asRecord(rawParams);
  return {
    id: reader.readString(params, "id"),
    subject: reader.readString(params, "subject"),
    importance: reader.readNumber(params, "importance", { integer: true, strict: true }),
    expiry: parseExpiry(reader.readString(params, "expiry")),
    claimKeyInput: reader.readString(params, "claimKey", { trim: false }),
    validFrom: reader.readString(params, "validFrom"),
    validTo: reader.readString(params, "validTo"),
  };
}

/** Parses raw agenr_fetch parameters through the host's reader boundary. */
export function parseFetchToolParams(rawParams: unknown, reader: MemoryToolParamReader): FetchToolParams {
  const params = asRecord(rawParams);
  return {
    id: reader.readString(params, "id"),
    subject: reader.readString(params, "subject"),
  };
}

/** Executes the host-neutral agenr_store business flow. */
export async function runStoreMemoryTool(
  params: StoreToolParams,
  services: EntryMemoryToolServices,
  options: {
    session: ToolSessionLike & { project?: string };
    sourcePrefix: SessionSourcePrefix;
    defaultSourceContext: string;
    extraDetails?: Record<string, unknown>;
    onWarning?: (warning: string) => void;
  },
): Promise<MemoryToolOutcome> {
  const result = await storeDurablesDetailed(
    [
      {
        type: params.type,
        subject: params.subject,
        content: params.content,
        ...(params.importance !== undefined ? { importance: params.importance } : {}),
        ...(params.expiry !== undefined ? { expiry: params.expiry } : {}),
        ...(params.tags.length > 0 ? { tags: params.tags } : {}),
        ...(params.supersedes ? { supersedes: params.supersedes } : {}),
        ...(params.claimKey
          ? {
              claim_key: params.claimKey,
              claim_key_raw: params.claimKey,
              ...buildToolCallClaimSupport(options.session, options.sourcePrefix, "agenr_store", new Date().toISOString()),
            }
          : {}),
        ...(params.polarity ? { directive_polarity: params.polarity } : {}),
        ...(params.trigger ? { directive_trigger: params.trigger } : {}),
        ...(params.validFrom ? { valid_from: params.validFrom } : {}),
        ...(params.validTo ? { valid_to: params.validTo } : {}),
        source_file: buildSessionSourceFile(options.session, options.sourcePrefix),
        source_context: params.sourceContext ?? options.defaultSourceContext,
        ...(options.session.project ? { project: options.session.project } : {}),
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
      onWarning: options.onWarning,
    },
  );
  const storedEntry = await services.memory.findEntryBySubject(params.subject);

  if (result.stored > 0) {
    return okOutcome(`Stored "${params.subject}".`, {
      status: "stored",
      subject: params.subject,
      entryId: storedEntry?.id,
      result,
      ...options.extraDetails,
    });
  }

  if (result.skipped > 0) {
    return okOutcome(`Skipped "${params.subject}" because an active duplicate already exists.`, {
      status: "skipped",
      subject: params.subject,
      entryId: storedEntry?.id,
      result,
      ...options.extraDetails,
    });
  }

  return failedOutcome(`Rejected "${params.subject}". Check the supplied type, content, and metadata.`, {
    status: "failed",
    subject: params.subject,
    result,
    ...options.extraDetails,
  });
}

/** Executes the host-neutral agenr_recall business flow. */
export async function runRecallMemoryTool(
  params: RecallToolParams,
  services: RecallMemoryToolServices,
  options: {
    sessionKey?: string;
    slotPolicyConfig?: ClaimSlotPolicyConfig;
    debugLog?: (message: string) => void;
  } = {},
): Promise<UnifiedRecallResult> {
  return runUnifiedRecall(
    {
      text: params.query,
      ...(params.mode ? { mode: params.mode } : {}),
      ...(params.limit !== undefined ? { limit: params.limit } : {}),
      ...(params.threshold !== undefined ? { threshold: params.threshold } : {}),
      ...(params.budget !== undefined ? { budget: params.budget } : {}),
      ...(params.types.length > 0 ? { types: params.types } : {}),
      ...(params.tags.length > 0 ? { tags: params.tags } : {}),
      ...(params.asOf ? { asOf: params.asOf } : {}),
      ...(options.sessionKey ? { sessionKey: options.sessionKey } : {}),
    },
    {
      database: services.episodes,
      procedures: services.procedures,
      recall: services.recall,
      embeddingAvailable: services.embeddingStatus.available,
      embeddingError: services.embeddingStatus.error,
      claimSlotPolicyConfig: options.slotPolicyConfig,
      debugLog: options.debugLog,
      embedQuery: services.embedQuery,
      recallOptions: {
        slotPolicyConfig: options.slotPolicyConfig,
      },
    },
  );
}

/** Executes the host-neutral agenr_fetch business flow. */
export async function runFetchMemoryTool(
  params: FetchToolParams,
  services: EntryMemoryToolServices,
  options: {
    extraDetails?: Record<string, unknown>;
  } = {},
): Promise<MemoryToolOutcome> {
  const entry = await resolveTargetDurable(buildEntryMemoryResolverPorts(services), { id: params.id, subject: params.subject });
  assertEntryFetchableContentLength(entry.content);

  return okOutcome(formatFetchedEntryText(entry), buildFetchToolDetails(entry, options.extraDetails));
}

/** Executes the host-neutral agenr_update business flow. */
export async function runUpdateMemoryTool(
  params: UpdateToolParams,
  services: EntryMemoryToolServices,
  options: {
    session: ToolSessionLike;
    sourcePrefix: SessionSourcePrefix;
    successDetails?: Record<string, unknown>;
    failureDetails?: Record<string, unknown>;
  },
): Promise<MemoryToolOutcome> {
  const claimSupport =
    params.claimKeyInput === undefined ? undefined : buildToolCallClaimSupport(options.session, options.sourcePrefix, "agenr_update", new Date().toISOString());
  const normalizedClaimKeyUpdate =
    params.claimKeyInput === undefined
      ? undefined
      : (() => {
          try {
            return normalizeManualClaimKeyUpdate({
              claimKey: params.claimKeyInput,
              rawClaimKey: params.claimKeyInput,
              supportSourceKind: claimSupport?.claim_support_source_kind,
              supportLocator: claimSupport?.claim_support_locator,
              supportObservedAt: claimSupport?.claim_support_observed_at,
              supportMode: claimSupport?.claim_support_mode,
            });
          } catch {
            throw new Error("claimKey must use canonical entity/attribute format.");
          }
        })();
  const entry = await resolveTargetDurable(buildEntryMemoryResolverPorts(services), { id: params.id, subject: params.subject });

  if (
    params.importance === undefined &&
    params.expiry === undefined &&
    normalizedClaimKeyUpdate === undefined &&
    params.validFrom === undefined &&
    params.validTo === undefined
  ) {
    throw new Error("Provide at least one update field: importance, expiry, claimKey, validFrom, or validTo.");
  }

  const mergedValidity = validateTemporalValidityRange(params.validFrom ?? entry.valid_from, params.validTo ?? entry.valid_to);
  if (!mergedValidity.ok) {
    throw new Error(mergedValidity.message);
  }

  const normalizedValidFrom = params.validFrom !== undefined ? mergedValidity.value.validFrom : undefined;
  const normalizedValidTo = params.validTo !== undefined ? mergedValidity.value.validTo : undefined;
  const updated = await services.entries.updateDurable(entry.id, {
    ...(params.importance !== undefined ? { importance: params.importance } : {}),
    ...(params.expiry !== undefined ? { expiry: params.expiry } : {}),
    ...(normalizedClaimKeyUpdate?.updateFields ?? {}),
    ...(params.validFrom !== undefined ? { valid_from: normalizedValidFrom } : {}),
    ...(params.validTo !== undefined ? { valid_to: normalizedValidTo } : {}),
  });

  if (!updated) {
    return failedOutcome(`Entry ${entry.id} is not active, so it could not be updated.`, {
      status: "failed",
      entryId: entry.id,
      ...options.failureDetails,
    });
  }

  return okOutcome(`Updated "${entry.subject}".`, {
    status: "updated",
    entryId: entry.id,
    subject: entry.subject,
    ...(params.importance !== undefined ? { importance: params.importance } : {}),
    ...(params.expiry !== undefined ? { expiry: params.expiry } : {}),
    ...(normalizedClaimKeyUpdate !== undefined ? { claimKey: normalizedClaimKeyUpdate.claimKey } : {}),
    ...(params.validFrom !== undefined ? { validFrom: normalizedValidFrom } : {}),
    ...(params.validTo !== undefined ? { validTo: normalizedValidTo } : {}),
    ...options.successDetails,
  });
}

export { FETCH_TOOL_PARAMETERS, RECALL_TOOL_PARAMETERS, STORE_TOOL_PARAMETERS, UPDATE_TOOL_PARAMETERS };

/**
 * Builds a successful host-neutral memory tool outcome.
 */
function okOutcome(text: string, details: Record<string, unknown>): MemoryToolOutcome {
  return { text, details, failed: false };
}

/**
 * Builds a failed host-neutral memory tool outcome.
 */
function failedOutcome(text: string, details: Record<string, unknown>): MemoryToolOutcome {
  return { text, details, failed: true };
}

function parseDirectivePolarityParam(value: string | undefined): StoreToolParams["polarity"] {
  if (value === undefined) {
    return undefined;
  }

  if (value === "abstain" || value === "proactive") {
    return value;
  }

  throw new Error(`Unsupported directive polarity "${value}".`);
}

function parseDirectiveTriggerParam(value: string | undefined): StoreToolParams["trigger"] {
  if (value === undefined) {
    return undefined;
  }

  const trigger = parseDirectiveTrigger(value);
  if (!trigger) {
    throw new Error(`Unsupported directive trigger "${value}".`);
  }

  return trigger;
}
