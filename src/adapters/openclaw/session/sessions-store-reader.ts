import * as fs from "node:fs/promises";
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
   * OpenClaw-reported session surface when present.
   */
  surface?: string;
  /**
   * OpenClaw-reported provider when present.
   */
  provider?: string;
  /**
   * OpenClaw-reported chat type when present.
   */
  chatType?: string;
  /**
   * Last-activity timestamp in Unix milliseconds when present.
   */
  updatedAt?: number;
}

/**
 * Stable issue kinds surfaced while reading `sessions.json`.
 */
export type OpenClawSessionsStoreDiagnosticKind = "missing_file" | "malformed_json" | "unreadable_file" | "structurally_invalid_file";

/**
 * Structured diagnostic emitted for one `sessions.json` read outcome.
 */
export interface OpenClawSessionsStoreDiagnostic {
  /**
   * Machine-readable failure or warning classification.
   */
  kind: OpenClawSessionsStoreDiagnosticKind;
  /**
   * Human-readable issue description.
   */
  message: string;
  /**
   * Path of the `sessions.json` file involved in the diagnostic.
   */
  path: string;
}

/**
 * Best-effort `sessions.json` read result with normalized entries and diagnostics.
 */
export interface OpenClawSessionsStoreReadResult {
  /**
   * Normalized entries recovered from the store.
   */
  entries: OpenClawSessionsStoreEntry[];
  /**
   * Structured diagnostics describing why entries were skipped or absent.
   */
  diagnostics: OpenClawSessionsStoreDiagnostic[];
}

/**
 * Reads and normalizes OpenClaw `sessions.json` entries from a sessions directory.
 *
 * Missing files, malformed JSON, and malformed entries are treated as empty
 * results for registry lookups and episode ingest preflight.
 *
 * @param sessionsDir - Absolute or relative OpenClaw sessions directory.
 * @param logger - Optional plugin logger used for debug diagnostics.
 * @returns Normalized session-store entries.
 */
export async function readOpenClawSessionsStore(sessionsDir: string, logger?: PluginLogger): Promise<OpenClawSessionsStoreEntry[]> {
  if (sessionsDir.trim().length === 0) {
    debugLog(logger, "sessions-store-reader", "skipping sessions.json read because sessionsDir is empty");
    return [];
  }

  const result = await readOpenClawSessionsStoreWithDiagnostics(sessionsDir);

  for (const diagnostic of result.diagnostics) {
    debugLog(logger, "sessions-store-reader", diagnostic.message);
  }

  if (result.diagnostics.length === 0) {
    debugLog(
      logger,
      "sessions-store-reader",
      `loaded sessions.json entries=${result.entries.length} path=${path.join(path.resolve(sessionsDir.trim()), "sessions.json")}`,
    );
  }

  return result.entries;
}

/**
 * Reads and normalizes OpenClaw `sessions.json` entries while preserving
 * best-effort behavior and surfacing explicit diagnostics for failures.
 *
 * @param sessionsDir - Absolute or relative OpenClaw sessions directory.
 * @returns Normalized entries plus structured diagnostics.
 */
export async function readOpenClawSessionsStoreWithDiagnostics(sessionsDir: string): Promise<OpenClawSessionsStoreReadResult> {
  const normalizedSessionsDir = sessionsDir.trim();
  if (normalizedSessionsDir.length === 0) {
    return {
      entries: [],
      diagnostics: [],
    };
  }

  const resolvedSessionsDir = path.resolve(normalizedSessionsDir);
  const sessionsJsonPath = path.join(resolvedSessionsDir, "sessions.json");

  try {
    const raw = await fs.readFile(sessionsJsonPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      return {
        entries: [],
        diagnostics: [
          {
            kind: "structurally_invalid_file",
            message: `sessions.json did not contain an object: path=${sessionsJsonPath}`,
            path: sessionsJsonPath,
          },
        ],
      };
    }

    const entries: OpenClawSessionsStoreEntry[] = [];
    for (const [sessionKey, value] of Object.entries(parsed)) {
      const normalizedSessionKey = sessionKey.trim();
      if (normalizedSessionKey.length === 0) {
        continue;
      }

      if (!isRecord(value)) {
        continue;
      }

      const sessionId = asTrimmedString(value["sessionId"]);
      const sessionFile = asTrimmedString(value["sessionFile"]);
      const origin = isRecord(value["origin"]) ? value["origin"] : undefined;
      const surface = asTrimmedString(origin?.["surface"]);
      const provider = asTrimmedString(origin?.["provider"]);
      const chatType = asTrimmedString(value["chatType"]);
      const updatedAt = asFiniteNumber(value["updatedAt"]);

      entries.push({
        sessionKey: normalizedSessionKey,
        ...(sessionId ? { sessionId } : {}),
        ...(sessionFile ? { sessionFile: resolveSessionStorePath(sessionFile, resolvedSessionsDir) } : {}),
        ...(surface ? { surface } : {}),
        ...(provider ? { provider } : {}),
        ...(chatType ? { chatType } : {}),
        ...(updatedAt !== undefined ? { updatedAt } : {}),
      });
    }

    return {
      entries,
      diagnostics: [],
    };
  } catch (error) {
    if (isFileNotFound(error)) {
      return {
        entries: [],
        diagnostics: [
          {
            kind: "missing_file",
            message: `sessions.json missing at ${sessionsJsonPath}`,
            path: sessionsJsonPath,
          },
        ],
      };
    }

    if (error instanceof SyntaxError) {
      return {
        entries: [],
        diagnostics: [
          {
            kind: "malformed_json",
            message: `sessions.json parse failed at ${sessionsJsonPath}: ${error.message}`,
            path: sessionsJsonPath,
          },
        ],
      };
    }

    return {
      entries: [],
      diagnostics: [
        {
          kind: "unreadable_file",
          message: `sessions.json read failed at ${sessionsJsonPath}: ${formatErrorMessage(error)}`,
          path: sessionsJsonPath,
        },
      ],
    };
  }
}

/** Resolves relative session-file entries against the owning sessions directory. */
function resolveSessionStorePath(candidatePath: string, sessionsDir: string): string {
  return path.isAbsolute(candidatePath) ? path.resolve(candidatePath) : path.resolve(sessionsDir, candidatePath);
}

/** Narrows unknown JSON values to record-like objects. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
