import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";

import { resolveAgentEffectiveModelPrimary, resolveDefaultAgentId } from "openclaw/plugin-sdk/agent-runtime";
import { createSingleTranscriptDiscoveryPort } from "../../../app/episode-ingest/index.js";
import { createDeadlineAwareEpisodeSummaryLlm } from "../../shared/deadline-aware-episode-summary-llm.js";
import { embedEpisodeSummaryWithinBudget } from "../../shared/bounded-episode-embedding.js";
import { EPISODE_SUMMARY_TIMEOUT_MS } from "../../shared/bounded-episode-summary.js";
import { writeBoundedSingleTranscriptEpisode } from "../../shared/bounded-episode-write.js";
import { createOpenClawLlmClient } from "../llm/openclaw-llm-client.js";
import { formatSessionContext } from "../logging.js";
import { openClawTranscriptParser } from "../transcript/parser.js";
import type { AgenrOpenClawHookContext, AgenrOpenClawHost, AgenrOpenClawServices } from "../types.js";
import { OPENCLAW_EPISODE_GENERATOR_VERSION } from "./episode-summary-prompt.js";

/**
 * Predecessor episode facts passed from the continuity resolver into the
 * background episode writer.
 */
export interface OpenClawPredecessorEpisodeTarget {
  /**
   * Stable predecessor session UUID.
   */
  sessionId: string;
  /**
   * Absolute predecessor transcript path.
   */
  sessionFile: string;
}

/**
 * Best-effort background write for one predecessor OpenClaw session.
 *
 * The function never throws. It logs all outcomes and returns once the
 * episodic-memory attempt is fully handled.
 *
 * @param params - Hook context, predecessor facts, shared services, and logger.
 * @returns Promise that resolves after the background episode attempt finishes.
 */
export async function writeOpenClawPredecessorEpisode(params: {
  ctx: AgenrOpenClawHookContext;
  predecessor?: OpenClawPredecessorEpisodeTarget;
  services: AgenrOpenClawServices;
  logger: PluginLogger;
}): Promise<void> {
  const sessionContext = formatSessionContext(params.ctx.sessionId, params.ctx.sessionKey);
  const writeStartedAtMs = Date.now();
  if (!params.predecessor) {
    params.logger.info(`[agenr] session-start predecessor episode write skipped for ${sessionContext} reason=no_predecessor`);
    return;
  }
  const predecessor = params.predecessor;

  params.logger.info(`[agenr] session-start predecessor episode write triggered for ${sessionContext} predecessor=${predecessor.sessionFile}`);

  const episodeModelRef = resolveOpenClawEpisodeModelRef(params.services.openClaw, params.ctx.agentId, params.services.pluginConfig.episodeModel);
  const episodeModel = episodeModelRef ?? "default";
  const summaryDeadlineMs = writeStartedAtMs + EPISODE_SUMMARY_TIMEOUT_MS;
  const llm = await createOpenClawLlmClient(params.services.openClaw, episodeModelRef, "episode model override");
  const summaryLlm = createDeadlineAwareEpisodeSummaryLlm(
    {
      complete: llm.complete.bind(llm),
      completeJson: llm.completeJson.bind(llm),
      metadata: {
        modelRef: episodeModel,
        pricing: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
        },
        usage: {
          calls: 0,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 0,
          totalCost: 0,
        },
      },
    },
    summaryDeadlineMs,
  );

  await writeBoundedSingleTranscriptEpisode({
    filePath: predecessor.sessionFile,
    context: sessionContext,
    actionLabel: "session-start predecessor episode write",
    logger: params.logger,
    summaryDeadlineMs,
    fileField: "predecessor",
    shortCountField: "cleanedMessages",
    failureModelRef: episodeModel,
    unexpectedFailureLevel: "info",
    ports: {
      files: createSingleTranscriptDiscoveryPort(predecessor.sessionFile),
      transcript: openClawTranscriptParser,
      episodes: params.services.episodes,
      createSummaryLlm: () => summaryLlm,
      embedSummary: (summary) =>
        embedEpisodeSummaryWithinBudget({
          summary,
          embedding: params.services.embedding,
          embeddingAvailable: params.services.embeddingStatus.available,
          deadlineMs: summaryDeadlineMs,
          logger: params.logger,
          logContext: `[agenr] session-start predecessor episode embedding skipped for ${sessionContext} predecessor=${predecessor.sessionFile}`,
        }),
    },
    ingestOptions: {
      genVersion: OPENCLAW_EPISODE_GENERATOR_VERSION,
      skipActiveSessionCheck: true,
      candidateOverrides: {
        sessionId: predecessor.sessionId,
        agentId: trimOptionalString(params.ctx.agentId) ?? null,
        surface: resolveSessionSurface(params.ctx) ?? null,
        metadataSource: "registry",
      },
    },
  });
}

/**
 * Derives the surface identifier from the current session's hook context.
 *
 * @param ctx - Active OpenClaw hook context.
 * @returns Normalized surface identifier, or undefined when unavailable.
 */
function resolveSessionSurface(ctx: AgenrOpenClawHookContext): string | undefined {
  const sessionKey = ctx.sessionKey?.trim() ?? "";
  if (/^agent:[^:]+:tui/i.test(sessionKey)) {
    return "tui";
  }

  const provider = ctx.messageProvider?.trim();
  if (provider) {
    return provider.toLowerCase();
  }

  return undefined;
}

/** Normalizes an optional string into a trimmed value. */
function trimOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Resolves the effective model ref for one predecessor episode summary request.
 *
 * @param openClaw - OpenClaw host config and runtime helpers.
 * @param agentId - Optional active agent id from the current hook context.
 * @param modelOverride - Optional plugin-config override for episode summaries.
 * @returns Explicit model ref when one is configured, otherwise `undefined`.
 */
function resolveOpenClawEpisodeModelRef(openClaw: AgenrOpenClawHost, agentId: string | undefined, modelOverride: string | undefined): string | undefined {
  const requestedOverride = trimOptionalString(modelOverride);
  if (requestedOverride) {
    return requestedOverride;
  }

  const resolvedAgentId = trimOptionalString(agentId) ?? resolveDefaultAgentId(openClaw.config);
  return resolveAgentEffectiveModelPrimary(openClaw.config, resolvedAgentId) ?? undefined;
}
