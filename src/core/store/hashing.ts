import { createHash } from "node:crypto";

/**
 * Computes the exact-match content hash used for idempotent storage writes.
 *
 * @param content - Entry content body to hash.
 * @param sourceFile - Optional source file path included in the hash input.
 * @returns SHA-256 hex digest for the source-aware content payload.
 */
export function computeContentHash(content: string, sourceFile?: string): string {
  const input = sourceFile ? `${sourceFile}\n${content}` : content;
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Computes the normalized content hash used for fuzzy dedup across sources.
 *
 * @param content - Raw entry content body to normalize and hash.
 * @returns SHA-256 hex digest for the normalized content payload.
 */
export function computeNormContentHash(content: string): string {
  const normalized = content
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[^\w\s]/g, "");
  return createHash("sha256").update(normalized).digest("hex");
}
