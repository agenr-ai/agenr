/** Shared stopwords for claim-key attribute and text overlap checks. */
const CLAIM_KEY_LEXICAL_STOP_TOKENS = new Set([
  "a",
  "about",
  "again",
  "already",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "during",
  "for",
  "from",
  "have",
  "how",
  "in",
  "into",
  "is",
  "it",
  "of",
  "on",
  "or",
  "our",
  "that",
  "the",
  "their",
  "there",
  "this",
  "to",
  "used",
  "user",
  "we",
  "where",
  "with",
]);

/** Minimum shared-token count for overlap coefficient denominators. */
const MIN_LEXICAL_TOKEN_LENGTH = 3;

/** Overlap metrics for two token sets. */
export interface ClaimKeyTokenOverlap {
  commonCount: number;
  coefficient: number;
}

/**
 * Tokenizes a claim-key attribute segment list for sibling-slot overlap checks.
 *
 * @param attribute - Normalized claim-key attribute.
 * @returns Stable attribute tokens.
 */
export function tokenizeClaimKeyAttributeTokens(attribute: string): Set<string> {
  return new Set(attribute.split("_").filter((token) => token.length >= MIN_LEXICAL_TOKEN_LENGTH && !CLAIM_KEY_LEXICAL_STOP_TOKENS.has(token)));
}

/**
 * Tokenizes free-form subject, content, or tag text for claim-key overlap checks.
 *
 * @param text - Raw text to tokenize.
 * @returns Stable lowercase lexical tokens.
 */
export function tokenizeClaimKeyTextTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/u)
      .map((token) => token.trim())
      .filter((token) => token.length >= MIN_LEXICAL_TOKEN_LENGTH && !CLAIM_KEY_LEXICAL_STOP_TOKENS.has(token)),
  );
}

/**
 * Tokenizes optional free-form text for claim-key overlap checks.
 *
 * @param value - Raw text to tokenize.
 * @returns Stable lowercase lexical tokens.
 */
export function tokenizeOptionalClaimKeyTextTokens(value: string | undefined): Set<string> {
  return tokenizeClaimKeyTextTokens(value ?? "");
}

/**
 * Computes overlap coefficient for two token sets.
 *
 * @param left - Left token set.
 * @param right - Right token set.
 * @returns Shared-token count and min-size overlap coefficient.
 */
export function computeClaimKeyTokenOverlap(left: Set<string>, right: Set<string>): ClaimKeyTokenOverlap {
  if (left.size === 0 || right.size === 0) {
    return { commonCount: 0, coefficient: 0 };
  }

  let commonCount = 0;
  for (const token of left) {
    if (right.has(token)) {
      commonCount += 1;
    }
  }

  return { commonCount, coefficient: commonCount / Math.min(left.size, right.size) };
}

/**
 * Returns the trailing stable attribute token used as the attribute head.
 *
 * @param attribute - Normalized claim-key attribute.
 * @returns Last stable token or the raw attribute when none qualify.
 */
export function readClaimKeyAttributeHead(attribute: string): string {
  const tokens = [...tokenizeClaimKeyAttributeTokens(attribute)];
  return tokens[tokens.length - 1] ?? attribute;
}
