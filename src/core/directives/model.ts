/**
 * Core directive domain model.
 *
 * Directives are first-class durable rows that control memory behavior. The
 * abstain implementation consumes this model for topic suppression, while
 * session-start and dreaming also use it for proactive surfacing and profile
 * projection.
 */

import { normalizeClaimKeySegment } from "../claim-key.js";
import { DIRECTIVE_BASE_TRIGGERS, DIRECTIVE_POLARITIES, type DirectivePolarity, type DirectiveTrigger, type Durable } from "../types.js";

/** Claim-key family prefix reserved for memory behavior directives. */
const MEMORY_DIRECTIVE_CLAIM_KEY_PREFIX = "user/memory_directive/";

/** Default trigger used when a proactive directive omits one. */
const DEFAULT_PROACTIVE_DIRECTIVE_TRIGGER = "session_start";

/** Default trigger used when an abstain directive omits one. */
const DEFAULT_ABSTAIN_DIRECTIVE_TRIGGER = "always";

/** Minimum topic length accepted for topic-scoped directive triggers. */
const MIN_DIRECTIVE_TOPIC_LENGTH = 2;

/** Parsed first-class directive metadata. */
export interface ParsedDirectiveMetadata {
  polarity: DirectivePolarity;
  trigger: DirectiveTrigger;
}

/**
 * Returns whether a durable is a memory behavior directive.
 *
 * @param entry - Candidate durable or partial durable shape.
 * @returns True when the row is first-class directive or a legacy directive key.
 */
export function isDirectiveDurable(entry: Pick<Durable, "claim_key"> & Partial<Pick<Durable, "type">>): boolean {
  const claimKey = entry.claim_key?.trim();
  return (
    entry.type === "directive" ||
    (claimKey !== undefined && claimKey.startsWith(MEMORY_DIRECTIVE_CLAIM_KEY_PREFIX) && claimKey.length > MEMORY_DIRECTIVE_CLAIM_KEY_PREFIX.length)
  );
}

/**
 * Parses and normalizes one directive trigger value.
 *
 * @param value - Candidate trigger string.
 * @returns Normalized trigger, or undefined when invalid.
 */
export function parseDirectiveTrigger(value: unknown): DirectiveTrigger | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = normalizeForDirective(value);
  if (DIRECTIVE_BASE_TRIGGERS.includes(normalized as (typeof DIRECTIVE_BASE_TRIGGERS)[number])) {
    return normalized as (typeof DIRECTIVE_BASE_TRIGGERS)[number];
  }

  if (!normalized.startsWith("topic:")) {
    return undefined;
  }

  const topic = normalizeForDirective(normalized.slice("topic:".length));
  return topic.length >= MIN_DIRECTIVE_TOPIC_LENGTH ? (`topic:${topic}` as const) : undefined;
}

/**
 * Parses and normalizes one directive polarity value.
 *
 * @param value - Candidate polarity string.
 * @returns Normalized polarity, or undefined when invalid.
 */
export function parseDirectivePolarity(value: unknown): DirectivePolarity | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = normalizeForDirective(value);
  return DIRECTIVE_POLARITIES.includes(normalized as DirectivePolarity) ? (normalized as DirectivePolarity) : undefined;
}

/**
 * Normalizes one user memory-directive claim key.
 *
 * Directive keys deliberately use a three-segment family:
 * `user/memory_directive/<name>`. The general durable claim-key normalizer stays
 * two-segment, so directive validation uses this narrow normalizer.
 *
 * @param value - Candidate directive claim-key string.
 * @returns Canonical directive claim key, or undefined when invalid.
 */
export function normalizeMemoryDirectiveClaimKey(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const segments = value
    .split("/")
    .map((segment) => normalizeClaimKeySegment(segment))
    .filter((segment) => segment.length > 0);
  if (segments.length !== 3 || segments[0] !== "user" || segments[1] !== "memory_directive") {
    return undefined;
  }

  return `${MEMORY_DIRECTIVE_CLAIM_KEY_PREFIX}${segments[2]}`;
}

/**
 * Resolves directive metadata from a durable row, including legacy abstain rows.
 *
 * @param entry - Candidate directive durable.
 * @returns Parsed directive metadata, or null when the row is not a directive.
 */
export function parseDirectiveMetadata(
  entry: Pick<Durable, "claim_key"> & Partial<Pick<Durable, "type" | "directive_polarity" | "directive_trigger">>,
): ParsedDirectiveMetadata | null {
  if (!isDirectiveDurable(entry)) {
    return null;
  }

  const polarity = parseDirectivePolarity(entry.directive_polarity ?? "abstain");
  if (!polarity) {
    return null;
  }

  const trigger = entry.directive_trigger === undefined ? defaultDirectiveTrigger(polarity) : parseDirectiveTrigger(entry.directive_trigger);
  return trigger ? { polarity, trigger } : null;
}

/**
 * Returns true when a durable is an active proactive directive row.
 *
 * @param entry - Candidate directive durable.
 * @returns True for first-class proactive directive rows.
 */
export function isProactiveDirectiveDurable(
  entry: Pick<Durable, "claim_key"> & Partial<Pick<Durable, "type" | "directive_polarity" | "directive_trigger">>,
): boolean {
  return parseDirectiveMetadata(entry)?.polarity === "proactive";
}

/**
 * Returns the default trigger for one directive polarity.
 *
 * @param polarity - Directive polarity.
 * @returns Default trigger for the polarity.
 */
export function defaultDirectiveTrigger(polarity: DirectivePolarity): DirectiveTrigger {
  return polarity === "proactive" ? DEFAULT_PROACTIVE_DIRECTIVE_TRIGGER : DEFAULT_ABSTAIN_DIRECTIVE_TRIGGER;
}

/** Normalizes text for directive enum and topic matching. */
function normalizeForDirective(value: string): string {
  return value.replace(/\s+/gu, " ").trim().normalize("NFKC").toLocaleLowerCase();
}

export { DEFAULT_ABSTAIN_DIRECTIVE_TRIGGER, DEFAULT_PROACTIVE_DIRECTIVE_TRIGGER, MEMORY_DIRECTIVE_CLAIM_KEY_PREFIX };
