import { promises as fs } from "node:fs";
import path from "node:path";

import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";

/**
 * One normalized `sessions.json` entry from the OpenClaw session store.
 */
export interface OpenClawSessionsStoreEntry {
  /**
   * Stable OpenClaw session key used as the object key in `sessions.json`.
   */
  sessionKey: string;
  /**
   * Ephemeral OpenClaw session UUID when present.
   */
  sessionId?: string;
  /**
   * Absolute path to the session JSONL file when present.
   */
  sessionFile?: string;
  /**
   * Last-activity timestamp in Unix milliseconds when present.
   */
  updatedAt?: number;
}

/**
 * Reads and normalizes OpenClaw `sessions.json` entries from a sessions directory.
 *
 * Missing files, malformed JSON, and malformed entries are treated as empty
 * results so TUI predecessor fallback remains best-effort.
 *
 * @param sessionsDir - Absolute or relative OpenClaw sessions directory.
 * @param logger - Optional plugin logger used for debug diagnostics.
 * @returns Normalized session-store entries.
 */
export async function readOpenClawSessionsStore(sessionsDir: string, logger?: PluginLogger): Promise<OpenClawSessionsStoreEntry[]> {
  const normalizedSessionsDir = sessionsDir.trim();
  if (normalizedSessionsDir.length === 0) {
    debugLog(logger, "sessions-store-reader", "skipping sessions.json read because sessionsDir is empty");
    return [];
  }

  const resolvedSessionsDir = path.resolve(normalizedSessionsDir);
  const sessionsJsonPath = path.join(resolvedSessionsDir, "sessions.json");

  try {
    const raw = await fs.readFile(sessionsJsonPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      debugLog(logger, "sessions-store-reader", `sessions.json did not contain an object: path=${sessionsJsonPath}`);
      return [];
    }

    const entries: OpenClawSessionsStoreEntry[] = [];
    for (const [sessionKey, value] of Object.entries(parsed)) {
      const normalizedSessionKey = sessionKey.trim();
      if (normalizedSessionKey.length === 0) {
        debugLog(logger, "sessions-store-reader", `skipping blank session key in ${sessionsJsonPath}`);
        continue;
      }

      if (!isRecord(value)) {
        debugLog(logger, "sessions-store-reader", `skipping non-object entry for key=${normalizedSessionKey}`);
        continue;
      }

      const sessionId = asTrimmedString(value["sessionId"]);
      const sessionFile = asTrimmedString(value["sessionFile"]);
      const updatedAt = asFiniteNumber(value["updatedAt"]);

      entries.push({
        sessionKey: normalizedSessionKey,
        ...(sessionId ? { sessionId } : {}),
        ...(sessionFile ? { sessionFile: resolveSessionStorePath(sessionFile, resolvedSessionsDir) } : {}),
        ...(updatedAt !== undefined ? { updatedAt } : {}),
      });
    }

    debugLog(logger, "sessions-store-reader", `loaded sessions.json entries=${entries.length} path=${sessionsJsonPath}`);
    return entries;
  } catch (error) {
    if (isFileNotFound(error)) {
      debugLog(logger, "sessions-store-reader", `sessions.json missing at ${sessionsJsonPath}`);
      return [];
    }

    if (error instanceof SyntaxError) {
      debugLog(logger, "sessions-store-reader", `sessions.json parse failed at ${sessionsJsonPath}: ${error.message}`);
      return [];
    }

    debugLog(logger, "sessions-store-reader", `sessions.json read failed at ${sessionsJsonPath}: ${formatErrorMessage(error)}`);
    return [];
  }
}

/** Resolves relative session-file entries against the owning sessions directory. */
function resolveSessionStorePath(candidatePath: string, sessionsDir: string): string {
  return path.isAbsolute(candidatePath) ? path.resolve(candidatePath) : path.resolve(sessionsDir, candidatePath);
}

/** Narrows unknown JSON values to record-like objects. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Extracts a trimmed non-empty string from untyped JSON fields. */
function asTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** Extracts a finite numeric timestamp from untyped JSON fields. */
function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Emits debug logs when the plugin logger supports them. */
function debugLog(logger: PluginLogger | undefined, subsystem: string, message: string): void {
  logger?.debug?.(`[agenr] ${subsystem}: ${message}`);
}

/** Detects stable file-not-found failures from Node.js fs calls. */
function isFileNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

/** Formats unknown read failures into human-readable text. */
function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
