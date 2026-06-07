import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";

import { resolveAgentEffectiveModelPrimary, resolveDefaultAgentId } from "openclaw/plugin-sdk/agent-runtime";
import type { EpisodeActivityThreshold } from "../../../app/episode-ingest/activity-threshold.js";
import { createSingleTranscriptDiscoveryPort } from "../../../app/episode-ingest/index.js";
import { HOST_SHUTDOWN_EPISODE_ACTIVITY_THRESHOLD } from "../../shared/shutdown-episode-threshold.js";
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
 * Stable session facts passed into the background episode writer.
 */
export interface OpenClawEpisodeTarget {
  /**
   * Stable session UUID.
   */
  sessionId: string;
  /**
   * Absolute transcript path for the session.
   */
  sessionFile: string;
}

/**
 * Best-effort bounded write for the just-finished OpenClaw session at session end.
 *
 * @param params - Hook context, session target snapshot, shared services, and logger.
 * @returns Promise that resolves after the episode attempt is complete or skipped.
 */
export async function writeOpenClawSessionEndEpisode(params: {
  ctx: AgenrOpenClawHookContext;
  target: OpenClawEpisodeTarget;
  services: AgenrOpenClawServices;
  logger: PluginLogger;
}): Promise<void> {
  await writeOpenClawSessionEpisode({
    ctx: params.ctx,
    target: params.target,
    services: params.services,
    logger: params.logger,
    actionLabel: "session-end episode write",
    sourceSessionId: params.target.sessionId,
    fileField: "file",
    shortCountField: "materialTurns",
    activityThreshold: HOST_SHUTDOWN_EPISODE_ACTIVITY_THRESHOLD,
    embeddingSkipLogContext: `[agenr] session-end episode embedding skipped for ${formatSessionContext(params.ctx.sessionId, params.ctx.sessionKey)} file=${params.target.sessionFile}`,
  });
}

/**
 * Best-effort episode write for the full transcript snapshot captured before compaction.
 *
 * @param params - Hook context, transcript path, shared services, and logger.
 * @returns Promise that resolves after the background episode attempt finishes.
 */
export async function writeOpenClawPreCompactionEpisode(params: {
  ctx: AgenrOpenClawHookContext;
  sessionId: string;
  sessionFile: string;
  messageCount: number;
  services: AgenrOpenClawServices;
  logger: PluginLogger;
}): Promise<void> {
  await writeOpenClawSessionEpisode({
    ctx: params.ctx,
    target: {
      sessionId: params.sessionId,
      sessionFile: params.sessionFile,
    },
    services: params.services,
    logger: params.logger,
    actionLabel: "pre-compaction episode write",
    sourceSessionId: `${params.sessionId}:pre-compaction:${params.messageCount}`,
    fileField: "file",
    shortCountField: "materialTurns",
    embeddingSkipLogContext: `[agenr] pre-compaction episode embedding skipped for ${formatSessionContext(params.ctx.sessionId, params.ctx.sessionKey)} file=${params.sessionFile}`,
  });
}

/**
 * Runs one bounded OpenClaw episode write for a resolved session target.
 *
 * @param params - Session target, labels, shared services, and logger.
 * @returns Promise that resolves after the bounded episode attempt finishes.
 */
async function writeOpenClawSessionEpisode(params: {
  ctx: AgenrOpenClawHookContext;
  target: OpenClawEpisodeTarget;
  services: AgenrOpenClawServices;
  logger: PluginLogger;
  actionLabel: string;
  sourceSessionId: string;
  fileField: "file";
  shortCountField: "materialTurns";
  embeddingSkipLogContext: string;
  activityThreshold?: EpisodeActivityThreshold;
}): Promise<void> {
  const sessionContext = formatSessionContext(params.ctx.sessionId, params.ctx.sessionKey);
  const writeStartedAtMs = Date.now();
  const target = params.target;

  params.logger.info(`[agenr] ${params.actionLabel} triggered for ${sessionContext} ${params.fileField}=${target.sessionFile}`);

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
    filePath: target.sessionFile,
    context: sessionContext,
    actionLabel: params.actionLabel,
    logger: params.logger,
    summaryDeadlineMs,
    fileField: params.fileField,
    shortCountField: params.shortCountField,
    failureModelRef: episodeModel,
    unexpectedFailureLevel: "info",
    ports: {
      files: createSingleTranscriptDiscoveryPort(target.sessionFile),
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
          logContext: params.embeddingSkipLogContext,
        }),
    },
    ingestOptions: {
      genVersion: OPENCLAW_EPISODE_GENERATOR_VERSION,
      skipActiveSessionCheck: true,
      ...(params.activityThreshold ? { activityThreshold: params.activityThreshold } : {}),
      candidateOverrides: {
        sessionId: params.sourceSessionId,
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
 * Resolves the effective model ref for one episode summary request.
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
