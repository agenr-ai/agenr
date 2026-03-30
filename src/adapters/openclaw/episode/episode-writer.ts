import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { DEFAULT_MODEL, DEFAULT_PROVIDER, parseModelRef, resolveAgentEffectiveModelPrimary, resolveDefaultAgentId } from "openclaw/plugin-sdk/agent-runtime";
import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";

import { formatErrorMessage, formatSessionContext } from "../logging.js";
import { openClawTranscriptParser } from "../transcript/parser.js";
import type { AgenrOpenClawHookContext, AgenrOpenClawHost, AgenrOpenClawServices } from "../types.js";
import {
  buildOpenClawEpisodeSummaryPrompt,
  OPENCLAW_EPISODE_GENERATOR_VERSION,
  OPENCLAW_EPISODE_SUMMARY_SYSTEM_PROMPT,
  parseOpenClawEpisodeSummaryResponse,
} from "./episode-summary-prompt.js";

const EPISODE_SUMMARY_TIMEOUT_MS = 20_000;
const EPISODE_SUMMARY_TIMEOUT = Symbol("episode-summary-timeout");
const MIN_EPISODE_MESSAGES = 4;
const MAX_EPISODE_TRANSCRIPT_CHARS = 14_000;

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
  if (!params.predecessor) {
    params.logger.info(`[agenr] session-start predecessor episode write skipped for ${sessionContext} reason=no_predecessor`);
    return;
  }

  params.logger.info(`[agenr] session-start predecessor episode write triggered for ${sessionContext} predecessor=${params.predecessor.sessionFile}`);

  try {
    const existingEpisode = await params.services.database.getEpisodeBySourceId("openclaw", params.predecessor.sessionId);
    if (existingEpisode) {
      params.logger.info(
        `[agenr] session-start predecessor episode write skipped for ${sessionContext} predecessor=${params.predecessor.sessionFile} reason=already_exists episode=${existingEpisode.id}`,
      );
      return;
    }

    const parsedTranscript = await openClawTranscriptParser.parseFile(params.predecessor.sessionFile);
    const cleanedMessages = parsedTranscript.messages.filter((message) => message.text.trim().length > 0);
    if (cleanedMessages.length < MIN_EPISODE_MESSAGES) {
      params.logger.info(
        `[agenr] session-start predecessor episode write skipped for ${sessionContext} predecessor=${params.predecessor.sessionFile} reason=too_short cleanedMessages=${cleanedMessages.length}`,
      );
      return;
    }

    const startedAt = parsedTranscript.metadata.startedAt?.trim();
    const endedAt = parsedTranscript.metadata.endedAt?.trim();
    if (!startedAt || !endedAt) {
      params.logger.info(
        `[agenr] session-start predecessor episode write skipped for ${sessionContext} predecessor=${params.predecessor.sessionFile} reason=missing_metadata`,
      );
      return;
    }

    const episodeExecution = resolveEpisodeSummaryExecution(params.services.openClaw, params.ctx.agentId);
    const episodeModel = formatResolvedEpisodeSummaryModel(episodeExecution.provider, episodeExecution.model);
    const transcript = capEpisodeTranscript(renderTranscript(cleanedMessages), MAX_EPISODE_TRANSCRIPT_CHARS);
    const prompt = buildOpenClawEpisodeSummaryPrompt(transcript);
    const response = await generateEpisodeSummaryResponse({
      logger: params.logger,
      model: episodeModel,
      openClaw: params.services.openClaw,
      prompt,
      sessionFile: params.predecessor.sessionFile,
      summaryExecution: episodeExecution,
    });

    if (response === EPISODE_SUMMARY_TIMEOUT) {
      params.logger.info(
        `[agenr] session-start predecessor episode write timed_out for ${sessionContext} predecessor=${params.predecessor.sessionFile} timeoutMs=${EPISODE_SUMMARY_TIMEOUT_MS}`,
      );
      return;
    }

    const structured = parseOpenClawEpisodeSummaryResponse(response);
    if (!structured) {
      params.logger.info(
        `[agenr] session-start predecessor episode write failed for ${sessionContext} predecessor=${params.predecessor.sessionFile} reason=invalid_response model=${episodeModel}`,
      );
      return;
    }

    const writeResult = await params.services.database.upsertEpisode({
      source: "openclaw",
      sourceId: params.predecessor.sessionId,
      sourceRef: params.predecessor.sessionFile,
      transcriptHash: parsedTranscript.metadata.transcriptHash,
      agentId: params.ctx.agentId?.trim(),
      startedAt,
      endedAt,
      summary: structured.summary,
      tags: structured.tags,
      activityLevel: structured.activityLevel,
      project: structured.project,
      genModel: episodeModel,
      genVersion: OPENCLAW_EPISODE_GENERATOR_VERSION,
      messageCount: cleanedMessages.length,
    });

    const actionMessage = writeResult.action === "inserted" ? "written" : writeResult.action === "updated" ? "updated" : "unchanged";
    params.logger.info(
      `[agenr] session-start predecessor episode write ${actionMessage} for ${sessionContext} predecessor=${params.predecessor.sessionFile} episode=${writeResult.episode.id}`,
    );
  } catch (error) {
    params.logger.info(
      `[agenr] session-start predecessor episode write failed for ${sessionContext} predecessor=${params.predecessor.sessionFile} reason=${formatErrorMessage(error)}`,
    );
  }
}

/**
 * Runs the embedded-agent episode summary generation with cleanup and timeout
 * handling.
 *
 * @param params - Execution dependencies for one episode summary call.
 * @returns Structured text response, or a timeout sentinel.
 */
async function generateEpisodeSummaryResponse(params: {
  logger: PluginLogger;
  model: string;
  openClaw: AgenrOpenClawHost;
  prompt: string;
  sessionFile: string;
  summaryExecution: ReturnType<typeof resolveEpisodeSummaryExecution>;
}): Promise<string | typeof EPISODE_SUMMARY_TIMEOUT> {
  const runEmbeddedPiAgent = params.openClaw.runtime.agent.runEmbeddedPiAgent;
  if (typeof runEmbeddedPiAgent !== "function") {
    throw new Error(`embedded_agent_unavailable model=${params.model}`);
  }

  const tempSessionFile = await createTempEpisodeSummarySessionFile();
  try {
    const result = await awaitWithTimeout(
      runEmbeddedPiAgent({
        sessionId: `agenr-episode-summary-${Date.now()}`,
        sessionKey: "temp:agenr-episode-summary",
        agentId: params.summaryExecution.agentId,
        sessionFile: tempSessionFile,
        workspaceDir: params.summaryExecution.workspaceDir,
        agentDir: params.summaryExecution.agentDir,
        config: params.openClaw.config,
        prompt: params.prompt,
        provider: params.summaryExecution.provider,
        model: params.summaryExecution.model,
        timeoutMs: EPISODE_SUMMARY_TIMEOUT_MS,
        runId: `agenr-episode-summary-${Date.now()}`,
        disableTools: true,
        extraSystemPrompt: OPENCLAW_EPISODE_SUMMARY_SYSTEM_PROMPT,
      }),
      EPISODE_SUMMARY_TIMEOUT_MS,
    );

    if (result === EPISODE_SUMMARY_TIMEOUT) {
      return EPISODE_SUMMARY_TIMEOUT;
    }

    const text = extractEmbeddedAgentText(result).trim();
    if (!text) {
      throw new Error(`empty_response model=${params.model}`);
    }

    return text;
  } finally {
    await cleanupTempEpisodeSummarySessionFile(tempSessionFile);
  }
}

/**
 * Resolves the OpenClaw agent/model used for episodic summary generation.
 *
 * @param openClaw - OpenClaw host config and runtime.
 * @param requestedAgentId - Optional active agent identifier.
 * @returns Concrete execution facts for the embedded-agent call.
 */
function resolveEpisodeSummaryExecution(
  openClaw: AgenrOpenClawHost,
  requestedAgentId?: string,
): {
  agentId: string;
  agentDir: string;
  model: string;
  provider: string;
  workspaceDir: string;
} {
  const agentId = requestedAgentId?.trim() || resolveDefaultAgentId(openClaw.config);
  const modelRef = resolveAgentEffectiveModelPrimary(openClaw.config, agentId);
  const parsedModelRef = modelRef ? parseModelRef(modelRef, DEFAULT_PROVIDER) : null;

  return {
    agentId,
    agentDir: openClaw.runtime.agent.resolveAgentDir(openClaw.config, agentId),
    workspaceDir: openClaw.runtime.agent.resolveAgentWorkspaceDir(openClaw.config, agentId),
    provider: parsedModelRef?.provider ?? DEFAULT_PROVIDER,
    model: parsedModelRef?.model ?? DEFAULT_MODEL,
  };
}

/**
 * Formats a provider/model pair as a stable stored identifier.
 *
 * @param provider - Resolved provider name.
 * @param model - Resolved model name.
 * @returns Stable `provider/model` identifier.
 */
function formatResolvedEpisodeSummaryModel(provider: string, model: string): string {
  return `${provider}/${model}`;
}

/**
 * Renders cleaned transcript messages into prompt text for episode generation.
 *
 * @param messages - Cleaned transcript messages.
 * @returns Transcript text with stable role prefixes.
 */
function renderTranscript(messages: Array<{ role: "user" | "assistant"; text: string }>): string {
  return messages.map((message) => `${message.role === "user" ? "User" : "Assistant"}: ${message.text.trim()}`).join("\n");
}

/**
 * Caps transcript text while preserving both the beginning and the end.
 *
 * @param transcript - Full rendered transcript.
 * @param maxChars - Maximum transcript length to keep.
 * @returns Capped transcript text.
 */
function capEpisodeTranscript(transcript: string, maxChars: number): string {
  if (transcript.length <= maxChars) {
    return transcript;
  }

  const omissionMarker = "\n\n[Earlier middle transcript omitted for brevity]\n\n";
  const headBudget = Math.max(0, Math.floor((maxChars - omissionMarker.length) * 0.35));
  const tailBudget = Math.max(0, maxChars - omissionMarker.length - headBudget);
  const head = trimToBoundary(transcript.slice(0, headBudget), false);
  const tail = trimToBoundary(transcript.slice(-tailBudget), true);
  return `${head}${omissionMarker}${tail}`.trim();
}

/**
 * Trims transcript slices at whitespace boundaries for cleaner prompt text.
 *
 * @param value - Transcript slice.
 * @param fromStart - Whether the slice is taken from the tail.
 * @returns Boundary-trimmed transcript text.
 */
function trimToBoundary(value: string, fromStart: boolean): string {
  if (value.length === 0) {
    return value;
  }

  if (fromStart) {
    const boundary = value.search(/\s/u);
    return boundary >= 0 ? value.slice(boundary).trimStart() : value.trim();
  }

  const reversedBoundary = value.trimEnd().search(/\s\S*$/u);
  return reversedBoundary >= 0 ? value.slice(0, reversedBoundary).trimEnd() : value.trim();
}

/**
 * Resolves a promise while allowing the caller to abandon the result after a
 * timeout.
 *
 * @param promise - In-flight embedded-agent call.
 * @param timeoutMs - Maximum wait time in milliseconds.
 * @returns Promise result or the timeout sentinel.
 */
async function awaitWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | typeof EPISODE_SUMMARY_TIMEOUT> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      resolve(EPISODE_SUMMARY_TIMEOUT);
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
 * Creates the temporary session file path required by the embedded-agent API.
 *
 * @returns Absolute temporary session path.
 */
async function createTempEpisodeSummarySessionFile(): Promise<string> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agenr-episode-summary-"));
  return path.join(tempDir, "session.jsonl");
}

/**
 * Removes temporary episode-summary runner state.
 *
 * @param tempEpisodeSummarySessionFile - Temporary session file path.
 * @returns Promise that resolves after cleanup completes.
 */
async function cleanupTempEpisodeSummarySessionFile(tempEpisodeSummarySessionFile: string): Promise<void> {
  try {
    await fs.rm(path.dirname(tempEpisodeSummarySessionFile), {
      recursive: true,
      force: true,
    });
  } catch {
    // Ignore cleanup failures for temporary episode-summary state.
  }
}

/**
 * Extracts the first non-empty text payload returned by the embedded-agent API.
 *
 * @param result - Embedded-agent response payload.
 * @returns First non-empty text body, or an empty string when none exists.
 */
function extractEmbeddedAgentText(result: { payloads?: Array<{ text?: string }> }): string {
  return result.payloads?.find((payload) => payload.text?.trim())?.text ?? "";
}
