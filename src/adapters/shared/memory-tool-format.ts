import type { UnifiedRecallResult } from "../../app/recall/index.js";
import type { Durable } from "../../core/types.js";
import type { RecallToolParams, StoreToolParams } from "./memory-tools.js";

const DEFAULT_RECALL_LIMIT = 10;
const RESULT_SUBJECT_LOG_LIMIT = 5;

/**
 * Maximum durable body characters included in agenr_recall previews.
 */
const DURABLE_PREVIEW_MAX_CHARS = 220;

/**
 * Maximum durable body characters returned by agenr_fetch in one tool result.
 */
const DURABLE_FETCH_MAX_CONTENT_CHARS = 32_768;

export { DURABLE_FETCH_MAX_CONTENT_CHARS, DURABLE_PREVIEW_MAX_CHARS };

/**
 * Preview metadata for one recalled durable body.
 */
export interface DurableRecallPreview {
  contentPreview: string;
  contentChars: number;
  previewTruncated: boolean;
}

/**
 * Builds the recall preview slice for one durable body.
 *
 * Full bodies are returned only from agenr_fetch.
 *
 * @param content - Raw stored durable content.
 * @returns Preview text and truncation metadata.
 */
export function buildDurableRecallPreview(content: string): DurableRecallPreview {
  const trimmed = content.trim();
  const previewTruncated = trimmed.length > DURABLE_PREVIEW_MAX_CHARS;

  return {
    contentPreview: previewTruncated ? truncate(trimmed, DURABLE_PREVIEW_MAX_CHARS) : trimmed,
    contentChars: trimmed.length,
    previewTruncated,
  };
}

/**
 * Returns true when any recalled durable preview was truncated in agenr_recall output.
 *
 * @param result - Unified recall result payload.
 * @returns Whether the agent should consider agenr_fetch for full bodies.
 */
export function recallResultHasTruncatedDurablePreviews(result: UnifiedRecallResult): boolean {
  if (result.durables.some((row) => buildDurableRecallPreview(row.durable.content).previewTruncated)) {
    return true;
  }

  return result.durableFamilies.some((family) => family.durables.some((row) => buildDurableRecallPreview(row.recall.durable.content).previewTruncated));
}

/**
 * Validates that one durable body is within the agenr_fetch size limit.
 *
 * @param content - Raw stored durable content.
 * @throws When content exceeds {@link DURABLE_FETCH_MAX_CONTENT_CHARS}.
 */
export function assertDurableFetchableContentLength(content: string): void {
  const contentChars = content.trim().length;
  if (contentChars > DURABLE_FETCH_MAX_CONTENT_CHARS) {
    throw new Error(
      `Durable content is ${contentChars} characters, which exceeds the agenr_fetch limit of ${DURABLE_FETCH_MAX_CONTENT_CHARS}. Use the CLI for full inspection.`,
    );
  }
}

/** Truncates tool text output to avoid oversized results. */
export function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, maxChars - 3).trimEnd()}...`;
}

/** Sanitizes store parameters before debug logging. */
export function sanitizeStoreToolParams(params: StoreToolParams): Record<string, unknown> {
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
    ...(params.polarity !== undefined ? { polarity: params.polarity } : {}),
    ...(params.trigger !== undefined ? { hasTrigger: true } : {}),
    ...(params.validFrom !== undefined ? { hasValidFrom: true } : {}),
    ...(params.validTo !== undefined ? { hasValidTo: true } : {}),
    ...(params.project !== undefined ? { hasProject: true } : {}),
  };
}

/** Formats the visible recall call summary for tool logging. */
export function formatRecallToolSummary(params: RecallToolParams): string {
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

  if (params.budget !== undefined) {
    parts.push(`budget=${params.budget}`);
  }

  return parts.join(" ");
}

/** Sanitizes recall parameters before info logging. */
export function sanitizeRecallToolParams(params: RecallToolParams): Record<string, unknown> {
  return {
    query: params.query,
    ...(params.mode ? { mode: params.mode } : {}),
    ...(params.limit !== undefined ? { limit: params.limit } : {}),
    ...(params.threshold !== undefined ? { threshold: params.threshold } : {}),
    ...(params.types.length > 0 ? { types: params.types } : {}),
    ...(params.tags.length > 0 ? { tags: params.tags } : {}),
    ...(params.asOf ? { asOf: params.asOf } : {}),
    ...(params.budget !== undefined ? { budget: params.budget } : {}),
  };
}

/** Formats a concise unified recall summary for info-level logging. */
export function formatUnifiedRecallLogSummary(result: UnifiedRecallResult): string {
  const procedureCount = result.procedureCandidates.length;
  const procedureSummary = result.procedure ? ` [procedure: ${JSON.stringify(truncate(result.procedure.title, 80))}]` : "";
  const durableSubjects = result.durables.map((row) => row.durable.subject.trim()).filter((subject) => subject.length > 0);
  const displayed = durableSubjects.slice(0, RESULT_SUBJECT_LOG_LIMIT).map((subject) => JSON.stringify(truncate(subject, 80)));
  const remaining = durableSubjects.length - RESULT_SUBJECT_LOG_LIMIT;
  const suffix = displayed.length === 0 ? "" : ` [durable subjects: ${displayed.join(", ")}${remaining > 0 ? `, ... and ${remaining} more` : ""}]`;
  const durableLabel = result.durables.length === 1 ? "durable" : "durables";
  const durableEpisodeSummary = `${result.episodes.length} episode${result.episodes.length === 1 ? "" : "s"}, ${result.durables.length} ${durableLabel}`;
  if (procedureCount === 0 && !result.procedure) {
    return `${durableEpisodeSummary}${suffix}`;
  }

  return `${procedureCount} procedure candidate${procedureCount === 1 ? "" : "s"}, ${durableEpisodeSummary}${procedureSummary}${suffix}`;
}

/** Builds shared structured details for a successful recall result. */
export function buildRecallToolDetails(result: UnifiedRecallResult, extraDetails: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: "ok",
    count: result.count,
    ...extraDetails,
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
      whyMatched: describeEpisodeWhyMatched(episode.scores.semantic, episode.scores.temporal),
    })),
    durables: result.durables.map((row) => {
      const preview = buildDurableRecallPreview(row.durable.content);

      return {
        id: row.durable.id,
        subject: row.durable.subject,
        type: row.durable.type,
        expiry: row.durable.expiry,
        importance: row.durable.importance,
        score: row.score,
        tags: row.durable.tags,
        contentPreview: preview.contentPreview,
        contentChars: preview.contentChars,
        previewTruncated: preview.previewTruncated,
      };
    }),
    projectedDurables: result.projectedDurables.map((row) => {
      const preview = buildDurableRecallPreview(row.recall.durable.content);

      return {
        id: row.durableId,
        familyKey: row.familyKey,
        claimKey: row.claimKey,
        slotPolicy: row.slotPolicy,
        memoryState: row.memoryState,
        claimStatus: row.claimStatus,
        freshness: row.freshness,
        provenance: row.provenance,
        whySurfaced: row.whySurfaced,
        contentPreview: preview.contentPreview,
        contentChars: preview.contentChars,
        previewTruncated: preview.previewTruncated,
      };
    }),
    durableFamilies: result.durableFamilies.map((family) => ({
      familyKey: family.familyKey,
      claimKey: family.claimKey,
      slotPolicy: family.slotPolicy,
      subject: family.subject,
      primaryDurableId: family.primary.durableId,
      durables: family.durables.map((row) => ({
        id: row.durableId,
        memoryState: row.memoryState,
        claimStatus: row.claimStatus,
      })),
    })),
    claimTransitions: result.claimTransitions,
    notices: result.notices,
  };
}

/**
 * Formats one fetched durable for model-visible agenr_fetch output.
 *
 * @param durable - Stored agenr durable.
 * @returns Full durable text with metadata header.
 */
export function formatFetchedDurableText(durable: Durable): string {
  const metadata = [
    `Durable ${durable.id}`,
    `subject=${durable.subject}`,
    `type=${durable.type} importance=${durable.importance} expiry=${durable.expiry} created=${durable.created_at}`,
    durable.claim_key ? `claim_key=${durable.claim_key}` : undefined,
    durable.tags.length > 0 ? `tags=${durable.tags.join(", ")}` : undefined,
    durable.valid_from ? `valid_from=${durable.valid_from}` : undefined,
    durable.valid_to ? `valid_to=${durable.valid_to}` : undefined,
    durable.source_context ? `source_context=${durable.source_context}` : undefined,
  ].filter((value): value is string => value !== undefined);

  return [...metadata, "", durable.content.trim()].join("\n");
}

/**
 * Appends non-fatal pipeline warnings to the agent-visible tool text.
 *
 * @param baseText - Primary success or failure message.
 * @param warnings - Non-fatal warnings collected during tool execution.
 * @returns Combined tool text with a warnings section when needed.
 */
export function formatMemoryToolOutcomeText(baseText: string, warnings: string[]): string {
  if (warnings.length === 0) {
    return baseText;
  }

  const warningLines = warnings.map((warning) => `- ${warning}`).join("\n");
  return `${baseText}\n\nWarnings:\n${warningLines}`;
}

/**
 * Builds optional structured warning details for tool outcomes.
 *
 * @param warnings - Non-fatal warnings collected during tool execution.
 * @returns Details payload fragment when warnings were emitted.
 */
export function buildMemoryToolWarningDetails(warnings: string[]): Record<string, unknown> {
  return warnings.length > 0 ? { warnings } : {};
}

/** Builds shared structured details for a successful fetch result. */
export function buildFetchToolDetails(durable: Durable, extraDetails: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: "ok",
    durableId: durable.id,
    subject: durable.subject,
    type: durable.type,
    importance: durable.importance,
    expiry: durable.expiry,
    tags: durable.tags,
    ...(durable.claim_key ? { claimKey: durable.claim_key } : {}),
    ...(durable.valid_from ? { validFrom: durable.valid_from } : {}),
    ...(durable.valid_to ? { validTo: durable.valid_to } : {}),
    ...(durable.source_context ? { sourceContext: durable.source_context } : {}),
    content: durable.content,
    ...extraDetails,
  };
}

/** Describes why one episodic recall candidate matched the query. */
function describeEpisodeWhyMatched(semanticScore: number, temporalScore: number): string {
  if (semanticScore > 0 && temporalScore > 0) {
    return "Semantic match within the resolved time window.";
  }

  if (semanticScore > 0) {
    return "Semantic match to the episode summary.";
  }

  if (temporalScore > 0) {
    return "Session overlaps the resolved time window.";
  }

  return "Matched episodic recall ranking.";
}
