/* eslint-disable jsdoc/require-jsdoc */

import { randomUUID } from "node:crypto";

import { resolveClaimExtractionConfig, type AgenrConfig } from "../../config.js";
import {
  describeClaimKeyNormalizationFailure,
  describeClaimKeySuspicion,
  inspectClaimKey,
  isTrustedClaimKeyForCleanup,
  normalizeClaimKeySegment,
  type ClaimKeyInspection,
} from "../../core/claim-key.js";
import type { LlmPort } from "../../core/ports.js";
import type {
  ClaimKeyHealthSnapshot,
  ClaimKeyQualityPassSummary,
  ClaimKeyQualityRepairCounts,
  SurgeonCompletionSummary,
  SurgeonRunProposal,
  SurgeonRunStatus,
} from "../../core/surgeon/types.js";
import { previewClaimKeyExtraction, type ClaimExtractionHints, type ClaimExtractionResult } from "../../core/store/claim-extraction.js";
import type { Entry } from "../../core/types.js";
import { emitSurgeonProgress, type ClaimKeyQualityProgressStage, type SurgeonProgressReporter } from "./progress.js";
import type { SurgeonPort } from "./ports.js";

const HIGH_CONFIDENCE_BACKFILL_THRESHOLD = 0.92;
const PROPOSAL_CONFIDENCE_THRESHOLD = 0.75;
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
const USER_METADATA_ENTITY_ALIASES = new Set(["i", "me", "myself", "person", "the_user", "user"]);
const PROJECT_METADATA_ENTITY_ALIASES = new Set(["app", "application", "project", "the_project", "this_project", "workspace"]);

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
}

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
  const claimExtractionConfig = resolveClaimExtractionConfig(deps.config ?? undefined);
  const before = summarizeClaimKeyHealth(actualEntries, claimExtractionConfig.eligibleTypes);
  const circuitBreakerState = createCircuitBreakerState();
  const progressTracker = createClaimKeyQualityProgressTracker({
    apply: options.apply,
    verbose: options.verbose,
    totalEntries: before.totalEntries,
    counts,
    reportProgress: options.reportProgress,
  });
  let claimExtractionLlm: ReturnType<NonNullable<ClaimKeyQualityRunDeps["createClaimExtractionLlm"]>> | null = null;
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
      progressTracker.startStage("missing", missingEntries.length, "entries");
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
      progressTracker.startStage("suspect_canonical", suspectEntries.length, "entries");
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
      const mixedKeyGroups = findMixedKeyGroups(projectedEntries);
      progressTracker.startStage("mixed_key_groups", mixedKeyGroups.length, "groups");
      for (const group of mixedKeyGroups) {
        if (options.signal?.aborted === true) {
          terminalStatus = "aborted";
          terminalError = "Run aborted by user (SIGINT).";
          break;
        }

        const proposal = createProposal({
          runId: options.runId,
          groupId: `claim-key-mixed:${group.groupKey}`,
          issueKind: "mixed_claim_key_group",
          scope: "cluster",
          entryIds: group.entries.map((entry) => entry.id),
          currentClaimKeys: normalizeStringArray(group.entries.flatMap((entry) => (entry.claim_key ? [entry.claim_key] : []))),
          proposedClaimKeys: group.proposedClaimKey ? [group.proposedClaimKey] : [],
          rationale: buildMixedGroupRationale(group),
          confidence: group.proposedClaimKey ? 0.8 : 0.55,
          source: group.proposedClaimKey ? "mixed_group_consensus" : "mixed_group",
          eligibleForApply: group.proposedClaimKey !== null,
          createdAt: options.now().toISOString(),
        });
        await persistProposal(proposal);
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
    `Identified ${counts.identifiedNormalizations} normalizations, ${counts.identifiedBackfills} backfills, and ${counts.identifiedMetadataRewrites} metadata-backed suspect-key rewrites.`,
    `Emitted ${counts.proposalsEmitted} unresolved proposal${counts.proposalsEmitted === 1 ? "" : "s"}.`,
  );
  if (counts.skippedNoClaim > 0 || counts.skippedLowConfidence > 0 || counts.skippedCollision > 0 || counts.skippedAmbiguous > 0) {
    observations.push(
      `Skipped ${counts.skippedNoClaim} no-claim cases, ${counts.skippedLowConfidence} low-confidence cases, ` +
        `${counts.skippedCollision} collision cases, and ${counts.skippedAmbiguous} ambiguous cases.`,
    );
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
    circuitBreaker,
  };
  const completion: SurgeonCompletionSummary = {
    actions_taken: actionsTaken,
    entries_skipped: [],
    observations,
    recommendations,
    claim_key_quality: passSummary,
  };

  return {
    status: terminalStatus,
    error: terminalError,
    completion,
    entriesRetired: 0,
    usage: claimExtractionUsage(claimExtractionLlm),
  };

  async function processInvalidOrNoncanonicalEntry(entry: Entry): Promise<void> {
    const inspection = inspectExistingClaimKey(entry);
    if (inspection.kind !== "malformed" && inspection.kind !== "noncanonical") {
      return;
    }

    if (inspection.kind === "malformed") {
      const proposal = await buildMalformedClaimKeyProposal(entry, inspection, {
        getSuggestion: async () => loadSuggestion(entry),
        now: options.now,
        runId: options.runId,
      });
      await persistProposal(proposal);
      counts.proposalsEmitted += 1;
      counts.skippedAmbiguous += 1;
      return;
    }

    const targetClaimKey = inspection.normalized.claimKey;
    const collision = findClaimKeyOccupants(projectedEntries, targetClaimKey, entry.id);
    if (collision.length > 0) {
      counts.skippedCollision += 1;
      recordCollision(circuitBreakerState);
      const proposal = createProposal({
        runId: options.runId,
        groupId: `claim-key-normalize:${entry.id}`,
        issueKind: "noncanonical_claim_key",
        scope: "single_entry",
        entryIds: [entry.id],
        currentClaimKeys: [entry.claim_key ?? ""],
        proposedClaimKeys: [targetClaimKey],
        rationale:
          `Canonical normalization would change "${entry.claim_key}" to "${targetClaimKey}", ` +
          `but that canonical key is already occupied by ${collision.length} other matched entr${collision.length === 1 ? "y" : "ies"}.`,
        confidence: 0.99,
        source: "normalize",
        eligibleForApply: true,
        createdAt: options.now().toISOString(),
      });
      await persistProposal(proposal);
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

    const suggestionRecord = await loadSuggestion(entry);
    if (terminalStatus !== "completed") {
      return;
    }

    const suggestion = suggestionRecord.suggestion;
    if (!suggestion?.claimKey) {
      counts.skippedNoClaim += 1;
      return;
    }

    const suggestedInspection = inspectClaimKey(suggestion.claimKey);
    const suggestionIsTrusted = suggestedInspection.suspectReasons.length === 0;
    const activeSiblings = findActiveClaimKeyOccupants(projectedEntries, suggestion.claimKey, entry.id);
    if (activeSiblings.some((sibling) => sibling.type !== entry.type)) {
      const proposal = createProposal({
        runId: options.runId,
        groupId: `claim-key-backfill:${entry.id}`,
        issueKind: "missing_claim_key",
        scope: "single_entry",
        entryIds: [entry.id, ...activeSiblings.map((sibling) => sibling.id)],
        currentClaimKeys: [],
        proposedClaimKeys: [suggestion.claimKey],
        rationale:
          `Backfill preview suggested "${suggestion.claimKey}" at confidence ${suggestion.confidence.toFixed(2)}, ` +
          "but the same slot key is already used by a different entry type in the matched working set.",
        confidence: suggestion.confidence,
        source: suggestion.path,
        eligibleForApply: true,
        createdAt: options.now().toISOString(),
      });
      await persistProposal(proposal);
      counts.proposalsEmitted += 1;
      counts.skippedAmbiguous += 1;
      return;
    }

    if (!suggestionIsTrusted || suggestion.confidence < HIGH_CONFIDENCE_BACKFILL_THRESHOLD) {
      if (suggestion.confidence >= PROPOSAL_CONFIDENCE_THRESHOLD) {
        const proposal = createProposal({
          runId: options.runId,
          groupId: `claim-key-backfill:${entry.id}`,
          issueKind: "missing_claim_key",
          scope: "single_entry",
          entryIds: [entry.id],
          currentClaimKeys: [],
          proposedClaimKeys: [suggestion.claimKey],
          rationale: !suggestionIsTrusted
            ? `Backfill preview suggested "${suggestion.claimKey}" at confidence ${suggestion.confidence.toFixed(2)}, but the proposed key is still structurally suspect.`
            : `Backfill preview suggested "${suggestion.claimKey}" at confidence ${suggestion.confidence.toFixed(2)}, below the auto-apply threshold.`,
          confidence: suggestion.confidence,
          source: suggestion.path,
          eligibleForApply: true,
          createdAt: options.now().toISOString(),
        });
        await persistProposal(proposal);
        counts.proposalsEmitted += 1;
        counts.skippedAmbiguous += 1;
      } else {
        counts.skippedLowConfidence += 1;
      }
      return;
    }

    counts.identifiedBackfills += 1;
    const updateResult = await maybeApplyClaimKeyUpdate(entry.id, suggestion.claimKey, {
      actualEntriesById,
      entriesById,
      issueKind: "missing_claim_key",
      oldClaimKey: null,
      source: suggestion.path,
      confidence: suggestion.confidence,
      rationale: `High-confidence claim-key backfill assigned "${suggestion.claimKey}" from ${suggestion.path}.`,
    });
    if (updateResult.applied) {
      counts.appliedBackfills += 1;
    }
    if (updateResult.projected) {
      circuitBreaker = recordAppliedRepair(circuitBreakerState, suggestion.claimKey);
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

    const suggestionRecord = claimExtractionConfig.eligibleTypes.includes(entry.type) ? await loadSuggestion(entry) : { suggestion: null, warnings: [] };
    if (terminalStatus !== "completed") {
      return;
    }

    const proposedClaimKeys = [
      metadataRepair,
      suggestionRecord.suggestion?.claimKey && suggestionRecord.suggestion.claimKey !== entry.claim_key ? suggestionRecord.suggestion.claimKey : null,
    ].filter((value): value is string => value !== null);
    const proposal = createProposal({
      runId: options.runId,
      groupId: `claim-key-suspect:${entry.id}`,
      issueKind: "suspect_canonical_claim_key",
      scope: "single_entry",
      entryIds: [entry.id],
      currentClaimKeys: entry.claim_key ? [entry.claim_key] : [],
      proposedClaimKeys,
      rationale: buildSuspectProposalRationale(entry, inspection.inspection, metadataRepair, suggestionRecord.suggestion),
      confidence: metadataRepair ? 0.98 : (suggestionRecord.suggestion?.confidence ?? 0.5),
      source: metadataRepair ? "metadata_rewrite" : (suggestionRecord.suggestion?.path ?? "heuristic"),
      eligibleForApply: proposedClaimKeys.length > 0,
      createdAt: options.now().toISOString(),
    });
    await persistProposal(proposal);
    counts.proposalsEmitted += 1;
    counts.skippedAmbiguous += 1;
  }

  async function loadSuggestion(entry: Entry): Promise<EntrySuggestionRecord> {
    const cached = suggestionCache.get(entry.id);
    if (cached) {
      return cached;
    }

    if (!claimExtractionConfig.enabled || !claimExtractionConfig.eligibleTypes.includes(entry.type)) {
      const empty = { suggestion: null, warnings: [] };
      suggestionCache.set(entry.id, empty);
      return empty;
    }

    if (!claimExtractionLlm) {
      claimExtractionLlm = deps.createClaimExtractionLlm ? deps.createClaimExtractionLlm() : null;
    }
    if (!claimExtractionLlm) {
      const empty = { suggestion: null, warnings: [] };
      suggestionCache.set(entry.id, empty);
      return empty;
    }

    const warnings: string[] = [];
    let suggestion: ClaimExtractionResult | null;
    try {
      suggestion = await previewClaimKeyExtraction(
        {
          type: entry.type,
          subject: entry.subject,
          content: entry.content,
        },
        claimExtractionLlm,
        claimExtractionConfig,
        {
          hints: buildCleanupHintsForEntry(trustedHints, entry),
          onWarning: (warning) => warnings.push(warning),
        },
      );
    } catch (error) {
      warnings.push(error instanceof Error ? error.message : String(error));
      suggestion = null;
    }

    const record = { suggestion, warnings };
    suggestionCache.set(entry.id, record);

    const usage = claimExtractionUsage(claimExtractionLlm);
    if (options.costCapUsd > 0 && usage.estimatedCostUsd >= options.costCapUsd) {
      terminalStatus = "cost_capped";
      terminalError = `Cost cap exceeded while previewing claim-key repairs at ${usage.estimatedCostUsd.toFixed(4)} USD.`;
    }

    return record;
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
      rationale: string;
    },
  ): Promise<{ projected: boolean; applied: boolean }> {
    const projected = input.entriesById.get(entryId);
    const actual = input.actualEntriesById.get(entryId);
    if (!projected || !actual) {
      return { projected: false, applied: false };
    }

    projected.claim_key = claimKey;
    if (!options.apply) {
      return { projected: true, applied: false };
    }

    const updated = await deps.port.updateEntry(entryId, { claim_key: claimKey }, { includeInactive: selection.includeInactive });
    if (!updated) {
      projected.claim_key = input.oldClaimKey ?? undefined;
      return { projected: false, applied: false };
    }

    actual.claim_key = claimKey;
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
        proposal_source: input.source,
        confidence: input.confidence,
        auto_applied: true,
      },
      createdAt: options.now().toISOString(),
    });
    actionsTaken += 1;
    return { projected: true, applied: true };
  }

  async function persistProposal(proposal: SurgeonRunProposal): Promise<void> {
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
        auto_applied: false,
        eligible_for_apply: proposal.eligibleForApply,
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

  return {
    totalEntries: entries.length,
    activeEntries: activeEntries.length,
    coverageCount: withClaimKeys.length,
    coveragePct: entries.length > 0 ? withClaimKeys.length / entries.length : 0,
    missingCount: entries.filter((entry) => inspectExistingClaimKey(entry).kind === "missing").length,
    eligibleMissingCount: entries.filter((entry) => inspectExistingClaimKey(entry).kind === "missing" && eligibleTypes.includes(entry.type)).length,
    malformedOrNoncanonicalCount,
    suspectCanonicalCount,
    mixedGroupCount: findMixedKeyGroups(entries).length,
    exactKeyMultiActiveClusterCount: countExactKeyMultiActiveClusters(activeEntries),
  };
}

function claimExtractionUsage(llm: (LlmPort & { metadata?: { usage?: { inputTokens?: number; outputTokens?: number; totalCost?: number } } }) | null): {
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
} {
  const usage = llm?.metadata?.usage;
  return {
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    estimatedCostUsd: usage?.totalCost ?? 0,
  };
}

interface ClaimKeyQualityStageProgressState {
  stage: ClaimKeyQualityProgressStage;
  total: number;
  completed: number;
  unitLabel: "entries" | "groups";
  lastReportedCompleted: number;
  lastReportedAtMs: number;
}

interface ClaimKeyQualityProgressTracker {
  emitHealthSnapshot(snapshot: ClaimKeyHealthSnapshot): void;
  startStage(stage: ClaimKeyQualityProgressStage, total: number, unitLabel: "entries" | "groups"): void;
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

    startStage(stage: ClaimKeyQualityProgressStage, total: number, unitLabel: "entries" | "groups"): void {
      activeStage =
        total > 0
          ? {
              stage,
              total,
              completed: 0,
              unitLabel,
              lastReportedCompleted: 0,
              lastReportedAtMs: Date.now(),
            }
          : null;

      if (!activeStage) {
        return;
      }

      emitStageEvent("started");
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

  function emitStageEvent(status: "started" | "progress" | "completed", nowMs = Date.now()): void {
    if (!activeStage) {
      return;
    }

    activeStage.lastReportedCompleted = activeStage.completed;
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
      processedEntries,
      totalEntries: input.totalEntries,
      counts: cloneRepairCounts(input.counts),
      elapsedMs: elapsedMs(startedAtMs, nowMs),
    });
  }
}

function createEmptyRepairCounts(): ClaimKeyQualityRepairCounts {
  return {
    identifiedNormalizations: 0,
    appliedNormalizations: 0,
    identifiedBackfills: 0,
    appliedBackfills: 0,
    identifiedMetadataRewrites: 0,
    appliedMetadataRewrites: 0,
    proposalsEmitted: 0,
    skippedNoClaim: 0,
    skippedLowConfidence: 0,
    skippedCollision: 0,
    skippedAmbiguous: 0,
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

function normalizeStringArray(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter((value) => value.length > 0)));
}

function isEntryActive(entry: Entry): boolean {
  return entry.retired === false && !entry.superseded_by;
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

function buildTrustedCleanupHintSeed(entries: Entry[]): Pick<ClaimExtractionHints, "entityHints" | "claimKeyExamples"> {
  const claimKeyStats = new Map<string, { count: number; maxImportance: number; latestCreatedAt: string }>();

  for (const entry of entries) {
    const claimKey = entry.claim_key?.trim();
    if (!claimKey || !isTrustedClaimKeyForCleanup(claimKey)) {
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
    entityHints,
    claimKeyExamples,
  };
}

function buildCleanupHintsForEntry(baseHints: Pick<ClaimExtractionHints, "entityHints" | "claimKeyExamples">, entry: Entry): ClaimExtractionHints {
  return {
    entityHints: [...(baseHints.entityHints ?? [])],
    claimKeyExamples: [...(baseHints.claimKeyExamples ?? [])],
    project: entry.project,
    userId: entry.user_id,
  };
}

async function buildMalformedClaimKeyProposal(
  entry: Entry,
  inspection: { kind: "malformed"; inspection: ClaimKeyInspection },
  deps: {
    getSuggestion(): Promise<EntrySuggestionRecord>;
    now(): Date;
    runId: string;
  },
): Promise<SurgeonRunProposal> {
  const suggestionRecord = await deps.getSuggestion();
  const proposedClaimKeys = suggestionRecord.suggestion?.claimKey ? [suggestionRecord.suggestion.claimKey] : [];

  return createProposal({
    runId: deps.runId,
    groupId: `claim-key-malformed:${entry.id}`,
    issueKind: "malformed_claim_key",
    scope: "single_entry",
    entryIds: [entry.id],
    currentClaimKeys: entry.claim_key ? [entry.claim_key] : [],
    proposedClaimKeys,
    rationale:
      `Stored claim key "${entry.claim_key}" is malformed because ${describeClaimKeyNormalizationFailure(inspection.inspection.normalizationFailure ?? "missing_separator")}.` +
      (suggestionRecord.suggestion?.claimKey
        ? ` Claim extraction preview suggested "${suggestionRecord.suggestion.claimKey}" at confidence ${suggestionRecord.suggestion.confidence.toFixed(2)}.`
        : ""),
    confidence: suggestionRecord.suggestion?.confidence ?? 0.5,
    source: suggestionRecord.suggestion?.path ?? "normalize",
    eligibleForApply: proposedClaimKeys.length > 0,
    createdAt: deps.now().toISOString(),
  });
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

function findMixedKeyGroups(entries: Entry[]): Array<{ groupKey: string; entries: Entry[]; proposedClaimKey: string | null }> {
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

function createProposal(input: Omit<SurgeonRunProposal, "id">): SurgeonRunProposal {
  return {
    id: randomUUID(),
    ...input,
    entryIds: normalizeStringArray(input.entryIds),
    currentClaimKeys: normalizeStringArray(input.currentClaimKeys),
    proposedClaimKeys: normalizeStringArray(input.proposedClaimKeys),
  };
}
