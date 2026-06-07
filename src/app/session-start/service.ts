import { recall, type RecallExecutionTraceSummary, type RecallOutput } from "../../core/recall/index.js";
import { isCurrentlyValidMemory, isWithinValidityWindow } from "../../core/temporal-validity.js";
import type { Durable } from "../../core/types.js";

import { resolveKeyedDurableLifecycleStatus } from "../../core/keyed-durable-lifecycle.js";
import { parseDirectiveMetadata } from "../../core/directives/model.js";
import { resolvePredecessorSessionArtifacts } from "../session-memory/predecessor-artifacts.js";
import { applyAbstainDirectivesForInjection } from "../directives/abstain-filter.js";
import { projectClaimCentricRecallEntry } from "../recall/claim-centric.js";
import { buildSessionStartArtifactRecallQuery } from "./artifact-recall-query.js";
import type { SessionStartDeps } from "./ports.js";
import type { SessionStartInput, SessionStartPatch, SessionStartPatchDiagnostics, SessionStartPatchItem, SessionStartPolicy } from "./types.js";

const DEFAULT_MAX_CORE_ENTRIES = 4;
const DEFAULT_MAX_ARTIFACT_RECALL_ENTRIES = 3;
const DEFAULT_MAX_DURABLE_ENTRIES = 5;
const DEFAULT_MAX_ARTIFACT_CHARS = 1_200;
const DEFAULT_MAX_PROFILE_SNAPSHOT_AGE_HOURS = 48;

/**
 * Builds one structured bounded session-start patch from host-supplied artifacts
 * plus Agenr durable memory.
 *
 * @param input - Host-neutral session-start facts and policy hints.
 * @param deps - Feature-scoped repository plus shared durable recall ports.
 * @returns Structured session-start patch for adapter rendering and inspection.
 */
export async function runSessionStart(input: SessionStartInput, deps: SessionStartDeps): Promise<SessionStartPatch> {
  const policy = normalizePolicy(input.policy);
  const now = deps.now ?? new Date();
  const nowMs = now.getTime();
  const profileSnapshot = await deps.repository.getActiveProfileSnapshot(policy.maxProfileSnapshotAgeHours * 60 * 60 * 1000, now);
  const profileEntries = profileSnapshot ? filterCurrentEntries(await deps.repository.listEntriesByIds(profileSnapshot.durableIds), nowMs) : [];
  const profileItems = profileEntries.map((entry) => buildProfilePatchItem(entry, profileSnapshot?.id ?? "unknown", nowMs));
  const proactiveDirectiveEntries = filterCurrentEntries((await deps.listActiveProactiveDirectives?.()) ?? [], nowMs);
  const proactiveDirectiveItems = proactiveDirectiveEntries.map((entry) => buildDirectivePatchItem(entry, nowMs));
  const coreEntries = await deps.repository.listCoreEntries(policy.maxCoreEntries, now);
  const coreItems = coreEntries.map((entry) => buildCorePatchItem(entry, nowMs));
  const diagnostics: SessionStartPatchDiagnostics = {
    coreCandidateCount: coreEntries.length,
    profileCandidateCount: profileEntries.length,
    ...(profileSnapshot ? { activeProfileSnapshotId: profileSnapshot.id } : {}),
    proactiveDirectiveCandidateCount: proactiveDirectiveEntries.length,
    artifactRecallCandidateCount: 0,
    artifactRecallUsed: false,
    notices: [],
  };

  const artifactRecallQuery = await resolveSessionStartArtifactRecallQuery(input.sessionKey, policy, deps);
  if (!policy.enableArtifactRecall) {
    diagnostics.notices.push("Artifact-grounded durable recall disabled by session-start policy.");
  }
  const artifactRecallItems: SessionStartPatchItem[] = artifactRecallQuery
    ? await runArtifactRecallSelection(artifactRecallQuery, input.sessionKey, policy, deps, diagnostics)
    : [];

  const mergedDurableMemory = mergeDurableMemory(profileItems, proactiveDirectiveItems, coreItems, artifactRecallItems, policy.maxDurableEntries);
  const visibleDurableMemory = await applyAbstainDirectivesForInjection(mergedDurableMemory, deps.listActiveAbstainDirectives, diagnostics);
  const durableMemory = assignRanks(visibleDurableMemory);

  return {
    durableMemory,
    diagnostics,
  };
}

/**
 * Resolves the artifact-grounded recall query for one session-start pass.
 *
 * @param sessionKey - Optional active session key.
 * @param policy - Effective session-start policy.
 * @param deps - Session-start dependencies.
 * @returns Normalized recall query, or undefined when recall should not run.
 */
async function resolveSessionStartArtifactRecallQuery(
  sessionKey: string | undefined,
  policy: Required<SessionStartPolicy>,
  deps: SessionStartDeps,
): Promise<string | undefined> {
  if (!policy.enableArtifactRecall) {
    return undefined;
  }

  const normalizedSessionKey = sessionKey?.trim();
  if (!normalizedSessionKey || !deps.sessionMemoryRepository) {
    return undefined;
  }

  const predecessor = await resolvePredecessorSessionArtifacts({ sessionKey: normalizedSessionKey }, deps.sessionMemoryRepository);
  return buildSessionStartArtifactRecallQuery(predecessor.artifacts, policy.maxArtifactChars);
}

/**
 * Converts one profile snapshot durable into a session-start patch item.
 */
function buildProfilePatchItem(entry: Durable, snapshotId: string, nowMs: number): SessionStartPatchItem {
  return {
    rank: 0,
    entry,
    sourceKind: "profile",
    whySurfaced: {
      summary: `active profile snapshot ${snapshotId}`,
      reasons: ["active profile snapshot", `snapshot ${snapshotId}`, `importance ${entry.importance}`],
    },
    memoryState: resolveMemoryState(entry, nowMs),
    claimStatus: resolveClaimStatus(entry),
    freshnessLabel: buildFreshnessLabel(entry),
    ...(buildProvenanceSummary(entry) ? { provenanceSummary: buildProvenanceSummary(entry) } : {}),
  };
}

/**
 * Converts one proactive directive into a session-start patch item.
 */
function buildDirectivePatchItem(entry: Durable, nowMs: number): SessionStartPatchItem {
  const metadata = parseDirectiveMetadata(entry);
  return {
    rank: 0,
    entry,
    sourceKind: "directive",
    whySurfaced: {
      summary: `proactive memory directive; trigger ${metadata?.trigger ?? "session_start"}`,
      reasons: ["proactive memory directive", `trigger ${metadata?.trigger ?? "session_start"}`, `importance ${entry.importance}`],
    },
    memoryState: resolveMemoryState(entry, nowMs),
    claimStatus: resolveClaimStatus(entry),
    freshnessLabel: buildFreshnessLabel(entry),
    ...(buildProvenanceSummary(entry) ? { provenanceSummary: buildProvenanceSummary(entry) } : {}),
  };
}

/**
 * Runs bounded artifact-grounded durable recall when a query is available.
 *
 * @param query - Normalized artifact-derived recall seed.
 * @param sessionKey - Optional session key for recall telemetry.
 * @param policy - Effective session-start policy.
 * @param deps - Feature-scoped repository plus shared recall ports.
 * @param diagnostics - Mutable diagnostics sink updated in place.
 * @returns Artifact-grounded durable-memory items.
 */
async function runArtifactRecallSelection(
  query: string,
  sessionKey: string | undefined,
  policy: Required<SessionStartPolicy>,
  deps: SessionStartDeps,
  diagnostics: SessionStartPatchDiagnostics,
): Promise<SessionStartPatchItem[]> {
  diagnostics.artifactRecallUsed = true;
  diagnostics.artifactRecallQuery = query;

  let artifactRecallTrace: RecallExecutionTraceSummary | undefined;
  try {
    const recalled = await recall(
      {
        text: query,
        limit: policy.maxArtifactRecallEntries,
        threshold: policy.recallThreshold,
        sessionKey,
      },
      deps.recall,
      {
        trace: {
          reportSummary(summary): void {
            artifactRecallTrace = summary;
          },
        },
        slotPolicyConfig: deps.slotPolicyConfig,
        ...(deps.now ? { now: deps.now } : {}),
      },
    );

    diagnostics.artifactRecallTrace = artifactRecallTrace;
    diagnostics.artifactRecallCandidateCount = recalled.length;
    if (artifactRecallTrace?.degraded.notices.length) {
      diagnostics.notices.push(...artifactRecallTrace.degraded.notices);
    }
    return recalled.map((item) => buildArtifactRecallPatchItem(item, deps));
  } catch (error) {
    diagnostics.artifactRecallTrace = artifactRecallTrace;
    diagnostics.notices.push(`Artifact-grounded durable recall failed: ${formatErrorMessage(error)}`);
    return [];
  }
}

/**
 * Converts one always-on core entry into a session-start patch item.
 *
 * @param entry - Active core entry selected for session-start use.
 * @param nowMs - Reference instant used to resolve valid-time freshness.
 * @returns Structured patch item with stable explanation metadata.
 */
function buildCorePatchItem(entry: Durable, nowMs: number): SessionStartPatchItem {
  return {
    rank: 0,
    entry,
    sourceKind: "core",
    whySurfaced: {
      summary: `always-on core memory; importance ${entry.importance}`,
      reasons: ["always-on core memory", `importance ${entry.importance}`, `expiry ${entry.expiry}`],
    },
    memoryState: resolveMemoryState(entry, nowMs),
    claimStatus: resolveClaimStatus(entry),
    freshnessLabel: buildFreshnessLabel(entry),
    ...(buildProvenanceSummary(entry) ? { provenanceSummary: buildProvenanceSummary(entry) } : {}),
  };
}

/**
 * Converts one durable recall result into a structured session-start patch item.
 *
 * @param recalled - Ranked durable recall result.
 * @param deps - Session-start dependencies with optional slot-policy overrides.
 * @returns Structured patch item enriched with claim-centric inspection metadata.
 */
function buildArtifactRecallPatchItem(recalled: RecallOutput, deps: SessionStartDeps): SessionStartPatchItem {
  const projected = projectClaimCentricRecallEntry(recalled, {
    slotPolicyConfig: deps.slotPolicyConfig,
  });
  return {
    rank: 0,
    entry: recalled.entry,
    sourceKind: "artifact_recall",
    score: recalled.score,
    whySurfaced: projected.whySurfaced,
    memoryState: projected.memoryState,
    claimStatus: projected.claimStatus,
    freshnessLabel: projected.freshness.label,
    ...(formatProjectedProvenance(projected.provenance) ? { provenanceSummary: formatProjectedProvenance(projected.provenance) } : {}),
  };
}

/**
 * Merges profile, directive, core, and artifact-grounded recall candidates.
 *
 * Profile snapshot entries lead, proactive directives rank above generic
 * memory, and later duplicates are dropped by entry ID.
 *
 * @param profileItems - Profile snapshot memory items.
 * @param directiveItems - Proactive directive items.
 * @param coreItems - Always-on core memory items.
 * @param artifactRecallItems - Artifact-grounded recall items.
 * @param maxDurableEntries - Final bounded durable-memory limit.
 * @returns Deduplicated bounded durable-memory items.
 */
function mergeDurableMemory(
  profileItems: SessionStartPatchItem[],
  directiveItems: SessionStartPatchItem[],
  coreItems: SessionStartPatchItem[],
  artifactRecallItems: SessionStartPatchItem[],
  maxDurableEntries: number,
): SessionStartPatchItem[] {
  const merged: SessionStartPatchItem[] = [];
  const seenEntryIds = new Set<string>();

  const tryAdd = (item: SessionStartPatchItem): boolean => {
    if (merged.length >= maxDurableEntries || seenEntryIds.has(item.entry.id)) {
      return false;
    }

    seenEntryIds.add(item.entry.id);
    merged.push(item);
    return true;
  };

  const addFrom = (items: SessionStartPatchItem[], maxAdd = Number.POSITIVE_INFINITY): void => {
    let added = 0;
    for (const item of items) {
      if (merged.length >= maxDurableEntries || added >= maxAdd) {
        return;
      }

      if (tryAdd(item)) {
        added += 1;
      }
    }
  };

  addFrom(profileItems);
  addFrom(directiveItems);
  if (merged.length >= maxDurableEntries) {
    return merged;
  }

  const uniqueArtifact = artifactRecallItems.find((item) => !seenEntryIds.has(item.entry.id));
  const remainingSlots = maxDurableEntries - merged.length;
  const coreLimit = uniqueArtifact ? Math.max(0, remainingSlots - 1) : remainingSlots;
  addFrom(coreItems, coreLimit);
  if (uniqueArtifact) {
    tryAdd(uniqueArtifact);
  }

  addFrom(coreItems);
  addFrom(artifactRecallItems);
  return merged;
}

/**
 * Assigns stable one-based ranks to the final durable-memory items.
 *
 * @param items - Final bounded durable-memory set.
 * @returns Ranked durable-memory items.
 */
function assignRanks(items: SessionStartPatchItem[]): SessionStartPatchItem[] {
  return items.map((item, index) => ({
    ...item,
    rank: index + 1,
  }));
}

/**
 * Normalizes optional session-start policy hints into concrete bounded values.
 *
 * @param policy - Optional caller-supplied policy hints.
 * @returns Concrete effective policy.
 */
function normalizePolicy(policy: SessionStartPolicy | undefined): Required<SessionStartPolicy> {
  const maxCoreEntries = normalizeCount(policy?.maxCoreEntries, DEFAULT_MAX_CORE_ENTRIES);
  const maxArtifactRecallEntries = normalizeCount(policy?.maxArtifactRecallEntries, DEFAULT_MAX_ARTIFACT_RECALL_ENTRIES);
  const maxDurableEntries = Math.max(maxCoreEntries, normalizeCount(policy?.maxDurableEntries, DEFAULT_MAX_DURABLE_ENTRIES));
  return {
    maxCoreEntries,
    enableArtifactRecall: policy?.enableArtifactRecall !== false,
    maxArtifactRecallEntries,
    maxDurableEntries,
    maxArtifactChars: normalizeCount(policy?.maxArtifactChars, DEFAULT_MAX_ARTIFACT_CHARS),
    recallThreshold: normalizeThreshold(policy?.recallThreshold),
    maxProfileSnapshotAgeHours: normalizeCount(policy?.maxProfileSnapshotAgeHours, DEFAULT_MAX_PROFILE_SNAPSHOT_AGE_HOURS),
  };
}

/** Filters session-start entries to those valid at the current time. */
function filterCurrentEntries(entries: Durable[], nowMs: number): Durable[] {
  return entries.filter((entry) => isWithinValidityWindow(entry.valid_from, entry.valid_to, nowMs));
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
 * Normalizes one optional recall threshold.
 *
 * @param value - Raw caller-supplied threshold.
 * @returns Effective threshold clamped into the inclusive 0-1 range.
 */
function normalizeThreshold(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }

  return Math.min(1, Math.max(0, value));
}

/**
 * Resolves the high-level memory-state label for one entry.
 *
 * A bounded `valid_to` alone does not make an entry historical: a row stays
 * current until its valid-time window actually closes. Only a `valid_to` that
 * has already passed relative to `nowMs` demotes the entry to historical.
 *
 * @param entry - Durable entry being surfaced at session start.
 * @param nowMs - Reference instant used to resolve valid-time freshness.
 * @returns Memory-state label suitable for inspection surfaces.
 */
function resolveMemoryState(entry: Durable, nowMs: number): SessionStartPatchItem["memoryState"] {
  if (entry.superseded_by) {
    return "superseded";
  }

  if (!isCurrentlyValidMemory(entry, nowMs)) {
    return "historical";
  }

  return "current";
}

/**
 * Resolves the normalized claim-status label for one entry.
 *
 * @param entry - Durable entry being surfaced at session start.
 * @returns Claim-lifecycle label suitable for inspection surfaces.
 */
function resolveClaimStatus(entry: Durable): SessionStartPatchItem["claimStatus"] {
  return resolveKeyedDurableLifecycleStatus(entry);
}

/**
 * Builds a concise freshness label for one durable entry.
 *
 * @param entry - Durable entry being surfaced at session start.
 * @returns Compact freshness summary.
 */
function buildFreshnessLabel(entry: Durable): string {
  const parts = [`created ${entry.created_at}`];
  const validFrom = normalizeOptionalString(entry.valid_from);
  const validTo = normalizeOptionalString(entry.valid_to);
  if (validFrom || validTo) {
    parts.push(`valid ${validFrom ?? "?"} -> ${validTo ?? "ongoing"}`);
  }

  return parts.join(" | ");
}

/**
 * Formats a compact provenance summary from one durable entry.
 *
 * @param entry - Durable entry being surfaced at session start.
 * @returns Compact provenance summary, or undefined when none exists.
 */
function buildProvenanceSummary(entry: Durable): string | undefined {
  const parts = [
    entry.superseded_by ? `superseded_by=${entry.superseded_by}` : undefined,
    entry.supersession_kind ? `kind=${entry.supersession_kind}` : undefined,
    entry.supersession_reason ? `reason=${entry.supersession_reason}` : undefined,
    entry.claim_support_source_kind ? `support=${entry.claim_support_source_kind}` : undefined,
    entry.claim_support_mode ? `support_mode=${entry.claim_support_mode}` : undefined,
    entry.claim_support_observed_at ? `observed=${entry.claim_support_observed_at}` : undefined,
    entry.claim_support_locator ? `locator=${entry.claim_support_locator}` : undefined,
  ].filter((value): value is string => value !== undefined);

  return parts.length > 0 ? parts.join(" | ") : undefined;
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
 * Normalizes optional multiline text by trimming and collapsing blank padding.
 *
 * @param value - Candidate optional text.
 * @returns Normalized text, or undefined when empty.
 */
function normalizeOptionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
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
