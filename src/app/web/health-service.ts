import {
  loadDreamHistoryRuntime,
  loadDreamProfileRuntime,
  loadDreamStatusRuntime,
} from "../dreaming/runtime.js";
import type { DreamHealthStats, DreamProfileSnapshot, DreamRunRecord } from "../dreaming/ports.js";

/** Number of recent runs inspected when surfacing failures on the cockpit. */
const RECENT_RUN_SAMPLE_SIZE = 10;

/**
 * Compact active-profile summary rendered on the Ops Cockpit.
 */
export interface CockpitProfileSummary {
  /** Active profile snapshot, or null when none has been projected. */
  snapshot: DreamProfileSnapshot | null;
  /** Count of durables included in the active profile bundle. */
  profileDurableCount: number;
  /** Count of directive durables tracked alongside the profile. */
  directiveCount: number;
}

/**
 * Proposal backlog rollup rendered on the Ops Cockpit.
 */
export interface CockpitBacklogSummary {
  /** Open proposals awaiting review. */
  total: number;
  /** Open proposals already eligible to apply. */
  eligible: number;
  /** Oldest still-open proposal creation timestamp, when present. */
  oldestOpenCreatedAt: string | null;
}

/**
 * Full cockpit snapshot composed from existing dreaming runtime views.
 */
export interface CockpitSnapshot {
  /** Aggregate corpus health summary. */
  health: DreamHealthStats;
  /** Most recent persisted dreaming run, when present. */
  lastRun: DreamRunRecord | null;
  /** Recent run history newest first. */
  recentRuns: DreamRunRecord[];
  /** Recent runs whose status is `failed`, surfaced as actionable items. */
  failedRuns: DreamRunRecord[];
  /** Active-profile rollup. */
  profile: CockpitProfileSummary;
  /** Proposal backlog rollup. */
  backlog: CockpitBacklogSummary;
  /** Count of recent applied light runs that skipped the pre-apply backup. */
  recentLightApplyRunsWithoutBackup: number;
}

/**
 * Loads the full Ops Cockpit snapshot for an instance.
 *
 * Composes the existing dreaming status, history, and profile runtime views so
 * the cockpit never reimplements corpus-health logic.
 *
 * @param input - Instance database path and environment overrides.
 * @returns Aggregate cockpit snapshot.
 */
export async function loadCockpitSnapshot(input: { dbPath: string; env?: NodeJS.ProcessEnv }): Promise<CockpitSnapshot> {
  const [status, history, profile] = await Promise.all([
    loadDreamStatusRuntime(input),
    loadDreamHistoryRuntime({ ...input, limit: RECENT_RUN_SAMPLE_SIZE }),
    loadDreamProfileRuntime(input),
  ]);

  return {
    health: status.health,
    lastRun: status.lastRun,
    recentRuns: history,
    failedRuns: history.filter((run) => run.status === "failed"),
    profile: {
      snapshot: profile.snapshot,
      profileDurableCount: profile.profileDurables.length,
      directiveCount: profile.directiveDurables.length,
    },
    backlog: {
      total: status.health.proposalBacklogCount,
      eligible: status.health.eligibleProposalBacklogCount,
      oldestOpenCreatedAt: status.health.oldestOpenProposalCreatedAt,
    },
    recentLightApplyRunsWithoutBackup: status.recentLightApplyRunsWithoutBackup,
  };
}
