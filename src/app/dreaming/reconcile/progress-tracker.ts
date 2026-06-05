import type { ClaimKeyHealthSnapshot, ReconcileRepairCounts } from "../../../core/dreaming/types.js";
import type { DreamTier } from "../../../core/dreaming/domain/pass-types.js";
import { emitDreamProgress, type DreamProgressReporter, type ReconcileProgressStage } from "../progress.js";
import {
  CLAIM_KEY_PROGRESS_EVERY_DURABLES,
  CLAIM_KEY_PROGRESS_EVERY_VERBOSE_DURABLES,
  CLAIM_KEY_PROGRESS_INTERVAL_MS,
  CLAIM_KEY_PROGRESS_VERBOSE_INTERVAL_MS,
} from "./constants.js";
import { cloneRepairCounts } from "./helpers/stats.js";
import { elapsedMs, normalizeOptionalNonNegativeCount } from "./helpers/utils.js";

interface ReconcileStageProgressState {
  stage: ReconcileProgressStage;
  total: number;
  completed: number;
  unitLabel: "durables" | "groups";
  previewQueued: number;
  previewCompleted: number;
  previewTotal: number;
  previewConcurrency: number | null;
  lastReportedCompleted: number;
  lastReportedPreviewCompleted: number;
  lastReportedAtMs: number;
}

export interface ReconcileProgressTracker {
  emitHealthSnapshot(snapshot: ClaimKeyHealthSnapshot): void;
  startStage(
    stage: ReconcileProgressStage,
    total: number,
    unitLabel: "durables" | "groups",
    options?: {
      previewTotal?: number;
      previewConcurrency?: number;
    },
  ): void;
  advancePreview(count?: number): void;
  advanceStage(count?: number): void;
}

export function createReconcileProgressTracker(input: {
  tier: DreamTier;
  apply: boolean;
  verbose: boolean;
  totalDurables: number;
  counts: ReconcileRepairCounts;
  reportProgress?: DreamProgressReporter;
}): ReconcileProgressTracker {
  const startedAtMs = Date.now();
  const progressIntervalMs = input.verbose ? CLAIM_KEY_PROGRESS_VERBOSE_INTERVAL_MS : CLAIM_KEY_PROGRESS_INTERVAL_MS;
  const progressEvery = input.verbose ? CLAIM_KEY_PROGRESS_EVERY_VERBOSE_DURABLES : CLAIM_KEY_PROGRESS_EVERY_DURABLES;
  let processedDurables = 0;
  let activeStage: ReconcileStageProgressState | null = null;

  return {
    emitHealthSnapshot(snapshot: ClaimKeyHealthSnapshot): void {
      emitDreamProgress(input.reportProgress, {
        kind: "reconcile_progress",
        tier: input.tier,
        apply: input.apply,
        stage: "health",
        status: "snapshot",
        completed: 0,
        total: snapshot.totalDurables,
        unitLabel: "durables",
        processedDurables,
        totalDurables: input.totalDurables,
        counts: cloneRepairCounts(input.counts),
        elapsedMs: elapsedMs(startedAtMs),
        health: snapshot,
      });
    },

    startStage(
      stage: ReconcileProgressStage,
      total: number,
      unitLabel: "durables" | "groups",
      options?: {
        previewTotal?: number;
        previewConcurrency?: number;
      },
    ): void {
      const previewTotal = normalizeOptionalNonNegativeCount(options?.previewTotal);
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
      if (activeStage.unitLabel === "durables") {
        processedDurables += count;
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
    emitDreamProgress(input.reportProgress, {
      kind: "reconcile_progress",
      tier: input.tier,
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
      processedDurables,
      totalDurables: input.totalDurables,
      counts: cloneRepairCounts(input.counts),
      elapsedMs: elapsedMs(startedAtMs, nowMs),
    });
  }
}
