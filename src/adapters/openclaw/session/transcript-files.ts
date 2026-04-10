import fs from "node:fs/promises";
import path from "node:path";

// Match rotated suffixes that include ISO timestamps with milliseconds.
const OPENCLAW_TRANSCRIPT_FILE_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl(?:\.(?:reset|deleted)\..+)?$/i;

/**
 * Discovers OpenClaw session transcript files for episode backfill.
 *
 * @param targetPath - File or directory to inspect.
 * @returns Sorted absolute transcript file paths.
 */
export async function discoverOpenClawTranscriptFiles(targetPath: string): Promise<string[]> {
  const resolvedTargetPath = path.resolve(targetPath);
  const stat = await fs.stat(resolvedTargetPath);

  if (stat.isFile()) {
    return matchesOpenClawTranscriptFile(path.basename(resolvedTargetPath)) ? [resolvedTargetPath] : [];
  }

  const entries = await fs.readdir(resolvedTargetPath, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && matchesOpenClawTranscriptFile(entry.name))
    .map((entry) => path.resolve(entry.parentPath ?? resolvedTargetPath, entry.name))
    .sort((left, right) => left.localeCompare(right));
}

/**
 * Shared discovery adapter used by episode-ingest preflight.
 *
 * @type {{ discoverFiles: typeof discoverOpenClawTranscriptFiles }}
 */
export const openClawTranscriptFiles = {
  discoverFiles: discoverOpenClawTranscriptFiles,
};

/**
 * Checks whether a filename matches the supported OpenClaw transcript shapes.
 *
 * Unlike generic transcript discovery, this predicate is intentionally narrow
 * and only accepts OpenClaw UUID-based session exports plus their rotated
 * reset/deleted variants.
 *
 * @param fileName - Basename to inspect.
 * @returns `true` when the file is an OpenClaw transcript candidate.
 */
function matchesOpenClawTranscriptFile(fileName: string): boolean {
  return OPENCLAW_TRANSCRIPT_FILE_PATTERN.test(fileName.trim());
}
