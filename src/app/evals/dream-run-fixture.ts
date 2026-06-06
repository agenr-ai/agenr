import type { DreamCompletionSummary, DreamRunStatus, DreamTier } from "../../core/dreaming/types.js";

/** Pre-baked dreaming run completion fixture for internal eval sandboxes. */
export interface EvalDreamRunFixture {
  /** Dreaming tier recorded on the seeded run. */
  tier: DreamTier;
  /** Completion summary persisted for the seeded run. */
  summaryJson: DreamCompletionSummary;
  /** Optional persisted run cost in USD for cost-per-mutation derivation. */
  estimatedCostUsd?: number;
  /** Optional completed-at timestamp for deterministic fixtures. */
  completedAt?: string;
}

/** Minimal persisted dreaming run record needed by eval seams. */
export interface EvalDreamRunRecord {
  /** Persisted dreaming run identifier. */
  runId: string;
  /** Persisted run completion status. */
  status: DreamRunStatus;
  /** Persisted completion timestamp, or null when absent. */
  completedAt: string | null;
  /** Persisted estimated model spend in USD. */
  estimatedCostUsd: number;
  /** Persisted completion summary JSON. */
  summaryJson: DreamCompletionSummary | null;
}

/** App-layer port for seeding and reading eval dreaming runs. */
export interface EvalDreamRunStore {
  /**
   * Inserts one completed dreaming run row with a pre-baked completion summary.
   *
   * @param fixture - Dream run fixture supplied by the eval request.
   * @returns Persisted dreaming run identifier.
   */
  provisionDreamRun(fixture: EvalDreamRunFixture): Promise<{ runId: string }>;
  /**
   * Loads one persisted eval dreaming run by identifier.
   *
   * @param runId - Dreaming run identifier returned by provisioning.
   * @returns Persisted run record, or null when missing.
   */
  getDreamRun(runId: string): Promise<EvalDreamRunRecord | null>;
}
