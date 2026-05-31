import type { AgentMessage } from "@earendil-works/pi-agent-core";

/** Minimal branch-entry shape needed for before-turn visibility filtering. */
export interface SkelnBranchEntryLike {
  /** Session tree entry discriminator. */
  type?: unknown;
  /** Session tree entry id. */
  id?: unknown;
  /** Parent id retained for compatibility with Skeln entries. */
  parentId?: unknown;
  /** Message payload when this is a message entry. */
  message?: unknown;
  /** First replayed entry after compaction when this is a compaction entry. */
  firstKeptEntryId?: unknown;
}

/**
 * Extracts message payloads visible to before-turn recall from a Skeln branch.
 *
 * @param branch - Raw Skeln branch entries from the extension session manager.
 * @returns Message payloads after the latest compaction boundary when it can be resolved.
 */
export function extractSkelnBeforeTurnBranchMessages(branch: SkelnBranchEntryLike[]): AgentMessage[] {
  return selectEntriesAfterLatestCompaction(branch).flatMap((entry) => (isSkelnMessageEntry(entry) ? [entry.message] : []));
}

/** Selects active branch entries while avoiding archived pre-compaction text. */
function selectEntriesAfterLatestCompaction(branch: SkelnBranchEntryLike[]): SkelnBranchEntryLike[] {
  const latestCompaction = findLatestCompactionEntry(branch);
  if (!latestCompaction) {
    return branch;
  }

  const firstKeptEntryId = typeof latestCompaction.firstKeptEntryId === "string" ? latestCompaction.firstKeptEntryId.trim() : "";
  if (!firstKeptEntryId) {
    return branch;
  }

  const keptStart = branch.findIndex((entry) => entry.id === firstKeptEntryId);
  const compactionIndex = branch.findIndex((entry) => entry === latestCompaction);
  if (keptStart < 0 || compactionIndex < 0 || keptStart >= compactionIndex) {
    return branch;
  }

  return branch.slice(keptStart, compactionIndex).concat(branch.slice(compactionIndex + 1));
}

/** Finds the newest compaction entry in branch order. */
function findLatestCompactionEntry(branch: SkelnBranchEntryLike[]): SkelnBranchEntryLike | undefined {
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry?.type === "compaction") {
      return entry;
    }
  }

  return undefined;
}

/** Narrows a raw branch entry to a message entry with an AgentMessage payload. */
function isSkelnMessageEntry(entry: SkelnBranchEntryLike): entry is SkelnBranchEntryLike & { type: "message"; message: AgentMessage } {
  if (entry.type !== "message" || !entry.message || typeof entry.message !== "object") {
    return false;
  }

  const role = (entry.message as { role?: unknown }).role;
  return role === "user" || role === "assistant" || role === "system" || role === "tool";
}
