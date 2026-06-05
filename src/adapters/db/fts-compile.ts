import type { LexicalSearchTier } from "../../core/recall/lexical.js";

/**
 * Wraps text as an FTS5 double-quoted string literal, escaping embedded quotes.
 *
 * @param text - Raw token or phrase text.
 * @returns SQLite FTS5 MATCH string literal.
 */
export function quoteFtsString(text: string): string {
  return `"${text.replaceAll('"', '""')}"`;
}

/**
 * Compiles one backend-agnostic lexical tier into a SQLite FTS5 MATCH expression.
 *
 * @param tier - Planned lexical tier from the core recall module.
 * @returns SQLite FTS5 MATCH text for that tier.
 */
export function compileLexicalTier(tier: LexicalSearchTier): string {
  if (tier.tier === "exact") {
    return quoteFtsString(tier.text);
  }

  // Quote every token as an FTS5 string literal rather than emitting bare
  // words. A bare word containing FTS5-special characters such as "." or "-"
  // (for example "schedule." or "text-embedding-3-small") is a syntax error
  // that makes the whole MATCH query throw, which the caller swallows and
  // silently turns into an empty tier. Quoting treats each token as a literal
  // phrase, so the tokenizer strips edge punctuation and the query still runs.
  const phrases = tier.tokens.map((token) => quoteFtsString(token));
  return tier.tier === "all_tokens" ? phrases.join(" ") : phrases.join(" OR ");
}
