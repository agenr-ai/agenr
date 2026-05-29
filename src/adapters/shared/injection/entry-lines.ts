import { truncate } from "../memory-tool-format.js";

const MAX_CONTENT_CHARS = 220;

/** Shared injection entry shape used by session-start and before-turn formatters. */
export interface InjectionEntryItem {
  rank: number;
  entry: {
    id: string;
    type: string;
    expiry: string;
    importance: number;
    subject: string;
    content: string;
    tags: string[];
  };
  score?: number;
  whySurfaced: { summary: string };
  freshnessLabel?: string;
  provenanceSummary?: string;
}

/**
 * Formats one memory entry header line for prompt injection.
 *
 * @param item - Injection entry item with rank and metadata.
 * @returns Header line for prompt injection.
 */
export function formatInjectionEntryHeader(item: InjectionEntryItem): string {
  const metadata = [
    `rank ${item.rank}`,
    item.entry.id,
    item.entry.type,
    item.entry.expiry,
    `importance ${item.entry.importance}`,
    item.score !== undefined ? `score ${item.score.toFixed(2)}` : undefined,
  ].filter((value): value is string => value !== undefined);

  return `- [${metadata.join(" | ")}] ${item.entry.subject}`;
}

/**
 * Formats one memory entry body block for prompt injection.
 *
 * @param item - Injection entry item with content and provenance metadata.
 * @returns Body lines for prompt injection.
 */
export function formatInjectionEntryBodyLines(item: InjectionEntryItem): string[] {
  const lines = [`  ${truncate(item.entry.content.trim(), MAX_CONTENT_CHARS)}`];
  lines.push(`  why: ${item.whySurfaced.summary}`);

  const metadata = [
    item.entry.tags.length > 0 ? `tags: ${item.entry.tags.join(", ")}` : undefined,
    item.freshnessLabel ? `freshness: ${item.freshnessLabel}` : undefined,
    item.provenanceSummary ? `provenance: ${truncate(item.provenanceSummary, MAX_CONTENT_CHARS)}` : undefined,
  ].filter((value): value is string => value !== undefined);
  if (metadata.length > 0) {
    lines.push(`  ${metadata.join(" | ")}`);
  }

  return lines;
}

export { MAX_CONTENT_CHARS };
