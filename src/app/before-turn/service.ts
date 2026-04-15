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
const DEFAULT_HIGH_CONFIDENCE_RECALL_THRESHOLD = 0.85;
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
const CONTEXT_REFERENCE_RE =
  /\b(?:it|its|that|this|they|them|their|those|these|he|him|his|she|her|hers|other one|other ones)\b/iu;
const HARD_CONTEXT_PREFIX_RE = /^(?:and\b|also\b|what about\b|how about\b|same\b|same as\b)/iu;
const SOFT_CONTEXT_FALLBACK_RE = /\b(?:next|follow up|follow-up|continue|continuation)\b/iu;
const CONTEXT_QUESTION_PREFIX_RE = /^(?:when|where|why|should|does|is|are|what should)\b/iu;
const MAX_CONTEXT_ANCHOR_CHARS = 120;

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
      ? runDurableRecallSelection(durableQueryPlan, input.sessionKey, policy, deps, diagnostics)
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
  queryPlan: DurableRecallQueryPlan,
  sessionKey: string | undefined,
  policy: Required<BeforeTurnPolicy>,
  deps: BeforeTurnDeps,
  diagnostics: BeforeTurnPatchDiagnostics,
): Promise<BeforeTurnPatchItem[]> {
  diagnostics.durableRecallUsed = true;
  const attemptedVariants: BeforeTurnQueryVariant[] = [];
  const primaryResult = await runDurableRecallAttempt(queryPlan.primary.query, sessionKey, policy, deps, diagnostics);
  attemptedVariants.push({
    kind: queryPlan.primary.kind,
    query: queryPlan.primary.query,
    candidateCount: primaryResult.candidateCount,
    selected: primaryResult.items.length > 0 && queryPlan.fallback === undefined,
  });

  if (primaryResult.items.length > 0 || queryPlan.fallback === undefined) {
    diagnostics.query = queryPlan.primary.query;
    diagnostics.queryPolicy = queryPlan.policy;
    diagnostics.queryVariants = attemptedVariants;
    diagnostics.durableRecallTrace = primaryResult.durableRecallTrace;
    diagnostics.durableRecallCandidateCount = primaryResult.candidateCount;
    if (primaryResult.notices.length > 0) {
      diagnostics.notices.push(...primaryResult.notices);
    }
    return primaryResult.items;
  }

  const fallbackResult = await runDurableRecallAttempt(queryPlan.fallback.query, sessionKey, policy, deps, diagnostics);
  attemptedVariants[0] = {
    ...attemptedVariants[0],
    selected: false,
  };
  attemptedVariants.push({
    kind: queryPlan.fallback.kind,
    query: queryPlan.fallback.query,
    candidateCount: fallbackResult.candidateCount,
    selected: fallbackResult.items.length > 0,
  });
  diagnostics.query = queryPlan.fallback.query;
  diagnostics.queryPolicy = "contextual_fallback";
  diagnostics.queryVariants = attemptedVariants;
  diagnostics.durableRecallTrace = fallbackResult.durableRecallTrace;
  diagnostics.durableRecallCandidateCount = fallbackResult.candidateCount;
  if (primaryResult.notices.length > 0) {
    diagnostics.notices.push(...primaryResult.notices);
  }
  if (fallbackResult.notices.length > 0) {
    diagnostics.notices.push(...fallbackResult.notices);
  }
  return fallbackResult.items;
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
  query: string,
  sessionKey: string | undefined,
  policy: Required<BeforeTurnPolicy>,
  deps: BeforeTurnDeps,
  diagnostics: BeforeTurnPatchDiagnostics,
): Promise<DurableRecallAttemptResult> {
  const durableRecallLimit = Math.max(policy.maxDurableEntries, policy.maxHighConfidenceDurableEntries);

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
    return {
      items: selectDurablePatchItems(
        recalled.map((item) => buildDurablePatchItem(item, deps)),
        policy,
        diagnostics,
      ),
      candidateCount: recalled.length,
      durableRecallTrace,
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
  notices: string[];
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
function buildDurableRecallQueryPlan(
  currentTurnText: string,
  recentTurns: BeforeTurnRecentTurn[],
  maxChars: number,
): DurableRecallQueryPlan | undefined {
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
