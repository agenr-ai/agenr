/**
 * Minimal memory-directive abstention primitive.
 *
 * A memory directive is a durable the user authored to constrain what memory
 * may be surfaced, for example "do not bring up the San Francisco move again".
 * Until the dedicated `directive` durable kind ships, directives are recognized
 * structurally by their claim-key family (`user/memory_directive/*`) and their
 * blocked topics are extracted from the directive content. Injection paths use
 * the helpers here to keep directive rows out of automatic memory and to
 * suppress any candidate that mentions a blocked topic.
 *
 * This module is pure domain logic: it never performs IO and never decides
 * where the directive rows come from. Callers supply the candidate durables and
 * the directive durables; the helpers only parse and match.
 *
 * Interim status: the natural-language verb and phrase patterns below are a
 * stopgap until the dedicated `directive` durable kind ships with structured
 * blocked-topic fields. Do not extend the regex surface to chase more phrasings.
 * When the directive kind lands, this module should become a thin adapter over
 * the stored structured shape rather than a growing NLP parser.
 */

import type { Durable } from "../types.js";

/**
 * Claim-key family prefix that marks a durable as a user memory directive.
 *
 * Directives live under a dedicated claim-key family so they can be recognized
 * without a separate durable kind. The trailing slash is significant: only keys
 * that are strictly inside the family qualify.
 */
export const MEMORY_DIRECTIVE_CLAIM_KEY_PREFIX = "user/memory_directive/";

/**
 * Verbs that introduce a blocked topic inside abstain-directive content.
 *
 * Each alternative is a request to stop surfacing whatever phrase follows it.
 * The list stays deliberately small and high-precision so unrelated durables
 * are never misread as directives.
 */
const ABSTAIN_VERB_PATTERN =
  "(?:mention|mentioning|bring up|bringing up|discuss|discussing|talk about|talking about|reference|referencing|raise|raising|recommend|recommending|suggest|suggesting|surface|surfacing|remind me about|remind me of)";

/**
 * Leading request markers that may precede an abstain verb in directive content.
 */
const ABSTAIN_LEAD_PATTERN = "(?:do not|don't|do n't|never|please do not|please don't|stop|avoid|no longer)";

/**
 * Global matcher for "stop surfacing X" style directives. The captured group is
 * the raw blocked topic phrase, trimmed and cleaned by the parser.
 */
const ABSTAIN_PHRASE_PATTERN = new RegExp(`\\b${ABSTAIN_LEAD_PATTERN}\\s+${ABSTAIN_VERB_PATTERN}\\s+(.+?)(?:[.!?;]|$)`, "giu");

/**
 * Trailing qualifier words stripped from an extracted blocked topic phrase.
 */
const TRAILING_QUALIFIER_PATTERN = /\b(?:again|anymore|any more|ever again|ever|at all|please|with me|to me)\s*$/giu;

/**
 * Leading determiner words stripped from an extracted blocked topic phrase.
 */
const LEADING_DETERMINER_PATTERN = /^(?:the|a|an|any|my|our|that|this|these|those)\s+/iu;

/**
 * Minimum length, in characters, for a usable blocked topic phrase. Single
 * characters are dropped so a malformed directive cannot blanket-suppress
 * unrelated memory.
 */
const MIN_BLOCKED_TERM_LENGTH = 2;

/**
 * One parsed abstain directive ready for matching against candidate durables.
 */
export interface AbstainDirective {
  /** Durable id of the directive row. */
  id: string;
  /** Claim key that placed the row in the memory-directive family. */
  claimKey: string;
  /** Normalized lowercase blocked topic phrases extracted from the directive. */
  blockedTerms: string[];
}

/**
 * One abstain match between a candidate durable and an active directive.
 */
export interface AbstainViolation {
  /** Directive durable id that blocked the candidate. */
  directiveId: string;
  /** Blocked topic phrase that the candidate mentioned. */
  blockedTerm: string;
}

/**
 * Returns whether a durable is a user memory directive.
 *
 * @param entry - Candidate durable, possibly carrying a directive claim key.
 * @returns True when the durable's claim key is inside the directive family.
 */
export function isMemoryDirectiveDurable(entry: Pick<Durable, "claim_key">): boolean {
  const claimKey = entry.claim_key?.trim();
  return claimKey !== undefined && claimKey.startsWith(MEMORY_DIRECTIVE_CLAIM_KEY_PREFIX) && claimKey.length > MEMORY_DIRECTIVE_CLAIM_KEY_PREFIX.length;
}

/**
 * Parses one durable into an abstain directive when it qualifies.
 *
 * Blocked topics are extracted from the directive content using the abstain
 * verb patterns, with the claim-key suffix used as a fallback signal when the
 * content yields nothing. A directive with no usable blocked term returns null
 * so it cannot silently suppress everything.
 *
 * @param entry - Candidate durable that may be a memory directive.
 * @returns Parsed directive, or null when the row is not a usable directive.
 */
export function parseAbstainDirective(entry: Pick<Durable, "id" | "claim_key" | "subject" | "content">): AbstainDirective | null {
  if (!isMemoryDirectiveDurable(entry)) {
    return null;
  }

  const claimKey = entry.claim_key!.trim();
  const blockedTerms = extractBlockedTerms(entry, claimKey);
  if (blockedTerms.length === 0) {
    return null;
  }

  return {
    id: entry.id,
    claimKey,
    blockedTerms,
  };
}

/**
 * Parses a batch of durables into the directives that successfully qualified.
 *
 * @param entries - Candidate directive durables to parse.
 * @returns Parsed abstain directives in input order.
 */
export function collectAbstainDirectives(entries: readonly Pick<Durable, "id" | "claim_key" | "subject" | "content">[]): AbstainDirective[] {
  const directives: AbstainDirective[] = [];
  for (const entry of entries) {
    const directive = parseAbstainDirective(entry);
    if (directive) {
      directives.push(directive);
    }
  }

  return directives;
}

/**
 * Finds the first directive a candidate durable violates, if any.
 *
 * A candidate violates a directive when its subject or content mentions one of
 * the directive's blocked topic phrases as a whole-word phrase. The directive's
 * own row never matches itself because callers exclude directive rows before
 * checking, but a defensive id comparison is still applied.
 *
 * @param entry - Candidate durable being considered for injection.
 * @param directives - Active abstain directives to check against.
 * @returns The first violation found, or null when the candidate is allowed.
 */
export function findAbstainViolation(entry: Pick<Durable, "id" | "subject" | "content">, directives: readonly AbstainDirective[]): AbstainViolation | null {
  if (directives.length === 0) {
    return null;
  }

  const haystack = normalizeForMatch(`${entry.subject} ${entry.content}`);
  if (haystack.length === 0) {
    return null;
  }

  for (const directive of directives) {
    if (directive.id === entry.id) {
      continue;
    }

    for (const blockedTerm of directive.blockedTerms) {
      if (mentionsBlockedTerm(haystack, blockedTerm)) {
        return {
          directiveId: directive.id,
          blockedTerm,
        };
      }
    }
  }

  return null;
}

/**
 * Extracts normalized blocked topic phrases from one directive durable.
 *
 * @param entry - Directive durable supplying content and subject text.
 * @param claimKey - Directive claim key used for the suffix fallback.
 * @returns Unique normalized blocked topic phrases.
 */
function extractBlockedTerms(entry: Pick<Durable, "subject" | "content">, claimKey: string): string[] {
  const terms = new Set<string>();

  for (const source of [entry.content, entry.subject]) {
    for (const phrase of matchAbstainPhrases(source)) {
      const cleaned = cleanBlockedTerm(phrase);
      if (cleaned.length >= MIN_BLOCKED_TERM_LENGTH) {
        terms.add(cleaned);
      }
    }
  }

  if (terms.size === 0) {
    const fallback = cleanBlockedTerm(deriveTermFromClaimKey(claimKey));
    if (fallback.length >= MIN_BLOCKED_TERM_LENGTH) {
      terms.add(fallback);
    }
  }

  return Array.from(terms);
}

/**
 * Collects raw blocked-topic phrases from a single text source.
 *
 * @param source - Directive text to scan.
 * @returns Raw captured phrases before cleaning.
 */
function matchAbstainPhrases(source: string): string[] {
  const phrases: string[] = [];
  // A fresh regex per call avoids shared lastIndex state across invocations.
  const pattern = new RegExp(ABSTAIN_PHRASE_PATTERN.source, ABSTAIN_PHRASE_PATTERN.flags);
  let match: RegExpExecArray | null = pattern.exec(source);
  while (match !== null) {
    const captured = match[1];
    if (captured) {
      phrases.push(captured);
    }
    match = pattern.exec(source);
  }

  return phrases;
}

/**
 * Derives a fallback blocked topic from the directive claim-key suffix.
 *
 * @param claimKey - Directive claim key inside the memory-directive family.
 * @returns Human-readable phrase derived from the suffix.
 */
function deriveTermFromClaimKey(claimKey: string): string {
  const suffix = claimKey.slice(MEMORY_DIRECTIVE_CLAIM_KEY_PREFIX.length);
  return suffix
    .replace(/^(?:do[_-]?not[_-]?mention[_-]?|avoid[_-]?|no[_-]?)/iu, "")
    .replace(/[_-]+/gu, " ")
    .trim();
}

/**
 * Cleans one raw blocked topic phrase into its normalized matchable form.
 *
 * @param phrase - Raw captured or derived phrase.
 * @returns Lowercase, qualifier-stripped phrase suitable for matching.
 */
function cleanBlockedTerm(phrase: string): string {
  const collapsed = phrase.replace(/\s+/gu, " ").trim();
  const withoutLead = collapsed.replace(LEADING_DETERMINER_PATTERN, "");
  const withoutTrailing = withoutLead.replace(TRAILING_QUALIFIER_PATTERN, "").trim();
  return normalizeForMatch(withoutTrailing);
}

/**
 * Returns whether normalized candidate text mentions a blocked phrase as a
 * whole-word phrase.
 *
 * @param haystack - Normalized candidate text.
 * @param blockedTerm - Normalized blocked topic phrase.
 * @returns True when the phrase appears on word boundaries.
 */
function mentionsBlockedTerm(haystack: string, blockedTerm: string): boolean {
  if (blockedTerm.length < MIN_BLOCKED_TERM_LENGTH) {
    return false;
  }

  const escaped = escapeRegExp(blockedTerm).replace(/\\?\s+/gu, "\\s+");
  const pattern = new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?:[^\\p{L}\\p{N}]|$)`, "iu");
  return pattern.test(haystack);
}

/**
 * Normalizes text for whole-phrase matching.
 *
 * @param value - Raw text.
 * @returns Lowercase whitespace-collapsed text.
 */
function normalizeForMatch(value: string): string {
  return value.replace(/\s+/gu, " ").trim().normalize("NFKC").toLocaleLowerCase();
}

/**
 * Escapes regular-expression metacharacters in a literal fragment.
 *
 * @param value - Raw text.
 * @returns Regex-safe literal text.
 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
