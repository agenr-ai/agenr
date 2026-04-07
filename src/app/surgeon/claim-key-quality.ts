/* eslint-disable jsdoc/require-jsdoc */

import { randomUUID } from "node:crypto";

import { DEFAULT_CLAIM_EXTRACTION_CONCURRENCY, resolveClaimExtractionConfig, type AgenrConfig } from "../../config.js";
import {
  detectClaimKeyEntityFamilyCandidates,
  type ClaimKeyEntityFamilyCandidate,
  type ClaimKeyEntityFamilyEvidence,
  type ClaimKeyEntityFamilyPairSupport,
} from "../../core/claim-key-entity-family.js";
import {
  compactClaimKey,
  describeClaimKeyNormalizationFailure,
  describeClaimKeySuspicion,
  inspectClaimKey,
  isTrustedClaimKeyForCleanup,
  normalizeClaimKeySegment,
  type ClaimKeyInspection,
} from "../../core/claim-key.js";
import {
  createEmptySiblingSlotResonanceEvaluation,
  evaluateSiblingSlotResonance,
  type SiblingSlotResonanceEvaluation,
} from "../../core/claim-key-slot-resonance.js";
import type { LlmPort } from "../../core/ports.js";
import type {
  ClaimKeyHealthSnapshot,
  ClaimKeyQualityPassSummary,
  ClaimKeyQualityRepairCounts,
  ClaimKeyQualityShadowBucket,
  ClaimKeyQualityShadowBucketSummary,
  SurgeonCompletionSummary,
  SurgeonRunProposal,
  SurgeonRunStatus,
} from "../../core/surgeon/types.js";
import {
  previewClaimKeyExtraction,
  type ClaimExtractionHints,
  type ClaimExtractionPreviewOutcome,
  type ClaimExtractionResult,
} from "../../core/store/claim-extraction.js";
import type { Entry } from "../../core/types.js";
import { emitSurgeonProgress, type ClaimKeyQualityProgressStage, type SurgeonProgressReporter } from "./progress.js";
import type { SurgeonPort } from "./ports.js";

const HIGH_CONFIDENCE_BACKFILL_THRESHOLD = 0.92;
const STRUCTURED_AUTO_APPLY_BACKFILL_THRESHOLD = 0.86;
const COMPACTED_SUPPORTED_AUTO_APPLY_BACKFILL_THRESHOLD = 0.78;
const PROPOSAL_CONFIDENCE_THRESHOLD = 0.75;
const SUPPORTED_PROPOSAL_CONFIDENCE_THRESHOLD = 0.65;
const MAX_CLEANUP_ENTITY_HINTS = 12;
const MAX_CLEANUP_CLAIM_KEY_HINTS = 8;
const CLAIM_KEY_CONCENTRATION_THRESHOLD = 25;
const CLAIM_KEY_CONCENTRATION_RATIO = 0.8;
const ENTITY_CONCENTRATION_THRESHOLD = 40;
const ENTITY_CONCENTRATION_RATIO = 0.85;
const COLLISION_SPIKE_THRESHOLD = 30;
const COLLISION_SPIKE_RATIO = 0.85;
const CLAIM_KEY_PROGRESS_INTERVAL_MS = 5_000;
const CLAIM_KEY_PROGRESS_VERBOSE_INTERVAL_MS = 2_000;
const CLAIM_KEY_PROGRESS_EVERY_ENTRIES = 250;
const CLAIM_KEY_PROGRESS_EVERY_VERBOSE_ENTRIES = 50;
const MAX_AUTO_APPLY_ATTRIBUTE_TOKENS = 4;
const SHADOW_RESONANCE_MIN_FAMILY_REUSE_COUNT = 20;
const SHADOW_RESONANCE_MIN_GROUNDED_RATIO = 0.7;
const SHADOW_RESONANCE_MIN_CONFIDENCE = 0.74;
const USER_METADATA_ENTITY_ALIASES = new Set(["i", "me", "myself", "person", "the_user", "user"]);
const PROJECT_METADATA_ENTITY_ALIASES = new Set(["app", "application", "project", "the_project", "this_project", "workspace"]);
const GROUNDING_STOP_TOKENS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
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
  "this",
  "to",
  "we",
  "with",
]);
const AWKWARD_AUTO_APPLY_ATTRIBUTE_TOKENS = new Set(["to", "for", "from", "with", "about", "into", "onto", "between", "during"]);
const POLICY_TEMPLATE_ATTRIBUTE_TOKENS = new Set(["policy", "default", "workflow", "process", "strategy", "guardrail", "rule", "boundary"]);
const AUTHORITATIVE_TEMPLATE_ATTRIBUTE_TOKENS = new Set(["source", "truth", "guide", "runbook", "reference"]);
const ARCHITECTURE_TEMPLATE_ATTRIBUTE_TOKENS = new Set([
  "adapter",
  "boundary",
  "architecture",
  "backend",
  "storage",
  "model",
  "support",
  "contract",
  "interface",
  "surface",
]);
const STABLE_FAMILY_SLOT_ATTRIBUTE_HEADS = new Set([
  "access",
  "boundary",
  "condition",
  "contract",
  "dependency",
  "mode",
  "owner",
  "order",
  "path",
  "policy",
  "preference",
  "preservation",
  "process",
  "requirement",
  "role",
  "rule",
  "schedule",
  "sequencing",
  "setting",
  "status",
  "strategy",
  "support",
  "surface",
  "timezone",
  "version",
  "window",
  "workflow",
  "workspace",
]);

type MissingBackfillPromotionClass =
  | "trusted_exact_reuse_grounded"
  | "trusted_family_template_grounded"
  | "trusted_family_stable_slot"
  | "trusted_family_grounded_alignment";
type MissingBackfillPromotionLane = "high_confidence_preview" | "structured_supported" | "compacted_supported" | "deterministic_repair" | "metadata_rewrite";
const SHADOW_BUCKET_ORDER: ClaimKeyQualityShadowBucket[] = [
  "high_density_grounded_family",
  "large_grounding_diluted_grounded_family",
  "thin_grounded_family_tail",
  "relaxed_one_sibling_stable_slot",
  "other_grounded_family_alignment",
];

interface MissingBackfillLexicalAlignment {
  entity: boolean;
  attribute: boolean;
  any: boolean;
  strongEntityAttribute: boolean;
  entityOverlapCount: number;
  attributeOverlapCount: number;
}

/**
 * Claim-key-quality selection and execution options for one surgeon run.
 */
export interface ClaimKeyQualityRunOptions {
  runId: string;
  apply: boolean;
  project?: string;
  type?: string;
  claimKeyPrefix?: string;
  entryIds?: string[];
  includeInactive?: boolean;
  signal?: AbortSignal;
  now(): Date;
  costCapUsd: number;
  verbose: boolean;
  reportProgress?: SurgeonProgressReporter;
}

/**
 * Resolved dependencies required by the claim-key-quality pass.
 */
export interface ClaimKeyQualityRunDeps {
  port: SurgeonPort;
  config: AgenrConfig | null;
  createClaimExtractionLlm?: () => LlmPort & { metadata?: { usage?: { inputTokens?: number; outputTokens?: number; totalCost?: number } } };
}

/**
 * Final deterministic result returned by the claim-key-quality pass.
 */
export interface ClaimKeyQualityRunResult {
  status: SurgeonRunStatus;
  error: string | null;
  completion: SurgeonCompletionSummary;
  entriesRetired: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
    estimatedCostUsd: number;
  };
}

interface EntrySuggestionRecord {
  suggestion: ClaimExtractionResult | null;
  warnings: string[];
  previewOutcome: ClaimExtractionPreviewOutcome | null;
}

type ClaimExtractionPreviewLlm = LlmPort & {
  metadata?: {
    usage?: {
      inputTokens?: number;
      outputTokens?: number;
      totalCost?: number;
    };
  };
};

interface ClaimKeyCircuitBreakerState {
  totalAutoMutations: number;
  blockedCollisions: number;
  appliedByClaimKey: Map<string, number>;
  appliedByEntity: Map<string, number>;
}

interface ClaimKeyCircuitBreakerTrip {
  kind: string;
  message: string;
}

interface TrustedGroupReuseCandidate {
  claimKey: string;
  supportingEntryIds: string[];
}

interface TrustedCleanupHintEntry {
  id: string;
  claimKey: string;
  entity: string;
  attribute: string;
  type: string;
  tags: string[];
  sourceContextTokens: string[];
  subjectTokens: string[];
  createdAt: string;
}

interface TrustedCleanupHintSeed {
  globalEntityHints: string[];
  globalClaimKeyExamples: string[];
  entries: TrustedCleanupHintEntry[];
}

interface MissingBackfillSupportEvaluation {
  autoApplyClass: MissingBackfillPromotionClass | null;
  supportedProposal: boolean;
  trustedExactReuse: boolean;
  trustedEntityFamilyReuse: boolean;
  tagGrounding: boolean;
  sourceContextGrounding: boolean;
  localGrounding: boolean;
  entityLexicalAlignment: boolean;
  attributeLexicalAlignment: boolean;
  strongEntityAttributeLexicalAlignment: boolean;
  lexicalAlignment: boolean;
  templateSupport: boolean;
  stableSlotSupport: boolean;
  familyReuseCount: number;
  groundedFamilyReuseCount: number;
  relaxedStableSlotFamilyGate: boolean;
  supportingEntryIds: string[];
  siblingSlotResonance: SiblingSlotResonanceEvaluation;
  supportEvidence: string[];
  rationaleFragments: string[];
}

interface ClaimKeyCompactnessEvaluation {
  claimKey: string;
  compactedFrom: string | null;
  compactionReason: string | null;
  compactEnoughForAutoApply: boolean;
  blockerReason: string | null;
}

interface MissingBackfillPromotionPolicy {
  lane: MissingBackfillPromotionLane;
  autoApplyThreshold: number;
}

interface MissingBackfillSkipDiagnostic {
  entryId: string;
  outcome: "no_claim" | "malformed_output" | "rejected_candidate" | "low_confidence_candidate";
  confidence: number | null;
  path: ClaimExtractionResult["path"] | ClaimExtractionPreviewOutcome["path"] | null;
  warning: string | null;
  suggestedClaimKey: string | null;
}

interface MissingBackfillDecisionStats {
  autoAppliedTrustedGroupReuse: number;
  autoAppliedDeterministicRepair: number;
  autoAppliedMetadataRepair: number;
  autoAppliedSupportedPreview: number;
  autoAppliedGroundedFamilyPromotion: number;
  autoAppliedRelaxedStableSlotPromotion: number;
  autoAppliedPreviewModel: number;
  autoAppliedCompactedCandidate: number;
  proposedTrustedGroupReuse: number;
  proposedSupportedCandidate: number;
  proposedGroundedFamilyPromotion: number;
  proposedRelaxedStableSlotPromotion: number;
  proposedPreviewCandidate: number;
  proposedCompactedCandidate: number;
  noClaimWithWarnings: number;
}

interface SiblingSlotResonanceShadowBucketStats {
  candidateCount: number;
  resonanceApplicableCount: number;
  resonanceFiredCount: number;
  shadowQualifiedCount: number;
}

interface SiblingSlotResonanceShadowStats {
  thresholdOnlyCandidateCount: number;
  resonanceApplicableCount: number;
  resonanceFiredCount: number;
  shadowQualifiedCount: number;
  resonanceFiredClaimKeys: string[];
  shadowQualifiedClaimKeys: string[];
  buckets: Map<ClaimKeyQualityShadowBucket, SiblingSlotResonanceShadowBucketStats>;
}

interface MissingBackfillShadowAudit {
  thresholdOnlyBucket: ClaimKeyQualityShadowBucket;
  shadowWouldQualify: boolean;
}

interface EntityFamilyConvergenceDecisionStats {
  appliedClusters: number;
  appliedEntries: number;
  proposedClusters: number;
}

interface EntityFamilyConvergenceAudit {
  competingEntityPrefixes: string[];
  canonicalEntityPrefix: string | null;
  canonicalSelectionReasons: string[];
  unresolvedReason: string | null;
  evidence: ClaimKeyEntityFamilyEvidence[];
  pairSupport: Array<{
    entityPrefixes: [string, string];
    supportingEntryIds: string[];
    sharedAttributes: string[];
    confidence: number;
    autoSafe: boolean;
    preferredCanonicalEntityPrefix: string | null;
    evidence: ClaimKeyEntityFamilyEvidence[];
  }>;
}

interface AppliedClaimKeyLifecycleMetadata {
  rawClaimKey?: string;
  status: NonNullable<Entry["claim_key_status"]>;
  source: NonNullable<Entry["claim_key_source"]>;
}

interface ProposalClaimKeyLifecycleMetadata {
  deferredUntilReview: true;
  proposedStatus: Entry["claim_key_status"];
  proposedSource?: Entry["claim_key_source"];
  proposedRawClaimKey?: string;
}

/**
 * Runs the first-class claim-key-quality surgeon pass.
 *
 * @param options - Claim-key-quality run selection and safety options.
 * @param deps - Database and optional claim-extraction dependencies.
 * @returns Final deterministic run summary plus usage totals.
 */
export async function runClaimKeyQualityPass(options: ClaimKeyQualityRunOptions, deps: ClaimKeyQualityRunDeps): Promise<ClaimKeyQualityRunResult> {
  const selection = {
    includeInactive: options.includeInactive === true,
    project: normalizeOptionalString(options.project) ?? null,
    type: normalizeOptionalString(options.type) ?? null,
    claimKeyPrefix: normalizeOptionalString(options.claimKeyPrefix) ?? null,
    entryIds: normalizeStringArray(options.entryIds ?? []),
  };
  const executionStyle: ClaimKeyQualityPassSummary["executionStyle"] =
    selection.includeInactive || selection.type !== null || selection.claimKeyPrefix !== null || selection.entryIds.length > 0 ? "targeted" : "autonomous";

  const sourceEntries = await deps.port.listClaimKeyQualityEntries({
    project: selection.project ?? undefined,
    type: selection.type ?? undefined,
    claimKeyPrefix: selection.claimKeyPrefix ?? undefined,
    entryIds: selection.entryIds,
    includeInactive: selection.includeInactive,
  });
  const actualEntries = sourceEntries.map((entry) => cloneEntry(entry));
  const projectedEntries = sourceEntries.map((entry) => cloneEntry(entry));
  const entriesById = new Map(projectedEntries.map((entry) => [entry.id, entry]));
  const actualEntriesById = new Map(actualEntries.map((entry) => [entry.id, entry]));
  const counts = createEmptyRepairCounts();
  const observations: string[] = [];
  const recommendations: string[] = [];
  const suggestionCache = new Map<string, EntrySuggestionRecord>();
  const trustedHints = buildTrustedCleanupHintSeed(actualEntries);
  const trustedReusableEntryIds = new Set(
    sourceEntries.flatMap((entry) => {
      const claimKey = entry.claim_key?.trim();
      return claimKey && isTrustedClaimKeyForCleanup(claimKey) ? [entry.id] : [];
    }),
  );
  const missingDecisionStats = createEmptyMissingBackfillDecisionStats();
  const siblingSlotResonanceShadowStats = createEmptySiblingSlotResonanceShadowStats();
  const entityFamilyDecisionStats = createEmptyEntityFamilyConvergenceDecisionStats();
  const handledEntityFamilyClaimKeys = new Set<string>();
  const skippedDiagnostics: MissingBackfillSkipDiagnostic[] = [];
  const claimExtractionConfig = resolveClaimExtractionConfig(deps.config ?? undefined);
  const previewConcurrency = resolveClaimExtractionConcurrency(claimExtractionConfig);
  const before = summarizeClaimKeyHealth(actualEntries, claimExtractionConfig.eligibleTypes);
  const circuitBreakerState = createCircuitBreakerState();
  const progressTracker = createClaimKeyQualityProgressTracker({
    apply: options.apply,
    verbose: options.verbose,
    totalEntries: before.totalEntries,
    counts,
    reportProgress: options.reportProgress,
  });
  const claimExtractionLlms: ClaimExtractionPreviewLlm[] = [];
  let fallbackClaimExtractionLlm: ClaimExtractionPreviewLlm | null | undefined;
  let circuitBreaker: ClaimKeyCircuitBreakerTrip | null = null;
  let terminalStatus: SurgeonRunStatus = "completed";
  let terminalError: string | null = null;
  let actionsTaken = 0;

  emitSurgeonProgress(options.reportProgress, {
    kind: "phase",
    phase: "load_working_set_complete",
    passType: "claim_key_quality",
    apply: options.apply,
    workingSetSize: before.totalEntries,
  });
  emitSurgeonProgress(options.reportProgress, {
    kind: "phase",
    phase: "pass_start",
    passType: "claim_key_quality",
    apply: options.apply,
  });
  progressTracker.emitHealthSnapshot(before);

  const invalidOrNoncanonicalEntries = projectedEntries.filter((entry) => {
    const inspection = inspectExistingClaimKey(entry);
    return inspection.kind === "malformed" || inspection.kind === "noncanonical";
  });
  const missingEntries = projectedEntries.filter((entry) => {
    const inspection = inspectExistingClaimKey(entry);
    return inspection.kind === "missing" && claimExtractionConfig.eligibleTypes.includes(entry.type);
  });
  const suspectEntries = projectedEntries.filter((entry) => inspectExistingClaimKey(entry).kind === "suspect");

  try {
    progressTracker.startStage("invalid_noncanonical", invalidOrNoncanonicalEntries.length, "entries");
    for (const entry of invalidOrNoncanonicalEntries) {
      if (options.signal?.aborted === true) {
        terminalStatus = "aborted";
        terminalError = "Run aborted by user (SIGINT).";
        break;
      }

      await processInvalidOrNoncanonicalEntry(entry);
      progressTracker.advanceStage();
      if (terminalStatus !== "completed" || circuitBreaker) {
        break;
      }
    }

    if (!circuitBreaker && terminalStatus === "completed") {
      const missingPreviewEntries = missingEntries.filter((entry) => shouldPreviewMissingEntry(entry));
      progressTracker.startStage("missing", missingEntries.length, "entries", {
        previewTotal: shouldPreloadSuggestions() ? missingPreviewEntries.length : 0,
        previewConcurrency: shouldPreloadSuggestions() ? previewConcurrency : undefined,
      });
      await preloadSuggestionsForStage(missingPreviewEntries);
      for (const entry of missingEntries) {
        if (options.signal?.aborted === true) {
          terminalStatus = "aborted";
          terminalError = "Run aborted by user (SIGINT).";
          break;
        }

        await processMissingEntry(entry);
        progressTracker.advanceStage();
        if (terminalStatus !== "completed" || circuitBreaker) {
          break;
        }
      }
    }

    if (!circuitBreaker && terminalStatus === "completed") {
      const suspectPreviewEntries = suspectEntries.filter((entry) => shouldPreloadSuspectSuggestion(entry));
      progressTracker.startStage("suspect_canonical", suspectEntries.length, "entries", {
        previewTotal: shouldPreloadSuggestions() ? suspectPreviewEntries.length : 0,
        previewConcurrency: shouldPreloadSuggestions() && suspectPreviewEntries.length > 0 ? previewConcurrency : undefined,
      });
      await preloadSuggestionsForStage(suspectPreviewEntries);
      for (const entry of suspectEntries) {
        if (options.signal?.aborted === true) {
          terminalStatus = "aborted";
          terminalError = "Run aborted by user (SIGINT).";
          break;
        }

        await processSuspectEntry(entry);
        progressTracker.advanceStage();
        if (terminalStatus !== "completed" || circuitBreaker) {
          break;
        }
      }
    }

    if (!circuitBreaker && terminalStatus === "completed") {
      const entityFamilyCandidates = detectClaimKeyEntityFamilyCandidates(projectedEntries);
      progressTracker.startStage("entity_family_convergence", entityFamilyCandidates.length, "groups");
      for (const candidate of entityFamilyCandidates) {
        if (options.signal?.aborted === true) {
          terminalStatus = "aborted";
          terminalError = "Run aborted by user (SIGINT).";
          break;
        }

        await processEntityFamilyConvergenceCandidate(candidate);
        for (const claimKey of candidate.claimKeys) {
          handledEntityFamilyClaimKeys.add(claimKey);
        }
        progressTracker.advanceStage();
        if (terminalStatus !== "completed" || circuitBreaker) {
          break;
        }
      }
    }

    if (!circuitBreaker && terminalStatus === "completed") {
      const mixedKeyGroups = findMixedKeyGroups(projectedEntries, handledEntityFamilyClaimKeys);
      progressTracker.startStage("mixed_key_groups", mixedKeyGroups.length, "groups");
      for (const group of mixedKeyGroups) {
        if (options.signal?.aborted === true) {
          terminalStatus = "aborted";
          terminalError = "Run aborted by user (SIGINT).";
          break;
        }

        const proposalLifecycle = buildProposalClaimKeyLifecycle({
          proposedClaimKeys: group.proposedClaimKey ? [group.proposedClaimKey] : [],
          source: group.proposedClaimKey ? "mixed_group_consensus" : "mixed_group",
        });
        const proposal = createProposal({
          runId: options.runId,
          groupId: `claim-key-mixed:${group.groupKey}`,
          issueKind: "mixed_claim_key_group",
          scope: "cluster",
          entryIds: group.entries.map((entry) => entry.id),
          currentClaimKeys: normalizeStringArray(group.entries.flatMap((entry) => (entry.claim_key ? [entry.claim_key] : []))),
          proposedClaimKeys: group.proposedClaimKey ? [group.proposedClaimKey] : [],
          rationale: buildProposalLifecycleRationale(buildMixedGroupRationale(group), proposalLifecycle),
          confidence: group.proposedClaimKey ? 0.8 : 0.55,
          source: group.proposedClaimKey ? "mixed_group_consensus" : "mixed_group",
          eligibleForApply: group.proposedClaimKey !== null,
          createdAt: options.now().toISOString(),
        });
        await persistProposal(proposal, {
          proposalLifecycle,
        });
        counts.proposalsEmitted += 1;
        progressTracker.advanceStage();
      }
    }
  } catch (error) {
    terminalStatus = "failed";
    terminalError = error instanceof Error ? error.message : String(error);
  }

  const actualAfter = summarizeClaimKeyHealth(actualEntries, claimExtractionConfig.eligibleTypes);
  const projectedAfter = summarizeClaimKeyHealth(projectedEntries, claimExtractionConfig.eligibleTypes);
  observations.push(
    `Claim-key quality reviewed ${before.totalEntries} entr${before.totalEntries === 1 ? "y" : "ies"} in ${executionStyle} mode.`,
    `Identified ${counts.identifiedNormalizations} normalizations, ${counts.identifiedBackfills} backfills, ${counts.identifiedMetadataRewrites} metadata-backed suspect-key rewrites, and ${counts.identifiedEntityFamilyConvergences} entity-family convergence rewrites.`,
    `Emitted ${counts.proposalsEmitted} unresolved proposal${counts.proposalsEmitted === 1 ? "" : "s"}.`,
  );
  if (counts.skippedNoClaim > 0 || counts.skippedLowConfidence > 0 || counts.skippedCollision > 0 || counts.skippedAmbiguous > 0) {
    observations.push(
      `Skipped ${counts.skippedNoClaim} no-claim cases, ${counts.skippedLowConfidence} low-confidence cases, ` +
        `${counts.skippedCollision} collision cases, and ${counts.skippedAmbiguous} ambiguous cases.`,
    );
  }
  const missingDecisionObservation = buildMissingDecisionObservation(missingDecisionStats);
  if (missingDecisionObservation) {
    observations.push(missingDecisionObservation);
  }
  const groundedFamilyObservation = buildGroundedFamilyPromotionObservation(missingDecisionStats);
  if (groundedFamilyObservation) {
    observations.push(groundedFamilyObservation);
  }
  const siblingSlotResonanceObservation = buildSiblingSlotResonanceObservation(siblingSlotResonanceShadowStats);
  if (siblingSlotResonanceObservation) {
    observations.push(siblingSlotResonanceObservation);
  }
  const siblingSlotResonanceShadowRuleObservation = buildSiblingSlotResonanceShadowRuleObservation(siblingSlotResonanceShadowStats);
  if (siblingSlotResonanceShadowRuleObservation) {
    observations.push(siblingSlotResonanceShadowRuleObservation);
  }
  const missingCompactionObservation = buildMissingCompactionObservation(missingDecisionStats);
  if (missingCompactionObservation) {
    observations.push(missingCompactionObservation);
  }
  if (missingDecisionStats.noClaimWithWarnings > 0) {
    observations.push(
      `${missingDecisionStats.noClaimWithWarnings} missing-key previews ended without a safe claim after deterministic validation warnings or malformed output.`,
    );
  }
  const entityFamilyObservation = buildEntityFamilyConvergenceObservation(entityFamilyDecisionStats);
  if (entityFamilyObservation) {
    observations.push(entityFamilyObservation);
  }
  const circuitBreakerMessage = (circuitBreaker as ClaimKeyCircuitBreakerTrip | null)?.message;
  if (circuitBreakerMessage) {
    recommendations.push(circuitBreakerMessage);
  }
  if (actualAfter.exactKeyMultiActiveClusterCount > 0) {
    recommendations.push(
      `Exact-key multi-active clusters remain at ${actualAfter.exactKeyMultiActiveClusterCount}. Run supersession after claim-key-quality to adjudicate lineage separately.`,
    );
  }

  const passSummary: ClaimKeyQualityPassSummary = {
    executionStyle,
    workingSet: selection,
    before,
    after: options.apply ? actualAfter : before,
    projectedAfter: options.apply ? undefined : projectedAfter,
    counts,
    shadowSiblingSlotResonance: buildSiblingSlotResonanceShadowSummary(siblingSlotResonanceShadowStats),
    circuitBreaker,
  };
  const completion: SurgeonCompletionSummary = {
    actions_taken: actionsTaken,
    entries_skipped: skippedDiagnostics.map((diagnostic) => ({
      entry_id: diagnostic.entryId,
      reason: formatMissingBackfillSkipDiagnostic(diagnostic),
    })),
    observations,
    recommendations,
    claim_key_quality: passSummary,
  };

  return {
    status: terminalStatus,
    error: terminalError,
    completion,
    entriesRetired: 0,
    usage: claimExtractionUsage(claimExtractionLlms),
  };

  async function processInvalidOrNoncanonicalEntry(entry: Entry): Promise<void> {
    const inspection = inspectExistingClaimKey(entry);
    if (inspection.kind !== "malformed" && inspection.kind !== "noncanonical") {
      return;
    }

    if (inspection.kind === "malformed") {
      const { proposal, proposalLifecycle } = await buildMalformedClaimKeyProposal(entry, inspection, {
        getSuggestion: async () => loadSuggestion(entry),
        now: options.now,
        runId: options.runId,
      });
      await persistProposal(proposal, {
        proposalLifecycle,
      });
      counts.proposalsEmitted += 1;
      counts.skippedAmbiguous += 1;
      return;
    }

    const targetClaimKey = inspection.normalized.claimKey;
    const collision = findClaimKeyOccupants(projectedEntries, targetClaimKey, entry.id);
    if (collision.length > 0) {
      counts.skippedCollision += 1;
      recordCollision(circuitBreakerState);
      const proposalLifecycle = buildProposalClaimKeyLifecycle({
        proposedClaimKeys: [targetClaimKey],
        source: "normalize",
        rawClaimKey: entry.claim_key ?? null,
      });
      const proposal = createProposal({
        runId: options.runId,
        groupId: `claim-key-normalize:${entry.id}`,
        issueKind: "noncanonical_claim_key",
        scope: "single_entry",
        entryIds: [entry.id],
        currentClaimKeys: [entry.claim_key ?? ""],
        proposedClaimKeys: [targetClaimKey],
        rationale: buildProposalLifecycleRationale(
          `Canonical normalization would change "${entry.claim_key}" to "${targetClaimKey}", ` +
            `but that canonical key is already occupied by ${collision.length} other matched entr${collision.length === 1 ? "y" : "ies"}.`,
          proposalLifecycle,
        ),
        confidence: 0.99,
        source: "normalize",
        eligibleForApply: true,
        createdAt: options.now().toISOString(),
      });
      await persistProposal(proposal, {
        proposalLifecycle,
      });
      counts.proposalsEmitted += 1;
      circuitBreaker = circuitBreaker ?? evaluateCircuitBreaker(circuitBreakerState);
      if (circuitBreaker) {
        terminalStatus = "failed";
        terminalError = circuitBreaker.message;
      }
      return;
    }

    counts.identifiedNormalizations += 1;
    const updateResult = await maybeApplyClaimKeyUpdate(entry.id, targetClaimKey, {
      actualEntriesById,
      entriesById,
      issueKind: "noncanonical_claim_key",
      oldClaimKey: entry.claim_key ?? null,
      source: "normalize",
      confidence: 0.99,
      rationale: `Canonical normalization preserves the slot while rewriting "${entry.claim_key}" to "${targetClaimKey}".`,
    });
    if (updateResult.applied) {
      counts.appliedNormalizations += 1;
    }
    if (updateResult.projected) {
      if (isTrustedClaimKeyForCleanup(targetClaimKey)) {
        trustedReusableEntryIds.add(entry.id);
      }
      circuitBreaker = recordAppliedRepair(circuitBreakerState, targetClaimKey);
    }
    if (circuitBreaker) {
      terminalStatus = "failed";
      terminalError = circuitBreaker.message;
    }
  }

  async function processMissingEntry(entry: Entry): Promise<void> {
    const inspection = inspectExistingClaimKey(entry);
    if (inspection.kind !== "missing" || !claimExtractionConfig.eligibleTypes.includes(entry.type)) {
      return;
    }

    const trustedGroupReuse = findTrustedGroupReuseCandidate(projectedEntries, trustedReusableEntryIds, entry);
    if (trustedGroupReuse) {
      const activeSiblings = findActiveClaimKeyOccupants(projectedEntries, trustedGroupReuse.claimKey, entry.id);
      if (activeSiblings.some((sibling) => sibling.type !== entry.type)) {
        const proposalLifecycle = buildProposalClaimKeyLifecycle({
          proposedClaimKeys: [trustedGroupReuse.claimKey],
          source: "trusted_group_reuse",
        });
        const proposal = createProposal({
          runId: options.runId,
          groupId: `claim-key-backfill:${entry.id}`,
          issueKind: "missing_claim_key",
          scope: "single_entry",
          entryIds: [entry.id, ...activeSiblings.map((sibling) => sibling.id)],
          currentClaimKeys: [],
          proposedClaimKeys: [trustedGroupReuse.claimKey],
          rationale: buildProposalLifecycleRationale(
            `A matched subject/type group already uses trusted canonical key "${trustedGroupReuse.claimKey}" ` +
              `across ${trustedGroupReuse.supportingEntryIds.length} supporting entr${trustedGroupReuse.supportingEntryIds.length === 1 ? "y" : "ies"}, ` +
              "but that same key is already occupied by a different active entry type in the matched working set.",
            proposalLifecycle,
          ),
          confidence: 0.99,
          source: "trusted_group_reuse",
          eligibleForApply: true,
          createdAt: options.now().toISOString(),
        });
        await persistProposal(proposal, {
          proposalLifecycle,
        });
        counts.proposalsEmitted += 1;
        counts.skippedAmbiguous += 1;
        missingDecisionStats.proposedTrustedGroupReuse += 1;
        return;
      }

      counts.identifiedBackfills += 1;
      const updateResult = await maybeApplyClaimKeyUpdate(entry.id, trustedGroupReuse.claimKey, {
        actualEntriesById,
        entriesById,
        issueKind: "missing_claim_key",
        oldClaimKey: null,
        source: "trusted_group_reuse",
        confidence: 0.99,
        rationale:
          `Matched subject/type entries already use trusted canonical key "${trustedGroupReuse.claimKey}", ` +
          `so the missing key can safely reuse that established family from ${trustedGroupReuse.supportingEntryIds.length} supporting entr${trustedGroupReuse.supportingEntryIds.length === 1 ? "y" : "ies"}.`,
      });
      if (updateResult.applied) {
        counts.appliedBackfills += 1;
      }
      if (updateResult.projected) {
        missingDecisionStats.autoAppliedTrustedGroupReuse += 1;
        circuitBreaker = recordAppliedRepair(circuitBreakerState, trustedGroupReuse.claimKey);
      }
      if (circuitBreaker) {
        terminalStatus = "failed";
        terminalError = circuitBreaker.message;
      }
      return;
    }

    const suggestionRecord = await loadSuggestion(entry);
    if (terminalStatus !== "completed") {
      return;
    }

    const suggestion = suggestionRecord.suggestion;
    if (!suggestion?.claimKey) {
      if (suggestionRecord.warnings.length > 0) {
        missingDecisionStats.noClaimWithWarnings += 1;
      }
      counts.skippedNoClaim += 1;
      skippedDiagnostics.push(
        buildMissingBackfillSkipDiagnostic(entry, suggestionRecord, {
          outcomeOverride: resolveMissingBackfillNullOutcome(suggestionRecord),
        }),
      );
      return;
    }

    const metadataBackfillClaimKey = resolveMetadataBackfillClaimKey(entry, suggestion.claimKey);
    const originalClaimKey = suggestion.compactedFrom ?? suggestion.claimKey;
    const compactness = evaluateClaimKeyCompactness(metadataBackfillClaimKey ?? suggestion.claimKey, {
      priorCompactedFrom: suggestion.compactedFrom ?? null,
      priorCompactionReason: suggestion.compactionReason ?? null,
    });
    const targetClaimKey = compactness.claimKey;
    const targetSource = metadataBackfillClaimKey ? "metadata_backfill_rewrite" : suggestion.path;
    const targetInspection = inspectClaimKey(targetClaimKey);
    const targetIsTrusted = targetInspection.suspectReasons.length === 0;
    const support = evaluateMissingBackfillSupport(entry, targetClaimKey, trustedHints);
    const promotionPolicy = resolveMissingBackfillPromotionPolicy({
      metadataRepaired: metadataBackfillClaimKey !== null,
      previewPath: suggestion.path,
      support,
      compactness,
    });
    const autoApplyThreshold = promotionPolicy.autoApplyThreshold;
    const proposalThreshold = resolveMissingBackfillProposalThreshold({
      metadataRepaired: metadataBackfillClaimKey !== null,
      previewPath: suggestion.path,
      support,
    });
    const activeSiblings = findActiveClaimKeyOccupants(projectedEntries, targetClaimKey, entry.id);
    if (activeSiblings.some((sibling) => sibling.type !== entry.type)) {
      const proposalLifecycle = buildProposalClaimKeyLifecycle({
        proposedClaimKeys: [targetClaimKey],
        source: targetSource,
        rawClaimKey: originalClaimKey,
        compactness,
        support,
      });
      const proposal = createProposal({
        runId: options.runId,
        groupId: `claim-key-backfill:${entry.id}`,
        issueKind: "missing_claim_key",
        scope: "single_entry",
        entryIds: [entry.id, ...activeSiblings.map((sibling) => sibling.id)],
        currentClaimKeys: [],
        proposedClaimKeys: [targetClaimKey],
        rationale: buildProposalLifecycleRationale(
          buildMissingBackfillConflictRationale({
            originalClaimKey,
            targetClaimKey,
            confidence: suggestion.confidence,
            metadataBackfillClaimKey,
            compactness,
          }) + " The same slot key is already used by a different entry type in the matched working set.",
          proposalLifecycle,
        ),
        confidence: suggestion.confidence,
        source: targetSource,
        eligibleForApply: true,
        createdAt: options.now().toISOString(),
      });
      await persistProposal(proposal, {
        compactness,
        promotion: promotionPolicy,
        proposalLifecycle,
        support,
        supportedCandidate: support.supportedProposal,
      });
      counts.proposalsEmitted += 1;
      counts.skippedAmbiguous += 1;
      recordGroundedFamilyPromotionDecision(missingDecisionStats, support, "proposal");
      if (compactness.compactedFrom) {
        missingDecisionStats.proposedCompactedCandidate += 1;
      }
      return;
    }

    if (!targetIsTrusted || !compactness.compactEnoughForAutoApply || suggestion.confidence < autoApplyThreshold) {
      const autoApplyBlocker = resolveMissingBackfillAutoApplyBlocker({
        trusted: targetIsTrusted,
        compactness,
        confidence: suggestion.confidence,
        autoApplyThreshold,
      });
      const shadowAudit = buildMissingBackfillShadowAudit({
        support,
        confidence: suggestion.confidence,
        autoApplyBlocker,
      });
      if (suggestion.confidence >= proposalThreshold) {
        const proposalLifecycle = buildProposalClaimKeyLifecycle({
          proposedClaimKeys: [targetClaimKey],
          source: targetSource,
          rawClaimKey: originalClaimKey,
          compactness,
          support,
        });
        const proposal = createProposal({
          runId: options.runId,
          groupId: `claim-key-backfill:${entry.id}`,
          issueKind: "missing_claim_key",
          scope: "single_entry",
          entryIds: [entry.id],
          currentClaimKeys: [],
          proposedClaimKeys: [targetClaimKey],
          rationale: buildProposalLifecycleRationale(
            buildMissingBackfillProposalRationale({
              originalClaimKey,
              targetClaimKey,
              confidence: suggestion.confidence,
              autoApplyThreshold,
              promotionLane: promotionPolicy.lane,
              trusted: targetIsTrusted,
              metadataBackfillClaimKey,
              compactness,
              support,
            }),
            proposalLifecycle,
          ),
          confidence: suggestion.confidence,
          source: targetSource,
          eligibleForApply: true,
          createdAt: options.now().toISOString(),
        });
        await persistProposal(proposal, {
          autoApplyBlocker,
          compactness,
          promotion: promotionPolicy,
          proposalLifecycle,
          support,
          supportedCandidate: support.supportedProposal,
          shadow: shadowAudit ?? undefined,
        });
        counts.proposalsEmitted += 1;
        counts.skippedAmbiguous += 1;
        recordGroundedFamilyPromotionDecision(missingDecisionStats, support, "proposal");
        if (shadowAudit) {
          recordSiblingSlotResonanceShadowCandidate(siblingSlotResonanceShadowStats, targetClaimKey, support, shadowAudit);
        }
        if (compactness.compactedFrom) {
          missingDecisionStats.proposedCompactedCandidate += 1;
        }
        if (metadataBackfillClaimKey !== null || suggestion.path === "deterministic_repair" || support.supportedProposal) {
          missingDecisionStats.proposedSupportedCandidate += 1;
        } else {
          missingDecisionStats.proposedPreviewCandidate += 1;
        }
      } else {
        counts.skippedLowConfidence += 1;
        skippedDiagnostics.push(
          buildMissingBackfillSkipDiagnostic(entry, suggestionRecord, {
            outcomeOverride: "low_confidence_candidate",
            suggestedClaimKey: targetClaimKey,
          }),
        );
      }
      return;
    }

    counts.identifiedBackfills += 1;
    const updateResult = await maybeApplyClaimKeyUpdate(entry.id, targetClaimKey, {
      actualEntriesById,
      entriesById,
      issueKind: "missing_claim_key",
      oldClaimKey: null,
      source: targetSource,
      confidence: suggestion.confidence,
      compactness,
      promotion: promotionPolicy,
      support,
      rawClaimKey: originalClaimKey,
      rationale: buildMissingBackfillApplyRationale({
        originalClaimKey,
        targetClaimKey,
        confidence: suggestion.confidence,
        promotionLane: promotionPolicy.lane,
        source: targetSource,
        metadataBackfillClaimKey,
        compactness,
        support,
      }),
    });
    if (updateResult.applied) {
      counts.appliedBackfills += 1;
    }
    if (updateResult.projected) {
      if (metadataBackfillClaimKey !== null) {
        missingDecisionStats.autoAppliedMetadataRepair += 1;
      } else if (suggestion.path === "deterministic_repair") {
        missingDecisionStats.autoAppliedDeterministicRepair += 1;
      } else if (support.autoApplyClass !== null && suggestion.confidence < HIGH_CONFIDENCE_BACKFILL_THRESHOLD) {
        missingDecisionStats.autoAppliedSupportedPreview += 1;
      } else {
        missingDecisionStats.autoAppliedPreviewModel += 1;
      }
      recordGroundedFamilyPromotionDecision(missingDecisionStats, support, "auto_apply");
      if (compactness.compactedFrom) {
        missingDecisionStats.autoAppliedCompactedCandidate += 1;
      }
      circuitBreaker = recordAppliedRepair(circuitBreakerState, targetClaimKey);
    }
    if (circuitBreaker) {
      terminalStatus = "failed";
      terminalError = circuitBreaker.message;
    }
  }

  async function processSuspectEntry(entry: Entry): Promise<void> {
    const inspection = inspectExistingClaimKey(entry);
    if (inspection.kind !== "suspect") {
      return;
    }

    const metadataRepair = resolveExplicitMetadataRepair(entry, inspection.inspection);
    if (metadataRepair && findClaimKeyOccupants(projectedEntries, metadataRepair, entry.id).length === 0) {
      counts.identifiedMetadataRewrites += 1;
      const updateResult = await maybeApplyClaimKeyUpdate(entry.id, metadataRepair, {
        actualEntriesById,
        entriesById,
        issueKind: "suspect_canonical_claim_key",
        oldClaimKey: entry.claim_key ?? null,
        source: "metadata_rewrite",
        confidence: 0.98,
        rationale: `Explicit entry metadata resolves ${describeSuspicionList(inspection.inspection)} to "${metadataRepair}".`,
      });
      if (updateResult.applied) {
        counts.appliedMetadataRewrites += 1;
      }
      if (updateResult.projected) {
        circuitBreaker = recordAppliedRepair(circuitBreakerState, metadataRepair);
      }
      if (circuitBreaker) {
        terminalStatus = "failed";
        terminalError = circuitBreaker.message;
      }
      return;
    }

    const suggestionRecord = claimExtractionConfig.eligibleTypes.includes(entry.type)
      ? await loadSuggestion(entry)
      : { suggestion: null, warnings: [], previewOutcome: null };
    if (terminalStatus !== "completed") {
      return;
    }

    const proposedClaimKeys = [
      metadataRepair,
      suggestionRecord.suggestion?.claimKey && suggestionRecord.suggestion.claimKey !== entry.claim_key ? suggestionRecord.suggestion.claimKey : null,
    ].filter((value): value is string => value !== null);
    const proposalLifecycle = buildProposalClaimKeyLifecycle({
      proposedClaimKeys,
      source: metadataRepair ? "metadata_rewrite" : (suggestionRecord.suggestion?.path ?? "heuristic"),
      rawClaimKey: entry.claim_key_raw ?? entry.claim_key ?? null,
    });
    const proposal = createProposal({
      runId: options.runId,
      groupId: `claim-key-suspect:${entry.id}`,
      issueKind: "suspect_canonical_claim_key",
      scope: "single_entry",
      entryIds: [entry.id],
      currentClaimKeys: entry.claim_key ? [entry.claim_key] : [],
      proposedClaimKeys,
      rationale: buildProposalLifecycleRationale(
        buildSuspectProposalRationale(entry, inspection.inspection, metadataRepair, suggestionRecord.suggestion),
        proposalLifecycle,
      ),
      confidence: metadataRepair ? 0.98 : (suggestionRecord.suggestion?.confidence ?? 0.5),
      source: metadataRepair ? "metadata_rewrite" : (suggestionRecord.suggestion?.path ?? "heuristic"),
      eligibleForApply: proposedClaimKeys.length > 0,
      createdAt: options.now().toISOString(),
    });
    await persistProposal(proposal, {
      proposalLifecycle,
    });
    counts.proposalsEmitted += 1;
    counts.skippedAmbiguous += 1;
  }

  async function processEntityFamilyConvergenceCandidate(candidate: ClaimKeyEntityFamilyCandidate): Promise<void> {
    const audit = buildEntityFamilyConvergenceAudit(candidate);
    const canonicalEntityPrefix = candidate.canonicalEntityPrefix;
    const entriesToRewrite = canonicalEntityPrefix
      ? projectedEntries.filter((entry) => {
          const claimKey = entry.claim_key?.trim();
          if (!claimKey) {
            return false;
          }

          const inspection = inspectClaimKey(claimKey);
          if (!inspection.normalized || inspection.suspectReasons.length > 0 || !candidate.entityPrefixes.includes(inspection.normalized.entity)) {
            return false;
          }

          return inspection.normalized.entity !== canonicalEntityPrefix;
        })
      : [];

    if (!canonicalEntityPrefix || !candidate.autoConverge || entriesToRewrite.length === 0) {
      const proposedClaimKeys = canonicalEntityPrefix ? mapEntityFamilyClaimKeys(candidate.claimKeys, candidate.entityPrefixes, canonicalEntityPrefix) : [];
      const proposalLifecycle = buildProposalClaimKeyLifecycle({
        proposedClaimKeys,
        source: canonicalEntityPrefix ? "entity_family_canonical_candidate" : "entity_family_ambiguous",
      });
      const proposal = createProposal({
        runId: options.runId,
        groupId: `claim-key-entity-family:${candidate.entityPrefixes.join(",")}`,
        issueKind: "entity_family_convergence",
        scope: "cluster",
        entryIds: candidate.entryIds,
        currentClaimKeys: candidate.claimKeys,
        proposedClaimKeys,
        rationale: buildProposalLifecycleRationale(buildEntityFamilyConvergenceRationale(candidate), proposalLifecycle),
        confidence: candidate.confidence,
        source: canonicalEntityPrefix ? "entity_family_canonical_candidate" : "entity_family_ambiguous",
        eligibleForApply: canonicalEntityPrefix !== null,
        createdAt: options.now().toISOString(),
      });
      await persistProposal(proposal, {
        entityFamilyAudit: audit,
        proposalLifecycle,
      });
      counts.proposalsEmitted += 1;
      counts.skippedAmbiguous += 1;
      entityFamilyDecisionStats.proposedClusters += 1;
      return;
    }

    for (const entry of entriesToRewrite) {
      const claimKey = entry.claim_key?.trim();
      if (!claimKey) {
        continue;
      }

      const inspection = inspectClaimKey(claimKey);
      if (!inspection.normalized) {
        continue;
      }

      const targetClaimKey = `${canonicalEntityPrefix}/${inspection.normalized.attribute}`;
      const activeSiblings = findActiveClaimKeyOccupants(projectedEntries, targetClaimKey, entry.id);
      if (activeSiblings.some((sibling) => sibling.type !== entry.type)) {
        const proposedClaimKeys = mapEntityFamilyClaimKeys(candidate.claimKeys, candidate.entityPrefixes, canonicalEntityPrefix);
        const proposalLifecycle = buildProposalClaimKeyLifecycle({
          proposedClaimKeys,
          source: "entity_family_collision",
        });
        const proposal = createProposal({
          runId: options.runId,
          groupId: `claim-key-entity-family:${candidate.entityPrefixes.join(",")}`,
          issueKind: "entity_family_convergence",
          scope: "cluster",
          entryIds: normalizeStringArray([...candidate.entryIds, ...activeSiblings.map((sibling) => sibling.id)]),
          currentClaimKeys: candidate.claimKeys,
          proposedClaimKeys,
          rationale: buildProposalLifecycleRationale(
            `${buildEntityFamilyConvergenceRationale(candidate)} ` +
              `Auto-convergence would collide with an active entry of a different type at "${targetClaimKey}".`,
            proposalLifecycle,
          ),
          confidence: candidate.confidence,
          source: "entity_family_collision",
          eligibleForApply: true,
          createdAt: options.now().toISOString(),
        });
        await persistProposal(proposal, {
          entityFamilyAudit: audit,
          autoApplyBlocker: "cross_type_collision",
          proposalLifecycle,
        });
        counts.proposalsEmitted += 1;
        counts.skippedAmbiguous += 1;
        entityFamilyDecisionStats.proposedClusters += 1;
        return;
      }
    }

    let appliedEntries = 0;
    for (const entry of entriesToRewrite) {
      const claimKey = entry.claim_key?.trim();
      if (!claimKey) {
        continue;
      }

      const inspection = inspectClaimKey(claimKey);
      if (!inspection.normalized) {
        continue;
      }

      const targetClaimKey = `${canonicalEntityPrefix}/${inspection.normalized.attribute}`;
      counts.identifiedEntityFamilyConvergences += 1;
      const updateResult = await maybeApplyClaimKeyUpdate(entry.id, targetClaimKey, {
        actualEntriesById,
        entriesById,
        issueKind: "entity_family_convergence",
        oldClaimKey: claimKey,
        source: "entity_family_auto_convergence",
        confidence: candidate.confidence,
        rationale:
          `${buildEntityFamilyConvergenceRationale(candidate)} ` +
          `This entry keeps attribute "${inspection.normalized.attribute}" while converging its entity prefix onto "${canonicalEntityPrefix}".`,
        entityFamilyAudit: audit,
      });
      if (updateResult.applied) {
        counts.appliedEntityFamilyConvergences += 1;
        appliedEntries += 1;
      }
      if (updateResult.projected) {
        circuitBreaker = recordAppliedRepair(circuitBreakerState, targetClaimKey);
      }
      if (circuitBreaker) {
        terminalStatus = "failed";
        terminalError = circuitBreaker.message;
        return;
      }
    }

    if (appliedEntries > 0) {
      entityFamilyDecisionStats.appliedClusters += 1;
      entityFamilyDecisionStats.appliedEntries += appliedEntries;
    }
  }

  function shouldPreloadSuggestions(): boolean {
    return claimExtractionConfig.enabled && typeof deps.createClaimExtractionLlm === "function";
  }

  function shouldPreviewMissingEntry(entry: Entry): boolean {
    return findTrustedGroupReuseCandidate(projectedEntries, trustedReusableEntryIds, entry) === null;
  }

  function shouldPreloadSuspectSuggestion(entry: Entry): boolean {
    if (!claimExtractionConfig.eligibleTypes.includes(entry.type)) {
      return false;
    }

    const inspection = inspectExistingClaimKey(entry);
    if (inspection.kind !== "suspect") {
      return false;
    }

    const metadataRepair = resolveExplicitMetadataRepair(entry, inspection.inspection);
    return metadataRepair === null || findClaimKeyOccupants(projectedEntries, metadataRepair, entry.id).length > 0;
  }

  async function preloadSuggestionsForStage(entries: Entry[]): Promise<void> {
    if (entries.length === 0 || !shouldPreloadSuggestions()) {
      return;
    }

    const workerCount = Math.min(previewConcurrency, entries.length);
    let nextIndex = 0;

    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        const llm = createTrackedClaimExtractionLlm();

        while (true) {
          if (terminalStatus !== "completed") {
            return;
          }

          if (options.signal?.aborted === true) {
            terminalStatus = "aborted";
            terminalError = "Run aborted by user (SIGINT).";
            return;
          }

          const currentIndex = nextIndex;
          nextIndex += 1;

          if (currentIndex >= entries.length) {
            return;
          }

          const entry = entries[currentIndex];
          if (!entry) {
            return;
          }

          await loadSuggestion(entry, llm);
          progressTracker.advancePreview();
        }
      }),
    );
  }

  async function loadSuggestion(entry: Entry, llmOverride?: ClaimExtractionPreviewLlm | null): Promise<EntrySuggestionRecord> {
    const cached = suggestionCache.get(entry.id);
    if (cached) {
      return cached;
    }

    if (!claimExtractionConfig.enabled || !claimExtractionConfig.eligibleTypes.includes(entry.type)) {
      const empty = createEmptySuggestionRecord();
      suggestionCache.set(entry.id, empty);
      return empty;
    }

    const llm = llmOverride ?? getFallbackClaimExtractionLlm();
    if (!llm) {
      const empty = createEmptySuggestionRecord();
      suggestionCache.set(entry.id, empty);
      return empty;
    }

    const warnings: string[] = [];
    let previewOutcome: ClaimExtractionPreviewOutcome | null = null;
    let suggestion: ClaimExtractionResult | null;
    try {
      suggestion = await previewClaimKeyExtraction(
        {
          type: entry.type,
          subject: entry.subject,
          content: entry.content,
        },
        llm,
        claimExtractionConfig,
        {
          hints: buildCleanupHintsForEntry(trustedHints, entry),
          onWarning: (warning) => warnings.push(warning),
          onPreviewOutcome: (outcome) => {
            previewOutcome = outcome;
          },
        },
      );
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : String(error));
      suggestion = null;
    }

    const record = { suggestion, warnings, previewOutcome };
    suggestionCache.set(entry.id, record);

    const usage = claimExtractionUsage(claimExtractionLlms);
    if (terminalStatus === "completed" && options.costCapUsd > 0 && usage.estimatedCostUsd >= options.costCapUsd) {
      terminalStatus = "cost_capped";
      terminalError = `Cost cap exceeded while previewing claim-key repairs at ${usage.estimatedCostUsd.toFixed(4)} USD.`;
    }

    return record;
  }

  function getFallbackClaimExtractionLlm(): ClaimExtractionPreviewLlm | null {
    if (fallbackClaimExtractionLlm !== undefined) {
      return fallbackClaimExtractionLlm;
    }

    fallbackClaimExtractionLlm = createTrackedClaimExtractionLlm();
    return fallbackClaimExtractionLlm;
  }

  function createTrackedClaimExtractionLlm(): ClaimExtractionPreviewLlm | null {
    const llm = deps.createClaimExtractionLlm ? deps.createClaimExtractionLlm() : null;
    if (llm && !claimExtractionLlms.includes(llm)) {
      claimExtractionLlms.push(llm);
    }

    return llm;
  }

  async function maybeApplyClaimKeyUpdate(
    entryId: string,
    claimKey: string,
    input: {
      actualEntriesById: Map<string, Entry>;
      entriesById: Map<string, Entry>;
      issueKind: string;
      oldClaimKey: string | null;
      source: string;
      confidence: number;
      support?: MissingBackfillSupportEvaluation;
      compactness?: ClaimKeyCompactnessEvaluation;
      promotion?: MissingBackfillPromotionPolicy;
      shadow?: MissingBackfillShadowAudit;
      rationale: string;
      rawClaimKey?: string | null;
      entityFamilyAudit?: EntityFamilyConvergenceAudit;
    },
  ): Promise<{ projected: boolean; applied: boolean }> {
    const projected = input.entriesById.get(entryId);
    const actual = input.actualEntriesById.get(entryId);
    if (!projected || !actual) {
      return { projected: false, applied: false };
    }

    const previousProjected = snapshotClaimKeyLifecycle(projected);
    const lifecycle = buildAppliedClaimKeyLifecycle({
      targetClaimKey: claimKey,
      priorClaimKey: input.oldClaimKey,
      priorClaimKeyRaw: projected.claim_key_raw ?? actual.claim_key_raw,
      rawClaimKey: input.rawClaimKey,
      source: input.source,
      support: input.support,
      compactness: input.compactness,
    });

    projected.claim_key = claimKey;
    projected.claim_key_raw = lifecycle.rawClaimKey;
    projected.claim_key_status = lifecycle.status;
    projected.claim_key_source = lifecycle.source;
    projected.claim_key_confidence = input.confidence;
    projected.claim_key_rationale = input.rationale;
    if (!options.apply) {
      return { projected: true, applied: false };
    }

    const updated = await deps.port.updateEntry(
      entryId,
      {
        claim_key: claimKey,
        claim_key_raw: lifecycle.rawClaimKey,
        claim_key_status: lifecycle.status,
        claim_key_source: lifecycle.source,
        claim_key_confidence: input.confidence,
        claim_key_rationale: input.rationale,
      },
      { includeInactive: selection.includeInactive },
    );
    if (!updated) {
      restoreClaimKeyLifecycle(projected, previousProjected);
      return { projected: false, applied: false };
    }

    actual.claim_key = claimKey;
    actual.claim_key_raw = lifecycle.rawClaimKey;
    actual.claim_key_status = lifecycle.status;
    actual.claim_key_source = lifecycle.source;
    actual.claim_key_confidence = input.confidence;
    actual.claim_key_rationale = input.rationale;
    await deps.port.logRunAction({
      id: randomUUID(),
      runId: options.runId,
      actionType: "update_entry",
      entryIds: [entryId],
      reasoning: input.rationale,
      recallDelta: null,
      details: {
        issue_kind: input.issueKind,
        old_claim_key: input.oldClaimKey,
        new_claim_key: claimKey,
        claim_key_raw: lifecycle.rawClaimKey,
        claim_key_status: lifecycle.status,
        claim_key_source: lifecycle.source,
        claim_key_confidence: input.confidence,
        claim_key_rationale: input.rationale,
        proposal_source: input.source,
        confidence: input.confidence,
        auto_apply_threshold: input.promotion?.autoApplyThreshold,
        auto_applied: true,
        promotion_lane: input.promotion?.lane,
        supported_auto_apply: input.support?.autoApplyClass !== null,
        ...buildMissingBackfillSupportAuditDetails(input.support),
        ...buildMissingBackfillShadowAuditDetails(input.shadow),
        ...(input.compactness?.compactedFrom
          ? {
              claim_key_compacted_from: input.compactness.compactedFrom,
              claim_key_compaction_reason: input.compactness.compactionReason,
            }
          : {}),
        ...(input.entityFamilyAudit
          ? {
              competing_entity_prefixes: [...input.entityFamilyAudit.competingEntityPrefixes],
              canonical_entity_prefix: input.entityFamilyAudit.canonicalEntityPrefix,
              canonical_selection_reasons: [...input.entityFamilyAudit.canonicalSelectionReasons],
              entity_family_unresolved_reason: input.entityFamilyAudit.unresolvedReason,
              entity_family_evidence: input.entityFamilyAudit.evidence.map((evidence) => ({ ...evidence })),
              entity_family_pair_support: input.entityFamilyAudit.pairSupport.map((support) => ({
                ...support,
                entityPrefixes: [...support.entityPrefixes],
                supportingEntryIds: [...support.supportingEntryIds],
                sharedAttributes: [...support.sharedAttributes],
                evidence: support.evidence.map((evidence) => ({ ...evidence })),
              })),
            }
          : {}),
      },
      createdAt: options.now().toISOString(),
    });
    actionsTaken += 1;
    return { projected: true, applied: true };

    function restoreClaimKeyLifecycle(entry: Entry, snapshot: ReturnType<typeof snapshotClaimKeyLifecycle>): void {
      entry.claim_key = snapshot.claimKey;
      entry.claim_key_raw = snapshot.claimKeyRaw;
      entry.claim_key_status = snapshot.claimKeyStatus;
      entry.claim_key_source = snapshot.claimKeySource;
      entry.claim_key_confidence = snapshot.claimKeyConfidence;
      entry.claim_key_rationale = snapshot.claimKeyRationale;
    }
  }

  async function persistProposal(
    proposal: SurgeonRunProposal,
    audit?: {
      autoApplyBlocker?: string | null;
      compactness?: ClaimKeyCompactnessEvaluation;
      promotion?: MissingBackfillPromotionPolicy;
      support?: MissingBackfillSupportEvaluation;
      supportedCandidate?: boolean;
      shadow?: MissingBackfillShadowAudit;
      entityFamilyAudit?: EntityFamilyConvergenceAudit;
      proposalLifecycle?: ProposalClaimKeyLifecycleMetadata;
    },
  ): Promise<void> {
    await deps.port.logRunProposal(proposal);
    await deps.port.logRunAction({
      id: randomUUID(),
      runId: options.runId,
      actionType: "flag_review",
      entryIds: proposal.entryIds,
      reasoning: proposal.rationale,
      recallDelta: null,
      details: {
        proposal_id: proposal.id,
        group_id: proposal.groupId,
        issue_kind: proposal.issueKind,
        current_claim_keys: proposal.currentClaimKeys,
        proposed_claim_keys: proposal.proposedClaimKeys,
        confidence: proposal.confidence,
        proposal_source: proposal.source,
        auto_apply_threshold: audit?.promotion?.autoApplyThreshold,
        auto_applied: false,
        promotion_lane: audit?.promotion?.lane,
        eligible_for_apply: proposal.eligibleForApply,
        supported_candidate: audit?.supportedCandidate === true,
        proposal_deferred_until_review: audit?.proposalLifecycle?.deferredUntilReview === true,
        proposal_claim_key_status: audit?.proposalLifecycle?.proposedStatus,
        proposal_claim_key_source: audit?.proposalLifecycle?.proposedSource,
        proposal_claim_key_raw: audit?.proposalLifecycle?.proposedRawClaimKey,
        ...buildMissingBackfillSupportAuditDetails(audit?.support),
        ...buildMissingBackfillShadowAuditDetails(audit?.shadow),
        ...(audit?.compactness?.compactedFrom
          ? {
              claim_key_compacted_from: audit.compactness.compactedFrom,
              claim_key_compaction_reason: audit.compactness.compactionReason,
            }
          : {}),
        ...(audit?.autoApplyBlocker
          ? {
              auto_apply_blocker: audit.autoApplyBlocker,
            }
          : {}),
        ...(audit?.entityFamilyAudit
          ? {
              competing_entity_prefixes: [...audit.entityFamilyAudit.competingEntityPrefixes],
              canonical_entity_prefix: audit.entityFamilyAudit.canonicalEntityPrefix,
              canonical_selection_reasons: [...audit.entityFamilyAudit.canonicalSelectionReasons],
              entity_family_unresolved_reason: audit.entityFamilyAudit.unresolvedReason,
              entity_family_evidence: audit.entityFamilyAudit.evidence.map((evidence) => ({ ...evidence })),
              entity_family_pair_support: audit.entityFamilyAudit.pairSupport.map((support) => ({
                ...support,
                entityPrefixes: [...support.entityPrefixes],
                supportingEntryIds: [...support.supportingEntryIds],
                sharedAttributes: [...support.sharedAttributes],
                evidence: support.evidence.map((evidence) => ({ ...evidence })),
              })),
            }
          : {}),
      },
      createdAt: proposal.createdAt,
    });
    actionsTaken += 1;
  }
}

/**
 * Summarizes claim-key quality for one matched working set.
 *
 * @param entries - Entries included in the working set.
 * @param eligibleTypes - Entry types eligible for missing-key backfill.
 * @returns Aggregate claim-key quality snapshot.
 */
export function summarizeClaimKeyHealth(entries: Entry[], eligibleTypes: string[]): ClaimKeyHealthSnapshot {
  const activeEntries = entries.filter((entry) => isEntryActive(entry));
  const withClaimKeys = entries.filter((entry) => typeof entry.claim_key === "string" && entry.claim_key.trim().length > 0);
  const malformedOrNoncanonicalCount = entries.filter((entry) => {
    const inspection = inspectExistingClaimKey(entry);
    return inspection.kind === "malformed" || inspection.kind === "noncanonical";
  }).length;
  const suspectCanonicalCount = entries.filter((entry) => inspectExistingClaimKey(entry).kind === "suspect").length;
  const entityFamilyCandidates = detectClaimKeyEntityFamilyCandidates(entries);

  return {
    totalEntries: entries.length,
    activeEntries: activeEntries.length,
    coverageCount: withClaimKeys.length,
    coveragePct: entries.length > 0 ? withClaimKeys.length / entries.length : 0,
    missingCount: entries.filter((entry) => inspectExistingClaimKey(entry).kind === "missing").length,
    eligibleMissingCount: entries.filter((entry) => inspectExistingClaimKey(entry).kind === "missing" && eligibleTypes.includes(entry.type)).length,
    malformedOrNoncanonicalCount,
    suspectCanonicalCount,
    entityFamilyGroupCount: entityFamilyCandidates.length,
    mixedGroupCount: findMixedKeyGroups(entries).length,
    exactKeyMultiActiveClusterCount: countExactKeyMultiActiveClusters(activeEntries),
  };
}

function claimExtractionUsage(llms: ClaimExtractionPreviewLlm[]): {
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
} {
  return llms.reduce(
    (total, llm) => {
      const usage = llm.metadata?.usage;
      total.inputTokens += usage?.inputTokens ?? 0;
      total.outputTokens += usage?.outputTokens ?? 0;
      total.estimatedCostUsd += usage?.totalCost ?? 0;
      return total;
    },
    {
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostUsd: 0,
    },
  );
}

interface ClaimKeyQualityStageProgressState {
  stage: ClaimKeyQualityProgressStage;
  total: number;
  completed: number;
  unitLabel: "entries" | "groups";
  previewQueued: number;
  previewCompleted: number;
  previewTotal: number;
  previewConcurrency: number | null;
  lastReportedCompleted: number;
  lastReportedPreviewCompleted: number;
  lastReportedAtMs: number;
}

interface ClaimKeyQualityProgressTracker {
  emitHealthSnapshot(snapshot: ClaimKeyHealthSnapshot): void;
  startStage(
    stage: ClaimKeyQualityProgressStage,
    total: number,
    unitLabel: "entries" | "groups",
    options?: {
      previewTotal?: number;
      previewConcurrency?: number;
    },
  ): void;
  advancePreview(count?: number): void;
  advanceStage(count?: number): void;
}

function createClaimKeyQualityProgressTracker(input: {
  apply: boolean;
  verbose: boolean;
  totalEntries: number;
  counts: ClaimKeyQualityRepairCounts;
  reportProgress?: SurgeonProgressReporter;
}): ClaimKeyQualityProgressTracker {
  const startedAtMs = Date.now();
  const progressIntervalMs = input.verbose ? CLAIM_KEY_PROGRESS_VERBOSE_INTERVAL_MS : CLAIM_KEY_PROGRESS_INTERVAL_MS;
  const progressEvery = input.verbose ? CLAIM_KEY_PROGRESS_EVERY_VERBOSE_ENTRIES : CLAIM_KEY_PROGRESS_EVERY_ENTRIES;
  let processedEntries = 0;
  let activeStage: ClaimKeyQualityStageProgressState | null = null;

  return {
    emitHealthSnapshot(snapshot: ClaimKeyHealthSnapshot): void {
      emitSurgeonProgress(input.reportProgress, {
        kind: "claim_key_quality_progress",
        passType: "claim_key_quality",
        apply: input.apply,
        stage: "health",
        status: "snapshot",
        completed: 0,
        total: snapshot.totalEntries,
        unitLabel: "entries",
        processedEntries,
        totalEntries: input.totalEntries,
        counts: cloneRepairCounts(input.counts),
        elapsedMs: elapsedMs(startedAtMs),
        health: snapshot,
      });
    },

    startStage(
      stage: ClaimKeyQualityProgressStage,
      total: number,
      unitLabel: "entries" | "groups",
      options?: {
        previewTotal?: number;
        previewConcurrency?: number;
      },
    ): void {
      const previewTotal = Math.max(0, options?.previewTotal ?? 0);
      activeStage =
        total > 0
          ? {
              stage,
              total,
              completed: 0,
              unitLabel,
              previewQueued: previewTotal,
              previewCompleted: 0,
              previewTotal,
              previewConcurrency: previewTotal > 0 ? (options?.previewConcurrency ?? null) : null,
              lastReportedCompleted: 0,
              lastReportedPreviewCompleted: 0,
              lastReportedAtMs: Date.now(),
            }
          : null;

      if (!activeStage) {
        return;
      }

      emitStageEvent("started");
    },

    advancePreview(count = 1): void {
      if (!activeStage || activeStage.previewTotal === 0) {
        return;
      }

      activeStage.previewCompleted += count;
      if (activeStage.previewCompleted > activeStage.previewTotal) {
        activeStage.previewCompleted = activeStage.previewTotal;
      }

      const nowMs = Date.now();
      if (
        activeStage.previewCompleted >= activeStage.previewTotal ||
        activeStage.previewCompleted - activeStage.lastReportedPreviewCompleted >= progressEvery ||
        nowMs - activeStage.lastReportedAtMs >= progressIntervalMs
      ) {
        emitStageEvent("preview_progress", nowMs);
      }
    },

    advanceStage(count = 1): void {
      if (!activeStage) {
        return;
      }

      activeStage.completed += count;
      if (activeStage.unitLabel === "entries") {
        processedEntries += count;
      }

      if (activeStage.completed >= activeStage.total) {
        emitStageEvent("completed");
        activeStage = null;
        return;
      }

      const nowMs = Date.now();
      if (activeStage.completed - activeStage.lastReportedCompleted >= progressEvery || nowMs - activeStage.lastReportedAtMs >= progressIntervalMs) {
        emitStageEvent("progress", nowMs);
      }
    },
  };

  function emitStageEvent(status: "started" | "preview_progress" | "progress" | "completed", nowMs = Date.now()): void {
    if (!activeStage) {
      return;
    }

    activeStage.lastReportedCompleted = activeStage.completed;
    activeStage.lastReportedPreviewCompleted = activeStage.previewCompleted;
    activeStage.lastReportedAtMs = nowMs;
    emitSurgeonProgress(input.reportProgress, {
      kind: "claim_key_quality_progress",
      passType: "claim_key_quality",
      apply: input.apply,
      stage: activeStage.stage,
      status,
      completed: activeStage.completed,
      total: activeStage.total,
      unitLabel: activeStage.unitLabel,
      ...(activeStage.previewTotal > 0
        ? {
            previewQueued: activeStage.previewQueued,
            previewCompleted: activeStage.previewCompleted,
            previewTotal: activeStage.previewTotal,
            ...(activeStage.previewConcurrency !== null ? { previewConcurrency: activeStage.previewConcurrency } : {}),
          }
        : {}),
      processedEntries,
      totalEntries: input.totalEntries,
      counts: cloneRepairCounts(input.counts),
      elapsedMs: elapsedMs(startedAtMs, nowMs),
    });
  }
}

function createEmptyMissingBackfillDecisionStats(): MissingBackfillDecisionStats {
  return {
    autoAppliedTrustedGroupReuse: 0,
    autoAppliedDeterministicRepair: 0,
    autoAppliedMetadataRepair: 0,
    autoAppliedSupportedPreview: 0,
    autoAppliedGroundedFamilyPromotion: 0,
    autoAppliedRelaxedStableSlotPromotion: 0,
    autoAppliedPreviewModel: 0,
    autoAppliedCompactedCandidate: 0,
    proposedTrustedGroupReuse: 0,
    proposedSupportedCandidate: 0,
    proposedGroundedFamilyPromotion: 0,
    proposedRelaxedStableSlotPromotion: 0,
    proposedPreviewCandidate: 0,
    proposedCompactedCandidate: 0,
    noClaimWithWarnings: 0,
  };
}

function createEmptySiblingSlotResonanceShadowStats(): SiblingSlotResonanceShadowStats {
  return {
    thresholdOnlyCandidateCount: 0,
    resonanceApplicableCount: 0,
    resonanceFiredCount: 0,
    shadowQualifiedCount: 0,
    resonanceFiredClaimKeys: [],
    shadowQualifiedClaimKeys: [],
    buckets: new Map(
      SHADOW_BUCKET_ORDER.map((bucket) => [
        bucket,
        {
          candidateCount: 0,
          resonanceApplicableCount: 0,
          resonanceFiredCount: 0,
          shadowQualifiedCount: 0,
        },
      ]),
    ),
  };
}

function createEmptyEntityFamilyConvergenceDecisionStats(): EntityFamilyConvergenceDecisionStats {
  return {
    appliedClusters: 0,
    appliedEntries: 0,
    proposedClusters: 0,
  };
}

function createEmptyRepairCounts(): ClaimKeyQualityRepairCounts {
  return {
    identifiedNormalizations: 0,
    appliedNormalizations: 0,
    identifiedBackfills: 0,
    appliedBackfills: 0,
    identifiedMetadataRewrites: 0,
    appliedMetadataRewrites: 0,
    identifiedEntityFamilyConvergences: 0,
    appliedEntityFamilyConvergences: 0,
    proposalsEmitted: 0,
    skippedNoClaim: 0,
    skippedLowConfidence: 0,
    skippedCollision: 0,
    skippedAmbiguous: 0,
  };
}

function createEmptySuggestionRecord(): EntrySuggestionRecord {
  return {
    suggestion: null,
    warnings: [],
    previewOutcome: null,
  };
}

function cloneRepairCounts(counts: ClaimKeyQualityRepairCounts): ClaimKeyQualityRepairCounts {
  return {
    identifiedNormalizations: counts.identifiedNormalizations,
    appliedNormalizations: counts.appliedNormalizations,
    identifiedBackfills: counts.identifiedBackfills,
    appliedBackfills: counts.appliedBackfills,
    identifiedMetadataRewrites: counts.identifiedMetadataRewrites,
    appliedMetadataRewrites: counts.appliedMetadataRewrites,
    identifiedEntityFamilyConvergences: counts.identifiedEntityFamilyConvergences,
    appliedEntityFamilyConvergences: counts.appliedEntityFamilyConvergences,
    proposalsEmitted: counts.proposalsEmitted,
    skippedNoClaim: counts.skippedNoClaim,
    skippedLowConfidence: counts.skippedLowConfidence,
    skippedCollision: counts.skippedCollision,
    skippedAmbiguous: counts.skippedAmbiguous,
  };
}

function elapsedMs(startedAtMs: number, nowMs = Date.now()): number {
  return Math.max(0, nowMs - startedAtMs);
}

function cloneEntry(entry: Entry): Entry {
  return {
    ...entry,
    tags: [...entry.tags],
    embedding: entry.embedding ? [...entry.embedding] : undefined,
  };
}

function normalizeOptionalString(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function resolveClaimExtractionConcurrency(config: { concurrency?: number }): number {
  const concurrency = config.concurrency;
  const normalized = typeof concurrency === "number" ? Math.trunc(concurrency) : Number.NaN;
  if (!Number.isFinite(normalized) || normalized <= 0) {
    return DEFAULT_CLAIM_EXTRACTION_CONCURRENCY;
  }

  return normalized;
}

function normalizeStringArray(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter((value) => value.length > 0)));
}

function isEntryActive(entry: Entry): boolean {
  return entry.retired === false && !entry.superseded_by;
}

function findTrustedGroupReuseCandidate(entries: Entry[], trustedEntryIds: Set<string>, entry: Entry): TrustedGroupReuseCandidate | null {
  const normalizedSubject = entry.subject.trim().toLowerCase();
  if (normalizedSubject.length === 0) {
    return null;
  }

  const trustedPeers = entries.filter((candidate) => {
    if (candidate.id === entry.id || candidate.type !== entry.type) {
      return false;
    }

    if (!trustedEntryIds.has(candidate.id)) {
      return false;
    }

    if (candidate.subject.trim().toLowerCase() !== normalizedSubject) {
      return false;
    }

    const claimKey = candidate.claim_key?.trim();
    return Boolean(claimKey && isTrustedClaimKeyForCleanup(claimKey));
  });
  const trustedClaimKeys = normalizeStringArray(
    trustedPeers.flatMap((candidate) => {
      const claimKey = candidate.claim_key?.trim();
      return claimKey ? [claimKey] : [];
    }),
  );
  if (trustedClaimKeys.length !== 1) {
    return null;
  }

  const claimKey = trustedClaimKeys[0];
  if (!claimKey) {
    return null;
  }

  return {
    claimKey,
    supportingEntryIds: trustedPeers.map((candidate) => candidate.id),
  };
}

function inspectExistingClaimKey(
  entry: Entry,
):
  | { kind: "missing" }
  | { kind: "ok"; inspection: ClaimKeyInspection }
  | { kind: "malformed"; inspection: ClaimKeyInspection }
  | { kind: "noncanonical"; inspection: ClaimKeyInspection; normalized: NonNullable<ClaimKeyInspection["normalized"]> }
  | { kind: "suspect"; inspection: ClaimKeyInspection } {
  const rawClaimKey = entry.claim_key?.trim();
  if (!rawClaimKey) {
    return { kind: "missing" };
  }

  const inspection = inspectClaimKey(rawClaimKey);
  if (inspection.normalizationFailure) {
    return { kind: "malformed", inspection };
  }

  if (inspection.normalized && !inspection.canonical) {
    return {
      kind: "noncanonical",
      inspection,
      normalized: inspection.normalized,
    };
  }

  if (inspection.suspectReasons.length > 0) {
    return { kind: "suspect", inspection };
  }

  return { kind: "ok", inspection };
}

function buildTrustedCleanupHintSeed(entries: Entry[]): TrustedCleanupHintSeed {
  const claimKeyStats = new Map<string, { count: number; maxImportance: number; latestCreatedAt: string }>();
  const trustedEntries: TrustedCleanupHintEntry[] = [];

  for (const entry of entries) {
    const claimKey = entry.claim_key?.trim();
    if (!claimKey || !isTrustedClaimKeyForCleanup(claimKey)) {
      continue;
    }

    const inspection = inspectClaimKey(claimKey);
    if (!inspection.normalized) {
      continue;
    }

    const existing = claimKeyStats.get(claimKey);
    if (existing) {
      existing.count += 1;
      existing.maxImportance = Math.max(existing.maxImportance, entry.importance);
      existing.latestCreatedAt = existing.latestCreatedAt.localeCompare(entry.created_at) >= 0 ? existing.latestCreatedAt : entry.created_at;
      continue;
    }

    claimKeyStats.set(claimKey, {
      count: 1,
      maxImportance: entry.importance,
      latestCreatedAt: entry.created_at,
    });
    trustedEntries.push({
      id: entry.id,
      claimKey: inspection.normalized.claimKey,
      entity: inspection.normalized.entity,
      attribute: inspection.normalized.attribute,
      type: entry.type,
      tags: normalizeGroundingTags(entry.tags),
      sourceContextTokens: tokenizeGroundingText(entry.source_context),
      subjectTokens: tokenizeGroundingText(entry.subject),
      createdAt: entry.created_at,
    });
  }

  const claimKeyExamples = [...claimKeyStats.entries()]
    .sort((left, right) => {
      const countDelta = right[1].count - left[1].count;
      if (countDelta !== 0) {
        return countDelta;
      }

      const importanceDelta = right[1].maxImportance - left[1].maxImportance;
      if (importanceDelta !== 0) {
        return importanceDelta;
      }

      const createdAtDelta = right[1].latestCreatedAt.localeCompare(left[1].latestCreatedAt);
      if (createdAtDelta !== 0) {
        return createdAtDelta;
      }

      return left[0].localeCompare(right[0]);
    })
    .slice(0, MAX_CLEANUP_CLAIM_KEY_HINTS)
    .map(([claimKey]) => claimKey);
  const entityHints = normalizeStringArray(claimKeyExamples.map((claimKey) => claimKey.split("/", 1)[0] ?? "").filter((entity) => entity.length > 0)).slice(
    0,
    MAX_CLEANUP_ENTITY_HINTS,
  );

  return {
    globalEntityHints: entityHints,
    globalClaimKeyExamples: claimKeyExamples,
    entries: trustedEntries.sort((left, right) => {
      const createdAtDelta = right.createdAt.localeCompare(left.createdAt);
      if (createdAtDelta !== 0) {
        return createdAtDelta;
      }

      const claimKeyDelta = left.claimKey.localeCompare(right.claimKey);
      if (claimKeyDelta !== 0) {
        return claimKeyDelta;
      }

      return left.id.localeCompare(right.id);
    }),
  };
}

function buildCleanupHintsForEntry(baseHints: TrustedCleanupHintSeed, entry: Entry): ClaimExtractionHints {
  // Tags and source_context only prioritize which already-trusted families are shown.
  // Local metadata narrows hinting, but it never becomes trusted canon by itself.
  const rankedEntries = baseHints.entries
    .map((trustedEntry) => ({
      trustedEntry,
      score: scoreTrustedHintRelevance(entry, trustedEntry),
    }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => {
      const scoreDelta = right.score - left.score;
      if (scoreDelta !== 0) {
        return scoreDelta;
      }

      const createdAtDelta = right.trustedEntry.createdAt.localeCompare(left.trustedEntry.createdAt);
      if (createdAtDelta !== 0) {
        return createdAtDelta;
      }

      return left.trustedEntry.claimKey.localeCompare(right.trustedEntry.claimKey);
    });
  const relevantClaimKeyExamples = rankedEntries.map((candidate) => candidate.trustedEntry.claimKey);
  const claimKeyExamples = normalizeStringArray([...relevantClaimKeyExamples, ...baseHints.globalClaimKeyExamples]).slice(0, MAX_CLEANUP_CLAIM_KEY_HINTS);
  const entityHints = normalizeStringArray([
    ...rankedEntries.map((candidate) => candidate.trustedEntry.entity),
    ...claimKeyExamples.map((claimKey) => claimKey.split("/", 1)[0] ?? ""),
    ...baseHints.globalEntityHints,
  ]).slice(0, MAX_CLEANUP_ENTITY_HINTS);

  return {
    entityHints,
    claimKeyExamples,
    project: entry.project,
    userId: entry.user_id,
    tags: normalizeGroundingTags(entry.tags),
    sourceContext: entry.source_context,
  };
}

function scoreTrustedHintRelevance(entry: Entry, trustedEntry: TrustedCleanupHintEntry): number {
  const entryTagSet = new Set(normalizeGroundingTags(entry.tags));
  const entrySourceTokens = new Set(tokenizeGroundingText(entry.source_context));
  const entrySubjectTokens = new Set(tokenizeGroundingText(entry.subject));
  const tagOverlap = countSetOverlap(entryTagSet, trustedEntry.tags);
  const sourceOverlap = countSetOverlap(entrySourceTokens, trustedEntry.sourceContextTokens);
  const subjectOverlap = countSetOverlap(entrySubjectTokens, trustedEntry.subjectTokens);

  return tagOverlap * 6 + sourceOverlap * 5 + subjectOverlap * 2 + (entry.type === trustedEntry.type ? 1 : 0);
}

function evaluateMissingBackfillSupport(entry: Entry, targetClaimKey: string, trustedHints: TrustedCleanupHintSeed): MissingBackfillSupportEvaluation {
  const inspection = inspectClaimKey(targetClaimKey);
  const normalized = inspection.normalized;
  if (!normalized) {
    return createEmptyMissingBackfillSupportEvaluation();
  }

  // Supported candidates still start from a trusted normalized key. Local overlap and
  // template cues can strengthen that candidate, but they cannot rescue a dirty key.
  const entryTagSet = new Set(normalizeGroundingTags(entry.tags));
  const entrySourceTokens = new Set(tokenizeGroundingText(entry.source_context));
  const relevantEntries = trustedHints.entries.filter((trustedEntry) => {
    if (trustedEntry.id === entry.id) {
      return false;
    }

    return trustedEntry.claimKey === normalized.claimKey || trustedEntry.entity === normalized.entity;
  });
  const exactReuseEntries = relevantEntries.filter((trustedEntry) => trustedEntry.claimKey === normalized.claimKey);
  const familyReuseEntries = relevantEntries.filter(
    (trustedEntry) => trustedEntry.claimKey !== normalized.claimKey && trustedEntry.entity === normalized.entity,
  );
  const groundedExactReuseEntries = exactReuseEntries.filter((trustedEntry) => {
    const grounding = inspectGroundingOverlap(entryTagSet, entrySourceTokens, trustedEntry);
    return grounding.tagGrounding || grounding.sourceContextGrounding;
  });
  const groundedFamilyReuseEntries = familyReuseEntries.filter((trustedEntry) => {
    const grounding = inspectGroundingOverlap(entryTagSet, entrySourceTokens, trustedEntry);
    return grounding.tagGrounding || grounding.sourceContextGrounding;
  });
  const tagGrounding = relevantEntries.some((trustedEntry) => inspectGroundingOverlap(entryTagSet, entrySourceTokens, trustedEntry).tagGrounding);
  const sourceContextGrounding = relevantEntries.some(
    (trustedEntry) => inspectGroundingOverlap(entryTagSet, entrySourceTokens, trustedEntry).sourceContextGrounding,
  );
  const localGrounding = tagGrounding || sourceContextGrounding;
  const lexicalAlignment = inspectCandidateLexicalAlignment(entry, normalized.entity, normalized.attribute);
  const templateSupport = matchesConservativeTemplateSupport(entry, normalized.attribute);
  const stableSlotSupport = matchesStableFamilySlotSupport(normalized.attribute);
  const trustedExactReuse = groundedExactReuseEntries.length > 0;
  const trustedEntityFamilyReuse = groundedFamilyReuseEntries.length > 0;
  const promotionSupport = resolveMissingBackfillPromotionSupport({
    exactReuseCount: groundedExactReuseEntries.length,
    familyReuseCount: familyReuseEntries.length,
    groundedFamilyReuseCount: groundedFamilyReuseEntries.length,
    localGrounding,
    templateSupport,
    stableSlotSupport,
    lexicalAlignment,
  });
  const siblingSlotResonance = evaluateSiblingSlotResonance({
    candidateClaimKey: normalized.claimKey,
    localLexicalTokens: buildEntryLocalLexicalTokens(entry),
    groundedSiblings: groundedFamilyReuseEntries.map((trustedEntry) => ({
      entryId: trustedEntry.id,
      claimKey: trustedEntry.claimKey,
    })),
  });
  const autoApplyClass = promotionSupport.autoApplyClass;
  const supportedProposal = lexicalAlignment.any && (templateSupport || stableSlotSupport || trustedExactReuse || trustedEntityFamilyReuse || localGrounding);
  const supportEvidence = [
    trustedExactReuse ? "trusted_exact_reuse" : null,
    trustedEntityFamilyReuse ? "trusted_entity_family_reuse" : null,
    tagGrounding ? "tag_grounding" : null,
    sourceContextGrounding ? "source_context_grounding" : null,
    lexicalAlignment.entity ? "entity_lexical_alignment" : null,
    lexicalAlignment.attribute ? "attribute_lexical_alignment" : null,
    lexicalAlignment.strongEntityAttribute ? "strong_entity_attribute_lexical_alignment" : null,
    templateSupport ? "template_support" : null,
    stableSlotSupport ? "stable_slot_support" : null,
    promotionSupport.relaxedStableSlotFamilyGate ? "single_grounded_family_sibling" : null,
  ].filter((value): value is string => value !== null);
  const rationaleFragments = [
    trustedExactReuse
      ? `trusted exact reuse from ${groundedExactReuseEntries.length} matching entr${groundedExactReuseEntries.length === 1 ? "y" : "ies"}`
      : null,
    trustedEntityFamilyReuse
      ? `trusted ${normalized.entity} family reuse from ${groundedFamilyReuseEntries.length} supporting entr${groundedFamilyReuseEntries.length === 1 ? "y" : "ies"}`
      : null,
    tagGrounding ? "overlapping tags with trusted corpus entries" : null,
    sourceContextGrounding ? "overlapping source_context with trusted corpus entries" : null,
    lexicalAlignment.strongEntityAttribute ? "strong entity and slot lexical alignment" : null,
    lexicalAlignment.attribute
      ? lexicalAlignment.strongEntityAttribute
        ? null
        : "clear lexical alignment to the proposed slot"
      : lexicalAlignment.entity
        ? "clear lexical alignment to the proposed entity"
        : null,
    templateSupport ? "a conservative policy/default/source-of-truth template match" : null,
    stableSlotSupport ? "a stable compact slot head in a well-established entity family" : null,
    promotionSupport.relaxedStableSlotFamilyGate ? "one grounded family sibling cleared the stable-slot family gate" : null,
  ].filter((value): value is string => value !== null);

  return {
    autoApplyClass,
    supportedProposal,
    trustedExactReuse,
    trustedEntityFamilyReuse,
    tagGrounding,
    sourceContextGrounding,
    localGrounding,
    entityLexicalAlignment: lexicalAlignment.entity,
    attributeLexicalAlignment: lexicalAlignment.attribute,
    strongEntityAttributeLexicalAlignment: lexicalAlignment.strongEntityAttribute,
    lexicalAlignment: lexicalAlignment.any,
    templateSupport,
    stableSlotSupport,
    familyReuseCount: familyReuseEntries.length,
    groundedFamilyReuseCount: groundedFamilyReuseEntries.length,
    relaxedStableSlotFamilyGate: promotionSupport.relaxedStableSlotFamilyGate,
    supportingEntryIds: normalizeStringArray([
      ...groundedExactReuseEntries.map((candidate) => candidate.id),
      ...groundedFamilyReuseEntries.map((candidate) => candidate.id),
    ]),
    siblingSlotResonance,
    supportEvidence,
    rationaleFragments,
  };
}

function createEmptyMissingBackfillSupportEvaluation(): MissingBackfillSupportEvaluation {
  return {
    autoApplyClass: null,
    supportedProposal: false,
    trustedExactReuse: false,
    trustedEntityFamilyReuse: false,
    tagGrounding: false,
    sourceContextGrounding: false,
    localGrounding: false,
    entityLexicalAlignment: false,
    attributeLexicalAlignment: false,
    strongEntityAttributeLexicalAlignment: false,
    lexicalAlignment: false,
    templateSupport: false,
    stableSlotSupport: false,
    familyReuseCount: 0,
    groundedFamilyReuseCount: 0,
    relaxedStableSlotFamilyGate: false,
    supportingEntryIds: [],
    siblingSlotResonance: createEmptySiblingSlotResonanceEvaluation(0),
    supportEvidence: [],
    rationaleFragments: [],
  };
}

function resolveMissingBackfillPromotionSupport(input: {
  exactReuseCount: number;
  familyReuseCount: number;
  groundedFamilyReuseCount: number;
  localGrounding: boolean;
  templateSupport: boolean;
  stableSlotSupport: boolean;
  lexicalAlignment: MissingBackfillLexicalAlignment;
}): {
  autoApplyClass: MissingBackfillPromotionClass | null;
  relaxedStableSlotFamilyGate: boolean;
} {
  if (input.exactReuseCount > 0 && (input.lexicalAlignment.attribute || input.templateSupport)) {
    return {
      autoApplyClass: "trusted_exact_reuse_grounded",
      relaxedStableSlotFamilyGate: false,
    };
  }

  if (input.templateSupport && input.localGrounding && input.familyReuseCount > 0 && (input.lexicalAlignment.attribute || input.lexicalAlignment.entity)) {
    return {
      autoApplyClass: "trusted_family_template_grounded",
      relaxedStableSlotFamilyGate: false,
    };
  }

  const relaxedStableSlotFamilyGate =
    input.stableSlotSupport &&
    input.localGrounding &&
    input.groundedFamilyReuseCount > 0 &&
    input.familyReuseCount === 1 &&
    input.lexicalAlignment.strongEntityAttribute;
  if (
    input.stableSlotSupport &&
    input.localGrounding &&
    input.groundedFamilyReuseCount > 0 &&
    (input.familyReuseCount >= 2 || relaxedStableSlotFamilyGate) &&
    input.lexicalAlignment.attribute
  ) {
    return {
      autoApplyClass: "trusted_family_stable_slot",
      relaxedStableSlotFamilyGate,
    };
  }

  if (input.localGrounding && input.groundedFamilyReuseCount > 0 && input.lexicalAlignment.strongEntityAttribute) {
    return {
      autoApplyClass: "trusted_family_grounded_alignment",
      relaxedStableSlotFamilyGate: false,
    };
  }

  return {
    autoApplyClass: null,
    relaxedStableSlotFamilyGate: false,
  };
}

function inspectGroundingOverlap(
  entryTagSet: Set<string>,
  entrySourceTokens: Set<string>,
  trustedEntry: TrustedCleanupHintEntry,
): { tagGrounding: boolean; sourceContextGrounding: boolean } {
  return {
    tagGrounding: countSetOverlap(entryTagSet, trustedEntry.tags) > 0,
    sourceContextGrounding: countSetOverlap(entrySourceTokens, trustedEntry.sourceContextTokens) > 0,
  };
}

function inspectCandidateLexicalAlignment(entry: Entry, entity: string, attribute: string): MissingBackfillLexicalAlignment {
  const lexicalTokens = new Set([
    ...tokenizeGroundingText(entry.subject),
    ...tokenizeGroundingText(entry.content),
    ...tokenizeGroundingText(entry.source_context),
    ...normalizeGroundingTags(entry.tags),
  ]);
  const entityTokens = entity.split("_").filter((token) => token.length > 0);
  const attributeTokens = attribute.split("_").filter((token) => token.length > 0 && !GROUNDING_STOP_TOKENS.has(token));

  const entityOverlapCount = countSetOverlap(lexicalTokens, entityTokens);
  const attributeOverlapCount = countSetOverlap(lexicalTokens, attributeTokens);
  const entityAlignment = entityOverlapCount > 0;
  const attributeAlignment = attributeOverlapCount > 0;
  const strongAttributeAlignment = attributeTokens.length > 0 && attributeOverlapCount >= Math.min(attributeTokens.length, 2);

  return {
    entity: entityAlignment,
    attribute: attributeAlignment,
    any: entityAlignment || attributeAlignment,
    strongEntityAttribute: entityAlignment && strongAttributeAlignment,
    entityOverlapCount,
    attributeOverlapCount,
  };
}

function matchesConservativeTemplateSupport(entry: Entry, attribute: string): boolean {
  const attributeTokens = new Set(attribute.split("_").filter((token) => token.length > 0));
  const subjectText = entry.subject.toLowerCase();
  const contentText = entry.content.toLowerCase();
  const combinedText = `${subjectText}\n${contentText}`;
  const authoritativePattern = /\b(authoritative|source of truth|source of record|canonical guide|canonical reference|primary guide|runbook)\b/u.test(
    combinedText,
  );
  if (authoritativePattern && intersects(attributeTokens, AUTHORITATIVE_TEMPLATE_ATTRIBUTE_TOKENS)) {
    return true;
  }

  const policyPattern =
    /\b(should|must|should stay|must stay|always|never|default(?:s)? to|default(?:s)?|policy|guardrail|required|preference|prefers?)\b/u.test(combinedText);
  if (policyPattern && intersects(attributeTokens, POLICY_TEMPLATE_ATTRIBUTE_TOKENS)) {
    return true;
  }

  const architecturePattern = /\b(uses|supports|backed by|architecture|boundary|workflow|process|pipeline|adapter|layer|contract|interface|surface)\b/u.test(
    combinedText,
  );
  return architecturePattern && intersects(attributeTokens, ARCHITECTURE_TEMPLATE_ATTRIBUTE_TOKENS);
}

function matchesStableFamilySlotSupport(attribute: string): boolean {
  const tokens = attribute.split("_").filter((token) => token.length > 0);
  if (tokens.length === 0 || tokens.length > MAX_AUTO_APPLY_ATTRIBUTE_TOKENS) {
    return false;
  }

  const head = tokens[tokens.length - 1];
  return typeof head === "string" && STABLE_FAMILY_SLOT_ATTRIBUTE_HEADS.has(head);
}

function evaluateClaimKeyCompactness(
  claimKey: string,
  prior?: {
    priorCompactedFrom: string | null;
    priorCompactionReason: string | null;
  },
): ClaimKeyCompactnessEvaluation {
  const compacted = compactClaimKey(claimKey);
  if (!compacted) {
    return {
      claimKey,
      compactedFrom: null,
      compactionReason: null,
      compactEnoughForAutoApply: false,
      blockerReason: "invalid_claim_key",
    };
  }

  const attributeTokens = compacted.attribute.split("_").filter((token) => token.length > 0);
  const compactEnoughForAutoApply =
    attributeTokens.length > 0 &&
    attributeTokens.length <= MAX_AUTO_APPLY_ATTRIBUTE_TOKENS &&
    !attributeTokens.some((token) => AWKWARD_AUTO_APPLY_ATTRIBUTE_TOKENS.has(token));
  const compactedFrom = compacted.compactedFrom ?? prior?.priorCompactedFrom ?? null;
  const compactionReason =
    compacted.reason && prior?.priorCompactionReason
      ? `${prior.priorCompactionReason} and ${compacted.reason}`
      : (compacted.reason ?? prior?.priorCompactionReason ?? null);

  return {
    claimKey: compacted.claimKey,
    compactedFrom,
    compactionReason,
    compactEnoughForAutoApply,
    blockerReason: compactEnoughForAutoApply ? null : "non_compact_canonical_slot",
  };
}

function resolveMissingBackfillNullOutcome(suggestionRecord: EntrySuggestionRecord): MissingBackfillSkipDiagnostic["outcome"] {
  if (suggestionRecord.previewOutcome?.outcome === "no_claim") {
    return "no_claim";
  }

  if (suggestionRecord.previewOutcome?.outcome === "rejected_candidate") {
    return "rejected_candidate";
  }

  if (suggestionRecord.warnings.some((warning) => /json|unexpected token|unterminated|position \d+/iu.test(warning))) {
    return "malformed_output";
  }

  return "rejected_candidate";
}

function buildMissingBackfillSkipDiagnostic(
  entry: Entry,
  suggestionRecord: EntrySuggestionRecord,
  options: {
    outcomeOverride: MissingBackfillSkipDiagnostic["outcome"];
    suggestedClaimKey?: string;
  },
): MissingBackfillSkipDiagnostic {
  const previewPath = suggestionRecord.suggestion?.path ?? suggestionRecord.previewOutcome?.path ?? null;
  const previewConfidence =
    suggestionRecord.suggestion?.confidence ??
    (typeof suggestionRecord.previewOutcome?.confidence === "number" ? suggestionRecord.previewOutcome.confidence : null);

  return {
    entryId: entry.id,
    outcome: options.outcomeOverride,
    confidence: previewConfidence,
    path: previewPath,
    warning: suggestionRecord.warnings[0] ?? null,
    suggestedClaimKey: options.suggestedClaimKey ?? suggestionRecord.suggestion?.claimKey ?? null,
  };
}

function formatMissingBackfillSkipDiagnostic(diagnostic: MissingBackfillSkipDiagnostic): string {
  const parts = [
    `missing_claim_key:${diagnostic.outcome}`,
    diagnostic.path ? `path=${diagnostic.path}` : null,
    typeof diagnostic.confidence === "number" ? `confidence=${diagnostic.confidence.toFixed(2)}` : null,
    diagnostic.suggestedClaimKey ? `suggested=${diagnostic.suggestedClaimKey}` : null,
    diagnostic.warning ? `warning=${diagnostic.warning}` : null,
  ].filter((value): value is string => value !== null);

  return parts.join(" ");
}

function normalizeGroundingTags(tags: string[]): string[] {
  return normalizeStringArray(tags.map((tag) => normalizeClaimKeySegment(tag)).filter((tag) => tag.length > 0));
}

function buildEntryLocalLexicalTokens(entry: Entry): string[] {
  return normalizeStringArray([
    ...tokenizeGroundingText(entry.subject),
    ...tokenizeGroundingText(entry.content),
    ...tokenizeGroundingText(entry.source_context),
    ...normalizeGroundingTags(entry.tags),
  ]);
}

function tokenizeGroundingText(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return normalizeStringArray(
    value
      .split(/[^a-zA-Z0-9]+/u)
      .map((token) => normalizeClaimKeySegment(token))
      .filter((token) => token.length > 2 && !GROUNDING_STOP_TOKENS.has(token)),
  );
}

function countSetOverlap(left: Set<string>, right: Iterable<string>): number {
  let count = 0;
  for (const value of right) {
    if (left.has(value)) {
      count += 1;
    }
  }

  return count;
}

function intersects(left: Set<string>, right: Set<string>): boolean {
  for (const value of left) {
    if (right.has(value)) {
      return true;
    }
  }

  return false;
}

async function buildMalformedClaimKeyProposal(
  entry: Entry,
  inspection: { kind: "malformed"; inspection: ClaimKeyInspection },
  deps: {
    getSuggestion(): Promise<EntrySuggestionRecord>;
    now(): Date;
    runId: string;
  },
): Promise<{ proposal: SurgeonRunProposal; proposalLifecycle: ProposalClaimKeyLifecycleMetadata }> {
  const suggestionRecord = await deps.getSuggestion();
  const proposedClaimKeys = suggestionRecord.suggestion?.claimKey ? [suggestionRecord.suggestion.claimKey] : [];
  const proposalLifecycle = buildProposalClaimKeyLifecycle({
    proposedClaimKeys,
    source: suggestionRecord.suggestion?.path ?? "normalize",
    rawClaimKey: entry.claim_key ?? null,
  });
  const proposal = createProposal({
    runId: deps.runId,
    groupId: `claim-key-malformed:${entry.id}`,
    issueKind: "malformed_claim_key",
    scope: "single_entry",
    entryIds: [entry.id],
    currentClaimKeys: entry.claim_key ? [entry.claim_key] : [],
    proposedClaimKeys,
    rationale: buildProposalLifecycleRationale(
      `Stored claim key "${entry.claim_key}" is malformed because ${describeClaimKeyNormalizationFailure(inspection.inspection.normalizationFailure ?? "missing_separator")}.` +
        (suggestionRecord.suggestion?.claimKey
          ? ` Claim extraction preview suggested "${suggestionRecord.suggestion.claimKey}" at confidence ${suggestionRecord.suggestion.confidence.toFixed(2)}.`
          : ""),
      proposalLifecycle,
    ),
    confidence: suggestionRecord.suggestion?.confidence ?? 0.5,
    source: suggestionRecord.suggestion?.path ?? "normalize",
    eligibleForApply: proposedClaimKeys.length > 0,
    createdAt: deps.now().toISOString(),
  });

  return { proposal, proposalLifecycle };
}

function resolveMetadataBackfillClaimKey(entry: Entry, claimKey: string): string | null {
  return resolveExplicitMetadataRepair(entry, inspectClaimKey(claimKey));
}

function resolveMissingBackfillPromotionPolicy(input: {
  previewPath: ClaimExtractionResult["path"];
  metadataRepaired: boolean;
  support: MissingBackfillSupportEvaluation;
  compactness: ClaimKeyCompactnessEvaluation;
}): MissingBackfillPromotionPolicy {
  if (input.metadataRepaired) {
    return {
      lane: "metadata_rewrite",
      autoApplyThreshold: STRUCTURED_AUTO_APPLY_BACKFILL_THRESHOLD,
    };
  }

  if (input.previewPath === "deterministic_repair") {
    return {
      lane: "deterministic_repair",
      autoApplyThreshold: STRUCTURED_AUTO_APPLY_BACKFILL_THRESHOLD,
    };
  }

  if (input.support.autoApplyClass !== null && input.compactness.compactedFrom) {
    return {
      lane: "compacted_supported",
      autoApplyThreshold: COMPACTED_SUPPORTED_AUTO_APPLY_BACKFILL_THRESHOLD,
    };
  }

  if (input.support.autoApplyClass !== null) {
    return {
      lane: "structured_supported",
      autoApplyThreshold: STRUCTURED_AUTO_APPLY_BACKFILL_THRESHOLD,
    };
  }

  return {
    lane: "high_confidence_preview",
    autoApplyThreshold: HIGH_CONFIDENCE_BACKFILL_THRESHOLD,
  };
}

function resolveMissingBackfillProposalThreshold(input: {
  previewPath: ClaimExtractionResult["path"];
  metadataRepaired: boolean;
  support: MissingBackfillSupportEvaluation;
}): number {
  if (input.metadataRepaired || input.previewPath === "deterministic_repair" || input.support.supportedProposal) {
    return SUPPORTED_PROPOSAL_CONFIDENCE_THRESHOLD;
  }

  return PROPOSAL_CONFIDENCE_THRESHOLD;
}

function buildMissingBackfillConflictRationale(input: {
  originalClaimKey: string;
  targetClaimKey: string;
  confidence: number;
  metadataBackfillClaimKey: string | null;
  compactness: ClaimKeyCompactnessEvaluation;
}): string {
  const compactnessSentence =
    input.compactness.compactedFrom && input.compactness.compactedFrom !== input.targetClaimKey
      ? ` The candidate was compacted from "${input.compactness.compactedFrom}" to "${input.targetClaimKey}" because ${input.compactness.compactionReason}.`
      : "";
  if (input.metadataBackfillClaimKey !== null && input.originalClaimKey !== input.targetClaimKey) {
    return (
      `Backfill preview suggested "${input.originalClaimKey}" at confidence ${input.confidence.toFixed(2)}, ` +
      `and explicit metadata safely grounds that candidate to "${input.targetClaimKey}".${compactnessSentence}`
    );
  }

  if (input.compactness.compactedFrom && input.compactness.compactedFrom !== input.targetClaimKey) {
    return (
      `Backfill preview suggested "${input.compactness.compactedFrom}" at confidence ${input.confidence.toFixed(2)}, ` +
      `and compact canonicalization safely shortened it to "${input.targetClaimKey}" because ${input.compactness.compactionReason}.`
    );
  }

  return `Backfill preview suggested "${input.targetClaimKey}" at confidence ${input.confidence.toFixed(2)}.`;
}

function buildMissingBackfillProposalRationale(input: {
  originalClaimKey: string;
  targetClaimKey: string;
  confidence: number;
  autoApplyThreshold: number;
  promotionLane: MissingBackfillPromotionLane;
  trusted: boolean;
  metadataBackfillClaimKey: string | null;
  compactness: ClaimKeyCompactnessEvaluation;
  support: MissingBackfillSupportEvaluation;
}): string {
  if (!input.trusted) {
    return `Backfill preview suggested "${input.targetClaimKey}" at confidence ${input.confidence.toFixed(2)}, but the proposed key is still structurally suspect.`;
  }

  if (!input.compactness.compactEnoughForAutoApply) {
    const compacted =
      input.compactness.compactedFrom && input.compactness.compactedFrom !== input.targetClaimKey
        ? ` after safely compacting "${input.compactness.compactedFrom}" to "${input.targetClaimKey}" because ${input.compactness.compactionReason}`
        : "";
    return (
      `Backfill preview suggested "${input.targetClaimKey}" at confidence ${input.confidence.toFixed(2)}${compacted}, ` +
      "but the resulting slot name is still too verbose or awkward to auto-apply safely."
    );
  }

  if (input.metadataBackfillClaimKey !== null && input.originalClaimKey !== input.targetClaimKey) {
    return (
      `Backfill preview suggested "${input.originalClaimKey}" at confidence ${input.confidence.toFixed(2)}, ` +
      `and explicit metadata resolves that candidate to likely canonical key "${input.targetClaimKey}", ` +
      `but that supported repair stays below the auto-apply threshold of ${input.autoApplyThreshold.toFixed(2)}.`
    );
  }

  if (input.support.autoApplyClass !== null) {
    const promotionLead =
      input.promotionLane === "compacted_supported"
        ? "Supported evidence remained strong after compact canonicalization"
        : `Supported evidence from ${describeMissingBackfillPromotionClass(input.support.autoApplyClass)} exists`;
    return (
      `Backfill preview suggested "${input.targetClaimKey}" at confidence ${input.confidence.toFixed(2)}. ` +
      `${promotionLead} via ${input.support.rationaleFragments.join(", ")}, ` +
      `but the candidate stays below the auto-apply threshold of ${input.autoApplyThreshold.toFixed(2)}.`
    );
  }

  if (input.support.rationaleFragments.length > 0) {
    return (
      `Backfill preview suggested "${input.targetClaimKey}" at confidence ${input.confidence.toFixed(2)}. ` +
      `Structural support exists from ${input.support.rationaleFragments.join(", ")}, ` +
      `but the candidate stays below the auto-apply threshold of ${input.autoApplyThreshold.toFixed(2)}.`
    );
  }

  return `Backfill preview suggested "${input.targetClaimKey}" at confidence ${input.confidence.toFixed(2)}, below the auto-apply threshold of ${input.autoApplyThreshold.toFixed(2)}.`;
}

function buildMissingBackfillApplyRationale(input: {
  originalClaimKey: string;
  targetClaimKey: string;
  confidence: number;
  promotionLane: MissingBackfillPromotionLane;
  source: string;
  metadataBackfillClaimKey: string | null;
  compactness: ClaimKeyCompactnessEvaluation;
  support: MissingBackfillSupportEvaluation;
}): string {
  if (input.metadataBackfillClaimKey !== null && input.originalClaimKey !== input.targetClaimKey) {
    return (
      `Metadata-grounded claim-key backfill rewrote preview candidate "${input.originalClaimKey}" to "${input.targetClaimKey}" ` +
      `at confidence ${input.confidence.toFixed(2)} from ${input.source}.` +
      (input.compactness.compactedFrom && input.compactness.compactedFrom !== input.targetClaimKey
        ? ` Compact canonicalization also shortened "${input.compactness.compactedFrom}" because ${input.compactness.compactionReason}.`
        : "")
    );
  }

  if (input.support.autoApplyClass !== null && input.confidence < HIGH_CONFIDENCE_BACKFILL_THRESHOLD) {
    const promotionPrefix = input.promotionLane === "compacted_supported" ? "Post-compaction supported claim-key backfill" : "Supported claim-key backfill";
    return (
      `${promotionPrefix} assigned "${input.targetClaimKey}" from ${input.source} at confidence ${input.confidence.toFixed(2)} ` +
      `through ${describeMissingBackfillPromotionClass(input.support.autoApplyClass)} using ${input.support.rationaleFragments.join(", ")}.` +
      (input.compactness.compactedFrom && input.compactness.compactedFrom !== input.targetClaimKey
        ? ` The candidate was compacted from "${input.compactness.compactedFrom}" because ${input.compactness.compactionReason}.`
        : "")
    );
  }

  return (
    `High-confidence claim-key backfill assigned "${input.targetClaimKey}" from ${input.source} at confidence ${input.confidence.toFixed(2)}.` +
    (input.compactness.compactedFrom && input.compactness.compactedFrom !== input.targetClaimKey
      ? ` The candidate was compacted from "${input.compactness.compactedFrom}" because ${input.compactness.compactionReason}.`
      : "")
  );
}

function describeMissingBackfillPromotionClass(promotionClass: MissingBackfillPromotionClass): string {
  switch (promotionClass) {
    case "trusted_exact_reuse_grounded":
      return "trusted exact-key reuse with local grounding";
    case "trusted_family_template_grounded":
      return "trusted family reuse plus grounded template support";
    case "trusted_family_stable_slot":
      return "trusted family reuse plus a stable compact slot";
    case "trusted_family_grounded_alignment":
      return "trusted family reuse plus grounded dual lexical alignment";
  }
}

function resolveMissingBackfillAutoApplyBlocker(input: {
  trusted: boolean;
  compactness: ClaimKeyCompactnessEvaluation;
  confidence: number;
  autoApplyThreshold: number;
}): string | null {
  if (!input.trusted) {
    return "structurally_suspect_claim_key";
  }

  if (!input.compactness.compactEnoughForAutoApply) {
    return input.compactness.blockerReason;
  }

  if (input.confidence < input.autoApplyThreshold) {
    return "below_auto_apply_threshold";
  }

  return null;
}

function resolveExplicitMetadataRepair(entry: Entry, inspection: ClaimKeyInspection): string | null {
  const normalized = inspection.normalized;
  if (!normalized) {
    return null;
  }

  const userEntity = normalizeMetadataEntity(entry.user_id);
  const projectEntity = normalizeMetadataEntity(entry.project);
  if (USER_METADATA_ENTITY_ALIASES.has(normalized.entity) && userEntity) {
    const candidate = `${userEntity}/${normalized.attribute}`;
    return isTrustedClaimKeyForCleanup(candidate) ? candidate : null;
  }

  if (PROJECT_METADATA_ENTITY_ALIASES.has(normalized.entity) && projectEntity) {
    const candidate = `${projectEntity}/${normalized.attribute}`;
    return isTrustedClaimKeyForCleanup(candidate) ? candidate : null;
  }

  return null;
}

function normalizeMetadataEntity(value: string | undefined): string | null {
  const normalized = value ? normalizeClaimKeySegment(value) : "";
  if (normalized.length === 0 || !/[a-z]/u.test(normalized)) {
    return null;
  }

  return normalized;
}

function createCircuitBreakerState(): ClaimKeyCircuitBreakerState {
  return {
    totalAutoMutations: 0,
    blockedCollisions: 0,
    appliedByClaimKey: new Map<string, number>(),
    appliedByEntity: new Map<string, number>(),
  };
}

function recordCollision(state: ClaimKeyCircuitBreakerState): void {
  state.blockedCollisions += 1;
}

function recordAppliedRepair(state: ClaimKeyCircuitBreakerState, claimKey: string): ClaimKeyCircuitBreakerTrip | null {
  state.totalAutoMutations += 1;
  state.appliedByClaimKey.set(claimKey, (state.appliedByClaimKey.get(claimKey) ?? 0) + 1);
  const entity = claimKey.split("/", 1)[0] ?? claimKey;
  state.appliedByEntity.set(entity, (state.appliedByEntity.get(entity) ?? 0) + 1);
  return evaluateCircuitBreaker(state);
}

function evaluateCircuitBreaker(state: ClaimKeyCircuitBreakerState): ClaimKeyCircuitBreakerTrip | null {
  const largestClaimKeyCluster = maxCounterValue(state.appliedByClaimKey);
  if (
    state.totalAutoMutations >= CLAIM_KEY_CONCENTRATION_THRESHOLD &&
    largestClaimKeyCluster >= CLAIM_KEY_CONCENTRATION_THRESHOLD &&
    largestClaimKeyCluster / state.totalAutoMutations >= CLAIM_KEY_CONCENTRATION_RATIO
  ) {
    const target = maxCounterKey(state.appliedByClaimKey) ?? "unknown";
    return {
      kind: "claim_key_concentration",
      message: `Claim-key-quality circuit breaker tripped: ${largestClaimKeyCluster}/${state.totalAutoMutations} auto-repairs converged onto "${target}".`,
    };
  }

  const largestEntityCluster = maxCounterValue(state.appliedByEntity);
  if (
    state.totalAutoMutations >= ENTITY_CONCENTRATION_THRESHOLD &&
    largestEntityCluster >= ENTITY_CONCENTRATION_THRESHOLD &&
    largestEntityCluster / state.totalAutoMutations >= ENTITY_CONCENTRATION_RATIO
  ) {
    const target = maxCounterKey(state.appliedByEntity) ?? "unknown";
    return {
      kind: "entity_prefix_concentration",
      message: `Claim-key-quality circuit breaker tripped: ${largestEntityCluster}/${state.totalAutoMutations} auto-repairs converged onto entity prefix "${target}".`,
    };
  }

  if (
    state.blockedCollisions >= COLLISION_SPIKE_THRESHOLD &&
    state.totalAutoMutations + state.blockedCollisions > 0 &&
    state.blockedCollisions / (state.totalAutoMutations + state.blockedCollisions) >= COLLISION_SPIKE_RATIO
  ) {
    return {
      kind: "collision_spike",
      message: `Claim-key-quality circuit breaker tripped: ${state.blockedCollisions} proposed repairs were blocked by collisions, suggesting non-convergent claim-key cleanup.`,
    };
  }

  return null;
}

function maxCounterValue(counter: Map<string, number>): number {
  let max = 0;
  for (const value of counter.values()) {
    max = Math.max(max, value);
  }

  return max;
}

function maxCounterKey(counter: Map<string, number>): string | null {
  let bestKey: string | null = null;
  let bestValue = -1;

  for (const [key, value] of counter.entries()) {
    if (value > bestValue) {
      bestKey = key;
      bestValue = value;
    }
  }

  return bestKey;
}

function findClaimKeyOccupants(entries: Entry[], claimKey: string, excludeEntryId: string): Entry[] {
  return entries.filter((entry) => entry.id !== excludeEntryId && entry.claim_key === claimKey);
}

function findActiveClaimKeyOccupants(entries: Entry[], claimKey: string, excludeEntryId: string): Entry[] {
  return entries.filter((entry) => entry.id !== excludeEntryId && entry.claim_key === claimKey && isEntryActive(entry));
}

function countExactKeyMultiActiveClusters(entries: Entry[]): number {
  const counts = new Map<string, number>();

  for (const entry of entries) {
    const claimKey = entry.claim_key?.trim();
    if (!claimKey) {
      continue;
    }

    counts.set(claimKey, (counts.get(claimKey) ?? 0) + 1);
  }

  return [...counts.values()].filter((count) => count >= 2).length;
}

function findMixedKeyGroups(
  entries: Entry[],
  coveredClaimKeys: ReadonlySet<string> = new Set<string>(),
): Array<{ groupKey: string; entries: Entry[]; proposedClaimKey: string | null }> {
  const groups = new Map<string, Entry[]>();

  for (const entry of entries) {
    const normalizedSubject = entry.subject.trim().toLowerCase();
    if (normalizedSubject.length === 0) {
      continue;
    }

    const groupKey = `${normalizedSubject}::${entry.type}`;
    const existing = groups.get(groupKey);
    if (existing) {
      existing.push(entry);
      continue;
    }

    groups.set(groupKey, [entry]);
  }

  return [...groups.entries()]
    .flatMap(([groupKey, groupEntries]) => {
      if (groupEntries.length < 2) {
        return [];
      }

      const claimKeys = normalizeStringArray(groupEntries.flatMap((entry) => (entry.claim_key ? [entry.claim_key] : [])));
      const hasMissing = groupEntries.some((entry) => !entry.claim_key);
      const distinctClaimKeyCount = claimKeys.length;
      if (!hasMissing && distinctClaimKeyCount <= 1) {
        return [];
      }
      if (!hasMissing && distinctClaimKeyCount > 1 && claimKeys.every((claimKey) => coveredClaimKeys.has(claimKey))) {
        return [];
      }

      const trustedClaimKeys = claimKeys.filter((claimKey) => isTrustedClaimKeyForCleanup(claimKey));
      const proposedClaimKey = trustedClaimKeys.length === 1 ? (trustedClaimKeys[0] ?? null) : null;
      return [
        {
          groupKey,
          entries: groupEntries,
          proposedClaimKey,
        },
      ];
    })
    .sort((left, right) => left.groupKey.localeCompare(right.groupKey));
}

function buildMixedGroupRationale(group: { groupKey: string; entries: Entry[]; proposedClaimKey: string | null }): string {
  const currentClaimKeys = normalizeStringArray(group.entries.flatMap((entry) => (entry.claim_key ? [entry.claim_key] : [])));
  if (group.proposedClaimKey) {
    return (
      `Entries sharing subject/type group "${group.groupKey}" use mixed or missing claim keys. ` +
      `The only trusted canonical family already present is "${group.proposedClaimKey}", so it is the conservative proposed target for later adjudication. ` +
      `Current non-null keys: ${currentClaimKeys.join(", ") || "(none)"}.`
    );
  }

  return (
    `Entries sharing subject/type group "${group.groupKey}" use mixed or missing claim keys, but the group does not expose one uniquely trusted canonical target. ` +
    `Current non-null keys: ${currentClaimKeys.join(", ") || "(none)"}.`
  );
}

function buildEntityFamilyConvergenceObservation(stats: EntityFamilyConvergenceDecisionStats): string | null {
  if (stats.appliedClusters === 0 && stats.proposedClusters === 0) {
    return null;
  }

  return (
    `Entity-family convergence auto-applied ${stats.appliedEntries} entry rewrite${stats.appliedEntries === 1 ? "" : "s"} ` +
    `across ${stats.appliedClusters} family cluster${stats.appliedClusters === 1 ? "" : "s"} and staged ${stats.proposedClusters} ` +
    `unresolved family proposal${stats.proposedClusters === 1 ? "" : "s"}.`
  );
}

function buildEntityFamilyConvergenceAudit(candidate: ClaimKeyEntityFamilyCandidate): EntityFamilyConvergenceAudit {
  return {
    competingEntityPrefixes: [...candidate.entityPrefixes],
    canonicalEntityPrefix: candidate.canonicalEntityPrefix,
    canonicalSelectionReasons: [...candidate.canonicalSelectionReasons],
    unresolvedReason: candidate.unresolvedReason,
    evidence: flattenEntityFamilyEvidence(candidate.pairSupport),
    pairSupport: candidate.pairSupport.map((support) => ({
      entityPrefixes: [...support.entityPrefixes] as [string, string],
      supportingEntryIds: [...support.supportingEntryIds],
      sharedAttributes: [...support.sharedAttributes],
      confidence: support.confidence,
      autoSafe: support.autoSafe,
      preferredCanonicalEntityPrefix: support.preferredCanonicalEntityPrefix,
      evidence: support.evidence.map((evidence) => ({ ...evidence })),
    })),
  };
}

function flattenEntityFamilyEvidence(pairSupport: ClaimKeyEntityFamilyPairSupport[]): ClaimKeyEntityFamilyEvidence[] {
  const evidenceByKey = new Map<string, ClaimKeyEntityFamilyEvidence>();

  for (const support of pairSupport) {
    for (const evidence of support.evidence) {
      const evidenceKey = `${evidence.kind}:${evidence.detail}`;
      if (!evidenceByKey.has(evidenceKey)) {
        evidenceByKey.set(evidenceKey, { ...evidence });
      }
    }
  }

  return [...evidenceByKey.values()];
}

function mapEntityFamilyClaimKeys(claimKeys: string[], entityPrefixes: string[], canonicalEntityPrefix: string): string[] {
  const entityPrefixSet = new Set(entityPrefixes);
  return normalizeStringArray(
    claimKeys.flatMap((claimKey) => {
      const inspection = inspectClaimKey(claimKey);
      if (!inspection.normalized || !entityPrefixSet.has(inspection.normalized.entity) || inspection.normalized.entity === canonicalEntityPrefix) {
        return [];
      }

      return [`${canonicalEntityPrefix}/${inspection.normalized.attribute}`];
    }),
  );
}

function buildEntityFamilyConvergenceRationale(candidate: ClaimKeyEntityFamilyCandidate): string {
  const evidenceText = flattenEntityFamilyEvidence(candidate.pairSupport)
    .map((evidence) => evidence.detail)
    .join(" ");
  const canonicalText = candidate.canonicalEntityPrefix
    ? ` Canonical entity prefix candidate: "${candidate.canonicalEntityPrefix}".`
    : " No single canonical entity prefix is safe to choose automatically.";
  const reasonText = candidate.unresolvedReason ? ` ${candidate.unresolvedReason}` : "";
  const selectionText =
    candidate.canonicalSelectionReasons.length > 0 ? ` Canonical selection signals: ${candidate.canonicalSelectionReasons.join(", ")}.` : "";

  return (
    `Claim-key entity families ${candidate.entityPrefixes.join(", ")} show repeated same-slot overlap and grounding support. ` +
    evidenceText +
    canonicalText +
    selectionText +
    reasonText
  ).trim();
}

function buildSuspectProposalRationale(
  entry: Entry,
  inspection: ClaimKeyInspection,
  metadataRepair: string | null,
  suggestion: ClaimExtractionResult | null,
): string {
  const suspectReason = describeSuspicionList(inspection);
  const replacementHint =
    metadataRepair !== null
      ? ` Explicit metadata suggests "${metadataRepair}".`
      : suggestion?.claimKey
        ? ` Claim extraction preview suggested "${suggestion.claimKey}" at confidence ${suggestion.confidence.toFixed(2)}.`
        : "";

  return `Claim key "${entry.claim_key}" is structurally canonical but suspect because ${suspectReason}.${replacementHint}`;
}

function describeSuspicionList(inspection: ClaimKeyInspection): string {
  if (!inspection.normalized || inspection.suspectReasons.length === 0) {
    return "it is low-trust";
  }

  return inspection.suspectReasons.map((reason) => describeClaimKeySuspicion(reason, inspection.normalized!)).join(", ");
}

function buildMissingDecisionObservation(stats: MissingBackfillDecisionStats): string | null {
  const autoAppliedParts = [
    stats.autoAppliedTrustedGroupReuse > 0 ? `${stats.autoAppliedTrustedGroupReuse} trusted-group reuses` : null,
    stats.autoAppliedMetadataRepair > 0 ? `${stats.autoAppliedMetadataRepair} metadata-grounded backfills` : null,
    stats.autoAppliedDeterministicRepair > 0 ? `${stats.autoAppliedDeterministicRepair} deterministic repairs` : null,
    stats.autoAppliedSupportedPreview > 0 ? `${stats.autoAppliedSupportedPreview} supported preview auto-applies` : null,
    stats.autoAppliedPreviewModel > 0 ? `${stats.autoAppliedPreviewModel} high-confidence preview suggestions` : null,
  ].filter((value): value is string => value !== null);
  const proposalParts = [
    stats.proposedTrustedGroupReuse > 0 ? `${stats.proposedTrustedGroupReuse} trusted-group reuse proposals` : null,
    stats.proposedSupportedCandidate > 0 ? `${stats.proposedSupportedCandidate} supported preview proposals` : null,
    stats.proposedPreviewCandidate > 0 ? `${stats.proposedPreviewCandidate} plain preview proposals` : null,
  ].filter((value): value is string => value !== null);
  if (autoAppliedParts.length === 0 && proposalParts.length === 0) {
    return null;
  }

  return `Missing-key decisions used ${autoAppliedParts.join(", ") || "no auto-applies"} and ${proposalParts.join(", ") || "no proposals"} after structural reuse checks.`;
}

function buildGroundedFamilyPromotionObservation(stats: MissingBackfillDecisionStats): string | null {
  const observations = [
    stats.autoAppliedGroundedFamilyPromotion > 0 || stats.proposedGroundedFamilyPromotion > 0
      ? `Grounded-family promotion auto-applied ${stats.autoAppliedGroundedFamilyPromotion} candidate${stats.autoAppliedGroundedFamilyPromotion === 1 ? "" : "s"} and staged ${stats.proposedGroundedFamilyPromotion} proposal${stats.proposedGroundedFamilyPromotion === 1 ? "" : "s"}.`
      : null,
    stats.autoAppliedRelaxedStableSlotPromotion > 0 || stats.proposedRelaxedStableSlotPromotion > 0
      ? `Relaxed stable-slot promotion auto-applied ${stats.autoAppliedRelaxedStableSlotPromotion} candidate${stats.autoAppliedRelaxedStableSlotPromotion === 1 ? "" : "s"} and staged ${stats.proposedRelaxedStableSlotPromotion} proposal${stats.proposedRelaxedStableSlotPromotion === 1 ? "" : "s"} after accepting one grounded family sibling.`
      : null,
  ].filter((value): value is string => value !== null);

  if (observations.length === 0) {
    return null;
  }

  return observations.join(" ");
}

function buildSiblingSlotResonanceObservation(stats: SiblingSlotResonanceShadowStats): string | null {
  if (stats.thresholdOnlyCandidateCount === 0) {
    return null;
  }

  const bucketSummary = SHADOW_BUCKET_ORDER.map((bucket) => {
    const bucketStats = stats.buckets.get(bucket);
    const label = describeShadowBucket(bucket);
    return `${label} ${bucketStats?.resonanceFiredCount ?? 0}/${bucketStats?.candidateCount ?? 0}`;
  }).join(", ");

  return (
    `Shadow sibling-slot resonance fired for ${stats.resonanceFiredCount}/${stats.thresholdOnlyCandidateCount} threshold-only candidates ` +
    `(${bucketSummary}).`
  );
}

function buildSiblingSlotResonanceShadowRuleObservation(stats: SiblingSlotResonanceShadowStats): string | null {
  if (stats.thresholdOnlyCandidateCount === 0) {
    return null;
  }

  if (stats.shadowQualifiedCount === 0) {
    return (
      "Shadow sibling-slot-resonance rule would have qualified 0 candidates " +
      `under grounded-family counts >= ${SHADOW_RESONANCE_MIN_FAMILY_REUSE_COUNT}, grounded ratio >= ${SHADOW_RESONANCE_MIN_GROUNDED_RATIO.toFixed(2)}, ` +
      `confidence >= ${SHADOW_RESONANCE_MIN_CONFIDENCE.toFixed(2)}, and sibling-slot resonance.`
    );
  }

  return (
    `Shadow sibling-slot-resonance rule would have qualified ${stats.shadowQualifiedCount} candidate` +
    `${stats.shadowQualifiedCount === 1 ? "" : "s"}: ${stats.shadowQualifiedClaimKeys.join(", ")}.`
  );
}

function buildMissingCompactionObservation(stats: MissingBackfillDecisionStats): string | null {
  if (stats.autoAppliedCompactedCandidate === 0 && stats.proposedCompactedCandidate === 0) {
    return null;
  }

  return (
    `Compact canonicalization rewrote ${stats.autoAppliedCompactedCandidate} missing-key candidate` +
    `${stats.autoAppliedCompactedCandidate === 1 ? "" : "s"} before auto-apply and ${stats.proposedCompactedCandidate} ` +
    `before unresolved proposal logging.`
  );
}

function snapshotClaimKeyLifecycle(entry: Entry): {
  claimKey: Entry["claim_key"];
  claimKeyRaw: Entry["claim_key_raw"];
  claimKeyStatus: Entry["claim_key_status"];
  claimKeySource: Entry["claim_key_source"];
  claimKeyConfidence: Entry["claim_key_confidence"];
  claimKeyRationale: Entry["claim_key_rationale"];
} {
  return {
    claimKey: entry.claim_key,
    claimKeyRaw: entry.claim_key_raw,
    claimKeyStatus: entry.claim_key_status,
    claimKeySource: entry.claim_key_source,
    claimKeyConfidence: entry.claim_key_confidence,
    claimKeyRationale: entry.claim_key_rationale,
  };
}

function buildAppliedClaimKeyLifecycle(input: {
  targetClaimKey: string;
  priorClaimKey: string | null;
  priorClaimKeyRaw?: string;
  rawClaimKey?: string | null;
  source: string;
  support?: MissingBackfillSupportEvaluation;
  compactness?: ClaimKeyCompactnessEvaluation;
}): AppliedClaimKeyLifecycleMetadata {
  const source = resolveLifecycleClaimKeySource({
    proposedClaimKeys: [input.targetClaimKey],
    source: input.source,
    compactness: input.compactness,
  });

  return {
    rawClaimKey: resolveLifecycleRawClaimKey({
      targetClaimKey: input.targetClaimKey,
      priorClaimKeyRaw: input.priorClaimKeyRaw,
      rawClaimKey: input.rawClaimKey,
      priorClaimKey: input.priorClaimKey,
    }),
    status: resolveLifecycleClaimKeyStatus({
      proposedClaimKeys: [input.targetClaimKey],
      source: input.source,
      support: input.support,
      compactness: input.compactness,
    }),
    source: source ?? "surgeon_compaction",
  };
}

function buildProposalClaimKeyLifecycle(input: {
  proposedClaimKeys: string[];
  source: string;
  rawClaimKey?: string | null;
  support?: MissingBackfillSupportEvaluation;
  compactness?: ClaimKeyCompactnessEvaluation;
}): ProposalClaimKeyLifecycleMetadata {
  const proposedClaimKeys = normalizeStringArray(input.proposedClaimKeys);
  const targetClaimKey = proposedClaimKeys[0];
  if (!targetClaimKey) {
    return {
      deferredUntilReview: true,
      proposedStatus: "unresolved",
    };
  }

  return {
    deferredUntilReview: true,
    proposedStatus: resolveLifecycleClaimKeyStatus({
      proposedClaimKeys,
      source: input.source,
      support: input.support,
      compactness: input.compactness,
    }),
    proposedSource: resolveLifecycleClaimKeySource({
      proposedClaimKeys,
      source: input.source,
      compactness: input.compactness,
    }),
    proposedRawClaimKey: resolveLifecycleRawClaimKey({
      targetClaimKey,
      rawClaimKey: input.rawClaimKey,
    }),
  };
}

function buildProposalLifecycleRationale(baseRationale: string, lifecycle: ProposalClaimKeyLifecycleMetadata): string {
  const normalizedBase = baseRationale.trim();
  if (lifecycle.proposedStatus === "unresolved" || !lifecycle.proposedSource) {
    return `${normalizedBase} The entry stays unchanged until review because no safe lifecycle write is ready yet.`;
  }

  const rawText = lifecycle.proposedRawClaimKey ? ` and claim_key_raw "${lifecycle.proposedRawClaimKey}"` : "";
  return (
    `${normalizedBase} The entry stays unchanged until review. ` +
    `If approved, the replacement would persist claim_key_status "${lifecycle.proposedStatus}" ` +
    `with claim_key_source "${lifecycle.proposedSource}"${rawText}.`
  );
}

function resolveLifecycleClaimKeySource(input: {
  proposedClaimKeys: string[];
  source: string;
  compactness?: ClaimKeyCompactnessEvaluation;
}): Entry["claim_key_source"] {
  if (normalizeStringArray(input.proposedClaimKeys).length === 0) {
    return undefined;
  }

  if (input.source === "metadata_backfill_rewrite" || input.source === "metadata_rewrite") {
    return "surgeon_metadata_rewrite";
  }

  if (
    input.source === "trusted_group_reuse" ||
    input.source === "mixed_group_consensus" ||
    input.source === "entity_family_auto_convergence" ||
    input.source === "entity_family_canonical_candidate" ||
    input.source === "entity_family_collision"
  ) {
    return "surgeon_family_reuse";
  }

  if (input.source === "normalize" || input.compactness?.compactedFrom) {
    return "surgeon_compaction";
  }

  if (input.source === "model" || input.source === "json_retry" || input.source === "deterministic_repair") {
    return input.source;
  }

  return undefined;
}

function resolveLifecycleClaimKeyStatus(input: {
  proposedClaimKeys: string[];
  source: string;
  support?: MissingBackfillSupportEvaluation;
  compactness?: ClaimKeyCompactnessEvaluation;
}): NonNullable<Entry["claim_key_status"]> {
  if (normalizeStringArray(input.proposedClaimKeys).length === 0) {
    return "unresolved";
  }

  const lifecycleSource = resolveLifecycleClaimKeySource(input);
  if (lifecycleSource === "deterministic_repair" && input.support?.autoApplyClass === null) {
    return "tentative";
  }

  return "trusted";
}

function resolveLifecycleRawClaimKey(input: {
  targetClaimKey: string;
  priorClaimKeyRaw?: string;
  rawClaimKey?: string | null;
  priorClaimKey?: string | null;
}): string | undefined {
  const candidates = [input.priorClaimKeyRaw, input.rawClaimKey ?? undefined, input.priorClaimKey ?? undefined];
  for (const candidate of candidates) {
    const normalized = normalizeOptionalString(candidate ?? undefined);
    if (normalized && normalized !== input.targetClaimKey) {
      return normalized;
    }
  }

  return undefined;
}

function createProposal(input: Omit<SurgeonRunProposal, "id">): SurgeonRunProposal {
  return {
    id: randomUUID(),
    ...input,
    entryIds: normalizeStringArray(input.entryIds),
    currentClaimKeys: normalizeStringArray(input.currentClaimKeys),
    proposedClaimKeys: normalizeStringArray(input.proposedClaimKeys),
  };
}

function buildMissingBackfillSupportAuditDetails(support?: MissingBackfillSupportEvaluation): Record<string, unknown> {
  if (!support?.supportedProposal) {
    return support?.autoApplyClass
      ? {
          support_class: support.autoApplyClass,
        }
      : {};
  }

  return {
    support_evidence: [...support.supportEvidence],
    supporting_entry_ids: [...support.supportingEntryIds],
    support_family_reuse_count: support.familyReuseCount,
    support_grounded_family_reuse_count: support.groundedFamilyReuseCount,
    support_sibling_slot_resonance_applicable: support.siblingSlotResonance.applicable,
    support_sibling_slot_resonance_fired: support.siblingSlotResonance.fired,
    support_sibling_slot_resonance_resonant_sibling_count: support.siblingSlotResonance.resonantSiblingCount,
    support_sibling_slot_resonance_dominant_shape: support.siblingSlotResonance.dominantShape,
    support_sibling_slot_resonance_dominant_shape_count: support.siblingSlotResonance.dominantShapeCount,
    support_sibling_slot_resonance_grounded_share: support.siblingSlotResonance.dominantShapeGroundedShare,
    support_sibling_slot_resonance_local_shape_coverage: support.siblingSlotResonance.localShapeTokenCoverage,
    support_sibling_slot_resonance_family_generic_tokens: [...support.siblingSlotResonance.familyGenericTokens],
    support_sibling_slot_resonance_discriminative_candidate_tokens: [...support.siblingSlotResonance.discriminativeCandidateTokens],
    support_sibling_slot_resonance_sibling_entry_ids: [...support.siblingSlotResonance.dominantSiblingEntryIds],
    support_sibling_slot_resonance_sibling_claim_keys: [...support.siblingSlotResonance.dominantSiblingClaimKeys],
    ...(support.strongEntityAttributeLexicalAlignment
      ? {
          support_strong_entity_attribute_lexical_alignment: true,
        }
      : {}),
    ...(support.autoApplyClass
      ? {
          support_class: support.autoApplyClass,
        }
      : {}),
    ...(support.relaxedStableSlotFamilyGate
      ? {
          support_relaxed_stable_slot_family_gate: true,
        }
      : {}),
  };
}

function buildMissingBackfillShadowAuditDetails(shadow?: MissingBackfillShadowAudit): Record<string, unknown> {
  if (!shadow) {
    return {};
  }

  return {
    shadow_threshold_only_bucket: shadow.thresholdOnlyBucket,
    shadow_would_qualify: shadow.shadowWouldQualify,
  };
}

function recordGroundedFamilyPromotionDecision(
  stats: MissingBackfillDecisionStats,
  support: MissingBackfillSupportEvaluation,
  decision: "auto_apply" | "proposal",
): void {
  if (support.autoApplyClass === "trusted_family_grounded_alignment") {
    if (decision === "auto_apply") {
      stats.autoAppliedGroundedFamilyPromotion += 1;
    } else {
      stats.proposedGroundedFamilyPromotion += 1;
    }
  }

  if (support.relaxedStableSlotFamilyGate) {
    if (decision === "auto_apply") {
      stats.autoAppliedRelaxedStableSlotPromotion += 1;
    } else {
      stats.proposedRelaxedStableSlotPromotion += 1;
    }
  }
}

function buildSiblingSlotResonanceShadowSummary(stats: SiblingSlotResonanceShadowStats): ClaimKeyQualityPassSummary["shadowSiblingSlotResonance"] {
  if (stats.thresholdOnlyCandidateCount === 0) {
    return null;
  }

  const buckets: ClaimKeyQualityShadowBucketSummary[] = SHADOW_BUCKET_ORDER.map((bucket) => {
    const bucketStats = stats.buckets.get(bucket);
    return {
      bucket,
      candidateCount: bucketStats?.candidateCount ?? 0,
      resonanceApplicableCount: bucketStats?.resonanceApplicableCount ?? 0,
      resonanceFiredCount: bucketStats?.resonanceFiredCount ?? 0,
      shadowQualifiedCount: bucketStats?.shadowQualifiedCount ?? 0,
    };
  });

  return {
    rule: {
      supportClass: "trusted_family_grounded_alignment",
      minFamilyReuseCount: SHADOW_RESONANCE_MIN_FAMILY_REUSE_COUNT,
      minGroundedRatio: SHADOW_RESONANCE_MIN_GROUNDED_RATIO,
      minConfidence: SHADOW_RESONANCE_MIN_CONFIDENCE,
      requiresSiblingSlotResonance: true,
    },
    thresholdOnlyCandidateCount: stats.thresholdOnlyCandidateCount,
    resonanceApplicableCount: stats.resonanceApplicableCount,
    resonanceFiredCount: stats.resonanceFiredCount,
    shadowQualifiedCount: stats.shadowQualifiedCount,
    resonanceFiredClaimKeys: [...stats.resonanceFiredClaimKeys],
    shadowQualifiedClaimKeys: [...stats.shadowQualifiedClaimKeys],
    buckets,
  };
}

function resolveThresholdOnlyShadowBucket(support: MissingBackfillSupportEvaluation): ClaimKeyQualityShadowBucket | null {
  if (support.relaxedStableSlotFamilyGate) {
    return "relaxed_one_sibling_stable_slot";
  }

  if (support.autoApplyClass !== "trusted_family_grounded_alignment") {
    return null;
  }

  const groundedRatio = support.familyReuseCount > 0 ? support.groundedFamilyReuseCount / support.familyReuseCount : 0;
  if (support.familyReuseCount >= SHADOW_RESONANCE_MIN_FAMILY_REUSE_COUNT) {
    return groundedRatio >= SHADOW_RESONANCE_MIN_GROUNDED_RATIO ? "high_density_grounded_family" : "large_grounding_diluted_grounded_family";
  }

  if (support.familyReuseCount <= 5) {
    return "thin_grounded_family_tail";
  }

  return "other_grounded_family_alignment";
}

function buildMissingBackfillShadowAudit(input: {
  support: MissingBackfillSupportEvaluation;
  confidence: number;
  autoApplyBlocker: string | null;
}): MissingBackfillShadowAudit | null {
  if (input.autoApplyBlocker !== "below_auto_apply_threshold") {
    return null;
  }

  const bucket = resolveThresholdOnlyShadowBucket(input.support);
  if (!bucket) {
    return null;
  }

  const groundedRatio = input.support.familyReuseCount > 0 ? input.support.groundedFamilyReuseCount / input.support.familyReuseCount : 0;
  return {
    thresholdOnlyBucket: bucket,
    shadowWouldQualify:
      input.support.autoApplyClass === "trusted_family_grounded_alignment" &&
      input.support.familyReuseCount >= SHADOW_RESONANCE_MIN_FAMILY_REUSE_COUNT &&
      groundedRatio >= SHADOW_RESONANCE_MIN_GROUNDED_RATIO &&
      input.confidence >= SHADOW_RESONANCE_MIN_CONFIDENCE &&
      input.support.siblingSlotResonance.fired,
  };
}

function recordSiblingSlotResonanceShadowCandidate(
  stats: SiblingSlotResonanceShadowStats,
  claimKey: string,
  support: MissingBackfillSupportEvaluation,
  shadow: MissingBackfillShadowAudit,
): void {
  stats.thresholdOnlyCandidateCount += 1;
  if (support.siblingSlotResonance.applicable) {
    stats.resonanceApplicableCount += 1;
  }
  if (support.siblingSlotResonance.fired) {
    stats.resonanceFiredCount += 1;
    stats.resonanceFiredClaimKeys = normalizeStringArray([...stats.resonanceFiredClaimKeys, claimKey]);
  }
  if (shadow.shadowWouldQualify) {
    stats.shadowQualifiedCount += 1;
    stats.shadowQualifiedClaimKeys = normalizeStringArray([...stats.shadowQualifiedClaimKeys, claimKey]);
  }

  const bucketStats = stats.buckets.get(shadow.thresholdOnlyBucket);
  if (!bucketStats) {
    return;
  }

  bucketStats.candidateCount += 1;
  if (support.siblingSlotResonance.applicable) {
    bucketStats.resonanceApplicableCount += 1;
  }
  if (support.siblingSlotResonance.fired) {
    bucketStats.resonanceFiredCount += 1;
  }
  if (shadow.shadowWouldQualify) {
    bucketStats.shadowQualifiedCount += 1;
  }
}

function describeShadowBucket(bucket: ClaimKeyQualityShadowBucket): string {
  switch (bucket) {
    case "high_density_grounded_family":
      return "high-density grounded-family";
    case "large_grounding_diluted_grounded_family":
      return "large grounding-diluted grounded-family";
    case "thin_grounded_family_tail":
      return "thin grounded-family tail";
    case "relaxed_one_sibling_stable_slot":
      return "relaxed one-sibling stable-slot";
    case "other_grounded_family_alignment":
      return "other grounded-family alignment";
  }
}
