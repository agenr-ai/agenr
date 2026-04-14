import { recall, type RecallExecutionTraceSummary, type RecallOutput } from "../../core/recall/index.js";

import { runProcedureRecall } from "../procedures/recall/service.js";
import { projectClaimCentricRecallEntry } from "../recall/claim-centric.js";

import type { BeforeTurnDeps } from "./ports.js";
import type {
  BeforeTurnInput,
  BeforeTurnPatch,
  BeforeTurnPatchDiagnostics,
  BeforeTurnPatchItem,
  BeforeTurnPolicy,
  BeforeTurnProcedureSuggestion,
  BeforeTurnRecentTurn,
} from "./types.js";

const DEFAULT_MAX_DURABLE_ENTRIES = 3;
const DEFAULT_MAX_RECENT_TURNS = 4;
const DEFAULT_MAX_QUERY_CHARS = 900;
const DEFAULT_MAX_PROCEDURE_CANDIDATES = 3;
const DEFAULT_RECALL_THRESHOLD = 0.2;
const DEFAULT_PROCEDURE_THRESHOLD = 0.6;
const SHORT_SOCIAL_TURN_RE =
  /^(?:hi|hello|hey|hey there|hello there|thanks|thank you|ok|okay|cool|sounds good|got it|yep|yes|no|nice|great|awesome|perfect|ping)(?:[.!?]+)?$/iu;

/**
 * Builds one structured bounded before-turn patch from the current user turn
 * plus a small recent-turn window.
 *
 * @param input - Host-neutral before-turn facts and policy hints.
 * @param deps - Shared durable recall and procedure-recall dependencies.
 * @returns Structured before-turn patch for adapter rendering and inspection.
 */
export async function runBeforeTurn(input: BeforeTurnInput, deps: BeforeTurnDeps): Promise<BeforeTurnPatch> {
  const policy = normalizePolicy(input.policy);
  const currentTurnText = normalizeOptionalString(input.currentTurnText);
  const recentTurns = normalizeRecentTurns(input.recentTurns, policy.maxRecentTurns, currentTurnText);
  const diagnostics: BeforeTurnPatchDiagnostics = {
    recentTurnCount: recentTurns.length,
    durableRecallUsed: false,
    durableRecallCandidateCount: 0,
    procedureRecallUsed: false,
    procedureCandidateCount: 0,
    abstained: false,
    abstentionReasons: [],
    notices: [],
  };

  if (!currentTurnText) {
    diagnostics.abstained = true;
    diagnostics.abstentionReasons.push("Current turn text was empty after normalization.");
    return {
      durableMemory: [],
      diagnostics,
    };
  }

  if (SHORT_SOCIAL_TURN_RE.test(normalizeWhitespace(currentTurnText))) {
    diagnostics.abstained = true;
    diagnostics.abstentionReasons.push("Current turn was a short social greeting, so before-turn recall abstained.");
    return {
      durableMemory: [],
      diagnostics,
    };
  }

  const query = buildBeforeTurnQuery(currentTurnText, recentTurns, policy.maxQueryChars);
  const procedureQuery = buildProcedureQuery(currentTurnText, recentTurns, policy.maxQueryChars);
  if (!query) {
    diagnostics.abstained = true;
    diagnostics.abstentionReasons.push("No usable before-turn query could be derived from the turn context.");
    return {
      durableMemory: [],
      diagnostics,
    };
  }

  diagnostics.query = query;

  const [durableMemory, procedure] = await Promise.all([
    policy.enableDurableRecall ? runDurableRecallSelection(query, input.sessionKey, policy, deps, diagnostics) : Promise.resolve([]),
    policy.enableProcedureSuggestion && procedureQuery ? runProcedureSelection(procedureQuery, policy, deps, diagnostics) : Promise.resolve(undefined),
  ]);

  if (!policy.enableDurableRecall) {
    diagnostics.abstentionReasons.push("Durable recall disabled by before-turn policy.");
  } else if (durableMemory.length === 0) {
    diagnostics.abstentionReasons.push("No durable memory entries cleared the before-turn threshold.");
  }

  if (!policy.enableProcedureSuggestion) {
    diagnostics.abstentionReasons.push("Procedure suggestion disabled by before-turn policy.");
  } else if (!procedure) {
    diagnostics.abstentionReasons.push("No canonical procedure suggestion cleared the before-turn threshold.");
  }

  diagnostics.abstained = durableMemory.length === 0 && !procedure;

  return {
    durableMemory: assignRanks(durableMemory),
    ...(procedure ? { procedure } : {}),
    diagnostics,
  };
}

/**
 * Runs bounded durable-memory recall anchored on the active turn context.
 *
 * @param query - Normalized turn-derived recall query.
 * @param sessionKey - Optional session key for recall telemetry.
 * @param policy - Effective before-turn policy.
 * @param deps - Shared durable recall dependencies.
 * @param diagnostics - Mutable diagnostics sink updated in place.
 * @returns Ranked durable-memory patch items.
 */
async function runDurableRecallSelection(
  query: string,
  sessionKey: string | undefined,
  policy: Required<BeforeTurnPolicy>,
  deps: BeforeTurnDeps,
  diagnostics: BeforeTurnPatchDiagnostics,
): Promise<BeforeTurnPatchItem[]> {
  diagnostics.durableRecallUsed = true;

  let durableRecallTrace: RecallExecutionTraceSummary | undefined;
  try {
    const recalled = await recall(
      {
        text: query,
        limit: policy.maxDurableEntries,
        threshold: policy.recallThreshold,
        sessionKey,
      },
      deps.recall,
      {
        trace: {
          reportSummary(summary): void {
            durableRecallTrace = summary;
          },
        },
        slotPolicyConfig: deps.slotPolicyConfig,
      },
    );

    diagnostics.durableRecallTrace = durableRecallTrace;
    diagnostics.durableRecallCandidateCount = recalled.length;
    if (durableRecallTrace?.degraded.notices.length) {
      diagnostics.notices.push(...durableRecallTrace.degraded.notices);
    }

    return recalled.map((item) => buildDurablePatchItem(item, deps));
  } catch (error) {
    diagnostics.durableRecallTrace = durableRecallTrace;
    diagnostics.notices.push(`Before-turn durable recall failed: ${formatErrorMessage(error)}`);
    return [];
  }
}

/**
 * Runs dedicated procedure recall and returns one canonical proactive suggestion
 * only when the leader is clearly stable enough.
 *
 * @param query - Normalized turn-derived procedure query.
 * @param policy - Effective before-turn policy.
 * @param deps - Procedure-recall dependencies.
 * @param diagnostics - Mutable diagnostics sink updated in place.
 * @returns One proactive procedure suggestion, or `undefined` when abstaining.
 */
async function runProcedureSelection(
  query: string,
  policy: Required<BeforeTurnPolicy>,
  deps: BeforeTurnDeps,
  diagnostics: BeforeTurnPatchDiagnostics,
): Promise<BeforeTurnProcedureSuggestion | undefined> {
  diagnostics.procedureRecallUsed = true;

  try {
    const result = await runProcedureRecall(
      {
        text: query,
        limit: policy.maxProcedureCandidates,
        threshold: policy.procedureThreshold,
      },
      {
        db: deps.procedures,
        ...(deps.embedQuery ? { embedQuery: deps.embedQuery } : {}),
      },
    );

    diagnostics.procedureCandidateCount = result.candidates.length;
    if (result.notices.length > 0) {
      diagnostics.notices.push(...result.notices);
    }

    const canonicalProcedure = result.canonicalProcedure;
    if (!canonicalProcedure) {
      return undefined;
    }

    const leader = result.candidates.find((candidate) => candidate.procedure.id === canonicalProcedure.id);
    if (!leader) {
      diagnostics.notices.push("Procedure recall returned a canonical procedure without a matching ranked candidate.");
      return undefined;
    }

    return {
      procedure: canonicalProcedure,
      score: leader.score,
      scores: {
        relevance: leader.scores.relevance,
        lexical: leader.scores.lexical,
        vector: leader.scores.vector,
      },
      whySurfaced: {
        summary: `canonical procedure match; score ${leader.score.toFixed(2)}`,
        reasons: [
          "canonical procedure match",
          `score ${leader.score.toFixed(2)}`,
          `lexical ${leader.scores.lexical.toFixed(2)}`,
          `vector ${leader.scores.vector.toFixed(2)}`,
        ],
      },
    };
  } catch (error) {
    diagnostics.notices.push(`Before-turn procedure recall failed: ${formatErrorMessage(error)}`);
    return undefined;
  }
}

/**
 * Converts one durable recall result into a structured before-turn patch item.
 *
 * @param recalled - Ranked durable recall result.
 * @param deps - Before-turn dependencies with optional slot-policy overrides.
 * @returns Structured patch item enriched with claim-centric inspection metadata.
 */
function buildDurablePatchItem(recalled: RecallOutput, deps: BeforeTurnDeps): BeforeTurnPatchItem {
  const projected = projectClaimCentricRecallEntry(recalled, {
    slotPolicyConfig: deps.slotPolicyConfig,
  });
  return {
    rank: 0,
    entry: recalled.entry,
    sourceKind: "turn_recall",
    score: recalled.score,
    whySurfaced: projected.whySurfaced,
    memoryState: projected.memoryState,
    claimStatus: projected.claimStatus,
    freshnessLabel: projected.freshness.label,
    ...(formatProjectedProvenance(projected.provenance) ? { provenanceSummary: formatProjectedProvenance(projected.provenance) } : {}),
  };
}

/**
 * Builds one bounded before-turn query from the current user turn plus a small
 * recent-turn window.
 *
 * @param currentTurnText - Current user-turn text after normalization.
 * @param recentTurns - Ordered recent turns preserved for extra context.
 * @param maxChars - Maximum character budget for the derived query.
 * @returns Normalized recall query, or `undefined` when empty.
 */
function buildBeforeTurnQuery(currentTurnText: string, recentTurns: BeforeTurnRecentTurn[], maxChars: number): string | undefined {
  if (maxChars <= 0) {
    return undefined;
  }

  let remaining = maxChars;
  const parts: string[] = [];
  const currentTurnPart = truncate(`Current turn: ${normalizeWhitespace(currentTurnText)}`, remaining);
  if (currentTurnPart.length === 0) {
    return undefined;
  }
  parts.push(currentTurnPart);
  remaining -= currentTurnPart.length;

  for (const turn of recentTurns) {
    if (remaining <= 0) {
      break;
    }

    const labeled = `${turn.role === "user" ? "User" : "Assistant"}: ${normalizeWhitespace(turn.text)}`;
    const truncated = truncate(labeled, remaining);
    if (truncated.length === 0) {
      continue;
    }

    parts.push(truncated);
    remaining -= truncated.length;
  }

  const query = normalizeWhitespace(parts.join("\n"));
  return query.length > 0 ? query : undefined;
}

/**
 * Builds the query used for proactive procedure suggestion.
 *
 * Procedure selection should stay anchored mostly on the current user ask so
 * generic recent-turn context does not dilute canonical-match scoring.
 *
 * @param currentTurnText - Current user-turn text after normalization.
 * @param recentTurns - Ordered recent turns preserved for fallback context.
 * @param maxChars - Maximum character budget for the derived query.
 * @returns Procedure-query text, or undefined when no usable text exists.
 */
function buildProcedureQuery(currentTurnText: string, recentTurns: BeforeTurnRecentTurn[], maxChars: number): string | undefined {
  const normalizedCurrentTurn = normalizeWhitespace(currentTurnText);
  if (normalizedCurrentTurn.length > 0) {
    return truncate(normalizedCurrentTurn, maxChars);
  }

  const recentUserTurn = [...recentTurns].reverse().find((turn) => turn.role === "user");
  return recentUserTurn ? truncate(normalizeWhitespace(recentUserTurn.text), maxChars) : undefined;
}

/**
 * Assigns stable one-based ranks to the final durable-memory items.
 *
 * @param items - Final bounded durable-memory set.
 * @returns Ranked durable-memory items.
 */
function assignRanks(items: BeforeTurnPatchItem[]): BeforeTurnPatchItem[] {
  return items.map((item, index) => ({
    ...item,
    rank: index + 1,
  }));
}

/**
 * Normalizes optional before-turn policy hints into concrete bounded values.
 *
 * @param policy - Optional caller-supplied policy hints.
 * @returns Concrete effective policy.
 */
function normalizePolicy(policy: BeforeTurnPolicy | undefined): Required<BeforeTurnPolicy> {
  return {
    enableDurableRecall: policy?.enableDurableRecall !== false,
    enableProcedureSuggestion: policy?.enableProcedureSuggestion !== false,
    maxRecentTurns: normalizeCount(policy?.maxRecentTurns, DEFAULT_MAX_RECENT_TURNS),
    maxQueryChars: normalizeCount(policy?.maxQueryChars, DEFAULT_MAX_QUERY_CHARS),
    maxDurableEntries: normalizeCount(policy?.maxDurableEntries, DEFAULT_MAX_DURABLE_ENTRIES),
    maxProcedureCandidates: normalizeCount(policy?.maxProcedureCandidates, DEFAULT_MAX_PROCEDURE_CANDIDATES),
    recallThreshold: normalizeThreshold(policy?.recallThreshold, DEFAULT_RECALL_THRESHOLD),
    procedureThreshold: normalizeThreshold(policy?.procedureThreshold, DEFAULT_PROCEDURE_THRESHOLD),
  };
}

/**
 * Normalizes one optional bounded count.
 *
 * @param value - Raw caller-supplied count.
 * @param fallback - Default value used when the input is absent or invalid.
 * @returns Effective non-negative integer count.
 */
function normalizeCount(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(0, Math.trunc(value));
}

/**
 * Normalizes one optional score threshold.
 *
 * @param value - Raw caller-supplied threshold.
 * @param fallback - Default value used when the input is absent or invalid.
 * @returns Effective threshold clamped into the inclusive 0-1 range.
 */
function normalizeThreshold(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.min(1, Math.max(0, value));
}

/**
 * Normalizes the recent-turn window used while building the before-turn query.
 *
 * @param recentTurns - Raw recent turns supplied by the host adapter.
 * @param maxRecentTurns - Maximum turns to preserve.
 * @param currentTurnText - Normalized current-turn text used for dedupe.
 * @returns Ordered normalized recent turns.
 */
function normalizeRecentTurns(
  recentTurns: BeforeTurnRecentTurn[] | undefined,
  maxRecentTurns: number,
  currentTurnText: string | undefined,
): BeforeTurnRecentTurn[] {
  if (!recentTurns || recentTurns.length === 0 || maxRecentTurns <= 0) {
    return [];
  }

  const normalizedTurns = recentTurns.flatMap((turn) => {
    if (turn.role !== "user" && turn.role !== "assistant") {
      return [];
    }

    const text = normalizeOptionalString(turn.text);
    return text ? [{ role: turn.role, text }] : [];
  });

  const currentTurnFingerprint = currentTurnText ? normalizeWhitespace(currentTurnText).toLowerCase() : undefined;
  const deduped = [...normalizedTurns];
  while (deduped.length > 0 && currentTurnFingerprint) {
    const last = deduped[deduped.length - 1];
    if (!last || last.role !== "user") {
      break;
    }

    if (normalizeWhitespace(last.text).toLowerCase() !== currentTurnFingerprint) {
      break;
    }

    deduped.pop();
  }

  return deduped.slice(-maxRecentTurns);
}

/**
 * Formats the projected claim-centric provenance shape into one compact string.
 *
 * @param provenance - Claim-centric projected provenance metadata.
 * @returns Compact provenance summary, or undefined when none exists.
 */
function formatProjectedProvenance(provenance: ReturnType<typeof projectClaimCentricRecallEntry>["provenance"]): string | undefined {
  const parts = [
    provenance.supersededById ? `superseded_by=${provenance.supersededById}` : undefined,
    provenance.supersessionKind ? `kind=${provenance.supersessionKind}` : undefined,
    provenance.supersessionReason ? `reason=${provenance.supersessionReason}` : undefined,
    provenance.supportSourceKind ? `support=${provenance.supportSourceKind}` : undefined,
    provenance.supportMode ? `support_mode=${provenance.supportMode}` : undefined,
    provenance.supportObservedAt ? `observed=${provenance.supportObservedAt}` : undefined,
    provenance.supportLocator ? `locator=${provenance.supportLocator}` : undefined,
  ].filter((value): value is string => value !== undefined);

  return parts.length > 0 ? parts.join(" | ") : undefined;
}

/**
 * Normalizes optional multiline text by trimming blank padding.
 *
 * @param value - Candidate optional text.
 * @returns Normalized text, or undefined when empty.
 */
function normalizeOptionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

/**
 * Collapses repeated whitespace inside one text value for query use.
 *
 * @param value - Raw text.
 * @returns Query-friendly normalized text.
 */
function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Truncates one string to the requested character budget.
 *
 * @param value - Raw string.
 * @param maxChars - Maximum characters to keep.
 * @returns Truncated string.
 */
function truncate(value: string, maxChars: number): string {
  if (maxChars <= 0) {
    return "";
  }

  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

/**
 * Formats unknown failures into stable human-readable text.
 *
 * @param error - Unknown failure value.
 * @returns Human-readable error message.
 */
function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
