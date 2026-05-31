import type { ExtensionContext } from "skeln";

import type { EpisodeActivityThreshold } from "../../../app/episode-ingest/activity-threshold.js";
import { createSingleTranscriptDiscoveryPort } from "../../../app/episode-ingest/index.js";
import { createAgenrEpisodeSummaryLlm } from "../../shared/agenr-episode-summary-llm.js";
import { embedEpisodeSummaryWithinBudget } from "../../shared/bounded-episode-embedding.js";
import { writeBoundedSingleTranscriptEpisode } from "../../shared/bounded-episode-write.js";
import { createDeadlineAwareEpisodeSummaryLlm } from "../../shared/deadline-aware-episode-summary-llm.js";
import { EPISODE_SUMMARY_TIMEOUT_MS } from "../../shared/bounded-episode-summary.js";
import { resolveLlmApiKey, resolveModel } from "../../llm.js";
import type { AgenrSkelnServices } from "../runtime.js";
import { skelnTranscriptParser } from "../transcript/parser.js";

/** Parameters for one bounded Skeln session transcript episode write. */
export interface WriteSkelnBoundedSessionEpisodeParams {
  /** Active Skeln extension context. */
  context: ExtensionContext;
  /** Shared Skeln runtime services. */
  services: AgenrSkelnServices;
  /** Human-readable action label used by bounded ingest logging. */
  actionLabel: string;
  /** Episode generator version persisted on the written episode. */
  genVersion: string;
  /** Activity gate applied before summary generation. */
  activityThreshold: EpisodeActivityThreshold;
  /** Builds the provenance source reference from the resolved session file path. */
  buildSourceRef: (sessionFile: string) => string;
  /** Structured context string passed to bounded ingest logging. */
  logContext: string;
  /** Details appended to the skip log when no session file is available. */
  skipDetails: string;
  /** Optional logger override for tests. */
  logger?: Pick<Console, "info" | "warn">;
}

/**
 * Best-effort bounded episode write for one Skeln session transcript file.
 *
 * @param params - Host context, services, and episode-write configuration.
 * @returns Promise that resolves after the attempt is complete or skipped.
 */
export async function writeSkelnBoundedSessionEpisode(params: WriteSkelnBoundedSessionEpisodeParams): Promise<void> {
  const logger = params.logger ?? console;
  const sessionFile = resolveSessionFile(params.context);
  const sessionId = String(params.context.sessionManager.getSessionId());
  const summaryDeadlineMs = Date.now() + EPISODE_SUMMARY_TIMEOUT_MS;

  if (!sessionFile) {
    logger.info(`[agenr] ${params.actionLabel} skipped for ${params.skipDetails} reason=no_session_file`);
    return;
  }

  const episodeModel = resolveModel(params.services.agenrConfig, "episode");
  const llmApiKey = resolveLlmApiKey(params.services.agenrConfig, episodeModel.provider);
  const summaryLlm = createDeadlineAwareEpisodeSummaryLlm(
    createAgenrEpisodeSummaryLlm(episodeModel.provider, episodeModel.modelId, llmApiKey),
    summaryDeadlineMs,
  );

  await writeBoundedSingleTranscriptEpisode({
    filePath: sessionFile,
    context: params.logContext,
    actionLabel: params.actionLabel,
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
          logContext: `[agenr] ${params.actionLabel} embedding skipped for ${params.logContext} file=${sessionFile}`,
        }),
    },
    ingestOptions: {
      source: "skeln",
      genVersion: params.genVersion,
      skipActiveSessionCheck: true,
      activityThreshold: params.activityThreshold,
      candidateOverrides: {
        sessionId,
        sourceRef: params.buildSourceRef(sessionFile),
        agentId: null,
        surface: "skeln",
        metadataSource: "reconstructed",
      },
    },
  });
}

/** Resolves the current Skeln session file from the extension context. */
export function resolveSessionFile(context: ExtensionContext): string | undefined {
  try {
    const sessionFile = context.sessionManager.getSessionFile().trim();
    return sessionFile || undefined;
  } catch {
    return undefined;
  }
}
