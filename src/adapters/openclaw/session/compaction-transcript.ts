import * as fs from "node:fs/promises";

import { parseJsonObjectLineWithDiagnostics } from "../transcript/jsonl.js";

/**
 * One compaction record stored in an OpenClaw session JSONL transcript.
 */
export interface OpenClawCompactionTranscriptEntry {
  /** Transcript entry id when present. */
  id?: string;
  /** Compaction summary text produced by OpenClaw. */
  summary: string;
  /** Token count before compaction when present. */
  tokensBefore?: number;
  /** Token count after compaction when present. */
  tokensAfter?: number;
  /** First transcript entry id retained after compaction. */
  firstKeptEntryId?: string;
  /** ISO timestamp when recorded by OpenClaw. */
  timestamp?: string;
  /** Whether the compaction entry came from a plugin hook path. */
  fromHook?: boolean;
}

/**
 * Reads all compaction entries from one OpenClaw session transcript file.
 *
 * @param sessionFile - Absolute path to the session JSONL transcript.
 * @returns Compaction entries in file order.
 */
export async function readOpenClawCompactionEntries(sessionFile: string): Promise<OpenClawCompactionTranscriptEntry[]> {
  const raw = await fs.readFile(sessionFile, "utf8");
  const entries: OpenClawCompactionTranscriptEntry[] = [];

  for (const [index, line] of raw.split("\n").entries()) {
    const parsed = parseJsonObjectLineWithDiagnostics(line, index + 1).record;
    if (!parsed || parsed.type !== "compaction") {
      continue;
    }

    const summary = readTrimmedString(parsed.summary);
    if (!summary) {
      continue;
    }

    const id = readTrimmedString(parsed.id);
    entries.push({
      ...(id ? { id } : {}),
      summary,
      ...(readOptionalNumber(parsed.tokensBefore) !== undefined ? { tokensBefore: readOptionalNumber(parsed.tokensBefore) } : {}),
      ...(readOptionalNumber(parsed.tokensAfter) !== undefined ? { tokensAfter: readOptionalNumber(parsed.tokensAfter) } : {}),
      ...(readTrimmedString(parsed.firstKeptEntryId) ? { firstKeptEntryId: readTrimmedString(parsed.firstKeptEntryId) } : {}),
      ...(readTrimmedString(parsed.timestamp) ? { timestamp: readTrimmedString(parsed.timestamp) } : {}),
      ...(parsed.fromHook === true ? { fromHook: true } : {}),
    });
  }

  return entries;
}

/**
 * Returns the latest compaction entry from one OpenClaw session transcript file.
 *
 * @param sessionFile - Absolute path to the session JSONL transcript.
 * @returns Latest compaction entry when one exists.
 */
export async function readLatestOpenClawCompactionEntry(sessionFile: string | undefined): Promise<OpenClawCompactionTranscriptEntry | undefined> {
  const path = sessionFile?.trim();
  if (!path) {
    return undefined;
  }

  try {
    const entries = await readOpenClawCompactionEntries(path);
    return entries.at(-1);
  } catch {
    return undefined;
  }
}

/** Reads one optional trimmed string field from a transcript record. */
function readTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Reads one optional numeric field from a transcript record. */
function readOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
