import * as fs from "node:fs/promises";

import type { TranscriptMessage } from "../../../core/types.js";

/**
 * Normalizes supported timestamp inputs to ISO-8601 strings.
 *
 * @param value - Candidate timestamp value from transcript data.
 * @returns ISO timestamp when parsing succeeds, otherwise `undefined`.
 */
export function parseTimestampValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }

  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    const milliseconds = value > 1e12 ? value : value * 1000;
    const parsed = new Date(milliseconds);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }

  return undefined;
}

/**
 * Extracts the first usable timestamp from a transcript record.
 *
 * @param record - Transcript record to inspect.
 * @returns ISO timestamp when a supported timestamp field is present.
 */
export function extractTimestamp(record: Record<string, unknown>): string | undefined {
  for (const field of ["timestamp", "ts", "created_at", "createdAt", "time", "date"]) {
    const parsed = parseTimestampValue(record[field]);
    if (parsed) {
      return parsed;
    }
  }

  return undefined;
}

/** Reads the transcript file modification time as an ISO timestamp fallback. */
async function getFileMtimeTimestamp(filePath: string): Promise<string | undefined> {
  try {
    const stat = await fs.stat(filePath);
    return parseTimestampValue(stat.mtime.toISOString());
  } catch {
    return undefined;
  }
}

/**
 * Resolves a fallback timestamp using candidate values, file metadata, and current time.
 *
 * @param filePath - Transcript file path used for metadata fallback.
 * @param candidates - Candidate timestamps to try in order.
 * @returns ISO timestamp guaranteed to be present.
 */
export async function resolveTimestampFallback(filePath: string, ...candidates: Array<string | undefined>): Promise<string> {
  for (const candidate of candidates) {
    const parsed = parseTimestampValue(candidate);
    if (parsed) {
      return parsed;
    }
  }

  const fileMtime = await getFileMtimeTimestamp(filePath);
  if (fileMtime) {
    return fileMtime;
  }

  return new Date().toISOString();
}

/**
 * Ensures every parsed message has a usable timestamp.
 *
 * @param filePath - Transcript file path used for fallback resolution.
 * @param messages - Parsed transcript messages to update in place.
 * @param options - Optional session-level timestamp hints.
 * @returns The fallback timestamp applied to messages missing timestamps.
 */
export async function applyMessageTimestampFallbacks(
  filePath: string,
  messages: TranscriptMessage[],
  options?: { sessionTimestamp?: string },
): Promise<string> {
  const fallbackTimestamp = await resolveTimestampFallback(filePath, options?.sessionTimestamp);
  for (const message of messages) {
    message.timestamp = parseTimestampValue(message.timestamp) ?? fallbackTimestamp;
  }

  return fallbackTimestamp;
}
