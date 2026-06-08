/** Operator-facing helpers for claim-key alias convergence audit payloads. */

import { formatPercent, titleCase } from "./format.js";
import { isRecord, readNullableNumberDetail, readStringArrayDetail } from "./action-details.js";

/** Compact alias audit summary derived from persisted action details. */
export interface AliasReviewSummaryView {
  entityPrefix: string | null;
  currentKeys: string[];
  proposedKey: string | null;
  deterministicConfidence: number | null;
  llmSameSlot: boolean | null;
  llmConfidence: number | null;
  llmRationale: string | null;
}

/** Operator-facing detail value with the raw value preserved for hover text. */
export interface FormattedAliasDetailValue {
  label: string;
  title: string;
}

/**
 * Builds a typed alias audit summary from persisted action details.
 *
 * @param details - Raw dream action detail payload.
 * @returns Alias summary when alias audit fields are present.
 */
export function buildAliasReviewSummary(details: Record<string, unknown>): AliasReviewSummaryView | null {
  const currentKeys = readStringArrayDetail(details.alias_current_claim_keys);
  const proposedKey = typeof details.alias_proposed_claim_key === "string" ? details.alias_proposed_claim_key : null;
  if (currentKeys.length === 0 && !proposedKey) {
    return null;
  }

  return {
    entityPrefix: typeof details.alias_entity_prefix === "string" ? details.alias_entity_prefix : null,
    currentKeys,
    proposedKey,
    deterministicConfidence: readNullableNumberDetail(details.alias_deterministic_confidence),
    llmSameSlot: typeof details.alias_llm_same_slot === "boolean" ? details.alias_llm_same_slot : null,
    llmConfidence: readNullableNumberDetail(details.alias_llm_confidence),
    llmRationale: typeof details.alias_llm_rationale === "string" ? details.alias_llm_rationale : null,
  };
}

/**
 * Formats a stored automatic-apply blocker without internal enum wording.
 *
 * @param blocker - Persisted blocker code or sentence.
 * @returns Operator-facing blocker text.
 */
export function formatAliasAutoApplyBlocker(blocker: string): string {
  if (blocker === "cross_type_collision") {
    return "Another active memory already uses that key for a different type";
  }
  if (!blocker.includes("_")) {
    return blocker;
  }
  return `Automatic apply was blocked by ${titleCase(blocker.replaceAll("_", " ")).toLowerCase()}`;
}

/**
 * Summarizes structured alias evidence without falling back to raw JSON.
 *
 * @param value - Persisted alias evidence array.
 * @returns Compact label and hover title.
 */
export function summarizeAliasEvidence(value: unknown[]): FormattedAliasDetailValue {
  const lines = value
    .map((entry) => {
      if (!isRecord(entry)) {
        return null;
      }
      const kind = typeof entry.kind === "string" ? titleCase(entry.kind.replaceAll("_", " ")) : "Evidence";
      const detail = typeof entry.detail === "string" ? entry.detail : null;
      return detail ? `${kind}: ${detail}` : kind;
    })
    .filter((line): line is string => line !== null);

  return {
    label: lines.length === 1 ? lines[0] ?? "1 evidence item" : `${lines.length} evidence items`,
    title: lines.join("\n"),
  };
}

/**
 * Summarizes alias key profiles without exposing raw JSON.
 *
 * @param value - Persisted alias key profile array.
 * @returns Compact label and hover title.
 */
export function summarizeAliasProfiles(value: unknown[]): FormattedAliasDetailValue {
  const lines = value
    .map((entry) => {
      if (!isRecord(entry) || typeof entry.claimKey !== "string") {
        return null;
      }
      const durableIds = Array.isArray(entry.durableIds) ? entry.durableIds.filter((id): id is string => typeof id === "string") : [];
      const durableCount = durableIds.length;
      const trustedOrManualCount = typeof entry.trustedOrManualCount === "number" ? entry.trustedOrManualCount : 0;
      const trustLabel = trustedOrManualCount > 0 ? "trusted/manual" : "tentative";
      return `${entry.claimKey} (${durableCount} durable${durableCount === 1 ? "" : "s"}, ${trustLabel})`;
    })
    .filter((line): line is string => line !== null);

  return {
    label: lines.length === 1 ? lines[0] ?? "1 key profile" : `${lines.length} key profiles`,
    title: lines.join("\n"),
  };
}

/**
 * Formats claim-key arrays for compact review summaries.
 *
 * @param values - Claim keys to display.
 * @param fallback - Text when the list is empty.
 * @returns Joined claim keys or fallback text.
 */
export function formatClaimKeyList(values: string[], fallback: string): string {
  return values.length > 0 ? values.join(", ") : fallback;
}

/**
 * Renders deterministic and LLM alias audit fields for operator review.
 *
 * @param input - Alias audit summary fields.
 * @returns JSX lines for the alias audit block.
 */
export function renderAliasReviewSummaryLines(input: {
  summary: AliasReviewSummaryView;
  formatClaimKeys: (values: string[], fallback: string) => string;
}): Array<{ key: string; text: string } | null> {
  const { summary } = input;
  const formatKeys = input.formatClaimKeys;
  return [
    summary.entityPrefix ? { key: "entity", text: `Entity: ${summary.entityPrefix}` } : null,
    { key: "current-keys", text: `Current keys: ${formatKeys(summary.currentKeys, "(none)")}` },
    summary.proposedKey ? { key: "target-key", text: `Target key: ${summary.proposedKey}` } : null,
    summary.deterministicConfidence !== null
      ? { key: "deterministic-confidence", text: `Deterministic confidence: ${formatPercent(summary.deterministicConfidence)}` }
      : null,
    summary.llmSameSlot !== null
      ? { key: "llm-verdict", text: `LLM verdict: ${summary.llmSameSlot ? "same slot" : "different slots"}` }
      : null,
    summary.llmConfidence !== null ? { key: "llm-confidence", text: `LLM confidence: ${formatPercent(summary.llmConfidence)}` } : null,
    summary.llmRationale ? { key: "llm-rationale", text: `LLM rationale: ${summary.llmRationale}` } : null,
  ];
}
