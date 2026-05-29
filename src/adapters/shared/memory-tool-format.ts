import type { UnifiedRecallResult } from "../../app/recall/index.js";
import type { RecallToolParams, StoreToolParams } from "./memory-tools.js";

const DEFAULT_RECALL_LIMIT = 10;
const RESULT_SUBJECT_LOG_LIMIT = 5;

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
    ...(params.validFrom !== undefined ? { hasValidFrom: true } : {}),
    ...(params.validTo !== undefined ? { hasValidTo: true } : {}),
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
  };
}

/** Formats a concise unified recall summary for info-level logging. */
export function formatUnifiedRecallLogSummary(result: UnifiedRecallResult): string {
  const procedureCount = result.procedureCandidates.length;
  const procedureSummary = result.procedure ? ` [procedure: ${JSON.stringify(truncate(result.procedure.title, 80))}]` : "";
  const entrySubjects = result.entries.map((entry) => entry.entry.subject.trim()).filter((subject) => subject.length > 0);
  const displayed = entrySubjects.slice(0, RESULT_SUBJECT_LOG_LIMIT).map((subject) => JSON.stringify(truncate(subject, 80)));
  const remaining = entrySubjects.length - RESULT_SUBJECT_LOG_LIMIT;
  const suffix = displayed.length === 0 ? "" : ` [entry subjects: ${displayed.join(", ")}${remaining > 0 ? `, ... and ${remaining} more` : ""}]`;
  const entryEpisodeSummary = `${result.episodes.length} episode${result.episodes.length === 1 ? "" : "s"}, ${result.entries.length} entr${
    result.entries.length === 1 ? "y" : "ies"
  }`;
  if (procedureCount === 0 && !result.procedure) {
    return `${entryEpisodeSummary}${suffix}`;
  }

  return `${procedureCount} procedure candidate${procedureCount === 1 ? "" : "s"}, ${entryEpisodeSummary}${procedureSummary}${suffix}`;
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
    projectedEntries: result.projectedEntries.map((entry) => ({
      id: entry.entryId,
      familyKey: entry.familyKey,
      claimKey: entry.claimKey,
      slotPolicy: entry.slotPolicy,
      memoryState: entry.memoryState,
      claimStatus: entry.claimStatus,
      freshness: entry.freshness,
      provenance: entry.provenance,
      whySurfaced: entry.whySurfaced,
    })),
    entryFamilies: result.entryFamilies.map((family) => ({
      familyKey: family.familyKey,
      claimKey: family.claimKey,
      slotPolicy: family.slotPolicy,
      subject: family.subject,
      primaryEntryId: family.primary.entryId,
      entries: family.entries.map((entry) => ({
        id: entry.entryId,
        memoryState: entry.memoryState,
        claimStatus: entry.claimStatus,
      })),
    })),
    claimTransitions: result.claimTransitions,
    notices: result.notices,
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
