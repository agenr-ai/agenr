import { truncate } from "../memory-tool-format.js";

const MAX_CONTENT_CHARS = 220;

/** Shared injection entry shape used by session-start and before-turn formatters. */
export interface InjectionDurableItem {
  rank: number;
  durable: {
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
 * Formats one durable memory header line for prompt injection.
 *
 * @param item - Injection entry item with rank and metadata.
 * @returns Header line for prompt injection.
 */
export function formatInjectionDurableHeader(item: InjectionDurableItem): string {
  const metadata = [
    `rank ${item.rank}`,
    item.durable.id,
    item.durable.type,
    item.durable.expiry,
    `importance ${item.durable.importance}`,
    item.score !== undefined ? `score ${item.score.toFixed(2)}` : undefined,
  ].filter((value): value is string => value !== undefined);

  return `- [${metadata.join(" | ")}] ${item.durable.subject}`;
}

/**
 * Formats one durable memory body block for prompt injection.
 *
 * @param item - Injection entry item with content and provenance metadata.
 * @returns Body lines for prompt injection.
 */
export function formatInjectionDurableBodyLines(item: InjectionDurableItem): string[] {
  const lines = [`  ${truncate(item.durable.content.trim(), MAX_CONTENT_CHARS)}`];
  lines.push(`  why: ${item.whySurfaced.summary}`);

  const metadata = [
    item.durable.tags.length > 0 ? `tags: ${item.durable.tags.join(", ")}` : undefined,
    item.freshnessLabel ? `freshness: ${item.freshnessLabel}` : undefined,
    item.provenanceSummary ? `provenance: ${truncate(item.provenanceSummary, MAX_CONTENT_CHARS)}` : undefined,
  ].filter((value): value is string => value !== undefined);
  if (metadata.length > 0) {
    lines.push(`  ${metadata.join(" | ")}`);
  }

  return lines;
}

export { MAX_CONTENT_CHARS };
