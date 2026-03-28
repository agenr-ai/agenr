import { promises as fs } from "node:fs";
import path from "node:path";

import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";

/**
 * Structured summary-file lookup facts for one predecessor session.
 */
export interface OpenClawSessionSummaryFile {
  /**
   * Session UUID derived from the transcript filename.
   */
  sessionId: string;
  /**
   * Absolute path to the sidecar Markdown summary file.
   */
  summaryPath: string;
  /**
   * Summary Markdown contents.
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
    debugLog(logger, "summary-reader", "cannot derive session id from empty session file path");
    return undefined;
  }

  const fileName = path.basename(normalizedSessionFile);
  const sessionId = fileName.replace(/\.jsonl(?:\..*)?$/i, "").trim();
  debugLog(logger, "summary-reader", `derived session id "${sessionId || "<empty>"}" from file=${normalizedSessionFile}`);

  return sessionId.length > 0 ? sessionId : undefined;
}

/**
 * Resolves the sidecar Markdown summary path for a session transcript file.
 *
 * @param sessionFile - Absolute or relative session transcript path.
 * @param logger - Optional plugin logger used for debug diagnostics.
 * @returns Absolute summary path, or `undefined` when session ID derivation fails.
 */
export function resolveOpenClawSessionSummaryPath(sessionFile: string, logger?: PluginLogger): string | undefined {
  const normalizedSessionFile = sessionFile.trim();
  const sessionId = deriveOpenClawSessionIdFromFilePath(normalizedSessionFile, logger);
  if (!sessionId) {
    return undefined;
  }

  const summaryPath = path.join(path.dirname(normalizedSessionFile), `${sessionId}.summary.md`);
  debugLog(logger, "summary-reader", `resolved summary path for session=${sessionId}: ${summaryPath}`);
  return summaryPath;
}

/**
 * Loads a sidecar session summary when one exists next to a transcript file.
 *
 * @param sessionFile - Absolute or relative predecessor transcript path.
 * @param logger - Optional plugin logger used for debug diagnostics.
 * @returns Summary lookup facts, or `null` when the file is absent.
 */
export async function readOpenClawSessionSummaryFile(sessionFile: string, logger?: PluginLogger): Promise<OpenClawSessionSummaryFile | null> {
  const summaryPath = resolveOpenClawSessionSummaryPath(sessionFile, logger);
  const sessionId = deriveOpenClawSessionIdFromFilePath(sessionFile, logger);
  if (!summaryPath || !sessionId) {
    return null;
  }

  try {
    const content = (await fs.readFile(summaryPath, "utf8")).trim();
    if (content.length === 0) {
      debugLog(logger, "summary-reader", `summary file is empty for session=${sessionId} path=${summaryPath}`);
      return null;
    }

    debugLog(logger, "summary-reader", `loaded summary file for session=${sessionId} path=${summaryPath} chars=${content.length}`);
    return {
      sessionId,
      summaryPath,
      content,
    };
  } catch (error) {
    if (isFileNotFound(error)) {
      debugLog(logger, "summary-reader", `summary file missing for session=${sessionId} path=${summaryPath}`);
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
