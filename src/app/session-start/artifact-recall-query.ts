import { SESSION_START_ARTIFACT_KINDS } from "../session-memory/predecessor-artifacts.js";
import type { SessionArtifact, SessionArtifactKind } from "../session-memory/types.js";

/** Stable section titles used when building artifact-grounded recall queries. */
const ARTIFACT_QUERY_TITLES: Record<(typeof SESSION_START_ARTIFACT_KINDS)[number], string> = {
  compaction_checkpoint: "Compaction checkpoint",
  branch_abandonment: "Branch abandonment",
  session_episode: "Session episode",
};

/** Preferred ordering when multiple predecessor artifacts are available. */
const SESSION_START_QUERY_ARTIFACT_ORDER = new Map<SessionArtifactKind, number>(SESSION_START_ARTIFACT_KINDS.map((kind, index) => [kind, index]));

/**
 * Builds one bounded artifact-grounded recall query from predecessor session artifacts.
 *
 * @param artifacts - Predecessor artifacts resolved from session-memory storage.
 * @param maxChars - Maximum character budget for the derived query.
 * @returns Normalized recall query, or undefined when no artifact signal exists.
 */
export function buildSessionStartArtifactRecallQuery(artifacts: SessionArtifact[], maxChars: number): string | undefined {
  if (artifacts.length === 0 || maxChars <= 0) {
    return undefined;
  }

  const orderedArtifacts = [...artifacts].sort(compareSessionStartArtifacts);
  let remaining = maxChars;
  const parts: string[] = [];

  for (const artifact of orderedArtifacts) {
    if (remaining <= 0) {
      break;
    }

    const title = ARTIFACT_QUERY_TITLES[artifact.kind as (typeof SESSION_START_ARTIFACT_KINDS)[number]];
    if (!title) {
      continue;
    }

    const normalizedContent = normalizeWhitespace(artifact.summary);
    if (normalizedContent.length === 0) {
      continue;
    }

    const labeled = `${title}: ${normalizedContent}`;
    const truncated = truncate(labeled, remaining);
    if (truncated.length === 0) {
      continue;
    }

    parts.push(truncated);
    remaining -= truncated.length;
  }

  const query = normalizeWhitespace(parts.join("\n"));
  return query.length > 0 ? query : undefined;
}

/** Sorts predecessor artifacts by preferred kind order, then newest first. */
function compareSessionStartArtifacts(left: SessionArtifact, right: SessionArtifact): number {
  const leftOrder = SESSION_START_QUERY_ARTIFACT_ORDER.get(left.kind) ?? Number.MAX_SAFE_INTEGER;
  const rightOrder = SESSION_START_QUERY_ARTIFACT_ORDER.get(right.kind) ?? Number.MAX_SAFE_INTEGER;
  if (leftOrder !== rightOrder) {
    return leftOrder - rightOrder;
  }

  return right.createdAt.localeCompare(left.createdAt);
}

/** Collapses repeated whitespace inside one text value for query use. */
function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** Truncates one string to the requested character budget. */
function truncate(value: string, maxChars: number): string {
  if (maxChars <= 0) {
    return "";
  }

  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}
