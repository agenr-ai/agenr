import path from "node:path";

import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";

/**
 * Derives an OpenClaw session UUID from a session transcript filename.
 *
 * Supports files like `session.jsonl`, `session.jsonl.reset.TIMESTAMP`, and
 * `session.jsonl.deleted.TIMESTAMP`.
 *
 * @param sessionFile - Absolute or relative session transcript path.
 * @param logger - Optional plugin logger used for debug diagnostics.
 * @returns Session UUID stem, or `undefined` when it cannot be derived.
 */
export function deriveOpenClawSessionIdFromFilePath(sessionFile: string, logger?: PluginLogger): string | undefined {
  const normalizedSessionFile = sessionFile.trim();
  if (normalizedSessionFile.length === 0) {
    debugLog(logger, "session-id", "cannot derive session id from empty session file path");
    return undefined;
  }

  const fileName = path.basename(normalizedSessionFile);
  const sessionId = fileName.replace(/\.jsonl(?:\..*)?$/i, "").trim();
  debugLog(logger, "session-id", `derived session id "${sessionId || "<empty>"}" from file=${normalizedSessionFile}`);

  return sessionId.length > 0 ? sessionId : undefined;
}

/** Emits debug logs when the plugin logger supports them. */
function debugLog(logger: PluginLogger | undefined, subsystem: string, message: string): void {
  logger?.debug?.(`[agenr] ${subsystem}: ${message}`);
}
