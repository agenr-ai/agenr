import { promises as fs } from "node:fs";

import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";

import { openClawTranscriptParser } from "../transcript/parser.js";
import type { AgenrOpenClawSummaryClient } from "../types.js";
import { resolveOpenClawSessionSummaryPath } from "./summary-reader.js";

const MIN_SUMMARY_MESSAGES = 4;
const MAX_TRANSCRIPT_CHARS = 14_000;
const SUMMARY_SYSTEM_PROMPT = [
  "You write concise narrative summaries that help the next session continue smoothly.",
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

/**
 * Outcome returned after attempting to write a file-based session summary.
 */
export interface OpenClawSessionSummaryWriteResult {
  /**
   * Final outcome classification for the summary attempt.
   */
  status: "written" | "skipped" | "failed";
  /**
   * Stable skip or failure reason when no file was written.
   */
  reason?: string;
  /**
   * Absolute path to the written summary file.
   */
  summaryPath?: string;
  /**
   * Number of cleaned transcript messages used for summarization.
   */
  messageCount?: number;
  /**
   * Number of cleaned transcript characters sent to the LLM.
   */
  transcriptChars?: number;
  /**
   * Resolved summary model identifier when an LLM call ran.
   */
  model?: string;
  /**
   * End-to-end LLM latency in milliseconds when a call ran.
   */
  durationMs?: number;
  /**
   * Bytes written to the sidecar summary file.
   */
  bytesWritten?: number;
}

/**
 * Generates a cleaned narrative session summary and writes it next to the
 * transcript JSONL file.
 *
 * @param params - Summary dependencies plus the outgoing session transcript path.
 * @returns Summary outcome facts used by the `before_reset` hook.
 */
export async function writeOpenClawSessionSummary(params: {
  sessionFile: string;
  llm: AgenrOpenClawSummaryClient | undefined;
  logger: PluginLogger;
}): Promise<OpenClawSessionSummaryWriteResult> {
  const sessionFile = params.sessionFile.trim();
  const summaryPath = resolveOpenClawSessionSummaryPath(sessionFile, params.logger);
  if (!summaryPath) {
    return {
      status: "skipped",
      reason: "missing_session_id",
    };
  }

  if (!params.llm) {
    return {
      status: "skipped",
      reason: "llm_unavailable",
      summaryPath,
    };
  }

  const parsedTranscript = await openClawTranscriptParser.parseFile(sessionFile);
  const cleanedMessages = parsedTranscript.messages.filter((message) => message.text.trim().length > 0);
  const transcript = renderTranscriptForSummary(cleanedMessages);
  const normalizedTranscript = capTranscript(transcript, MAX_TRANSCRIPT_CHARS);

  debugLog(
    params.logger,
    "summary",
    `transcript adapter output for file=${sessionFile}: messages=${cleanedMessages.length} chars=${normalizedTranscript.length}`,
  );

  if (cleanedMessages.length === 0 || normalizedTranscript.length === 0) {
    return {
      status: "skipped",
      reason: "empty",
      summaryPath,
      messageCount: cleanedMessages.length,
      transcriptChars: normalizedTranscript.length,
    };
  }

  if (cleanedMessages.length < MIN_SUMMARY_MESSAGES) {
    return {
      status: "skipped",
      reason: "too_short",
      summaryPath,
      messageCount: cleanedMessages.length,
      transcriptChars: normalizedTranscript.length,
    };
  }

  const summaryModel = params.llm.metadata.model.id;
  const prompt = [
    "Produce a concise continuity summary for the next session.",
    "Prefer short paragraphs. Use a short 'Open loops' section only if it adds clarity.",
    "",
    "Transcript:",
    normalizedTranscript,
  ].join("\n");

  debugLog(
    params.logger,
    "summary",
    `sending summary prompt model=${summaryModel} promptChars=${prompt.length} transcriptChars=${normalizedTranscript.length}`,
  );

  const startedAt = Date.now();
  try {
    const response = (await params.llm.complete(SUMMARY_SYSTEM_PROMPT, prompt)).trim();
    const durationMs = Date.now() - startedAt;
    const normalizedSummary = normalizeSummary(response);

    debugLog(params.logger, "summary", `received summary response model=${summaryModel} durationMs=${durationMs} chars=${normalizedSummary.length}`);

    if (normalizedSummary.length === 0) {
      return {
        status: "failed",
        reason: "empty_response",
        summaryPath,
        messageCount: cleanedMessages.length,
        transcriptChars: normalizedTranscript.length,
        model: summaryModel,
        durationMs,
      };
    }

    const summaryBytes = Buffer.byteLength(`${normalizedSummary}\n`, "utf8");
    await fs.writeFile(summaryPath, `${normalizedSummary}\n`, "utf8");

    return {
      status: "written",
      summaryPath,
      messageCount: cleanedMessages.length,
      transcriptChars: normalizedTranscript.length,
      model: summaryModel,
      durationMs,
      bytesWritten: summaryBytes,
    };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    debugLog(params.logger, "summary", `summary generation error for file=${sessionFile}: ${formatErrorMessage(error)}`);
    return {
      status: "failed",
      reason: formatErrorMessage(error),
      summaryPath,
      messageCount: cleanedMessages.length,
      transcriptChars: normalizedTranscript.length,
      model: summaryModel,
      durationMs,
    };
  }
}

/**
 * Renders cleaned transcript messages into a stable summary prompt body.
 *
 * @param messages - Cleaned transcript messages produced by the adapter.
 * @returns Human-readable transcript text for the summary LLM.
 */
export function renderTranscriptForSummary(messages: Array<{ role: "user" | "assistant"; text: string }>): string {
  return messages.map((message) => `${message.role === "user" ? "User" : "Assistant"}: ${message.text.trim()}`).join("\n");
}

/** Emits debug logs when the plugin logger supports them. */
function debugLog(logger: PluginLogger, subsystem: string, message: string): void {
  logger.debug?.(`[agenr] ${subsystem}: ${message}`);
}

/** Trims model output and removes a duplicated top-level header when present. */
function normalizeSummary(value: string): string {
  const trimmed = value.trim();
  return trimmed.replace(/^# .+\n+/u, "").trim();
}

/** Formats unknown errors into stable loggable strings. */
function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Caps transcript size while preserving both the beginning and the end. */
function capTranscript(transcript: string, maxChars: number): string {
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
