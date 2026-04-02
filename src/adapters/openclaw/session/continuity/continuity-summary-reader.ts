import * as fs from "node:fs/promises";
import path from "node:path";

import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";
import { deriveOpenClawSessionIdFromFilePath } from "../session-id.js";
import type { OpenClawContinuitySummaryFile } from "./types.js";

export type { OpenClawContinuitySummaryFile } from "./types.js";
export { deriveOpenClawSessionIdFromFilePath } from "../session-id.js";

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
