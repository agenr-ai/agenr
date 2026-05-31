import { generateEpisodeSummary } from "../../../core/episode/summary-generator.js";
import type { EpisodeIngestPorts } from "../ports.js";
import type {
  EpisodeIngestCandidate,
  EpisodeIngestCandidateOverrides,
  EpisodeIngestExecutionResult,
  EpisodeIngestPlan,
  EpisodeIngestSessionResult,
  EpisodeTranscriptIngestResult,
  ExecuteEpisodeIngestPlanOptions,
  IngestEpisodeTranscriptOptions,
} from "../types.js";
import type { EpisodeSource } from "../../../core/types.js";
import { classifyPreflightTranscript } from "./preflight.js";
import {
  addUsageStats,
  cloneUsageStats,
  createEmptyUsageStats,
  createSerializedExecutor,
  embedEpisodeSummary,
  formatExecutionError,
  trimOptionalString,
} from "./shared.js";

/**
 * Ingests one transcript directly into episodic memory using the shared app workflow.
 *
 * @param filePath - Absolute transcript path to parse and ingest.
 * @param ports - Transcript, database, summary-generation, and embedding ports.
 * @param options - Generator version plus optional host-specific overrides.
 * @returns Single-transcript ingest outcome.
 */
export async function ingestEpisodeTranscript(
  filePath: string,
  ports: EpisodeIngestPorts,
  options: IngestEpisodeTranscriptOptions,
): Promise<EpisodeTranscriptIngestResult> {
  const createSummaryLlm = ports.createSummaryLlm;
  if (!createSummaryLlm) {
    throw new Error("Episode transcript ingest requires createSummaryLlm().");
  }

  const classification = await classifyPreflightTranscript(filePath, ports, {
    referenceNow: options.now ?? new Date(),
    regenerate: options.regenerate === true,
    skipActiveSessionCheck: options.skipActiveSessionCheck === true,
    activityThreshold: options.activityThreshold,
  });
  if (classification.kind === "skipped") {
    return {
      kind: "skipped",
      skipped: classification.value,
    };
  }

  if (classification.kind === "invalid") {
    return {
      kind: "invalid",
      invalid: classification.value,
    };
  }

  const candidate = applyCandidateOverrides(classification.value, options.candidateOverrides);
  const session = await executeEpisodeCandidate(
    candidate,
    createSummaryLlm,
    ports,
    {
      source: options.source ?? DEFAULT_EPISODE_SOURCE,
      genVersion: options.genVersion,
    },
    async <T>(task: () => Promise<T>) => task(),
  );

  return {
    kind: "executed",
    candidate,
    session,
  };
}

/**
 * Executes a Stage 2 plan using concurrency-limited summary generation and serialized writes.
 *
 * @param plan - Precomputed Stage 2 execution plan.
 * @param ports - Episode database and summary-generation client factory.
 * @param options - Concurrency, generator version, and progress reporting options.
 * @returns Aggregate execution results and actual usage totals.
 */
export async function executeEpisodeIngestPlan(
  plan: EpisodeIngestPlan,
  ports: EpisodeIngestPorts,
  options: ExecuteEpisodeIngestPlanOptions,
): Promise<EpisodeIngestExecutionResult> {
  const createSummaryLlm = ports.createSummaryLlm;
  if (!createSummaryLlm) {
    throw new Error("Episode ingest execution requires createSummaryLlm().");
  }

  if (!Number.isFinite(options.concurrency) || Math.trunc(options.concurrency) <= 0) {
    throw new Error(`Episode ingest concurrency must be a positive integer. Received: ${options.concurrency}.`);
  }

  if (plan.candidates.length === 0) {
    return {
      sessions: [],
      usage: createEmptyUsageStats(),
      modelRef: plan.model.modelRef,
      totals: {
        attempted: 0,
        written: 0,
        updated: 0,
        unchanged: 0,
        failed: 0,
      },
    };
  }

  const results = new Array<EpisodeIngestSessionResult>(plan.candidates.length);
  let nextIndex = 0;
  let completed = 0;
  const workerCount = Math.min(Math.trunc(options.concurrency), plan.candidates.length);
  const runSerializedWrite = createSerializedExecutor();

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const currentIndex = nextIndex;
        nextIndex += 1;

        if (currentIndex >= plan.candidates.length) {
          return;
        }

        const candidate = plan.candidates[currentIndex];
        if (!candidate) {
          return;
        }

        const result = await executeEpisodeCandidate(
          candidate,
          createSummaryLlm,
          ports,
          {
            source: options.source ?? DEFAULT_EPISODE_SOURCE,
            genVersion: options.genVersion,
          },
          runSerializedWrite,
        );
        results[currentIndex] = result;

        completed += 1;
        options.onProgress?.(completed, plan.candidates.length, result);
      }
    }),
  );

  const usage = results.reduce((total, result) => addUsageStats(total, result.usage), createEmptyUsageStats());

  return {
    sessions: results,
    usage,
    modelRef: plan.model.modelRef,
    totals: {
      attempted: results.length,
      written: results.filter((result) => result.action === "written").length,
      updated: results.filter((result) => result.action === "updated").length,
      unchanged: results.filter((result) => result.action === "unchanged").length,
      failed: results.filter((result) => result.action === "failed").length,
    },
  };
}

/**
 * Executes one Stage 2 candidate and returns its stable result payload.
 *
 * @param candidate - Candidate selected by the Stage 2 planning pass.
 * @param createSummaryLlm - Factory for per-candidate summary clients.
 * @param ports - Episode-ingest service ports.
 * @param genVersion - Generator version persisted with successful writes.
 * @param runSerializedWrite - Serialized write executor used for database upserts.
 * @returns One stable execution result.
 */
async function executeEpisodeCandidate(
  candidate: EpisodeIngestCandidate,
  createSummaryLlm: NonNullable<EpisodeIngestPorts["createSummaryLlm"]>,
  ports: EpisodeIngestPorts,
  writeOptions: EpisodeCandidateWriteOptions,
  runSerializedWrite: <T>(task: () => Promise<T>) => Promise<T>,
): Promise<EpisodeIngestSessionResult> {
  const startedAt = trimOptionalString(candidate.startedAt) ?? trimOptionalString(candidate.existingEpisode?.startedAt);
  const endedAt = trimOptionalString(candidate.endedAt) ?? trimOptionalString(candidate.existingEpisode?.endedAt);
  if (!startedAt) {
    return {
      action: "failed",
      filePath: candidate.filePath,
      ...(candidate.sessionId ? { sessionId: candidate.sessionId } : {}),
      error: "missing_started_at",
      usage: createEmptyUsageStats(),
    };
  }

  const llm = createSummaryLlm();
  try {
    const structured = await generateEpisodeSummary(candidate.renderedTranscript, llm);
    if (!structured) {
      return {
        action: "failed",
        filePath: candidate.filePath,
        ...(candidate.sessionId ? { sessionId: candidate.sessionId } : {}),
        error: "invalid_response",
        usage: cloneUsageStats(llm.metadata.usage),
      };
    }

    const existingEpisode = candidate.existingEpisode;
    const embedding = await embedEpisodeSummary(structured.summary, ports);
    const writeResult = await runSerializedWrite(async () =>
      ports.episodes.upsertEpisode({
        source: writeOptions.source,
        ...(candidate.sessionId ? { sourceId: candidate.sessionId } : {}),
        sourceRef: candidate.metadataSource === "registry" || !existingEpisode?.sourceRef ? candidate.sourceRef : existingEpisode.sourceRef,
        transcriptHash: candidate.transcriptHash,
        ...((trimOptionalString(candidate.agentId) ?? trimOptionalString(existingEpisode?.agentId))
          ? { agentId: trimOptionalString(candidate.agentId) ?? trimOptionalString(existingEpisode?.agentId) }
          : {}),
        ...((trimOptionalString(candidate.surface) ?? trimOptionalString(existingEpisode?.surface))
          ? { surface: trimOptionalString(candidate.surface) ?? trimOptionalString(existingEpisode?.surface) }
          : {}),
        startedAt,
        ...(endedAt ? { endedAt } : {}),
        summary: structured.summary,
        tags: structured.tags,
        activityLevel: structured.activityLevel,
        ...(structured.project ? { project: structured.project } : {}),
        genModel: llm.metadata.modelRef,
        genVersion: writeOptions.genVersion,
        messageCount: candidate.messageCount,
        ...(embedding ? { embedding } : {}),
      }),
    );

    return {
      action: mapWriteAction(writeResult.action),
      filePath: candidate.filePath,
      ...(candidate.sessionId ? { sessionId: candidate.sessionId } : {}),
      activityLevel: structured.activityLevel,
      episodeId: writeResult.episode.id,
      usage: cloneUsageStats(llm.metadata.usage),
    };
  } catch (error) {
    return {
      action: "failed",
      filePath: candidate.filePath,
      ...(candidate.sessionId ? { sessionId: candidate.sessionId } : {}),
      error: formatExecutionError(error),
      usage: cloneUsageStats(llm.metadata.usage),
    };
  }
}

/** Default source retained for existing OpenClaw ingest callers. */
const DEFAULT_EPISODE_SOURCE: EpisodeSource = "openclaw";

/** Source-specific write options for one episode candidate. */
interface EpisodeCandidateWriteOptions {
  /** Episode source persisted with the row. */
  source: EpisodeSource;
  /** Generator version persisted with the row. */
  genVersion: string;
}

/**
 * Applies host-specific metadata overrides to one prepared candidate.
 *
 * @param candidate - Transcript-derived candidate produced by classification.
 * @param overrides - Optional override fields supplied by the caller.
 * @returns Candidate copy with the requested overrides applied.
 */
function applyCandidateOverrides(candidate: EpisodeIngestCandidate, overrides: EpisodeIngestCandidateOverrides | undefined): EpisodeIngestCandidate {
  if (!overrides) {
    return candidate;
  }

  return {
    ...candidate,
    ...(overrides.sessionId !== undefined ? { sessionId: overrides.sessionId } : {}),
    ...(overrides.sourceRef !== undefined ? { sourceRef: overrides.sourceRef } : {}),
    ...("agentId" in overrides ? { agentId: overrides.agentId ?? null } : {}),
    ...("surface" in overrides ? { surface: overrides.surface ?? null } : {}),
    ...(overrides.metadataSource !== undefined ? { metadataSource: overrides.metadataSource } : {}),
  };
}

/**
 * Maps database upsert actions into Stage 2 session-result actions.
 *
 * @param action - Raw database action.
 * @returns User-facing Stage 2 action.
 */
function mapWriteAction(action: "inserted" | "updated" | "unchanged"): "written" | "updated" | "unchanged" {
  if (action === "inserted") {
    return "written";
  }

  return action;
}
