import { recall, type RecallExecutionTraceSummary, type RecallOutput } from "../../core/recall/index.js";

import { runProcedureRecall } from "../procedures/recall/service.js";
import { projectClaimCentricRecallEntry } from "../recall/claim-centric.js";

import type { BeforeTurnDeps } from "./ports.js";
import type {
  BeforeTurnDirectnessDiagnostics,
  BeforeTurnDirectnessQueryKind,
  BeforeTurnDirectnessSignal,
  BeforeTurnInput,
  BeforeTurnPatch,
  BeforeTurnPatchDiagnostics,
  BeforeTurnPatchItem,
  BeforeTurnPolicy,
  BeforeTurnProcedureSuggestion,
  BeforeTurnQueryPolicy,
  BeforeTurnQueryVariant,
  BeforeTurnQueryVariantKind,
  BeforeTurnRecentTurn,
  BeforeTurnSignalLabel,
  BeforeTurnSuppressedTurnCategory,
} from "./types.js";

const DEFAULT_MAX_DURABLE_ENTRIES = 1;
const DEFAULT_MAX_HIGH_CONFIDENCE_DURABLE_ENTRIES = 2;
const DEFAULT_MAX_RECENT_TURNS = 2;
const DEFAULT_MAX_QUERY_CHARS = 450;
const DEFAULT_MAX_PROCEDURE_CANDIDATES = 3;
const DEFAULT_RECALL_THRESHOLD = 0.6;
/**
 * Minimum composite recall score treated as "high confidence" by the
 * before-turn selector.
 *
 * This gate decides two things:
 * 1. Whether `shouldRetryWeakPrimaryWithContext` accepts the current-turn-only
 *    winner as strong enough to skip the contextual-fallback retry.
 * 2. Whether `selectDurablePatchItems` may expand past the normal one-item
 *    cap up to `maxHighConfidenceDurableEntries`.
 *
 * The pre-RRF default of `0.85` was tuned for the legacy continuous blend,
 * where composite scores rarely cleared `0.85` without a dominant-on-both-
 * channels top candidate. Reciprocal rank fusion (see
 * `src/core/recall/fusion.ts`) normalizes rank-based contributions so a
 * top-1 in one channel alone already maps to an RRF relevance of `0.5`, and
 * a single-candidate pool lands at `1.0` after normalization. With
 * `score = 0.5 * relevance + 0.25 * recency + 0.25 * importance`, even
 * moderately good single-channel leaders with strong recency and importance
 * can clear `0.85`, which suppresses the contextual-fallback retry on
 * continuation-style turns like `"what should we do next?"`.
 *
 * The initial phase-2 recalibration raised the gate to `0.92`. The
 * phase-0 attribution sweep at run `2026-04-19T23-07-52-044Z` showed that
 * still was not enough: rows 22 and 23 in
 * `docs/internal/recall/regression-attribution.md` seed a single-entry
 * memory pool where the RRF-normalized relevance is exactly `1.0`, and the
 * default importance 6 with near-zero age composes to `0.5 + 0.25 + 0.25 *
 * 0.733 = ~0.933` - still above `0.92`, so the continuation-style fallback
 * never fired.
 *
 * The phase-2 follow-up raises the gate to `0.97`. This keeps the
 * high-confidence behavior gated on candidates whose composite score is
 * effectively at the ceiling (top-1 in both channels, near-maximum importance,
 * near-maximum recency), and lets the single-candidate "first turn after a
 * continuation cue" cases escalate to the contextual fallback they were
 * designed for. The precision floor for this gate is the
 * importance-10 very-recent permanent entry, whose composite is ~`0.999`
 * and therefore still clears `0.97`; that shape is pinned by the
 * "keeps the current-turn-only variant when the primary score clears the
 * recalibrated default" regression test.
 *
 * See the threshold-induced rows in
 * `docs/internal/recall/regression-attribution.md` for the cases this
 * recalibration targets.
 */
const DEFAULT_HIGH_CONFIDENCE_RECALL_THRESHOLD = 0.97;
const DEFAULT_PROCEDURE_THRESHOLD = 0.72;
const DEFAULT_SKIP_TRIVIAL_TURNS = true;
const DEFAULT_REQUIRE_TURN_SIGNAL = true;
const SHORT_TURN_MAX_WORDS = 4;
const SHORT_TURN_MAX_CHARS = 24;
const SOCIAL_TURN_RE =
  /^(?:hi|hello|hey|hey there|hello there|thanks|thank you|ok|okay|cool|sounds good|got it|yep|yes|no|nice|great|awesome|perfect|ping)(?:[.!?]+)?$/iu;
const TASK_SIGNAL_RE =
  /\b(?:do|make|create|draft|write|send|schedule|book|reserve|organize|arrange|prepare|plan|choose|decide|contact|call|email|message|buy|order|find|search|check|compare|review|explain|summarize|investigate|research|use|apply|remember|recall|assist|help|should|need to|help me)\b/iu;
const FACTUAL_SIGNAL_RE =
  /\b(?:what(?:'s|\s+is|\s+was|\s+were)?|which|where|who|when|how much|how many|what time|what day|did we|do we|previous|prior|earlier|before|last|again|decision|preference|fact|rule|policy|status|availability|location|address|phone|email|price|cost|budget|deadline|date|time|name|called|uses|used|change(?:d)?|order|reservation|appointment|account|contact)\b/iu;
const PROCEDURAL_SIGNAL_RE =
  /\b(?:how do i|how should i|how can i|how to|what should i do|what do i need to do|steps|procedure|process|workflow|runbook|playbook|guide|guidance|instructions|checklist|recipe|template|walk me through|step by step|best way to|planning|arrange|prepare|book|reserve|schedule|rollout|migration|incident response)\b/iu;
const CONTEXT_REFERENCE_RE = /\b(?:it|its|that|this|they|them|their|those|these|he|him|his|she|her|hers|other one|other ones)\b/iu;
const HARD_CONTEXT_PREFIX_RE = /^(?:and\b|also\b|what about\b|how about\b|same\b|same as\b)/iu;
const SOFT_CONTEXT_FALLBACK_RE = /\b(?:next|follow up|follow-up|continue|continuation)\b/iu;
const CONTEXT_QUESTION_PREFIX_RE = /^(?:when|where|why|should|does|is|are|what should)\b/iu;
const MAX_CONTEXT_ANCHOR_CHARS = 120;
const DIRECTNESS_STABLE_GAP = 0.08;
const DIRECTNESS_SUBJECT_ENTITY_MATCH_BONUS = 0.16;
const DIRECTNESS_SUBJECT_IDENTITY_WRAPPER_BONUS = 0.12;
const DIRECTNESS_DEFINITIONAL_CONTENT_BONUS = 0.22;
const DIRECTNESS_CLAIM_KEY_ENTITY_MATCH_BONUS = 0.18;
const DIRECTNESS_ADJACENT_RELATIONSHIP_PENALTY = 0.18;
const DIRECTNESS_LIST_LORE_PENALTY = 0.08;
const ENTITY_DIRECTNESS_MAX_WORDS = 5;
const ENTITY_DIRECTNESS_RECALL_CANDIDATE_LIMIT = 5;
const DIRECTNESS_IDENTITY_WRAPPERS = new Set(["identity", "profile", "bio", "biography", "definition", "overview", "summary"]);
const DIRECTNESS_RELATIONSHIP_KEYWORDS = new Set([
  "cousin",
  "cousins",
  "family",
  "brother",
  "brothers",
  "sister",
  "sisters",
  "mother",
  "father",
  "parent",
  "parents",
  "friend",
  "friends",
  "relationship",
  "relationships",
  "owner",
  "owners",
]);
const DIRECTNESS_LIST_LORE_KEYWORDS = new Set(["list", "notes", "timeline", "history", "background", "facts", "lore"]);

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
    queryVariants: [],
    recentTurnCount: recentTurns.length,
    turnSignalLabels: [],
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

  const turnSignal = inspectTurnSignal(currentTurnText);
  diagnostics.turnSignalLabels = turnSignal.signalLabels;
  if (turnSignal.suppressedTurnCategory) {
    diagnostics.suppressedTurnCategory = turnSignal.suppressedTurnCategory;
  }

  if (policy.skipTrivialTurns && turnSignal.suppressedTurnCategory && turnSignal.suppressedTurnCategory !== "low_signal") {
    diagnostics.abstained = true;
    diagnostics.abstentionReasons.push(turnSignal.reason);
    return {
      durableMemory: [],
      diagnostics,
    };
  }

  if (policy.requireTurnSignal && turnSignal.signalLabels.length === 0) {
    diagnostics.abstained = true;
    diagnostics.abstentionReasons.push(turnSignal.reason);
    return {
      durableMemory: [],
      diagnostics,
    };
  }

  const durableQueryPlan = buildDurableRecallQueryPlan(currentTurnText, recentTurns, policy.maxQueryChars);
  const procedureQuery = buildProcedureQuery(currentTurnText, recentTurns, policy.maxQueryChars);
  if (!durableQueryPlan) {
    diagnostics.abstained = true;
    diagnostics.abstentionReasons.push("No usable before-turn query could be derived from the turn context.");
    return {
      durableMemory: [],
      diagnostics,
    };
  }

  const [durableMemory, procedure] = await Promise.all([
    policy.enableDurableRecall
      ? runDurableRecallSelection(currentTurnText, durableQueryPlan, input.sessionKey, policy, deps, diagnostics)
      : Promise.resolve([]),
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
 * @param queryPlan - Normalized durable-query plan for the active turn.
 * @param sessionKey - Optional session key for recall telemetry.
 * @param policy - Effective before-turn policy.
 * @param deps - Shared durable recall dependencies.
 * @param diagnostics - Mutable diagnostics sink updated in place.
 * @returns Ranked durable-memory patch items.
 */
async function runDurableRecallSelection(
  currentTurnText: string,
  queryPlan: DurableRecallQueryPlan,
  sessionKey: string | undefined,
  policy: Required<BeforeTurnPolicy>,
  deps: BeforeTurnDeps,
  diagnostics: BeforeTurnPatchDiagnostics,
): Promise<BeforeTurnPatchItem[]> {
  diagnostics.durableRecallUsed = true;
  const attemptedVariants: BeforeTurnQueryVariant[] = [];
  const primaryResult = await runDurableRecallAttempt(currentTurnText, queryPlan.primary.query, sessionKey, policy, deps, diagnostics);
  attemptedVariants.push({
    kind: queryPlan.primary.kind,
    query: queryPlan.primary.query,
    candidateCount: primaryResult.candidateCount,
    selected: primaryResult.items.length > 0,
  });

  if (queryPlan.fallback === undefined || (primaryResult.items.length > 0 && !shouldRetryWeakPrimaryWithContext(primaryResult, policy))) {
    diagnostics.query = queryPlan.primary.query;
    diagnostics.queryPolicy = queryPlan.policy;
    diagnostics.queryVariants = attemptedVariants;
    diagnostics.durableRecallTrace = primaryResult.durableRecallTrace;
    diagnostics.durableRecallCandidateCount = primaryResult.candidateCount;
    diagnostics.directness = primaryResult.directness;
    if (primaryResult.notices.length > 0) {
      diagnostics.notices.push(...primaryResult.notices);
    }
    if (primaryResult.directness?.decision === "abstained") {
      diagnostics.abstentionReasons.push(primaryResult.directness.reason);
    }
    return primaryResult.items;
  }

  const fallbackPlan = queryPlan.fallback;
  const primaryItems = primaryResult.items;
  const fallbackResult = await runDurableRecallAttempt(currentTurnText, fallbackPlan.query, sessionKey, policy, deps, diagnostics);
  const shouldUseFallback = fallbackResult.items.length > 0;
  attemptedVariants[0] = {
    ...attemptedVariants[0],
    selected: primaryItems.length > 0 && !shouldUseFallback,
  };
  attemptedVariants.push({
    kind: fallbackPlan.kind,
    query: fallbackPlan.query,
    candidateCount: fallbackResult.candidateCount,
    selected: shouldUseFallback,
  });

  const selectedResult = shouldUseFallback ? fallbackResult : primaryResult;
  const selectedQuery = shouldUseFallback ? fallbackPlan.query : queryPlan.primary.query;
  const selectedPolicy = shouldUseFallback ? "contextual_fallback" : queryPlan.policy;

  diagnostics.query = selectedQuery;
  diagnostics.queryPolicy = selectedPolicy;
  diagnostics.queryVariants = attemptedVariants;
  diagnostics.durableRecallTrace = selectedResult.durableRecallTrace;
  diagnostics.durableRecallCandidateCount = selectedResult.candidateCount;
  diagnostics.directness = selectedResult.directness;
  if (primaryResult.notices.length > 0) {
    diagnostics.notices.push(...primaryResult.notices);
  }
  if (fallbackResult.notices.length > 0) {
    diagnostics.notices.push(...fallbackResult.notices);
  }
  if (selectedResult.directness?.decision === "abstained") {
    diagnostics.abstentionReasons.push(selectedResult.directness.reason);
  }
  return selectedResult.items;
}

/**
 * Returns whether a continuation-style turn should retry with compact context
 * even though the bare current-turn query surfaced a bounded result.
 *
 * @param primaryResult - Primary current-turn-only durable recall attempt.
 * @param policy - Effective before-turn policy.
 * @returns `true` when the primary winner is below the high-confidence bar.
 */
function shouldRetryWeakPrimaryWithContext(primaryResult: DurableRecallAttemptResult, policy: Required<BeforeTurnPolicy>): boolean {
  const topScore = primaryResult.items[0]?.score;
  return typeof topScore === "number" && topScore < policy.highConfidenceRecallThreshold;
}

/**
 * One attempted durable-memory recall pass for one derived query string.
 *
 * @param query - Normalized turn-derived recall query.
 * @param sessionKey - Optional session key for recall telemetry.
 * @param policy - Effective before-turn policy.
 * @param deps - Shared durable recall dependencies.
 * @param diagnostics - Mutable diagnostics sink used by durable-item shaping.
 * @returns Ranked durable-memory patch items plus candidate and trace metadata.
 */
async function runDurableRecallAttempt(
  currentTurnText: string,
  query: string,
  sessionKey: string | undefined,
  policy: Required<BeforeTurnPolicy>,
  deps: BeforeTurnDeps,
  diagnostics: BeforeTurnPatchDiagnostics,
): Promise<DurableRecallAttemptResult> {
  const directnessQuery = detectEntityDefinitionTurn(currentTurnText);
  const durableRecallLimit = directnessQuery
    ? Math.max(policy.maxDurableEntries, policy.maxHighConfidenceDurableEntries, ENTITY_DIRECTNESS_RECALL_CANDIDATE_LIMIT)
    : Math.max(policy.maxDurableEntries, policy.maxHighConfidenceDurableEntries);

  let durableRecallTrace: RecallExecutionTraceSummary | undefined;
  try {
    const recalled = await recall(
      {
        text: query,
        limit: durableRecallLimit,
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
    const notices = durableRecallTrace?.degraded.notices.length ? [...durableRecallTrace.degraded.notices] : [];
    const directnessSelection = applyDirectnessSelection(
      currentTurnText,
      recalled.map((item) => buildDurablePatchItem(item, deps)),
    );
    return {
      items: selectDurablePatchItems(directnessSelection.items, policy, diagnostics),
      candidateCount: recalled.length,
      durableRecallTrace,
      directness: directnessSelection.diagnostics,
      notices,
    };
  } catch (error) {
    return {
      items: [],
      candidateCount: 0,
      durableRecallTrace,
      notices: [`Before-turn durable recall failed: ${formatErrorMessage(error)}`],
    };
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
 * One durable-query attempt emitted by the query planner.
 */
type DurableRecallQueryAttempt = {
  kind: BeforeTurnQueryVariantKind;
  query: string;
};

/**
 * Query plan used by the before-turn durable-memory selector.
 */
type DurableRecallQueryPlan = {
  policy: BeforeTurnQueryPolicy;
  primary: DurableRecallQueryAttempt;
  fallback?: DurableRecallQueryAttempt;
};

/**
 * Result returned from one durable-memory recall attempt.
 */
type DurableRecallAttemptResult = {
  items: BeforeTurnPatchItem[];
  candidateCount: number;
  durableRecallTrace?: RecallExecutionTraceSummary;
  directness?: BeforeTurnDirectnessDiagnostics;
  notices: string[];
};

/**
 * Narrow directness turn shape extracted from the current user request.
 */
type DirectnessQueryMatch = {
  kind: BeforeTurnDirectnessQueryKind;
  entity: string;
  normalizedEntity: string;
};

/**
 * Candidate-level directness features computed after durable recall returns.
 */
type DirectnessCandidateScore = {
  item: BeforeTurnPatchItem;
  baseRank: number;
  baseScore: number;
  directnessDelta: number;
  adjustedScore: number;
  signals: BeforeTurnDirectnessSignal[];
};

/**
 * Builds the durable-memory query plan for one before-turn selection pass.
 *
 * The default path stays current-turn-only. Compact context is added only when
 * the turn looks context-dependent or continuation-oriented.
 *
 * @param currentTurnText - Current user-turn text after normalization.
 * @param recentTurns - Ordered recent turns preserved for extra context.
 * @param maxChars - Maximum character budget for the derived query.
 * @returns Durable query plan, or `undefined` when no usable query exists.
 */
function buildDurableRecallQueryPlan(currentTurnText: string, recentTurns: BeforeTurnRecentTurn[], maxChars: number): DurableRecallQueryPlan | undefined {
  const currentOnlyQuery = buildCurrentTurnOnlyQuery(currentTurnText, maxChars);
  if (!currentOnlyQuery) {
    return undefined;
  }

  const contextualQuery = buildContextualAnchorQuery(currentOnlyQuery, recentTurns, maxChars);
  if (!contextualQuery) {
    return {
      policy: "current_only",
      primary: {
        kind: "current_only",
        query: currentOnlyQuery,
      },
    };
  }

  if (requiresContextualQuery(currentTurnText)) {
    return {
      policy: "contextual_required",
      primary: {
        kind: "contextual_anchor",
        query: contextualQuery,
      },
    };
  }

  if (shouldAllowContextualFallback(currentTurnText, recentTurns)) {
    return {
      policy: "current_only",
      primary: {
        kind: "current_only",
        query: currentOnlyQuery,
      },
      fallback: {
        kind: "contextual_anchor",
        query: contextualQuery,
      },
    };
  }

  return {
    policy: "current_only",
    primary: {
      kind: "current_only",
      query: currentOnlyQuery,
    },
  };
}

/**
 * Builds the default current-turn-only durable recall query.
 *
 * @param currentTurnText - Current user-turn text after normalization.
 * @param maxChars - Maximum character budget for the derived query.
 * @returns Current-turn-only query, or `undefined` when empty.
 */
function buildCurrentTurnOnlyQuery(currentTurnText: string, maxChars: number): string | undefined {
  if (maxChars <= 0) {
    return undefined;
  }

  const query = truncate(normalizeWhitespace(currentTurnText), maxChars);
  return query.length > 0 ? query : undefined;
}

/**
 * Builds the compact contextual fallback query using one recent-turn anchor.
 *
 * @param currentTurnQuery - Current-turn-only query text.
 * @param recentTurns - Ordered recent turns preserved for extra context.
 * @param maxChars - Maximum character budget for the full query.
 * @returns Contextual query, or `undefined` when no compact anchor exists.
 */
function buildContextualAnchorQuery(currentTurnQuery: string, recentTurns: BeforeTurnRecentTurn[], maxChars: number): string | undefined {
  const anchor = buildCompactContextAnchor(recentTurns);
  if (!anchor || maxChars <= currentTurnQuery.length) {
    return undefined;
  }

  const prefix = "Topic: ";
  const separator = "\n";
  const remaining = maxChars - currentTurnQuery.length - separator.length - prefix.length;
  if (remaining <= 0) {
    return undefined;
  }

  return `${currentTurnQuery}${separator}${prefix}${truncate(anchor, remaining)}`;
}

/**
 * Builds one compact contextual anchor from the most recent relevant turn.
 *
 * @param recentTurns - Ordered recent turns preserved for extra context.
 * @returns Compact contextual anchor text, or `undefined` when unavailable.
 */
function buildCompactContextAnchor(recentTurns: BeforeTurnRecentTurn[]): string | undefined {
  const recentTurn = recentTurns[recentTurns.length - 1];
  if (!recentTurn) {
    return undefined;
  }

  const normalized = normalizeWhitespace(recentTurn.text);
  return normalized.length > 0 ? truncate(normalized, MAX_CONTEXT_ANCHOR_CHARS) : undefined;
}

/**
 * Returns whether the current turn is too context-dependent for a bare query.
 *
 * @param currentTurnText - Current user-turn text after normalization.
 * @returns `true` when recent context should be required immediately.
 */
function requiresContextualQuery(currentTurnText: string): boolean {
  const normalizedTurn = normalizeWhitespace(currentTurnText);
  const lowerTurn = normalizedTurn.toLowerCase();
  const wordCount = normalizedTurn.split(/\s+/u).filter((token) => token.length > 0).length;
  const hasContextReference = CONTEXT_REFERENCE_RE.test(lowerTurn);

  if (HARD_CONTEXT_PREFIX_RE.test(lowerTurn) && (hasContextReference || lowerTurn.includes("other one"))) {
    return true;
  }

  if (CONTEXT_QUESTION_PREFIX_RE.test(lowerTurn) && hasContextReference && wordCount <= 8) {
    return true;
  }

  return hasContextReference && wordCount <= 6;
}

/**
 * Returns whether the selector should retry with compact context after a weak
 * current-turn-only attempt.
 *
 * @param currentTurnText - Current user-turn text after normalization.
 * @param recentTurns - Ordered recent turns preserved for extra context.
 * @returns `true` when a contextual fallback attempt is worth trying.
 */
function shouldAllowContextualFallback(currentTurnText: string, recentTurns: BeforeTurnRecentTurn[]): boolean {
  if (recentTurns.length === 0 || requiresContextualQuery(currentTurnText)) {
    return false;
  }

  return SOFT_CONTEXT_FALLBACK_RE.test(normalizeWhitespace(currentTurnText).toLowerCase());
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
 * Applies a narrow directness rerank for entity and definitional asks.
 *
 * @param currentTurnText - Current user-turn text after normalization.
 * @param items - Ranked durable-memory candidates from the shared recall path.
 * @returns Reordered candidates or an empty set when the winner stays unstable.
 */
function applyDirectnessSelection(
  currentTurnText: string,
  items: BeforeTurnPatchItem[],
): {
  items: BeforeTurnPatchItem[];
  diagnostics?: BeforeTurnDirectnessDiagnostics;
} {
  if (items.length === 0) {
    return { items };
  }

  const queryMatch = detectEntityDefinitionTurn(currentTurnText);
  if (!queryMatch) {
    return { items };
  }

  const scoredCandidates = items.map((item, index) => scoreDirectnessCandidate(queryMatch, item, index + 1));
  const rerankedCandidates = [...scoredCandidates].sort(compareDirectnessCandidates);
  const winner = rerankedCandidates[0];
  const runnerUp = rerankedCandidates[1];
  const winnerGap = runnerUp ? winner.adjustedScore - runnerUp.adjustedScore : undefined;
  const winnerHasPositiveIdentitySignal = hasPositiveIdentitySignal(winner);
  const runnerUpHasPositiveIdentitySignal = runnerUp ? hasPositiveIdentitySignal(runnerUp) : false;
  const winnerHasOnlyAdjacentSignals =
    winner.signals.includes("adjacent_relationship") &&
    !winner.signals.includes("definitional_content") &&
    !winner.signals.includes("subject_entity_match") &&
    !winner.signals.includes("subject_identity_wrapper");
  const requiresStrictStableGap = runnerUpHasPositiveIdentitySignal;
  const winnerGapTooSmall = requiresStrictStableGap && runnerUp !== undefined && winnerGap !== undefined && winnerGap < DIRECTNESS_STABLE_GAP;

  if (!winnerHasPositiveIdentitySignal || winnerHasOnlyAdjacentSignals || winnerGapTooSmall) {
    const reason =
      !winnerHasPositiveIdentitySignal || winnerHasOnlyAdjacentSignals
        ? `Before-turn directness check abstained for "${queryMatch.entity}" because the top candidate looked adjacent rather than definitional.`
        : `Before-turn directness check abstained for "${queryMatch.entity}" because the top candidates remained too close after reranking.`;
    return {
      items: [],
      diagnostics: buildDirectnessDiagnostics(queryMatch, "abstained", reason, rerankedCandidates, winnerGap),
    };
  }

  const decision = winner.baseRank === 1 ? "kept" : "reranked";
  const reason =
    decision === "kept"
      ? `Before-turn directness check kept ${winner.item.entry.id} because it stayed the clearest definitional match for "${queryMatch.entity}".`
      : `Before-turn directness check reranked ${winner.item.entry.id} ahead of an adjacent match for "${queryMatch.entity}".`;
  return {
    items: [winner.item],
    diagnostics: buildDirectnessDiagnostics(queryMatch, decision, reason, rerankedCandidates, winnerGap),
  };
}

/**
 * Detects narrow entity-definition ask patterns that deserve a local rerank.
 *
 * @param currentTurnText - Current user-turn text after normalization.
 * @returns Extracted directness query shape, or `undefined` when not applicable.
 */
function detectEntityDefinitionTurn(currentTurnText: string): DirectnessQueryMatch | undefined {
  const normalizedTurn = normalizeWhitespace(currentTurnText);
  const patterns = [/^(?:who|what)\s+is\s+(.+?)(?:\s+again)?[?!.,]*$/iu, /^who'?s\s+(.+?)(?:\s+again)?[?!.,]*$/iu, /^tell\s+me\s+about\s+(.+?)[?!.,]*$/iu];

  for (const pattern of patterns) {
    const match = pattern.exec(normalizedTurn);
    const candidateEntity = normalizeDirectnessEntity(match?.[1]);
    if (candidateEntity) {
      return {
        kind: "entity_definition",
        entity: candidateEntity,
        normalizedEntity: normalizeDirectnessText(candidateEntity),
      };
    }
  }

  return undefined;
}

/**
 * Normalizes a candidate entity phrase and rejects obviously contextual or
 * relational variants so the rerank stays narrow.
 *
 * @param entityText - Raw entity phrase captured from the current turn.
 * @returns Normalized entity text, or `undefined` when the ask is too broad.
 */
function normalizeDirectnessEntity(entityText: string | undefined): string | undefined {
  const cleaned = entityText
    ? normalizeWhitespace(entityText)
        .replace(/^[("'`]+/u, "")
        .replace(/[)"'`?!.,]+$/u, "")
        .replace(/^(?:the|a|an)\s+/iu, "")
        .trim()
    : "";
  if (cleaned.length === 0) {
    return undefined;
  }

  const wordCount = cleaned.split(/\s+/u).filter((token) => token.length > 0).length;
  const normalized = normalizeDirectnessText(cleaned);
  if (
    wordCount === 0 ||
    wordCount > ENTITY_DIRECTNESS_MAX_WORDS ||
    CONTEXT_REFERENCE_RE.test(normalized) ||
    normalized.includes("'s") ||
    containsKeyword(normalized, DIRECTNESS_RELATIONSHIP_KEYWORDS)
  ) {
    return undefined;
  }

  return cleaned;
}

/**
 * Scores one durable candidate using narrow directness features.
 *
 * @param queryMatch - Directness query shape extracted from the current turn.
 * @param item - Durable candidate returned from shared recall.
 * @param baseRank - One-based original candidate rank.
 * @returns Candidate with directness deltas and stable signals.
 */
function scoreDirectnessCandidate(queryMatch: DirectnessQueryMatch, item: BeforeTurnPatchItem, baseRank: number): DirectnessCandidateScore {
  const subject = normalizeDirectnessText(item.entry.subject);
  const content = normalizeDirectnessText(item.entry.content);
  const signals: BeforeTurnDirectnessSignal[] = [];
  let directnessDelta = 0;

  if (subject === queryMatch.normalizedEntity) {
    signals.push("subject_entity_match");
    directnessDelta += DIRECTNESS_SUBJECT_ENTITY_MATCH_BONUS;
  } else if (isIdentityWrapperSubject(subject, queryMatch.normalizedEntity)) {
    signals.push("subject_identity_wrapper");
    directnessDelta += DIRECTNESS_SUBJECT_IDENTITY_WRAPPER_BONUS;
  }

  if (hasDefinitionalContent(content, queryMatch.normalizedEntity)) {
    signals.push("definitional_content");
    directnessDelta += DIRECTNESS_DEFINITIONAL_CONTENT_BONUS;
  }

  if (hasEntityClaimKey(item.entry.claim_key, queryMatch.normalizedEntity)) {
    signals.push("claim_key_entity_match");
    directnessDelta += DIRECTNESS_CLAIM_KEY_ENTITY_MATCH_BONUS;
  }

  if (looksLikeAdjacentRelationship(subject, content, queryMatch.normalizedEntity)) {
    signals.push("adjacent_relationship");
    directnessDelta -= DIRECTNESS_ADJACENT_RELATIONSHIP_PENALTY;
  }

  if (looksLikeListLore(subject, content)) {
    signals.push("list_lore");
    directnessDelta -= DIRECTNESS_LIST_LORE_PENALTY;
  }

  return {
    item,
    baseRank,
    baseScore: item.score,
    directnessDelta,
    adjustedScore: item.score + directnessDelta,
    signals,
  };
}

/**
 * Converts the internal directness ranking pass into stable diagnostics.
 *
 * @param queryMatch - Directness query shape extracted from the turn.
 * @param decision - Final directness decision.
 * @param reason - Human-readable decision summary.
 * @param candidates - Ranked candidate diagnostics after local reranking.
 * @param winnerGap - Optional gap between the winner and runner-up.
 * @returns Stable before-turn directness diagnostics.
 */
function buildDirectnessDiagnostics(
  queryMatch: DirectnessQueryMatch,
  decision: BeforeTurnDirectnessDiagnostics["decision"],
  reason: string,
  candidates: DirectnessCandidateScore[],
  winnerGap: number | undefined,
): BeforeTurnDirectnessDiagnostics {
  const winner = decision === "abstained" ? undefined : candidates[0];
  const runnerUp = candidates[1];
  return {
    queryKind: queryMatch.kind,
    entity: queryMatch.entity,
    decision,
    winnerEntryId: winner?.item.entry.id,
    runnerUpEntryId: runnerUp?.item.entry.id,
    ...(winnerGap !== undefined ? { winnerGap: roundToThreeDecimals(winnerGap) } : {}),
    reason,
    candidates: candidates.map((candidate) => ({
      entryId: candidate.item.entry.id,
      baseRank: candidate.baseRank,
      baseScore: roundToThreeDecimals(candidate.baseScore),
      directnessDelta: roundToThreeDecimals(candidate.directnessDelta),
      adjustedScore: roundToThreeDecimals(candidate.adjustedScore),
      signals: candidate.signals,
    })),
  };
}

/**
 * Returns whether the winning candidate has a positive definitional signal.
 *
 * @param candidate - Top reranked candidate.
 * @returns `true` when the candidate looks direct enough to inject.
 */
function hasPositiveIdentitySignal(candidate: DirectnessCandidateScore): boolean {
  return (
    candidate.signals.includes("definitional_content") ||
    candidate.signals.includes("subject_entity_match") ||
    candidate.signals.includes("subject_identity_wrapper")
  );
}

/**
 * Returns whether the candidate subject is just the entity plus a small
 * identity-style wrapper.
 *
 * @param subject - Normalized candidate subject.
 * @param entity - Normalized entity extracted from the turn.
 * @returns `true` when the subject is a minimal identity wrapper.
 */
function isIdentityWrapperSubject(subject: string, entity: string): boolean {
  for (const wrapper of DIRECTNESS_IDENTITY_WRAPPERS) {
    if (subject === `${entity} ${wrapper}` || subject === `${wrapper} ${entity}`) {
      return true;
    }
  }

  return false;
}

/**
 * Returns whether the candidate content opens with a definitional statement.
 *
 * @param content - Normalized candidate content.
 * @param entity - Normalized entity extracted from the turn.
 * @returns `true` when the candidate content is definition-like.
 */
function hasDefinitionalContent(content: string, entity: string): boolean {
  const escapedEntity = escapeRegExp(entity);
  if (startsWithBareRelationshipPredicate(content, escapedEntity)) {
    return false;
  }

  const anchoredPatterns = [new RegExp(`^${escapedEntity}\\s+(?:is|was|means)\\b`, "u"), new RegExp(`^${escapedEntity}\\s+refers\\s+to\\b`, "u")];
  if (anchoredPatterns.some((pattern) => pattern.test(content))) {
    return true;
  }

  return hasEmbeddedDefinitionalContent(content, escapedEntity);
}

/**
 * Returns whether the candidate content contains a sentence- or clause-level
 * identity statement for the queried entity, even when the entry subject is
 * broader relationship lore.
 *
 * @param content - Normalized candidate content.
 * @param escapedEntity - Regex-safe entity extracted from the turn.
 * @returns `true` when the content contains an embedded identity-like clause.
 */
function hasEmbeddedDefinitionalContent(content: string, escapedEntity: string): boolean {
  const embeddedLead = `(?:^|[.!?;:]\\s+)${escapedEntity}\\s+(?:is|was)\\s+`;
  const fullNameLead = `(?:^|[.!?;:]\\s+)${escapedEntity}(?:\\s+[\\p{L}\\p{N}]+){1,2}\\s+(?:is|was)\\s+`;
  if (startsWithBareRelationshipPredicate(content, escapedEntity)) {
    return false;
  }

  const patterns = [
    new RegExp(`${embeddedLead}(?:a|an|the)\\b`, "u"),
    new RegExp(`${embeddedLead}[\\p{L}\\p{N}]+(?:['’]s)\\b`, "u"),
    // Allow short-name queries like "who is John?" to match a leading
    // full-name clause such as "John Doe is married to Beverly".
    new RegExp(`${fullNameLead}(?:a|an|the)\\b`, "u"),
    new RegExp(`${fullNameLead}[\\p{L}\\p{N}]+\\b`, "u"),
  ];
  return patterns.some((pattern) => pattern.test(content));
}

/**
 * Returns whether the content starts with a bare relationship predicate such
 * as "Duke is cousins with ..." that should not count as a direct identity
 * definition for before-turn reranking.
 *
 * @param content - Normalized candidate content.
 * @param escapedEntity - Regex-safe entity extracted from the turn.
 * @returns `true` when the leading predicate is just a relationship term.
 */
function startsWithBareRelationshipPredicate(content: string, escapedEntity: string): boolean {
  const relationshipAlternation = Array.from(DIRECTNESS_RELATIONSHIP_KEYWORDS).join("|");
  const embeddedLead = `(?:^|[.!?;:]\\s+)${escapedEntity}\\s+(?:is|was)\\s+`;
  return new RegExp(`${embeddedLead}(?:${relationshipAlternation})\\b`, "u").test(content);
}

/**
 * Returns whether the candidate looks like adjacent relationship memory.
 *
 * @param subject - Normalized candidate subject.
 * @param content - Normalized candidate content.
 * @param entity - Normalized entity extracted from the turn.
 * @returns `true` when the candidate looks relationship-adjacent.
 */
function looksLikeAdjacentRelationship(subject: string, content: string, entity: string): boolean {
  if (!subject.includes(entity) && !content.includes(entity)) {
    return false;
  }

  return containsKeyword(subject, DIRECTNESS_RELATIONSHIP_KEYWORDS) || containsKeyword(content, DIRECTNESS_RELATIONSHIP_KEYWORDS);
}

/**
 * Returns whether the candidate looks like list or lore aggregation.
 *
 * @param subject - Normalized candidate subject.
 * @param content - Normalized candidate content.
 * @returns `true` when the candidate looks like indirect lore.
 */
function looksLikeListLore(subject: string, content: string): boolean {
  return containsKeyword(subject, DIRECTNESS_LIST_LORE_KEYWORDS) || containsKeyword(content, DIRECTNESS_LIST_LORE_KEYWORDS);
}

/**
 * Stable sort order for directness-scored candidates.
 *
 * @param left - Left candidate.
 * @param right - Right candidate.
 * @returns Negative when left should rank first.
 */
function compareDirectnessCandidates(left: DirectnessCandidateScore, right: DirectnessCandidateScore): number {
  if (right.adjustedScore !== left.adjustedScore) {
    return right.adjustedScore - left.adjustedScore;
  }

  if (right.baseScore !== left.baseScore) {
    return right.baseScore - left.baseScore;
  }

  return left.baseRank - right.baseRank;
}

/**
 * Normalizes text for the local directness heuristics.
 *
 * @param value - Raw text.
 * @returns Lowercased whitespace-normalized text.
 */
function normalizeDirectnessText(value: string): string {
  return normalizeWhitespace(value).toLocaleLowerCase();
}

/**
 * Returns whether the candidate claim key is anchored on the queried entity.
 *
 * @param claimKey - Optional durable claim key carried by the candidate entry.
 * @param entity - Normalized entity extracted from the current turn.
 * @returns `true` when the claim key head matches the entity.
 */
function hasEntityClaimKey(claimKey: string | undefined, entity: string): boolean {
  const head = claimKey?.split("/", 1)[0]?.replace(/[-_]+/g, " ");
  return normalizeDirectnessText(head ?? "") === entity;
}

/**
 * Returns whether the normalized text contains any keyword as a whole token.
 *
 * @param text - Normalized text to inspect.
 * @param keywords - Stable keyword set to look for.
 * @returns `true` when at least one keyword is present.
 */
function containsKeyword(text: string, keywords: Set<string>): boolean {
  const tokens = new Set(text.match(/[\p{L}\p{N}]+/gu) ?? []);
  for (const keyword of keywords) {
    if (tokens.has(keyword)) {
      return true;
    }
  }

  return false;
}

/**
 * Escapes regular-expression metacharacters in a literal text fragment.
 *
 * @param value - Raw text.
 * @returns Regex-safe literal text.
 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Rounds a floating-point value to three decimal places for diagnostics.
 *
 * @param value - Raw numeric value.
 * @returns Rounded numeric value.
 */
function roundToThreeDecimals(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * Internal summary of whether the current turn looks worth proactive recall.
 */
type TurnSignalInspection = {
  signalLabels: BeforeTurnSignalLabel[];
  suppressedTurnCategory?: BeforeTurnSuppressedTurnCategory;
  reason: string;
};

/**
 * Applies the normal one-item cap and only expands the durable set when every
 * extra item clears the very-high-confidence threshold.
 *
 * @param items - Ranked durable items returned from recall.
 * @param policy - Effective before-turn policy.
 * @param diagnostics - Mutable diagnostics sink updated in place.
 * @returns Final bounded durable set for prompt rendering.
 */
function selectDurablePatchItems(
  items: BeforeTurnPatchItem[],
  policy: Required<BeforeTurnPolicy>,
  diagnostics: BeforeTurnPatchDiagnostics,
): BeforeTurnPatchItem[] {
  if (policy.maxDurableEntries <= 0 || items.length === 0) {
    return [];
  }

  const boundedItems = items.slice(0, policy.maxDurableEntries);
  const expandedLimit = Math.max(policy.maxDurableEntries, policy.maxHighConfidenceDurableEntries);
  if (expandedLimit <= policy.maxDurableEntries || items.length <= policy.maxDurableEntries) {
    return boundedItems;
  }

  const expansionCandidates = items.slice(0, expandedLimit);
  const canExpand =
    expansionCandidates.length > policy.maxDurableEntries && expansionCandidates.every((item) => item.score >= policy.highConfidenceRecallThreshold);
  if (canExpand) {
    diagnostics.notices.push(`Before-turn durable recall expanded to ${expansionCandidates.length} high-confidence items.`);
    return expansionCandidates;
  }

  diagnostics.notices.push(
    `Before-turn durable recall kept the top ${boundedItems.length} item${
      boundedItems.length === 1 ? "" : "s"
    } because additional candidates were not high confidence.`,
  );
  return boundedItems;
}

/**
 * Inspects the current turn for strong proactive-recall signal and obvious
 * low-value chatter/testing patterns.
 *
 * @param currentTurnText - Normalized current user turn.
 * @returns Signal labels plus an early-skip reason when recall should abstain.
 */
function inspectTurnSignal(currentTurnText: string): TurnSignalInspection {
  const normalizedTurn = normalizeWhitespace(currentTurnText);
  const lowerTurn = normalizedTurn.toLowerCase();
  const signalLabels = collectTurnSignalLabels(lowerTurn);
  const wordCount = normalizedTurn.split(/\s+/u).filter((token) => token.length > 0).length;
  const isShortTurn = wordCount <= SHORT_TURN_MAX_WORDS || normalizedTurn.length <= SHORT_TURN_MAX_CHARS;

  if (signalLabels.length === 0 && (SOCIAL_TURN_RE.test(lowerTurn) || isShortTurn)) {
    return {
      signalLabels,
      suppressedTurnCategory: "short_social",
      reason: "Current turn was short or social without clear factual, procedural, or task intent.",
    };
  }

  if (signalLabels.length === 0) {
    return {
      signalLabels,
      suppressedTurnCategory: "low_signal",
      reason: "Current turn lacked clear factual, procedural, or task signal, so before-turn recall abstained.",
    };
  }

  return {
    signalLabels,
    reason: `Current turn showed ${signalLabels.join(", ")} recall signal.`,
  };
}

/**
 * Collects stable signal labels from the normalized current turn text.
 *
 * @param lowerTurn - Lowercased current turn text.
 * @returns Stable signal labels used for diagnostics and gating.
 */
function collectTurnSignalLabels(lowerTurn: string): BeforeTurnSignalLabel[] {
  const labels: BeforeTurnSignalLabel[] = [];
  if (TASK_SIGNAL_RE.test(lowerTurn)) {
    labels.push("task");
  }
  if (FACTUAL_SIGNAL_RE.test(lowerTurn)) {
    labels.push("factual");
  }
  if (PROCEDURAL_SIGNAL_RE.test(lowerTurn)) {
    labels.push("procedural");
  }
  return labels;
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
  const maxDurableEntries = normalizeCount(policy?.maxDurableEntries, DEFAULT_MAX_DURABLE_ENTRIES);
  const maxHighConfidenceDurableEntries = Math.max(
    maxDurableEntries,
    normalizeCount(policy?.maxHighConfidenceDurableEntries, DEFAULT_MAX_HIGH_CONFIDENCE_DURABLE_ENTRIES),
  );
  return {
    enableDurableRecall: policy?.enableDurableRecall !== false,
    enableProcedureSuggestion: policy?.enableProcedureSuggestion !== false,
    maxRecentTurns: normalizeCount(policy?.maxRecentTurns, DEFAULT_MAX_RECENT_TURNS),
    maxQueryChars: normalizeCount(policy?.maxQueryChars, DEFAULT_MAX_QUERY_CHARS),
    maxDurableEntries,
    maxHighConfidenceDurableEntries,
    maxProcedureCandidates: normalizeCount(policy?.maxProcedureCandidates, DEFAULT_MAX_PROCEDURE_CANDIDATES),
    recallThreshold: normalizeThreshold(policy?.recallThreshold, DEFAULT_RECALL_THRESHOLD),
    highConfidenceRecallThreshold: normalizeThreshold(policy?.highConfidenceRecallThreshold, DEFAULT_HIGH_CONFIDENCE_RECALL_THRESHOLD),
    procedureThreshold: normalizeThreshold(policy?.procedureThreshold, DEFAULT_PROCEDURE_THRESHOLD),
    skipTrivialTurns: policy?.skipTrivialTurns ?? DEFAULT_SKIP_TRIVIAL_TURNS,
    requireTurnSignal: policy?.requireTurnSignal ?? DEFAULT_REQUIRE_TURN_SIGNAL,
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
