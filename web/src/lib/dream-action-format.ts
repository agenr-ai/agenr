/** Operator-facing formatting helpers for dream run action audit payloads. */

import type { DreamRunActionView } from "../api/types.js";
import { summarizeAliasEvidence, summarizeAliasProfiles } from "./alias-audit.js";
import { readNumberDetail, readStringArrayDetail } from "./action-details.js";
import { formatDateTime, titleCase } from "./format.js";

/** UUID text emitted by storage-level audit payloads. */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** UUID fragments embedded inside storage-level audit prose. */
export const UUID_IN_TEXT_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu;

/** Detail field labels for operator-facing dream action payloads. */
export const DETAIL_KEY_LABELS: Record<string, string> = {
  claim_key: "Claim key",
  evidence_refs: "Evidence",
  predecessor_id: "Previous durable",
  successor_id: "Replacement durable",
  valid_to: "Valid until",
  alias_entity_prefix: "Alias entity",
  alias_current_claim_keys: "Current keys",
  alias_proposed_claim_key: "Proposed key",
  alias_deterministic_confidence: "Deterministic confidence",
  alias_deterministic_auto_apply_eligible: "Deterministic auto-apply",
  alias_unresolved_reason: "Blocker",
  alias_llm_same_slot: "LLM same slot",
  alias_llm_canonical_claim_key: "LLM canonical key",
  alias_llm_confidence: "LLM confidence",
  alias_llm_rationale: "LLM rationale",
  alias_evidence: "Alias evidence",
  alias_key_profiles: "Alias profiles",
};

/** Operator-facing detail value with the raw value preserved for hover text. */
export interface FormattedDetailValue {
  label: string;
  title: string;
}

type ActionDurable = DreamRunActionView["durables"][number];

/** Formats a dreaming action type for operator display. */
export function formatActionTypeLabel(actionType: string): string {
  return actionType === "flag_review" ? "Needs review" : titleCase(actionType);
}

/** Formats an action detail key for compact display. */
export function formatDetailKey(key: string): string {
  return DETAIL_KEY_LABELS[key] ?? titleCase(key.replaceAll("_", " "));
}

/** Returns whether an action has raw detail fields worth exposing in diagnostics. */
export function hasActionDetails(details: Record<string, unknown> | null | undefined): boolean {
  return details ? Object.values(details).some((value) => value !== null && value !== undefined && value !== "") : false;
}

/** Formats a durable reference as a stable operator-facing label. */
export function formatDurableReference(durableId: string, durableById: Map<string, ActionDurable>): string {
  const durable = durableById.get(durableId);
  if (!durable) {
    return "Missing durable";
  }
  if (durable.claim_key) {
    return `${durable.subject} - ${durable.claim_key}`;
  }
  return durable.subject;
}

/** Formats an affected durable list item without exposing storage IDs. */
export function formatAffectedDurableReference(
  durableId: string,
  details: Record<string, unknown> | null,
  durableById: Map<string, ActionDurable>,
): string {
  const durable = durableById.get(durableId);
  if (durable) {
    return formatDurableReference(durableId, durableById);
  }
  return formatMissingDurableLabel(durableId, details);
}

/** Builds full hover text for an affected durable chip. */
export function formatDurableReferenceTitle(durableId: string, durableById: Map<string, ActionDurable>): string {
  const durable = durableById.get(durableId);
  if (!durable) {
    return `Missing durable: ${durableId}`;
  }
  const parts = [`${durable.subject}`, durable.claim_key ? `Claim key: ${durable.claim_key}` : null, `Durable ID: ${durable.id}`];
  return parts.filter((part): part is string => Boolean(part)).join("\n");
}

/** Builds hover text for an affected durable list item. */
export function formatAffectedDurableReferenceTitle(
  durableId: string,
  details: Record<string, unknown> | null,
  durableById: Map<string, ActionDurable>,
): string {
  const durable = durableById.get(durableId);
  if (durable) {
    return formatDurableReferenceTitle(durableId, durableById);
  }
  return `${formatMissingDurableLabel(durableId, details)}: ${durableId}`;
}

/** Replaces raw durable UUIDs in persisted action prose with friendly labels. */
export function formatActionReasoning(
  reasoning: string,
  details: Record<string, unknown> | null,
  durableById: Map<string, ActionDurable>,
): string {
  const predecessorId = typeof details?.predecessor_id === "string" ? details.predecessor_id : null;
  const successorId = typeof details?.successor_id === "string" ? details.successor_id : null;
  if (predecessorId && successorId && reasoning.startsWith("Superseded durable ")) {
    const predecessor = formatSentenceReference(formatAffectedDurableReference(predecessorId, details, durableById));
    const successor = formatSentenceReference(formatAffectedDurableReference(successorId, details, durableById));
    return `Superseded ${predecessor} with temporal revision ${successor}.`;
  }

  return reasoning.replace(UUID_IN_TEXT_PATTERN, (durableId) => formatAffectedDurableReference(durableId, details, durableById));
}

/** Plain-language evidence summary lines for review proposals. */
export function buildReviewEvidenceLines(details: Record<string, unknown>): string[] {
  const familyReuseCount = readNumberDetail(details.support_family_reuse_count);
  const groundedFamilyReuseCount = readNumberDetail(details.support_grounded_family_reuse_count);
  const supportEvidence = readStringArrayDetail(details.support_evidence);
  const hasSupportedCandidate = details.supported_candidate === true;

  return [
    familyReuseCount > 0
      ? `${familyReuseCount} related memor${familyReuseCount === 1 ? "y already uses" : "ies already use"} a compatible key.`
      : null,
    groundedFamilyReuseCount > 0
      ? `${groundedFamilyReuseCount} of those related memories include supporting provenance.`
      : null,
    hasSupportedCandidate || supportEvidence.length > 0 ? "Dreaming found matching evidence in the existing corpus." : null,
  ].filter((line): line is string => line !== null);
}

/** Formats a structured action detail value for compact display. */
export function formatDetailValue(value: unknown, key: string, durableById: Map<string, ActionDurable>): FormattedDetailValue {
  if (Array.isArray(value)) {
    if (key === "alias_evidence") {
      return summarizeAliasEvidence(value);
    }
    if (key === "alias_key_profiles") {
      return summarizeAliasProfiles(value);
    }
    const entries = value.map((entry) => formatDetailValue(entry, key, durableById));
    return {
      label: summarizeDetailList(entries, key),
      title: entries.map((entry) => entry.title).join("\n"),
    };
  }

  if (typeof value === "object" && value !== null) {
    const raw = JSON.stringify(value);
    return { label: raw, title: raw };
  }

  const text = String(value);
  const durable = durableById.get(text);
  if (durable) {
    return { label: formatDurableReference(text, durableById), title: formatDurableReferenceTitle(text, durableById) };
  }
  if (isTimestampDetail(key, text)) {
    return { label: formatDateTime(text), title: text };
  }
  if (isEvidenceReference(text)) {
    return { label: "Episode evidence", title: text };
  }
  if (UUID_PATTERN.test(text)) {
    return { label: friendlyIdentifierLabel(key), title: text };
  }
  return { label: text, title: text };
}

/** Makes role labels read naturally inside generated prose. */
function formatSentenceReference(label: string): string {
  if (label === "Previous durable" || label === "Replacement durable" || label === "Missing durable") {
    return `${label.charAt(0).toLowerCase()}${label.slice(1)}`;
  }
  return label;
}

/** Labels missing durable references by their role when action details expose it. */
function formatMissingDurableLabel(durableId: string, details: Record<string, unknown> | null): string {
  if (details?.predecessor_id === durableId) {
    return "Previous durable";
  }
  if (details?.successor_id === durableId) {
    return "Replacement durable";
  }
  return "Missing durable";
}

/** Summarizes repeated action detail values without exposing raw storage IDs. */
function summarizeDetailList(entries: FormattedDetailValue[], key: string): string {
  if (entries.length === 0) {
    return "-";
  }
  if (key === "evidence_refs") {
    return entries.length === 1 ? entries[0]?.label ?? "Evidence" : `${entries.length} evidence refs`;
  }
  return entries.map((entry) => entry.label).join(", ");
}

/** Returns whether a detail value is an ISO timestamp field. */
function isTimestampDetail(key: string, value: string): boolean {
  if (!/(?:_at|_to|_from)$/u.test(key)) {
    return false;
  }
  return Number.isFinite(Date.parse(value));
}

/** Returns whether a raw evidence reference contains an internal storage UUID. */
function isEvidenceReference(value: string): boolean {
  const [prefix, id] = value.split(":", 2);
  return prefix === "episode" && id !== undefined && UUID_PATTERN.test(id);
}

/** Builds a generic friendly label for an internal identifier detail. */
function friendlyIdentifierLabel(key: string): string {
  const label = DETAIL_KEY_LABELS[key] ?? titleCase(key.replaceAll("_", " "));
  return label.toLowerCase().includes("durable") ? label : `${label} record`;
}
