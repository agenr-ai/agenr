import type { Durable, StoreDurableInput } from "../types.js";

/**
 * Builds the embedding input text for a stored knowledge entry.
 *
 * @param entry - Entry data to serialize for the embedding provider.
 * @returns Stable plain-text representation used for embedding generation.
 */
export function composeEmbeddingText(entry: StoreDurableInput | Durable): string {
  return `${entry.type}: ${entry.subject} - ${entry.content}`;
}
