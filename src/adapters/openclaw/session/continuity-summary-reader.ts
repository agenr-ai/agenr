import { promises as fs } from "node:fs";
import path from "node:path";

import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";

/**
 * Structured continuity summary lookup facts for one predecessor session.
 */
export interface OpenClawContinuitySummaryFile {
  /**
   * Session UUID derived from the transcript filename.
   */
  sessionId: string;
  /**
   * Absolute path to the sidecar Markdown continuity summary file.
   */
  continuitySummaryPath: string;
  /**
   * Continuity summary Markdown contents.
   */
  content: string;
}

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
    debugLog(logger, "continuity-summary-reader", "cannot derive session id from empty session file path");
    return undefined;
  }

  const fileName = path.basename(normalizedSessionFile);
  const sessionId = fileName.replace(/\.jsonl(?:\..*)?$/i, "").trim();
  debugLog(logger, "continuity-summary-reader", `derived session id "${sessionId || "<empty>"}" from file=${normalizedSessionFile}`);

  return sessionId.length > 0 ? sessionId : undefined;
}

/**
 * Resolves the sidecar Markdown continuity summary path for a session
 * transcript file.
 *
 * @param sessionFile - Absolute or relative session transcript path.
 * @param logger - Optional plugin logger used for debug diagnostics.
 * @returns Absolute continuity summary path, or `undefined` when session ID
 *   derivation fails.
 */
export function resolveOpenClawContinuitySummaryPath(sessionFile: string, logger?: PluginLogger): string | undefined {
  const normalizedSessionFile = sessionFile.trim();
  const sessionId = deriveOpenClawSessionIdFromFilePath(normalizedSessionFile, logger);
  if (!sessionId) {
    return undefined;
  }

  const continuitySummaryPath = path.join(path.dirname(normalizedSessionFile), `${sessionId}.continuity-summary.md`);
  debugLog(logger, "continuity-summary-reader", `resolved continuity summary path for session=${sessionId}: ${continuitySummaryPath}`);
  return continuitySummaryPath;
}

/**
 * Loads a sidecar continuity summary when one exists next to a transcript file.
 *
 * @param sessionFile - Absolute or relative predecessor transcript path.
 * @param logger - Optional plugin logger used for debug diagnostics.
 * @returns Continuity summary lookup facts, or `null` when the file is absent.
 */
export async function readOpenClawContinuitySummaryFile(sessionFile: string, logger?: PluginLogger): Promise<OpenClawContinuitySummaryFile | null> {
  const continuitySummaryPath = resolveOpenClawContinuitySummaryPath(sessionFile, logger);
  const sessionId = deriveOpenClawSessionIdFromFilePath(sessionFile, logger);
  if (!continuitySummaryPath || !sessionId) {
    return null;
  }

  try {
    const continuitySummaryContent = (await fs.readFile(continuitySummaryPath, "utf8")).trim();
    if (continuitySummaryContent.length === 0) {
      debugLog(logger, "continuity-summary-reader", `continuity summary file is empty for session=${sessionId} path=${continuitySummaryPath}`);
      return null;
    }

    debugLog(
      logger,
      "continuity-summary-reader",
      `loaded continuity summary file for session=${sessionId} path=${continuitySummaryPath} chars=${continuitySummaryContent.length}`,
    );
    return {
      sessionId,
      continuitySummaryPath,
      content: continuitySummaryContent,
    };
  } catch (error) {
    if (isFileNotFound(error)) {
      debugLog(logger, "continuity-summary-reader", `continuity summary file missing for session=${sessionId} path=${continuitySummaryPath}`);
      return null;
    }

    throw error;
  }
}

/** Emits debug logs when the plugin logger supports them. */
function debugLog(logger: PluginLogger | undefined, subsystem: string, message: string): void {
  logger?.debug?.(`[agenr] ${subsystem}: ${message}`);
}

/** Detects stable file-not-found failures from Node.js fs calls. */
function isFileNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
