import fs from "node:fs/promises";
import path from "node:path";

import { discoverTranscriptFiles } from "../../../adapters/files/transcript-files.js";

/** Aggregate facts about OpenClaw session transcript discovery. */
export interface SessionScanResult {
  /** Total transcript files found under the scan root. */
  totalFiles: number;
  /** All discovered transcript files. */
  allFiles: string[];
  /** Transcript files modified in the recent window. */
  recentFiles: string[];
  /** Combined size of every discovered transcript file. */
  totalSizeBytes: number;
  /** Combined size of recent transcript files. */
  recentSizeBytes: number;
}

/**
 * Scans an OpenClaw agents directory for session transcripts.
 *
 * @param sessionsRoot - OpenClaw agents root directory.
 * @param recentDays - Number of days used for the "recent" ingest option.
 * @returns Session counts, file lists, and byte totals.
 */
export async function scanSessionFiles(sessionsRoot: string, recentDays = 7): Promise<SessionScanResult> {
  const result: SessionScanResult = {
    totalFiles: 0,
    allFiles: [],
    recentFiles: [],
    totalSizeBytes: 0,
    recentSizeBytes: 0,
  };

  let files: string[];
  try {
    files = await discoverTranscriptFiles(sessionsRoot);
  } catch (error) {
    if (isMissingPathError(error)) {
      return result;
    }
    throw error;
  }

  const cutoffMs = Date.now() - recentDays * 24 * 60 * 60 * 1000;
  for (const filePath of files) {
    if (!isSessionTranscriptPath(filePath)) {
      continue;
    }

    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try {
      stat = await fs.stat(filePath);
    } catch (error) {
      if (isMissingPathError(error)) {
        continue;
      }
      throw error;
    }

    result.allFiles.push(filePath);
    result.totalFiles += 1;
    result.totalSizeBytes += stat.size;

    if (stat.mtimeMs >= cutoffMs) {
      result.recentFiles.push(filePath);
      result.recentSizeBytes += stat.size;
    }
  }

  return result;
}

/** Returns whether a discovered JSONL path belongs to an OpenClaw sessions tree. */
function isSessionTranscriptPath(filePath: string): boolean {
  return filePath.split(path.sep).includes("sessions");
}

/** Checks whether an unknown error represents a missing input path. */
function isMissingPathError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
}
