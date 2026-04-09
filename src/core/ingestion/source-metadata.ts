import path from "node:path";

import type { ParsedTranscript, StoreEntryInput } from "../types.js";

const SNAPSHOT_STYLE_SOURCE_FILE_PATTERN = /\.jsonl\.(?:reset|deleted)\./iu;
const IGNORED_PROJECT_DIRECTORY_NAMES = new Set(["", ".", "..", "users", "user", "home", "tmp", "var"]);

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
 * Resolves one stored project identifier from explicit transcript metadata or a matching workspace hint.
 *
 * @param transcript - Parsed transcript metadata.
 * @param entry - Extracted row that may already carry explicit project metadata.
 * @returns Stored project identifier when the source safely supports one.
 */
export function resolveTranscriptProject(
  transcript: ParsedTranscript,
  entry: Pick<StoreEntryInput, "project" | "subject" | "content" | "tags" | "source_context">,
): string | undefined {
  const explicitProject = normalizeOptionalString(entry.project) ?? normalizeOptionalString(transcript.metadata.project);
  if (explicitProject) {
    return explicitProject;
  }

  const workingDirectoryProject = deriveWorkingDirectoryProject(transcript.metadata.workingDirectory);
  if (!workingDirectoryProject) {
    return undefined;
  }

  return entryContainsProjectSignal(entry, workingDirectoryProject) ? workingDirectoryProject : undefined;
}

/** Derives a conservative project identifier from a working-directory path. */
function deriveWorkingDirectoryProject(workingDirectory?: string): string | undefined {
  const normalizedWorkingDirectory = normalizeOptionalString(workingDirectory);
  if (!normalizedWorkingDirectory) {
    return undefined;
  }

  const candidate = normalizeMetadataIdentifier(path.basename(normalizedWorkingDirectory));
  if (!candidate || IGNORED_PROJECT_DIRECTORY_NAMES.has(candidate)) {
    return undefined;
  }

  return candidate;
}

/** Returns whether one entry visibly references the candidate project identifier. */
function entryContainsProjectSignal(entry: Pick<StoreEntryInput, "subject" | "content" | "tags" | "source_context">, project: string): boolean {
  const projectTokens = project.split("_").filter((token) => token.length > 0);
  if (projectTokens.length === 0) {
    return false;
  }

  return [entry.subject, entry.source_context].some((value) => {
    const tokens = tokenizeText(value);
    return projectTokens.every((token) => tokens.has(token));
  });
}

/** Normalizes one identifier into lowercase snake_case for metadata matching. */
function normalizeMetadataIdentifier(value?: string): string | undefined {
  const normalized = normalizeOptionalString(value)
    ?.toLowerCase()
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "");
  return normalized && normalized.length > 0 ? normalized : undefined;
}

/** Tokenizes free text into lowercase alphanumeric words for conservative matching. */
function tokenizeText(value?: string): Set<string> {
  return new Set(
    (value ?? "")
      .toLowerCase()
      .split(/[^a-z0-9]+/u)
      .map((token) => token.trim())
      .filter((token) => token.length > 0),
  );
}

/** Trims one optional string and drops the empty result. */
function normalizeOptionalString(value?: string): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}
