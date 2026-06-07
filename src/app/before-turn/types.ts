import type { AbstainSuppression } from "../directives/abstain-filter.js";
import type { RecallExecutionTraceSummary } from "../../core/recall/index.js";
import type { ClaimCentricClaimStatus, ClaimCentricMemoryState } from "../recall/claim-centric.js";
import type { Durable, Procedure } from "../../core/types.js";

/**
 * High-level category explaining why a turn was suppressed before recall ran.
 */
export type BeforeTurnSuppressedTurnCategory = "short_social" | "low_signal";

/**
 * High-level label describing why a turn looked recall-worthy.
 */
export type BeforeTurnSignalLabel = "task" | "factual" | "procedural";

/**
 * Stable query policy used for proactive durable-memory recall.
 */
export type BeforeTurnQueryPolicy = "current_only" | "contextual_fallback" | "contextual_required";

/**
 * Stable query variant kind preserved for before-turn diagnostics.
 */
export type BeforeTurnQueryVariantKind = "current_only" | "contextual_anchor";

/**
 * Narrow directness query category handled locally in before-turn selection.
 */
export type BeforeTurnDirectnessQueryKind = "entity_definition";

/**
 * Stable decision emitted by the before-turn directness pass.
 */
export type BeforeTurnDirectnessDecision = "kept" | "reranked" | "abstained";

/**
 * Stable directness signal attached to one candidate during rerank.
 */
export type BeforeTurnDirectnessSignal =
  | "subject_entity_match"
  | "subject_identity_wrapper"
  | "definitional_content"
  | "claim_key_entity_match"
  | "adjacent_relationship"
  | "list_lore";

/**
 * Inspectable directness features for one top candidate.
 */
export interface BeforeTurnDirectnessCandidateDiagnostic {
  /** Durable identifier for the inspected candidate. */
  durableId: string;
  /** Original recall rank before local directness reranking. */
  baseRank: number;
  /** Base durable recall score before local adjustments. */
  baseScore: number;
  /** Local directness delta added to the base score. */
  directnessDelta: number;
  /** Adjusted score after the local directness pass. */
  adjustedScore: number;
  /** Stable directness signals observed for this candidate. */
  signals: BeforeTurnDirectnessSignal[];
}

/**
 * Compact diagnostics describing one before-turn directness pass.
 */
export interface BeforeTurnDirectnessDiagnostics {
  /** Directness query category that triggered the local rerank. */
  queryKind: BeforeTurnDirectnessQueryKind;
  /** Normalized entity string extracted from the current turn. */
  entity: string;
  /** Final local decision after reranking or abstention. */
  decision: BeforeTurnDirectnessDecision;
  /** Winning durable id after reranking when one remained stable enough. */
  winnerDurableId?: string;
  /** Runner-up durable id used for stability comparison when available. */
  runnerUpDurableId?: string;
  /** Adjusted winner gap against the runner-up when available. */
  winnerGap?: number;
  /** Short explanation describing why the pass kept, reranked, or abstained. */
  reason: string;
  /** Inspectable top candidate features used by the local decision. */
  candidates: BeforeTurnDirectnessCandidateDiagnostic[];
}

/**
 * One attempted durable-memory query variant.
 */
export interface BeforeTurnQueryVariant {
  /** Stable variant kind used for this attempt. */
  kind: BeforeTurnQueryVariantKind;
  /** Actual query text issued to durable recall. */
  query: string;
  /** Count of durable candidates returned before final shaping. */
  candidateCount: number;
  /** Whether this variant supplied the final durable selection. */
  selected: boolean;
}

/**
 * Normalized recent conversational turn supplied by the host adapter.
 */
export interface BeforeTurnRecentTurn {
  /** Role for one recent turn. */
  role: "user" | "assistant";
  /** Plain-text turn body after adapter-side normalization. */
  text: string;
}

/**
 * Policy hints that shape one before-turn selection pass.
 */
export interface BeforeTurnPolicy {
  /** Enables or disables durable-memory recall for this pass. */
  enableDurableRecall?: boolean;
  /** Enables or disables proactive procedure suggestion for this pass. */
  enableProcedureSuggestion?: boolean;
  /** Maximum recent turns to consider while building the turn query. */
  maxRecentTurns?: number;
  /** Maximum total characters preserved in the derived turn query. */
  maxQueryChars?: number;
  /** Maximum durable-memory rows to return. */
  maxDurables?: number;
  /** Maximum durable-memory rows allowed when all surfaced items are very high confidence. */
  maxHighConfidenceDurables?: number;
  /** Maximum procedure candidates to consider before canonical selection. */
  maxProcedureCandidates?: number;
  /** Optional score threshold used for durable-memory recall. */
  recallThreshold?: number;
  /** Optional score threshold required before expanding beyond the normal durable-item cap. */
  highConfidenceRecallThreshold?: number;
  /** Optional score threshold used for canonical procedure selection. */
  procedureThreshold?: number;
  /** Enables or disables early skips for short or social turns. */
  skipTrivialTurns?: boolean;
  /** Enables or disables the stronger factual/procedural/task signal gate. */
  requireTurnSignal?: boolean;
}

/**
 * Host-neutral input accepted by the before-turn service.
 */
export interface BeforeTurnInput {
  /** Optional session key used for telemetry attribution. */
  sessionKey?: string;
  /** Current user-turn text that should anchor the selection pass. */
  currentTurnText: string;
  /** Optional bounded recent conversational turns. */
  recentTurns?: BeforeTurnRecentTurn[];
  /** Optional host trigger hint preserved for future routing. */
  trigger?: string;
  /** Optional policy hints that bound the returned patch. */
  policy?: BeforeTurnPolicy;
}

/**
 * Concise explanation of why one patch component surfaced.
 */
export interface BeforeTurnSurfacingExplanation {
  /** One-line explanation suitable for prompt or UI surfaces. */
  summary: string;
  /** Stable reason fragments preserved for tests and traces. */
  reasons: string[];
}

/**
 * One ranked durable-memory item returned by the before-turn service.
 */
export interface BeforeTurnPatchItem {
  /** Stable final rank in the bounded durable-memory set. */
  rank: number;
  /** Hydrated durable selected for the active turn. */
  durable: Durable;
  /** Source channel for this surfaced item. */
  sourceKind: "turn_recall" | "directive";
  /** Final ranking score from durable-memory recall. */
  score: number;
  /** Concise explanation of why the item surfaced. */
  whySurfaced: BeforeTurnSurfacingExplanation;
  /** High-level memory-state label for inspection surfaces. */
  memoryState: ClaimCentricMemoryState;
  /** Claim-lifecycle label when available. */
  claimStatus: ClaimCentricClaimStatus;
  /** Compact freshness summary useful to adapters and traces. */
  freshnessLabel: string;
  /** Compact provenance summary when supporting metadata is available. */
  provenanceSummary?: string;
}

/**
 * One proactive procedure suggestion returned by the before-turn service.
 */
export interface BeforeTurnProcedureSuggestion {
  /** Canonical stored procedure selected for the active turn. */
  procedure: Procedure;
  /** Final leader score from dedicated procedure recall. */
  score: number;
  /** Score components preserved for inspection and tests. */
  scores: {
    /** Blended relevance signal across lexical and vector evidence. */
    relevance: number;
    /** Lexical overlap score between the query and the procedure. */
    lexical: number;
    /** Vector similarity score when semantic retrieval was available. */
    vector: number;
  };
  /** Concise explanation of why the procedure surfaced. */
  whySurfaced: BeforeTurnSurfacingExplanation;
}

/**
 * One durable suppressed from before-turn injection by a memory directive.
 */
export type BeforeTurnDirectiveAbstention = AbstainSuppression;

/**
 * Compact diagnostics emitted alongside one before-turn patch.
 */
export interface BeforeTurnPatchDiagnostics {
  /** Effective bounded query text derived from the turn context. */
  query?: string;
  /** Stable query policy used for the durable before-turn pass. */
  queryPolicy?: BeforeTurnQueryPolicy;
  /** Actual durable-query variants attempted during selection. */
  queryVariants: BeforeTurnQueryVariant[];
  /** Number of recent turns actually used while building the query. */
  recentTurnCount: number;
  /** High-level labels describing the turn signal observed before recall. */
  turnSignalLabels: BeforeTurnSignalLabel[];
  /** Optional category explaining why the current turn was suppressed early. */
  suppressedTurnCategory?: BeforeTurnSuppressedTurnCategory;
  /** Whether durable-memory recall was attempted. */
  durableRecallUsed: boolean;
  /** Count of durable-memory candidates considered before final shaping. */
  durableRecallCandidateCount: number;
  /** Count of active topic-triggered proactive directives considered. */
  topicProactiveDirectiveCandidateCount?: number;
  /** Count of topic-triggered proactive directives matched to the current turn. */
  topicProactiveDirectiveMatchedCount?: number;
  /** Typed trace emitted by the shared durable recall pipeline. */
  durableRecallTrace?: RecallExecutionTraceSummary;
  /** Optional diagnostics for a local before-turn directness rerank pass. */
  directness?: BeforeTurnDirectnessDiagnostics;
  /** Whether procedure recall was attempted. */
  procedureRecallUsed: boolean;
  /** Count of procedure candidates considered before canonical selection. */
  procedureCandidateCount: number;
  /** Whether the service abstained from surfacing any patch content. */
  abstained: boolean;
  /** Stable reasons explaining why the service abstained. */
  abstentionReasons: string[];
  /** Durables suppressed from injection by active memory directives. */
  directiveAbstentions?: BeforeTurnDirectiveAbstention[];
  /** Stable degraded-mode or failure notices relevant to the selection pass. */
  notices: string[];
}

/**
 * Structured before-turn output returned by the app-layer service.
 */
export interface BeforeTurnPatch {
  /** Ranked bounded durable-memory selection for adapter rendering. */
  durableMemory: BeforeTurnPatchItem[];
  /** Optional high-confidence proactive procedure suggestion. */
  procedure?: BeforeTurnProcedureSuggestion;
  /** Compact diagnostics describing how the patch was built. */
  diagnostics: BeforeTurnPatchDiagnostics;
}
