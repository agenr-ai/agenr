/**
 * Minimal lexical stop-word list used for recall tokenization.
 */
const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "could",
  "should",
  "may",
  "might",
  "shall",
  "can",
  "need",
  "must",
  "i",
  "me",
  "my",
  "we",
  "our",
  "you",
  "your",
  "he",
  "him",
  "his",
  "she",
  "her",
  "it",
  "its",
  "they",
  "them",
  "their",
  "this",
  "that",
  "these",
  "those",
  "what",
  "which",
  "who",
  "whom",
  "in",
  "on",
  "at",
  "to",
  "for",
  "of",
  "with",
  "by",
  "from",
  "up",
  "about",
  "into",
  "through",
  "during",
  "before",
  "after",
  "above",
  "below",
  "and",
  "or",
  "but",
  "not",
  "no",
  "nor",
  "so",
  "if",
  "then",
  "else",
  "when",
  "where",
  "how",
  "all",
  "each",
  "every",
  "both",
  "few",
  "more",
  "some",
  "any",
  "other",
  "than",
]);

export { STOP_WORDS };

const FTS_OPERATOR_TOKENS = new Set(["or", "not", "near"]);

/**
 * Tokenize free-form text into normalized lexical terms.
 *
 * @param text - Source text to tokenize.
 * @returns Lowercased non-stopword tokens.
 */
export function tokenize(text: string): string[] {
  const matches = text.toLowerCase().match(/[a-z0-9][a-z0-9._-]*/g) ?? [];
  return matches.filter((token) => token.length >= 2 && !STOP_WORDS.has(token));
}

/**
 * Build a cascade of FTS5 MATCH query strings from raw user text.
 *
 * @param text - Raw query text.
 * @returns Exact, all-token, and any-token tiers in cascade order.
 */
export function buildFtsQueries(text: string): string[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return [];
  }

  const exactPhrase = `"${trimmed.replaceAll('"', '""')}"`;
  const tokens = tokenize(trimmed).filter((token) => !FTS_OPERATOR_TOKENS.has(token));

  if (tokens.length === 0) {
    return [exactPhrase];
  }

  if (tokens.length === 1) {
    return [exactPhrase, tokens[0]!];
  }

  return [exactPhrase, tokens.join(" "), tokens.join(" OR ")];
}

/**
 * Compute the lexical overlap score between a query and an entry.
 *
 * @param query - Raw recall query text.
 * @param subject - Entry subject text.
 * @param content - Entry content text.
 * @returns Normalized lexical overlap signal in the 0-1 range.
 */
export function computeLexicalScore(query: string, subject: string, content: string): number {
  const queryTokens = tokenize(query);
  const subjectTokens = tokenize(subject);
  const contentTokens = tokenize(content);
  const subjectTokenSet = new Set(subjectTokens);
  const contentTokenSet = new Set(contentTokens);

  const tokenOverlap =
    queryTokens.length === 0 ? 0 : queryTokens.filter((token) => subjectTokenSet.has(token) || contentTokenSet.has(token)).length / queryTokens.length;

  const phraseMatches = countPhraseMatches(queryTokens, subjectTokens, contentTokens);
  const phraseBonus = Math.min(0.4, phraseMatches * 0.2);
  const subjectBonus = normalizeText(query) === normalizeText(subject) && normalizeText(query).length > 0 ? 0.3 : 0;

  return Math.min(1, tokenOverlap + phraseBonus + subjectBonus);
}

/** Normalize raw text for exact string comparisons. */
const normalizeText = (text: string): string => text.trim().toLowerCase();

/** Count matching 2+ token query subsequences found in subject or content order. */
const countPhraseMatches = (queryTokens: string[], subjectTokens: string[], contentTokens: string[]): number => {
  if (queryTokens.length < 2) {
    return 0;
  }

  const matchedPhrases = new Set<string>();
  for (let size = 2; size <= queryTokens.length; size += 1) {
    for (let index = 0; index + size <= queryTokens.length; index += 1) {
      const phraseTokens = queryTokens.slice(index, index + size);
      if (hasConsecutivePhrase(subjectTokens, phraseTokens) || hasConsecutivePhrase(contentTokens, phraseTokens)) {
        matchedPhrases.add(phraseTokens.join(" "));
      }
    }
  }

  return matchedPhrases.size;
};

/** Check whether a token sequence appears consecutively inside a target token array. */
const hasConsecutivePhrase = (haystack: string[], needle: string[]): boolean => {
  if (needle.length === 0 || haystack.length < needle.length) {
    return false;
  }

  for (let index = 0; index + needle.length <= haystack.length; index += 1) {
    let matches = true;
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[index + offset] !== needle[offset]) {
        matches = false;
        break;
      }
    }

    if (matches) {
      return true;
    }
  }

  return false;
};
