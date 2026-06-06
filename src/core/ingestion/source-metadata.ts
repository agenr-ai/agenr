import { resolveDurableProjectScope } from "../store/project-scope.js";
import type { ParsedTranscript, StoreDurableInput } from "../types.js";

const SNAPSHOT_STYLE_SOURCE_FILE_PATTERN = /\.jsonl\.(?:reset|deleted)\./iu;

/**
 * Returns whether one source-file value still points at a reset/deleted snapshot path.
 *
 * @param sourceFile - Candidate persisted source identity.
 * @returns `true` when the value still looks snapshot-style.
 */
export function isSnapshotStyleSourceFile(sourceFile?: string): boolean {
  const normalized = normalizeOptionalString(sourceFile);
  return normalized !== undefined && SNAPSHOT_STYLE_SOURCE_FILE_PATTERN.test(normalized);
}

/**
 * Resolves the durable source identity that should be stored for one extracted entry.
 *
 * @param filePath - Raw ingest path used to read the transcript file.
 * @param transcript - Parsed transcript metadata.
 * @param entrySourceFile - Optional source file already present on the extracted row.
 * @returns Stable source identity for persistence.
 */
export function resolveStableTranscriptSourceFile(filePath: string, transcript: ParsedTranscript, entrySourceFile?: string): string {
  const fallbackSourceFile = normalizeOptionalString(filePath) ?? filePath;
  const stableSourceIdentity = normalizeOptionalString(transcript.metadata.sourceIdentity) ?? fallbackSourceFile;
  const extractedSourceFile = normalizeOptionalString(entrySourceFile);
  if (!extractedSourceFile) {
    return stableSourceIdentity;
  }

  if (stableSourceIdentity !== fallbackSourceFile && (extractedSourceFile === fallbackSourceFile || isSnapshotStyleSourceFile(extractedSourceFile))) {
    return stableSourceIdentity;
  }

  return extractedSourceFile;
}

/**
 * Resolves one stored user identifier from transcript metadata without inventing guesses.
 *
 * @param transcript - Parsed transcript metadata.
 * @param entryUserId - Optional explicit user identifier already present on the row.
 * @returns Stored user identifier when the source provided one.
 */
export function resolveTranscriptUserId(transcript: ParsedTranscript, entryUserId?: string): string | undefined {
  return normalizeOptionalString(entryUserId) ?? normalizeOptionalString(transcript.metadata.userId);
}

/**
 * Resolves one stored project identifier using explicit entry metadata and conservative workspace hints.
 *
 * @param transcript - Parsed transcript metadata.
 * @param entry - Extracted row that may already carry explicit project metadata.
 * @returns Stored project identifier when the durable knowledge is scoped to a workspace.
 */
export function resolveTranscriptProject(
  transcript: ParsedTranscript,
  entry: Pick<StoreDurableInput, "project" | "subject" | "content" | "tags" | "source_context" | "claim_key">,
): string | undefined {
  return resolveDurableProjectScope(entry, {
    sessionWorkspace: transcript.metadata.project,
    workingDirectory: transcript.metadata.workingDirectory,
  });
}

/** Trims one optional string and drops the empty result. */
function normalizeOptionalString(value?: string): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}
