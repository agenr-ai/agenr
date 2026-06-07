import type { SessionArtifact } from "../../../app/session-memory/types.js";

/**
 * Formats one compaction checkpoint artifact for prompt-time injection.
 *
 * @param artifact - Persisted compaction checkpoint artifact.
 * @returns Markdown block suitable for hidden user injection or prepend context.
 */
export function formatCompactionRecallContext(artifact: Pick<SessionArtifact, "summary" | "metadata">): string {
  const summary = artifact.summary.trim();
  const metadata = readCompactionMetadata(artifact.metadata);
  const lines = ["## Agenr Compaction Recall", summary];

  if (metadata.compactedCount !== undefined && metadata.messageCount !== undefined) {
    lines.push(`${metadata.compactedCount} messages compacted, ${metadata.messageCount} remain in context.`);
  } else if (metadata.tokensBefore !== undefined) {
    lines.push(`Compacted from about ${metadata.tokensBefore.toLocaleString()} tokens.`);
  }

  return lines.join("\n");
}

/** Reads typed compaction metadata from one artifact payload. */
function readCompactionMetadata(metadata: unknown): {
  compactedCount?: number;
  messageCount?: number;
  tokensBefore?: number;
} {
  if (typeof metadata !== "object" || metadata === null) {
    return {};
  }

  const record = metadata as Record<string, unknown>;
  return {
    ...(readOptionalNumber(record.compactedCount) !== undefined ? { compactedCount: readOptionalNumber(record.compactedCount) } : {}),
    ...(readOptionalNumber(record.messageCount) !== undefined ? { messageCount: readOptionalNumber(record.messageCount) } : {}),
    ...(readOptionalNumber(record.tokensBefore) !== undefined ? { tokensBefore: readOptionalNumber(record.tokensBefore) } : {}),
  };
}

/** Reads one optional numeric metadata field. */
function readOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
