import { resolveAgentEffectiveModelPrimary, resolveDefaultAgentId } from "openclaw/plugin-sdk/agent-runtime";
import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";

import { ingestEpisodeTranscript, type EpisodeIngestLlmPort, type EpisodeIngestUsageStats } from "../../../app/episode-ingest/index.js";
import type { EmbeddingPort } from "../../../core/ports.js";
import { createOpenClawLlmClient } from "../llm/openclaw-llm-client.js";
import { formatErrorMessage, formatSessionContext } from "../logging.js";
import { openClawTranscriptParser } from "../transcript/parser.js";
import type { AgenrOpenClawHookContext, AgenrOpenClawHost, AgenrOpenClawServices } from "../types.js";
import { OPENCLAW_EPISODE_GENERATOR_VERSION } from "./episode-summary-prompt.js";

const EPISODE_SUMMARY_TIMEOUT_MS = 45_000;
const EPISODE_SUMMARY_TIMEOUT_ERROR_MESSAGE = "Episode summary generation timed out.";
const EPISODE_EMBEDDING_TIMEOUT = Symbol("episode-embedding-timeout");
const EPISODE_EMBEDDING_MIN_HEADROOM_MS = 5_000;

/**
 * Error raised when predecessor episode summary generation exceeds its timeout.
 */
class OpenClawEpisodeSummaryTimeoutError extends Error {
  /**
   * Creates a timeout error with a stable name for caller-side handling.
   */
  public constructor() {
    super(EPISODE_SUMMARY_TIMEOUT_ERROR_MESSAGE);
    this.name = "OpenClawEpisodeSummaryTimeoutError";
  }
}

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

  try {
    const episodeModelRef = resolveOpenClawEpisodeModelRef(params.services.openClaw, params.ctx.agentId, params.services.pluginConfig.episodeModel);
    const episodeModel = episodeModelRef ?? "default";
    const summaryDeadlineMs = writeStartedAtMs + EPISODE_SUMMARY_TIMEOUT_MS;
    const ingestResult = await Promise.race([
      (async () => {
        const summaryLlm = await createOpenClawEpisodeSummaryLlm({
          modelRef: episodeModel,
          openClaw: params.services.openClaw,
          resolvedModelRef: episodeModelRef,
          deadlineMs: summaryDeadlineMs,
        });

        return ingestEpisodeTranscript(
          predecessor.sessionFile,
          {
            files: createSingleTranscriptDiscoveryPort(predecessor.sessionFile),
            transcript: openClawTranscriptParser,
            episodes: params.services.episodes,
            createSummaryLlm: () => summaryLlm,
            embedSummary: createPredecessorEpisodeEmbeddingStrategy({
              embedding: params.services.embedding,
              embeddingAvailable: params.services.embeddingStatus.available,
              logger: params.logger,
              sessionContext,
              predecessorFile: predecessor.sessionFile,
              deadlineMs: summaryDeadlineMs,
            }),
          },
          {
            genVersion: OPENCLAW_EPISODE_GENERATOR_VERSION,
            skipActiveSessionCheck: true,
            candidateOverrides: {
              sessionId: predecessor.sessionId,
              agentId: trimOptionalString(params.ctx.agentId) ?? null,
              surface: resolveSessionSurface(params.ctx) ?? null,
              metadataSource: "registry",
            },
          },
        );
      })(),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new OpenClawEpisodeSummaryTimeoutError()), EPISODE_SUMMARY_TIMEOUT_MS);
      }),
    ]);

    if (ingestResult.kind === "skipped") {
      logSkippedEpisodeIngest(sessionContext, predecessor.sessionFile, ingestResult.skipped, params.logger);
      return;
    }

    if (ingestResult.kind === "invalid") {
      params.logger.info(
        `[agenr] session-start predecessor episode write skipped for ${sessionContext} predecessor=${predecessor.sessionFile} reason=invalid_transcript cleanedMessages=${ingestResult.invalid.messageCount}`,
      );
      return;
    }

    if (ingestResult.session.action === "failed") {
      logFailedEpisodeIngest(sessionContext, predecessor.sessionFile, ingestResult.session.error, episodeModel, params.logger);
      return;
    }

    params.logger.info(
      `[agenr] session-start predecessor episode write ${ingestResult.session.action} for ${sessionContext} predecessor=${predecessor.sessionFile} episode=${ingestResult.session.episodeId}`,
    );
  } catch (error) {
    if (error instanceof OpenClawEpisodeSummaryTimeoutError) {
      params.logger.info(
        `[agenr] session-start predecessor episode write timed_out for ${sessionContext} predecessor=${predecessor.sessionFile} timeoutMs=${EPISODE_SUMMARY_TIMEOUT_MS}`,
      );
      return;
    }

    params.logger.info(
      `[agenr] session-start predecessor episode write failed for ${sessionContext} predecessor=${predecessor.sessionFile} reason=${formatErrorMessage(error)}`,
    );
  }
}

/**
 * Derives the surface identifier from the current session's hook context.
 * Surfaces stay in their own lanes, so the current session's surface is always
 * the predecessor's surface.
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

/**
 * Creates a one-file discovery adapter to satisfy the shared episode-ingest port surface.
 *
 * @param filePath - Transcript file path that should be discovered.
 * @returns Discovery port that always returns the single provided file.
 */
function createSingleTranscriptDiscoveryPort(filePath: string): { discoverFiles: (targetPath: string) => Promise<string[]> } {
  return {
    async discoverFiles(_targetPath: string): Promise<string[]> {
      return [filePath];
    },
  };
}

/**
 * Creates an app-compatible LLM port backed by the lightweight OpenClaw LLM client.
 *
 * @param params - Lightweight LLM dependencies for one episode summary call.
 * @returns LLM port that delegates to the OpenClaw-authenticated client.
 */
async function createOpenClawEpisodeSummaryLlm(params: {
  modelRef: string;
  openClaw: AgenrOpenClawHost;
  resolvedModelRef?: string;
  deadlineMs: number;
}): Promise<EpisodeIngestLlmPort> {
  const llm = await createOpenClawLlmClient(params.openClaw, params.resolvedModelRef, "episode model override");
  const usage = createEmptyUsageStats();
  const completeWithTimeout = async <T>(task: Promise<T>): Promise<T> => {
    usage.calls += 1;
    const remainingMs = Math.max(0, params.deadlineMs - Date.now());
    return Promise.race([
      task,
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new OpenClawEpisodeSummaryTimeoutError()), remainingMs);
      }),
    ]);
  };

  return {
    complete: async (systemPrompt: string, userMessage: string): Promise<string> => completeWithTimeout(llm.complete(systemPrompt, userMessage)),
    completeJson: async <T>(systemPrompt: string, userMessage: string): Promise<T> => {
      return completeWithTimeout(llm.completeJson<T>(systemPrompt, userMessage));
    },
    metadata: {
      modelRef: params.modelRef,
      pricing: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
      usage,
    },
  };
}

/**
 * Creates the host-specific embedding strategy injected into the shared app workflow.
 *
 * @param params - Embedding dependencies and timeout budget facts.
 * @returns Embedding function used by the episode-ingest app service.
 */
function createPredecessorEpisodeEmbeddingStrategy(params: {
  embedding: EmbeddingPort;
  embeddingAvailable: boolean;
  logger: PluginLogger;
  sessionContext: string;
  predecessorFile: string;
  deadlineMs: number;
}): (summary: string) => Promise<number[] | undefined> {
  return async (summary: string): Promise<number[] | undefined> =>
    maybeEmbedEpisodeSummary({
      summary,
      embedding: params.embedding,
      embeddingAvailable: params.embeddingAvailable,
      logger: params.logger,
      sessionContext: params.sessionContext,
      predecessorFile: params.predecessorFile,
      deadlineMs: params.deadlineMs,
    });
}

/**
 * Logs one skipped predecessor-episode ingest outcome.
 *
 * @param sessionContext - Stable current-session identifiers for log output.
 * @param predecessorFile - Absolute predecessor transcript path.
 * @param skipped - Shared app-service skip result.
 * @param logger - Plugin logger used for diagnostics.
 * @returns Nothing.
 */
function logSkippedEpisodeIngest(
  sessionContext: string,
  predecessorFile: string,
  skipped: {
    reason: string;
    messageCount: number;
    existingEpisode?: EpisodeIngestSkipExistingEpisode;
  },
  logger: PluginLogger,
): void {
  if (skipped.reason === "skipped_exists") {
    logger.info(
      `[agenr] session-start predecessor episode write skipped for ${sessionContext} predecessor=${predecessorFile} reason=already_exists episode=${skipped.existingEpisode?.id}`,
    );
    return;
  }

  if (skipped.reason === "skipped_short") {
    logger.info(
      `[agenr] session-start predecessor episode write skipped for ${sessionContext} predecessor=${predecessorFile} reason=too_short cleanedMessages=${skipped.messageCount}`,
    );
    return;
  }

  logger.info(`[agenr] session-start predecessor episode write skipped for ${sessionContext} predecessor=${predecessorFile} reason=${skipped.reason}`);
}

/**
 * Logs one failed predecessor-episode ingest outcome.
 *
 * @param sessionContext - Stable current-session identifiers for log output.
 * @param predecessorFile - Absolute predecessor transcript path.
 * @param error - Shared app-service failure reason.
 * @param episodeModel - Stable episode summary model identifier.
 * @param logger - Plugin logger used for diagnostics.
 * @returns Nothing.
 */
function logFailedEpisodeIngest(sessionContext: string, predecessorFile: string, error: string | undefined, episodeModel: string, logger: PluginLogger): void {
  if (error === EPISODE_SUMMARY_TIMEOUT_ERROR_MESSAGE) {
    logger.info(
      `[agenr] session-start predecessor episode write timed_out for ${sessionContext} predecessor=${predecessorFile} timeoutMs=${EPISODE_SUMMARY_TIMEOUT_MS}`,
    );
    return;
  }

  if (error === "invalid_response") {
    logger.info(
      `[agenr] session-start predecessor episode write failed for ${sessionContext} predecessor=${predecessorFile} reason=invalid_response model=${episodeModel}`,
    );
    return;
  }

  logger.info(`[agenr] session-start predecessor episode write failed for ${sessionContext} predecessor=${predecessorFile} reason=${error ?? "unknown"}`);
}

/**
 * Best-effort inline episode embedding that respects the write timeout budget.
 *
 * @param params - Embedding dependencies and timeout budget facts.
 * @returns Embedding vector, or undefined when unavailable or skipped.
 */
async function maybeEmbedEpisodeSummary(params: {
  summary: string;
  embedding: EmbeddingPort;
  embeddingAvailable: boolean;
  logger: PluginLogger;
  sessionContext: string;
  predecessorFile: string;
  deadlineMs: number;
}): Promise<number[] | undefined> {
  if (!params.embeddingAvailable) {
    params.logger.info(
      `[agenr] session-start predecessor episode embedding skipped for ${params.sessionContext} predecessor=${params.predecessorFile} reason=embedding_unavailable`,
    );
    return undefined;
  }

  const remainingBudgetMs = params.deadlineMs - Date.now();
  if (remainingBudgetMs < EPISODE_EMBEDDING_MIN_HEADROOM_MS) {
    params.logger.info(
      `[agenr] session-start predecessor episode embedding skipped for ${params.sessionContext} predecessor=${params.predecessorFile} reason=budget_tight remainingMs=${Math.max(
        0,
        remainingBudgetMs,
      )}`,
    );
    return undefined;
  }

  try {
    const result = await awaitEmbeddingWithTimeout(params.embedding.embed([params.summary]), remainingBudgetMs);
    if (result === EPISODE_EMBEDDING_TIMEOUT) {
      params.logger.info(
        `[agenr] session-start predecessor episode embedding skipped for ${params.sessionContext} predecessor=${params.predecessorFile} reason=embedding_timeout budgetMs=${remainingBudgetMs}`,
      );
      return undefined;
    }

    const vector = result[0]?.map((value) => (Number.isFinite(value) ? value : 0));
    if (!vector || vector.length === 0) {
      params.logger.info(
        `[agenr] session-start predecessor episode embedding skipped for ${params.sessionContext} predecessor=${params.predecessorFile} reason=empty_embedding`,
      );
      return undefined;
    }

    return vector;
  } catch (error) {
    params.logger.info(
      `[agenr] session-start predecessor episode embedding skipped for ${params.sessionContext} predecessor=${params.predecessorFile} reason=${formatErrorMessage(error)}`,
    );
    return undefined;
  }
}

/**
 * Resolves an embedding request while capping it to the remaining time budget.
 *
 * @param promise - In-flight embedding call.
 * @param timeoutMs - Maximum remaining time budget.
 * @returns Embedding result or the embedding-timeout sentinel.
 */
async function awaitEmbeddingWithTimeout(promise: Promise<number[][]>, timeoutMs: number): Promise<number[][] | typeof EPISODE_EMBEDDING_TIMEOUT> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      resolve(EPISODE_EMBEDDING_TIMEOUT);
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

/**
 * Creates an empty usage snapshot for one episode-summary LLM wrapper.
 *
 * @returns Zeroed usage totals.
 */
function createEmptyUsageStats(): EpisodeIngestUsageStats {
  return {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    totalCost: 0,
  };
}

/**
 * Normalizes an optional string into a trimmed value.
 *
 * @param value - Optional string value.
 * @returns Trimmed string, or undefined when absent.
 */
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

/**
 * Existing-episode facts needed by skip logging.
 */
interface EpisodeIngestSkipExistingEpisode {
  /**
   * Persisted episode identifier.
   */
  id: string;
}
