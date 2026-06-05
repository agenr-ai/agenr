import { randomUUID } from "node:crypto";

import {
  compareRetirementCandidates,
  isActionableRetirementCandidate,
  type DreamRetirementPolicyCandidate,
} from "../../core/dreaming/domain/retirement-policy.js";
import type { DreamPruneSummary } from "../../core/dreaming/types.js";
import type { Durable } from "../../core/types.js";
import type { DreamPort } from "./ports.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Options accepted by the deterministic prune stage.
 */
export interface DreamPruneOptions {
  runId: string;
  apply: boolean;
  project?: string;
  protectedDurableIds?: string[];
  protectRecalledDays: number;
  protectMinImportance: number;
  now(): Date;
}

/**
 * Dependencies required by the prune stage.
 */
export interface DreamPruneDeps {
  port: DreamPort;
}

/**
 * Runs conservative durable retirement after synthesis and projection.
 *
 * @param options - Prune scope, protection thresholds, and run metadata.
 * @param deps - Persistence port used to read and mutate durables.
 * @returns Structured prune summary for the dreaming completion record.
 */
export async function runPruneStage(options: DreamPruneOptions, deps: DreamPruneDeps): Promise<DreamPruneSummary> {
  const durables = await deps.port.listReconcileDurables({
    ...(options.project ? { project: options.project } : {}),
    includeInactive: false,
  });
  const activeProfileIds = await loadProtectedProfileIds(deps.port, options.protectedDurableIds ?? []);
  const evaluated = durables
    .map((durable) =>
      evaluatePruneCandidate(durable, {
        activeProfileIds,
        now: options.now(),
        protectMinImportance: options.protectMinImportance,
        protectRecalledDays: options.protectRecalledDays,
      }),
    )
    .filter((candidate): candidate is PruneCandidateEvaluation => candidate !== null)
    .sort((left, right) => compareRetirementCandidates(toRetirementPolicyCandidate(left.durable), toRetirementPolicyCandidate(right.durable)));

  const protectedCount = evaluated.filter((candidate) => candidate.protectionReason !== null).length;
  const retirable = evaluated.filter((candidate) => candidate.protectionReason === null);
  let durablesRetired = 0;

  if (options.apply && retirable.length > 0) {
    await deps.port.withTransaction(async (tx) => {
      for (const candidate of retirable) {
        const retired = await tx.retireDurable(candidate.durable.id, candidate.retirementReason);
        if (!retired) {
          continue;
        }
        durablesRetired += 1;

        await tx.logRunAction({
          id: randomUUID(),
          runId: options.runId,
          actionType: "retire",
          durableIds: [candidate.durable.id],
          reasoning: candidate.retirementReason,
          recallDelta: null,
          details: {
            stage: "prune",
            expiry: candidate.durable.expiry,
            importance: candidate.durable.importance,
            recall_count: candidate.durable.recall_count,
          },
          createdAt: options.now().toISOString(),
        });
      }
    });
  }

  return {
    durablesScanned: durables.length,
    candidatesIdentified: evaluated.length,
    candidatesProtected: protectedCount,
    candidatesRetirable: retirable.length,
    durablesRetired,
    dryRun: !options.apply,
  };
}

/** Evaluation result for one durable considered by the prune stage. */
interface PruneCandidateEvaluation {
  durable: Durable;
  protectionReason: string | null;
  retirementReason: string;
}

/** Evaluates whether one durable is retirable or protected during pruning. */
function evaluatePruneCandidate(
  durable: Durable,
  options: {
    activeProfileIds: ReadonlySet<string>;
    now: Date;
    protectMinImportance: number;
    protectRecalledDays: number;
  },
): PruneCandidateEvaluation | null {
  if (!isActionableRetirementCandidate(toRetirementPolicyCandidate(durable)) && !isExpiredByValidTo(durable, options.now)) {
    return null;
  }

  return {
    durable,
    protectionReason: resolveProtectionReason(durable, options),
    retirementReason: buildRetirementReason(durable, options.now),
  };
}

/** Loads durable ids protected by the active profile snapshot and explicit config. */
async function loadProtectedProfileIds(port: DreamPort, protectedDurableIds: string[]): Promise<ReadonlySet<string>> {
  const snapshot = await port.getActiveProfileSnapshot();
  const profileIds = new Set(protectedDurableIds);
  if (!snapshot) {
    return profileIds;
  }

  for (const durableId of [...snapshot.durableIds, ...snapshot.directiveIds]) {
    profileIds.add(durableId);
  }
  return profileIds;
}

/** Resolves the first protection reason that prevents pruning one durable. */
function resolveProtectionReason(
  durable: Durable,
  options: {
    activeProfileIds: ReadonlySet<string>;
    now: Date;
    protectMinImportance: number;
    protectRecalledDays: number;
  },
): string | null {
  if (options.activeProfileIds.has(durable.id)) {
    return "active_profile";
  }

  if (durable.type === "directive") {
    return "directive";
  }

  if (durable.expiry === "core") {
    return "core_expiry";
  }

  if (durable.importance >= options.protectMinImportance) {
    return "high_importance";
  }

  if (wasRecentlyRecalled(durable, options.now, options.protectRecalledDays)) {
    return "recent_recall";
  }

  return null;
}

/** Returns whether a durable was recalled inside the configured protection window. */
function wasRecentlyRecalled(durable: Durable, now: Date, protectRecalledDays: number): boolean {
  if (!durable.last_recalled_at) {
    return false;
  }

  const recalledAt = Date.parse(durable.last_recalled_at);
  if (!Number.isFinite(recalledAt)) {
    return false;
  }

  const cutoff = now.getTime() - protectRecalledDays * DAY_MS;
  return recalledAt >= cutoff;
}

/** Returns whether a durable's valid-to timestamp has expired. */
function isExpiredByValidTo(durable: Durable, now: Date): boolean {
  if (!durable.valid_to) {
    return false;
  }

  const validTo = Date.parse(durable.valid_to);
  return Number.isFinite(validTo) && validTo <= now.getTime();
}

/** Builds the persisted retirement reason for a prune action. */
function buildRetirementReason(durable: Durable, now: Date): string {
  if (isExpiredByValidTo(durable, now)) {
    return "Dream prune retired an expired valid-time durable.";
  }

  if (durable.expiry === "temporary") {
    return "Dream prune retired a temporary durable after synthesis.";
  }

  return "Dream prune retired a low-signal durable after synthesis.";
}

/** Adapts a durable to the core retirement-policy candidate shape. */
function toRetirementPolicyCandidate(durable: Durable): DreamRetirementPolicyCandidate {
  return {
    id: durable.id,
    subject: durable.subject,
    type: durable.type,
    importance: durable.importance,
    expiry: durable.expiry,
    recallCount: durable.recall_count,
    createdAt: durable.created_at,
    updatedAt: durable.updated_at,
  };
}
