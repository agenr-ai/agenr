import { DEFAULT_DREAMING_IMPORTANCE_THRESHOLD, DEFAULT_DREAMING_MIN_INTERVAL_MINUTES, type AgenrConfig } from "../../config.js";
import type { EmbeddingPort } from "../../core/ports.js";
import type { DreamRunRecord } from "./ports.js";
import type { CostMeteredLlm, DreamPort } from "./ports.js";
import type { DreamRunResult } from "./service.js";
import { runDreamWithHeldLock } from "./service.js";
import { runDreamScan } from "./scan.js";
import { isEpisodeWriteInProgress, tryAcquireDreamingRunLock, withHeldDreamingRunLock } from "./concurrency.js";

const MINUTE_MS = 60 * 1000;

/** Background light-dream trigger source. */
export type LightDreamTriggerKind = "post_session" | "importance";

/** Result returned when a light dream trigger is evaluated. */
export type LightDreamTriggerResult =
  | {
      status: "skipped";
      reason:
        | "light_disabled"
        | "post_session_disabled"
        | "run_in_progress"
        | "episode_write_in_progress"
        | "interval_guard"
        | "no_evidence"
        | "importance_below_threshold";
      unsynthesizedImportanceSum?: number;
    }
  | {
      status: "ran";
      result: DreamRunResult;
      unsynthesizedImportanceSum: number;
    };

/**
 * Dependencies required to run a background light dream.
 */
export interface LightDreamTriggerDeps {
  port: DreamPort;
  dbPath?: string;
  config: AgenrConfig | null;
  embedding?: EmbeddingPort;
  createExtractLlm?: () => CostMeteredLlm;
  createClaimExtractionLlm?: () => CostMeteredLlm;
}

/**
 * Evaluates and possibly runs a background light dreaming pass.
 *
 * @param input - Trigger kind and optional clock override.
 * @param deps - Dreaming infrastructure shared with the host plugin runtime.
 * @returns Trigger decision and run result when one was launched.
 */
export async function maybeRunLightDream(
  input: { trigger: LightDreamTriggerKind; now?: () => Date },
  deps: LightDreamTriggerDeps,
): Promise<LightDreamTriggerResult> {
  const now = input.now ?? (() => new Date());
  const config = resolveLightDreamTriggerConfig(deps.config);
  if (!config.lightEnabled) {
    return { status: "skipped", reason: "light_disabled" };
  }

  if (input.trigger === "post_session" && !config.postSessionLightDream) {
    return { status: "skipped", reason: "post_session_disabled" };
  }

  // Only the store-triggered `importance` path can race a host episode write,
  // since it fires concurrently from the store tool. The `post_session` path is
  // already invoked after the guarded episode write completes, so it needs no
  // guard here.
  if (input.trigger === "importance" && isEpisodeWriteInProgress(deps.dbPath)) {
    return { status: "skipped", reason: "episode_write_in_progress" };
  }

  const lock = await tryAcquireDreamingRunLock(deps.port, deps.dbPath);
  if (!lock) {
    return { status: "skipped", reason: "run_in_progress" };
  }

  return withHeldDreamingRunLock(lock, async (lease) => {
    const lastRun = await deps.port.getLastRun();
    if (isWithinMinInterval(lastRun, now(), config.minIntervalMinutes)) {
      return { status: "skipped", reason: "interval_guard" };
    }

    const scan = await runDreamScan({ now }, { port: deps.port });
    if (!hasEvidence(scan)) {
      return { status: "skipped", reason: "no_evidence", unsynthesizedImportanceSum: scan.unsynthesizedImportanceSum };
    }

    if (input.trigger === "importance" && scan.unsynthesizedImportanceSum < config.importanceThreshold) {
      return {
        status: "skipped",
        reason: "importance_below_threshold",
        unsynthesizedImportanceSum: scan.unsynthesizedImportanceSum,
      };
    }

    const result = await runDreamWithHeldLock(
      {
        tier: "light",
        apply: true,
        verbose: false,
        json: true,
        skipBackup: true,
      },
      {
        port: deps.port,
        dbPath: deps.dbPath,
        config: deps.config,
        now,
        ...(deps.embedding ? { embedding: deps.embedding } : {}),
        ...(deps.createExtractLlm ? { createExtractLlm: deps.createExtractLlm } : {}),
        ...(deps.createClaimExtractionLlm ? { createClaimExtractionLlm: deps.createClaimExtractionLlm } : {}),
      },
      lease,
    );

    return {
      status: "ran",
      result,
      unsynthesizedImportanceSum: scan.unsynthesizedImportanceSum,
    };
  });
}

/** Resolves light-dream trigger settings from optional configuration. */
function resolveLightDreamTriggerConfig(config: AgenrConfig | null): {
  lightEnabled: boolean;
  postSessionLightDream: boolean;
  importanceThreshold: number;
  minIntervalMinutes: number;
} {
  return {
    lightEnabled: config?.dreaming?.tiers?.light?.enabled ?? true,
    postSessionLightDream: config?.dreaming?.triggers?.postSessionLightDream ?? true,
    importanceThreshold: config?.dreaming?.triggers?.importanceThreshold ?? DEFAULT_DREAMING_IMPORTANCE_THRESHOLD,
    minIntervalMinutes: config?.dreaming?.triggers?.minIntervalMinutes ?? DEFAULT_DREAMING_MIN_INTERVAL_MINUTES,
  };
}

/** Returns whether the last light dream is still inside the configured interval. */
function isWithinMinInterval(lastRun: DreamRunRecord | null, now: Date, minIntervalMinutes: number): boolean {
  if (!lastRun || minIntervalMinutes <= 0) {
    return false;
  }

  const reference = lastRun.completedAt ?? lastRun.startedAt;
  const timestamp = Date.parse(reference);
  if (!Number.isFinite(timestamp)) {
    return false;
  }

  return now.getTime() - timestamp < minIntervalMinutes * MINUTE_MS;
}

/** Returns whether a scan found evidence worth reconciling in a light dream. */
function hasEvidence(scan: Awaited<ReturnType<typeof runDreamScan>>): boolean {
  return scan.episodesSinceLastRun > 0 || scan.ingestFilesSinceLastRun > 0 || scan.durablesCreatedSinceLastRun > 0;
}
