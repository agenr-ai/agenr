import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type { IngestFilePort } from "../../app/ingestion/ports.js";

const GENERIC_TRANSCRIPT_FILE_PATTERN = /^.+\.jsonl(?:\.(?:reset|deleted)\..+)?$/iu;

/**
 * Discovers transcript files from a target file or directory path.
 *
 * @param targetPath - File or directory to inspect for transcript files.
 * @param options - Optional discovery flags.
 * @returns Sorted absolute transcript file paths.
 */
export async function discoverTranscriptFiles(targetPath: string, options: { recursive?: boolean } = {}): Promise<string[]> {
  const resolvedTargetPath = path.resolve(targetPath);
  const stat = await fs.stat(resolvedTargetPath);

  if (stat.isFile()) {
    return matchesTranscriptFileName(path.basename(resolvedTargetPath)) ? [resolvedTargetPath] : [];
  }

  const recursive = options.recursive ?? true;
  const entries = recursive
    ? await fs.readdir(resolvedTargetPath, { recursive: true, withFileTypes: true })
    : await fs.readdir(resolvedTargetPath, { withFileTypes: true });

  return entries
    .filter((entry) => entry.isFile() && matchesTranscriptFileName(entry.name))
    .map((entry) => path.resolve(entry.parentPath ?? resolvedTargetPath, entry.name))
    .sort((left, right) => left.localeCompare(right));
}

/**
 * Computes the SHA-256 digest for a transcript file.
 *
 * @param filePath - Transcript file path to hash.
 * @returns SHA-256 digest of the file contents.
 */
export async function computeTranscriptFileHash(filePath: string): Promise<string> {
  const content = await fs.readFile(filePath, "utf-8");
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Shared local filesystem adapter for transcript discovery and hashing.
 */
const localTranscriptFiles: IngestFilePort = {
  discoverFiles: discoverTranscriptFiles,
  computeFileHash: computeTranscriptFileHash,
};

export { localTranscriptFiles };

/**
 * Checks whether a basename matches the generic transcript-file shapes.
 *
 * Generic ingest intentionally accepts arbitrary `.jsonl` transcript basenames
 * plus rotated `.jsonl.reset.*` and `.jsonl.deleted.*` variants. Narrower
 * adapter-specific filtering, such as OpenClaw UUID-only names, belongs in the
 * adapter-specific discovery layer.
 *
 * @param fileName - Basename to inspect.
 * @returns `true` when the file name is an admissible transcript candidate.
 */
function matchesTranscriptFileName(fileName: string): boolean {
  return GENERIC_TRANSCRIPT_FILE_PATTERN.test(fileName.trim());
}
