import type { ExtensionContext } from "skeln";

import { resolveEpisodeActivityEligibility, type EpisodeActivityThreshold } from "../../../app/episode-ingest/activity-threshold.js";
import { createSingleTranscriptDiscoveryPort } from "../../../app/episode-ingest/index.js";
import { countMaterialTranscriptTurns } from "../../../core/episode/transcript-render.js";
import type { ParsedTranscript } from "../../../core/types.js";
import { createAgenrEpisodeSummaryLlm } from "../../shared/agenr-episode-summary-llm.js";
import { embedEpisodeSummaryWithinBudget } from "../../shared/bounded-episode-embedding.js";
import { writeBoundedSingleTranscriptEpisode } from "../../shared/bounded-episode-write.js";
import { createDeadlineAwareEpisodeSummaryLlm } from "../../shared/deadline-aware-episode-summary-llm.js";
import { EPISODE_SUMMARY_TIMEOUT_MS } from "../../shared/bounded-episode-summary.js";
import { resolveLlmApiKey, resolveModel } from "../../llm.js";
import type { AgenrSkelnServices } from "../runtime.js";
import { skelnTranscriptParser } from "../transcript/parser.js";

const SKELN_EPISODE_GENERATOR_VERSION = "skeln-episodic-summary-v1";

/** Skeln shutdown episode activity gate from the Phase 4 lifecycle contract. */
const SKELN_PHASE4_SHUTDOWN_EPISODE_ACTIVITY_THRESHOLD: EpisodeActivityThreshold = {
  minMaterialTurns: 8,
  minDurationMs: 20 * 60 * 1000,
};

/**
 * Best-effort bounded Skeln episode write for a completed session.
 *
 * @param params - Host context, shared services, and optional logger.
 * @returns Promise that resolves after the episode attempt is complete or skipped.
 */
export async function writeSkelnShutdownEpisode(params: {
  context: ExtensionContext;
  services: AgenrSkelnServices;
  logger?: Pick<Console, "info" | "warn">;
}): Promise<void> {
  const logger = params.logger ?? console;
  const sessionFile = resolveSessionFile(params.context);
  const sessionId = String(params.context.sessionManager.getSessionId());
  const summaryDeadlineMs = Date.now() + EPISODE_SUMMARY_TIMEOUT_MS;

  if (!sessionFile) {
    logger.info(`[agenr] skeln shutdown episode write skipped for session=${sessionId} reason=no_session_file`);
    return;
  }

  const context = `session=${sessionId} key=skeln:${sessionId}`;
  const episodeModel = resolveModel(params.services.agenrConfig, "episode");
  const llmApiKey = resolveLlmApiKey(params.services.agenrConfig, episodeModel.provider);
  const summaryLlm = createDeadlineAwareEpisodeSummaryLlm(
    createAgenrEpisodeSummaryLlm(episodeModel.provider, episodeModel.modelId, llmApiKey),
    summaryDeadlineMs,
  );

  await writeBoundedSingleTranscriptEpisode({
    filePath: sessionFile,
    context,
    actionLabel: "skeln shutdown episode write",
    logger,
    summaryDeadlineMs,
    ports: {
      files: createSingleTranscriptDiscoveryPort(sessionFile),
      transcript: skelnTranscriptParser,
      episodes: params.services.episodes,
      createSummaryLlm: () => summaryLlm,
      embedSummary: (summary) =>
        embedEpisodeSummaryWithinBudget({
          summary,
          embedding: params.services.embedding,
          embeddingAvailable: params.services.embeddingStatus.available,
          deadlineMs: summaryDeadlineMs,
          logger,
          logContext: `[agenr] skeln shutdown episode embedding skipped for ${context} file=${sessionFile}`,
        }),
    },
    ingestOptions: {
      source: "skeln",
      genVersion: SKELN_EPISODE_GENERATOR_VERSION,
      skipActiveSessionCheck: true,
      activityThreshold: SKELN_PHASE4_SHUTDOWN_EPISODE_ACTIVITY_THRESHOLD,
      candidateOverrides: {
        sessionId,
        sourceRef: sessionFile,
        agentId: null,
        surface: "skeln",
        metadataSource: "reconstructed",
      },
    },
  });
}

/** Eligibility facts returned by Skeln shutdown activity threshold evaluation. */
export type SkelnShutdownEpisodeEligibility = ReturnType<typeof resolveSkelnShutdownEpisodeEligibility>;

/**
 * Resolves phase 4 activity thresholds for optional shutdown episode writes.
 *
 * @param transcript - Parsed Skeln transcript.
 * @returns Eligibility decision and threshold facts.
 */
export function resolveSkelnShutdownEpisodeEligibility(transcript: ParsedTranscript) {
  return resolveEpisodeActivityEligibility(
    countMaterialTranscriptTurns(transcript.messages),
    transcript.metadata.startedAt,
    transcript.metadata.endedAt,
    SKELN_PHASE4_SHUTDOWN_EPISODE_ACTIVITY_THRESHOLD,
  );
}

/** Resolves the current Skeln session file from the extension context. */
function resolveSessionFile(context: ExtensionContext): string | undefined {
  try {
    const sessionFile = context.sessionManager.getSessionFile().trim();
    return sessionFile || undefined;
  } catch {
    return undefined;
  }
}
