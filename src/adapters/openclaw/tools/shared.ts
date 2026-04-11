import { failedTextResult, readStringParam } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawPluginToolContext, PluginLogger } from "openclaw/plugin-sdk/core";

import type { ClaimCentricRecallEntry, UnifiedRecallMode, UnifiedRecallResult } from "../../../app/recall/index.js";
import { resolveClaimSlotPolicy } from "../../../core/claim-slot-policy.js";
import { ENTRY_TYPES, EXPIRY_LEVELS, type Entry, type EntryType, type Expiry } from "../../../core/types.js";
import type { AgenrOpenClawServices } from "../types.js";

/**
 * Human-readable guidance shown in the store tool schema.
 *
 * @type {string}
 */
export const ENTRY_TYPE_DESCRIPTION =
  "Knowledge type to store. Use fact for durable truth about a person, system, place, or how something works. Use decision for a standing rule, constraint, policy, or chosen approach future sessions should follow - not a progress update or completed action. Use preference for what someone likes, wants, values, or wants avoided. Use lesson for a non-obvious takeaway learned from experience that should change future behavior. Use milestone for a rare one-time event with durable future significance - not ordinary execution progress. Use relationship for a meaningful durable connection between people, groups, or systems.";

/**
 * Human-readable guidance shown in expiry-related tool schemas.
 *
 * @type {string}
 */
export const EXPIRY_DESCRIPTION =
  "Lifetime bucket: core (always injected at session start, use sparingly), permanent (durable and recalled on demand), or temporary (short-horizon).";

/**
 * Human-readable guidance shown in the update tool schema.
 *
 * @type {string}
 */
export const UPDATE_EXPIRY_DESCRIPTION = `${EXPIRY_DESCRIPTION} Accepted values: ${EXPIRY_LEVELS.join(", ")}.`;

/**
 * Default recall limit used when building log summaries.
 *
 * @type {number}
 */
export const DEFAULT_RECALL_LIMIT = 10;

/**
 * Supported recall-mode values accepted by `agenr_recall`.
 *
 * @type {readonly string[]}
 */
export const RECALL_MODES = ["auto", "entries", "episodes"] as const;

const RESULT_SUBJECT_LOG_LIMIT = 5;

/**
 * Resolves exactly one tool target selector into a concrete agenr entry.
 *
 * @param services - OpenClaw service bundle used for entry lookups.
 * @param params - Raw tool parameters.
 * @param options - Optional selector controls.
 * @returns Matching agenr entry.
 */
export async function resolveTargetEntry(
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
    const entry = await services.memory.findMostRecentEntry();
    if (!entry) {
      throw new Error("No agenr entries exist yet.");
    }
    return entry;
  }

  if (id) {
    const entry = (await services.entries.getEntry(id)) ?? (await services.memory.getEntryTrace(id))?.entry;
    if (!entry) {
      throw new Error(`No agenr entry found for id ${id}.`);
    }
    return entry;
  }

  const entry = await services.memory.findEntryBySubject(subject ?? "");
  if (!entry) {
    throw new Error(`No agenr entry found for subject "${subject}".`);
  }

  return entry;
}

/**
 * Parses an optional boolean field from tool params.
 *
 * @param params - Raw tool parameters.
 * @param key - Parameter name to parse.
 * @returns Boolean value, or undefined when absent.
 */
export function readBooleanParam(params: Record<string, unknown>, key: string): boolean | undefined {
  const value = params[key];
  if (value === undefined) {
    return undefined;
  }

  if (typeof value === "boolean") {
    return value;
  }

  throw new Error(`${key} must be a boolean.`);
}

/**
 * Parses optional recall/store type filters into validated agenr entry types.
 *
 * @param values - Candidate entry-type strings.
 * @returns Validated entry types.
 */
export function parseEntryTypes(values: string[] | undefined): EntryType[] {
  return normalizeStringArray(values).map((value) => parseEntryType(value));
}

/**
 * Parses the optional unified recall mode parameter.
 *
 * @param value - Candidate recall mode.
 * @returns Validated recall mode, or undefined when absent.
 */
export function parseRecallMode(value: string | undefined): UnifiedRecallMode | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === "auto" || value === "entries" || value === "episodes") {
    return value;
  }

  throw new Error(`Unsupported recall mode "${value}".`);
}

/**
 * Parses one entry type string into the agenr domain union.
 *
 * @param value - Candidate entry type.
 * @returns Validated entry type.
 */
export function parseEntryType(value: string): EntryType {
  if (ENTRY_TYPES.includes(value as EntryType)) {
    return value as EntryType;
  }

  throw new Error(`Unsupported entry type "${value}".`);
}

/**
 * Parses an optional expiry string into the agenr domain union.
 *
 * @param value - Candidate expiry value.
 * @returns Validated expiry value, or undefined when absent.
 */
export function parseExpiry(value: string | undefined): Expiry | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (EXPIRY_LEVELS.includes(value as Expiry)) {
    return value as Expiry;
  }

  throw new Error(`Unsupported expiry "${value}".`);
}

/**
 * Normalizes optional string arrays by trimming, deduplicating, and dropping empties.
 *
 * @param values - Candidate string values.
 * @returns Normalized string list.
 */
export function normalizeStringArray(values: string[] | undefined): string[] {
  if (!values) {
    return [];
  }

  return Array.from(new Set(values.map((value) => value.trim()).filter((value) => value.length > 0)));
}

/**
 * Builds a stable source-file provenance label from the OpenClaw session context.
 *
 * @param ctx - Tool invocation context.
 * @returns Source-file label for stored entries.
 */
export function buildSessionSourceFile(ctx: OpenClawPluginToolContext): string {
  const target = ctx.sessionKey ?? ctx.sessionId ?? ctx.agentId ?? "unknown";
  return `openclaw-session:${target}`;
}

/**
 * Builds conservative explicit tool-call support metadata for claim-key preservation.
 *
 * @param ctx - Tool invocation context.
 * @param toolName - Tool that carried the explicit claim key.
 * @param observedAt - Observation timestamp to persist alongside the support metadata.
 * @returns Support metadata suitable for explicit manual claim-key paths.
 */
export function buildToolCallClaimSupport(
  ctx: OpenClawPluginToolContext,
  toolName: string,
  observedAt: string,
): Pick<Entry, "claim_support_source_kind" | "claim_support_locator" | "claim_support_observed_at" | "claim_support_mode"> {
  return {
    claim_support_source_kind: "tool_call",
    claim_support_locator: `${buildSessionSourceFile(ctx)}#${toolName}`,
    claim_support_observed_at: observedAt,
    claim_support_mode: "explicit",
  };
}

/**
 * Logs one tool call summary plus sanitized parameters at info level.
 *
 * @param logger - Host logger used for OpenClaw tools.
 * @param toolName - Tool name being invoked.
 * @param ctx - Tool invocation context.
 * @param summary - Human-readable summary text.
 * @param sanitizedParams - Redacted parameter payload for logs.
 * @returns Nothing.
 */
export function logToolCall(
  logger: PluginLogger,
  toolName: string,
  ctx: OpenClawPluginToolContext,
  summary: string,
  sanitizedParams: Record<string, unknown>,
): void {
  logger.info(`[agenr] tool=${toolName} ${formatToolSessionContext(ctx)} ${summary}`);
  logger.info(`[agenr] tool=${toolName} ${formatToolSessionContext(ctx)} params=${JSON.stringify(sanitizedParams)}`);
}

/**
 * Logs a warning when one OpenClaw tool call fails.
 *
 * @param logger - Host logger used for OpenClaw tools.
 * @param toolName - Tool name being invoked.
 * @param ctx - Tool invocation context.
 * @param error - Unknown failure value.
 * @returns Nothing.
 */
export function logToolFailure(logger: PluginLogger, toolName: string, ctx: OpenClawPluginToolContext, error: unknown): void {
  logger.warn(`[agenr] tool=${toolName} ${formatToolSessionContext(ctx)} failed: ${formatErrorMessage(error)}`);
}

/**
 * Formats a compact id-or-subject selector summary for tool call logs.
 *
 * @param id - Optional entry id.
 * @param subject - Optional entry subject.
 * @param last - Optional "last entry" selector.
 * @returns Log-friendly selector description.
 */
export function formatTargetSelector(id?: string, subject?: string, last?: boolean): string {
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

/**
 * Sanitizes store parameters before debug logging.
 *
 * @param params - Parsed store-tool parameters.
 * @returns Redacted log payload.
 */
export function sanitizeStoreToolParams(params: {
  type: EntryType;
  subject: string;
  content: string;
  importance: number | undefined;
  expiry: Expiry | undefined;
  tags: string[];
  sourceContext: string | undefined;
  supersedes: string | undefined;
  claimKey: string | undefined;
  validFrom: string | undefined;
  validTo: string | undefined;
}): Record<string, unknown> {
  return {
    type: params.type,
    subject: params.subject,
    ...(params.importance !== undefined ? { importance: params.importance } : {}),
    ...(params.expiry !== undefined ? { expiry: params.expiry } : {}),
    ...(params.tags.length > 0 ? { tags: params.tags } : {}),
    contentLength: params.content.length,
    ...(params.sourceContext !== undefined ? { sourceContextLength: params.sourceContext.length } : {}),
    ...(params.supersedes !== undefined ? { hasSupersedes: true } : {}),
    ...(params.claimKey !== undefined ? { hasClaimKey: true } : {}),
    ...(params.validFrom !== undefined ? { hasValidFrom: true } : {}),
    ...(params.validTo !== undefined ? { hasValidTo: true } : {}),
  };
}

/**
 * Formats the visible recall call summary for tool logging.
 *
 * @param params - Parsed recall-tool parameters.
 * @returns Log summary string.
 */
export function formatRecallToolSummary(params: {
  query: string;
  mode: UnifiedRecallMode | undefined;
  limit: number | undefined;
  types: EntryType[];
  tags: string[];
  asOf?: string;
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

  if (params.asOf) {
    parts.push(`as_of=${JSON.stringify(params.asOf)}`);
  }

  return parts.join(" ");
}

/**
 * Sanitizes recall parameters before info logging.
 *
 * @param params - Parsed recall-tool parameters.
 * @returns Redacted log payload.
 */
export function sanitizeRecallToolParams(params: {
  query: string;
  mode: UnifiedRecallMode | undefined;
  limit: number | undefined;
  threshold: number | undefined;
  types: EntryType[];
  tags: string[];
  asOf?: string;
}): Record<string, unknown> {
  return {
    query: params.query,
    ...(params.mode ? { mode: params.mode } : {}),
    ...(params.limit !== undefined ? { limit: params.limit } : {}),
    ...(params.threshold !== undefined ? { threshold: params.threshold } : {}),
    ...(params.types.length > 0 ? { types: params.types } : {}),
    ...(params.tags.length > 0 ? { tags: params.tags } : {}),
    ...(params.asOf ? { asOf: params.asOf } : {}),
  };
}

/**
 * Sanitizes retire parameters before debug logging.
 *
 * @param params - Parsed retire-tool parameters.
 * @returns Redacted log payload.
 */
export function sanitizeRetireToolParams(params: { id: string | undefined; subject: string | undefined; reason: string | undefined }): Record<string, unknown> {
  return {
    ...(params.id ? { id: params.id } : {}),
    ...(params.subject ? { subject: params.subject } : {}),
    ...(params.reason !== undefined ? { reasonLength: params.reason.length } : {}),
  };
}

/**
 * Sanitizes update parameters before debug logging.
 *
 * @param params - Parsed update-tool parameters.
 * @returns Redacted log payload.
 */
export function sanitizeUpdateToolParams(params: {
  id: string | undefined;
  subject: string | undefined;
  importance: number | undefined;
  expiry: Expiry | undefined;
  claimKey: string | undefined;
  validFrom: string | undefined;
  validTo: string | undefined;
}): Record<string, unknown> {
  return {
    ...(params.id ? { id: params.id } : {}),
    ...(params.subject ? { subject: params.subject } : {}),
    ...(params.importance !== undefined ? { importance: params.importance } : {}),
    ...(params.expiry !== undefined ? { expiry: params.expiry } : {}),
    ...(params.claimKey !== undefined ? { hasClaimKey: true } : {}),
    ...(params.validFrom !== undefined ? { hasValidFrom: true } : {}),
    ...(params.validTo !== undefined ? { hasValidTo: true } : {}),
  };
}

/**
 * Sanitizes trace parameters before debug logging.
 *
 * @param params - Parsed trace-tool parameters.
 * @returns Redacted log payload.
 */
export function sanitizeTraceToolParams(params: { id: string | undefined; subject: string | undefined; last: boolean | undefined }): Record<string, unknown> {
  return {
    ...(params.id ? { id: params.id } : {}),
    ...(params.subject ? { subject: params.subject } : {}),
    ...(params.last !== undefined ? { last: params.last } : {}),
  };
}

/**
 * Formats unified recall results into sectioned tool-readable text.
 *
 * @param result - Unified recall result payload.
 * @returns Human-readable recall text.
 */
export function formatUnifiedRecallResults(result: UnifiedRecallResult): string {
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

  if (result.asOf) {
    lines.push("As Of");
    lines.push(result.asOf);
    lines.push("");
  }

  const renderEntriesFirst = result.routing.detectedIntent === "historical_state";
  if (renderEntriesFirst) {
    appendEntryMatches(lines, result);
    lines.push("");
    appendClaimTransitions(lines, result);
    lines.push("");
    appendEpisodeMatches(lines, result);
  } else {
    appendEpisodeMatches(lines, result);
    lines.push("");
    appendEntryMatches(lines, result);
    lines.push("");
    appendClaimTransitions(lines, result);
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

/** Append the entry result section in tool-readable text format. */
function appendEntryMatches(lines: string[], result: UnifiedRecallResult): void {
  lines.push("Entry Matches");
  if (result.projectedEntries.length === 0) {
    lines.push("None.");
    return;
  }

  for (const [familyIndex, family] of result.entryFamilies.entries()) {
    lines.push(
      family.claimKey
        ? `Family ${familyIndex + 1}. claim_key=${family.claimKey} | slot_policy=${family.slotPolicy} | primary=${family.primary.entryId} | subject=${family.subject}`
        : `Standalone ${familyIndex + 1}. ${family.primary.entryId} | subject=${family.subject}`,
    );
    for (const [entryIndex, entry] of family.entries.entries()) {
      lines.push(
        `   ${entryIndex + 1}. ${entry.entryId} | ${entry.recall.entry.type} | ${entry.recall.entry.subject} | score ${entry.recall.score.toFixed(2)} | state=${entry.memoryState} | claim_status=${formatClaimStatus(entry.claimStatus)}`,
      );
      lines.push(`      ${truncate(entry.recall.entry.content, 220)}`);
      lines.push(`      freshness=${entry.freshness.label}`);
      const provenance = formatProjectedEntryProvenance(entry);
      if (provenance) {
        lines.push(`      provenance=${provenance}`);
      }
      lines.push(`      why_surfaced=${entry.whySurfaced.summary}`);
    }
  }
}

/** Append the episode result section in tool-readable text format. */
function appendEpisodeMatches(lines: string[], result: UnifiedRecallResult): void {
  lines.push("Episode Matches");
  if (result.episodes.length === 0) {
    lines.push("None.");
    return;
  }

  for (const [index, episode] of result.episodes.entries()) {
    lines.push(
      `${index + 1}. ${episode.episode.id} | ${episode.episode.source} | ${episode.episode.startedAt} -> ${episode.episode.endedAt ?? episode.episode.startedAt} | score ${episode.score.toFixed(2)}`,
    );
    lines.push(`   ${index < 3 ? episode.episode.summary.trim() : truncate(episode.episode.summary.trim(), 220)}`);
    lines.push(`   why_matched=${describeEpisodeMatch(episode)}`);
  }
}

/** Append the compact claim-transition explanation section. */
function appendClaimTransitions(lines: string[], result: UnifiedRecallResult): void {
  lines.push("Claim Transitions");
  if (result.claimTransitions.length === 0) {
    lines.push("None.");
    return;
  }

  for (const [index, transition] of result.claimTransitions.entries()) {
    lines.push(
      `${index + 1}. family=${transition.claimKey ?? transition.familyKey} | slot_policy=${transition.slotPolicy}${transition.currentEntryId ? ` | current=${transition.currentEntryId}` : ""}${
        transition.priorEntryId ? ` | prior=${transition.priorEntryId}` : ""
      }`,
    );
    lines.push(`   ${transition.summary}`);
    if (transition.episodeContext) {
      lines.push(
        `   episode=${transition.episodeContext.episodeId} | ${transition.episodeContext.startedAt} -> ${transition.episodeContext.endedAt ?? transition.episodeContext.startedAt}`,
      );
      lines.push(`   ${truncate(transition.episodeContext.summary.trim(), 220)}`);
    }
  }
}

/**
 * Formats a concise unified recall summary for info-level logging.
 *
 * @param result - Unified recall result payload.
 * @returns Log summary string.
 */
export function formatUnifiedRecallLogSummary(result: UnifiedRecallResult): string {
  const entrySubjects = result.entries.map((entry) => entry.entry.subject.trim()).filter((subject) => subject.length > 0);
  const displayed = entrySubjects.slice(0, RESULT_SUBJECT_LOG_LIMIT).map((subject) => JSON.stringify(truncate(subject, 80)));
  const remaining = entrySubjects.length - RESULT_SUBJECT_LOG_LIMIT;
  const suffix = displayed.length === 0 ? "" : ` [entry subjects: ${displayed.join(", ")}${remaining > 0 ? `, ... and ${remaining} more` : ""}]`;
  return `${result.episodes.length} episode${result.episodes.length === 1 ? "" : "s"}, ${result.entries.length} entr${
    result.entries.length === 1 ? "y" : "ies"
  }${suffix}`;
}

/**
 * Formats the limited Phase 1 provenance view returned by `agenr_trace`.
 *
 * @param entry - Target entry being traced.
 * @param supersededBy - Entry that superseded the target, when present.
 * @param supersedes - Entries superseded by the target.
 * @param recallEvents - Recent recall events linked to the target.
 * @returns Human-readable trace output.
 */
export function formatTrace(
  entry: Entry,
  supersededBy: Entry | undefined,
  supersedes: Entry[],
  claimFamily: { claimKey: string; slotPolicy?: "exclusive" | "multivalued"; entries: Entry[] } | undefined,
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

  if (entry.claim_key) {
    lines.push(`claim_key=${entry.claim_key}`);
  }

  if (claimFamily && claimFamily.entries.length > 0) {
    const slotPolicy = claimFamily.slotPolicy ?? resolveClaimSlotPolicy(claimFamily.claimKey).policy;
    lines.push(
      `claim_family=${claimFamily.claimKey} | slot_policy=${slotPolicy} | ${claimFamily.entries
        .map((item) => `${item.id}:${describeTraceEntryState(item)}:${formatClaimLifecycleLabel(item)}`)
        .join(", ")}`,
    );
    const transitionSummary = summarizeTraceClaimFamilyTransition(claimFamily.entries);
    if (transitionSummary) {
      lines.push(`transition=${transitionSummary}`);
    }
  }

  if (entry.valid_from || entry.valid_to) {
    lines.push(`validity=${entry.valid_from ?? "?"} -> ${entry.valid_to ?? "ongoing"}`);
  }

  if (entry.supersession_kind) {
    lines.push(`supersession_kind=${entry.supersession_kind}${entry.supersession_reason ? ` reason=${truncate(entry.supersession_reason, 120)}` : ""}`);
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

/**
 * Truncates tool text output to avoid oversized results.
 *
 * @param value - Text to truncate.
 * @param maxChars - Maximum character count.
 * @returns Truncated string when needed.
 */
export function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, maxChars - 3).trimEnd()}...`;
}

/**
 * Wraps unexpected tool failures in the standard failed result payload.
 *
 * @param error - Unknown failure value.
 * @returns Standard failed text result payload.
 */
export function toolFailureResult(error: unknown) {
  return failedTextResult(formatErrorMessage(error), {
    status: "failed" as const,
  });
}

/**
 * Normalizes unknown tool failures into human-readable messages.
 *
 * @param error - Unknown failure value.
 * @returns Human-readable error message.
 */
export function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

/**
 * Guards untrusted tool parameters and narrows them to a string-keyed object.
 *
 * @param value - Raw tool parameter payload.
 * @returns Object-like parameter payload.
 */
export function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  throw new Error("Tool parameters must be an object.");
}

/**
 * Formats stable session identifiers for tool-level OpenClaw logs.
 *
 * @param ctx - Tool invocation context.
 * @returns Stable session context string for logs.
 */
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

/**
 * Formats a short explanation for why an episode matched recall.
 *
 * @param result - Matched episodic recall result.
 * @returns Human-readable match explanation.
 */
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

/**
 * Formats the normalized claim-status label for user-facing text output.
 *
 * @param status - Claim-centric lifecycle label.
 * @returns Text label suitable for human-facing output.
 */
function formatClaimStatus(status: ClaimCentricRecallEntry["claimStatus"]): string {
  return status === "no_key" ? "no-key" : status;
}

/**
 * Formats provenance cues for one projected recall row.
 *
 * @param entry - Claim-aware recalled entry.
 * @returns Concise provenance text, or an empty string when none exist.
 */
function formatProjectedEntryProvenance(entry: ClaimCentricRecallEntry): string {
  const parts = [
    entry.provenance.supersededById ? `superseded_by=${entry.provenance.supersededById}` : undefined,
    entry.provenance.supersessionKind ? `kind=${entry.provenance.supersessionKind}` : undefined,
    entry.provenance.supersessionReason ? `reason=${truncate(entry.provenance.supersessionReason, 120)}` : undefined,
    entry.provenance.supportSourceKind ? `support=${entry.provenance.supportSourceKind}` : undefined,
    entry.provenance.supportMode ? `support_mode=${entry.provenance.supportMode}` : undefined,
    entry.provenance.supportObservedAt ? `observed=${entry.provenance.supportObservedAt}` : undefined,
    entry.provenance.supportLocator ? `locator=${truncate(entry.provenance.supportLocator, 120)}` : undefined,
  ].filter((value): value is string => value !== undefined);

  return parts.join(" | ");
}

/**
 * Formats one entry state label for trace lineage output.
 *
 * @param entry - Trace entry to describe.
 * @returns Narrow state label for lineage inspection.
 */
function describeTraceEntryState(entry: Entry): string {
  if (entry.superseded_by) {
    return "superseded";
  }

  if (entry.retired || entry.valid_to) {
    return "historical";
  }

  return "current";
}

/**
 * Formats the claim-key lifecycle label for trace lineage output.
 *
 * @param entry - Trace entry to describe.
 * @returns Lifecycle label used in lineage inspection.
 */
function formatClaimLifecycleLabel(entry: Entry): string {
  if (!entry.claim_key) {
    return "no-key";
  }

  return entry.claim_key_status ?? "legacy";
}

/** Builds a compact change summary from a traced claim family when possible. */
function summarizeTraceClaimFamilyTransition(entries: Entry[]): string | undefined {
  const current = entries.find((entry) => !entry.retired && !entry.superseded_by);
  const prior = [...entries]
    .reverse()
    .find((entry) => entry.id !== current?.id && (entry.superseded_by !== undefined || entry.retired || entry.valid_to !== undefined));
  if (current && prior) {
    return `${prior.id} -> ${current.id}`;
  }
  if (prior) {
    return `${prior.id} is historical with no current sibling in the traced family`;
  }
  if (current) {
    return `${current.id} is the only current sibling in the traced family`;
  }
  return undefined;
}
