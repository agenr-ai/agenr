import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";

import { openClawTranscriptParser } from "../../transcript/parser.js";

const RECENT_SESSION_MESSAGE_LIMIT = 6;
const RECENT_SESSION_MAX_CHARS = 1_800;

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
    const tail = transcript.messages.slice(-RECENT_SESSION_MESSAGE_LIMIT);
    const body = capRecentSession(tail.map((message) => `${message.role === "user" ? "U" : "A"}: ${message.text}`).join("\n"), RECENT_SESSION_MAX_CHARS);

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
