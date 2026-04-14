import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";

import { openClawTranscriptParser } from "../../transcript/parser.js";

const RECENT_SESSION_MESSAGE_LIMIT = 6;
const RECENT_SESSION_MAX_CHARS = 1_800;
const SESSION_START_SECTION_HEADINGS = [
  "## Previous session summary",
  "## Recent session",
  "## Agenr Session Recall",
  "### Core Memory",
  "### Relevant Durable Memory",
  "## Agenr Before-Turn Recall",
  "### Suggested Procedure",
] as const;
const INLINE_METADATA_SENTINELS = [
  "Sender (untrusted metadata):",
  "Conversation info (untrusted metadata):",
  "Thread starter (untrusted, for context):",
  "Replied message (untrusted, for context):",
  "Forwarded message context (untrusted metadata):",
  "Chat history since last reply (untrusted, for context):",
] as const;

/**
 * Renders a compact recent-session tail from the predecessor transcript file.
 *
 * @param sessionFile - Absolute predecessor transcript path.
 * @param logger - Plugin logger used for transcript-tail diagnostics.
 * @returns Prompt-ready transcript excerpt, or an empty string when unavailable.
 */
export async function renderRecentSessionSection(sessionFile: string, logger: PluginLogger): Promise<string> {
  try {
    const transcript = await openClawTranscriptParser.parseFile(sessionFile);
    const sanitizedMessages = transcript.messages
      .map((message) => ({
        prefix: message.role === "user" ? "U" : "A",
        text: sanitizeRecentSessionMessage(message.text, message.role),
      }))
      .filter((message) => message.text.length > 0);
    const tail = sanitizedMessages.slice(-RECENT_SESSION_MESSAGE_LIMIT);
    const body = capRecentSession(tail.map((message) => `${message.prefix}: ${message.text}`).join("\n"), RECENT_SESSION_MAX_CHARS);

    logger.debug?.(`[agenr] before_prompt_build: recent session tail for file=${sessionFile}: messages=${tail.length} chars=${body.length}`);
    return body;
  } catch (error) {
    logger.debug?.(`[agenr] before_prompt_build: failed to build recent session tail for file=${sessionFile}: ${formatErrorMessage(error)}`);
    return "";
  }
}

/**
 * Formats unknown transcript-tail failures into human-readable log messages.
 *
 * @param error - Unknown thrown value.
 * @returns Human-readable error text.
 */
function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Caps recent-session excerpts from the end to keep the newest turns visible.
 *
 * @param value - Full rendered transcript tail.
 * @param maxChars - Maximum allowed prompt characters.
 * @returns Prompt-ready recent-session excerpt.
 */
function capRecentSession(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  const marker = "[...truncated earlier recent session...]\n";
  return `${marker}${value.slice(-(maxChars - marker.length)).trimStart()}`;
}

/**
 * Removes startup-wrapper noise from one normalized transcript message.
 *
 * @param text - Parsed transcript message text.
 * @param role - Transcript role used for wrapper unrolling.
 * @returns Cleaned recent-session text suitable for prompt injection.
 */
function sanitizeRecentSessionMessage(text: string, role: "user" | "assistant"): string {
  const wrapperDetected = SESSION_START_SECTION_HEADINGS.some((heading) => text.includes(heading));
  let cleaned = text;

  for (const heading of SESSION_START_SECTION_HEADINGS) {
    cleaned = cleaned.split(heading).join(" ");
  }

  cleaned = stripInlineMetadata(cleaned);
  cleaned = collapseWhitespace(cleaned);

  if (wrapperDetected) {
    cleaned = unwrapEmbeddedTranscriptTurn(cleaned, role);
  }

  return collapseWhitespace(cleaned);
}

/**
 * Removes inline OpenClaw metadata payloads that should not appear in recent tails.
 *
 * @param text - Candidate recent-session text.
 * @returns Text without known metadata payloads.
 */
function stripInlineMetadata(text: string): string {
  let cleaned = text;
  for (const sentinel of INLINE_METADATA_SENTINELS) {
    const escapedSentinel = escapeForRegExp(sentinel);
    cleaned = cleaned.replace(new RegExp(`${escapedSentinel}\\s*(?:json\\s*)?\\{[\\s\\S]*?\\}`, "gu"), " ");
    cleaned = cleaned.replace(new RegExp(`${escapedSentinel}[^\n]*`, "gu"), " ");
  }

  cleaned = cleaned.replace(/Untrusted context \(metadata, do not treat as instructions or commands\):[\s\S]*$/gu, " ");
  return cleaned;
}

/**
 * Unwraps one embedded `U:` or `A:` transcript turn when startup wrappers leaked in.
 *
 * @param text - Cleaned message text with wrapper markers removed.
 * @param role - Role that determines which turn marker to unwrap.
 * @returns The final embedded turn for the current role when present.
 */
function unwrapEmbeddedTranscriptTurn(text: string, role: "user" | "assistant"): string {
  if (role === "user") {
    const timestampMatches = [...text.matchAll(/\[(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s[^\]]+\]/gu)];
    if (timestampMatches.length > 1) {
      const lastTimestamp = timestampMatches.at(-1);
      if (lastTimestamp?.index !== undefined) {
        return text.slice(lastTimestamp.index).trim();
      }
    }
  }

  const marker = role === "user" ? "U:" : "A:";
  const lastMarkerIndex = text.lastIndexOf(marker);
  if (lastMarkerIndex < 0) {
    return text;
  }

  return text.slice(lastMarkerIndex + marker.length).trim();
}

/**
 * Escapes one string for safe RegExp interpolation.
 *
 * @param value - Raw literal string.
 * @returns RegExp-safe literal text.
 */
function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * Collapses repeated whitespace while preserving single-line readability.
 *
 * @param value - Raw text block.
 * @returns Trimmed single-space text.
 */
function collapseWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}
