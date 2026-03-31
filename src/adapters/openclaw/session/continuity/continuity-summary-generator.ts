import { promises as fs } from "node:fs";
import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";

import { formatOpenClawEmbeddedAgentModel, resolveOpenClawEmbeddedAgentExecution, runOpenClawEmbeddedAgentTextTask } from "../../embedded-agent/task-runner.js";
import { openClawTranscriptParser } from "../../transcript/parser.js";
import type { AgenrOpenClawHost, AgenrOpenClawPluginConfig } from "../../types.js";
import { readOpenClawContinuitySummaryFile, resolveOpenClawContinuitySummaryPath } from "./continuity-summary-reader.js";
import type { OpenClawContinuitySummaryWriteResult } from "./types.js";

const MIN_CONTINUITY_SUMMARY_MESSAGES = 4;
const MAX_CONTINUITY_TRANSCRIPT_CHARS = 14_000;
const CONTINUITY_SUMMARY_TIMEOUT_MS = 30_000;
const CONTINUITY_SUMMARY_SYSTEM_PROMPT = [
  "You write concise narrative continuity summaries that help the next session continue smoothly.",
  "The transcript can be about any domain. Do not assume technical, project, or coding context unless the transcript shows it.",
  "Write 200 to 500 words in plain Markdown with no code fences.",
  "Capture:",
  "- what topics were discussed",
  "- what was learned, decided, agreed on, or corrected",
  "- what remains unfinished, open, or pending",
  "- user preferences, clarifications, and constraints that matter for continuity",
  "- the overall direction or intent of the conversation",
  "Do not replay the transcript turn by turn. Do not invent facts. If something is uncertain, say so briefly.",
].join("\n");

export type { OpenClawContinuitySummaryWriteResult } from "./types.js";

/**
 * Generates a cleaned narrative continuity summary and writes it next to the
 * transcript JSONL file.
 *
 * @param params - Continuity summary dependencies plus the outgoing session
 *   transcript path.
 * @returns Continuity summary outcome facts used by both session continuity
 *   hooks.
 */
export async function generateAndWriteOpenClawContinuitySummary(params: {
  sessionFile: string;
  agentId?: string;
  openClaw: AgenrOpenClawHost;
  logger: PluginLogger;
  pluginConfig?: AgenrOpenClawPluginConfig;
}): Promise<OpenClawContinuitySummaryWriteResult> {
  const sessionFile = params.sessionFile.trim();
  const continuitySummaryPath = resolveOpenClawContinuitySummaryPath(sessionFile, params.logger);
  if (!continuitySummaryPath) {
    return {
      status: "skipped",
      reason: "missing_session_id",
    };
  }

  const parsedTranscript = await openClawTranscriptParser.parseFile(sessionFile);
  const cleanedMessages = parsedTranscript.messages.filter((message) => message.text.trim().length > 0);
  const transcript = renderTranscriptForContinuitySummary(cleanedMessages);
  const normalizedTranscript = capContinuityTranscript(transcript, MAX_CONTINUITY_TRANSCRIPT_CHARS);

  debugLog(
    params.logger,
    "continuity-summary",
    `transcript adapter output for file=${sessionFile}: messages=${cleanedMessages.length} chars=${normalizedTranscript.length}`,
  );

  if (cleanedMessages.length === 0 || normalizedTranscript.length === 0) {
    return {
      status: "skipped",
      reason: "empty",
      continuitySummaryPath,
      messageCount: cleanedMessages.length,
      transcriptChars: normalizedTranscript.length,
    };
  }

  if (cleanedMessages.length < MIN_CONTINUITY_SUMMARY_MESSAGES) {
    return {
      status: "skipped",
      reason: "too_short",
      continuitySummaryPath,
      messageCount: cleanedMessages.length,
      transcriptChars: normalizedTranscript.length,
    };
  }

  const continuitySummaryExecution = resolveOpenClawEmbeddedAgentExecution({
    openClaw: params.openClaw,
    requestedAgentId: params.agentId,
    modelOverride: params.pluginConfig?.continuityModel,
    invalidOverrideLabel: "continuity model override",
  });
  const continuitySummaryModel = formatOpenClawEmbeddedAgentModel(continuitySummaryExecution);
  const prompt = [
    "Produce a concise continuity summary for the next session.",
    "Prefer short paragraphs. Use a short 'Open loops' section only if it adds clarity.",
    "",
    "Transcript:",
    normalizedTranscript,
  ].join("\n");

  debugLog(
    params.logger,
    "continuity-summary",
    `sending continuity summary prompt model=${continuitySummaryModel} promptChars=${prompt.length} transcriptChars=${normalizedTranscript.length}`,
  );
  params.logger.info(
    `[agenr] continuity-summary: using OpenClaw embedded agent provider=${continuitySummaryExecution.provider} model=${continuitySummaryExecution.model} agent=${continuitySummaryExecution.agentId}`,
  );
  debugLog(
    params.logger,
    "continuity-summary",
    `resolved OpenClaw continuity summary model for file=${sessionFile}: agentId=${continuitySummaryExecution.agentId} modelRef=${continuitySummaryExecution.modelRef ?? "default"} provider=${continuitySummaryExecution.provider} model=${continuitySummaryExecution.model}`,
  );

  const startedAt = Date.now();
  try {
    const embeddedAgentResult = await runOpenClawEmbeddedAgentTextTask({
      openClaw: params.openClaw,
      execution: continuitySummaryExecution,
      prompt,
      systemPrompt: CONTINUITY_SUMMARY_SYSTEM_PROMPT,
      timeoutMs: CONTINUITY_SUMMARY_TIMEOUT_MS,
      runIdPrefix: "agenr-continuity-summary",
      sessionKey: "temp:agenr-continuity-summary",
      tempDirPrefix: "agenr-continuity-summary-",
    });
    const durationMs = Date.now() - startedAt;

    if (embeddedAgentResult.status === "unavailable") {
      params.logger.warn?.(`[agenr] continuity-summary: OpenClaw embedded agent runner unavailable for file=${sessionFile}`);
      return {
        status: "skipped",
        reason: "embedded_agent_unavailable",
        continuitySummaryPath,
        messageCount: cleanedMessages.length,
        transcriptChars: normalizedTranscript.length,
        model: continuitySummaryModel,
      };
    }

    if (embeddedAgentResult.status === "timeout") {
      return {
        status: "failed",
        reason: "timeout",
        continuitySummaryPath,
        messageCount: cleanedMessages.length,
        transcriptChars: normalizedTranscript.length,
        model: continuitySummaryModel,
        durationMs,
      };
    }

    if (embeddedAgentResult.status === "empty_response") {
      return {
        status: "failed",
        reason: "empty_response",
        continuitySummaryPath,
        messageCount: cleanedMessages.length,
        transcriptChars: normalizedTranscript.length,
        model: continuitySummaryModel,
        durationMs,
      };
    }

    const normalizedContinuitySummary = normalizeContinuitySummary(embeddedAgentResult.text);

    debugLog(
      params.logger,
      "continuity-summary",
      `received continuity summary response model=${continuitySummaryModel} durationMs=${durationMs} chars=${normalizedContinuitySummary.length}`,
    );

    if (normalizedContinuitySummary.length === 0) {
      return {
        status: "failed",
        reason: "empty_response",
        continuitySummaryPath,
        messageCount: cleanedMessages.length,
        transcriptChars: normalizedTranscript.length,
        model: continuitySummaryModel,
        durationMs,
      };
    }

    const existingContinuitySummary = await readOpenClawContinuitySummaryFile(sessionFile, params.logger);
    if (existingContinuitySummary?.continuitySummaryPath === continuitySummaryPath) {
      debugLog(
        params.logger,
        "continuity-summary",
        `continuity summary file already exists at write time path=${continuitySummaryPath} chars=${existingContinuitySummary.content.length}`,
      );
      return {
        status: "skipped",
        reason: "already_exists",
        continuitySummaryPath,
        content: existingContinuitySummary.content,
        messageCount: cleanedMessages.length,
        transcriptChars: normalizedTranscript.length,
        model: continuitySummaryModel,
        durationMs,
      };
    }

    const continuitySummaryBytes = Buffer.byteLength(`${normalizedContinuitySummary}\n`, "utf8");
    await fs.writeFile(continuitySummaryPath, `${normalizedContinuitySummary}\n`, "utf8");
    debugLog(
      params.logger,
      "continuity-summary",
      `wrote continuity summary file path=${continuitySummaryPath} chars=${normalizedContinuitySummary.length} bytes=${continuitySummaryBytes}`,
    );

    return {
      status: "written",
      continuitySummaryPath,
      content: normalizedContinuitySummary,
      messageCount: cleanedMessages.length,
      transcriptChars: normalizedTranscript.length,
      model: continuitySummaryModel,
      durationMs,
      bytesWritten: continuitySummaryBytes,
    };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    debugLog(params.logger, "continuity-summary", `continuity summary generation error for file=${sessionFile}: ${formatErrorMessage(error)}`);
    return {
      status: "failed",
      reason: formatErrorMessage(error),
      continuitySummaryPath,
      messageCount: cleanedMessages.length,
      transcriptChars: normalizedTranscript.length,
      model: continuitySummaryModel,
      durationMs,
    };
  }
}

/**
 * Renders cleaned transcript messages into a stable continuity summary prompt
 * body.
 *
 * @param messages - Cleaned transcript messages produced by the adapter.
 * @returns Human-readable transcript text for the OpenClaw continuity summary
 *   runner.
 */
export function renderTranscriptForContinuitySummary(messages: Array<{ role: "user" | "assistant"; text: string }>): string {
  return messages.map((message) => `${message.role === "user" ? "User" : "Assistant"}: ${message.text.trim()}`).join("\n");
}

/** Emits debug logs when the plugin logger supports them. */
function debugLog(logger: PluginLogger, subsystem: string, message: string): void {
  logger.debug?.(`[agenr] ${subsystem}: ${message}`);
}

/** Trims model output and removes a duplicated top-level header when present. */
function normalizeContinuitySummary(value: string): string {
  const trimmed = value.trim();
  return trimmed.replace(/^# .+\n+/u, "").trim();
}

/** Formats unknown errors into stable loggable strings. */
function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Caps transcript size while preserving both the beginning and the end. */
function capContinuityTranscript(transcript: string, maxChars: number): string {
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

/** Trims transcript slices at whitespace boundaries for cleaner prompt text. */
function trimToBoundary(value: string, fromStart: boolean): string {
  if (value.length === 0) {
    return value;
  }

  if (fromStart) {
    const boundary = value.search(/\s/);
    return boundary >= 0 ? value.slice(boundary).trimStart() : value.trim();
  }

  const reversedBoundary = value.trimEnd().search(/\s\S*$/u);
  return reversedBoundary >= 0 ? value.slice(0, reversedBoundary).trimEnd() : value.trim();
}
