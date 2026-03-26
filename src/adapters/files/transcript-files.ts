import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type { IngestFilePort } from "../../app/ingestion/ports.js";

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
    return [resolvedTargetPath];
  }

  const recursive = options.recursive ?? true;
  const entries = recursive
    ? await fs.readdir(resolvedTargetPath, { recursive: true, withFileTypes: true })
    : await fs.readdir(resolvedTargetPath, { withFileTypes: true });

  return entries
    .filter((entry) => entry.isFile() && entry.name.includes(".jsonl"))
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
